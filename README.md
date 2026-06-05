# Personal Invoice Automation

Turns every receipt you get — by **email**, or as a **photo on your phone** — into a row in a
Google Sheet, automatically, with no manual data entry. A receipt is read by Google's Gemini AI,
which pulls out the vendor, date, amount, currency, tax and invoice number, decides whether it's
even a real receipt, and files it.

| | |
|---|---|
| **Live app (Vercel)** | https://simpleexpensereport.vercel.app |
| **Drive folder** | https://drive.google.com/drive/folders/1EaS0WCSTQutUK7VigyxeTIve8LHTKRFx |
| **Expenses Sheet** | https://docs.google.com/spreadsheets/d/1dSWFwyXy9wdXMYpjPsrbRCPDVZj8_bI2d4qauCkIAA8 |
| **Repo** | https://github.com/sdanpo/simple-expense-report (auto-deploys to Vercel on push to `master`) |

---

## 1. The big picture — what happens, and why

```
  ┌─────────────┐   ┌──────────────────────────┐   ┌──────────────────────────────┐
  │  YOUR PHONE │   │         GMAIL            │   │   GOOGLE DRIVE  /Invoices/    │
  │             │   │  receipts arrive here    │   │  ┌────────┐ ┌─────────┐ ┌──────────┐
  │ camera ▶ ───┼──▶│  (Gmail filter labels    │   │  │ Inbox  │ │Processed│ │ Ignored  │
  │ photo-sync  │   │   them "AutoInvoiced")   │   │  └────────┘ └─────────┘ └──────────┘
  │ app uploads │   └────────────┬─────────────┘   └─────▲────────────▲──────────▲───────┘
  │ to /Inbox   │                │                       │            │          │
  └──────┬──────┘                │ reads labeled mail    │ drops      │ moves    │ moves
         │                       ▼                       │ files in   │ here     │ here
         │            ┌────────────────────────┐         │ (success)  │ (not a
         └───────────▶│   GOOGLE APPS SCRIPT   │─────────┘            │  receipt)
              uploads │  (runs every hour AS    │                     │
              land in │   you, inside Google)   │  pings ──────┐      │
              /Inbox  │  • read Gmail → Inbox   │              │      │
                      │  • trigger processing   │              ▼      │
                      └────────────────────────┘   ┌──────────────────┴───────────┐
                                                    │   VERCEL  (the "brain")      │
                                                    │  /api/cron/process-invoices  │
                                                    │  for each file in Inbox:     │
                                                    │   1. send to ── Gemini AI ──▶ classify + extract
                                                    │   2. write a row ──────────▶ GOOGLE SHEET
                                                    │   3. move file to Processed/Ignored
                                                    └──────────────────────────────┘
```

**Why it's split into two pieces (Apps Script + Vercel):**

- **Google Apps Script** runs *as you*, inside Google. It's the only piece that can read your Gmail
  and write to your Drive without OAuth consent screens, app-verification, or 7-day token expiry.
  Its job is deliberately tiny: **move receipts from Gmail into the Drive Inbox, then poke Vercel.**
- **Vercel** hosts the **processing logic** (the "brain"): the AI prompts, the classify/extract step,
  the Sheet-writing, the file-moving, and a set of admin tools. It lives in this Git repo, so the
  logic is **easy to read, change, and redeploy** (push to `master` → Vercel rebuilds in ~1 min).

In short: **Apps Script = the hands inside your Google account; Vercel = the editable brain.**

---

## 2. The three ways a receipt gets in

| Source | How it arrives | Who handles it |
|--------|----------------|----------------|
| **Email with a PDF/image attachment** (Gett, Roamless, utility bills, "חשבונית מס") | Gmail filter labels it `AutoInvoiced`; Apps Script saves the attachment into Drive `Inbox` | Apps Script → Vercel |
| **Email where the receipt is in the body text** (Uber, Metropark — no attachment) | Apps Script reads the message body and POSTs the text to Vercel `/api/admin/process-text` | Apps Script → Vercel |
| **Photo taken on your phone** | A background photo-sync app (e.g. FolderSync) uploads it straight into Drive `Inbox` | Vercel picks it up on the next run |

Anything that lands in the Drive **Inbox** — whether put there by Apps Script or by the photo-sync
app — is processed by Vercel on the next run.

---

## 3. What happens, step by step (and when)

**Every hour**, Google fires the Apps Script `runHourly` trigger (Google picks the minute; ±~15 min
jitter). Each run, bounded by a **4-minute budget** so it can never hit Apps Script's 6-minute limit:

1. **Ingest email** (`ingestLabeledThreads_`): find Gmail threads labeled `AutoInvoiced` but not yet
   `AutoInvoiced-done`. For each message:
   - Save real PDF/image **attachments** into Drive `Inbox` (inline logos, tracking pixels, and tiny
     <5 KB files are skipped; `application/octet-stream` PDFs are normalized by extension; a filename
     dedup prevents re-saving the same file).
   - If a message has **no usable attachment**, send its **body text** to Vercel
     `/api/admin/process-text` (this is how Uber-style receipts are caught).
   - Mark the thread `AutoInvoiced-done` so it's never re-ingested.
2. **Trigger processing** (`triggerProcessing_`): repeatedly call Vercel `/api/cron/process-invoices`
   until the Inbox is drained (or the time budget runs out — leftovers wait for next hour).

**On each `/api/cron/process-invoices` call**, Vercel processes up to **4 files** (`MAX_FILES_PER_RUN`)
and reports how many remain, so the caller loops until `remaining: 0`. For each file:

1. **Claim** it by moving it out of `Inbox` → `Processed` *before* any slow work (so a retry or a
   concurrent run can't double-process it).
2. **Download** the file and send it to **Gemini** (`analyzeDocument`) — a **single** AI call that
   both classifies (is this a receipt?) and extracts the fields.
3. **Decide:**
   - Not a receipt, or low confidence → move to `Ignored`.
   - **Already in the Sheet** (same invoice number, or same date+amount+currency) → skip the row and
     move to `Ignored`, logged as `duplicate`. This is what stops multiple photos of one receipt (or a
     re-processed file) from creating duplicate rows.
   - A new receipt → append a row to the Sheet, leave the file in `Processed`.
4. **On error:** a *permanent* error — corrupt/unreadable image, or a Gemini **refusal/safety block**
   (e.g. a photo of a person, which returns prose instead of JSON) → `Ignored`. A *transient* error
   (rate-limit, timeout) → moved back to `Inbox` to retry next cycle.

**Once a day at 06:00 UTC (09:00 Israel)**, a Vercel cron also calls `/api/cron/process-invoices`
once — a backstop in case an hourly Apps Script run was missed. (It does **not** read email.)

So end-to-end latency for a new receipt ≈ *(photo-sync interval, for photos)* + *up to 1 hour* until
the next processing run.

---

## 4. What counts as a receipt (the classification rules)

Gemini is told to **accept only proof-of-payment documents** — the deciding test is *"does it show a
concrete amount that was actually charged/paid, plus a vendor?"*

- **Accepted:** store/restaurant receipts, ride/taxi/parking/toll receipts, utility bills,
  subscription invoices, **travel-insurance premiums / eSIM / booking charges**, Hebrew
  "חשבונית מס/קבלה". RTL/Hebrew text is fully valid. Currency is read from the actual symbol
  (₪→ILS, $→USD, €→EUR, £→GBP) — a Hebrew document is **not** assumed to be ILS.
- **Rejected** (no amount actually charged = not an expense): insurance **policy terms** pages with no
  price, pension/fund statements and notices, bank statements, schedules, contracts, book/equipment
  lists, reservation confirmations with no price, "this is not a payment receipt / charge summary"
  documents, marketing, and personal photos.

A row is marked **`Approved`** when vendor + date + amount are all present and confidence ≥ 0.8;
otherwise **`Needs Review`**. The Gemini model is **`gemini-2.5-flash-lite`** (override with the
`GEMINI_MODEL` env var) — chosen because the `2.0-flash` / `2.5-flash` free tiers are only ~20
requests/day, while `flash-lite` has its own larger quota pool.

---

## 5. The Drive folder lifecycle

```
/Invoices
  /Inbox      ← receipts land here (from Apps Script or the photo-sync app). Transient.
  /Processed  ← files that became a Sheet row. Kept as the archive.
  /Ignored    ← files Gemini judged not-a-receipt, or unsupported/too-large/corrupt.
```

**Cleanup:** the **Inbox** is self-clearing (files move out as they're processed). The **Ignored**
folder is auto-trashed by the Apps Script hourly run once files are older than
`IGNORED_RETENTION_DAYS` (default 3; recoverable from Drive trash ~30 days). The **Processed**
folder is kept as the receipt archive (the Sheet's `drive_link` points into it); run
`cleanupProcessedOrphans` to drop duplicate/orphan files the Sheet doesn't reference.

A file is only ever in one folder. The Sheet's `drive_link` column points back to the file.

---

## 6. The Google Sheet

One sheet named **`Invoices`**, columns:

`vendor · invoice_date · total_amount · currency · tax_amount · invoice_number · confidence · status · file_name · drive_link · processed_at`

---

## 7. Components reference

### Apps Script — `apps-script/Code.gs` (the thin "hands" layer)
Runs as you, hourly. Key functions:

| Function | Role |
|----------|------|
| `setup` | One-time: create the `AutoInvoiced` labels, create the Gmail filters, delete the rogue legacy `invoice-ingested` filter, install the hourly trigger. |
| `runHourly` | The scheduled job (4-min budget): ingest email → consolidate stray inbox folders → trigger Vercel processing → auto-clean old Ignored files. |
| `ingestLabeledThreads_` | Save attachments to Inbox; send body-only receipts to Vercel. |
| `sendBodyToAnalyzer_` | POST a message body to `/api/admin/process-text`. |
| `triggerProcessing_` | Ping `/api/cron/process-invoices` until the Inbox is drained. |
| `consolidateInboxes_` | Move files out of any stray sibling folder named `inbox` into the real Inbox (self-heals a sync app that creates a duplicate). |
| `cleanupIgnored_` | Auto-trash Ignored files older than `IGNORED_RETENTION_DAYS` (logs to the Log tab). |
| `logToSheet_` / `hasSecret_` | Post a line to the unified Log tab; detect whether the real `CRON_SECRET` is set. |
| `backfillRecentReceipts` | One-time: label + ingest receipt emails from the last 30 days. |
| `forceReingest` | Un-mark recent threads so missed attachments re-ingest (dedup-safe). |
| `clearSheet` | Delete all data rows from the Sheet (keep header). |
| `emptyIgnoredNow` | Trash everything in Ignored immediately. |
| `cleanupProcessedOrphans` | Trash Processed files no Sheet row references (de-dupe the archive). |
| `resetInboxTrashAllFiles` / `clearAllInvoiceFolders` | Trash the Inbox (+ Ignored) / all three folders — full reset. |

`apps-script/appsscript.json` is the manifest (Gmail advanced service + OAuth scopes, incl. `spreadsheets`).
`apps-script/Code.local.gs` is a gitignored copy with the secret filled in (don't commit it).

### Vercel — `src/app/api/**` (the "brain")
| Route | Purpose |
|-------|---------|
| `GET /api/cron/process-invoices` | **Main processor.** Process up to 4 Inbox files → Gemini → Sheet → move. Returns `{processed, remaining, results}`. Also the daily Vercel cron target. Auth: `Bearer CRON_SECRET`. |
| `GET /api/setup` | Ensure the Sheet exists with headers; echo the configured IDs. |
| `POST /api/admin/process-text` | Analyze a receipt delivered as **email body text** (Uber, Metropark). |
| `POST /api/admin/process-url` | Analyze a receipt from a **public image/PDF URL** (e.g. a Google Photos share link). |
| `GET  /api/admin/process-drive-file?ids=…` | Re-analyze existing Drive files by ID → Sheet (rebuild without re-ingesting from Gmail). |
| `POST /api/admin/add-row` | Append a row with **explicit values** (manual correction, e.g. forcing a currency). |
| `POST /api/admin/log` | Append a line to the unified **Log** tab (used by the Apps Script ingester). |
| `GET  /api/admin/clean-sheet` | Delete all data rows (keep header). |
| `GET  /api/admin/delete-rows?match=…` | Delete rows containing a substring (targeted removal). |
| `GET  /api/admin/clean-inbox?folders=…` | **Does not work** — the service account is only an Editor and Google won't let it *trash* files you own. Folder clearing must be done from Apps Script (`clearAllInvoiceFolders`). |
| `GET /api/cron/gmail-to-inbox` | **Legacy / unused** — an old OAuth-token Gmail ingester. Ingestion is done by Apps Script instead; kept for reference. |

All `/api/**` routes are protected by `Authorization: Bearer <CRON_SECRET>` (except where noted).

### Vercel — `src/lib/**`
- `gemini.ts` — the AI: model selection, the strict classify+extract **prompt**, `analyzeDocument`
  (files) and `analyzeText` (email bodies), with retry/backoff on transient errors.
- `drive.ts` — list Inbox, download, move files (via the service account). **The Inbox folder ID is
  hardcoded here as `INBOX_ID`** (the original env-configured Inbox was accidentally trashed and
  replaced by `1Dd8…`, which the photo-sync app writes to) — `GOOGLE_DRIVE_INBOX_ID` is no longer read.
- `sheets.ts` — ensure headers, append a row, the unified Log tab (`appendLog`), and dedup keys
  (`getExistingDedupKeys` / `dedupKey`).
- `auth.ts` — service-account auth for Drive/Sheets.
- `types.ts` — shared types.

---

## 8. Environment variables (Vercel → Settings → Environment Variables)

| Variable | What it is |
|----------|-----------|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service-account JSON (one line). Used for Drive read/move + Sheet writes — no token to expire. Must be shared as Editor on the `/Invoices` folder and the Sheet. |
| `GEMINI_API_KEY` | Gemini API key (https://aistudio.google.com/apikey). |
| `GEMINI_MODEL` | *(optional)* override the model; default `gemini-2.5-flash-lite`. |
| `MAX_FILES_PER_RUN` | *(optional)* files processed per call; default `4`. |
| `GOOGLE_DRIVE_PROCESSED_ID` / `_IGNORED_ID` | The Processed / Ignored folder IDs. (The **Inbox** ID is now hardcoded as `INBOX_ID` in `src/lib/drive.ts`; `GOOGLE_DRIVE_INBOX_ID` is unused.) |
| `IGNORED_RETENTION_DAYS` | Set in Apps Script `CONFIG` (default 3) — auto-trash Ignored files older than this. |
| `GOOGLE_SHEETS_ID` | The Expenses spreadsheet ID. |
| `CRON_SECRET` | Shared secret protecting the API routes; the **same value** goes in Apps Script `CONFIG.CRON_SECRET`. |
| `GMAIL_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | *(legacy)* only used by the unused `gmail-to-inbox` route. |

---

## 9. Setup from scratch

**Vercel side**
1. `GOOGLE_SERVICE_ACCOUNT_JSON`: create a service account, share `/Invoices` (Editor) and the Sheet
   (Editor) with its email.
2. Set the env vars above. Deploy (push to `master`; GitHub → Vercel auto-deploys).
3. `curl https://<app>/api/setup` to create the Sheet headers.

**Apps Script side** (this is what makes it hands-free)
1. script.google.com → paste `apps-script/Code.gs`.
2. Editor → **Services (+) → Gmail → Add** (lets it manage the Gmail filters).
3. Project Settings → show `appsscript.json` → paste `apps-script/appsscript.json`.
4. Set `CONFIG.CRON_SECRET` to the same value as Vercel's `CRON_SECRET`.
5. Run **`setup`**, authorize. Optionally run **`backfillRecentReceipts`** once to pull recent receipts.

**Phone side (photos)**
- Install a Drive-sync app (this setup uses **FolderSync**, one-way "upload") and sync a folder into the
  Drive `Inbox` folder (`INBOX_ID` in `src/lib/drive.ts`). This deployment syncs the whole camera roll
  and relies on Gemini billing + dedup + auto-clean to absorb it; a dedicated "Receipts" folder avoids
  processing personal photos (see Known issues).

---

## 10. Manual operations

Trigger a processing pass now (loop until `"remaining": 0`):
```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://simpleexpensereport.vercel.app/api/cron/process-invoices
```
Add a one-off receipt from a public photo URL:
```bash
curl -X POST -H "Authorization: Bearer <CRON_SECRET>" -H "Content-Type: application/json" \
  -d '{"url":"https://…","file_name":"my_receipt.jpg"}' \
  https://simpleexpensereport.vercel.app/api/admin/process-url
```
Clear the Sheet / remove a row:
```bash
curl -H "Authorization: Bearer <CRON_SECRET>" "https://…/api/admin/clean-sheet"
curl -H "Authorization: Bearer <CRON_SECRET>" "https://…/api/admin/delete-rows?match=926001473744"
```
Clear the Drive folders: run **`clearAllInvoiceFolders`** in Apps Script (Vercel can't trash files you
own).

---

## 11. Logs & debugging — one place

There is a **single activity log: a `Log` tab in the same Google Sheet.** Both halves of the system
write to it, so you never open the Apps Script editor or the Vercel dashboard to see what happened:

```
timestamp           | source      | event        | detail
2026-06-04 18:05:11 | apps-script | ingest       | hourly run: ingested 3 email item(s)
2026-06-04 18:05:14 | vercel      | approved     | IMG_x.jpg → approved: El Corte Inglés 1.86 EUR
2026-06-04 18:05:18 | vercel      | ignored      | IMG_y.jpg → ignored (not a receipt)
2026-06-04 18:05:22 | vercel      | error        | IMG_z.jpg → Gemini quota/rate-limit (429), will retry
```

- **"Did it run?"** → look for an `apps-script / ingest` line in the last hour.
- **"Why didn't my receipt show up?"** → find its filename: `ignored (not a receipt)` = Gemini didn't
  see it as a receipt; `error … will retry` = transient (quota), it'll reappear; no line at all = it
  never reached the Inbox (sync/label problem — see below).

Implementation: Vercel writes via `appendLog()` (`src/lib/sheets.ts`); Apps Script POSTs to
`/api/admin/log`. The tab is auto-created and trimmed to the newest ~1000 rows. Raw runtime logs still
exist (Apps Script **Executions**, Vercel **Logs**) but are only needed for deep stack traces.

## 12. Known issues & design decisions

- **Photo-sync floods the Inbox — accepted by design here.** The phone (FolderSync) syncs the *whole
  camera roll*, so every personal photo/video gets run through Gemini. **Decision:** keep it simple and
  **enable Gemini API billing** (≈ $0.0002/image, a few cents/month) rather than scope the sync.
  Personal photos classify to `Ignored` and auto-delete after `IGNORED_RETENTION_DAYS`; duplicate rows
  are prevented by the dedup check. If you'd rather not pay to analyze personal photos, the alternative
  is a *dedicated Receipts folder* (sync only that) or a "newer than N days" + exclude-`*.mp4` filter.
  Note: the processor *moves* files out of the Inbox, so use one-way "upload" sync (not mirror) to
  avoid re-upload loops; `consolidateInboxes_` also self-heals a duplicate `inbox` folder.
- **The service account cannot trash files you own.** It's an Editor, and Google only lets the owner
  trash. So `clean-inbox` fails; folder clearing/auto-clean is done from Apps Script
  (`clearAllInvoiceFolders`, `cleanupIgnored_`). The service account *can* read/move/download files
  (even trashed ones, by ID, for ~30 days).
- **Gemini free-tier quota is small.** `2.0-flash`/`2.5-flash` ≈ 20 req/day; we use `flash-lite` **with
  billing enabled** so floods don't hit a cap. Gemini also *refuses* some images (e.g. photos of
  people), returning prose not JSON — those are treated as permanent errors → `Ignored`.
- **Duplicates from re-photographed receipts.** The same receipt shot several times = several photos;
  the dedup check (invoice # / date+amount) ensures only one Sheet row.
- **Google Photos ≠ Google Drive.** A photo backed up to Google Photos is not in Drive, and the Photos
  API is locked down — nothing can pull it automatically. A photo only enters the pipeline once it's
  in Drive (via a sync app, manual upload, or a share link processed with `process-url`).
- **Apps Script schedule isn't exact.** `everyHours(1)` runs once per hour at a Google-chosen minute,
  ±~15 min. There is no way to pin it to `:00`.
- **Currency on dual-denominated docs.** Some Israeli receipts price in USD but bill in ILS (e.g. the
  Menora travel-insurance premium $5.27). The prompt is told to read the printed symbol; genuine
  ambiguities can be corrected with `/api/admin/add-row`.

---

## 13. Repo layout

```
apps-script/
  Code.gs           ← the hourly Gmail→Inbox ingester + Vercel trigger (paste into script.google.com)
  appsscript.json   ← Apps Script manifest (scopes + Gmail advanced service)
src/
  app/api/cron/process-invoices/  ← the main processor
  app/api/admin/*                 ← operational endpoints (text/url/drive-file/add-row/clean/delete)
  app/api/setup/                  ← header bootstrap
  lib/                            ← gemini, drive, sheets, auth, types
scripts/            ← local diagnostics (run against .env.local)
vercel.json         ← the daily 06:00 UTC backstop cron
```
