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
export async function analyzeDocument(
  content: Buffer,
  mimeType: string
): Promise<DocumentAnalysis> {
  const prompt = `You are an expense-document analyzer.

Step 1 — classify: is this file an invoice, receipt, bill, or other proof-of-payment / expense document?
This includes: store receipts, ride/taxi receipts (Gett, Uber), utility bills, subscription invoices,
insurance payment confirmations, and Hebrew documents (חשבונית, חשבונית מס, קבלה, אישור תשלום).
Hebrew documents may have reversed/right-to-left text — that does not make them less valid.
If the document shows a business/vendor name and a paid or due amount, it IS an expense document.
Marketing emails, newsletters, product images, screenshots, and personal photos without payment
details are NOT expense documents.

Step 2 — if it IS an expense document, extract its data. If not, use null for all fields.

Return JSON only:
{
  "is_invoice": boolean,
  "confidence": number,        // 0.0-1.0 certainty of classification AND extraction
  "vendor": string | null,
  "invoice_date": string | null,   // YYYY-MM-DD
  "total_amount": number | null,
  "currency": string | null,       // 3-letter ISO code (ILS, USD, EUR, ...)
  "tax_amount": number | null,
  "invoice_number": string | null
}
Rules:
- Do not invent values; use null if unknown`;

  return (await generateWithRetry(content, mimeType, prompt)) as DocumentAnalysis;
}
