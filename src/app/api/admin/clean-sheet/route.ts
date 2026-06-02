import { NextRequest, NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const SHEET_NAME = 'Invoices';

/**
 * Admin: delete ALL data rows from the Invoices sheet (header row is kept).
 * Used to clear test/stale rows before a clean backfill. Protected by CRON_SECRET.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const sheets = getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID!;

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = meta.data.sheets?.find((s) => s.properties?.title === SHEET_NAME);
    if (!sheet) {
      return NextResponse.json({ error: `Sheet "${SHEET_NAME}" not found` }, { status: 404 });
    }
    const sheetId = sheet.properties!.sheetId!;

    const data = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_NAME}!A:K`,
    });
    const numRows = (data.data.values ?? []).length;
    if (numRows <= 1) {
      return NextResponse.json({ removed: 0 });
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: numRows },
            },
          },
        ],
      },
    });

    return NextResponse.json({ removed: numRows - 1 });
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
