import { NextRequest, NextResponse } from 'next/server';
import { analyzeDocument, isSupportedMimeType } from '@/lib/gemini';
import { appendRow, ensureSheetHeaders, appendLog, getExistingDedupKeys, dedupKey } from '@/lib/sheets';
import { isReceipt, analysisToRow, summarize, isPermanentError } from '@/lib/pipeline';
import { authorizeInbound, getInboundTokens } from '@/lib/inbound-auth';
import { uploadFileToDrive } from '@/lib/drive';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// Photos are large; reject absurd uploads outright, and skip tiny files that can
// only be junk (matches the Apps Script attachment floor).
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const MIN_UPLOAD_BYTES = 1024; // 1 KB

/**
 * Direct photo upload from the Android app. The app's on-device gate has already
 * decided a photo is *probably* a receipt; this endpoint is the authoritative
 * classifier (Gemini) and writes the row. No Drive involved — bytes come straight
 * from the phone.
 *
 * HTTP contract the app's upload queue relies on:
 *   200  → handled (approved / needs_review / not_a_receipt / duplicate / ignored_*).
 *          Always terminal: the app dequeues.
 *   400  → malformed request (no file). Terminal: drop it.
 *   401  → bad/missing token. The app must re-auth; do NOT retry blindly.
 *   413  → file too large. Terminal: drop it.
 *   503  → transient (Gemini overloaded / rate-limited). The app retries w/ backoff.
 *   500  → unexpected. The app retries.
 */
export async function POST(req: NextRequest) {
  const auth = authorizeInbound(req.headers.get('authorization'), getInboundTokens());
  if (!auth.ok) return NextResponse.json({ status: 'unauthorized', error: auth.reason }, { status: 401 });

  // Parse multipart form.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ status: 'bad_request', error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return NextResponse.json({ status: 'bad_request', error: 'Missing "file"' }, { status: 400 });
  }

  const fileName =
    (typeof form.get('file_name') === 'string' && (form.get('file_name') as string)) ||
    ((file as any).name as string) ||
    'photo';
  const mimeType = file.type || 'application/octet-stream';
  const clientDedupId = typeof form.get('client_dedup_id') === 'string'
    ? (form.get('client_dedup_id') as string) : '';

  // Size guards (terminal outcomes — the app should not retry these).
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ status: 'too_large', error: `Max ${MAX_UPLOAD_BYTES} bytes` }, { status: 413 });
  }
  if (file.size < MIN_UPLOAD_BYTES) {
    await safeLog('ignored', `${fileName} → too small (${file.size}B)`);
    return NextResponse.json({ status: 'ignored_too_small' });
  }

  // Unsupported type is terminal — tell the app to drop it (200, not an error).
  if (!isSupportedMimeType(mimeType)) {
    await safeLog('ignored', `${fileName} → unsupported type ${mimeType}`);
    return NextResponse.json({ status: 'ignored_unsupported_type' });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Analyze (classify + extract in one Gemini call).
  let invoice;
  try {
    await ensureSheetHeaders();
    invoice = await analyzeDocument(buffer, mimeType);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Permanent (corrupt / safety refusal / no-JSON) → not a receipt, terminal.
    if (isPermanentError(err)) {
      await safeLog('ignored', `${fileName} → unprocessable: ${message.slice(0, 80)}`);
      return NextResponse.json({ status: 'ignored_unprocessable' });
    }
    // Transient → ask the app to retry later.
    await safeLog('error', `${fileName} → Gemini transient: ${message.slice(0, 80)}`);
    return NextResponse.json({ status: 'retry', error: message }, { status: 503 });
  }

  if (!isReceipt(invoice)) {
    await safeLog('ignored', `${fileName} → not a receipt`);
    return NextResponse.json({ status: 'not_a_receipt', analysis: invoice });
  }

  // Dedup against rows already in the Sheet (re-uploads, or multiple photos of the
  // same receipt) so a lost-ack retry never creates a second row.
  const seen = await getExistingDedupKeys();
  const key = dedupKey(invoice);
  if (seen.has(key)) {
    await safeLog('duplicate', `${fileName} → duplicate: ${summarize(invoice)}`);
    return NextResponse.json({ status: 'duplicate', summary: summarize(invoice) });
  }

  // Archive the image to Drive /Processed (as the user) so the Sheet row links to
  // the original. Best-effort: if the Drive user-token isn't configured, we still
  // record the receipt with an empty link rather than failing the upload.
  const driveLink = await archiveToDrive(buffer, fileName, mimeType, invoice);

  const row = analysisToRow(invoice, { file_name: fileName, drive_link: driveLink });
  await appendRow(row);
  await safeLog(
    row.status === 'Approved' ? 'approved' : 'needs_review',
    `${fileName} → photo receipt: ${summarize(invoice)}${clientDedupId ? ` [${clientDedupId}]` : ''}`
  );

  return NextResponse.json({ status: row.status.toLowerCase().replace(' ', '_'), row, summary: summarize(invoice) });
}

// Upload the image to Drive /Processed and return its webViewLink. Best-effort:
// returns '' if Drive isn't configured (missing GMAIL_REFRESH_TOKEN) or fails.
async function archiveToDrive(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  invoice: { vendor: string | null; invoice_date: string | null }
): Promise<string> {
  const folderId = process.env.GOOGLE_DRIVE_PROCESSED_ID;
  if (!folderId || !process.env.GMAIL_REFRESH_TOKEN) return '';
  try {
    // Readable, sortable name: "<date>_<vendor>_<original>".
    const prefix = [invoice.invoice_date, invoice.vendor]
      .filter(Boolean)
      .join('_')
      .replace(/[^a-zA-Z0-9._\-֐-׿ ]/g, '_')
      .slice(0, 80);
    const name = prefix ? `${prefix}_${fileName}` : fileName;
    const uploaded = await uploadFileToDrive(name, buffer, mimeType, folderId);
    return uploaded.webViewLink ?? '';
  } catch (err) {
    console.error('Drive archival failed:', err instanceof Error ? err.message : err);
    return '';
  }
}

// Logging must never break ingestion.
async function safeLog(event: string, detail: string): Promise<void> {
  try {
    await appendLog([{ source: 'vercel', event, detail }]);
  } catch {
    /* ignore */
  }
}
