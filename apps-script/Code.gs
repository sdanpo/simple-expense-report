/**
 * Invoice Automation — Gmail → Drive Inbox ingester + processor trigger.
 *
 * Runs AS YOU inside Google (no OAuth client, no consent screen, no verification).
 *
 * HOW INGESTION WORKS (label-based, no keyword guessing):
 *   1. A Gmail FILTER (created by `setup`, or manually) applies the label
 *      "AutoInvoiced" to incoming mail that looks like an invoice/receipt.
 *      You can also apply the label by hand to any email you want ingested.
 *   2. Every run, this script takes threads labeled AutoInvoiced that were not
 *      ingested yet, saves their real attachments (PDF/images — no inline
 *      signature logos / tracking pixels) into the Drive Inbox folder, and
 *      marks the thread with "AutoInvoiced-done" so it is never re-ingested.
 *   3. It then pings the Vercel processor until the Inbox is drained, within a
 *      strict time budget so the script can NEVER exceed Apps Script's 6-minute
 *      execution limit.
 *
 * SET UP (one time):
 *   1. Paste this file into script.google.com (replace everything).
 *   2. Enable the Gmail Advanced Service: Editor sidebar > Services (+) > Gmail > Add.
 *   3. Set CONFIG.CRON_SECRET below (value is in Vercel → Settings → Env Vars).
 *   4. Select function `setup` in the toolbar and click Run, authorize.
 *   5. Optionally run `backfillRecentReceipts` once to ingest the last few days.
 *   6. Done. It runs once per hour (Google schedules it at a fixed minute within the hour).
 */

const CONFIG = {
  INBOX_FOLDER_ID: '1eaCs2dx-ZxwZYGA6xaqNQrKXblO7xWQG',
  PROCESS_URL: 'https://simpleexpensereport.vercel.app/api/cron/process-invoices',
  CRON_SECRET: 'PASTE_CRON_SECRET_HERE', // value is in .env.local (gitignored) / Vercel env

  // Gmail labels.
  // NOTE: do NOT reuse the old "invoice-ingested" label — a rogue Gmail filter was
  // found applying it to ALL incoming mail, which silently excluded every new
  // receipt from ingestion. setup() deletes that filter.
  INGEST_LABEL: 'AutoInvoiced',          // applied by the Gmail filter (or by hand)
  DONE_LABEL: 'AutoInvoiced-done',       // applied by this script after ingestion
  LEGACY_DONE_LABEL: 'invoice-ingested', // old label; rogue filters for it get removed

  // The Gmail filter created by setup(). Keywords match anywhere (subject, body,
  // attachment names) — that is how receipts like Gett's ("receipt" only appears in
  // the attachment) are caught. Junk stays out because ingestion now skips inline
  // images / tiny files, and Gemini routes non-invoices to Ignored.
  FILTER_QUERY: 'has:attachment (invoice OR receipt OR "tax invoice" OR חשבונית OR קבלה)',

  // Safety limits
  MAX_THREADS_PER_RUN: 10,
  MIN_ATTACHMENT_BYTES: 5 * 1024,        // skip signature logos / tracking pixels
  TIME_BUDGET_MS: 4 * 60 * 1000,         // hard stop well before the 6-min Apps Script limit
};

// Real document types we ingest. Some senders attach PDFs as
// "application/octet-stream", so we also accept by file extension.
const ALLOWED_TYPES = {
  'application/pdf': 'application/pdf',
  'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png',
  'image/heic': 'image/heic', 'image/heif': 'image/heif', 'image/webp': 'image/webp',
};
const EXTENSION_TYPES = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  heic: 'image/heic', heif: 'image/heif', webp: 'image/webp',
};

/** Run ONCE manually: authorizes scopes, creates labels + Gmail filter, installs the hourly trigger. */
function setup() {
  ensureLabel_(CONFIG.INGEST_LABEL);
  ensureLabel_(CONFIG.DONE_LABEL);
  removeRogueFilters_();
  createGmailFilter_();

  // Remove ALL existing triggers for this project to avoid duplicates / runaway schedules,
  // then install a single hourly trigger.
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runHourly').timeBased().everyHours(1).create();

  if (CONFIG.CRON_SECRET === 'PASTE_CRON_SECRET_HERE') {
    Logger.log('WARNING: CONFIG.CRON_SECRET is not set. Ingestion will work, but the ' +
      'processor cannot be triggered (401). Paste the real CRON_SECRET and save.');
  }
  Logger.log('Setup complete. Hourly trigger installed. Running once now...');
  runHourly();
}

/** Main job: ingest labeled emails, then drain the processor — all within the time budget. */
function runHourly() {
  const deadline = Date.now() + CONFIG.TIME_BUDGET_MS;
  const ingested = ingestLabeledThreads_(deadline);
  Logger.log('Ingested ' + ingested + ' attachment(s).');
  triggerProcessing_(deadline);
}

/**
 * One-time helper: label recent receipt-like emails (last 30 days) with AutoInvoiced
 * so they get ingested. Gmail filters only apply to NEW mail, so run this once after
 * setup to backfill, then it runs ingestion immediately.
 * Covers: keyword-matching emails AND emails you sent to yourself with attachments
 * (the "photograph a receipt and email it to myself" habit).
 */
function backfillRecentReceipts() {
  const ingestLabel = ensureLabel_(CONFIG.INGEST_LABEL);
  // Slightly broader than the ongoing filter (adds policy/insurance terms) — the
  // Gemini classifier routes any non-expense documents to Ignored anyway.
  const keywordQuery = CONFIG.FILTER_QUERY.replace(')', ' OR פוליסת OR ביטוח)');
  const me = Session.getActiveUser().getEmail();
  const selfQuery = 'from:' + me + ' to:' + me + ' has:attachment';
  let labeled = 0;
  [keywordQuery, selfQuery].forEach(function (q) {
    const threads = GmailApp.search('newer_than:30d -label:' + CONFIG.DONE_LABEL + ' ' + q, 0, 100);
    threads.forEach(function (t) { t.addLabel(ingestLabel); });
    labeled += threads.length;
  });
  Logger.log('Labeled ' + labeled + ' thread(s) with ' + CONFIG.INGEST_LABEL +
    '. Running ingestion now...');
  runHourly();
}

/**
 * One-time helper: move EVERYTHING currently in the Drive Inbox AND Ignored folders
 * to the trash. Use this to clear the junk files the old (pre-fix) script ingested,
 * including real receipts that were misclassified into Ignored.
 * Safe: every file was extracted from a Gmail message that still exists, and real
 * receipts get re-ingested cleanly by backfillRecentReceipts(). Trash is recoverable
 * for 30 days. The Processed folder (files already in the Sheet) is NOT touched.
 */
function resetInboxTrashAllFiles() {
  const inbox = DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID);
  let count = trashAllIn_(inbox);
  // Also clear sibling "Ignored" folder — junk plus possible false negatives.
  const parents = inbox.getParents();
  if (parents.hasNext()) {
    const siblings = parents.next().getFolders();
    while (siblings.hasNext()) {
      const folder = siblings.next();
      if (folder.getName() === 'Ignored') count += trashAllIn_(folder);
    }
  }
  Logger.log('Moved ' + count + ' file(s) to the trash.');
}

/**
 * One-time helper: un-mark recently ingested threads so any attachments missing from
 * Drive get re-ingested. Safe — the filename dedup skips files that already exist in
 * Inbox/Processed/Ignored, so nothing gets duplicated.
 */
function forceReingest() {
  const done = ensureLabel_(CONFIG.DONE_LABEL);
  const threads = GmailApp.search('label:' + CONFIG.INGEST_LABEL + ' newer_than:7d', 0, 50);
  threads.forEach(function (t) { t.removeLabel(done); });
  Logger.log('Cleared done-mark from ' + threads.length + ' thread(s). Re-ingesting...');
  runHourly();
}

function trashAllIn_(folder) {
  const files = folder.getFiles();
  let count = 0;
  while (files.hasNext()) {
    files.next().setTrashed(true);
    count++;
  }
  return count;
}

function ingestLabeledThreads_(deadline) {
  const ingestLabel = ensureLabel_(CONFIG.INGEST_LABEL);
  const doneLabel = ensureLabel_(CONFIG.DONE_LABEL);
  const inbox = DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID);

  const query = 'label:' + CONFIG.INGEST_LABEL + ' -label:' + CONFIG.DONE_LABEL + ' has:attachment';
  const threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS_PER_RUN);
  let count = 0;

  for (let t = 0; t < threads.length; t++) {
    if (Date.now() > deadline) {
      Logger.log('Time budget reached during ingestion; remaining threads will be picked up next run.');
      break;
    }
    const thread = threads[t];
    const messages = thread.getMessages();
    for (let m = 0; m < messages.length; m++) {
      const msg = messages[m];
      // Real attachments only — inline images (signatures, logos, tracking pixels) are excluded.
      const atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
      for (let a = 0; a < atts.length; a++) {
        const att = atts[a];
        const mime = resolveMimeType_(att);
        if (!mime) continue;
        if (att.getSize() < CONFIG.MIN_ATTACHMENT_BYTES) continue;
        const dateStr = Utilities.formatDate(msg.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
        const safeSubject = (msg.getSubject() || 'no-subject').replace(/[^\w֐-׿ .-]/g, '_').slice(0, 60);
        const name = dateStr + '_' + safeSubject + '_' + att.getName();
        // Idempotency: never save the same file twice (e.g. re-labeled threads,
        // threads previously ingested by the old script).
        if (alreadyIngested_(name)) continue;
        // Force the correct content type so the processor recognizes octet-stream PDFs.
        inbox.createFile(att.copyBlob().setName(name).setContentType(mime));
        count++;
      }
    }
    // Mark the thread immediately so a timeout mid-run never causes re-ingestion.
    thread.addLabel(doneLabel);
  }
  return count;
}

// True if a file with this name already exists in the Inbox or in the sibling
// Processed/Ignored folders (i.e. it was ingested before, possibly already handled).
function alreadyIngested_(name) {
  const inbox = DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID);
  if (inbox.getFilesByName(name).hasNext()) return true;
  const parents = inbox.getParents();
  if (parents.hasNext()) {
    const root = parents.next();
    const siblings = root.getFolders();
    while (siblings.hasNext()) {
      const folder = siblings.next();
      if (folder.getId() !== CONFIG.INBOX_FOLDER_ID && folder.getFilesByName(name).hasNext()) return true;
    }
  }
  return false;
}

// Returns the normalized MIME type for an attachment, or null if it is not a
// document type we ingest. Falls back to the file extension because some senders
// attach PDFs as application/octet-stream.
function resolveMimeType_(att) {
  const declared = (att.getContentType() || '').toLowerCase();
  if (ALLOWED_TYPES[declared]) return ALLOWED_TYPES[declared];
  const name = (att.getName() || '').toLowerCase();
  const ext = name.indexOf('.') === -1 ? '' : name.split('.').pop();
  return EXTENSION_TYPES[ext] || null;
}

// Ping the processor until the Inbox is drained (the endpoint processes a bounded
// batch per call and reports `remaining`). Stops at the time budget so the script
// never exceeds the Apps Script execution limit — leftovers are picked up next hour.
function triggerProcessing_(deadline) {
  if (CONFIG.CRON_SECRET === 'PASTE_CRON_SECRET_HERE') {
    Logger.log('Skipping processing trigger: CONFIG.CRON_SECRET is not set.');
    return;
  }
  while (Date.now() < deadline) {
    let parsed;
    try {
      const res = UrlFetchApp.fetch(CONFIG.PROCESS_URL, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + CONFIG.CRON_SECRET },
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      const body = res.getContentText();
      Logger.log('Process ping: ' + code + ' ' + body.slice(0, 500));
      if (code !== 200) break;
      parsed = JSON.parse(body);
    } catch (e) {
      Logger.log('Process trigger failed: ' + e);
      break;
    }
    // Stop when the Inbox is drained or the endpoint made no progress.
    if (!parsed || parsed.remaining === 0 || parsed.processed === 0) break;
  }
}

function ensureLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// ---------- Gmail filter management (requires the Gmail Advanced Service) ----------

// Delete any filter that auto-applies the legacy "invoice-ingested" label.
// One such rogue filter was labeling ALL incoming mail, which excluded every
// new receipt from ingestion.
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
        Logger.log('Removed rogue Gmail filter that applied "' + CONFIG.LEGACY_DONE_LABEL + '" to incoming mail.');
      }
    });
  } catch (e) {
    Logger.log('Could not check/remove rogue filters (' + e + '). If the Gmail Advanced Service is not ' +
      'enabled: Editor sidebar > Services (+) > Gmail > Add, then re-run setup. Also check ' +
      'Gmail > Settings > Filters and DELETE any filter that applies the "' +
      CONFIG.LEGACY_DONE_LABEL + '" label.');
  }
}

// Create the Gmail filters that auto-apply the AutoInvoiced label:
//   1. Incoming invoice/receipt emails (keyword match)
//   2. Emails you send to yourself with an attachment (photographed receipts)
function createGmailFilter_() {
  const me = Session.getActiveUser().getEmail();
  const wantedQueries = [
    CONFIG.FILTER_QUERY,
    'from:' + me + ' to:' + me + ' has:attachment',
  ];
  try {
    const labels = Gmail.Users.Labels.list('me').labels || [];
    const label = labels.filter(function (l) { return l.name === CONFIG.INGEST_LABEL; })[0];
    if (!label) throw new Error('Label not found: ' + CONFIG.INGEST_LABEL);

    const filters = (Gmail.Users.Settings.Filters.list('me').filter) || [];
    wantedQueries.forEach(function (query) {
      const exists = filters.some(function (f) {
        return f.criteria && f.criteria.query === query;
      });
      if (exists) {
        Logger.log('Gmail filter already exists: ' + query);
        return;
      }
      Gmail.Users.Settings.Filters.create({
        criteria: { query: query },
        action: { addLabelIds: [label.id] },
      }, 'me');
      Logger.log('Gmail filter created: ' + query + ' -> ' + CONFIG.INGEST_LABEL);
    });
  } catch (e) {
    Logger.log('Could not create the Gmail filters automatically (' + e + ').\n' +
      'Either enable the Gmail Advanced Service (Editor sidebar > Services + > Gmail) and re-run setup,\n' +
      'or create them manually: Gmail > Settings > Filters > Create new filter >\n' +
      '  Has the words: ' + wantedQueries.join('\n  Has the words: ') + '\n' +
      '  > Create filter > Apply the label: ' + CONFIG.INGEST_LABEL);
  }
}
