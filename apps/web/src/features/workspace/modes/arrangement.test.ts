// Study modes (§39, track F3): each mode arranges the SAME rail sections — order, default section, panels, question
// density and the practice policy — and «امتحن نفسك» hides explanations and the source inspector. Pure model.
import { describe, expect, it } from 'vitest';
import { STUDY_MODES } from '@medlevo/shared';
import { arrangementFor, isStudyMode, practiceHref, visibleTab } from './arrangement';

describe('study mode arrangements', () => {
  it('every mode keeps the same five sections (visible + hidden), no duplicated section and a visible default', () => {
    for (const m of STUDY_MODES) {
      const a = arrangementFor(m);
      const all = [...a.railOrder, ...a.hidden].sort();
      expect(all).toEqual(['cases', 'explain', 'mine', 'questions', 'sources']);
      expect(new Set(a.railOrder).size).toBe(a.railOrder.length);
      expect(a.railOrder).toContain(a.defaultTab);
      expect(a.mode).toBe(m);
    }
  });

  it('Learn opens on explanations with this page’s questions; Practice leads with questions and the anti-shortcut', () => {
    const learn = arrangementFor('learn');
    expect(learn.railOrder[0]).toBe('explain');
    expect(learn.questionDensity).toBe('page');
    expect(learn.panels).toEqual({ rail: true, left: true });
    const practice = arrangementFor('practice');
    expect(practice.railOrder[0]).toBe('questions');
    expect(practice.defaultTab).toBe('questions');
    expect(practice.questionDensity).toBe('all');
    expect(practice.practice.antiShortcut).toBe(true);
    const review = arrangementFor('review');
    expect(review.defaultTab).toBe('mine');
    expect(review.practice.mode).toBe('revision');
    expect(arrangementFor('understand').railOrder.indexOf('cases')).toBeLessThan(arrangementFor('understand').railOrder.indexOf('questions'));
  });

  it('Exam hides explanations and the source inspector, link reasons and the original page; hints are off', () => {
    const exam = arrangementFor('exam');
    expect(exam.hidden).toEqual(['explain', 'sources']);
    expect(exam.railOrder).not.toContain('explain');
    expect(exam.railOrder).not.toContain('sources');
    expect(exam.showExplanations).toBe(false);
    expect(exam.showLinkReasons).toBe(false);
    expect(exam.showQuestionSource).toBe(false);
    expect(exam.practice).toEqual({ mode: 'exam', hints: 'off', antiShortcut: false });
  });

  it('a hidden or unknown requested section falls back to the mode’s default; unknown modes are Learn', () => {
    const exam = arrangementFor('exam');
    expect(visibleTab(exam, 'explain')).toBe('questions');
    expect(visibleTab(exam, 'sources')).toBe('questions');
    expect(visibleTab(exam, 'cases')).toBe('cases');
    expect(visibleTab(arrangementFor('learn'), null)).toBe('explain');
    expect(arrangementFor('cram' as never).mode).toBe('learn');
    expect(isStudyMode('exam')).toBe(true);
    expect(isStudyMode('cram')).toBe(false);
    expect(isStudyMode(null)).toBe(false);
  });

  it('the practice route carries the mode’s policy (the exams module fixes it at creation)', () => {
    expect(practiceHref(arrangementFor('learn'), 'L1', 'Q1')).toBe('/practice?source_id=L1&question_id=Q1');
    expect(practiceHref(arrangementFor('practice'), 'L1', 'Q1')).toBe('/practice?source_id=L1&question_id=Q1&anti_shortcut=1');
    expect(practiceHref(arrangementFor('review'), 'L1', 'Q1')).toBe('/practice?source_id=L1&question_id=Q1&mode=revision');
    expect(practiceHref(arrangementFor('exam'), 'L 1', 'Q1')).toBe('/practice?source_id=L+1&question_id=Q1&mode=exam');
  });
});
