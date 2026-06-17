# Multi-user onboarding & storage — Option B (target design)

> **Status: PROPOSED / target design — not yet implemented.** The system today is
> single-tenant (one owner's Google account, Sheet, and service account). This document
> describes the design for turning it into a frictionless multi-user product. It does not
> describe current behavior.

## Goal

Let **any** new user who downloads the app start using it in **two consent taps** — with
**no developer console, no API keys/secrets, and no scary "see all your Drive" prompts** —
while their receipts live in **their own Google Drive** (so we are not the custodian of
their financial data), and the apps stay thin enough that **iOS is a small port, not a
second implementation**.

## Guiding principle

The app does **only** what the device alone can do (acquire a photo and hand it off).
**Everything else — classification, extraction, dedup, writing the Sheet — is on the
server, written once and shared by all platforms.** Every line of logic in the app must be
maintained twice (Kotlin + Swift) and will drift; server logic is written once.

## Why Option B (and not the alternatives)

The variable cost in any Google integration is **scope verification**, not the number of
consent clicks:

| Permission | Consent the user sees | Operator verification |
|---|---|---|
| Identity (`openid email profile`) | "know who you are" — trivial | none |
| **`drive.file`** | "create & manage files **this app** makes in your Drive" — mild | **none** |
| Full Drive / Sheets | "see & manage **all** your Drive/Sheets" — scary | yes (audit) |
| Read Gmail / Photos | "read **all** your email/photos" — scary | yes (audit); Photos API now restricted |

- **Option A** — identity only, data in *our* product DB/blob. Fewest clicks, but we become
  custodian of users' financial data.
- **Option B (chosen)** — identity + `drive.file`. Data lives in the **user's own** Drive
  (a Sheet + an images folder the app creates). Mild consent, **no verification**, we hold
  no user data.
- **Option C** — read Gmail/Photos for full "do nothing" auto-ingest. Triggers Google's
  security audit and shows scary consent; Photos API is now restricted to a picker. Avoided.

`drive.file` is the sweet spot: the app can create and write *only the files it makes* in
the user's Drive, so it never needs full-Drive access and never triggers the audit.

## Operator one-time setup (the only console work — once, ever)

Done once for the whole product; **no user ever sees it**:

1. One Google Cloud project + OAuth consent screen, scopes: **`openid email profile drive.file`**.
2. OAuth client IDs: **Android** (app SHA-1), **iOS** (bundle id), **Web** (for the server).
3. One **Gemini API key** (server-side, all users share it; cost ≈ $0.0002/image).

> Confirm at publish time that `drive.file` still requires no security assessment (it has
> long been the recommended no-audit scope, but Google reclassifies occasionally).

## User onboarding (what a new user taps)

```
1. Download, open app
2. "Continue with Google"
      → consent: identity + "create & manage files this app makes in your Drive"
3. (first capture) allow Photos/Camera — one tap
4. Take/share a receipt → it appears as a row in a Google Sheet in their own Drive
```

Two consent taps. No console, no keys, no all-Drive prompt.

## Token model (why the server stores almost nothing)

- Google Sign-In on the device yields a **short-lived `drive.file` access token** (the OS
  silently refreshes it).
- The app **sends that token with each upload**. The server **borrows it for that one
  request** to write to the user's Drive, then discards it.
- **The server stores no long-lived Google tokens** — only the user's id and two file ids
  (below). The user's receipts never live on our servers.

> A stored **refresh token** is needed *only* for server-initiated writes when the user is
> offline (e.g. future email ingestion). The photo path does not need it.

## Data flow per receipt

```
 app:  photo + Google drive.file access token + identity
         │
         ▼
 POST /api/inbound   (server; product Gemini key)
   1. identify the user
   2. Gemini: classify + extract (vendor, date, amount, currency, tax, number)
   3. dedup against the user's own sheet
   4. (if receipt) upload image  ─▶ user's Drive  /My Receipts/images
   5. append row (+ image link)  ─▶ user's "My Receipts" Google Sheet
         │
         ▼
 image + row live in the USER's own Drive — they own it
```

## First-run provisioning (server, idempotent)

On the first upload, if no Sheet id is stored for this user, the server uses the provided
token to **create a "My Receipts" spreadsheet (with the header row) + a "Receipts" image
folder** in the user's Drive, and stores their ids. Every later upload reuses them. Because
of `drive.file`, the app/server can see *only* these app-created files — nothing else in
the user's Drive.

## Server data model (the entire per-user record)

```
userId (Google sub) · email · spreadsheetId · imagesFolderId
```

The **user's Sheet is the system of record**, not our database.

## App vs server responsibilities

| | App (thin, per-platform) | Server (brain, once) |
|---|---|---|
| Google Sign-In (identity + `drive.file`) | ✅ | verifies identity |
| Capture / receive photo | ✅ | — |
| Upload image + token to `/api/inbound` | ✅ | — |
| Gemini classify / extract, dedup | — | ✅ |
| Create & write the user's Sheet + Drive folder | — | ✅ |
| View receipts | "Open my Sheet" button (opens the Drive URL) | — |

No Drive/Sheets SDK in the app — the server performs every Google write. The app is
sign-in + uploader + a link.

## Where everything resides

- **The sheet:** a "My Receipts" Google Sheet in the **user's own Drive** (app-created).
- **The photos:** a "Receipts" folder in the **user's own Drive**, linked from each row.
- **Our servers:** only `userId · email · spreadsheetId · imagesFolderId` + the Gemini key.
  No user receipts, no long-lived tokens.

## iOS portability

Identical server. The iOS app = Google Sign-In SDK (request `drive.file` + access token) +
a Share Extension + the same upload call. A small port — there is no app-side logic to
re-implement.

## Edge cases & open questions

- **Token expired/revoked:** the app silently re-fetches the access token, or re-prompts
  sign-in if Google has revoked access.
- **User deleted the Sheet/folder:** re-provision on the next upload.
- **Dedup:** read the user's own sheet (the existing `getExistingDedupKeys` logic, scoped
  per user).
- **Validate before committing:** confirm an app-created spreadsheet is writable via the
  Sheets API under `drive.file` (documented behavior — worth a ~10-min spike).
- **Custodial scope:** the per-request token can touch only files the app created in the
  user's Drive — a small blast radius, but still treat the token in flight with care.

## Email (optional, later)

Add per-user **forwarding** to an inbox address (a one-time Gmail filter — no Gmail scope,
no audit). The server processes forwarded receipts and writes to the same "My Receipts"
Sheet. Avoids the restricted Gmail scope entirely.

## Relationship to the current system

Today's backend is single-tenant: one service account, one hardcoded Sheet, one
`INBOUND_TOKENS` value, images archived to the owner's Drive `/Processed`. Moving to Option
B means:

- Replace the static `INBOUND_TOKENS` with **per-user Google identity** on `/api/inbound`.
- Replace the service-account Drive/Sheets writes with **per-user `drive.file`** writes
  (using the token the app forwards).
- Add **first-run provisioning** + the tiny per-user record.
- The shared `pipeline.ts` (classify → status → row → dedup) is reused as-is.

The legacy single-tenant path (Apps Script + service account + owner's Sheet) can keep
running for the original owner during the transition.
