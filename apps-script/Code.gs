/**
 * Invoice Automation — SELF-CONTAINED Google Apps Script pipeline.
 *
 * Runs entirely inside Google as YOU. No Vercel, no server, no service account.
 *   Gmail  -> read labeled receipt emails (attachments + body-only receipts)
 *   Drive  -> Inbox folder holds incoming files (also fed by a phone photo-sync app)
 *   Gemini -> classify + extract each receipt (one API call per file)
 *   Sheet  -> append a row; file moved to Processed / Ignored
 *
 * SET UP (one time):
 *   1. Paste this file into script.google.com (replace everything), Save.
 *   2. Editor sidebar > Services (+) > Gmail > Add   (for the auto-label filters).
 *   3. Project Settings > show appsscript.json > paste apps-script/appsscript.json.
 *   4. Put your Gemini API key in CONFIG.GEMINI_API_KEY
 *      (free key at https://aistudio.google.com/apikey).
 *   5. Run `setup`, authorize. Done — it runs every hour on its own.
 *
 * One-time helpers you can run manually: backfillTrip, forceReingest,
 *   clearSheet, clearAllInvoiceFolders, resetInboxTrashAllFiles.
 */

const CONFIG = {
  // Drive folders
  INBOX_FOLDER_ID: '1eaCs2dx-ZxwZYGA6xaqNQrKXblO7xWQG',
  PROCESSED_FOLDER_ID: '1qRyuo0sPXpEQfZfeaQfVQfix20w0tGyr',
  IGNORED_FOLDER_ID: '1PctH71brnmHySD1VSolcy4kek3ca4svW',

  // Google Sheet
  SHEET_ID: '1dSWFwyXy9wdXMYpjPsrbRCPDVZj8_bI2d4qauCkIAA8',
  SHEET_NAME: 'Invoices',

  // Gemini. 2.0-flash / 2.5-flash free tiers are ~20 req/day — use flash-lite.
  GEMINI_API_KEY: 'PASTE_GEMINI_API_KEY_HERE',
  GEMINI_MODEL: 'gemini-2.5-flash-lite',

  // Gmail labels. Do NOT reuse the old "invoice-ingested" label — a rogue filter
  // for it once labeled ALL incoming mail. setup() deletes that filter.
  INGEST_LABEL: 'AutoInvoiced',
  DONE_LABEL: 'AutoInvoiced-done',
  LEGACY_DONE_LABEL: 'invoice-ingested',
  FILTER_QUERY: 'has:attachment (invoice OR receipt OR "tax invoice" OR חשבונית OR קבלה)',

  // Safety limits (Apps Script caps each run at 6 minutes)
  MAX_THREADS_PER_RUN: 10,
  MIN_ATTACHMENT_BYTES: 5 * 1024,
  MAX_FILES_PER_RUN: 12,
  MAX_FILE_BYTES: 15 * 1024 * 1024,   // Gemini inline-data request limit guard
  TIME_BUDGET_MS: 5 * 60 * 1000,      // stop well before the 6-min limit
};

const HEADERS = ['vendor', 'invoice_date', 'total_amount', 'currency', 'tax_amount',
  'invoice_number', 'confidence', 'status', 'file_name', 'drive_link', 'processed_at'];

// MIME types Gemini accepts inline, normalized. Also resolved from file extension
// (some senders attach PDFs as application/octet-stream).
const GEMINI_TYPES = {
  'application/pdf': 'application/pdf',
  'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png',
  'image/webp': 'image/webp', 'image/heic': 'image/heic', 'image/heif': 'image/heif',
};
const EXTENSION_TYPES = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
};

const ANALYZE_PROMPT = `You are a strict expense-RECEIPT analyzer. Accept ONLY proof-of-payment documents.

The deciding test: does the document show a CONCRETE AMOUNT that was actually CHARGED or PAID for a
purchase, together with a vendor/merchant name?

ACCEPT (is_invoice = true) if YES — a real expense. INCLUDES: store/restaurant receipts, ride/taxi
receipts (Gett, Uber, Bolt), parking & toll receipts, utility bills, subscription invoices, AND
travel-insurance premiums / eSIM / booking charges. Hebrew docs ("חשבונית מס/קבלה", "קבלה",
"אישור תשלום") count. Hebrew/RTL text is still valid.

REJECT (is_invoice = false) if there is NO amount actually charged — the document is informational:
- Insurance POLICY TERMS / coverage-details pages with NO premium/price (just conditions).
  (If an insurance document DOES show a premium/cost that was charged, ACCEPT it.)
- Pension / provident-fund statements or notices ("הודעה על הפסקת תשלום").
- Bank/account statements, schedules, contracts, forms, book/equipment lists, reservation
  confirmations with no price, shipping notices.
- Documents that say "this is not a payment receipt" / "charge summary".
- Marketing, newsletters, product images, screenshots, personal photos.
When unsure whether a real amount was charged, set is_invoice = false.

CURRENCY — read the actual symbol, do not assume (a Hebrew doc is NOT automatically ILS):
  ₪ / NIS / ש"ח -> "ILS";  $ / US$ -> "USD";  € -> "EUR";  £ -> "GBP".

If is_invoice is false, set every other field to null.

Return JSON only:
{"is_invoice": boolean, "confidence": number, "vendor": string|null, "invoice_date": string|null,
 "total_amount": number|null, "currency": string|null, "tax_amount": number|null,
 "invoice_number": string|null}
invoice_date format YYYY-MM-DD. Do not invent values; use null if unknown.`;

/** Run ONCE: labels, Gmail filters, hourly trigger. */
function setup() {
  ensureLabel_(CONFIG.INGEST_LABEL);
  ensureLabel_(CONFIG.DONE_LABEL);
  removeRogueFilters_();
  createGmailFilter_();

  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runHourly').timeBased().everyHours(1).create();

  if (CONFIG.GEMINI_API_KEY === 'PASTE_GEMINI_API_KEY_HERE') {
    Logger.log('WARNING: set CONFIG.GEMINI_API_KEY (https://aistudio.google.com/apikey) before processing.');
  }
  Logger.log('Setup complete. Hourly trigger installed. Running once now...');
  runHourly();
}

/** Main hourly job: ingest labeled emails, then process the Inbox — within the time budget. */
function runHourly() {
  const deadline = Date.now() + CONFIG.TIME_BUDGET_MS;
  const ingested = ingestLabeledThreads_(deadline);
  Logger.log('Ingested ' + ingested + ' item(s) from email.');
  const processed = processInbox_(deadline);
  Logger.log('Processed ' + processed + ' file(s) from the Inbox.');
}

// ---------- Gmail ingestion ----------

function ingestLabeledThreads_(deadline) {
  const ingestLabel = ensureLabel_(CONFIG.INGEST_LABEL);
  const doneLabel = ensureLabel_(CONFIG.DONE_LABEL);
  const inbox = DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID);

  const query = 'label:' + CONFIG.INGEST_LABEL + ' -label:' + CONFIG.DONE_LABEL;
  const threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS_PER_RUN);
  let count = 0;

  for (let t = 0; t < threads.length; t++) {
    if (Date.now() > deadline) { Logger.log('Budget reached during ingestion.'); break; }
    const thread = threads[t];
    const messages = thread.getMessages();
    for (let m = 0; m < messages.length; m++) {
      const msg = messages[m];
      let ingestedAttachment = false;
      const atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
      for (let a = 0; a < atts.length; a++) {
        const att = atts[a];
        const mime = resolveMimeType_(att.getContentType(), att.getName());
        if (!mime) continue;
        if (att.getSize() < CONFIG.MIN_ATTACHMENT_BYTES) continue;
        const name = fileNameFor_(msg, att.getName());
        if (alreadyIngested_(name)) { ingestedAttachment = true; continue; }
        inbox.createFile(att.copyBlob().setName(name).setContentType(mime));
        count++;
        ingestedAttachment = true;
      }
      // No usable attachment → the receipt (if any) is in the body text.
      if (!ingestedAttachment) count += analyzeBodyAndRecord_(msg);
    }
    thread.addLabel(doneLabel);
  }
  return count;
}

// Analyze a message's body text for a receipt (Uber, Metropark, etc.) and record it.
function analyzeBodyAndRecord_(msg) {
  if (CONFIG.GEMINI_API_KEY === 'PASTE_GEMINI_API_KEY_HERE') return 0;
  const body = (msg.getPlainBody() || '').slice(0, 18000);
  if (body.replace(/\s/g, '').length < 40) return 0;
  const subject = msg.getSubject() || 'no-subject';
  let analysis;
  try {
    analysis = callGemini_([{ text: ANALYZE_PROMPT + '\n\nDOCUMENT TEXT:\nEmail subject: ' + subject + '\n\n' + body }]);
  } catch (e) { Logger.log('Body analyze failed "' + subject + '": ' + e); return 0; }
  if (!analysis.is_invoice || (analysis.confidence || 0) < 0.5) {
    Logger.log('Body not a receipt: ' + subject);
    return 0;
  }
  const dateStr = Utilities.formatDate(msg.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  appendRow_(buildRow_(analysis, dateStr + '_' + safe_(subject) + '.eml',
    'https://mail.google.com/mail/u/0/#all/' + msg.getId()));
  Logger.log('Body receipt: ' + subject + ' -> ' + analysis.vendor + ' ' + analysis.total_amount + ' ' + analysis.currency);
  return 1;
}

// ---------- Inbox processing (was the Vercel endpoint) ----------

function processInbox_(deadline) {
  if (CONFIG.GEMINI_API_KEY === 'PASTE_GEMINI_API_KEY_HERE') {
    Logger.log('Skipping processing: CONFIG.GEMINI_API_KEY not set.');
    return 0;
  }
  // Snapshot IDs first (we move files out of the folder while iterating).
  const it = DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID).getFiles();
  const ids = [];
  while (it.hasNext()) ids.push(it.next().getId());

  let done = 0;
  for (let i = 0; i < ids.length; i++) {
    if (done >= CONFIG.MAX_FILES_PER_RUN || Date.now() > deadline) break;
    const file = DriveApp.getFileById(ids[i]);
    done++;
    try { processOneFile_(file); }
    catch (e) { Logger.log('Error processing ' + file.getName() + ': ' + e); }
  }
  return done;
}

function processOneFile_(file) {
  const name = file.getName();
  const mime = resolveMimeType_(file.getMimeType(), name);
  if (!mime) { moveFile_(file, CONFIG.IGNORED_FOLDER_ID); Logger.log('ignored (unsupported): ' + name); return; }
  if (file.getSize() > CONFIG.MAX_FILE_BYTES) {
    moveFile_(file, CONFIG.IGNORED_FOLDER_ID);
    Logger.log('ignored (too large for Gemini): ' + name);
    return;
  }
  const b64 = Utilities.base64Encode(file.getBlob().getBytes());
  const analysis = callGemini_([{ text: ANALYZE_PROMPT }, { inline_data: { mime_type: mime, data: b64 } }]);
  if (!analysis.is_invoice || (analysis.confidence || 0) < 0.5) {
    moveFile_(file, CONFIG.IGNORED_FOLDER_ID);
    Logger.log('ignored (not a receipt): ' + name);
    return;
  }
  appendRow_(buildRow_(analysis, name, file.getUrl()));
  moveFile_(file, CONFIG.PROCESSED_FOLDER_ID);
  Logger.log('approved: ' + name + ' -> ' + analysis.vendor + ' ' + analysis.total_amount + ' ' + analysis.currency);
}

// ---------- Gemini ----------

function callGemini_(parts) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    CONFIG.GEMINI_MODEL + ':generateContent?key=' + CONFIG.GEMINI_API_KEY;
  const payload = JSON.stringify({ contents: [{ parts: parts }] });
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', payload: payload, muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code === 200) {
      const data = JSON.parse(text);
      const out = data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts[0].text;
      return extractJson_(out);
    }
    lastErr = code + ': ' + text.slice(0, 200);
    if (code === 429 || code >= 500) { Utilities.sleep(2000 * (attempt + 1)); continue; }
    break;
  }
  throw new Error('Gemini ' + lastErr);
}

function extractJson_(text) {
  if (!text) throw new Error('empty Gemini response');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in Gemini response');
  return JSON.parse(m[0]);
}

// ---------- Sheet ----------

function ensureSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONFIG.SHEET_NAME);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  return sh;
}

function buildRow_(a, fileName, link) {
  const auto = a.vendor && a.invoice_date && a.total_amount != null && (a.confidence || 0) >= 0.8;
  return {
    vendor: a.vendor || '', invoice_date: a.invoice_date || '',
    total_amount: (a.total_amount == null ? '' : a.total_amount),
    currency: a.currency || '', tax_amount: (a.tax_amount == null ? '' : a.tax_amount),
    invoice_number: a.invoice_number || '', confidence: (a.confidence == null ? '' : a.confidence),
    status: auto ? 'Approved' : 'Needs Review', file_name: fileName, drive_link: link || '',
  };
}

function appendRow_(r) {
  ensureSheet_().appendRow([r.vendor, r.invoice_date, r.total_amount, r.currency, r.tax_amount,
    r.invoice_number, r.confidence, r.status, r.file_name, r.drive_link, new Date().toISOString()]);
}

// ---------- Drive helpers ----------

function moveFile_(file, destId) {
  const dest = DriveApp.getFolderById(destId);
  dest.addFile(file);
  const parents = file.getParents();
  while (parents.hasNext()) {
    const p = parents.next();
    if (p.getId() !== destId) p.removeFile(file);
  }
}

function resolveMimeType_(declared, name) {
  const d = (declared || '').toLowerCase();
  if (GEMINI_TYPES[d]) return GEMINI_TYPES[d];
  const lower = (name || '').toLowerCase();
  const ext = lower.indexOf('.') === -1 ? '' : lower.split('.').pop();
  return EXTENSION_TYPES[ext] || null;
}

function fileNameFor_(msg, attName) {
  const dateStr = Utilities.formatDate(msg.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return dateStr + '_' + safe_(msg.getSubject()) + '_' + attName;
}

function safe_(s) { return (s || 'no-subject').replace(/[^\w֐-׿ .-]/g, '_').slice(0, 60); }

function alreadyIngested_(name) {
  const inbox = DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID);
  if (inbox.getFilesByName(name).hasNext()) return true;
  const ids = [CONFIG.PROCESSED_FOLDER_ID, CONFIG.IGNORED_FOLDER_ID];
  for (let i = 0; i < ids.length; i++) {
    if (DriveApp.getFolderById(ids[i]).getFilesByName(name).hasNext()) return true;
  }
  return false;
}

function ensureLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// ---------- One-time helpers ----------

/** Clear all data rows from the Sheet (keep header). */
function clearSheet() {
  const sh = ensureSheet_();
  const last = sh.getLastRow();
  if (last > 1) sh.deleteRows(2, last - 1);
  Logger.log('Cleared ' + Math.max(0, last - 1) + ' data row(s).');
}

/** Trash every file in Inbox + Processed + Ignored. Recoverable for ~30 days. */
function clearAllInvoiceFolders() {
  let n = trashAllIn_(DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID));
  n += trashAllIn_(DriveApp.getFolderById(CONFIG.PROCESSED_FOLDER_ID));
  n += trashAllIn_(DriveApp.getFolderById(CONFIG.IGNORED_FOLDER_ID));
  Logger.log('Trashed ' + n + ' file(s) across all folders.');
}

/** Trash everything in the Inbox only. */
function resetInboxTrashAllFiles() {
  Logger.log('Trashed ' + trashAllIn_(DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID)) + ' Inbox file(s).');
}

function trashAllIn_(folder) {
  const files = folder.getFiles();
  let count = 0;
  while (files.hasNext()) { files.next().setTrashed(true); count++; }
  return count;
}

/** Label + ingest receipt-like emails from the last 30 days (incl. self-sent attachments). */
function backfillRecentReceipts() {
  const ingest = ensureLabel_(CONFIG.INGEST_LABEL);
  const kw = CONFIG.FILTER_QUERY.replace(')', ' OR פוליסת OR ביטוח)');
  const me = Session.getActiveUser().getEmail();
  let labeled = 0;
  [kw, 'from:' + me + ' to:' + me + ' has:attachment'].forEach(function (q) {
    const threads = GmailApp.search('newer_than:30d -label:' + CONFIG.DONE_LABEL + ' ' + q, 0, 100);
    threads.forEach(function (t) { t.addLabel(ingest); });
    labeled += threads.length;
  });
  Logger.log('Labeled ' + labeled + ' thread(s). Running now...');
  runHourly();
}

/** Un-mark recently ingested threads so missing attachments/body receipts re-process. */
function forceReingest() {
  const done = ensureLabel_(CONFIG.DONE_LABEL);
  const threads = GmailApp.search('label:' + CONFIG.INGEST_LABEL + ' newer_than:7d', 0, 50);
  threads.forEach(function (t) { t.removeLabel(done); });
  Logger.log('Cleared done-mark from ' + threads.length + ' thread(s). Running now...');
  runHourly();
}

// ---------- Gmail filter management (needs the Gmail Advanced Service) ----------

function removeRogueFilters_() {
  try {
    const labels = Gmail.Users.Labels.list('me').labels || [];
    const legacy = labels.filter(function (l) { return l.name === CONFIG.LEGACY_DONE_LABEL; })[0];
    if (!legacy) return;
    const filters = (Gmail.Users.Settings.Filters.list('me').filter) || [];
    filters.forEach(function (f) {
      const adds = (f.action && f.action.addLabelIds) || [];
      if (adds.indexOf(legacy.id) !== -1) {
        Gmail.Users.Settings.Filters.remove('me', f.id);
        Logger.log('Removed rogue filter applying "' + CONFIG.LEGACY_DONE_LABEL + '".');
      }
    });
  } catch (e) {
    Logger.log('Could not check rogue filters (' + e + '). Enable the Gmail Advanced Service and re-run setup.');
  }
}

function createGmailFilter_() {
  const me = Session.getActiveUser().getEmail();
  const wanted = [CONFIG.FILTER_QUERY, 'from:' + me + ' to:' + me + ' has:attachment'];
  try {
    const labels = Gmail.Users.Labels.list('me').labels || [];
    const label = labels.filter(function (l) { return l.name === CONFIG.INGEST_LABEL; })[0];
    if (!label) throw new Error('Label not found: ' + CONFIG.INGEST_LABEL);
    const filters = (Gmail.Users.Settings.Filters.list('me').filter) || [];
    wanted.forEach(function (q) {
      if (filters.some(function (f) { return f.criteria && f.criteria.query === q; })) return;
      Gmail.Users.Settings.Filters.create({ criteria: { query: q }, action: { addLabelIds: [label.id] } }, 'me');
      Logger.log('Gmail filter created: ' + q + ' -> ' + CONFIG.INGEST_LABEL);
    });
  } catch (e) {
    Logger.log('Could not create filters automatically (' + e + '). Enable the Gmail Advanced Service ' +
      '(Services + > Gmail) and re-run setup, or create them by hand in Gmail Settings > Filters.');
  }
}
