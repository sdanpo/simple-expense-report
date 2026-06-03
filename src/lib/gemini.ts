import { GoogleGenerativeAI } from '@google/generative-ai';
import type { DocumentAnalysis } from './types';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
// gemini-2.5-flash-lite: fast (no thinking latency), and its free-tier daily quota is a
// SEPARATE pool from gemini-2.5-flash / 2.0-flash (which are tiny: ~20 requests/day).
// Override with the GEMINI_MODEL env var if quotas change again.
const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite' });

const SUPPORTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

export function isSupportedMimeType(mimeType: string): boolean {
  return SUPPORTED_MIME_TYPES.has(mimeType.toLowerCase());
}

function extractJSON(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON in Gemini response: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504)\b/.test(msg) || /high demand|overloaded|unavailable|rate limit/i.test(msg);
}

// Call Gemini with retry/backoff on transient (overload / rate-limit) errors.
async function generateWithRetry(content: Buffer, mimeType: string, prompt: string): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent([
        prompt,
        { inlineData: { data: content.toString('base64'), mimeType } },
      ]);
      return extractJSON(result.response.text());
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === MAX_RETRIES - 1) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Classify AND extract in a single Gemini call — the free-tier daily request quota is
 * very small, so every file must cost exactly one request.
 */
const ANALYZE_PROMPT = `You are a strict expense-RECEIPT analyzer. Your job is to accept ONLY
proof-of-payment documents and reject everything else.

The deciding test: does the document show a CONCRETE AMOUNT that the person was actually
CHARGED or PAID for a purchase, together with a vendor/merchant name?

ACCEPT (is_invoice = true) if YES — it is a real expense. This INCLUDES: store/restaurant
receipts, ride/taxi receipts (Gett, Uber, Bolt), parking & toll receipts, utility bills,
subscription invoices, AND travel-insurance premiums / eSIM / booking charges — any purchase
with a price. Hebrew docs ("חשבונית מס/קבלה", "קבלה", "אישור תשלום") count.

REJECT (is_invoice = false) only if there is NO amount actually charged — i.e. the document is
informational, not a purchase:
- Insurance POLICY TERMS or coverage-details pages that show NO premium/price (just conditions).
  (NOTE: if an insurance document DOES show a premium/cost that was charged, ACCEPT it.)
- Pension / provident-fund / gemel statements or notices ("הודעה על הפסקת תשלום") — no purchase.
- Bank/account statements, balance notices, schedules, contracts, forms, book/equipment lists,
  reservation confirmations with no price, shipping/delivery notices.
- Documents that explicitly say "this is not a payment receipt" / "charge summary".
- Marketing emails, newsletters, product images, screenshots, personal photos.

When unsure whether a real amount was charged, set is_invoice = false.

CURRENCY — read the actual symbol/code on the document, do not assume:
  ₪ or NIS or ש"ח or אג' -> "ILS"
  $ or US$ or USD       -> "USD"
  € or EUR              -> "EUR"
  £ or GBP              -> "GBP"
A Hebrew document is NOT automatically ILS — if the amount is shown in $ or €, use that.

If is_invoice is false, set every other field to null.

Return JSON only:
{
  "is_invoice": boolean,
  "confidence": number,           // 0.0-1.0 certainty
  "vendor": string | null,
  "invoice_date": string | null,  // YYYY-MM-DD
  "total_amount": number | null,
  "currency": string | null,      // 3-letter ISO code
  "tax_amount": number | null,
  "invoice_number": string | null
}
Rules: do not invent values; use null if unknown.`;

export async function analyzeDocument(
  content: Buffer,
  mimeType: string
): Promise<DocumentAnalysis> {
  return (await generateWithRetry(content, mimeType, ANALYZE_PROMPT)) as DocumentAnalysis;
}

/** Same analysis for receipts that arrive as email body text (Uber, Metropark, etc.). */
export async function analyzeText(text: string): Promise<DocumentAnalysis> {
  const result = await model.generateContent([
    ANALYZE_PROMPT + '\n\nDOCUMENT TEXT:\n' + text.slice(0, 20000),
  ]);
  return extractJSON(result.response.text()) as DocumentAnalysis;
}
