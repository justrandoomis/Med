// Lasso actions provided by the screen around the engine (track F4, §28/§29): «تحويل إلى نص» and «اسأل عن المحدد»
// (handwriting recognition + the contextual chat) and the time links of strokes written during a recording. The engine
// stays independent of routes and servers: without a provider the menu items stay disabled with their reason.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AnnotationAnchor, InkAudioLink, NormBox } from '@medlevo/shared';
import type { InkItem } from './model';

export interface InkSelectionInfo {
  targetKey: string;
  /** anchor of the page the selection is on (null when the page is not loaded) */
  anchor: AnnotationAnchor | null;
  /** selected items (strokes, shapes, text boxes …) — the host decides what it can read */
  items: InkItem[];
  /** selection box, normalized to the unrotated page */
  bbox: NormBox;
  /** page height / page width */
  ar: number;
}

export interface InkSelectionAction {
  /** null → the action can run; otherwise why it is disabled (shown next to it) */
  reason: string | null;
  run(sel: InkSelectionInfo): void;
}

/**
 * (parity N1 Wave 0) A named lasso action supplied by the screen around the engine (N2 «احفظ كعنصر», N4 «أنشئ بطاقة»,
 * «أنشئ سؤالًا», «لقطة» …). It appears in the selection's «المزيد» menu, disabled with its reason while it cannot run.
 */
export interface InkSelectionExtraAction extends InkSelectionAction {
  /** stable id (also the React key), e.g. 'n4.card' */
  id: string;
  label_ar: string;
  icon?: ReactNode;
}

export interface InkSelectionActions {
  /** (N1 Wave 0) more named actions, after the built-in ones */
  extra?: InkSelectionExtraAction[];
  convert?: InkSelectionAction;
  ask?: InkSelectionAction;
  /** (H3 item 4) «اصنع بطاقة من المحدد…»: a flashcard (front from the reading of the strokes, or a picture of the page) */
  card?: InkSelectionAction;
  /** (H3 item 4) «اكتب سؤالًا من المحدد…»: an owner-written question saved in the Question Vault */
  question?: InkSelectionAction;
  /** play the recording at the stroke's moment */
  playAudio?(link: InkAudioLink): void;
  /** change (→ manual) or remove a stroke's time link; the host asks the owner for the moment */
  editAudioLink?(item: InkItem, targetKey: string): void;
}

const Ctx = createContext<InkSelectionActions | null>(null);

/**
 * Provides lasso actions. Providers nest: an inner provider's actions win, and the `extra` actions of every provider
 * around are kept (each track can wrap the reader with its own actions).
 */
export function InkSelectionActionsProvider({ value, children }: { value: InkSelectionActions; children: ReactNode }) {
  const outer = useContext(Ctx);
  const merged = useMemo<InkSelectionActions>(() => {
    if (!outer) return value;
    const extra = [...(outer.extra ?? []), ...(value.extra ?? [])];
    const seen = new Set<string>();
    // the inner provider's action wins over an outer one with the same id
    const unique = extra.reverse().filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true))).reverse();
    return { ...outer, ...value, extra: unique };
  }, [outer, value]);
  return <Ctx.Provider value={merged}>{children}</Ctx.Provider>;
}

export function useInkSelectionActions(): InkSelectionActions | null {
  return useContext(Ctx);
}

export const NO_RECOGNITION_HOST_AR = 'قراءة الخط متاحة في صفحات المحاضرات المفتوحة في مساحة الدراسة.';
export const NO_ASK_HOST_AR = 'السؤال عن الكتابة يحتاج لوحة الدراسة السياقية بجانب صفحة من محاضرة.';
export const NO_CARD_HOST_AR = 'صنع البطاقات والأسئلة من المحدد متاح في صفحات المصادر والدفاتر المفتوحة في مساحة الدراسة.';
