# Invoice Automation — Setup Guide

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
cd F:\simple_expense_report
set GMAIL_CLIENT_ID=YOUR_CLIENT_ID
set GMAIL_CLIENT_SECRET=YOUR_CLIENT_SECRET
node scripts/setup-gmail-auth.js
```
Follow the instructions. Copy the `GMAIL_REFRESH_TOKEN` it prints.

> The OAuth token requests **Gmail + Drive** scopes. Drive is required because the
> service account has no personal-Drive storage quota, so Gmail attachments must be
> uploaded into the Inbox folder **as you** (via this token). Invoice processing
> itself (classify/extract/sheet/move) runs on the service account and needs no token.

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

### Add invoice via phone
Take photo → tap Share → Google Drive → navigate to **Invoices/Inbox**

### Add invoice via email
Forward the email to dan.porat@gmail.com — it gets auto-ingested within the hour.

### Add invoice manually
Upload directly to the Inbox folder link above.

---

## Cron Schedule
- `:00` every hour → Gmail → Drive Inbox
- `:30` every hour → Process Inbox → Sheets
