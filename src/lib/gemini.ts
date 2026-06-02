import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ClassificationResult, InvoiceData } from './types';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
// gemini-2.5-flash: gemini-2.0-flash no longer has free-tier quota (429, limit: 0).
// Override with the GEMINI_MODEL env var if quotas change again.
const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });

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

export async function classifyDocument(
  content: Buffer,
  mimeType: string
): Promise<ClassificationResult> {
  const prompt = `You are a document classifier.
Determine whether this file is an invoice, receipt, bill, or expense-related document.
Return JSON only:
{"is_invoice": boolean, "confidence": number}
Rules:
- Only classify financial documents as true
- If uncertain, return false
- Do not guess`;

  return (await generateWithRetry(content, mimeType, prompt)) as ClassificationResult;
}

export async function extractInvoiceData(
  content: Buffer,
  mimeType: string
): Promise<InvoiceData> {
  const prompt = `You are an invoice extraction engine.
Extract structured invoice data.
Return JSON only.
Fields:
{
  "vendor": string | null,
  "invoice_date": string | null,
  "total_amount": number | null,
  "currency": string | null,
  "tax_amount": number | null,
  "invoice_number": string | null,
  "confidence": number
}
Rules:
- Do not invent values
- Use null if unknown
- invoice_date format: YYYY-MM-DD
- currency: 3-letter ISO code (ILS, USD, EUR, etc.)
- confidence: 0.0 to 1.0 reflecting certainty of extraction`;

  return (await generateWithRetry(content, mimeType, prompt)) as InvoiceData;
}
