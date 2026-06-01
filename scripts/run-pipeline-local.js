/** Run the full process-invoices pipeline locally with the service account. */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
const model = new GoogleGenerativeAI(env.GEMINI_API_KEY).getGenerativeModel({ model: 'gemini-2.5-flash' });

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);
const extractJSON = (t) => JSON.parse(t.match(/\{[\s\S]*\}/)[0]);

async function classify(buf, mime) {
  const r = await model.generateContent(['You are a document classifier. Determine whether this file is an invoice, receipt, bill, or expense-related document. Return JSON only: {"is_invoice": boolean, "confidence": number}', { inlineData: { data: buf.toString('base64'), mimeType: mime } }]);
  return extractJSON(r.response.text());
}
async function extract(buf, mime) {
  const r = await model.generateContent(['You are an invoice extraction engine. Extract structured invoice data. Return JSON only. Fields: {"vendor": string|null, "invoice_date": string|null, "total_amount": number|null, "currency": string|null, "tax_amount": number|null, "invoice_number": string|null, "confidence": number}. invoice_date format YYYY-MM-DD. currency 3-letter ISO.', { inlineData: { data: buf.toString('base64'), mimeType: mime } }]);
  return extractJSON(r.response.text());
}

async function moveFile(fileId, dest) {
  const f = await drive.files.get({ fileId, fields: 'parents' });
  await drive.files.update({ fileId, addParents: dest, removeParents: (f.data.parents || []).join(','), fields: 'id,parents' });
}

(async () => {
  const list = await drive.files.list({
    q: `'${env.GOOGLE_DRIVE_INBOX_ID}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,webViewLink)',
  });
  const files = list.data.files || [];
  console.log(`Inbox: ${files.length} file(s)`);

  for (const file of files) {
    console.log(`\n--- ${file.name} (${file.mimeType}) ---`);
    if (!SUPPORTED.has(file.mimeType)) {
      await moveFile(file.id, env.GOOGLE_DRIVE_IGNORED_ID);
      console.log('  unsupported -> Ignored');
      continue;
    }
    const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
    const buf = Buffer.from(res.data);
    console.log(`  downloaded ${buf.length} bytes`);

    const c = await classify(buf, file.mimeType);
    console.log('  classify:', JSON.stringify(c));
    if (!c.is_invoice || c.confidence < 0.5) {
      await moveFile(file.id, env.GOOGLE_DRIVE_IGNORED_ID);
      console.log('  not invoice -> Ignored');
      continue;
    }

    const inv = await extract(buf, file.mimeType);
    console.log('  extract:', JSON.stringify(inv));
    const approve = inv.vendor && inv.invoice_date && inv.total_amount != null && inv.confidence >= 0.8;
    const status = approve ? 'Approved' : 'Needs Review';

    await sheets.spreadsheets.values.append({
      spreadsheetId: env.GOOGLE_SHEETS_ID,
      range: 'Invoices!A:K',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[
        inv.vendor || '', inv.invoice_date || '', inv.total_amount ?? '', inv.currency || '',
        inv.tax_amount ?? '', inv.invoice_number || '', (inv.confidence ?? 0).toFixed(2),
        status, file.name, file.webViewLink, new Date().toISOString(),
      ]] },
    });
    console.log(`  sheet appended (${status})`);
    await moveFile(file.id, env.GOOGLE_DRIVE_PROCESSED_ID);
    console.log('  -> Processed');
  }
  console.log('\nPIPELINE DONE');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
