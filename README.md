# Personal Invoice Automation — Status

**Live app:** https://simpleexpensereport.vercel.app
**Drive folder:** https://drive.google.com/drive/folders/1EaS0WCSTQutUK7VigyxeTIve8LHTKRFx
**Sheet:** https://docs.google.com/spreadsheets/d/1dSWFwyXy9wdXMYpjPsrbRCPDVZj8_bI2d4qauCkIAA8

## What works right now (deployed + tested end-to-end)

Photo/PDF → Drive `Invoices/Inbox` → Gemini classify+extract → Google Sheet → file moved to `Processed`/`Ignored`.

Verified in production:
- ✅ Real invoice PDF (BigDeal, 255 ILS) → extracted + Approved + row in Sheet
- ✅ Real invoice PDF (Rami Levy, 284.98 ILS) → extracted + Approved
- ✅ Non-invoice photo → routed to `Ignored`
- ✅ Unsupported file type → routed to `Ignored`
- ✅ Empty inbox → idempotent (no double-processing)
- ✅ Gemini transient 503 → auto-retry with backoff, then succeeds

## Architecture (final)

| Concern | Mechanism | Why |
|---------|-----------|-----|
| Drive read / move, Sheets write | **Service account** | Works for user-owned files; no token to expire |
| Gemini classify + extract | `gemini-2.5-flash` | `gemini-1.5-flash` was retired |
| Invoice processing | Vercel route `/api/cron/process-invoices` | Proven pipeline |
| Scheduling | Vercel cron daily 06:00 UTC **+** Apps Script hourly ping | Hobby plan caps native cron at daily |
| **Gmail → Inbox ingestion** | **Google Apps Script** (`apps-script/Code.gs`) | Runs *as you* — no OAuth client/consent/verification/7-day-expiry headaches that blocked the service-account + OAuth route |

### Why not service-account upload / OAuth client for Gmail?
- Service accounts have **no personal-Drive storage quota** → cannot upload files.
- A standalone OAuth client for a personal Gmail with restricted scopes (gmail.modify, drive) triggers unverified-app friction and token expiry. Apps Script avoids all of it.

## Ways invoices get in

1. **Phone (primary):** photo → Share → Google Drive → `Invoices/Inbox`. Works now.
2. **Manual:** upload to the Inbox folder. Works now.
3. **Email:** Apps Script pulls Gmail attachments hourly (after the 2-min setup below).

## Remaining setup — Gmail ingestion (one time, ~2 min)

1. Open https://script.google.com → **New project**
2. Delete the stub, paste the contents of `apps-script/Code.gs`
3. Click **Save**, then select function **`setup`** in the toolbar and click **Run**
4. Authorize when prompted (your own script — pick account → Advanced → Go to project → Allow)
5. Done. It now ingests Gmail invoice attachments **and** pings the processor every hour.

## Manual controls

Trigger processing now:
```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://simpleexpensereport.vercel.app/api/cron/process-invoices
```

## Repo scripts (local diagnostics, use `.env.local`)
- `scripts/test-gemini.js` — Gemini on a local image
- `scripts/run-pipeline-local.js` — full pipeline locally via service account
- `scripts/verify-and-clean.js` — read Sheet + folder state
- `scripts/cleanup-test-artifacts.js` — clear test rows/files
