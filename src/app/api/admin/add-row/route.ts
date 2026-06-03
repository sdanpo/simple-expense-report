import { NextRequest, NextResponse } from 'next/server';
import { appendRow, ensureSheetHeaders } from '@/lib/sheets';
import type { SheetRow, InvoiceStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Admin: append a receipt row with explicit values. Used for corrections / edge
 * cases where Gemini mis-reads a field (e.g. a premium priced in USD but billed in
 * ILS). Protected by CRON_SECRET.
 *
 * POST { vendor, invoice_date, total_amount, currency, tax_amount?, invoice_number?,
 *        status?, file_name?, drive_link? }
 */
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!b.vendor) {
    return NextResponse.json({ error: 'Missing "vendor"' }, { status: 400 });
  }

  try {
    await ensureSheetHeaders();
    const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
    const status = (str(b.status) || 'Approved') as InvoiceStatus;
    const row: SheetRow = {
      vendor: str(b.vendor),
      invoice_date: str(b.invoice_date),
      total_amount: str(b.total_amount),
      currency: str(b.currency),
      tax_amount: str(b.tax_amount),
      invoice_number: str(b.invoice_number),
      confidence: str(b.confidence) || '1.00',
      status,
      file_name: str(b.file_name) || 'manual-entry',
      drive_link: str(b.drive_link),
      processed_at: new Date().toISOString(),
    };
    await appendRow(row);
    return NextResponse.json({ status: 'added', row });
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
