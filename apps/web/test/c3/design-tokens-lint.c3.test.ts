// @vitest-environment node
// AOS-20.1 (track C3): «New screens use only design-system tokens» — a LINT rule (`medlevo-css/token-colors`,
// tools/eslint/design-tokens.mjs, enabled in eslint.config.js for every stylesheet of apps/web/src). It found one
// hand-written colour on a new screen (the QR card's white in channels.css), now the token `--ml-color-scan-paper`.
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../..');
const eslint = new ESLint({ cwd: ROOT });
const lint = async (css: string, file = 'apps/web/src/features/new-screen/new-screen.css') => (await eslint.lintText(css, { filePath: join(ROOT, file) }))[0]!.messages;

describe('medlevo-css/token-colors', () => {
  it('a new stylesheet with a hand-written colour fails the lint: hex, colour functions, named colours', async () => {
    const msgs = await lint(`.x { color: #1c2230; }
.y { background: rgba(0, 0, 0, 0.2); }
.z { border: 1px solid white; }
.w { box-shadow: 0 1px 2px hsl(220 10% 20%); }
.v { --local-mark: #7e8ae8; }`);
    expect(msgs.map((m) => m.ruleId)).toEqual(Array(5).fill('medlevo-css/token-colors'));
    expect(msgs.map((m) => m.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it('tokens and colourless keywords pass; comments, strings and non-colour words are not colours', async () => {
    const msgs = await lint(`/* light #FFFDF8 on dark #1D1C1A */
.a { color: var(--ml-color-ink); background: var(--ml-color-paper); border-color: currentColor; outline: 2px solid transparent; }
.b { white-space: nowrap; font-family: "Gold Sans", var(--ml-font-latin); grid-template-areas: "red blue"; }
.c { background: color-mix(in srgb, var(--ml-color-accent) 20%, transparent); }`);
    expect(msgs).toEqual([]);
  });

  it('every stylesheet of the web app passes (a NEW file is covered by default; only the token file and frozen pre-AOS files are exempt)', async () => {
    const results = await eslint.lintFiles(['apps/web/src/**/*.css']);
    const problems = results.flatMap((r) => r.messages.map((m) => `${r.filePath.replace(ROOT, '')}:${m.line} ${m.message}`));
    expect(problems).toEqual([]);
    expect(results.length).toBeGreaterThan(20);
    const covered = await eslint.calculateConfigForFile(join(ROOT, 'apps/web/src/features/any-future-screen/screen.css'));
    expect(covered.rules['medlevo-css/token-colors'][0]).toBe(2); // (review R3: with the frozen baseline as its option)
    for (const aos of ['features/channels/channels.css', 'features/me/me.css', 'features/notifications/notifications.css', 'features/lectures/publications.css', 'features/copies/copies.css', 'features/admin/admin.css', 'app/shell.css']) {
      expect(await eslint.isPathIgnored(join(ROOT, 'apps/web/src', aos)), aos).toBe(false);
    }
  });
});
