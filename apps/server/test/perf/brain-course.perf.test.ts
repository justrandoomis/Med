// PERFORMANCE (MEDLEVO_PERF=1): the Course Brain on a LARGE synthetic course — 30 TEST lectures × 20 pages, each page a
// heading, six definitions and a list item, every lecture using the previous ones' terms (≈4,800 concepts, ≈3,500
// inferred relations). Round 7 H4: the extraction job no longer recomputes the course's relations inline — a background
// job (`brain.recompute_relations`) does, reading through per-lecture caches and a token n-gram prefilter and yielding
// the event loop every ~20 ms. Measured here: extraction alone, a COLD recompute (no cache), a warm one, an INCREMENTAL
// one after one lecture changed (with the longest synchronous slice), and that the incremental result equals a cold one.
// Budgets are generous wall-clock limits for this machine class; the measured numbers are written to the results file.
import { describe, expect, it } from 'vitest';
import { runRelationRecompute } from '../../src/modules/brain/course';
import { clearRecomputeCaches, recomputeInferredRelations, recomputeInferredRelationsAsync } from '../../src/modules/brain/relations';
import { runKnowledgeExtraction } from '../../src/modules/brain/run';
import { courseKey, studySource } from '../../src/modules/brain/store';
import { brainApp, call, createCourse, insertLecture, type RegionSpec } from '../brain/helpers';
import { PERF_ENABLED } from './fixtures';
import { report } from './measure';

const LECTURES = Number(process.env.MEDLEVO_PERF_BRAIN_LECTURES || 30);
const PAGES = 20;

describe.skipIf(!PERF_ENABLED)('Course Brain on a large course', () => {
  it('extraction, relation recompute and the course views stay within budget; a recompute is idempotent', async () => {
    const t = await brainApp();
    try {
      const course = (await createCourse(t, 'Perf course (TEST)')).id;
      const lectures = [];
      for (let i = 0; i < LECTURES; i++) {
        const pages: RegionSpec[][] = [];
        for (let p = 0; p < PAGES; p++) {
          const regs: RegionSpec[] = [{ kind: 'heading', text: p === 0 ? `Topic${i} entity — كيان${i}` : `Section ${i}-${p} entity${i}x${p}` }];
          for (let k = 0; k < 6; k++) regs.push({ kind: 'paragraph', text: `Term${i}x${p}x${k} is defined as a TEST item related to Term${Math.max(0, i - 1)}x${p}x${k} and Topic${Math.max(0, i - 2)} entity.` });
          regs.push({ kind: 'list_item', text: `• Finding${i}x${p}` });
          pages.push(regs);
        }
        lectures.push(insertLecture(t, course, `Perf lecture ${i} (TEST)`, pages, { sortOrder: i }));
      }
      const extraction: number[] = [];
      for (const l of lectures) {
        const t0 = performance.now();
        runKnowledgeExtraction(t.ctx, l.versionId);
        extraction.push(performance.now() - t0);
      }
      const snapshot = () => t.ctx.db.all('SELECT from_concept_id, to_concept_id, relation, status, support, reasons_json FROM concept_relation ORDER BY from_concept_id, to_concept_id, relation');
      const key = courseKey(studySource(t.ctx, lectures[0]!.sourceId));
      // the background job body, from scratch (no cache): what the server does once after the 30 extraction jobs
      clearRecomputeCaches(t.ctx);
      const coldSlices: number[] = [];
      let t0 = performance.now();
      await recomputeInferredRelationsAsync(t.ctx, key, { onSlice: (ms) => coldSlices.push(ms) });
      const coldMs = performance.now() - t0;
      // the job body now finds this state computed? (it saves the state; a second call is a no-op)
      await runRelationRecompute(t.ctx, key);
      const before = snapshot();
      // warm (nothing changed): idempotent
      t0 = performance.now();
      recomputeInferredRelations(t.ctx, key);
      const warmMs = performance.now() - t0;
      expect(snapshot()).toEqual(before);
      // incremental: lecture 15 changes (a re-processed page) and is re-extracted; the job recomputes with the caches
      const changed = lectures[15]!;
      t.ctx.db.run('UPDATE source_region SET text = ? WHERE id = ?', ['Term15x0x0 is defined as a TEST item related to Term3x0x0 only.', changed.regionIds[0]![1]]);
      const e0 = performance.now();
      runKnowledgeExtraction(t.ctx, changed.versionId);
      const reExtractMs = performance.now() - e0;
      const slices: number[] = [];
      t0 = performance.now();
      await recomputeInferredRelationsAsync(t.ctx, key, { onSlice: (ms) => slices.push(ms) });
      const incrementalMs = performance.now() - t0;
      const incremental = snapshot();
      clearRecomputeCaches(t.ctx);
      t0 = performance.now();
      recomputeInferredRelations(t.ctx, key);
      const coldAfterMs = performance.now() - t0;
      expect(snapshot()).toEqual(incremental);
      const recomputeMs = coldMs;
      const views: Record<string, number> = {};
      for (const [name, url] of [
        ['course', `/api/brain/courses/${course}`],
        ['map', `/api/brain/map?course_node_id=${course}`],
        ['coverage', `/api/brain/coverage?course_node_id=${course}`],
        ['knowledge', `/api/brain/knowledge?course_node_id=${course}`],
        ['concepts', `/api/brain/concepts?course_node_id=${course}`],
      ] as const) {
        const s = performance.now();
        expect((await call(t).get(url)).statusCode).toBe(200);
        views[name] = Math.round(performance.now() - s);
      }
      const results = {
        lectures: LECTURES,
        pages_per_lecture: PAGES,
        relations: before.length,
        extraction_ms: { first: Math.round(extraction[0]!), last: Math.round(extraction[extraction.length - 1]!), max: Math.round(Math.max(...extraction)) },
        recompute_ms: Math.round(recomputeMs),
        recompute_cold_ms: Math.round(coldMs),
        recompute_cold_longest_slice_ms: Math.round(Math.max(...coldSlices)),
        recompute_warm_ms: Math.round(warmMs),
        re_extract_one_lecture_ms: Math.round(reExtractMs),
        recompute_incremental_ms: Math.round(incrementalMs),
        recompute_incremental_slices: slices.length,
        recompute_incremental_longest_slice_ms: Math.round(Math.max(...slices)),
        recompute_cold_after_change_ms: Math.round(coldAfterMs),
        views_ms: views,
      };
      report('brain-course', results);
      expect(Math.max(...extraction)).toBeLessThan(5_000);
      expect(recomputeMs).toBeLessThan(4_000);
      // the course page never recomputes inside the request (it enqueues the background job)
      expect(views.course!).toBeLessThan(4_000);
      // the FIRST map request (cold V8 regexp cache) compiles no regex per concept (~1.5 s before, see map-cold.h4.test.ts)
      expect(views.map!).toBeLessThan(1_000);
      // the async recompute gives the event loop back: no synchronous slice near the old whole-recompute block
      expect(Math.max(...slices)).toBeLessThan(500);
    } finally {
      await t.close();
    }
  }, 1_200_000);
});
