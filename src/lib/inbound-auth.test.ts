import { describe, it, expect } from 'vitest';
import { getInboundTokens, authorizeInbound } from './inbound-auth';

describe('getInboundTokens', () => {
  it('parses comma-separated INBOUND_TOKENS and trims', () => {
    expect(getInboundTokens({ INBOUND_TOKENS: ' a , b ,c' } as any)).toEqual(['a', 'b', 'c']);
  });
  it('includes CRON_SECRET as an accepted token', () => {
    expect(getInboundTokens({ CRON_SECRET: 's3cret' } as any)).toEqual(['s3cret']);
  });
  it('combines both sources and drops empties', () => {
    expect(getInboundTokens({ INBOUND_TOKENS: 'x,,', CRON_SECRET: 'y' } as any)).toEqual(['x', 'y']);
  });
  it('returns empty when nothing configured', () => {
    expect(getInboundTokens({} as any)).toEqual([]);
  });
});

describe('authorizeInbound', () => {
  it('allows everything in dev mode (no tokens configured)', () => {
    expect(authorizeInbound(null, [])).toEqual({ ok: true });
    expect(authorizeInbound('Bearer whatever', [])).toEqual({ ok: true });
  });
  it('accepts a valid bearer token', () => {
    expect(authorizeInbound('Bearer good', ['good'])).toEqual({ ok: true });
    expect(authorizeInbound('  Bearer good  ', ['good'])).toEqual({ ok: true });
  });
  it('rejects a missing header', () => {
    const v = authorizeInbound(null, ['good']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(401);
  });
  it('rejects a non-bearer header', () => {
    expect(authorizeInbound('Basic abc', ['good']).ok).toBe(false);
  });
  it('rejects a wrong token', () => {
    expect(authorizeInbound('Bearer bad', ['good']).ok).toBe(false);
  });
  it('matches the token exactly (no prefix match)', () => {
    expect(authorizeInbound('Bearer goodx', ['good']).ok).toBe(false);
  });
});
