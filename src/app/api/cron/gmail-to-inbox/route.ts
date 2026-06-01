import { NextRequest, NextResponse } from 'next/server';
import { ingestGmailAttachments } from '@/lib/gmail';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!process.env.GMAIL_REFRESH_TOKEN) {
    return NextResponse.json({ skipped: true, reason: 'Gmail not configured' });
  }

  try {
    const ingested = await ingestGmailAttachments();
    return NextResponse.json({ ingested });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Gmail ingestion error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${secret}`;
}
