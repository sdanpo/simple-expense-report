import { NextRequest, NextResponse } from 'next/server';
import { analyzeDocument } from '@/lib/gemini';
import { appendRow, ensureSheetHeaders } from '@/lib/sheets';
import type { SheetRow, InvoiceStatus } from '@/lib/types';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

/**
 * Admin: process a receipt/invoice from a publicly accessible URL (e.g. a Google
 * Photos direct image link) through the standard Gemini pipeline and append the
 * result to the Invoices sheet. The URL is stored as the drive_link.
 * Protected by CRON_SECRET.
 *
 * POST { "url": "https://...", "file_name": "optional display name" }
 */
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { url?: string; file_name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.url) {
    return NextResponse.json({ error: 'Missing "url"' }, { status: 400 });
  }

  try {
    const res = await fetch(body.url);
    if (!res.ok) {
      return NextResponse.json({ error: `Fetch failed: ${res.status}` }, { status: 422 });
    }
    const mimeType = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
    const content = Buffer.from(await res.arrayBuffer());

    await ensureSheetHeaders();
    const invoice = await analyzeDocument(content, mimeType);
    if (!invoice.is_invoice || invoice.confidence < 0.5) {
      return NextResponse.json({ status: 'not_an_invoice', analysis: invoice });
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
      file_name: body.file_name ?? body.url.split('/').pop() ?? 'url-upload',
      drive_link: body.url,
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
