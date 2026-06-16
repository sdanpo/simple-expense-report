# Invoice Automation — Setup Guide

> **Architecture note (current):** phone receipts are now captured by the **Android app**
> (**https://github.com/sdanpo/expense-report-android**) which uploads to `POST /api/inbound`
> — you no longer need FolderSync / "share to Drive." Email is still handled by Apps Script.
> This guide covers the backend (Vercel) setup; see the README for the full picture and the
> app repo's README for installing the phone app.

## What was already done for you

- Google Drive folders created:
  - `/Invoices/Inbox` — drop files here
  - `/Invoices/Processed` — auto-moved after success
  - `/Invoices/Ignored` — auto-moved if not an invoice
- Google Sheet created: **Invoice Expenses**
- All app code written and ready to deploy

---

## Step 1 — Google Cloud Project + Service Account

You need a service account so Vercel can access your Drive and Sheets.

### 1a. Create GCP Project
1. Go to https://console.cloud.google.com/
2. Click the project dropdown → **New Project** → name it `invoice-automation`
3. Click **Create**

### 1b. Enable APIs
In your new project, go to **APIs & Services → Library** and enable:
- **Google Drive API**
- **Google Sheets API**
- **Gmail API** (for email ingestion)

### 1c. Create Service Account
1. Go to **IAM & Admin → Service Accounts**
2. Click **Create Service Account**
3. Name: `invoice-bot` → Click **Create and Continue** → **Done**
4. Click the service account email → **Keys** tab → **Add Key → Create new key → JSON**
5. Save the downloaded JSON file — you'll need it in Step 2

### 1d. Share Drive folders with the service account
The service account email looks like: `invoice-bot@invoice-automation-XXXXX.iam.gserviceaccount.com`

Share these folders with that email (Editor access):
- https://drive.google.com/drive/folders/1EaS0WCSTQutUK7VigyxeTIve8LHTKRFx (Invoices root)

Also share the spreadsheet:
- https://docs.google.com/spreadsheets/d/1dSWFwyXy9wdXMYpjPsrbRCPDVZj8_bI2d4qauCkIAA8

---

## Step 2 — Gmail OAuth2 (for email ingestion)

### 2a. Create OAuth2 credentials
1. In Google Cloud Console → **APIs & Services → Credentials**
2. **Create Credentials → OAuth client ID**
3. Type: **Desktop app** → Name: `invoice-gmail-client`
4. Download the JSON → note the `client_id` and `client_secret`

### 2b. Get refresh token
```bash
GMAIL_CLIENT_ID=YOUR_CLIENT_ID GMAIL_CLIENT_SECRET=YOUR_CLIENT_SECRET \
  node scripts/setup-gmail-auth.js
```
It prints a URL — open it, authorize (Gmail + Drive), and the script captures the code
automatically via a local `http://localhost` callback (Google retired the old "oob" flow).
Copy the `GMAIL_REFRESH_TOKEN` it prints.

> The OAuth token requests **Gmail + Drive** scopes. Drive is required because the service
> account has no personal-Drive storage quota, so files must be uploaded **as you**. This
> token is used by `POST /api/inbound` to **archive app-uploaded receipt images into Drive
> `/Processed`** (so the Sheet links to them) and by the `ingest-gmail` cron. Without it,
> `/api/inbound` still records receipts but leaves `drive_link` empty.

---

## Step 3 — Vercel Deployment

### 3a. Install Vercel CLI
```bash
npm install -g vercel
```

### 3b. Deploy
```bash
cd F:\simple_expense_report
vercel
```
Follow prompts. Select your account and create a new project named `invoice-automation`.

### 3c. Set Environment Variables
In Vercel dashboard → your project → **Settings → Environment Variables**, add:

| Variable | Value |
|----------|-------|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Paste entire service account JSON (minified to one line) |
| `GMAIL_CLIENT_ID` | From Step 2a |
| `GMAIL_CLIENT_SECRET` | From Step 2a |
| `GMAIL_REFRESH_TOKEN` | From Step 2b |
| `GEMINI_API_KEY` | (your Gemini API key from aistudio.google.com) |
| `GOOGLE_DRIVE_INBOX_ID` | 1eaCs2dx-ZxwZYGA6xaqNQrKXblO7xWQG |
| `GOOGLE_DRIVE_PROCESSED_ID` | 1qRyuo0sPXpEQfZfeaQfVQfix20w0tGyr |
| `GOOGLE_DRIVE_IGNORED_ID` | 1PctH71brnmHySD1VSolcy4kek3ca4svW |
| `GOOGLE_SHEETS_ID` | 1dSWFwyXy9wdXMYpjPsrbRCPDVZj8_bI2d4qauCkIAA8 |
| `CRON_SECRET` | Any random string (e.g. `openssl rand -hex 32`) |
| `INBOUND_TOKENS` | Bearer token(s) the **Android app** uses for `POST /api/inbound` (comma-separated). The same value goes into the app build as `-PINBOUND_TOKEN`. |

> After adding/changing env vars, **redeploy** (`vercel --prod`) so the functions pick them up.

### 3d. Redeploy with env vars
```bash
vercel --prod
```

### 3e. Run initial setup
```bash
curl https://YOUR-VERCEL-URL/api/setup
```
This creates the sheet headers.

---

## Step 4 — Test the pipeline

1. Upload a photo of a receipt to: https://drive.google.com/drive/folders/1eaCs2dx-ZxwZYGA6xaqNQrKXblO7xWQG
2. Trigger processing manually:
   ```bash
   curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://YOUR-VERCEL-URL/api/cron/process-invoices
   ```
3. Check the sheet: https://docs.google.com/spreadsheets/d/1dSWFwyXy9wdXMYpjPsrbRCPDVZj8_bI2d4qauCkIAA8

---

## Daily Use

### Add invoice via phone (current)
Just **take a photo** with your normal camera. The **Android app** captures it
automatically and uploads it — nothing to share or forward. (Install it from
**https://github.com/sdanpo/expense-report-android**.)

### Add invoice via email
Receipts in your Gmail are auto-ingested by Apps Script (within the hour).

### Add invoice manually
`POST` an image to `/api/inbound` (with a `Bearer INBOUND_TOKENS` header), or use the
admin endpoints (`/api/admin/process-url` for a public image URL).

---

## Cron Schedule
- **Apps Script** (hourly, as you): read labeled Gmail → Drive Inbox → trigger Vercel.
- **Vercel cron** (daily 06:00 UTC): `/api/cron/process-invoices` backstop pass.
- `/api/cron/ingest-gmail` exists (direct Gmail read) but is **not scheduled** yet.
- `/api/inbound` is on-demand (the Android app calls it as photos are taken).
