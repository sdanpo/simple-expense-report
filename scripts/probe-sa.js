/** Probe what the service account CAN do: list inbox, append sheet, move a file. */
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
  // 1. list inbox
  try {
    const r = await drive.files.list({
      q: `'${env.GOOGLE_DRIVE_INBOX_ID}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType)',
    });
    console.log('LIST inbox OK:', (r.data.files || []).length, 'files');
  } catch (e) { console.log('LIST inbox FAIL:', e.message); }

  // 2. append to sheet
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: env.GOOGLE_SHEETS_ID,
      range: 'Invoices!A:K',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['__PROBE__', '', '', '', '', '', '', '', '', '', '']] },
    });
    console.log('APPEND sheet OK');
  } catch (e) { console.log('APPEND sheet FAIL:', e.message); }
})();
