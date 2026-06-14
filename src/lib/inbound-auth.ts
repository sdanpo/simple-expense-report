// Authentication for device uploads to /api/inbound.
//
// For the team-testing phase a per-device bearer token is sufficient and fully
// verifiable. Tokens come from INBOUND_TOKENS (comma-separated) and, as a
// convenience, CRON_SECRET is also accepted so the same secret can drive both.
//
// FUTURE: when going multi-user/public, swap this for Google ID-token verification
// (the Android app already signs in with Google) — verify the ID token and map the
// `sub` claim to a user. The route only depends on `authorizeInbound`, so that's a
// localized change.

/** Collect the set of accepted bearer tokens from the environment. */
export function getInboundTokens(env: NodeJS.ProcessEnv = process.env): string[] {
  const tokens: string[] = [];
  for (const raw of (env.INBOUND_TOKENS ?? '').split(',')) {
    const t = raw.trim();
    if (t) tokens.push(t);
  }
  const cron = (env.CRON_SECRET ?? '').trim();
  if (cron) tokens.push(cron);
  return tokens;
}

export type AuthVerdict =
  | { ok: true }
  | { ok: false; status: 401; reason: string };

/**
 * Pure auth check. If NO tokens are configured we allow the request (dev mode),
 * mirroring the existing cron/admin routes. Otherwise an exact Bearer match is
 * required.
 */
export function authorizeInbound(authHeader: string | null, tokens: string[]): AuthVerdict {
  if (tokens.length === 0) return { ok: true }; // dev mode: nothing configured
  if (!authHeader) return { ok: false, status: 401, reason: 'Missing Authorization header' };
  const m = /^Bearer\s+(.+)$/.exec(authHeader.trim());
  if (!m) return { ok: false, status: 401, reason: 'Authorization must be a Bearer token' };
  if (!tokens.includes(m[1])) return { ok: false, status: 401, reason: 'Invalid token' };
  return { ok: true };
}
