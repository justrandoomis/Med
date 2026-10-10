// Study modes (§39): Learn / Understand / Practice / Review / Exam. A mode ARRANGES the same tools and the same data —
// the order of the Study Rail sections and which one opens, which side panels open, how many linked questions are shown,
// the hints policy of a practice set started from the rail, and what stays hidden in Exam mode (explanations, solutions,
// link reasons, the source peek of a question). No tool is duplicated and no data is split per mode; the mode itself
// is persisted with the study session (study_session.mode, synced like the rest of the session).
import { STUDY_MODES, type ExamMode, type StudyMode } from '@medlevo/shared';

export type RailSection = 'explain' | 'questions' | 'cases' | 'sources' | 'mine';

export const RAIL_SECTION_LABELS_AR: Record<RailSection, string> = {
  explain: 'الشرح والسؤال',
  questions: 'الأسئلة',
  cases: 'حالات',
  sources: 'المصادر',
  mine: 'ملاحظاتي',
};

/** How many of the lecture's linked questions the rail shows open (the rest stay one click away). */
export type QuestionDensity = 'page' | 'lecture' | 'all';

export interface ModeArrangement {
  mode: StudyMode;
  /** visible rail sections, in order */
  railOrder: RailSection[];
  /** sections hidden in this mode (with EXAM_MODE_HIDDEN_AR next to them) */
  hidden: RailSection[];
  /** the section opened when the owner switches to this mode */
  defaultTab: RailSection;
  /** side panels opened by the switch (the owner can still toggle them) */
  panels: { rail: boolean; left: boolean };
  questionDensity: QuestionDensity;
  /** the practice set started from the rail («تدرّب» / «امتحن نفسك») */
  practice: { mode: Extract<ExamMode, 'practice' | 'revision' | 'exam'>; hints: 'progressive' | 'off'; antiShortcut: boolean };
  /** explanations, «why linked» reasons, opening a question's original page, AI explain tools */
  showExplanations: boolean;
  showLinkReasons: boolean;
  showQuestionSource: boolean;
}

const ARRANGEMENTS: Record<StudyMode, ModeArrangement> = {
  learn: {
    mode: 'learn',
    railOrder: ['explain', 'sources', 'questions', 'cases', 'mine'],
    hidden: [],
    defaultTab: 'explain',
    panels: { rail: true, left: true },
    questionDensity: 'page',
    practice: { mode: 'practice', hints: 'progressive', antiShortcut: false },
    showExplanations: true,
    showLinkReasons: true,
    showQuestionSource: true,
  },
  understand: {
    mode: 'understand',
    railOrder: ['explain', 'sources', 'cases', 'questions', 'mine'],
    hidden: [],
    defaultTab: 'explain',
    panels: { rail: true, left: false },
    questionDensity: 'page',
    practice: { mode: 'practice', hints: 'progressive', antiShortcut: false },
    showExplanations: true,
    showLinkReasons: true,
    showQuestionSource: true,
  },
  practice: {
    mode: 'practice',
    railOrder: ['questions', 'cases', 'explain', 'mine', 'sources'],
    hidden: [],
    defaultTab: 'questions',
    panels: { rail: true, left: false },
    questionDensity: 'all',
    // Anti-shortcut (§39): the solution stays hidden until an answer was chosen
    practice: { mode: 'practice', hints: 'progressive', antiShortcut: true },
    showExplanations: true,
    showLinkReasons: true,
    showQuestionSource: true,
  },
  review: {
    mode: 'review',
    railOrder: ['mine', 'questions', 'cases', 'explain', 'sources'],
    hidden: [],
    defaultTab: 'mine',
    panels: { rail: true, left: true },
    questionDensity: 'lecture',
    practice: { mode: 'revision', hints: 'progressive', antiShortcut: false },
    showExplanations: true,
    showLinkReasons: true,
    showQuestionSource: true,
  },
  exam: {
    mode: 'exam',
    railOrder: ['questions', 'cases', 'mine'],
    hidden: ['explain', 'sources'],
    defaultTab: 'questions',
    panels: { rail: true, left: false },
    questionDensity: 'all',
    // assessed: no hints, solutions only after finishing (the exams module enforces it on the server)
    practice: { mode: 'exam', hints: 'off', antiShortcut: false },
    showExplanations: false,
    showLinkReasons: false,
    showQuestionSource: false,
  },
};

export function isStudyMode(v: unknown): v is StudyMode {
  return typeof v === 'string' && (STUDY_MODES as readonly string[]).includes(v);
}

export function arrangementFor(mode: StudyMode | null | undefined): ModeArrangement {
  return ARRANGEMENTS[isStudyMode(mode) ? mode : 'learn'];
}

/** The tab to show: the requested one when it is visible in this mode, else the mode's default. */
export function visibleTab(a: ModeArrangement, requested: RailSection | null | undefined): RailSection {
  return requested && a.railOrder.includes(requested) ? requested : a.defaultTab;
}

/** Practice route of a question from the rail, with the mode's policy (the exams module fixes it at creation). */
export function practiceHref(a: ModeArrangement, sourceId: string, questionId: string): string {
  const q = new URLSearchParams({ source_id: sourceId, question_id: questionId });
  if (a.practice.mode !== 'practice') q.set('mode', a.practice.mode);
  if (a.practice.antiShortcut) q.set('anti_shortcut', '1');
  return `/practice?${q.toString()}`;
}
