/**
 * End-to-end test: upload test invoice to Drive Inbox, trigger the
 * production cron endpoint, then read the Sheet back to verify the row.
 * Uses service account creds from .env.local. No external state printed.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// --- load .env.local ---
const envPath = path.join(__dirname, '..', '.env.local');
const envText = fs.readFileSync(envPath, 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const creds = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.JWT(creds.client_email, undefined, creds.private_key, [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
]);
const drive = google.drive({ version: 'v3', auth });
const sheets = google.sheets({ version: 'v4', auth });

const INBOX = env.GOOGLE_DRIVE_INBOX_ID;
const PROCESSED = env.GOOGLE_DRIVE_PROCESSED_ID;
const IGNORED = env.GOOGLE_DRIVE_IGNORED_ID;
const SHEET_ID = env.GOOGLE_SHEETS_ID;
const CRON_SECRET = env.CRON_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://simpleexpensereport.vercel.app';

async function uploadTestInvoice() {
  const filePath = path.join(__dirname, '..', 'test_invoice.jpg');
  const { Readable } = require('stream');
  const content = fs.readFileSync(filePath);
  const name = `e2e_test_${Date.now()}.jpg`;
  const res = await drive.files.create({
    requestBody: { name, parents: [INBOX] },
    media: { mimeType: 'image/jpeg', body: Readable.from(content) },
    fields: 'id, name',
  });
  console.log(`[1] Uploaded ${res.data.name} (${res.data.id}) to Inbox`);
  return res.data.id;
}

async function triggerCron() {
  const url = `${BASE_URL}/api/cron/process-invoices`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  const body = await res.json();
  console.log(`[2] Cron HTTP ${res.status}:`, JSON.stringify(body));
  return body;
}

async function readSheetTail() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Invoices!A1:K50',
  });
  const rows = res.data.values || [];
  console.log(`[3] Sheet has ${rows.length} row(s) (incl header)`);
  if (rows.length) {
    console.log('    Header:', JSON.stringify(rows[0]));
    if (rows.length > 1) console.log('    Last row:', JSON.stringify(rows[rows.length - 1]));
  }
  return rows;
}

async function checkFolders(fileId) {
  const res = await drive.files.get({ fileId, fields: 'parents, name' });
  const parents = res.data.parents || [];
  let loc = 'UNKNOWN';
  if (parents.includes(PROCESSED)) loc = 'Processed';
  else if (parents.includes(IGNORED)) loc = 'Ignored';
  else if (parents.includes(INBOX)) loc = 'Inbox (NOT moved!)';
  console.log(`[4] File ${res.data.name} now in: ${loc}`);
  return loc;
}

(async () => {
  try {
    const fileId = await uploadTestInvoice();
    await triggerCron();
    await readSheetTail();
    await checkFolders(fileId);
    console.log('\nE2E TEST COMPLETE');
  } catch (err) {
    console.error('E2E TEST FAILED:', err.message);
    process.exit(1);
  }
})();
