import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import type { DocumentAnalysis } from '@/lib/types';

// --- Mock the IO boundaries; keep all pure logic real. ---
vi.mock('@/lib/gemini', () => ({
  analyzeDocument: vi.fn(),
  isSupportedMimeType: (m: string) =>
    ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']
      .includes((m || '').toLowerCase()),
}));

vi.mock('@/lib/sheets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sheets')>();
  return {
    ...actual, // keep the real, pure dedupKey
    ensureSheetHeaders: vi.fn(async () => {}),
    appendRow: vi.fn(async () => {}),
    appendLog: vi.fn(async () => {}),
    getExistingDedupKeys: vi.fn(async () => new Set<string>()),
  };
});

import { POST } from '@/app/api/inbound/route';
import { analyzeDocument } from '@/lib/gemini';
import { appendRow, getExistingDedupKeys } from '@/lib/sheets';
import { dedupKey } from '@/lib/sheets';

const mockAnalyze = vi.mocked(analyzeDocument);
const mockAppendRow = vi.mocked(appendRow);
const mockDedup = vi.mocked(getExistingDedupKeys);

const TOKEN = 'testtoken';

function receipt(over: Partial<DocumentAnalysis> = {}): DocumentAnalysis {
  return {
    is_invoice: true,
    confidence: 0.95,
    vendor: 'Gett',
    invoice_date: '2026-06-01',
    total_amount: 42.5,
    currency: 'ILS',
    tax_amount: 6.5,
    invoice_number: 'INV-1',
    ...over,
  };
}

function buildReq(opts: {
  token?: string | null;
  bytes?: Uint8Array;
  type?: string;
  fileName?: string;
  omitFile?: boolean;
  extra?: Record<string, string>;
}): NextRequest {
  const form = new FormData();
  if (!opts.omitFile) {
    const bytes = opts.bytes ?? new Uint8Array(2048); // default ~2KB, passes size floor
    const blob = new Blob([bytes as unknown as BlobPart], { type: opts.type ?? 'image/jpeg' });
    form.append('file', blob, opts.fileName ?? 'receipt.jpg');
  }
  for (const [k, v] of Object.entries(opts.extra ?? {})) form.append(k, v);

  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token) headers['authorization'] = `Bearer ${token}`;

  return new Request('http://localhost/api/inbound', {
    method: 'POST',
    body: form,
    headers,
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INBOUND_TOKENS = TOKEN;
  delete process.env.CRON_SECRET;
  mockDedup.mockResolvedValue(new Set<string>());
});

describe('/api/inbound — happy paths', () => {
  it('approves a high-confidence receipt and writes one row', async () => {
    mockAnalyze.mockResolvedValue(receipt());
    const res = await POST(buildReq({ extra: { client_dedup_id: 'abc' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('approved');
    expect(body.row.vendor).toBe('Gett');
    expect(mockAppendRow).toHaveBeenCalledTimes(1);
  });

  it('flags a low-confidence/missing-field receipt as needs_review', async () => {
    mockAnalyze.mockResolvedValue(receipt({ vendor: null, confidence: 0.6 }));
    const res = await POST(buildReq({}));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('needs_review');
    expect(mockAppendRow).toHaveBeenCalledTimes(1);
  });
});

describe('/api/inbound — non-receipt / dedup (terminal 200, no row)', () => {
  it('returns not_a_receipt when Gemini says it is not an invoice', async () => {
    mockAnalyze.mockResolvedValue(receipt({ is_invoice: false }));
    const res = await POST(buildReq({}));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('not_a_receipt');
    expect(mockAppendRow).not.toHaveBeenCalled();
  });

  it('returns not_a_receipt when confidence is below the floor', async () => {
    mockAnalyze.mockResolvedValue(receipt({ confidence: 0.3 }));
    const res = await POST(buildReq({}));
    expect((await res.json()).status).toBe('not_a_receipt');
    expect(mockAppendRow).not.toHaveBeenCalled();
  });

  it('detects a duplicate already in the sheet and writes no row', async () => {
    const r = receipt();
    mockDedup.mockResolvedValue(new Set([dedupKey(r)]));
    mockAnalyze.mockResolvedValue(r);
    const res = await POST(buildReq({}));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('duplicate');
    expect(mockAppendRow).not.toHaveBeenCalled();
  });
});

describe('/api/inbound — input guards', () => {
  it('ignores unsupported type without calling Gemini', async () => {
    const res = await POST(buildReq({ type: 'image/heic', fileName: 'x.heic' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('ignored_unsupported_type');
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('ignores a too-small file', async () => {
    const res = await POST(buildReq({ bytes: new Uint8Array(10) }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('ignored_too_small');
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('rejects a too-large file with 413', async () => {
    const res = await POST(buildReq({ bytes: new Uint8Array(20 * 1024 * 1024 + 1) }));
    expect(res.status).toBe(413);
    expect((await res.json()).status).toBe('too_large');
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('returns 400 when no file is provided', async () => {
    const res = await POST(buildReq({ omitFile: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).status).toBe('bad_request');
  });
});

describe('/api/inbound — auth', () => {
  it('rejects a missing token with 401', async () => {
    const res = await POST(buildReq({ token: null }));
    expect(res.status).toBe(401);
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('rejects a wrong token with 401', async () => {
    const res = await POST(buildReq({ token: 'nope' }));
    expect(res.status).toBe(401);
  });

  it('allows in dev mode when no token configured', async () => {
    delete process.env.INBOUND_TOKENS;
    delete process.env.CRON_SECRET;
    mockAnalyze.mockResolvedValue(receipt());
    const res = await POST(buildReq({ token: null }));
    expect(res.status).toBe(200);
  });
});

describe('/api/inbound — Gemini error handling (retryable vs terminal)', () => {
  it('returns 503 retry on a transient Gemini error (no row)', async () => {
    mockAnalyze.mockRejectedValue(new Error('503 model is overloaded'));
    const res = await POST(buildReq({}));
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('retry');
    expect(mockAppendRow).not.toHaveBeenCalled();
  });

  it('returns 200 ignored_unprocessable on a permanent Gemini error', async () => {
    mockAnalyze.mockRejectedValue(new Error('No JSON in Gemini response: refusal'));
    const res = await POST(buildReq({}));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('ignored_unprocessable');
    expect(mockAppendRow).not.toHaveBeenCalled();
  });
});
