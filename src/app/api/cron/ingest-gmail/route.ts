import { NextRequest, NextResponse } from 'next/server';
import { ingestGmailDirect } from '@/lib/gmail-ingest';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

// Caps messages per invocation so a backlog drains over ticks without timing out.
const MAX_MESSAGES_PER_RUN = Number(process.env.MAX_GMAIL_PER_RUN) || 8;

/**
 * Cron: read invoice-like Gmail directly and write rows to the Sheet. This is the
 * Vercel-side replacement for the Google Apps Script ingester. Protected by
 * CRON_SECRET (Vercel cron sends it automatically).
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const summary = await ingestGmailDirect(MAX_MESSAGES_PER_RUN);
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${secret}`;
}
