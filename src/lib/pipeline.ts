import type { DocumentAnalysis, SheetRow, InvoiceStatus } from './types';

// Shared, PURE decision logic for turning a Gemini analysis into a Sheet row.
// Used by the Drive cron, the Gmail cron, the email-body route, and /api/inbound,
// so every ingestion path classifies, thresholds, and formats identically.

// A receipt must be classified as an invoice AND clear this confidence floor.
export const MIN_CONFIDENCE = 0.5;
// Above this confidence (with the key fields present) we auto-approve instead of
// flagging for human review.
export const AUTO_APPROVE_CONFIDENCE = 0.8;

/** Is this analysis a real receipt we should record? */
export function isReceipt(a: Pick<DocumentAnalysis, 'is_invoice' | 'confidence'>): boolean {
  return a.is_invoice === true && a.confidence >= MIN_CONFIDENCE;
}

/** Approved only when the core fields are present and confidence is high. */
export function decideStatus(a: DocumentAnalysis): InvoiceStatus {
  const autoApprove =
    a.vendor !== null &&
    a.invoice_date !== null &&
    a.total_amount !== null &&
    a.confidence >= AUTO_APPROVE_CONFIDENCE;
  return autoApprove ? 'Approved' : 'Needs Review';
}

/** A short, human-readable one-liner: "Vendor 42.5 ILS". */
export function summarize(a: Pick<DocumentAnalysis, 'vendor' | 'total_amount' | 'currency'>): string {
  return `${a.vendor ?? '?'} ${a.total_amount ?? ''} ${a.currency ?? ''}`.trim();
}

export interface RowMeta {
  file_name: string;
  drive_link: string;
  /** ISO timestamp; injectable so callers/tests are deterministic. */
  processed_at?: string;
}

/** Build the Sheet row from an analysis + source metadata. */
export function analysisToRow(a: DocumentAnalysis, meta: RowMeta): SheetRow {
  return {
    vendor: a.vendor ?? '',
    invoice_date: a.invoice_date ?? '',
    total_amount: a.total_amount?.toString() ?? '',
    currency: a.currency ?? '',
    tax_amount: a.tax_amount?.toString() ?? '',
    invoice_number: a.invoice_number ?? '',
    confidence: a.confidence.toFixed(2),
    status: decideStatus(a),
    file_name: meta.file_name,
    drive_link: meta.drive_link,
    processed_at: meta.processed_at ?? new Date().toISOString(),
  };
}

// ---- Gemini error classification (shared by all ingestion paths) ----

/** Transient = worth retrying later (overload / rate-limit / 5xx). */
export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504)\b/.test(msg) ||
    /high demand|overloaded|unavailable|rate limit/i.test(msg);
}

/**
 * Permanent = can never succeed on retry. Includes 400-class input errors AND
 * Gemini refusals/safety blocks, which return prose instead of JSON ("No JSON in
 * Gemini response") — common for photos of people, which are not receipts anyway.
 */
export function isPermanentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b400\b|Bad Request|Unable to process input|No JSON in Gemini response|cannot fulfill|safety/i
    .test(msg);
}

/** Compress a raw error into a short, human-readable Log detail. */
export function shortError(message: string): string {
  if (/\b429\b|quota|rate limit/i.test(message)) return 'Gemini quota/rate-limit (429), will retry';
  if (/\b5\d\d\b|overloaded|unavailable/i.test(message)) return 'Gemini temporarily unavailable, will retry';
  return message.slice(0, 120);
}
