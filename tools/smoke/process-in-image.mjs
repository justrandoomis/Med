#!/usr/bin/env node
// Processing smoke test against a RUNNING MedLevo (the production Docker image in CI, docker job): signs in, uploads
// real fixture lectures (a mixed text/figure lecture and an image-heavy atlas — the pathology-slide case), waits for
// processing and prints what happened as GitHub annotations (readable on the run page without signing in).
// Exit 1 when a fixture's processing ends «failed», so a broken tool in the image (poppler, OCR models, LibreOffice,
// fonts, permissions) fails the image job instead of a user's upload.
//   node tools/smoke/process-in-image.mjs http://127.0.0.1:10000 <username> <password>
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [base, username, password] = process.argv.slice(2);
if (!base || !username || !password) {
  console.error('usage: process-in-image.mjs <base url> <username> <password>');
  process.exit(2);
}
const FIXTURES = ['fixtures/acceptance/g1_mixed_lecture.pdf', 'fixtures/acceptance/g3_image_atlas.pdf'];
const HEADERS = { 'x-medlevo-csrf': '1', 'x-medlevo-client': '0.1.0', origin: base };
let cookie = '';
const note = (level, msg) => console.log(`::${level}::${msg.replace(/\r?\n/g, ' ')}`);

async function call(method, path, body, extra = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...HEADERS, ...(cookie ? { cookie } : {}), ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...extra },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
await call('POST', '/api/auth/login', { username, password });
const { node: shelf } = await call('POST', '/api/library/nodes', { parent_id: null, kind: 'notebook', title: 'CI smoke', cover: { style: 'linen', color: 'rose', symbol: 'book' } });
const { node: course } = await call('POST', '/api/library/nodes', { parent_id: shelf.id, kind: 'course', title: 'Pathology (CI)' });
for (const f of FIXTURES) {
  const form = new FormData();
  form.set('node_id', course.id);
  form.set('source_type', 'lecture');
  form.set('files', new Blob([readFileSync(join(process.cwd(), f))], { type: 'application/pdf' }), basename(f));
  const up = (await call('POST', '/api/sources/upload', form)).results[0];
  if (up?.status !== 'accepted') {
    failed++;
    note('error', `${basename(f)}: upload refused ${JSON.stringify(up)}`);
    continue;
  }
  const t0 = Date.now();
  let st = null;
  for (;;) {
    st = await call('GET', `/api/sources/versions/${up.version_id}/processing`);
    const s = st.job?.status;
    if (s && ['completed', 'partial', 'failed', 'cancelled', 'waiting_for_input'].includes(s)) break;
    if (Date.now() - t0 > 600_000) break;
    await sleep(2000);
  }
  const s = st.job?.status ?? 'unknown';
  const secs = Math.round((Date.now() - t0) / 1000);
  const detail = JSON.stringify({ job: st.job && { status: st.job.status, error: st.job.error ?? st.job.error_ar ?? null, stage: st.job.stage ?? null }, summary: st.summary }).slice(0, 3500);
  if (s === 'failed' || s === 'unknown' || s === 'cancelled') {
    failed++;
    note('error', `${basename(f)}: processing ${s} after ${secs}s — ${detail}`);
  } else note('notice', `${basename(f)}: processing ${s} after ${secs}s — ${detail}`);
}
process.exit(failed ? 1 : 0);
