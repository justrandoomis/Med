// Selection actions that arrive in later rounds (§30). They are listed so the owner sees what exists,
// but stay disabled with a specific reason (§12, §61): the capability's own reason when the feature is
// unavailable, otherwise the honest fact that the reader is not wired to it yet.
import type { FeatureKey } from '@medlevo/shared';

export interface PendingAction {
  id: 'explain' | 'simplify' | 'translate' | 'ask' | 'compare' | 'mcq' | 'flashcard' | 'revision' | 'explain_image';
  label: string;
  /** English name as used in the spec, shown as an LTR term */
  term: string;
  feature: FeatureKey;
}

export const SELECTION_AI_ACTIONS: readonly PendingAction[] = [
  { id: 'explain', label: 'اشرح', term: 'Explain', feature: 'ai.explain' },
  { id: 'simplify', label: 'بسّط', term: 'Simplify', feature: 'ai.explain' },
  { id: 'translate', label: 'ترجم', term: 'Translate', feature: 'ai.explain' },
  { id: 'ask', label: 'اسأل عن التحديد', term: 'Ask', feature: 'ai.chat' },
  { id: 'compare', label: 'قارن', term: 'Compare', feature: 'ai.summaries' },
  { id: 'mcq', label: 'أنشئ سؤال اختيار من متعدد', term: 'Create MCQ', feature: 'ai.generate_questions' },
  { id: 'flashcard', label: 'أنشئ بطاقة مراجعة', term: 'Create Flashcard', feature: 'flashcards' },
  { id: 'revision', label: 'أضف إلى المراجعة', term: 'Add to Revision', feature: 'planner' },
  { id: 'explain_image', label: 'اشرح الصورة', term: 'Explain Image', feature: 'ai.figure_explain' },
];

export const NOT_WIRED_AR = 'لم تُربط هذه الأداة بمساحة الدراسة بعد؛ تصل في مرحلة لاحقة.';

/** Reason shown next to a disabled action. */
export function pendingActionReason(gate: { available: boolean; reason: string | null }): string {
  if (!gate.available && gate.reason) return gate.reason;
  return NOT_WIRED_AR;
}
