
## Architecture (all-in-Apps-Script, Vercel retired)

The entire pipeline now runs inside Google Apps Script (`apps-script/Code.gs`) as you:
Gmail read -> Drive Inbox -> **Gemini (called directly from Apps Script)** -> Sheet -> Processed/Ignored.
No server, no service account, no CRON_SECRET. A phone photo-sync app feeds the Drive Inbox.

**Vercel is no longer used** and can be deleted (project + the daily cron in `vercel.json`).
The Next.js app under `src/` and the `/api/admin/*` endpoints are kept in the repo for reference only.

Schedule: the Apps Script `runHourly` time trigger runs every hour and does both email ingestion
and Inbox processing, bounded by a 5-minute time budget (Apps Script caps runs at 6 min).

# Personal Invoice Automation — Status

**Live app:** https://simpleexpensereport.vercel.app
**Drive folder:** https://drive.google.com/drive/folders/1EaS0WCSTQutUK7VigyxeTIve8LHTKRFx
**Sheet:** https://docs.google.com/spreadsheets/d/1dSWFwyXy9wdXMYpjPsrbRCPDVZj8_bI2d4qauCkIAA8

## Pipeline

Photo/PDF → Drive `Invoices/Inbox` → Gemini classify+extract → Google Sheet → file moved to `Processed`/`Ignored`.

| Concern | Mechanism |
|---------|-----------|
| Drive read / move, Sheets write | **Service account** (no token to expire) |
| Gemini classify + extract | `gemini-2.5-flash` (2.0-flash lost free-tier quota; override via `GEMINI_MODEL` env) |
| Invoice processing | Vercel route `/api/cron/process-invoices` (6 files per call, caller re-invokes until `remaining: 0`) |
| Scheduling | Vercel cron daily 06:00 UTC **+** Apps Script hourly run |
| **Gmail → Inbox ingestion** | **Google Apps Script** (`apps-script/Code.gs`) — label-based |
| **Phone camera → Inbox** | **Background sync app** (see below) — no manual sharing |

## How invoices get in (100% hands-free)

### 1. Email (Gmail filter + label)
A Gmail filter applies the **`AutoInvoiced`** label to incoming emails that look like
invoices/receipts. Every hour the Apps Script:
1. Takes `AutoInvoiced` threads not yet marked **`AutoInvoiced-done`**
2. Saves their *real* attachments (PDF/images — inline signature logos and tracking
   pixels are skipped, octet-stream PDFs are normalized) into Drive `Invoices/Inbox`
3. Marks the thread `AutoInvoiced-done`
4. Pings the Vercel processor until the Inbox is drained (within a strict 4-minute
   budget so it can never exceed Apps Script's execution limit)

**Manual override:** apply the `AutoInvoiced` label by hand to any email and it gets
ingested on the next hourly run.

### 2. Phone camera (background sync app — set up once)
Install a sync app and point it at the Drive `Invoices/Inbox` folder:
- **Android:** [Autosync for Google Drive](https://play.google.com/store/apps/details?id=com.ttxapps.drivesync) —
  create a one-way sync pair: a phone album/folder (e.g. "Receipts") → Drive `Invoices/Inbox`.
- **iPhone:** "Sync with Google Drive" (Pixegram) — same idea: sync a Photos album → `Invoices/Inbox`.

Then: take a photo of the receipt → it lands in the Inbox automatically → processed within the hour.

### 3. Manual
Upload directly to the [Inbox folder](https://drive.google.com/drive/folders/1eaCs2dx-ZxwZYGA6xaqNQrKXblO7xWQG).

## Apps Script setup / update (~3 min)

1. Open https://script.google.com → your invoice project (or **New project**)
2. Replace the code with the contents of `apps-script/Code.gs`
3. Enable the **Gmail Advanced Service**: Editor sidebar → Services **+** → Gmail → Add
4. Replace the manifest: ⚙️ Project Settings → "Show appsscript.json manifest file in editor" →
   paste `apps-script/appsscript.json` (adds the `gmail.settings.basic` scope needed to manage filters)
5. Paste the real `CRON_SECRET` into `CONFIG.CRON_SECRET` (value in Vercel → Settings → Env Vars)
6. Select function **`setup`** → Run → authorize. This also **deletes the rogue Gmail
   filter** that was labeling all incoming mail as `invoice-ingested`, and creates two
   new filters: keyword-matching receipts + self-sent emails with attachments.
7. Run **`resetInboxTrashAllFiles`** once — clears the ~350 junk files the old script
   ingested (recoverable from trash for 30 days).
8. Run **`backfillRecentReceipts`** once — re-ingests real receipt emails from the last
   30 days (including photos you emailed to yourself) and processes them into the Sheet.

## Incident notes (2026-06-02)

What broke and how it was fixed:
1. **Junk flood:** old script matched keywords anywhere incl. "payment" and saved *inline*
   images (signature logos, auction pictures). → Now: inline images excluded, tiny files
   excluded, tighter keywords.
2. **6-minute timeouts ("ran endlessly"):** unbounded ingestion + up to 30 processor pings.
   → Now: hard 4-minute time budget on every run.
3. **Rogue Gmail filter** auto-applied `invoice-ingested` to ALL incoming mail, so new
   receipts were pre-excluded from ingestion. → Now: `setup()` removes it; the script uses
   new labels (`AutoInvoiced` / `AutoInvoiced-done`).
4. **octet-stream PDFs skipped** (e.g. Menora insurance docs). → Now: type resolved from
   file extension and normalized on save.
5. **Processing never triggered:** `CRON_SECRET` left as placeholder in Apps Script → 401.
   → Now: explicit warning at setup; paste the real secret.
6. **Gemini free tier removed for `gemini-2.0-flash`** (429, `limit: 0`) → every file
   errored and bounced back to the Inbox. → Now: `gemini-2.5-flash` by default,
   configurable via `GEMINI_MODEL`.

## Manual controls

Trigger processing now:
```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://simpleexpensereport.vercel.app/api/cron/process-invoices
```
Repeat until the response shows `"remaining": 0`.

## Repo scripts (local diagnostics, use `.env.local`)
- `scripts/test-gemini.js` — Gemini on a local image
- `scripts/run-pipeline-local.js` — full pipeline locally via service account
- `scripts/verify-and-clean.js` — read Sheet + folder state
- `scripts/cleanup-test-artifacts.js` — clear test rows/files

> Note: `.env.local` is gitignored and not present on this machine — recreate it from
> `.env.example` with values from the Vercel dashboard to run local scripts.
