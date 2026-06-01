/** Delete e2e_* test files and clear sheet data rows (keep header). */
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
  // clear data rows, keep header
  await sheets.spreadsheets.values.clear({ spreadsheetId: env.GOOGLE_SHEETS_ID, range: 'Invoices!A2:K1000' });
  console.log('cleared sheet data rows (header kept)');

  for (const id of [env.GOOGLE_DRIVE_INBOX_ID, env.GOOGLE_DRIVE_PROCESSED_ID, env.GOOGLE_DRIVE_IGNORED_ID]) {
    const r = await drive.files.list({ q: `'${id}' in parents and trashed = false`, fields: 'files(id,name)' });
    for (const f of r.data.files || []) {
      if (f.name.startsWith('e2e_')) {
        try {
          await drive.files.update({ fileId: f.id, requestBody: { trashed: true } });
          console.log('trashed', f.name);
        } catch (e) {
          console.log('could not trash (delete manually):', f.name, '-', e.message);
        }
      }
    }
  }

  // final state
  for (const [name, id] of [['Inbox', env.GOOGLE_DRIVE_INBOX_ID], ['Processed', env.GOOGLE_DRIVE_PROCESSED_ID], ['Ignored', env.GOOGLE_DRIVE_IGNORED_ID]]) {
    const r = await drive.files.list({ q: `'${id}' in parents and trashed = false`, fields: 'files(name)' });
    console.log(`${name}: ${(r.data.files || []).map((f) => f.name).join(', ') || '(empty)'}`);
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
