// Study modes (§39): Learn / Understand / Practice / Review / Exam. A mode ARRANGES the same tools and the same data —
// which Study Rail section opens (the rail has two: the smart chat and my notes), which skills lead, which side panels open, how many linked questions are shown,
// the hints policy of a practice set started from the rail, and what stays hidden in Exam mode (explanations, solutions,
// link reasons, the source peek of a question). No tool is duplicated and no data is split per mode; the mode itself
// is persisted with the study session (study_session.mode, synced like the rest of the session).
import { STUDY_MODES, type ExamMode, type StudyMode } from '@medlevo/shared';

/**
 * (smart chat, wp/smart-rail) The rail has TWO sections: «المحادثة الذكية» (the study chat with its skills) and
 * «ملاحظاتي». The former tabs «الشرح والسؤال» / «الأسئلة» / «حالات» / «المصادر» became the chat's skills and cards; their
 * full panels stay one step away as rail TOOLS (opened from a card or from the reading bar's «⋯»).
 */
export type RailSection = 'chat' | 'mine';
export type RailTool = 'explain' | 'questions' | 'cases' | 'sources';
export const RAIL_TOOLS: readonly RailTool[] = ['explain', 'questions', 'cases', 'sources'];

export const RAIL_SECTION_LABELS_AR: Record<RailSection, string> = {
  chat: 'المحادثة الذكية',
  mine: 'ملاحظاتي',
};
/** «امتحن نفسك»: the chat (it explains) is hidden; the first section holds the lecture's questions and cases */
export const EXAM_CHAT_SECTION_LABEL_AR = 'أسئلة وحالات';

export const RAIL_TOOL_LABELS_AR: Record<RailTool, string> = {
  explain: 'شرح سريع وترجمة',
  questions: 'أسئلة المحاضرة',
  cases: 'حالات المحاضرة',
  sources: 'المصادر والأشكال',
};

/** Rail values saved before the two-section rail (sessions, links) → the section that now holds them. */
export function railSectionOf(v: unknown): RailSection | null {
  if (v === 'mine') return 'mine';
  if (v === 'chat' || v === 'explain' || v === 'questions' || v === 'cases' || v === 'sources') return 'chat';
  return null;
}

/** How many of the lecture's linked questions the rail shows open (the rest stay one click away). */
export type QuestionDensity = 'page' | 'lecture' | 'all';

export interface ModeArrangement {
  mode: StudyMode;
  /** visible rail sections, in order (always the two) */
  railOrder: RailSection[];
  /** the first section's name in this mode */
  chatLabel: string;
  /** what this mode hides, in words (with EXAM_MODE_HIDDEN_AR next to them) */
  hidden: string[];
  /** rail tools this mode hides (their entries stay, disabled with the reason) */
  hiddenTools: RailTool[];
  /** the section opened when the owner switches to this mode */
  defaultTab: RailSection;
  /** the skill chips this mode puts first (practice: questions first) */
  skillsFirst: Array<'mcq' | 'case' | 'lecture_questions'>;
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

const BOTH: RailSection[] = ['chat', 'mine'];
const CHAT = RAIL_SECTION_LABELS_AR.chat;

const ARRANGEMENTS: Record<StudyMode, ModeArrangement> = {
  learn: {
    mode: 'learn',
    railOrder: BOTH,
    chatLabel: CHAT,
    hidden: [],
    hiddenTools: [],
    defaultTab: 'chat',
    skillsFirst: [],
    panels: { rail: true, left: true },
    questionDensity: 'page',
    practice: { mode: 'practice', hints: 'progressive', antiShortcut: false },
    showExplanations: true,
    showLinkReasons: true,
    showQuestionSource: true,
  },
  understand: {
    mode: 'understand',
    railOrder: BOTH,
    chatLabel: CHAT,
    hidden: [],
    hiddenTools: [],
    defaultTab: 'chat',
    skillsFirst: ['case'],
    panels: { rail: true, left: false },
    questionDensity: 'page',
    practice: { mode: 'practice', hints: 'progressive', antiShortcut: false },
    showExplanations: true,
    showLinkReasons: true,
    showQuestionSource: true,
  },
  practice: {
    mode: 'practice',
    railOrder: BOTH,
    chatLabel: CHAT,
    hidden: [],
    hiddenTools: [],
    defaultTab: 'chat',
    skillsFirst: ['mcq', 'case', 'lecture_questions'],
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
    railOrder: BOTH,
    chatLabel: CHAT,
    hidden: [],
    hiddenTools: [],
    defaultTab: 'mine',
    skillsFirst: ['lecture_questions'],
    panels: { rail: true, left: true },
    questionDensity: 'lecture',
    practice: { mode: 'revision', hints: 'progressive', antiShortcut: false },
    showExplanations: true,
    showLinkReasons: true,
    showQuestionSource: true,
  },
  exam: {
    mode: 'exam',
    railOrder: BOTH,
    chatLabel: EXAM_CHAT_SECTION_LABEL_AR,
    hidden: ['المحادثة الذكية', 'الشرح', 'المصادر'],
    hiddenTools: ['explain', 'sources'],
    defaultTab: 'chat',
    skillsFirst: [],
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

/** A rail tool this mode shows (null: hidden here — e.g. explanations and the source inspector in «امتحن نفسك»). */
export function visibleTool(a: ModeArrangement, tool: RailTool | null | undefined): RailTool | null {
  return tool && !a.hiddenTools.includes(tool) ? tool : null;
}

/** Practice route of a question from the rail, with the mode's policy (the exams module fixes it at creation). */
export function practiceHref(a: ModeArrangement, sourceId: string, questionId: string): string {
  const q = new URLSearchParams({ source_id: sourceId, question_id: questionId });
  if (a.practice.mode !== 'practice') q.set('mode', a.practice.mode);
  if (a.practice.antiShortcut) q.set('anti_shortcut', '1');
  return `/practice?${q.toString()}`;
}
