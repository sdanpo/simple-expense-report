import { NextRequest, NextResponse } from 'next/server';
import { appendLog, type LogEntry } from '@/lib/sheets';

export const dynamic = 'force-dynamic';

/**
 * Admin: append an entry to the unified Log tab. Lets the Apps Script ingester
 * record its activity in the SAME place as the Vercel processor, so there is one
 * log to read (the Sheet's "Log" tab). Protected by CRON_SECRET.
 *
 * POST { "event": "ingest", "detail": "saved 2 attachments", "source": "apps-script" }
 */
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let b: { event?: string; detail?: string; source?: string };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const entry: LogEntry = {
    source: b.source === 'vercel' ? 'vercel' : 'apps-script',
    event: (b.event || 'info').slice(0, 40),
    detail: (b.detail || '').slice(0, 500),
  };
  await appendLog([entry]);
  return NextResponse.json({ ok: true });
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${secret}`;
}
