// Release R1-b final verification — the maintenance page's forms must work in a REAL browser.
//
// Found by the release critic pass (Chromium, phone and desktop): the owner typed the current password on
// /api/maintenance, ticked «نعم، ابدأ» and pressed «ابدأ الترقية» — and the page answered «رُفض الطلب لأنه صادر من أصل
// غير مسموح.» (403). Nothing could be started from the page. The page was served with `Referrer-Policy: no-referrer`,
// and under that policy a browser sends `Origin: null` with a form POST (Fetch, «append a request `Origin` header»:
// a non-GET request whose referrer policy is no-referrer gets the serialized origin `null`), which the origin check
// refuses. The server tests only ever posted with a hand-written `Origin`, so they could not see it.
// The page now uses `same-origin`: a same-origin form POST carries the page's own origin, a cross-site one still gets
// `null` and is refused, and no referrer ever leaves for another site.
// The same critic run (390 px) found the «blocked» page's reason cut off at the screen edge: the variable name
// «(MEDLEVO_OWNER_MIGRATION=rollback)» is one unbreakable word wider than a phone; the page now wraps long words.
// It also measured the «نعم، ابدأ» checkbox at 14×24 px on the phone: the two-line label squeezed it (flex item).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { openDb } from '../../src/db/db';
import { migrate } from '../../src/db/migrate';
import { hashSecret } from '../../src/modules/auth/password';
import { planBoot, startMaintenance } from '../../src/system/maintenance';
import { TEST_ORIGIN } from '../helpers/app';

const USER = 'owner_form';
const PASSWORD = 'maintenance-form-pass-1';
let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'medlevo-maint-form-'));
});
afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

async function legacyDir(): Promise<string> {
  const dir = join(work, `d-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const db = openDb(join(dir, 'medlevo.sqlite'));
  try {
    migrate(db);
    const t = Date.now();
    db.run(`INSERT INTO owner (id, username, password_hash, recovery_codes_json, password_changed_at, created_at, updated_at) VALUES ('owner', ?, ?, '[]', ?, ?, ?)`, [USER, await hashSecret(PASSWORD, 12), t, t, t]);
  } finally {
    db.close();
  }
  return dir;
}

async function maintenance(dir: string) {
  const config = loadConfig({ NODE_ENV: 'test', MEDLEVO_DATA_DIR: dir, MEDLEVO_ORIGIN: TEST_ORIGIN, MEDLEVO_LOG_LEVEL: 'silent', MEDLEVO_SCRYPT_LOG_N: '12' });
  const plan = planBoot(config);
  if (plan.kind !== 'maintenance') throw new Error(`expected maintenance, got ${plan.kind}`);
  return startMaintenance({ config, plan, migration: { verifyBoot: false } });
}

describe('R1-b final: the maintenance page forms work in a real browser', () => {
  it('the page is not served with Referrer-Policy no-referrer (a browser would post its forms with Origin: null)', async () => {
    const m = await maintenance(await legacyDir());
    try {
      for (const url of ['/api/maintenance', '/']) {
        const page = await m.app.inject({ method: 'GET', url });
        expect(page.body).toContain('<form method="post"');
        const policy = String(page.headers['referrer-policy'] ?? '');
        // policies under which a same-origin POST keeps its Origin and nothing leaks to another site
        expect(['same-origin', 'strict-origin', 'strict-origin-when-cross-origin']).toContain(policy);
      }
    } finally {
      await m.close();
    }
  });

  it('what a browser then sends — the page’s own Origin and Sec-Fetch-Site same-origin — starts the migration; Origin null stays refused', async () => {
    const dir = await legacyDir();
    const m = await maintenance(dir);
    try {
      const body = new URLSearchParams({ username: USER, password: PASSWORD, confirm: 'yes' }).toString();
      const nul = await m.app.inject({ method: 'POST', url: '/api/maintenance/start', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', 'sec-fetch-site': 'cross-site' }, payload: body });
      expect(nul.statusCode).toBe(403);
      const start = await m.app.inject({ method: 'POST', url: '/api/maintenance/start', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TEST_ORIGIN, 'sec-fetch-site': 'same-origin' }, payload: body });
      expect(start.statusCode, start.body).toBe(303);
      await m.finished;
      expect(m.status().phase).toBe('done');
    } finally {
      await m.close();
    }
  });

  it('long unbreakable words (variable names, file names) wrap on a phone instead of running off the screen', async () => {
    const m = await maintenance(await legacyDir());
    try {
      const page = await m.app.inject({ method: 'GET', url: '/api/maintenance' });
      const css = /<style>([\s\S]*?)<\/style>/.exec(page.body)?.[1] ?? '';
      expect(css).toMatch(/(^|[\s;{])main\s*\{[^}]*overflow-wrap:\s*anywhere/);
    } finally {
      await m.close();
    }
  });

  it('the «نعم، ابدأ» checkbox keeps its 24 px box beside a two-line label on a phone (it was squeezed to 14 px)', async () => {
    const m = await maintenance(await legacyDir());
    try {
      const page = await m.app.inject({ method: 'GET', url: '/api/maintenance' });
      const css = /<style>([\s\S]*?)<\/style>/.exec(page.body)?.[1] ?? '';
      // the label is a flex row: without `flex: none` the box shrinks when the words need two lines
      expect(css).toMatch(/input\[type=checkbox\]\s*\{[^}]*flex:\s*none/);
    } finally {
      await m.close();
    }
  });
});
