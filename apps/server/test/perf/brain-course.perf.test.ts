// PERFORMANCE (MEDLEVO_PERF=1): the Course Brain on a LARGE synthetic course — 30 TEST lectures × 20 pages, each page a
// heading, six definitions and a list item, every lecture using the previous ones' terms (≈4,800 concepts, ≈3,500
// inferred relations). The extraction job runs in-process, so its course-level relation recompute blocks the server
// while it runs; the F2 review cut it (memoised lookups + a substring prefilter that cannot change the result). Budgets
// are generous wall-clock limits for this machine class; the measured numbers are written to the results file.
import { describe, expect, it } from 'vitest';
import { recomputeInferredRelations } from '../../src/modules/brain/relations';
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
      const snapshot = () => t.ctx.db.all('SELECT from_concept_id, to_concept_id, relation, status, reasons_json FROM concept_relation ORDER BY from_concept_id, to_concept_id, relation');
      const before = snapshot();
      const t0 = performance.now();
      recomputeInferredRelations(t.ctx, courseKey(studySource(t.ctx, lectures[0]!.sourceId)));
      const recomputeMs = performance.now() - t0;
      expect(snapshot()).toEqual(before);
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
        views_ms: views,
      };
      report('brain-course', results);
      expect(Math.max(...extraction)).toBeLessThan(5_000);
      expect(recomputeMs).toBeLessThan(4_000);
      // the course page right after the extraction jobs does not recompute again
      expect(views.course!).toBeLessThan(4_000);
    } finally {
      await t.close();
    }
  }, 1_200_000);
});
