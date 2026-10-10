// G2 / AC-07 — a retrieved paragraph with SIMILAR WORDS that does not prove the sentence never makes the answer pass
// the support check («topic similarity is not support»). Real pipeline on the Golden Set; the verifier is the
// TEST-ONLY scripted provider — the deterministic checks are real.
// Adversarial angles beyond the module tests: the reference's «Ultrasound is the first-line investigation for
// suspected gallstones» vs the lecture's «Ultrasound is the first-line imaging test in children…» (near-identical
// wording, different claim), the same in Arabic, a near-verbatim «directly stated» copy with one key word swapped,
// a claim that cites the supporting excerpt AND a merely similar one (the similar one must not be shown as support),
// a verifier that is unavailable / says «supported» for a claim whose deterministic checks failed / answers twice.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatPostResponse, ClaimView, StudyArtifactView } from '@medlevo/shared';
import type { ProviderRequest } from '../../src/modules/ai/types';
import { linkReference } from '../evidence/helpers';
import { aliasFor, claimsInPrompt, content, S, ScriptedAi, studyLibrary, type StudyLib } from '../studybook/helpers';

const ai = new ScriptedAi();
let lib: StudyLib;

beforeAll(async () => {
  lib = await studyLibrary(ai);
  linkReference(lib.t, lib.lecture.sourceId, lib.reference.sourceId);
}, 180_000);
afterAll(async () => {
  await lib?.t.close();
});
afterEach(() => {
  ai.verdict = () => 'supported';
  if (ai.errors.length) throw new Error(`scripted generator failed: ${ai.errors.splice(0).map(String).join(' | ')}`);
});

const wide = () => ({ mode: 'lecture_plus_references' as const, lecture_source_id: lib.lecture.sourceId, reference_source_ids: [lib.reference.sourceId] });
/** an unanchored question whose words are in BOTH the lecture and the reference: both excerpts are in the pack */
async function explain(gen: (req: ProviderRequest) => unknown): Promise<StudyArtifactView> {
  const th = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/threads', headers: lib.h, payload: { scope: wide(), anchor: null, style: 'detailed' } });
  expect(th.statusCode, th.body).toBe(200);
  ai.once('chat', gen);
  const res = await lib.t.app.inject({ method: 'POST', url: `/api/studybook/threads/${th.json().thread.id}/messages`, headers: lib.h, payload: { text: 'Ultrasound first-line' } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as ChatPostResponse).answer.artifact!;
}
const claimWith = (a: StudyArtifactView, needle: string): ClaimView | undefined => Object.values(a.claims).find((c) => c.text.includes(needle));
const removedWith = (a: StudyArtifactView, needle: string) => a.removed.find((r) => r.text.includes(needle));
const GALL = 'Ultrasound is the first-line investigation for suspected gallstones';
const KIDS = 'Ultrasound is the first-line imaging test in children';

describe('G2 AC-07 — similar words are not support', () => {
  it('a «directly stated» copy with the key noun swapped: the 80 % containment pre-check lets it through, the independent verifier rejects it (EN)', async () => {
    // documented limit: «Ultrasound is the first-line investigation for suspected appendicitis» shares 5 of 6 content
    // words with the gallstones sentence, so the deterministic containment check alone does not catch the swap
    ai.verdict = (t) => (/appendicitis/.test(t) ? 'not_supported' : 'supported');
    const a = await explain((req) =>
      content([
        { kind: 'paragraph', sentences: [S.c(`${KIDS} and in pregnant women.`, [aliasFor(req, KIDS)], 'directly_stated')] },
        { kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line investigation for suspected appendicitis.', [aliasFor(req, 'suspected gallstones')], 'directly_stated')] },
      ]),
    );
    expect(claimWith(a, 'pregnant women')?.verification_status).toBe('linked');
    expect(claimWith(a, 'suspected appendicitis')).toBeUndefined();
    expect(removedWith(a, 'suspected appendicitis')!.reason_ar).toMatch(/التشابه في الموضوع ليس دعمًا/);
  });

  it('a «directly stated» sentence that shares only some words with the excerpt fails containment before any verifier', async () => {
    const before = ai.callsFor('verify_support').length;
    const a = await explain((req) => content([{ kind: 'paragraph', sentences: [S.c('Ultrasound reliably excludes appendicitis in pregnant adults with fever.', [aliasFor(req, 'suspected gallstones')], 'directly_stated')] }]));
    expect(removedWith(a, 'reliably excludes')!.reason_ar).toMatch(/مذكور نصًا/);
    const asked = ai.callsFor('verify_support').slice(before).map((c) => c.prompt).join('\n');
    expect(asked).not.toContain('reliably excludes');
  });

  it('a paraphrase that is only on the same topic reaches the independent verifier, which rejects it (never linked)', async () => {
    ai.verdict = (t) => (/appendicitis/.test(t) ? 'not_supported' : 'supported');
    const a = await explain((req) => content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is how suspected appendicitis is investigated first.', [aliasFor(req, 'suspected gallstones')], 'derived')] }]));
    expect(a.abstain?.reason).toBe('insufficient_evidence');
    expect(removedWith(a, 'appendicitis')!.reason_ar).toMatch(/التشابه في الموضوع ليس دعمًا/);
    expect(Object.keys(a.claims)).toHaveLength(0);
  });

  it('CT ≠ Ultrasound, adults ≠ children, a changed threshold: rejected deterministically even if a verifier would say «supported»', async () => {
    ai.verdict = () => 'supported'; // a careless verifier
    const a = await explain((req) =>
      content([
        {
          kind: 'paragraph',
          sentences: [
            S.c('CT abdomen is the first-line imaging test in children.', [aliasFor(req, KIDS)], 'derived'),
            S.c('Ultrasound is the first-line imaging test in adults.', [aliasFor(req, KIDS)], 'derived'),
            S.c('A white cell count above 12 ×10⁹/L supports the diagnosis.', [aliasFor(req, KIDS)], 'derived'),
            S.c(`${KIDS} and in pregnant women.`, [aliasFor(req, KIDS)], 'directly_stated'),
          ],
        },
      ]),
    );
    expect(Object.values(a.claims).map((c) => c.text)).toEqual([`${KIDS} and in pregnant women.`]);
    expect(a.removed.map((r) => r.text).sort()).toEqual(
      ['CT abdomen is the first-line imaging test in children.', 'Ultrasound is the first-line imaging test in adults.', 'A white cell count above 12 ×10⁹/L supports the diagnosis.'].sort(),
    );
  });

  it('Arabic: a near-verbatim copy of the reference sentence about gallstones, re-aimed at appendicitis, is never linked', async () => {
    ai.verdict = (t) => (/الزائدة/.test(t) ? 'not_supported' : 'supported');
    const a = await explain((req) =>
      content([{ kind: 'paragraph', sentences: [S.c('يُعد التصوير بالأمواج فوق الصوتية الفحص الأولي عند الشك بالتهاب الزائدة.', [aliasFor(req, 'حصى المرارة')], 'directly_stated')] }]),
    );
    expect(claimWith(a, 'الزائدة')).toBeUndefined();
    expect(removedWith(a, 'الزائدة')).toBeTruthy();
  });

  it('without an independent verifier the same sentence is «needs review» — never «linked», never silently supported', async () => {
    ai.always('verify_support', () => new Error('verifier down'));
    try {
      const a = await explain((req) => content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is how suspected appendicitis is investigated first.', [aliasFor(req, 'suspected gallstones')], 'derived')] }]));
      const c = claimWith(a, 'appendicitis')!;
      expect(c.verification_status).toBe('needs_review');
      expect(c.issues.map((i) => i.reason_ar).join(' ')).toMatch(/تعذّر إجراء التحقق المستقل/);
    } finally {
      // restore the default parsing verifier
      (ai as unknown as { permanent: Map<string, unknown> }).permanent.delete('verify_support');
    }
  });

  it('a verifier that answers the same claim twice (supported AND not_supported) does not get it linked', async () => {
    ai.once('verify_support', (req) => ({ results: claimsInPrompt(req.prompt).flatMap((c) => [{ index: c.index, verdict: 'supported', reason: 'x' }, { index: c.index, verdict: 'not_supported', reason: 'y' }]) }));
    const a = await explain((req) => content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is how suspected appendicitis is investigated first.', [aliasFor(req, 'suspected gallstones')], 'derived')] }]));
    expect(claimWith(a, 'appendicitis')?.verification_status ?? 'removed').not.toBe('linked');
  });

  it('a claim citing the supporting excerpt AND a merely similar one: the similar one is never shown as support', async () => {
    // an honest verifier names the excerpt(s) its verdict rests on
    ai.once('verify_support', (req) => {
      const results = [];
      for (const block of req.prompt.split('<untrusted_content ').slice(1)) {
        const claim = /CLAIM \[(\d+)\]: ([^\n]*)/.exec(block);
        if (!claim) continue;
        const based = [...block.matchAll(/EVIDENCE (E\d+) .*:\n([^\n]*)/g)].filter((m) => m[2]!.includes('in children')).map((m) => m[1]!);
        results.push({ index: Number(claim[1]), verdict: based.length ? 'supported' : 'not_supported', reason: 'سبب الاختبار', based_on: based });
      }
      return { results };
    });
    const a = await explain((req) => content([{ kind: 'paragraph', sentences: [S.c(`${KIDS} and in pregnant women.`, [aliasFor(req, KIDS), aliasFor(req, 'suspected gallstones')], 'synthesized')] }]));
    const c = claimWith(a, 'pregnant women')!;
    expect(c.verification_status).toBe('linked');
    const cited = c.citations.map((x) => x.evidence.quote);
    expect(cited.some((q) => q.includes('in children'))).toBe(true);
    expect(cited.some((q) => q.includes('gallstones'))).toBe(false); // similar words ≠ support
  });
});
