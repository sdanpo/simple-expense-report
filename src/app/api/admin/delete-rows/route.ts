import { NextRequest, NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const SHEET_NAME = 'Invoices';

/**
 * Admin: delete every data row that contains the given substring in any cell.
 * Used for targeted corrections (e.g. remove a single mis-included receipt).
 * Header row is never touched. Protected by CRON_SECRET.
 *
 * GET ?match=<substring>
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const match = req.nextUrl.searchParams.get('match');
  if (!match) {
    return NextResponse.json({ error: 'Missing ?match=' }, { status: 400 });
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
    const rows = data.data.values ?? [];

    // Collect matching data-row indices (skip header at index 0).
    const toDelete: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i] ?? []).some((cell) => String(cell).includes(match))) {
        toDelete.push(i);
      }
    }
    if (toDelete.length === 0) {
      return NextResponse.json({ deleted: 0 });
    }

    // Delete bottom-up so indices stay valid.
    const requests = toDelete
      .sort((a, b) => b - a)
      .map((i) => ({
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 },
        },
      }));

    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    return NextResponse.json({ deleted: toDelete.length });
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
