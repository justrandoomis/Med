// GATE-1 (X8, BUILD_PLAN §1.3 release rule): release R1-c ships base migrations 0163 / 0860, so it must not move an
// R1-a owner's database itself (ADR-0003 §5: the release that performs the move adds no base migration). Run end to end
// against the REAL R1-a release (git d0c8ab4, scratch `gate1/mig`), R1-c's maintenance page refused «ابدأ الترقية»
// with «قاعدة البيانات أقدم من الإصدار R1-a … ثبّت R1-a وشغّله مرة واحدة أولًا» — wrong (the database IS R1-a) and a loop
// (running R1-a again changes nothing). The unit suites never saw it: their «R1-a» fixture is written by THIS build, so
// it already holds 0163 / 0860. The owner is now told the way that works: the multi-user release R1-b first.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { openDb } from '../../src/db/db';
import { readMigrations } from '../../src/db/migrate';
import { detectDataDir } from '../../src/system/layout';
import { dataDirPaths, planOwnerMigration, R1A_BASE_MIGRATIONS, runOwnerMigration } from '../../src/system/ownerMigration';
import { TEST_ORIGIN } from '../helpers/app';
import { buildLegacyFixture, copyLegacy, type LegacyFixture } from './legacy-fixture';

let fx: LegacyFixture;
let work: string;
let n = 0;
const fresh = () => copyLegacy(fx, join(work, `case-${++n}`));
const configFor = (dir: string) => loadConfig({ NODE_ENV: 'test', MEDLEVO_DATA_DIR: dir, MEDLEVO_ORIGIN: TEST_ORIGIN, MEDLEVO_LOG_LEVEL: 'silent', MEDLEVO_SCRYPT_LOG_N: '12' });

/** make the fixture database exactly what R1-a wrote: its base migrations only (the rows R1-c added go) */
function asR1a(dir: string, alsoDrop: string[] = []): void {
  const db = openDb(join(dir, 'medlevo.sqlite'));
  try {
    const later = db.all<{ name: string }>('SELECT name FROM schema_migration').map((r) => r.name).filter((m) => !R1A_BASE_MIGRATIONS.includes(m));
    for (const m of [...later, ...alsoDrop]) db.run('DELETE FROM schema_migration WHERE name = ?', [m]);
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'medlevo-owner-migration-gate1-'));
  fx = await buildLegacyFixture(work);
}, 300_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('GATE-1: an R1-a database reaching a release that adds base migrations', () => {
  it('R1-a’s base migrations are frozen, all still shipped; R1-c adds exactly 0163 and 0860 after them', () => {
    const shipped = readMigrations().map((m) => m.name);
    expect(R1A_BASE_MIGRATIONS).toHaveLength(44);
    expect(R1A_BASE_MIGRATIONS.every((m) => shipped.includes(m))).toBe(true);
    expect(shipped.filter((m) => !R1A_BASE_MIGRATIONS.includes(m))).toEqual(['0163_pinned_region.sql', '0860_document_copy.sql']);
  });

  it('the plan names the way that works (the multi-user release R1-b first), never «older than R1-a»', () => {
    const dir = fresh();
    asR1a(dir);
    const report = planOwnerMigration(configFor(dir));
    const text = report.problems_ar.join(' ');
    expect(text).not.toContain('أقدم من الإصدار R1-a');
    expect(text).toContain('R1-b');
    expect(text).toContain('0163_pinned_region');
  });

  it('«ابدأ الترقية» is refused with that reason and nothing changes', async () => {
    const dir = fresh();
    asR1a(dir);
    await expect(runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false })).rejects.toMatchObject({ code: 'MULTI_USER_RELEASE_FIRST' });
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('legacy_single_owner');
    expect(existsSync(join(dir, 'system.sqlite'))).toBe(false);
  });

  it('a database that lacks one of R1-a’s own migrations is still «older than R1-a»', async () => {
    const dir = fresh();
    asR1a(dir, ['0861_attribution.sql']);
    expect(planOwnerMigration(configFor(dir)).problems_ar.join(' ')).toContain('أقدم من الإصدار R1-a');
    await expect(runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false })).rejects.toMatchObject({ code: 'DB_OLDER_THAN_R1A' });
  });
});
