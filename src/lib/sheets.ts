import { getSheetsClient } from './auth';
import type { SheetRow } from './types';

const SHEET_NAME = 'Invoices';
const HEADERS = [
  'vendor',
  'invoice_date',
  'total_amount',
  'currency',
  'tax_amount',
  'invoice_number',
  'confidence',
  'status',
  'file_name',
  'drive_link',
  'processed_at',
];

export async function ensureSheetHeaders(): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID!;

  // Check if sheet exists, create if not
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets?.find(
    (s) => s.properties?.title === SHEET_NAME
  );

  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
      },
    });
  }

  // Check if headers already set
  const range = `${SHEET_NAME}!A1:K1`;
  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  if (current.data.values?.length) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });
}

export async function appendRow(row: SheetRow): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID!;

  const values = [
    row.vendor,
    row.invoice_date,
    row.total_amount,
    row.currency,
    row.tax_amount,
    row.invoice_number,
    row.confidence,
    row.status,
    row.file_name,
    row.drive_link,
    row.processed_at,
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_NAME}!A:K`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}
