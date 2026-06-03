import { NextRequest, NextResponse } from 'next/server';
import { analyzeText } from '@/lib/gemini';
import { appendRow, ensureSheetHeaders } from '@/lib/sheets';
import type { SheetRow, InvoiceStatus } from '@/lib/types';

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
    if (!invoice.is_invoice || invoice.confidence < 0.5) {
      return NextResponse.json({ status: 'not_a_receipt', analysis: invoice });
    }

    const autoApprove =
      invoice.vendor !== null &&
      invoice.invoice_date !== null &&
      invoice.total_amount !== null &&
      invoice.confidence >= 0.8;
    const status: InvoiceStatus = autoApprove ? 'Approved' : 'Needs Review';

    const row: SheetRow = {
      vendor: invoice.vendor ?? '',
      invoice_date: invoice.invoice_date ?? '',
      total_amount: invoice.total_amount?.toString() ?? '',
      currency: invoice.currency ?? '',
      tax_amount: invoice.tax_amount?.toString() ?? '',
      invoice_number: invoice.invoice_number ?? '',
      confidence: invoice.confidence.toFixed(2),
      status,
      file_name: body.file_name ?? 'email-body-receipt',
      drive_link: body.source_link ?? '',
      processed_at: new Date().toISOString(),
    };
    await appendRow(row);

    return NextResponse.json({ status: status.toLowerCase().replace(' ', '_'), row });
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
