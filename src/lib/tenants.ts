// Where does an upload go? — multi-tenant routing for /api/inbound.
//
// The system began single-tenant: one spreadsheet (GOOGLE_SHEETS_ID) and one Drive
// folder (GOOGLE_DRIVE_PROCESSED_ID) shared by every upload. That is correct for one
// owner and wrong the moment a second person installs the app — their receipts would
// land in the owner's spreadsheet.
//
// A "tenant" is just an answer to that question. It is resolved from the bearer token
// the device already sends, so the phone gains no new concepts: one token per person,
// each pointing at that person's own Sheet (and, optionally, their own Drive folder for
// the archived images).
//
// BACK-COMPAT IS TOTAL AND DELIBERATE. Any token that has no explicit tenant entry —
// including every token already in INBOUND_TOKENS and CRON_SECRET — resolves to the
// DEFAULT tenant, which is exactly the old env-var pair. An existing deployment that
// never sets INBOUND_TENANTS behaves identically to before.
//
// Configuration (Vercel → Environment Variables):
//
//   INBOUND_TENANTS = [
//     {"token":"…","id":"hadas","sheetId":"1AbC…","processedFolderId":"1XyZ…"},
//     {"token":"…","id":"dan",  "sheetId":"1DeF…"}
//   ]
//
// `id` is a label for the log only and is never secret. `processedFolderId` may be
// omitted: the row is still written, just without a link to the image.

export interface Tenant {
  /** Short label used in log lines. Never secret, never a credential. */
  id: string;
  /** Destination spreadsheet for this tenant's rows. */
  sheetId: string;
  /** Drive folder for archived images. Empty ⇒ skip archival, still write the row. */
  processedFolderId: string;
  /**
   * This tenant's own Gemini API key. Empty ⇒ fall back to the deployment's GEMINI_API_KEY,
   * i.e. the owner pays. Set it so the tenant's own account carries the AI cost and quota.
   */
  geminiApiKey: string;
}

/** The single-tenant configuration the system shipped with. */
export function defaultTenant(env: NodeJS.ProcessEnv = process.env): Tenant {
  return {
    id: 'default',
    sheetId: (env.GOOGLE_SHEETS_ID ?? '').trim(),
    processedFolderId: (env.GOOGLE_DRIVE_PROCESSED_ID ?? '').trim(),
    // Deliberately empty: the default tenant uses the module-level client built from
    // GEMINI_API_KEY, so behaviour is byte-identical to before this field existed.
    geminiApiKey: '',
  };
}

/**
 * Parse INBOUND_TENANTS into a token → Tenant map.
 *
 * Hostile input is survivable by design: this runs on the ingestion path, and a typo in
 * an env var must never take uploads down. Anything malformed is skipped and the caller
 * falls back to the default tenant — a receipt landing in the wrong-but-configured place
 * is recoverable, a 500 on every upload is not.
 *
 * Entries are skipped when `token` or `sheetId` is missing/blank. On a duplicate token
 * the FIRST entry wins, so the result never depends on object iteration luck.
 */
export function parseTenants(env: NodeJS.ProcessEnv = process.env): Map<string, Tenant> {
  const out = new Map<string, Tenant>();
  const raw = (env.INBOUND_TENANTS ?? '').trim();
  if (!raw) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately quiet-but-visible: one line, no secrets, ingestion continues.
    console.error('INBOUND_TENANTS is not valid JSON — falling back to the default tenant');
    return out;
  }
  if (!Array.isArray(parsed)) {
    console.error('INBOUND_TENANTS must be a JSON array — falling back to the default tenant');
    return out;
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const token = typeof e.token === 'string' ? e.token.trim() : '';
    const sheetId = typeof e.sheetId === 'string' ? e.sheetId.trim() : '';
    if (!token || !sheetId) continue;
    if (out.has(token)) continue; // first wins — deterministic

    const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : 'tenant';
    const processedFolderId =
      typeof e.processedFolderId === 'string' ? e.processedFolderId.trim() : '';
    const geminiApiKey = typeof e.geminiApiKey === 'string' ? e.geminiApiKey.trim() : '';

    out.set(token, { id, sheetId, processedFolderId, geminiApiKey });
  }
  return out;
}

/**
 * Tokens that exist only in INBOUND_TENANTS.
 *
 * Callers add these to the accepted-token list so a tenant does not have to be declared
 * twice (once to authenticate, once to route). Listing a token in both places is
 * harmless.
 */
export function tenantTokens(env: NodeJS.ProcessEnv = process.env): string[] {
  return Array.from(parseTenants(env).keys());
}

/** Extract the bearer value from an Authorization header, or '' if there isn't one. */
export function bearerToken(authHeader: string | null): string {
  if (!authHeader) return '';
  const m = /^Bearer\s+(.+)$/.exec(authHeader.trim());
  return m ? m[1] : '';
}

/**
 * Resolve the destination for a request.
 *
 * Never returns null: an authenticated request with no explicit tenant is the original
 * single-tenant case and goes to the default. Authentication is a separate concern
 * (`authorizeInbound`) and must run first — this function assumes the caller is allowed.
 */
export function resolveTenant(
  authHeader: string | null,
  env: NodeJS.ProcessEnv = process.env
): Tenant {
  const token = bearerToken(authHeader);
  if (token) {
    const hit = parseTenants(env).get(token);
    if (hit) return hit;
  }
  return defaultTenant(env);
}
