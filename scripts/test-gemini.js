/** Test Gemini classify + extract on the local test invoice. No Google auth needed. */
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const envText = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const img = fs.readFileSync(path.join(__dirname, '..', 'test_invoice.jpg'));
const inlineData = { data: img.toString('base64'), mimeType: 'image/jpeg' };

function extractJSON(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m[0]);
}

(async () => {
  const c = await model.generateContent([
    'You are a document classifier. Determine whether this file is an invoice, receipt, bill, or expense-related document. Return JSON only: {"is_invoice": boolean, "confidence": number}',
    { inlineData },
  ]);
  console.log('CLASSIFY:', JSON.stringify(extractJSON(c.response.text())));

  const e = await model.generateContent([
    'You are an invoice extraction engine. Extract structured invoice data. Return JSON only. Fields: {"vendor": string|null, "invoice_date": string|null, "total_amount": number|null, "currency": string|null, "tax_amount": number|null, "invoice_number": string|null, "confidence": number}. invoice_date format YYYY-MM-DD. currency 3-letter ISO.',
    { inlineData },
  ]);
  console.log('EXTRACT:', JSON.stringify(extractJSON(e.response.text())));
})();
