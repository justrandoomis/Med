// Study modes (§39, track F3; smart chat): each mode arranges the SAME two rail sections — default section, leading
// skills, panels, question density and the practice policy — and «امتحن نفسك» hides the chat, explanations and the
// source inspector. Pure model.
import { describe, expect, it } from 'vitest';
import { STUDY_MODES } from '@medlevo/shared';
import { arrangementFor, isStudyMode, practiceHref, RAIL_SECTION_LABELS_AR, railSectionOf, visibleTab, visibleTool } from './arrangement';

describe('study mode arrangements', () => {
  it('every mode keeps the same two sections — the smart chat and my notes — and a visible default', () => {
    for (const m of STUDY_MODES) {
      const a = arrangementFor(m);
      expect(a.railOrder).toEqual(['chat', 'mine']);
      expect(a.railOrder).toContain(a.defaultTab);
      expect(a.mode).toBe(m);
    }
    expect(RAIL_SECTION_LABELS_AR).toEqual({ chat: 'المحادثة الذكية', mine: 'ملاحظاتي' });
  });

  it('Learn opens on the chat with this page’s questions; Practice leads with the question skills and the anti-shortcut', () => {
    const learn = arrangementFor('learn');
    expect(learn.defaultTab).toBe('chat');
    expect(learn.chatLabel).toBe('المحادثة الذكية');
    expect(learn.questionDensity).toBe('page');
    expect(learn.panels).toEqual({ rail: true, left: true });
    const practice = arrangementFor('practice');
    expect(practice.skillsFirst).toEqual(['mcq', 'case', 'lecture_questions']);
    expect(practice.questionDensity).toBe('all');
    expect(practice.practice.antiShortcut).toBe(true);
    const review = arrangementFor('review');
    expect(review.defaultTab).toBe('mine');
    expect(review.practice.mode).toBe('revision');
    expect(arrangementFor('understand').skillsFirst[0]).toBe('case');
  });

  it('Exam hides the chat, explanations and the source inspector, link reasons and the original page; hints are off', () => {
    const exam = arrangementFor('exam');
    expect(exam.chatLabel).toBe('أسئلة وحالات');
    expect(exam.hidden).toEqual(['المحادثة الذكية', 'الشرح', 'المصادر']);
    expect(exam.hiddenTools).toEqual(['explain', 'sources']);
    expect(visibleTool(exam, 'explain')).toBeNull();
    expect(visibleTool(exam, 'sources')).toBeNull();
    expect(visibleTool(exam, 'questions')).toBe('questions');
    expect(visibleTool(arrangementFor('learn'), 'sources')).toBe('sources');
    expect(exam.showExplanations).toBe(false);
    expect(exam.showLinkReasons).toBe(false);
    expect(exam.showQuestionSource).toBe(false);
    expect(exam.practice).toEqual({ mode: 'exam', hints: 'off', antiShortcut: false });
  });

  it('an unknown requested section falls back to the mode’s default; old saved tabs open the chat; unknown modes are Learn', () => {
    expect(visibleTab(arrangementFor('review'), null)).toBe('mine');
    expect(visibleTab(arrangementFor('learn'), null)).toBe('chat');
    for (const old of ['explain', 'questions', 'cases', 'sources', 'chat']) expect(railSectionOf(old)).toBe('chat');
    expect(railSectionOf('mine')).toBe('mine');
    expect(railSectionOf(undefined)).toBeNull();
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
