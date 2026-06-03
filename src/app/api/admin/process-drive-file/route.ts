import { NextRequest, NextResponse } from 'next/server';
import { downloadFile } from '@/lib/drive';
import { getDriveClient } from '@/lib/auth';
import { analyzeDocument } from '@/lib/gemini';
import { appendRow, ensureSheetHeaders } from '@/lib/sheets';
import type { SheetRow, InvoiceStatus } from '@/lib/types';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

/**
 * Admin: re-analyze specific Drive files by ID (already in Processed/Ignored) and
 * append receipts to the Sheet. Lets us rebuild the Sheet without re-ingesting from
 * Gmail (which the filename dedup would skip). Protected by CRON_SECRET.
 *
 * GET ?ids=<id1>,<id2>,...
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const ids = (req.nextUrl.searchParams.get('ids') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ error: 'Missing ?ids=' }, { status: 400 });
  }

  try {
    await ensureSheetHeaders();
    const drive = getDriveClient();
    const results: unknown[] = [];

    for (const id of ids) {
      const meta = await drive.files.get({
        fileId: id,
        fields: 'name, mimeType, webViewLink',
      });
      const name = meta.data.name ?? id;
      const mimeType = meta.data.mimeType ?? 'application/pdf';
      const content = await downloadFile(id);
      const invoice = await analyzeDocument(content, mimeType);

      if (!invoice.is_invoice || invoice.confidence < 0.5) {
        results.push({ id, name, status: 'rejected_not_receipt' });
        continue;
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
        file_name: name,
        drive_link: meta.data.webViewLink ?? '',
        processed_at: new Date().toISOString(),
      };
      await appendRow(row);
      results.push({ id, name, status: status.toLowerCase().replace(' ', '_'), vendor: invoice.vendor, total: invoice.total_amount, currency: invoice.currency });
    }

    return NextResponse.json({ results });
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
