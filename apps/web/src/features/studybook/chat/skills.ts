// Smart chat skills (wp/smart-rail): the study chat's quick actions — chips above the composer and a «/» command menu.
// Each skill is an EXISTING server capability wired as a chat turn: explain / summarize are evidence-checked chat
// questions; MCQ, case, compare, flashcards, image question, linked questions and sources run in their own module and
// come back as an interactive card stored in the conversation (ChatAttachment, migration 0471). No new AI path.
// Pure logic (no React): definitions, the «/» query and matching, the owner's request wording.
import type { ChatSkillId } from '@medlevo/shared';

export interface SkillDef {
  id: ChatSkillId;
  /** the chip / menu label */
  label: string;
  /** the «/» command (Arabic, no diacritics) */
  command: string;
  /** one line in the «/» menu */
  hint: string;
  /** chat skills are a question to the chat; card skills produce a card */
  mode: 'chat' | 'card';
  /** the skill asks for a few choices first (count + difficulty, or the two terms) */
  form?: 'mcq' | 'compare';
}

export const SKILL_DEFS: readonly SkillDef[] = [
  { id: 'explain_page', label: 'اشرح الصفحة', command: 'اشرح', hint: 'شرح الصفحة التي تقرؤها من مصادرك، مع التحقق من كل جملة', mode: 'chat' },
  { id: 'summarize', label: 'لخّص', command: 'لخص', hint: 'تلخيص الصفحة (أو التحديد) في نقاط مرتبة', mode: 'chat' },
  { id: 'mcq', label: 'اسألني MCQ', command: 'mcq', hint: 'أسئلة اختيار من متعدد من هذه الصفحة؛ تُنشر بعد التحقق فقط', mode: 'card', form: 'mcq' },
  { id: 'case', label: 'حالة سريرية', command: 'حالة', hint: 'حالة سريرية من الصفحة تُكشف خطوة خطوة', mode: 'card' },
  { id: 'compare', label: 'قارن', command: 'قارن', hint: 'مقارنة مصطلحين في جدول مدعوم بالمصادر', mode: 'card', form: 'compare' },
  { id: 'cards', label: 'بطاقات', command: 'بطاقات', hint: 'بطاقات مراجعة من صور المحاضرة الموصوفة', mode: 'card' },
  { id: 'figure_question', label: 'سؤال من الصورة', command: 'صورة', hint: 'سؤال عن صورة موصوفة في هذه الصفحة', mode: 'card' },
  { id: 'explain_figure', label: 'اشرح الشكل', command: 'شكل', hint: 'شرح الشكل في الصفحة مما يذكره المصدر', mode: 'card' },
  { id: 'lecture_questions', label: 'أسئلة المحاضرة', command: 'أسئلة', hint: 'أسئلة خزنتك المرتبطة بهذه الصفحة والمحاضرة', mode: 'card' },
  { id: 'sources', label: 'المصادر', command: 'مصادر', hint: 'مصادر هذه المحادثة ونطاقها، وصور المحاضرة', mode: 'card' },
];

export function skillDef(id: ChatSkillId): SkillDef {
  return SKILL_DEFS.find((s) => s.id === id)!;
}

/** Arabic search folding: no diacritics / tatweel, alef forms and taa marbuta unified, lower case. */
export function foldAr(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .trim();
}

/** The «/» query of the composer text, or null when the text is not a command (a «/» at the start, one line). */
export function slashQuery(text: string): string | null {
  if (!text.startsWith('/') || text.includes('\n')) return null;
  const q = text.slice(1);
  // «/mcq شيء» — a space after a complete command closes the menu (the rest is the owner's text)
  if (/\s\S/.test(q)) return null;
  return q.trim();
}

/** Skills whose command or label starts with (or contains) the query, prefix matches first. */
export function matchSkills<T extends { def: SkillDef }>(query: string, items: readonly T[]): T[] {
  const q = foldAr(query);
  if (!q) return [...items];
  const starts: T[] = [];
  const contains: T[] = [];
  for (const it of items) {
    const keys = [foldAr(it.def.command), foldAr(it.def.label)];
    if (keys.some((k) => k.startsWith(q))) starts.push(it);
    else if (keys.some((k) => k.includes(q))) contains.push(it);
  }
  return [...starts, ...contains];
}

export const MCQ_COUNTS = [1, 3, 5] as const;

/** What the owner sees as their own message for a skill (kept short; it also names a new conversation). */
export function requestText(id: ChatSkillId, o: { count?: number; difficultyLabel?: string; items?: string[]; page?: string | null; selection?: boolean } = {}): string {
  const where = o.selection ? 'التحديد' : (o.page ?? 'هذه الصفحة');
  switch (id) {
    case 'explain_page':
      return o.selection ? 'اشرح التحديد' : 'اشرح هذه الصفحة';
    case 'summarize':
      return o.selection ? 'لخّص التحديد في نقاط مرتبة.' : 'لخّص هذه الصفحة في نقاط مرتبة.';
    case 'mcq':
      return `اسألني ${o.count === 1 || !o.count ? 'سؤال MCQ واحدًا' : `${o.count} أسئلة MCQ`}${o.difficultyLabel ? ` — ${o.difficultyLabel}` : ''} من ${where}`;
    case 'case':
      return `حالة سريرية من ${where}`;
    case 'compare':
      return `قارن: ${(o.items ?? []).join(' / ')}`;
    case 'cards':
      return 'بطاقات مراجعة من صور المحاضرة';
    case 'figure_question':
      return `سؤال من الصورة في ${where}`;
    case 'explain_figure':
      return `اشرح الشكل في ${where}`;
    case 'lecture_questions':
      return 'أسئلة المحاضرة المرتبطة';
    case 'sources':
      return 'المصادر';
  }
}
