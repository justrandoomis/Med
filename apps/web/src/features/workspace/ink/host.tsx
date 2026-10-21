// What the screen around the ink engine provides (track F1): where page links lead and how to follow them, and which
// page is «current» for a pasted picture or the toolbar's «اختر صورة…». The reader and the notebook screen render
// <InkHost> inside their <InkProvider>; without it links are not offered (the tool stays out of the toolbar) and a
// pasted picture lands on the last page that was touched.
import { createContext, useContext, useEffect, useInsertionEffect, useMemo, useRef, type ReactNode } from 'react';
import type { AnnotationAnchor, LinkTarget, StudyMode } from '@medlevo/shared';
import { useInkInternal } from './InkProvider';
import { insertImage, startImageUploader } from './images';
import { onRehomed } from './layers/rehome';

export interface LinkChoice {
  target: LinkTarget;
  /** what the link says on the page (optional) */
  label?: string | null;
  /** the target as shown when linking, kept for display, e.g. «ص 12 — محاضرة الزائدة» */
  targetLabel?: string | null;
}

export interface InkLinkHost {
  /** ask the owner where a new link leads; null = cancelled */
  pickTarget(from: { targetKey: string; anchor: AnnotationAnchor }): Promise<LinkChoice | null>;
  /** follow a link (the host records a Back entry, §11) */
  open(target: LinkTarget, from: { targetKey: string; anchor: AnnotationAnchor }): void;
  /** the target's current name (a renamed note page …); null → the stored label */
  describe?(target: LinkTarget): string | null;
}

export interface InkHostValue {
  links: InkLinkHost | null;
  /** the page the owner is on (target key + anchor), for paste / «اختر صورة…» */
  currentPage: () => { targetKey: string; anchor: AnnotationAnchor; ar: number; pageWidthPt: number } | null;
  /** report a problem to the owner (polite live region of the host) */
  notify?: (message: string) => void;
  /**
   * (parity N1, G66) the study mode the screen is in, for the per-mode toolbars. Absent: the engine reads it from the
   * reader's mode switch; null: no study mode here (a notebook).
   */
  studyMode?: StudyMode | null;
  /**
   * (parity N1 wave 2, G67) host entries of the long-press page menu. Each is offered only when the screen provides it:
   * a note page after a lecture page (the reader), and on printed text «عرّف» (N3, the terms dictionary) and «أضف إلى
   * المراجعة» (N4). Note pages get «صفحة ملاحظات بعد هذه الصفحة» from the reader's own note-page actions.
   */
  pageMenu?: {
    newNotePageAfter?: (anchor: AnnotationAnchor) => void;
    define?: (q: { text: string; anchor: AnnotationAnchor; at: [number, number] }) => void;
    addToReview?: (q: { text: string; anchor: AnnotationAnchor; at: [number, number] }) => void;
  };
}

const InkHostContext = createContext<InkHostValue | null>(null);

export function useInkHost(): InkHostValue | null {
  return useContext(InkHostContext);
}

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'color'].includes((t as HTMLInputElement).type));
}

/**
 * Provides the host to every ink layer and handles pasting a picture (Ctrl/⌘ V with an image on the clipboard)
 * onto the current page. Starts the picture uploader (retries while the app is open).
 */
export function InkHost({ links, currentPage, notify, studyMode, pageMenu, children }: InkHostValue & { children: ReactNode }) {
  const { store, announce } = useInkInternal();
  const value = useMemo<InkHostValue>(() => ({ links, currentPage, notify, ...(studyMode !== undefined ? { studyMode } : {}), ...(pageMenu ? { pageMenu } : {}) }), [links, currentPage, notify, studyMode, pageMenu]);
  const ref = useRef(value);
  // the latest host value for the paste listener, written at commit (before any layout effect) rather than during render
  useInsertionEffect(() => {
    ref.current = value;
  });

  useEffect(() => {
    startImageUploader();
  }, []);

  // (P1-T2, ADR-0004 R2) writing the server refused on a read-only layer was re-created on «ملاحظاتي»: say so
  useEffect(
    () =>
      onRehomed((n) => {
        announce(n.message_ar);
        ref.current.notify?.(n.message_ar);
      }),
    [announce],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target) || document.querySelector('[aria-modal="true"]')) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) return;
      const here = ref.current.currentPage();
      const key = store.activeTargetKey ?? here?.targetKey ?? null;
      const page = key ? store.page(key) : undefined;
      const anchor = page?.anchor ?? (here && here.targetKey === key ? here.anchor : null);
      if (!key || !anchor) return;
      e.preventDefault();
      void insertImage({ store, targetKey: key, anchor, file: files[0]!, at: [0.5, 0.4], ar: page?.ar ?? here?.ar ?? 842 / 595, pageWidthPt: here?.pageWidthPt }).then((r) => {
        const msg = r.ok ? 'أُدرجت الصورة في الصفحة. حرّكها أو غيّر حجمها بأداة التحديد الحر.' : r.reason;
        announce(msg);
        if (!r.ok) ref.current.notify?.(r.reason);
      });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [store, announce]);

  return <InkHostContext.Provider value={value}>{children}</InkHostContext.Provider>;
}
