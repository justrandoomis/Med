// Round 7 H4 (docs/PERFORMANCE.md «Course Brain recompute»): the FIRST knowledge-map request after a restart took
// ~1.5 s on the 30 × 20 course (later ones ~0.2 s). Cause: lectureQuestions() compiled one Unicode regex per concept
// (`(?:^|[^\p{L}\p{N}])(?:name|…)(?:$|[^\p{L}\p{N}])`, flag u) to find concept names in question text — ~4,800 distinct
// patterns at ~0.3 ms each, cached by V8 afterwards. The old inline relation recompute compiled the very same patterns
// and so warmed that cache; once the recompute stopped compiling them (occursAsWord), the map paid the whole cost.
// Fixed by matching with occursAsWord (≡ the regex, tested in h4-extractors.test.ts): no regex per concept.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/lib/ids';
import { lectureQuestions } from '../../src/modules/brain/lecture-questions';
import { studySource } from '../../src/modules/brain/store';
import { brainApp, call, createCourse, insertLecture, type BApp } from './helpers';

let t: BApp;
beforeAll(async () => {
  t = await brainApp();
});
afterAll(async () => t.close());

/** counts `new RegExp(...)` while `fn` runs (regex literals are not counted) */
function countRegExpConstructions<T>(fn: () => T): { value: T; count: number } {
  const Orig = globalThis.RegExp;
  let count = 0;
  globalThis.RegExp = new Proxy(Orig, {
    construct(target, args, newTarget) {
      count++;
      return Reflect.construct(target, args, newTarget) as object;
    },
    apply(target, thisArg, args) {
      count++;
      return Reflect.apply(target, thisArg, args) as RegExp;
    },
  });
  try {
    return { value: fn(), count };
  } finally {
    globalThis.RegExp = Orig;
  }
}

describe('question ↔ concept by name in the question text (lectureQuestions)', () => {
  it('whole-word matches only, Arabic and English; no regex compiled per concept', async () => {
    const course = (await createCourse(t, 'Map cold (TEST)')).id;
    const l = insertLecture(t, course, 'Gout (TEST)', [[{ kind: 'heading', text: 'Gout' }, { kind: 'paragraph', text: 'Gout is defined as a TEST crystal arthropathy.' }]]);
    const q = await call(t).ok<{ question_id: string }>('POST', '/api/questions/quick-add', {
      text: '1. Which crystal is seen in gout — النقرس (TEST)?\nA. Urate\nB. Calcium pyrophosphate\nC. Cystine',
      key_label: 'A',
    });
    const now = t.ctx.clock.now();
    t.ctx.db.run(
      `INSERT OR REPLACE INTO question_lecture_link (id, question_id, lecture_source_id, relation, score, reason, reason_json, origin, status, created_at, updated_at)
       VALUES (?, ?, ?, 'directly_covered', 1, 'TEST', ?, 'owner', 'accepted', ?, ?)`,
      [newId(now), q.question_id, l.sourceId, JSON.stringify({ lecture_page_ids: [l.pageIds[0]] }), now, now],
    );
    const concepts = [
      { id: 'c_gout', names: ['gout'], page_ids: [] },
      { id: 'c_ar', names: ['النقرس'], page_ids: [] },
      { id: 'c_two_words', names: ['calcium pyrophosphate'], page_ids: [] },
      // a name inside a longer word is not a match («urat» ⊂ «urate», «cyst» ⊂ «cystine»)
      { id: 'c_part', names: ['urat', 'cyst'], page_ids: [] },
      { id: 'c_absent', names: ['pseudogout'], page_ids: [] },
      ...Array.from({ length: 300 }, (_, i) => ({ id: `c_filler_${i}`, names: [`filler term ${i}`, `مصطلح${i}`], page_ids: [] })),
    ];
    const { value, count } = countRegExpConstructions(() => lectureQuestions(t.ctx, studySource(t.ctx, l.sourceId), concepts));
    const got = value.find((x) => x.id === q.question_id)!;
    expect(Object.fromEntries(got.concepts)).toEqual({ c_gout: 'text', c_ar: 'text', c_two_words: 'text' });
    expect(count).toBeLessThan(concepts.length);
  });
});
