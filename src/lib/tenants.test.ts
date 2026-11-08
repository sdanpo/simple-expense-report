import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseTenants,
  tenantTokens,
  defaultTenant,
  resolveTenant,
  bearerToken,
} from './tenants';

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

afterEach(() => vi.restoreAllMocks());

/** Silence the deliberate console.error on malformed config while asserting on it. */
function quiet() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('defaultTenant', () => {
  it('is the original single-tenant env pair', () => {
    expect(defaultTenant(env({ GOOGLE_SHEETS_ID: 'sheet1', GOOGLE_DRIVE_PROCESSED_ID: 'folder1' })))
      .toEqual({ id: 'default', sheetId: 'sheet1', processedFolderId: 'folder1' });
  });
  it('tolerates an unconfigured deployment without throwing', () => {
    expect(defaultTenant(env({}))).toEqual({ id: 'default', sheetId: '', processedFolderId: '' });
  });
});

describe('parseTenants', () => {
  it('is empty when INBOUND_TENANTS is unset or blank', () => {
    expect(parseTenants(env({})).size).toBe(0);
    expect(parseTenants(env({ INBOUND_TENANTS: '   ' })).size).toBe(0);
  });

  it('parses entries and trims whitespace', () => {
    const m = parseTenants(env({
      INBOUND_TENANTS: JSON.stringify([
        { token: ' t1 ', id: ' hadas ', sheetId: ' s1 ', processedFolderId: ' f1 ' },
      ]),
    }));
    expect(m.get('t1')).toEqual({ id: 'hadas', sheetId: 's1', processedFolderId: 'f1' });
  });

  it('allows a tenant with no Drive folder (row still written, no image link)', () => {
    const m = parseTenants(env({ INBOUND_TENANTS: JSON.stringify([{ token: 't', sheetId: 's' }]) }));
    expect(m.get('t')).toEqual({ id: 'tenant', sheetId: 's', processedFolderId: '' });
  });

  it('skips entries missing a token or a sheetId', () => {
    const m = parseTenants(env({
      INBOUND_TENANTS: JSON.stringify([
        { token: '', sheetId: 's' },
        { token: 't', sheetId: '' },
        { sheetId: 's2' },
        { token: 'good', sheetId: 'ok' },
      ]),
    }));
    expect(Array.from(m.keys())).toEqual(['good']);
  });

  it('keeps the FIRST entry on a duplicate token, deterministically', () => {
    const m = parseTenants(env({
      INBOUND_TENANTS: JSON.stringify([
        { token: 'dup', sheetId: 'first' },
        { token: 'dup', sheetId: 'second' },
      ]),
    }));
    expect(m.get('dup')?.sheetId).toBe('first');
  });

  // The ingestion path must survive a typo in an env var: a receipt going to the
  // configured-but-default place is recoverable, a 500 on every upload is not.
  it('survives malformed JSON and says so once', () => {
    const spy = quiet();
    expect(parseTenants(env({ INBOUND_TENANTS: '{not json' })).size).toBe(0);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('survives a JSON object instead of an array', () => {
    const spy = quiet();
    expect(parseTenants(env({ INBOUND_TENANTS: '{"token":"t"}' })).size).toBe(0);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('ignores junk entries inside a valid array', () => {
    const spy = quiet();
    const m = parseTenants(env({ INBOUND_TENANTS: '[null, 42, "x", {"token":"t","sheetId":"s"}]' }));
    expect(Array.from(m.keys())).toEqual(['t']);
    expect(spy).not.toHaveBeenCalled(); // array itself was fine
  });
});

describe('tenantTokens', () => {
  it('lists only tokens that carry a tenant', () => {
    expect(tenantTokens(env({
      INBOUND_TENANTS: JSON.stringify([
        { token: 'a', sheetId: 's' },
        { token: 'b', sheetId: '' }, // skipped
      ]),
    }))).toEqual(['a']);
  });
  it('is empty when nothing is configured', () => {
    expect(tenantTokens(env({}))).toEqual([]);
  });
});

describe('bearerToken', () => {
  it('extracts the value and tolerates surrounding whitespace', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('  Bearer abc  ')).toBe('abc');
  });
  it('returns empty for missing or non-bearer headers', () => {
    expect(bearerToken(null)).toBe('');
    expect(bearerToken('Basic abc')).toBe('');
  });
});

describe('resolveTenant', () => {
  const e = env({
    GOOGLE_SHEETS_ID: 'ownerSheet',
    GOOGLE_DRIVE_PROCESSED_ID: 'ownerFolder',
    INBOUND_TENANTS: JSON.stringify([
      { token: 'hadasToken', id: 'hadas', sheetId: 'hadasSheet', processedFolderId: 'hadasFolder' },
    ]),
  });

  it('routes a tenant token to that tenant', () => {
    expect(resolveTenant('Bearer hadasToken', e))
      .toEqual({ id: 'hadas', sheetId: 'hadasSheet', processedFolderId: 'hadasFolder' });
  });

  // The whole back-compat promise in one test: an existing INBOUND_TOKENS/CRON_SECRET
  // device keeps writing exactly where it always did.
  it('routes an unknown-but-authorized token to the default tenant', () => {
    expect(resolveTenant('Bearer legacyToken', e))
      .toEqual({ id: 'default', sheetId: 'ownerSheet', processedFolderId: 'ownerFolder' });
  });

  it('routes a missing header to the default tenant (dev mode)', () => {
    expect(resolveTenant(null, e).sheetId).toBe('ownerSheet');
  });

  it('does not prefix-match a token', () => {
    expect(resolveTenant('Bearer hadasTokenX', e).id).toBe('default');
  });
});
