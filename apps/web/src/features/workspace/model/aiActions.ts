// Selection actions (§30). The explanation family (Explain, Simplify, Translate, Ask, Compare, Explain Image) is
// wired to the «الشرح والسؤال» rail tab: the toolbar hands the selection anchor over through a small store and
// the workspace opens the tab. Create MCQ / Create Flashcard / Add to Revision belong to later tracks and stay
// disabled with a specific, honest reason (§12, §61) — or the capability's own reason when the feature is off.
import { useSyncExternalStore } from 'react';
import type { FeatureKey, NormBox, SelectionAnchor } from '@medlevo/shared';

export type SelectionActionId = 'explain' | 'simplify' | 'translate' | 'ask' | 'compare' | 'mcq' | 'flashcard' | 'revision' | 'explain_image';

export interface PendingAction {
  id: SelectionActionId;
  label: string;
  /** English name as used in the spec, shown as an LTR term */
  term: string;
  feature: FeatureKey;
  /** wired to the rail in this build */
  wired: boolean;
  /** why a not-wired action is unavailable (honest, specific) */
  notWiredReason?: string;
}

export const SELECTION_AI_ACTIONS: readonly PendingAction[] = [
  { id: 'explain', label: 'اشرح', term: 'Explain', feature: 'ai.explain', wired: true },
  { id: 'simplify', label: 'بسّط', term: 'Simplify', feature: 'ai.explain', wired: true },
  { id: 'translate', label: 'ترجم', term: 'Translate', feature: 'ai.explain', wired: true },
  { id: 'ask', label: 'اسأل عن التحديد', term: 'Ask', feature: 'ai.chat', wired: true },
  { id: 'compare', label: 'قارن', term: 'Compare', feature: 'ai.summaries', wired: true },
  { id: 'mcq', label: 'أنشئ سؤال اختيار من متعدد', term: 'Create MCQ', feature: 'ai.generate_questions', wired: false, notWiredReason: 'إنشاء الأسئلة من التحديد يصل مع مرحلة الأسئلة المولَّدة؛ لم يُربط بالقارئ بعد.' },
  { id: 'flashcard', label: 'أنشئ بطاقة مراجعة', term: 'Create Flashcard', feature: 'flashcards', wired: false, notWiredReason: 'البطاقات والمراجعة المتباعدة تصل في مرحلة لاحقة؛ لم تُربط بالقارئ بعد.' },
  { id: 'revision', label: 'أضف إلى المراجعة', term: 'Add to Revision', feature: 'planner', wired: false, notWiredReason: 'خطة المراجعة تصل في مرحلة لاحقة؛ لم تُربط بالقارئ بعد.' },
  { id: 'explain_image', label: 'اشرح الصورة', term: 'Explain Image', feature: 'ai.figure_explain', wired: true },
];

export const NOT_WIRED_AR = 'لم تُربط هذه الأداة بمساحة الدراسة بعد؛ تصل في مرحلة لاحقة.';

/** Reason shown next to a disabled action, or null when it can run now. */
export function actionDisabledReason(a: PendingAction, gate: { available: boolean; reason: string | null }): string | null {
  if (!gate.available) return gate.reason ?? 'هذه الميزة غير متاحة الآن.';
  if (!a.wired) return a.notWiredReason ?? NOT_WIRED_AR;
  return null;
}

/** Back-compat helper (pending reason for a disabled action). */
export function pendingActionReason(gate: { available: boolean; reason: string | null }): string {
  if (!gate.available && gate.reason) return gate.reason;
  return NOT_WIRED_AR;
}

// ───────── selection → rail hand-over ─────────
export type ExplainActionId = Extract<SelectionActionId, 'explain' | 'simplify' | 'translate' | 'ask' | 'compare' | 'explain_image'>;

export interface AiRequest {
  /** unique per click (the rail reacts once) */
  id: string;
  action: ExplainActionId;
  anchor: SelectionAnchor;
  /** the selected text (logical order) */
  text: string;
  pageIndex: number;
  /** selection rectangles (normalized, unrotated page) → the rail resolves the region ids under them */
  rects: NormBox[];
}

let pending: AiRequest | null = null;
const listeners = new Set<() => void>();
let seq = 0;

export const aiRequestStore = {
  get: (): AiRequest | null => pending,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** called by the selection toolbar */
  request(r: Omit<AiRequest, 'id'>): AiRequest {
    pending = { ...r, id: `${Date.now()}-${++seq}` };
    listeners.forEach((l) => l());
    return pending;
  },
  /** the rail consumed it */
  clear(id?: string): void {
    if (id && pending?.id !== id) return;
    pending = null;
    listeners.forEach((l) => l());
  },
};

export function usePendingAiRequest(): AiRequest | null {
  return useSyncExternalStore(aiRequestStore.subscribe, aiRequestStore.get, aiRequestStore.get);
}
