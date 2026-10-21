// PL-0 adversarial review (2026-10-21): the Render blueprint must not pin a value the owner is told to change in the
// Render dashboard. Render documents that a Blueprint sync — every push that modifies render.yaml, by default —
// overwrites dashboard edits of any variable the Blueprint defines («if any such changes conflict with
// Blueprint-defined configuration, the next Blueprint sync overwrites them»; values the Blueprint does not define are
// kept). The restore procedure switches the server to the restored copy by setting MEDLEVO_DATA_DIR in the dashboard:
// with MEDLEVO_DATA_DIR pinned in render.yaml, the next release touching render.yaml silently moved the server BACK
// to the old, pre-restore directory, hiding everything written since the restore. The defaults therefore live in the
// image (Dockerfile ENV) and in config.ts, and render.yaml only holds what the owner never edits.
// Static checks of the committed files; Render itself was not run (no account).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** `- key: NAME` entries of render.yaml with the kind of value each one has */
function blueprintEnv(yaml: string): Map<string, 'value' | 'generateValue' | 'sync:false' | 'other'> {
  const out = new Map<string, 'value' | 'generateValue' | 'sync:false' | 'other'>();
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*- key:\s*([A-Z0-9_]+)\s*$/.exec(lines[i]!);
    if (!m) continue;
    let kind: 'value' | 'generateValue' | 'sync:false' | 'other' = 'other';
    for (let j = i + 1; j < lines.length && !/^\s*- /.test(lines[j]!); j++) {
      const l = lines[j]!.trim();
      if (l.startsWith('value:')) kind = 'value';
      else if (l.startsWith('generateValue:')) kind = 'generateValue';
      else if (/^sync:\s*false/.test(l)) kind = 'sync:false';
    }
    out.set(m[1]!, kind);
  }
  return out;
}

/** variables the guides tell the owner to set or change in Render → Environment */
const OWNER_SET_IN_DASHBOARD = [
  'MEDLEVO_DATA_DIR', // restore: switch to the restored directory
  'MEDLEVO_ORIGIN', // a custom domain
  'MEDLEVO_TIMEZONE',
  'MEDLEVO_BACKUP_SCHEDULE', // «every other day / weekly / off»
  'MEDLEVO_BACKUP_KEEP_DAILY',
  'MEDLEVO_BACKUP_KEEP_WEEKLY',
  'MEDLEVO_BACKUP_KEEP_LOCAL',
];

describe('render.yaml never fights the owner’s dashboard settings', () => {
  const env = blueprintEnv(read('render.yaml'));

  it('pins no value of a variable the owner sets in the dashboard (a Blueprint sync would overwrite it)', () => {
    expect(env.size).toBeGreaterThan(5); // the parser sees the blueprint
    for (const k of OWNER_SET_IN_DASHBOARD) expect(env.get(k), `${k} must not be pinned in render.yaml`).toBeUndefined();
  });

  it('the secrets are prompted (sync: false) or generated once (generateValue), never written in the file', () => {
    for (const k of ['MEDLEVO_R2_ACCOUNT_ID', 'MEDLEVO_R2_ACCESS_KEY_ID', 'MEDLEVO_R2_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY']) expect(env.get(k)).toBe('sync:false');
    for (const k of ['MEDLEVO_SETUP_TOKEN', 'MEDLEVO_BACKUP_ENCRYPTION_KEY']) expect(env.get(k)).toBe('generateValue');
  });

  it('the image supplies the defaults instead: data on the disk, Baghdad time; the origin falls back to RENDER_EXTERNAL_URL', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/MEDLEVO_DATA_DIR=\/var\/data\/medlevo\b/);
    expect(dockerfile).toMatch(/MEDLEVO_TIMEZONE=Asia\/Baghdad\b/);
    expect(read('render.yaml')).toMatch(/mountPath:\s*\/var\/data\s*$/m);
    // what the service sees on Render with nothing set in the dashboard
    const c = loadConfig({ NODE_ENV: 'production', MEDLEVO_DATA_DIR: '/var/data/medlevo', MEDLEVO_TIMEZONE: 'Asia/Baghdad', RENDER_EXTERNAL_URL: 'https://medlevo.onrender.com' });
    expect(c.origin).toBe('https://medlevo.onrender.com');
    expect(c.cookieSecure).toBe(true);
    expect(c.offsite.schedule).toEqual({ hour: 3, minute: 15 });
    expect([c.offsite.keepDaily, c.offsite.keepWeekly, c.offsite.keepLocal]).toEqual([7, 4, 1]);
  });
});
