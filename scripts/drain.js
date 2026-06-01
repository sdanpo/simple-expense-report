/** Drain the Inbox by repeatedly calling the processor until remaining==0. */
const fs = require('fs');
const path = require('path');
const envText = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const URL = 'https://simpleexpensereport.vercel.app/api/cron/process-invoices';

(async () => {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(URL, { headers: { Authorization: 'Bearer ' + env.CRON_SECRET } });
    const body = await res.json();
    console.log(`ping ${i + 1}: HTTP ${res.status} processed=${body.processed} remaining=${body.remaining}`);
    if (res.status !== 200) break;
    if (body.remaining === 0 || body.processed === 0) break;
  }
  console.log('drain done');
})();
