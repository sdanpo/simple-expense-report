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

// ---- One unified activity log, as a "Log" tab in the same spreadsheet ----
// Both Vercel and Apps Script write here so there is a SINGLE place to see what
// happened and why, without opening any dev console.
const LOG_SHEET = 'Log';
const LOG_HEADERS = ['timestamp', 'source', 'event', 'detail'];
const LOG_MAX_ROWS = 1000; // keep the newest ~1000 entries

export interface LogEntry {
  source: 'vercel' | 'apps-script';
  event: string; // e.g. 'approved' | 'ignored' | 'error' | 'ingest' | 'run'
  detail: string;
}

async function ensureLogSheet(): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID!;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === LOG_SHEET);
  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: LOG_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${LOG_SHEET}!A1:D1`,
      valueInputOption: 'RAW',
      requestBody: { values: [LOG_HEADERS] },
    });
  }
}

/** Append one or more entries to the Log tab. Never throws — logging must not break processing. */
export async function appendLog(entries: LogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    await ensureLogSheet();
    const sheets = getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID!;
    const ts = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${LOG_SHEET}!A:D`,
      valueInputOption: 'RAW',
      requestBody: { values: entries.map((e) => [ts, e.source, e.event, e.detail]) },
    });
    await trimLog(sheets, spreadsheetId);
  } catch (err) {
    console.error('appendLog failed:', err instanceof Error ? err.message : err);
  }
}

// Keep the Log tab from growing unbounded — delete oldest rows past LOG_MAX_ROWS.
async function trimLog(
  sheets: ReturnType<typeof getSheetsClient>,
  spreadsheetId: string
): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets?.find((s) => s.properties?.title === LOG_SHEET);
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId == null) return;
  const data = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${LOG_SHEET}!A:A` });
  const rows = (data.data.values ?? []).length; // includes header
  if (rows <= LOG_MAX_ROWS + 1) return;
  const removeCount = rows - (LOG_MAX_ROWS + 1);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 1 + removeCount },
          },
        },
      ],
    },
  });
}

// A stable key identifying a receipt, for de-duplication. Prefer the invoice number;
// otherwise fall back to date+amount+currency (vendor is omitted because Gemini reads
// the same receipt's vendor inconsistently across photos).
export function dedupKey(x: {
  invoice_number?: string | null; invoice_date?: string | null;
  total_amount?: string | number | null; currency?: string | null;
}): string {
  const inv = String(x.invoice_number ?? '').trim();
  if (inv) return 'inv:' + inv.toLowerCase();
  return 'vda:' + String(x.invoice_date ?? '') + '|' + String(x.total_amount ?? '') +
    '|' + String(x.currency ?? '').toLowerCase();
}

// Keys for every receipt already in the Invoices sheet (for dedup).
export async function getExistingDedupKeys(): Promise<Set<string>> {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID!;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A2:F`, // vendor..invoice_number (no header)
  });
  const keys = new Set<string>();
  for (const r of res.data.values ?? []) {
    keys.add(dedupKey({ invoice_date: r[1], total_amount: r[2], currency: r[3], invoice_number: r[5] }));
  }
  return keys;
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
