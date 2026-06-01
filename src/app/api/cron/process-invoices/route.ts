import { NextRequest, NextResponse } from 'next/server';
import { listInboxFiles, downloadFile, moveFile } from '@/lib/drive';
import { classifyDocument, extractInvoiceData, isSupportedMimeType } from '@/lib/gemini';
import { appendRow, ensureSheetHeaders } from '@/lib/sheets';
import type { SheetRow, InvoiceStatus } from '@/lib/types';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

// Cap files per invocation so we never hit the serverless function timeout.
// Caller (Apps Script / cron) re-invokes until `remaining` reaches 0.
const MAX_FILES_PER_RUN = Number(process.env.MAX_FILES_PER_RUN) || 6;

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results: { file: string; status: string; error?: string }[] = [];

  try {
    await ensureSheetHeaders();
    const allFiles = await listInboxFiles();
    const batch = allFiles.slice(0, MAX_FILES_PER_RUN);

    for (const file of batch) {
      try {
        const result = await processFile(file);
        results.push(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error processing ${file.name}:`, message);
        results.push({ file: file.name, status: 'error', error: message });
        // Leave file in Inbox — will retry next cycle
      }
    }

    const remaining = Math.max(0, allFiles.length - batch.length);
    return NextResponse.json({ processed: results.length, remaining, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function processFile(file: { id: string; name: string; mimeType: string; webViewLink: string }) {
  if (!isSupportedMimeType(file.mimeType)) {
    await moveFile(file.id, process.env.GOOGLE_DRIVE_IGNORED_ID!);
    return { file: file.name, status: 'ignored_unsupported_type' };
  }

  // Claim the file by moving it out of the Inbox BEFORE any slow work. A
  // concurrent invocation (or a retry after a timeout) that re-lists the Inbox
  // will no longer see it, preventing duplicate Sheet rows. On error we move it
  // back so the next cycle retries.
  await moveFile(file.id, process.env.GOOGLE_DRIVE_PROCESSED_ID!);

  try {
    const content = await downloadFile(file.id);

    // Step 1: Classify
    const classification = await classifyDocument(content, file.mimeType);
    if (!classification.is_invoice || classification.confidence < 0.5) {
      await moveFile(file.id, process.env.GOOGLE_DRIVE_IGNORED_ID!);
      return { file: file.name, status: 'ignored_not_invoice' };
    }

    // Step 2: Extract
    const invoice = await extractInvoiceData(content, file.mimeType);

    // Step 3: Validate
    const autoApprove =
      invoice.vendor !== null &&
      invoice.invoice_date !== null &&
      invoice.total_amount !== null &&
      invoice.confidence >= 0.8;
    const status: InvoiceStatus = autoApprove ? 'Approved' : 'Needs Review';

    // Step 4: Write to Sheets (file already in Processed from the claim step)
    const row: SheetRow = {
      vendor: invoice.vendor ?? '',
      invoice_date: invoice.invoice_date ?? '',
      total_amount: invoice.total_amount?.toString() ?? '',
      currency: invoice.currency ?? '',
      tax_amount: invoice.tax_amount?.toString() ?? '',
      invoice_number: invoice.invoice_number ?? '',
      confidence: invoice.confidence.toFixed(2),
      status,
      file_name: file.name,
      drive_link: file.webViewLink,
      processed_at: new Date().toISOString(),
    };
    await appendRow(row);

    return { file: file.name, status: status.toLowerCase().replace(' ', '_') };
  } catch (err) {
    // Roll back the claim so the file is retried next cycle.
    await moveFile(file.id, process.env.GOOGLE_DRIVE_INBOX_ID!).catch(() => {});
    throw err;
  }
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // allow if not set (dev mode)
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${secret}`;
}
