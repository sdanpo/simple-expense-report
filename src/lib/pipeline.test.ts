import { describe, it, expect } from 'vitest';
import {
  isReceipt,
  decideStatus,
  summarize,
  analysisToRow,
  isTransientError,
  isPermanentError,
  shortError,
  MIN_CONFIDENCE,
  AUTO_APPROVE_CONFIDENCE,
} from './pipeline';
import type { DocumentAnalysis } from './types';

function analysis(over: Partial<DocumentAnalysis> = {}): DocumentAnalysis {
  return {
    is_invoice: true,
    confidence: 0.9,
    vendor: 'Gett',
    invoice_date: '2026-06-01',
    total_amount: 42.5,
    currency: 'ILS',
    tax_amount: 6.5,
    invoice_number: 'INV-1',
    ...over,
  };
}

describe('isReceipt', () => {
  it('accepts an invoice at/above the confidence floor', () => {
    expect(isReceipt({ is_invoice: true, confidence: MIN_CONFIDENCE })).toBe(true);
    expect(isReceipt({ is_invoice: true, confidence: 0.99 })).toBe(true);
  });
  it('rejects non-invoices regardless of confidence', () => {
    expect(isReceipt({ is_invoice: false, confidence: 1 })).toBe(false);
  });
  it('rejects invoices below the confidence floor', () => {
    expect(isReceipt({ is_invoice: true, confidence: MIN_CONFIDENCE - 0.01 })).toBe(false);
  });
});

describe('decideStatus', () => {
  it('approves when all core fields present and confidence high', () => {
    expect(decideStatus(analysis({ confidence: AUTO_APPROVE_CONFIDENCE }))).toBe('Approved');
  });
  it('needs review when confidence just below the auto-approve bar', () => {
    expect(decideStatus(analysis({ confidence: AUTO_APPROVE_CONFIDENCE - 0.01 }))).toBe('Needs Review');
  });
  it('needs review when a core field is missing even at high confidence', () => {
    expect(decideStatus(analysis({ vendor: null }))).toBe('Needs Review');
    expect(decideStatus(analysis({ invoice_date: null }))).toBe('Needs Review');
    expect(decideStatus(analysis({ total_amount: null }))).toBe('Needs Review');
  });
});

describe('summarize', () => {
  it('joins vendor/amount/currency', () => {
    expect(summarize({ vendor: 'Uber', total_amount: 10, currency: 'USD' })).toBe('Uber 10 USD');
  });
  it('uses ? for missing vendor and trims', () => {
    expect(summarize({ vendor: null, total_amount: null, currency: null })).toBe('?');
  });
});

describe('analysisToRow', () => {
  it('maps fields and formats confidence to 2 decimals', () => {
    const row = analysisToRow(analysis({ confidence: 0.834 }), {
      file_name: 'r.jpg',
      drive_link: 'http://x',
      processed_at: '2026-06-14T00:00:00.000Z',
    });
    expect(row).toMatchObject({
      vendor: 'Gett',
      invoice_date: '2026-06-01',
      total_amount: '42.5',
      currency: 'ILS',
      tax_amount: '6.5',
      invoice_number: 'INV-1',
      confidence: '0.83',
      status: 'Approved',
      file_name: 'r.jpg',
      drive_link: 'http://x',
      processed_at: '2026-06-14T00:00:00.000Z',
    });
  });
  it('coerces nulls to empty strings', () => {
    const row = analysisToRow(
      analysis({ is_invoice: true, vendor: null, invoice_date: null, total_amount: null, currency: null, tax_amount: null, invoice_number: null, confidence: 0.6 }),
      { file_name: 'f', drive_link: '' }
    );
    expect(row.vendor).toBe('');
    expect(row.total_amount).toBe('');
    expect(row.tax_amount).toBe('');
    expect(row.invoice_number).toBe('');
    expect(row.status).toBe('Needs Review');
  });
  it('defaults processed_at to a valid ISO timestamp when omitted', () => {
    const row = analysisToRow(analysis(), { file_name: 'f', drive_link: '' });
    expect(() => new Date(row.processed_at).toISOString()).not.toThrow();
    expect(row.processed_at).toBe(new Date(row.processed_at).toISOString());
  });
});

describe('error classification', () => {
  it('flags transient errors (429/5xx/overload)', () => {
    expect(isTransientError(new Error('Status 429 rate limit'))).toBe(true);
    expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransientError(new Error('model is overloaded'))).toBe(true);
    expect(isTransientError(new Error('plain failure'))).toBe(false);
  });
  it('flags permanent errors (400 / no-JSON / safety)', () => {
    expect(isPermanentError(new Error('400 Bad Request'))).toBe(true);
    expect(isPermanentError(new Error('No JSON in Gemini response: sorry'))).toBe(true);
    expect(isPermanentError(new Error('blocked by safety'))).toBe(true);
    expect(isPermanentError(new Error('503 unavailable'))).toBe(false);
  });
  it('transient and permanent are mutually exclusive for typical errors', () => {
    const samples = ['429', '400', 'No JSON in Gemini response', '503', 'overloaded'];
    for (const s of samples) {
      const e = new Error(s);
      expect(isTransientError(e) && isPermanentError(e)).toBe(false);
    }
  });
  it('shortError summarizes quota and 5xx', () => {
    expect(shortError('Error 429 quota exceeded')).toMatch(/quota/);
    expect(shortError('502 overloaded')).toMatch(/unavailable/);
    expect(shortError('weird thing happened')).toBe('weird thing happened');
  });
});
