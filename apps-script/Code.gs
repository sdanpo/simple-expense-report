/**
 * Invoice Automation — Gmail → Drive Inbox ingester + hourly processor trigger.
 *
 * Runs AS YOU inside Google (no OAuth client, no consent screen, no verification).
 * Set up: paste into script.google.com, set CONFIG below, run `setup` once to
 * authorize + install the hourly trigger. Done.
 *
 * What it does every hour:
 *   1. Finds Gmail messages with attachments (PDF/image) not yet processed
 *   2. Saves each attachment into the Drive Inbox folder
 *   3. Labels the message so it is never re-ingested
 *   4. Pings the Vercel endpoint so invoices flow into the Sheet within the hour
 */

const CONFIG = {
  INBOX_FOLDER_ID: '1eaCs2dx-ZxwZYGA6xaqNQrKXblO7xWQG',
  PROCESS_URL: 'https://simpleexpensereport.vercel.app/api/cron/process-invoices',
  CRON_SECRET: 'PASTE_CRON_SECRET_HERE', // value is in .env.local (gitignored) / Vercel env
  PROCESSED_LABEL: 'invoice-ingested',
  // Only invoice-like emails (avoids ingesting random attachments). Tune as you like.
  SEARCH_QUERY: 'has:attachment newer_than:30d -label:invoice-ingested ' +
    '(invoice OR receipt OR bill OR "tax invoice" OR payment OR חשבונית OR קבלה OR "אישור תשלום")',
  MAX_THREADS: 25,
};

const ALLOWED_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'image/webp',
];

/** Run ONCE manually: authorizes scopes and installs the hourly trigger. */
function setup() {
  ensureLabel_();
  // remove existing triggers for this function to avoid duplicates
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runHourly'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runHourly').timeBased().everyHours(1).create();
  Logger.log('Setup complete. Hourly trigger installed. Running once now...');
  runHourly();
}

/** Main hourly job. */
function runHourly() {
  const ingested = ingestGmailAttachments_();
  Logger.log('Ingested ' + ingested + ' attachment(s).');
  triggerProcessing_();
}

function ingestGmailAttachments_() {
  const label = ensureLabel_();
  const inbox = DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID);
  const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, CONFIG.MAX_THREADS);
  let count = 0;

  for (let t = 0; t < threads.length; t++) {
    const thread = threads[t];
    const messages = thread.getMessages();
    for (let m = 0; m < messages.length; m++) {
      const msg = messages[m];
      const atts = msg.getAttachments();
      for (let a = 0; a < atts.length; a++) {
        const att = atts[a];
        const type = (att.getContentType() || '').toLowerCase();
        if (ALLOWED_TYPES.indexOf(type) === -1) continue;
        const dateStr = Utilities.formatDate(msg.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
        const safeSubject = (msg.getSubject() || 'no-subject').replace(/[^\w֐-׿ .-]/g, '_').slice(0, 60);
        const name = dateStr + '_' + safeSubject + '_' + att.getName();
        inbox.createFile(att.copyBlob().setName(name));
        count++;
      }
    }
    thread.addLabel(label); // mark whole thread ingested
  }
  return count;
}

// Ping the processor repeatedly until the Inbox is drained (the endpoint
// processes a bounded batch per call and reports `remaining`). Bounded by
// MAX_PINGS to stay within the Apps Script 6-minute execution budget.
function triggerProcessing_() {
  const MAX_PINGS = 30;
  for (let i = 0; i < MAX_PINGS; i++) {
    try {
      const res = UrlFetchApp.fetch(CONFIG.PROCESS_URL, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + CONFIG.CRON_SECRET },
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      const body = res.getContentText();
      Logger.log('Process ping ' + (i + 1) + ': ' + code + ' ' + body);
      if (code !== 200) break;
      let parsed;
      try { parsed = JSON.parse(body); } catch (e) { break; }
      if (!parsed || parsed.remaining === 0 || parsed.processed === 0) break;
    } catch (e) {
      Logger.log('Process trigger failed: ' + e);
      break;
    }
  }
}

function ensureLabel_() {
  return GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL) ||
    GmailApp.createLabel(CONFIG.PROCESSED_LABEL);
}
