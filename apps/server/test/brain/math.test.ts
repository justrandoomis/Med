// Course Brain — pure rules: coverage math with denominators (§36) and the Student Knowledge Map state (§44).
import { describe, expect, it } from 'vitest';
import { addCounts, computeCoverage, ZERO_COUNT } from '../../src/modules/brain/coverage';
import type { ConceptBasis, QuestionSide } from '../../src/modules/brain/lecture-questions';
import { classifyKnowledge } from '../../src/modules/brain/student';

const pages = [0, 1, 2, 3].map((i) => ({ id: `p${i}`, page_index: i, printed_label: String(11 + i), kind: 'page' }));
const q = (id: string, side: QuestionSide, page_ids: string[], concepts: Array<[string, ConceptBasis]>, attempts = 0) => ({ id, side, page_ids, concepts: new Map(concepts), attempts });

describe('computeCoverage', () => {
  it('separates source and generated coverage, counts attempted and uncovered, always with the denominator', () => {
    const r = computeCoverage(
      pages,
      [
        { id: 'c1', name: 'Alpha', status: 'accepted', page_ids: ['p0'] },
        { id: 'c2', name: 'Beta', status: 'suggested', page_ids: ['p1'] },
        { id: 'c3', name: 'Gamma', status: 'suggested', page_ids: ['p2'] },
      ],
      [q('s1', 'source', ['p0'], [['c1', 'matcher']], 2), q('s2', 'source', ['p0', 'p1'], []), q('g1', 'generated', ['p2'], [['c3', 'evidence']], 1), q('g2', 'generated', ['p0'], [['c1', 'text']])],
    );
    expect(r.pages.map((p) => [p.label_ar, p.status, p.source_question_ids, p.generated_question_ids, p.attempted_question_ids])).toEqual([
      ['ص 11 (الصفحة 1 في الملف)', 'source', ['s1', 's2'], ['g2'], ['s1']],
      ['ص 12 (الصفحة 2 في الملف)', 'source', ['s2'], [], []],
      ['ص 13 (الصفحة 3 في الملف)', 'generated_only', [], ['g1'], ['g1']],
      ['ص 14 (الصفحة 4 في الملف)', 'uncovered', [], [], []],
    ]);
    expect(r.totals.pages).toEqual({ total: 4, with_source_questions: 2, with_generated_questions: 2, attempted: 2, uncovered: 1 });
    expect(r.concepts.map((c) => [c.name, c.status])).toEqual([
      ['Alpha', 'source'],
      ['Beta', 'uncovered'],
      ['Gamma', 'generated_only'],
    ]);
    expect(r.totals.concepts).toEqual({ total: 3, with_source_questions: 1, with_generated_questions: 2, attempted: 2, uncovered: 1 });
    expect(r.concepts[0]!.basis_ar).toContain('ربط السؤال بالمحاضرة ذكر المفهوم');
    expect(r.concepts[0]!.basis_ar).toContain('اسم المفهوم في نص السؤال');
    expect(r.concepts[1]!.basis_ar).toContain('لا يوجد سؤال');
    expect(r.totals.questions).toEqual({ source: 2, generated: 2, attempted_source: 1, attempted_generated: 1 });
  });

  it('an empty lecture is 0 of 0, never a percentage of nothing; course totals add up', () => {
    const r = computeCoverage([], [], []);
    expect(r.totals.pages).toEqual(ZERO_COUNT);
    expect(addCounts({ total: 4, with_source_questions: 2, with_generated_questions: 1, attempted: 1, uncovered: 1 }, { total: 2, with_source_questions: 0, with_generated_questions: 0, attempted: 0, uncovered: 2 })).toEqual({
      total: 6,
      with_source_questions: 2,
      with_generated_questions: 1,
      attempted: 1,
      uncovered: 3,
    });
  });
});

describe('classifyKnowledge (Student Knowledge Map state)', () => {
  const base = { pagesTotal: 2, pagesViewed: 0, questionAttempts: 0, cardReviews: 0, mastery: null, sample: 0, weaknessStatus: null };
  it('opening pages is never mastery; practice below the sample has no estimate', () => {
    expect(classifyKnowledge(base)).toBe('not_started');
    expect(classifyKnowledge({ ...base, pagesViewed: 2 })).toBe('read');
    expect(classifyKnowledge({ ...base, pagesViewed: 2, questionAttempts: 2, sample: 2 })).toBe('practicing');
    expect(classifyKnowledge({ ...base, cardReviews: 1 })).toBe('practicing');
  });
  it('estimate thresholds and an active weakness', () => {
    expect(classifyKnowledge({ ...base, questionAttempts: 3, mastery: 0.85, sample: 3 })).toBe('strong');
    expect(classifyKnowledge({ ...base, questionAttempts: 3, mastery: 0.6, sample: 3 })).toBe('developing');
    expect(classifyKnowledge({ ...base, questionAttempts: 3, mastery: 0.2, sample: 3 })).toBe('needs_work');
    expect(classifyKnowledge({ ...base, questionAttempts: 3, mastery: 0.9, sample: 3, weaknessStatus: 'active' })).toBe('needs_work');
    expect(classifyKnowledge({ ...base, questionAttempts: 1, weaknessStatus: 'improving' })).toBe('developing');
  });
});
