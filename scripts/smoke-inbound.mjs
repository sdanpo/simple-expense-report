#!/usr/bin/env node
/**
 * Smoke-test the NEW backend endpoints against a deployed (or preview) URL, using
 * real Gemini/Sheets/Gmail — the part the local vitest suite mocks out.
 *
 * Usage:
 *   node scripts/smoke-inbound.mjs --url https://<preview>.vercel.app \
 *        --token <INBOUND_TOKENS value> [--image path/to/receipt.jpg] [--gmail]
 *
 * Env fallbacks: SMOKE_URL, SMOKE_TOKEN, CRON_SECRET.
 *
 * What it checks:
 *   1. /api/inbound rejects a missing token            -> 401
 *   2. /api/inbound rejects a tiny/unsupported upload  -> 200 ignored_* (terminal)
 *   3. /api/inbound with a real receipt image          -> 200 approved/needs_review/duplicate
 *      (re-run is safe: dedup should report "duplicate")
 *   4. (optional, --gmail) /api/cron/ingest-gmail       -> 200 summary  (needs CRON_SECRET)
 *
 * Exit code is non-zero if any assertion fails.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// ---- args ----
const args = parseArgs(process.argv.slice(2));
const URL = (args.url || process.env.SMOKE_URL || '').replace(/\/$/, '');
const TOKEN = args.token || process.env.SMOKE_TOKEN || process.env.CRON_SECRET || '';
const CRON_SECRET = args['cron-secret'] || process.env.CRON_SECRET || TOKEN;
const IMAGE = args.image || '';
const DO_GMAIL = Boolean(args.gmail);
const EXPECT_RECEIPT = Boolean(args['expect-receipt']);

if (!URL) fail('Missing --url (or SMOKE_URL). Example: --url https://your-app.vercel.app');
if (!TOKEN) fail('Missing --token (or SMOKE_TOKEN). Must match a backend INBOUND_TOKENS value.');

let failures = 0;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function postInbound({ token, bytes, fileName, mime }) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), fileName);
  form.append('file_name', fileName);
  form.append('client_dedup_id', `smoke-${fileName}`);
  const headers = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${URL}/api/inbound`, { method: 'POST', body: form, headers });
  let body;
  try { body = await res.json(); } catch { body = {}; }
  return { status: res.status, body };
}

async function run() {
  console.log(`\nSmoke-testing ${URL}\n`);

  // Buffer above the 1 KB floor so structural tests reach the mime/Gemini stages
  // instead of short-circuiting on `ignored_too_small`.
  const PAD_2KB = Buffer.alloc(2048, 1);

  // 1. Auth: missing token -> 401 (auth is checked before anything else)
  try {
    const r = await postInbound({ token: '', bytes: PAD_2KB, fileName: 'noauth.png', mime: 'image/png' });
    record('inbound rejects missing token (401)', r.status === 401, `got ${r.status}`);
  } catch (e) { record('inbound rejects missing token (401)', false, e.message); }

  // 2. Unsupported type -> 200 ignored_unsupported_type (terminal, not an error)
  try {
    const r = await postInbound({ token: TOKEN, bytes: PAD_2KB, fileName: 'x.heic', mime: 'image/heic' });
    record('inbound ignores unsupported type (200 terminal)',
      r.status === 200 && r.body.status === 'ignored_unsupported_type',
      `${r.status} ${r.body.status}`);
  } catch (e) { record('inbound ignores unsupported type', false, e.message); }

  // 3. Supported image -> exercises Gemini + Sheets. Any VALID classification proves
  //    the integration works; pass --expect-receipt to also assert it's a receipt.
  if (IMAGE) {
    try {
      const bytes = readFileSync(IMAGE);
      const r = await postInbound({ token: TOKEN, bytes, fileName: basename(IMAGE), mime: guessMime(IMAGE) });
      const valid = ['approved', 'needs_review', 'duplicate', 'not_a_receipt'].includes(r.body.status);
      record('inbound runs Gemini + Sheets on a real image (200, valid classification)',
        r.status === 200 && valid, `${r.status} ${r.body.status}${r.body.summary ? ` (${r.body.summary})` : ''}`);
      if (EXPECT_RECEIPT) {
        const isReceipt = ['approved', 'needs_review', 'duplicate'].includes(r.body.status);
        record('  classified as a receipt', isReceipt, r.body.status);
      }
    } catch (e) { record('inbound runs Gemini + Sheets', false, e.message); }
  } else {
    console.log('… skipping the Gemini/Sheets check (pass --image path/to/photo.jpg to include it)');
  }

  // 4. Gmail cron (optional)
  if (DO_GMAIL) {
    try {
      const res = await fetch(`${URL}/api/cron/ingest-gmail`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      });
      const body = await res.json().catch(() => ({}));
      record('ingest-gmail runs (200 summary)',
        res.status === 200 && typeof body.scanned === 'number',
        res.status === 200 ? JSON.stringify(body) : `got ${res.status}`);
    } catch (e) { record('ingest-gmail runs', false, e.message); }
  } else {
    console.log('… skipping /api/cron/ingest-gmail (pass --gmail to include it)');
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---- helpers ----
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}
function guessMime(p) {
  const e = p.toLowerCase().split('.').pop();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' }[e]
    || 'application/octet-stream';
}
function fail(msg) { console.error(`Error: ${msg}`); process.exit(2); }

run();
