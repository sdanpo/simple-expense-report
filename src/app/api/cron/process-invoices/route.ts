import { NextRequest, NextResponse } from 'next/server';
import { listInboxFiles, downloadFile, moveFile, INBOX_ID } from '@/lib/drive';
import { analyzeDocument, isSupportedMimeType } from '@/lib/gemini';
import { appendRow, ensureSheetHeaders, appendLog, getExistingDedupKeys, dedupKey, type LogEntry } from '@/lib/sheets';
import { isReceipt, analysisToRow, summarize, isPermanentError, shortError } from '@/lib/pipeline';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

// Cap files per invocation so we never hit the serverless function timeout.
// Caller (Apps Script / cron) re-invokes until `remaining` reaches 0.
const MAX_FILES_PER_RUN = Number(process.env.MAX_FILES_PER_RUN) || 4;

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results: { file: string; status: string; error?: string }[] = [];

  try {
    await ensureSheetHeaders();
    const allFiles = await listInboxFiles();
    const batch = allFiles.slice(0, MAX_FILES_PER_RUN);

    // Receipts already in the Sheet — so multiple photos of the same receipt (or a
    // re-processed file) don't create duplicate rows. Updated as we add within this run.
    const seen = await getExistingDedupKeys();

    const logs: LogEntry[] = [];
    for (const file of batch) {
      try {
        const result = await processFile(file, seen);
        results.push(result);
        logs.push(logFor(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error processing ${file.name}:`, message);
        results.push({ file: file.name, status: 'error', error: message });
        logs.push({ source: 'vercel', event: 'error', detail: `${file.name} → ${shortError(message)}` });
        // Leave file in Inbox — will retry next cycle
      }
    }

    const remaining = Math.max(0, allFiles.length - batch.length);
    // Write the human-readable outcome of this run to the Log tab in the Sheet.
    await appendLog(logs);
    return NextResponse.json({ processed: results.length, remaining, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function processFile(file: { id: string; name: string; mimeType: string; webViewLink: string }, seen: Set<string>) {
  if (!isSupportedMimeType(file.mimeType)) {
    await moveFile(file.id, process.env.GOOGLE_DRIVE_IGNORED_ID!);
    return { file: file.name, status: 'ignored_unsupported_type' };
  }

  // Claim the file by moving it out of the Inbox BEFORE any slow work. A
  // concurrent invocation (or a retry after a timeout) that re-lists the Inbox
  // will no longer see it, preventing duplicate Sheet rows. On error we move it
  // back so the next cycle retries.
  await moveFile(file.id, process.env.GOOGLE_DRIVE_PROCESSED_ID!);

  try {
    const content = await downloadFile(file.id);

    // Single Gemini call: classify + extract together (free-tier quota is scarce).
    const invoice = await analyzeDocument(content, file.mimeType);
    if (!isReceipt(invoice)) {
      await moveFile(file.id, process.env.GOOGLE_DRIVE_IGNORED_ID!);
      return { file: file.name, status: 'ignored_not_invoice' };
    }

    // Skip if this receipt is already in the Sheet (another photo of it, or a retry).
    const key = dedupKey({
      invoice_number: invoice.invoice_number,
      invoice_date: invoice.invoice_date,
      total_amount: invoice.total_amount,
      currency: invoice.currency,
    });
    if (seen.has(key)) {
      await moveFile(file.id, process.env.GOOGLE_DRIVE_IGNORED_ID!);
      return { file: file.name, status: 'duplicate', summary: summarize(invoice) };
    }
    seen.add(key);

    // Write to Sheets (file already in Processed from the claim step)
    const row = analysisToRow(invoice, { file_name: file.name, drive_link: file.webViewLink });
    await appendRow(row);

    return { file: file.name, status: row.status.toLowerCase().replace(' ', '_'), summary: summarize(invoice) };
  } catch (err) {
    // Permanent input errors (corrupted/unreadable file) can never succeed —
    // route to Ignored instead of retrying forever.
    if (isPermanentError(err)) {
      await moveFile(file.id, process.env.GOOGLE_DRIVE_IGNORED_ID!).catch(() => {});
      return { file: file.name, status: 'ignored_unprocessable' };
    }
    // Roll back the claim so the file is retried next cycle.
    await moveFile(file.id, INBOX_ID).catch(() => {});
    throw err;
  }
}

// Turn a processFile result into a one-line Log entry a human can read.
function logFor(r: { file: string; status: string; summary?: string }): LogEntry {
  const map: Record<string, string> = {
    approved: 'approved',
    needs_review: 'needs review',
    ignored_not_invoice: 'ignored (not a receipt)',
    ignored_unsupported_type: 'ignored (unsupported file)',
    ignored_unprocessable: 'ignored (corrupt/unreadable)',
  };
  map['duplicate'] = 'duplicate (already in sheet)';
  const event = r.status.startsWith('ignored') ? 'ignored'
    : r.status === 'duplicate' ? 'duplicate'
    : r.status === 'approved' || r.status === 'needs_review' ? r.status : 'info';
  const label = map[r.status] ?? r.status;
  const detail = r.summary ? `${r.file} → ${label}: ${r.summary}` : `${r.file} → ${label}`;
  return { source: 'vercel', event, detail };
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // allow if not set (dev mode)
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${secret}`;
}
