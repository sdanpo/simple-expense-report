import { describe, it, expect } from 'vitest';
import {
  buildSearchQuery,
  flattenParts,
  getHeader,
  decodeBase64Url,
  selectAttachments,
  extractBodyText,
  sanitizeFileName,
  DONE_LABEL,
  type GmailPart,
} from './gmail-ingest';

const b64url = (s: string) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

describe('buildSearchQuery', () => {
  it('includes keywords, the done-label exclusion, and a recency bound', () => {
    const q = buildSearchQuery(30);
    expect(q).toContain('invoice');
    expect(q).toContain('חשבונית');
    expect(q).toContain(`-label:${DONE_LABEL}`);
    expect(q).toContain('newer_than:30d');
  });
});

describe('flattenParts', () => {
  it('flattens a nested MIME tree to leaves', () => {
    const tree: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('hi') } },
        { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64url('<b>x</b>') } }] },
      ],
    };
    const leaves = flattenParts(tree);
    expect(leaves.map((l) => l.mimeType)).toEqual(['text/plain', 'text/html']);
  });
  it('returns [] for nullish', () => {
    expect(flattenParts(null)).toEqual([]);
  });
});

describe('getHeader', () => {
  it('matches case-insensitively', () => {
    const headers = [{ name: 'Subject', value: 'Receipt' }];
    expect(getHeader(headers, 'subject')).toBe('Receipt');
    expect(getHeader(headers, 'From')).toBeNull();
  });
});

describe('decodeBase64Url', () => {
  it('decodes URL-safe base64 (with - and _)', () => {
    // bytes that base64-encode using + and / → URL-safe uses - and _
    const original = Buffer.from([0xfb, 0xff, 0xbf]);
    const urlSafe = original.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    expect(decodeBase64Url(urlSafe).equals(original)).toBe(true);
  });
});

describe('selectAttachments', () => {
  it('selects supported real attachments and skips inline/unsupported', () => {
    const payload: GmailPart = {
      parts: [
        { filename: 'a.pdf', mimeType: 'application/pdf', body: { attachmentId: 'p1' } },
        { filename: 'logo.png', mimeType: 'image/png', body: {} }, // inline: no attachmentId
        { filename: 'note.txt', mimeType: 'text/plain', body: { attachmentId: 'p2' } }, // unsupported
        { filename: 'photo.jpg', mimeType: 'image/jpeg', body: { attachmentId: 'p3' } },
      ],
    };
    const refs = selectAttachments(payload);
    expect(refs.map((r) => r.attachmentId)).toEqual(['p1', 'p3']);
  });
});

describe('extractBodyText', () => {
  it('prefers text/plain', () => {
    const payload: GmailPart = {
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('Plain receipt 42 ILS') } },
        { mimeType: 'text/html', body: { data: b64url('<b>ignored</b>') } },
      ],
    };
    expect(extractBodyText(payload)).toBe('Plain receipt 42 ILS');
  });
  it('falls back to stripped HTML', () => {
    const payload: GmailPart = {
      parts: [{ mimeType: 'text/html', body: { data: b64url('<div>Total: <b>42</b>&nbsp;ILS</div>') } }],
    };
    expect(extractBodyText(payload)).toBe('Total: 42 ILS');
  });
  it('handles a simple non-multipart body', () => {
    const payload: GmailPart = { mimeType: 'text/plain', body: { data: b64url('hello') } };
    expect(extractBodyText(payload)).toBe('hello');
  });
  it('returns empty string when there is no body', () => {
    expect(extractBodyText({ mimeType: 'multipart/mixed', parts: [] })).toBe('');
  });
});

describe('sanitizeFileName', () => {
  it('keeps Hebrew + alphanumerics and replaces the rest', () => {
    expect(sanitizeFileName('חשבונית #12/3.pdf')).toBe('חשבונית _12_3.pdf');
  });
});
