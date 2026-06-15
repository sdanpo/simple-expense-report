import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DocumentAnalysis } from '@/lib/types';

vi.mock('@/lib/auth', () => ({ getGmailClient: vi.fn() }));
vi.mock('@/lib/gemini', () => ({
  analyzeDocument: vi.fn(),
  analyzeText: vi.fn(),
  isSupportedMimeType: () => true,
}));
vi.mock('@/lib/sheets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sheets')>();
  return {
    ...actual, // real dedupKey
    ensureSheetHeaders: vi.fn(async () => {}),
    appendRow: vi.fn(async () => {}),
    appendLog: vi.fn(async () => {}),
    getExistingDedupKeys: vi.fn(async () => new Set<string>()),
  };
});

import { ingestGmailDirect, DONE_LABEL } from '@/lib/gmail-ingest';
import { getGmailClient } from '@/lib/auth';
import { analyzeDocument, analyzeText } from '@/lib/gemini';
import { appendRow, getExistingDedupKeys, dedupKey } from '@/lib/sheets';

const mockGetGmail = vi.mocked(getGmailClient);
const mockAnalyzeDoc = vi.mocked(analyzeDocument);
const mockAnalyzeText = vi.mocked(analyzeText);
const mockAppendRow = vi.mocked(appendRow);
const mockDedup = vi.mocked(getExistingDedupKeys);

const b64url = (s: string) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

function receipt(over: Partial<DocumentAnalysis> = {}): DocumentAnalysis {
  return {
    is_invoice: true, confidence: 0.95, vendor: 'Gett', invoice_date: '2026-06-01',
    total_amount: 42.5, currency: 'ILS', tax_amount: 6.5, invoice_number: 'INV-1', ...over,
  };
}

interface FakeMsg {
  id: string;
  payload: any;
  attachments?: Record<string, string>; // attachmentId -> base64url data
}

function fakeGmail(msgs: FakeMsg[]) {
  const modify = vi.fn(async () => ({ data: {} }));
  const gmail = {
    users: {
      messages: {
        list: vi.fn(async () => ({ data: { messages: msgs.map((m) => ({ id: m.id })) } })),
        get: vi.fn(async ({ id }: any) => ({ data: { payload: msgs.find((m) => m.id === id)!.payload } })),
        attachments: {
          get: vi.fn(async ({ messageId, id }: any) => ({
            data: { data: msgs.find((m) => m.id === messageId)!.attachments?.[id] ?? null },
          })),
        },
        modify,
      },
      labels: {
        list: vi.fn(async () => ({ data: { labels: [{ id: 'LDONE', name: DONE_LABEL }] } })),
        create: vi.fn(async () => ({ data: { id: 'LDONE' } })),
      },
    },
  };
  return { gmail, modify };
}

function pdfMessage(id: string): FakeMsg {
  return {
    id,
    payload: {
      headers: [{ name: 'Subject', value: 'Your tax invoice' }],
      parts: [{ filename: 'inv.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att1' } }],
    },
    attachments: { att1: b64url('%PDF-bytes') },
  };
}

function bodyMessage(id: string, text: string): FakeMsg {
  return {
    id,
    payload: {
      headers: [{ name: 'Subject', value: 'Uber receipt' }],
      parts: [{ mimeType: 'text/plain', body: { data: b64url(text) } }],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDedup.mockResolvedValue(new Set<string>());
});

describe('ingestGmailDirect', () => {
  it('processes a PDF attachment receipt, writes a row, and marks the message done', async () => {
    const { gmail, modify } = fakeGmail([pdfMessage('m1')]);
    mockGetGmail.mockReturnValue(gmail as any);
    mockAnalyzeDoc.mockResolvedValue(receipt());

    const s = await ingestGmailDirect(8);
    expect(s).toMatchObject({ scanned: 1, receipts: 1, duplicates: 0, ignored: 0, errors: 0 });
    expect(mockAppendRow).toHaveBeenCalledTimes(1);
    expect(modify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1', requestBody: { addLabelIds: ['LDONE'] } })
    );
  });

  it('processes a body-text receipt when there is no attachment', async () => {
    const { gmail } = fakeGmail([bodyMessage('m2', 'Total charged 19.90 USD to your Uber account')]);
    mockGetGmail.mockReturnValue(gmail as any);
    mockAnalyzeText.mockResolvedValue(receipt({ vendor: 'Uber', currency: 'USD', total_amount: 19.9, invoice_number: null }));

    const s = await ingestGmailDirect(8);
    expect(s.receipts).toBe(1);
    expect(mockAnalyzeText).toHaveBeenCalledOnce();
    expect(mockAppendRow).toHaveBeenCalledTimes(1);
  });

  it('marks non-receipts done but writes no row', async () => {
    const { gmail, modify } = fakeGmail([pdfMessage('m3')]);
    mockGetGmail.mockReturnValue(gmail as any);
    mockAnalyzeDoc.mockResolvedValue(receipt({ is_invoice: false }));

    const s = await ingestGmailDirect(8);
    expect(s).toMatchObject({ receipts: 0, ignored: 1 });
    expect(mockAppendRow).not.toHaveBeenCalled();
    expect(modify).toHaveBeenCalledOnce(); // still labeled so it isn't re-scanned
  });

  it('detects a duplicate already in the sheet', async () => {
    const r = receipt();
    mockDedup.mockResolvedValue(new Set([dedupKey(r)]));
    const { gmail } = fakeGmail([pdfMessage('m4')]);
    mockGetGmail.mockReturnValue(gmail as any);
    mockAnalyzeDoc.mockResolvedValue(r);

    const s = await ingestGmailDirect(8);
    expect(s.duplicates).toBe(1);
    expect(mockAppendRow).not.toHaveBeenCalled();
  });

  it('does NOT mark done on a transient error, so it retries next run', async () => {
    const { gmail, modify } = fakeGmail([pdfMessage('m5')]);
    mockGetGmail.mockReturnValue(gmail as any);
    mockAnalyzeDoc.mockRejectedValue(new Error('503 overloaded'));

    const s = await ingestGmailDirect(8);
    expect(s.errors).toBe(1);
    expect(s.receipts).toBe(0);
    expect(modify).not.toHaveBeenCalled();
  });

  it('treats a permanent Gemini error as ignored and marks done', async () => {
    const { gmail, modify } = fakeGmail([pdfMessage('m6')]);
    mockGetGmail.mockReturnValue(gmail as any);
    mockAnalyzeDoc.mockRejectedValue(new Error('No JSON in Gemini response'));

    const s = await ingestGmailDirect(8);
    expect(s.ignored).toBe(1);
    expect(s.errors).toBe(0);
    expect(modify).toHaveBeenCalledOnce();
  });

  it('reports remaining when the backlog exceeds the per-run cap', async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => pdfMessage(`b${i}`));
    const { gmail } = fakeGmail(msgs);
    mockGetGmail.mockReturnValue(gmail as any);
    mockAnalyzeDoc.mockResolvedValue(receipt({ invoice_number: null, total_amount: null })); // not dup-collapsed

    const s = await ingestGmailDirect(4);
    expect(s.scanned).toBe(4);
    expect(s.remaining).toBe(6);
  });

  it('returns an empty summary when nothing matches', async () => {
    const { gmail } = fakeGmail([]);
    mockGetGmail.mockReturnValue(gmail as any);
    const s = await ingestGmailDirect(8);
    expect(s).toMatchObject({ scanned: 0, receipts: 0, remaining: 0 });
  });
});
