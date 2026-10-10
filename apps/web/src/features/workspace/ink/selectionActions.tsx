// Lasso actions provided by the screen around the engine (track F4, §28/§29): «تحويل إلى نص» and «اسأل عن المحدد»
// (handwriting recognition + the contextual chat) and the time links of strokes written during a recording. The engine
// stays independent of routes and servers: without a provider the menu items stay disabled with their reason.
import { createContext, useContext, type ReactNode } from 'react';
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

export interface InkSelectionActions {
  convert?: InkSelectionAction;
  ask?: InkSelectionAction;
  /** play the recording at the stroke's moment */
  playAudio?(link: InkAudioLink): void;
  /** change (→ manual) or remove a stroke's time link; the host asks the owner for the moment */
  editAudioLink?(item: InkItem, targetKey: string): void;
}

const Ctx = createContext<InkSelectionActions | null>(null);

export function InkSelectionActionsProvider({ value, children }: { value: InkSelectionActions; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useInkSelectionActions(): InkSelectionActions | null {
  return useContext(Ctx);
}

export const NO_RECOGNITION_HOST_AR = 'قراءة الخط متاحة في صفحات المحاضرات المفتوحة في مساحة الدراسة.';
export const NO_ASK_HOST_AR = 'السؤال عن الكتابة يحتاج لوحة الدراسة السياقية بجانب صفحة من محاضرة.';
