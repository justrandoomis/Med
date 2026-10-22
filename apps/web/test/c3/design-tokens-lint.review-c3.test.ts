// @vitest-environment node
// Adversarial review of track C3, R3 (AOS-20.1 «New screens use only design-system tokens»): the lint rule exempted the
// pre-AOS stylesheets WHOLE — components.css among them, where new AOS rules keep landing (C3 itself added the AI
// allowance line there) — so a hand-written colour in new CSS there passed `npm run lint`. They are frozen now, not
// exempt: each keeps the colours it holds today (tools/eslint/design-tokens.frozen.json) and one more fails.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../..');
const eslint = new ESLint({ cwd: ROOT });
const COMPONENTS = 'apps/web/src/design/components.css';
const lint = async (css: string, file: string) => (await eslint.lintText(css, { filePath: join(ROOT, file) }))[0]!.messages;
const today = (file: string) => readFileSync(join(ROOT, file), 'utf8');

describe('medlevo-css/token-colors on the pre-AOS stylesheets (frozen, not exempt)', () => {
  it('components.css as it is passes; a NEW rule with a hand-written colour appended to it fails', async () => {
    expect(await lint(today(COMPONENTS), COMPONENTS)).toEqual([]);
    const msgs = await lint(`${today(COMPONENTS)}\n.ml-new-aos-thing { color: #1c2230; border: 1px solid red; }\n`, COMPONENTS);
    expect(msgs.map((m) => m.ruleId)).toEqual(['medlevo-css/token-colors', 'medlevo-css/token-colors']);
    expect(msgs[0]!.message).toContain('frozen pre-AOS stylesheet');
  });

  it('one more of a colour the file already holds fails too (the count is frozen, not the value)', async () => {
    const held = JSON.parse(readFileSync(join(ROOT, 'tools/eslint/design-tokens.frozen.json'), 'utf8')) as Record<string, Record<string, number>>;
    expect(held[COMPONENTS]!['#fff']).toBeGreaterThan(0);
    const msgs = await lint(`${today(COMPONENTS)}\n.ml-another { background: #FFF; }\n`, COMPONENTS);
    expect(msgs).toHaveLength(1);
  });

  it('a named colour in a mask, a border image or the -webkit- shadow of a new stylesheet fails too', async () => {
    const msgs = await lint(
      `.a { mask-image: linear-gradient(black, transparent); }
.b { -webkit-mask-image: linear-gradient(to left, black 80%, transparent); }
.c { border-image: linear-gradient(red, blue) 1; }
.d { -webkit-box-shadow: 0 0 2px black; }
.e { backdrop-filter: drop-shadow(0 0 1px white); }`,
      'apps/web/src/features/new-screen/new-screen.css',
    );
    expect(msgs.map((m) => m.line)).toEqual([1, 2, 3, 3, 4, 5]);
  });

  it('only the token file is outside the rule; every frozen stylesheet is linted', async () => {
    const cfg = (await eslint.calculateConfigForFile(join(ROOT, 'apps/web/src/design/tokens.css'))) as { rules?: Record<string, unknown> } | undefined;
    expect(cfg?.rules?.['medlevo-css/token-colors']).toBeUndefined(); // the token file defines the colours
    for (const f of ['design/base.css', 'design/components.css', 'features/library/library.css', 'features/workspace/ink/ink.css', 'features/workspace/workspace.css']) {
      expect(await eslint.isPathIgnored(join(ROOT, 'apps/web/src', f)), f).toBe(false);
      const c = (await eslint.calculateConfigForFile(join(ROOT, 'apps/web/src', f))) as { rules: Record<string, unknown[]> };
      expect(c.rules['medlevo-css/token-colors']?.[0], f).toBe(2);
    }
  });
});
