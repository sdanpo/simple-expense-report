import { getGmailClient } from './auth';
import { analyzeDocument, analyzeText, isSupportedMimeType } from './gemini';
import { appendRow, ensureSheetHeaders, appendLog, getExistingDedupKeys, dedupKey, type LogEntry } from './sheets';
import { isReceipt, analysisToRow, summarize, isPermanentError, shortError } from './pipeline';

// Direct Gmail → Sheet ingestion, running on Vercel. This REPLACES the Google
// Apps Script: instead of a script labeling mail and dropping attachments into a
// Drive Inbox, the backend searches Gmail itself, analyzes attachments (and
// body-text receipts) in memory, and writes rows. Processed messages are tagged
// with a Gmail label so they are never ingested twice (the old `AutoInvoiced-done`
// idea, now applied via the API).

export const DONE_LABEL = 'AutoInvoiced-done';

// Mail worth looking at. Broad on purpose: body-only receipts (Uber, Metropark)
// have no attachment, so we can't require one here — Gemini is the real filter.
const SEARCH_TERMS = [
  'invoice', 'receipt', '"tax invoice"', 'חשבונית', 'קבלה', '"payment receipt"', '"order confirmation"',
];

const ATTACHMENT_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf',
]);

export interface IngestSummary {
  scanned: number;
  receipts: number;
  duplicates: number;
  ignored: number;
  errors: number;
  remaining: number;
}

// ---------- pure helpers (unit-tested without the Gmail API) ----------

export interface GmailHeader { name?: string | null; value?: string | null }
export interface GmailPart {
  filename?: string | null;
  mimeType?: string | null;
  headers?: GmailHeader[];
  body?: { data?: string | null; attachmentId?: string | null; size?: number | null };
  parts?: GmailPart[];
}

/** Build the Gmail search query for unprocessed candidate mail. */
export function buildSearchQuery(days = 30, doneLabel = DONE_LABEL): string {
  return `(${SEARCH_TERMS.join(' OR ')}) -label:${doneLabel} newer_than:${days}d`;
}

/** Flatten a MIME part tree into a list of leaf parts. */
export function flattenParts(part?: GmailPart | null): GmailPart[] {
  if (!part) return [];
  if (part.parts && part.parts.length) return part.parts.flatMap(flattenParts);
  return [part];
}

export function getHeader(headers: GmailHeader[] | undefined, name: string): string | null {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

/** Gmail returns URL-safe base64; decode to a Buffer. */
export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export interface AttachmentRef { filename: string; attachmentId: string; mimeType: string }

/** Pick real, supported attachments (skip inline parts with no attachmentId). */
export function selectAttachments(payload?: GmailPart | null): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  for (const p of flattenParts(payload)) {
    const mime = (p.mimeType ?? '').toLowerCase();
    if (!p.filename || !p.body?.attachmentId) continue;
    if (!ATTACHMENT_MIME_TYPES.has(mime)) continue;
    out.push({ filename: p.filename, attachmentId: p.body.attachmentId, mimeType: mime });
  }
  return out;
}

/** Best-effort plain-text body: prefer text/plain, else strip tags from text/html. */
export function extractBodyText(payload?: GmailPart | null): string {
  if (!payload) return '';
  const parts = flattenParts(payload);
  const plain = parts
    .filter((p) => (p.mimeType ?? '').toLowerCase() === 'text/plain' && p.body?.data)
    .map((p) => decodeBase64Url(p.body!.data!).toString('utf8'));
  if (plain.length) return plain.join('\n').trim();

  const html = parts
    .filter((p) => (p.mimeType ?? '').toLowerCase() === 'text/html' && p.body?.data)
    .map((p) => decodeBase64Url(p.body!.data!).toString('utf8'));
  if (html.length) return stripHtml(html.join('\n'));

  // Simple, non-multipart message.
  if (payload.body?.data) {
    const raw = decodeBase64Url(payload.body.data).toString('utf8');
    return (payload.mimeType ?? '').toLowerCase() === 'text/html' ? stripHtml(raw) : raw.trim();
  }
  return '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\-֐-׿ ]/g, '_').slice(0, 200);
}

// ---------- orchestration ----------

/**
 * Search Gmail and process candidate messages directly to the Sheet. Bounded by
 * `maxMessages` per run so a backlog drains over several cron ticks rather than
 * risking the function timeout. Returns `remaining` so a caller can re-invoke.
 */
export async function ingestGmailDirect(maxMessages = 8): Promise<IngestSummary> {
  const gmail = getGmailClient();
  await ensureSheetHeaders();

  const listed = await gmail.users.messages.list({
    userId: 'me',
    q: buildSearchQuery(),
    maxResults: Math.max(maxMessages, 25),
  });
  const all = listed.data.messages ?? [];
  const batch = all.slice(0, maxMessages);

  const summary: IngestSummary = {
    scanned: batch.length, receipts: 0, duplicates: 0, ignored: 0, errors: 0,
    remaining: Math.max(0, all.length - batch.length),
  };
  if (batch.length === 0) return summary;

  const doneLabelId = await ensureLabel(gmail, DONE_LABEL);
  const seen = await getExistingDedupKeys();
  const logs: LogEntry[] = [];

  for (const m of batch) {
    if (!m.id) continue;
    let markDone = true;
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const payload = full.data.payload as GmailPart | undefined;
      const subject = getHeader(payload?.headers, 'Subject') ?? 'email';
      const link = `https://mail.google.com/mail/u/0/#all/${m.id}`;

      const attachments = selectAttachments(payload);
      let recordedFromAttachment = false;

      for (const att of attachments) {
        const got = await gmail.users.messages.attachments.get({
          userId: 'me', messageId: m.id, id: att.attachmentId,
        });
        const data = got.data.data;
        if (!data) continue;
        const buffer = decodeBase64Url(data);
        const name = sanitizeFileName(`${subject}_${att.filename}`);
        const outcome = await recordAnalyzed(
          () => analyzeDocument(buffer, att.mimeType), name, link, seen, logs
        );
        if (outcome === 'error') { markDone = false; summary.errors++; }
        else if (outcome === 'receipt') { summary.receipts++; recordedFromAttachment = true; }
        else if (outcome === 'duplicate') { summary.duplicates++; recordedFromAttachment = true; }
        else summary.ignored++;
      }

      // No usable attachment → try the body text (Uber-style receipts).
      if (!recordedFromAttachment && attachments.length === 0) {
        const text = extractBodyText(payload);
        if (text.length > 0) {
          const outcome = await recordAnalyzed(
            () => analyzeText(text), sanitizeFileName(subject), link, seen, logs
          );
          if (outcome === 'error') { markDone = false; summary.errors++; }
          else if (outcome === 'receipt') summary.receipts++;
          else if (outcome === 'duplicate') summary.duplicates++;
          else summary.ignored++;
        } else {
          summary.ignored++;
        }
      }
    } catch (err) {
      // Whole-message failure (e.g. Gmail get failed). Retry next run.
      markDone = false;
      summary.errors++;
      logs.push({ source: 'vercel', event: 'error', detail: `gmail ${m.id} → ${shortError(err instanceof Error ? err.message : String(err))}` });
    }

    // Mark processed so we never re-ingest — unless a transient error means we want a retry.
    if (markDone) {
      await gmail.users.messages.modify({
        userId: 'me', id: m.id, requestBody: { addLabelIds: [doneLabelId] },
      }).catch(() => { /* a failed label just means we re-see it next run; dedup protects the Sheet */ });
    }
  }

  await appendLog(logs);
  return summary;
}

type Outcome = 'receipt' | 'duplicate' | 'ignored' | 'error';

/**
 * Run one analyze call, apply the shared receipt/dedup/row logic, and append a row
 * if it's a new receipt. Returns the outcome; 'error' means transient (retry).
 */
async function recordAnalyzed(
  analyze: () => Promise<import('./types').DocumentAnalysis>,
  fileName: string,
  link: string,
  seen: Set<string>,
  logs: LogEntry[]
): Promise<Outcome> {
  let analysis: import('./types').DocumentAnalysis;
  try {
    analysis = await analyze();
  } catch (err) {
    if (isPermanentError(err)) {
      logs.push({ source: 'vercel', event: 'ignored', detail: `${fileName} → unprocessable` });
      return 'ignored';
    }
    logs.push({ source: 'vercel', event: 'error', detail: `${fileName} → ${shortError(err instanceof Error ? err.message : String(err))}` });
    return 'error';
  }

  if (!isReceipt(analysis)) {
    logs.push({ source: 'vercel', event: 'ignored', detail: `${fileName} → not a receipt` });
    return 'ignored';
  }

  const key = dedupKey(analysis);
  if (seen.has(key)) {
    logs.push({ source: 'vercel', event: 'duplicate', detail: `${fileName} → duplicate: ${summarize(analysis)}` });
    return 'duplicate';
  }
  seen.add(key);

  const row = analysisToRow(analysis, { file_name: fileName, drive_link: link });
  await appendRow(row);
  logs.push({
    source: 'vercel',
    event: row.status === 'Approved' ? 'approved' : 'needs_review',
    detail: `${fileName} → ${summarize(analysis)}`,
  });
  return 'receipt';
}

async function ensureLabel(gmail: ReturnType<typeof getGmailClient>, name: string): Promise<string> {
  const existing = await gmail.users.labels.list({ userId: 'me' });
  const found = existing.data.labels?.find((l) => l.name === name);
  if (found?.id) return found.id;
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  return created.data.id!;
}
