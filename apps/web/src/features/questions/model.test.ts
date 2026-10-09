import { describe, expect, it } from 'vitest';
import type { LectureQuestionItem } from '@medlevo/shared';
import { answerPill, changedFields, extractionPill, groupLectureItems, isCorrect, keyOriginLabel, nextLabel, questionCountAr, relationPill } from './model';

describe('question vault model', () => {
  it('statuses carry text labels (never colour alone) and separate key from extraction', () => {
    expect(answerPill('missing_key')).toEqual({ tone: 'warning', label: 'لا يوجد مفتاح' });
    expect(answerPill('conflicting_key').tone).toBe('danger');
    expect(answerPill('ai_derived').label).toContain('AI-derived');
    expect(extractionPill('checks_passed').label).toBe('اجتاز فحوص الاستخراج');
    expect(extractionPill('owner_reviewed').label).toBe('راجعته شخصيًا');
    expect(relationPill('directly_covered').label).toBe('مغطى مباشرة');
  });

  it('the answer marker says who stands behind it', () => {
    expect(keyOriginLabel('source_key')).toBe('حسب مفتاح المصدر');
    expect(keyOriginLabel('owner_key')).toBe('حسب المفتاح الذي حددته');
    expect(keyOriginLabel('missing_key')).toBeNull();
    expect(isCorrect({ correct_option_ids: ['x'] }, { id: 'x' })).toBe(true);
    expect(isCorrect({ correct_option_ids: null }, { id: 'x' })).toBe(false);
  });

  it('rail groups: this page first, weak course-only links apart', () => {
    const mk = (id: string, on: boolean, relation: LectureQuestionItem['link']['relation']) => ({ question_id: id, on_this_page: on, link: { relation } }) as unknown as LectureQuestionItem;
    const g = groupLectureItems([mk('a', false, 'directly_covered'), mk('b', true, 'strongly_related'), mk('c', true, 'course_related_only'), mk('d', false, 'partially_covered')]);
    expect(g.onPage.map((i) => i.question_id)).toEqual(['b']);
    expect(g.inLecture.map((i) => i.question_id)).toEqual(['a', 'd']);
    expect(g.courseOnly.map((i) => i.question_id)).toEqual(['c']);
  });

  it('next option label follows the printed script', () => {
    expect(nextLabel(['A', 'B'])).toBe('C');
    expect(nextLabel(['أ', 'ب'])).toBe('ج');
    expect(nextLabel(['1', '2'])).toBe('3');
    expect(nextLabel([])).toBe('A');
  });

  it('changed fields drive «save as new version» vs «accept as is»', () => {
    const orig = { stem: 'Which?', options: [{ option_key: 'o1', source_label: 'A', text: 'x' }] };
    expect(changedFields(orig, { stem: 'Which? ', options: [{ option_key: 'o1', source_label: 'A', text: 'x' }] })).toEqual([]);
    expect(changedFields(orig, { stem: 'Which one?', options: orig.options })).toEqual(['stem']);
    expect(changedFields(orig, { stem: 'Which?', options: [{ option_key: 'o1', source_label: 'A', text: 'y' }] })).toEqual(['options']);
  });

  it('question counts agree with the number in Arabic (review fix)', () => {
    expect(questionCountAr(1)).toBe('سؤال واحد');
    expect(questionCountAr(2)).toBe('سؤالان');
    expect(questionCountAr(3)).toBe('3 أسئلة');
    expect(questionCountAr(10)).toBe('10 أسئلة');
    expect(questionCountAr(11)).toBe('11 سؤالًا');
    expect(questionCountAr(103)).toBe('103 أسئلة');
  });
});
