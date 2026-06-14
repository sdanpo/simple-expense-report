import { NextRequest, NextResponse } from 'next/server';
import { analyzeText } from '@/lib/gemini';
import { appendRow, ensureSheetHeaders, appendLog } from '@/lib/sheets';
import { isReceipt, analysisToRow, summarize } from '@/lib/pipeline';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Admin: analyze a receipt that arrives as email body text (Uber, Metropark, and
 * other senders that put the receipt in the message body instead of an attachment).
 * Protected by CRON_SECRET.
 *
 * POST { "text": "...", "file_name": "label", "source_link": "https://mail..." }
 */
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { text?: string; file_name?: string; source_link?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.text) {
    return NextResponse.json({ error: 'Missing "text"' }, { status: 400 });
  }

  try {
    await ensureSheetHeaders();
    const invoice = await analyzeText(body.text);
    if (!isReceipt(invoice)) {
      await appendLog([{ source: 'vercel', event: 'ignored',
        detail: `${body.file_name ?? 'email body'} → email body not a receipt` }]);
      return NextResponse.json({ status: 'not_a_receipt', analysis: invoice });
    }

    const row = analysisToRow(invoice, {
      file_name: body.file_name ?? 'email-body-receipt',
      drive_link: body.source_link ?? '',
    });
    await appendRow(row);

    await appendLog([{
      source: 'vercel', event: row.status === 'Approved' ? 'approved' : 'needs_review',
      detail: `${body.file_name ?? 'email body'} → email-body receipt: ${summarize(invoice)}`,
    }]);
    return NextResponse.json({ status: row.status.toLowerCase().replace(' ', '_'), row });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // allow if not set (dev mode)
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${secret}`;
}
