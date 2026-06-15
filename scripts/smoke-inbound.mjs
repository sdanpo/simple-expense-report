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

if (!URL) fail('Missing --url (or SMOKE_URL). Example: --url https://your-app.vercel.app');
if (!TOKEN) fail('Missing --token (or SMOKE_TOKEN). Must match a backend INBOUND_TOKENS value.');

let failures = 0;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// A 1x1 PNG (valid image, but Gemini will classify it "not a receipt"): used to
// exercise the supported-but-not-a-receipt path without needing a real photo.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

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

  // 1. Auth: missing token -> 401
  try {
    const r = await postInbound({ token: '', bytes: TINY_PNG, fileName: 'noauth.png', mime: 'image/png' });
    record('inbound rejects missing token (401)', r.status === 401, `got ${r.status}`);
  } catch (e) { record('inbound rejects missing token (401)', false, e.message); }

  // 2. Unsupported type -> 200 ignored_unsupported_type (terminal, not an error)
  try {
    const r = await postInbound({ token: TOKEN, bytes: TINY_PNG, fileName: 'x.heic', mime: 'image/heic' });
    record('inbound ignores unsupported type (200 terminal)',
      r.status === 200 && String(r.body.status).startsWith('ignored'),
      `${r.status} ${r.body.status}`);
  } catch (e) { record('inbound ignores unsupported type', false, e.message); }

  // 3a. Supported image, valid token. With the tiny PNG, expect not_a_receipt;
  //     with a real --image, expect approved/needs_review (or duplicate on re-run).
  try {
    const bytes = IMAGE ? readFileSync(IMAGE) : TINY_PNG;
    const fileName = IMAGE ? basename(IMAGE) : 'tiny.png';
    const mime = IMAGE ? guessMime(IMAGE) : 'image/png';
    const r = await postInbound({ token: TOKEN, bytes, fileName, mime });
    const ok = r.status === 200;
    record('inbound accepts a supported upload (200)', ok, `${r.status} ${r.body.status}`);
    if (IMAGE) {
      const good = ['approved', 'needs_review', 'duplicate'].includes(r.body.status);
      record('  real receipt classified as a receipt', good,
        good ? (r.body.summary || r.body.status) : `unexpected status ${r.body.status}`);
    }
  } catch (e) { record('inbound accepts a supported upload', false, e.message); }

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
