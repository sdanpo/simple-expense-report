/** Read sheet, verify file locations, remove __PROBE__ row. */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const envText = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
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

(async () => {
  const SHEET = 'Invoices';
  const get = await sheets.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SHEETS_ID, range: `${SHEET}!A1:K100` });
  let rows = get.data.values || [];
  console.log(`Sheet rows (incl header): ${rows.length}`);

  // find probe rows to delete (by vendor col == __PROBE__)
  const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: env.GOOGLE_SHEETS_ID });
  const sheetId = sheetMeta.data.sheets.find((s) => s.properties.title === SHEET).properties.sheetId;
  const deleteReqs = [];
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i][0] === '__PROBE__') {
      deleteReqs.push({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } });
    }
  }
  if (deleteReqs.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: env.GOOGLE_SHEETS_ID, requestBody: { requests: deleteReqs } });
    console.log(`Removed ${deleteReqs.length} __PROBE__ row(s)`);
  }

  const after = await sheets.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SHEETS_ID, range: `${SHEET}!A1:K100` });
  rows = after.data.values || [];
  console.log('\nFinal sheet contents:');
  rows.forEach((r, i) => console.log(`  [${i}] ${JSON.stringify(r)}`));

  // verify folders
  for (const [name, id] of [['Inbox', env.GOOGLE_DRIVE_INBOX_ID], ['Processed', env.GOOGLE_DRIVE_PROCESSED_ID], ['Ignored', env.GOOGLE_DRIVE_IGNORED_ID]]) {
    const r = await drive.files.list({ q: `'${id}' in parents and trashed = false`, fields: 'files(name)' });
    console.log(`\n${name}: ${(r.data.files || []).map((f) => f.name).join(', ') || '(empty)'}`);
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
