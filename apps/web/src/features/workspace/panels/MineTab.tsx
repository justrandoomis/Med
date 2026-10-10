// «ملاحظاتي»: notes on this source (local-first; save status per note), bookmarks, and writing that
// «تحتاج إعادة ربط» (§25: never deleted, never moved silently — listed with where it used to be).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkMinus, BookmarkPlus, FilePlus2, FileText, MapPin, NotebookPen, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import {
  detectDir,
  newId,
  richTextFromPlain,
  richTextToPlain,
  segmentRuns,
  stripBidiControls,
  type AnnotationAnchor,
  type NeedsReanchorItem,
  type Paragraph,
  type RichText,
  type TextQuote,
} from '@medlevo/shared';
import { Button, ConfirmDialog, EmptyState, IconButton, RichTextView, SaveStatus, SegmentedControl, StatusPill, TextArea, Tooltip, cx } from '../../../design';
import { getDb, type AnnotationRow } from '../../../lib/localdb';
import { useEntitySyncState } from '../../../lib/sync';
import { fetchNeedsReanchor, fetchNotes } from '../data/api';
import { useAnnotationsOfKind, useLocalNeedsReanchor, useNotes } from '../data/hooks';
import { createAnnotation, deleteAnnotation, deleteNote, mergeServerNotes, saveNote, type WorkspaceNoteRow } from '../data/local';
import { clearNoteDraft, writeNoteDraft } from '../data/noteDrafts';
import type { SourceDocument } from '../data/useSourceDocument';
import { fullPageLabel } from '../model/pages';

export type MineTabValue = 'notes' | 'bookmarks' | 'reanchor' | 'pages';

/** The note pages inserted in this source (track F1): open one, restore a trashed one, add one here. */
export interface MineNotePages {
  live: ReadonlyArray<{ id: string; label: string }>;
  trashed: ReadonlyArray<{ id: string; label: string }>;
  onGo: (id: string) => void;
  onRestore: (id: string) => void;
  onNew: () => void;
}

export interface NoteDraft {
  pageIndex: number;
  quote: TextQuote | null;
}

export interface MineTabProps {
  doc: SourceDocument;
  pageIndex: number;
  sub: MineTabValue;
  onSub: (v: MineTabValue) => void;
  draft: NoteDraft | null;
  onDraftConsumed: () => void;
  anchorFor: (pageIndex: number) => AnnotationAnchor | null;
  onGoToPage: (pageIndex: number) => void;
  online: boolean;
  notePages?: MineNotePages;
}

export function MineTab(p: MineTabProps) {
  const pageKeys = useMemo(() => p.doc.pages.map((pg) => `source_page:${pg.id}`), [p.doc.pages]);
  const reanchorLocal = useLocalNeedsReanchor(pageKeys);
  return (
    <div className="wk-rail-section">
      <SegmentedControl<MineTabValue>
        label="أقسام ملاحظاتي"
        size="sm"
        fullWidth
        value={p.sub}
        onValueChange={p.onSub}
        options={[
          { value: 'notes', label: 'الملاحظات' },
          { value: 'bookmarks', label: 'العلامات' },
          { value: 'reanchor', label: reanchorLocal.length ? `إعادة ربط (${reanchorLocal.length})` : 'إعادة ربط' },
          ...(p.notePages ? [{ value: 'pages' as const, label: p.notePages.live.length ? `صفحات (${p.notePages.live.length})` : 'صفحات' }] : []),
        ]}
      />
      {p.sub === 'notes' && <NotesSection {...p} pageKeys={pageKeys} />}
      {p.sub === 'bookmarks' && <BookmarksSection doc={p.doc} pageIndex={p.pageIndex} pageKeys={pageKeys} anchorFor={p.anchorFor} onGoToPage={p.onGoToPage} />}
      {p.sub === 'reanchor' && <ReanchorSection doc={p.doc} local={reanchorLocal} online={p.online} onGoToPage={p.onGoToPage} />}
      {p.sub === 'pages' && p.notePages && <NotePagesSection pages={p.notePages} />}
    </div>
  );
}

// ───────────────────────────── note pages (track F1) ─────────────────────────────
function NotePagesSection({ pages }: { pages: MineNotePages }) {
  return (
    <>
      <div className="wk-rail-actions">
        <Button size="sm" variant="secondary" icon={<FilePlus2 size={16} />} onClick={pages.onNew}>
          صفحة ملاحظات بعد هذه الصفحة
        </Button>
      </div>
      <h3 className="wk-rail-h">صفحات الملاحظات في هذا المصدر</h3>
      {pages.live.length === 0 ? (
        <p className="wk-muted">لا صفحات ملاحظات بعد. أضف صفحة ورقية (فارغة أو مسطّرة أو منقّطة أو مربعات) بين صفحات المحاضرة واكتب عليها بالقلم.</p>
      ) : (
        <ul className="wk-marks" role="list">
          {pages.live.map((n) => (
            <li key={n.id}>
              <button type="button" className="wk-mark-row" onClick={() => pages.onGo(n.id)}>
                <FileText size={16} aria-hidden="true" />
                <bdi>{n.label}</bdi>
              </button>
            </li>
          ))}
        </ul>
      )}
      {pages.trashed.length > 0 && (
        <>
          <h3 className="wk-rail-h">المحذوفة</h3>
          <ul className="wk-marks" role="list">
            {pages.trashed.map((n) => (
              <li key={n.id} className="wk-mark-row wk-mark-row--static">
                <bdi>{n.label}</bdi>
                <Button size="sm" variant="plain" icon={<RotateCcw size={14} />} onClick={() => pages.onRestore(n.id)}>
                  استعادة
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

// ───────────────────────────── notes ─────────────────────────────
function quoteParagraph(q: TextQuote): Paragraph {
  const dir = detectDir(q.exact);
  return { dir, kind: 'quote', runs: segmentRuns(q.exact, dir) };
}

/** comparable text of a note (the server strips bidi controls, so they never count as a change) */
function noteText(body: RichText): string {
  return stripBidiControls(richTextToPlain(body));
}

function ownText(body: RichText): string {
  return richTextToPlain({ v: 1, paragraphs: body.paragraphs.filter((x) => x.kind !== 'quote') });
}

function NotesSection({ doc, pageIndex, pageKeys, draft, onDraftConsumed, anchorFor, onGoToPage, online }: MineTabProps & { pageKeys: string[] }) {
  const notes = useNotes(pageKeys);
  const [editing, setEditing] = useState<{ id: string | null; pageIndex: number; quote: TextQuote | null } | null>(null);
  const pageById = useMemo(() => new Map(doc.pages.map((pg) => [pg.id, pg])), [doc.pages]);

  // seed this device with the server's notes for the source (rows with local edits are never overwritten)
  useEffect(() => {
    if (!online) return;
    void fetchNotes(doc.detail.id)
      .then((r) => mergeServerNotes(getDb(), r.notes))
      .catch(() => undefined);
  }, [doc.detail.id, online]);

  useEffect(() => {
    if (!draft) return;
    setEditing({ id: null, pageIndex: draft.pageIndex, quote: draft.quote });
    onDraftConsumed();
  }, [draft, onDraftConsumed]);

  const currentKey = pageKeys[pageIndex];
  const here = notes.filter((n) => n.anchorKey === currentKey);
  const elsewhere = notes.filter((n) => n.anchorKey !== currentKey);
  const pageOf = (n: WorkspaceNoteRow) => {
    const a = n.anchor as AnnotationAnchor | null;
    return a?.type === 'page' ? pageById.get(a.page_id) ?? null : null;
  };

  return (
    <>
      <div className="wk-rail-actions">
        <Button size="sm" variant="secondary" icon={<NotebookPen size={16} />} onClick={() => setEditing({ id: null, pageIndex, quote: null })} disabled={!!editing && editing.id === null}>
          ملاحظة على هذه الصفحة
        </Button>
      </div>
      {editing && (
        <NoteEditor
          key={editing.id ?? `new-${editing.pageIndex}`}
          existing={editing.id ? (notes.find((n) => n.id === editing.id) ?? null) : null}
          anchor={anchorFor(editing.pageIndex)}
          quote={editing.quote}
          pageLabel={doc.pages[editing.pageIndex] ? fullPageLabel(doc.pages[editing.pageIndex]!) : ''}
          onClose={() => setEditing(null)}
        />
      )}
      <h3 className="wk-rail-h">على هذه الصفحة</h3>
      {here.length === 0 ? (
        <p className="wk-muted">لا ملاحظات على هذه الصفحة بعد.</p>
      ) : (
        <ul className="wk-notes" role="list">
          {here.map((n) => (
            <NoteCard key={n.id} note={n} pageLabel={null} onEdit={() => setEditing({ id: n.id, pageIndex, quote: null })} onGo={null} />
          ))}
        </ul>
      )}
      {elsewhere.length > 0 && (
        <>
          <h3 className="wk-rail-h">في صفحات أخرى من هذا الإصدار</h3>
          <ul className="wk-notes" role="list">
            {elsewhere.map((n) => {
              const pg = pageOf(n);
              return (
                <NoteCard
                  key={n.id}
                  note={n}
                  pageLabel={pg ? fullPageLabel(pg) : null}
                  onEdit={() => setEditing({ id: n.id, pageIndex: pg?.page_index ?? pageIndex, quote: null })}
                  onGo={pg ? () => onGoToPage(pg.page_index) : null}
                />
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

export function NoteCard({ note, pageLabel, onEdit, onGo }: { note: WorkspaceNoteRow; pageLabel: string | null; onEdit: () => void; onGo: (() => void) | null }) {
  const state = useEntitySyncState('note', note.id);
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="wk-note">
      <div className="wk-note__head">
        {pageLabel && onGo ? (
          <Button size="sm" variant="plain" icon={<MapPin size={14} />} onClick={onGo}>
            {pageLabel}
          </Button>
        ) : (
          <span />
        )}
        {note.conflictOfId && <StatusPill tone="warning">نسخة محفوظة من تعارض</StatusPill>}
        {/* §28: a saved AI answer stays visibly generated in the list, even if its own label paragraph was edited away */}
        {note.origin === 'ai_answer' && <StatusPill tone="info">إجابة مولَّدة محفوظة — ليست مصدرًا</StatusPill>}
        <SaveStatus state={state ?? 'synced'} compact />
      </div>
      <RichTextView value={note.body as RichText} variant="ui" className="wk-note__body" />
      <div className="wk-note__actions">
        <Tooltip content="تعديل الملاحظة" describe={false}>
          <IconButton label="تعديل الملاحظة" icon={<Pencil size={16} />} size="sm" onClick={onEdit} />
        </Tooltip>
        <Tooltip content="حذف الملاحظة" describe={false}>
          <IconButton label="حذف الملاحظة" icon={<Trash2 size={16} />} size="sm" onClick={() => setConfirm(true)} />
        </Tooltip>
      </div>
      <ConfirmDialog
        open={confirm}
        onCancel={() => setConfirm(false)}
        title="حذف الملاحظة؟"
        impact="تُحذف هذه الملاحظة من هذا الجهاز ثم من أجهزتك الأخرى بعد المزامنة. إذا كانت قد عُدّلت من جهاز آخر في الوقت نفسه فسيُحتفظ بالنص المعدّل."
        confirmLabel="حذف الملاحظة"
        destructive
        onConfirm={async () => {
          await deleteNote(getDb(), note);
          setConfirm(false);
        }}
      />
    </li>
  );
}

/**
 * Note editor: every change is written to this device (debounced) and synced through the outbox.
 * Writing is never lost: the last keystrokes are flushed when the editor closes for any reason (another
 * note opened, the rail tab or sheet closed, the reader left), and saves run one after another so a
 * new note is created once — never twice by two overlapping saves. A reload or a crashed tab never closes
 * the editor, so every keystroke is also backed up synchronously (data/noteDrafts.ts) and recovered on the
 * next load (I2: text typed right before a reload was lost).
 */
export function NoteEditor({ existing, anchor, quote, pageLabel, onClose }: { existing: WorkspaceNoteRow | null; anchor: AnnotationAnchor | null; quote: TextQuote | null; pageLabel: string; onClose: () => void }) {
  const [text, setText] = useState(() => (existing ? ownText(existing.body as RichText) : ''));
  const rowRef = useRef<WorkspaceNoteRow | null>(existing);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(text);
  /** typed but not yet handed to a save */
  const dirty = useRef(false);
  /** saves are serialized: a save starts after the previous one wrote its row */
  const chain = useRef<Promise<void>>(Promise.resolve());
  const [savedId, setSavedId] = useState<string | null>(existing?.id ?? null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const state = useEntitySyncState('note', savedId);
  const quotes = useMemo(() => {
    if (existing) return (existing.body as RichText).paragraphs.filter((x) => x.kind === 'quote');
    return quote ? [quoteParagraph(quote)] : [];
  }, [existing, quote]);
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  /** text of the note as this editor last saw / wrote it (to notice another device's text arriving) */
  const lastSeen = useRef<string | null>(existing ? noteText(existing.body as RichText) : null);
  /** id a NEW note is saved under — known before the first save, so a recovered draft lands on the same note */
  const newNoteId = useRef<string>(existing?.id ?? newId());
  /** this editor's crash-safe draft (localStorage) */
  const draftKey = useRef<string>(newId());

  const backup = (value: string) => {
    writeNoteDraft({
      key: draftKey.current,
      noteId: rowRef.current?.id ?? newNoteId.current,
      body: { v: 1, paragraphs: [...quotesRef.current, ...richTextFromPlain(value).paragraphs] },
      anchor: (rowRef.current?.anchor as AnnotationAnchor | null | undefined) ?? anchorRef.current,
      baseText: lastSeen.current,
    });
  };

  const write = async (value: string) => {
    const own = richTextFromPlain(value).paragraphs;
    if (own.length === 0 && quotesRef.current.length === 0) {
      clearNoteDraft(draftKey.current, '');
      return;
    }
    const body: RichText = { v: 1, paragraphs: [...quotesRef.current, ...own] };
    const db = getDb();
    let latestRow = rowRef.current ? ((await db.notes.get(rowRef.current.id)) as WorkspaceNoteRow | undefined) ?? rowRef.current : null;
    const anchorNow = (latestRow?.anchor as AnnotationAnchor | null | undefined) ?? anchorRef.current;
    if (latestRow && lastSeen.current !== null && !latestRow.deletedAt && noteText(latestRow.body as RichText) !== lastSeen.current) {
      // the note changed under this editor (another device's text arrived after a conflict was kept):
      // never write over it — keep both, and continue in a new note next to it
      latestRow = null;
    }
    // a new note uses the id its draft carries; a note continued after a conflict gets a fresh one
    const row = await saveNote(db, { id: rowRef.current === null ? newNoteId.current : undefined, body, anchor: anchorNow }, latestRow);
    rowRef.current = row;
    lastSeen.current = noteText(row.body as RichText);
    setSavedId(row.id);
    clearNoteDraft(draftKey.current, lastSeen.current); // kept when newer text was typed meanwhile
  };

  const persist = (value: string): Promise<void> => {
    dirty.current = false;
    const run = chain.current.then(() => write(value));
    chain.current = run.then(
      () => setSaveError(null),
      () => {
        dirty.current = true; // keep it for the next attempt (the text is still in the editor)
        setSaveError('تعذّر حفظ الملاحظة على هذا الجهاز. تحقق من مساحة التخزين؛ النص ما زال في المحرر.');
      },
    );
    return chain.current;
  };

  // closing the editor in any way flushes what was typed (the debounce must never drop writing)
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (dirty.current) void persist(latest.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="wk-note-editor">
      {quotes.length > 0 && <RichTextView value={{ v: 1, paragraphs: quotes }} className="wk-note-editor__quote" />}
      <TextArea
        label={existing ? 'تعديل الملاحظة' : `ملاحظة جديدة — ${pageLabel}`}
        hint="تُحفظ على هذا الجهاز أثناء الكتابة، ثم تُزامَن."
        error={saveError ?? undefined}
        value={text}
        rows={4}
        autoFocus
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          latest.current = v;
          dirty.current = true;
          backup(v);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void persist(v), 600);
        }}
      />
      <div className="wk-note-editor__foot">
        {savedId ? <SaveStatus state={state ?? 'saved_locally'} live /> : <span className="wk-muted">لم يُحفظ شيء بعد</span>}
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            window.clearTimeout(timer.current);
            await persist(latest.current);
            if (!dirty.current) onClose();
          }}
        >
          تم
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────────── bookmarks ─────────────────────────────
export function BookmarksSection({ doc, pageIndex, pageKeys, anchorFor, onGoToPage, compact }: { doc: SourceDocument; pageIndex: number; pageKeys: string[]; anchorFor: (i: number) => AnnotationAnchor | null; onGoToPage: (i: number) => void; compact?: boolean }) {
  const marks = useAnnotationsOfKind(pageKeys, 'bookmark');
  const current = marks.find((m) => m.targetKey === pageKeys[pageIndex]);
  const indexByKey = useMemo(() => new Map(pageKeys.map((k, i) => [k, i])), [pageKeys]);
  const toggle = async () => {
    if (current) {
      await deleteAnnotation(getDb(), current);
      return;
    }
    const anchor = anchorFor(pageIndex);
    if (!anchor) return;
    await createAnnotation(getDb(), { kind: 'bookmark', anchor, data: { v: 1 }, layer: 'text' });
  };
  const sorted = [...marks].sort((a, b) => (indexByKey.get(a.targetKey) ?? 0) - (indexByKey.get(b.targetKey) ?? 0));
  return (
    <>
      {!compact && (
        <div className="wk-rail-actions">
          <Button size="sm" variant="secondary" icon={current ? <BookmarkMinus size={16} /> : <BookmarkPlus size={16} />} onClick={() => void toggle()}>
            {current ? 'إزالة علامة هذه الصفحة' : 'ضع علامة على هذه الصفحة'}
          </Button>
        </div>
      )}
      {sorted.length === 0 ? (
        <EmptyState headingLevel={3} icon={<Bookmark size={22} />} title="لا علامات بعد" description="ضع علامة على الصفحات التي تريد الرجوع إليها بسرعة." />
      ) : (
        <ul className="wk-marks" role="list">
          {sorted.map((m: AnnotationRow) => {
            const i = indexByKey.get(m.targetKey) ?? 0;
            const pg = doc.pages[i];
            return (
              <li key={m.id}>
                <button type="button" className={cx('wk-mark-row', i === pageIndex && 'wk-mark-row--current')} aria-current={i === pageIndex ? 'page' : undefined} onClick={() => onGoToPage(i)}>
                  <Bookmark size={16} aria-hidden="true" />
                  <span>{pg ? fullPageLabel(pg) : `الصفحة ${i + 1} في الملف`}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ───────────────────────────── needs re-anchor ─────────────────────────────
function ReanchorSection({ doc, local, online, onGoToPage }: { doc: SourceDocument; local: AnnotationRow[]; online: boolean; onGoToPage: (i: number) => void }) {
  const [server, setServer] = useState<NeedsReanchorItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    fetchNeedsReanchor(doc.detail.id)
      .then((r) => !cancelled && setServer(r.items))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [doc.detail.id, online]);
  const pageIdx = useMemo(() => new Map(doc.pages.map((p) => [p.id, p.page_index])), [doc.pages]);
  const items = useMemo(() => {
    const byId = new Map<string, { id: string; kind: string; where: string | null; pageIndex: number | null }>();
    for (const it of server ?? []) {
      const prev = it.annotation.previous_anchor ?? it.annotation.anchor;
      byId.set(it.annotation.id, { id: it.annotation.id, kind: it.annotation.kind, where: it.previous_location_ar, pageIndex: prev.type === 'page' ? (pageIdx.get(prev.page_id) ?? null) : null });
    }
    for (const a of local) {
      if (byId.has(a.id)) continue;
      const anchor = a.anchor as AnnotationAnchor;
      const i = anchor?.type === 'page' ? (pageIdx.get(anchor.page_id) ?? null) : null;
      byId.set(a.id, { id: a.id, kind: a.kind, where: i != null && doc.pages[i] ? fullPageLabel(doc.pages[i]!) : null, pageIndex: i });
    }
    return [...byId.values()];
  }, [server, local, pageIdx, doc.pages]);

  return (
    <>
      <p className="wk-muted">
        عندما يتغير المصدر أو تخطيطه ولا يمكن إعادة ربط كتابة أو ملاحظة بثقة، تظهر هنا مع مكانها السابق. لا يُحذف شيء ولا يوضع فوق فقرة أخرى. إعادة الربط اليدوي تصل في مرحلة لاحقة.
      </p>
      {!online && server === null && <p className="wk-muted">دون اتصال: تُعرض القائمة المحفوظة على هذا الجهاز فقط.</p>}
      {failed && <p className="wk-muted">تعذّر جلب القائمة من الخادم؛ تُعرض العناصر المحفوظة على هذا الجهاز.</p>}
      {items.length === 0 ? (
        <EmptyState headingLevel={3} title="لا شيء يحتاج إعادة ربط" description="كل كتاباتك وملاحظاتك على هذا المصدر في مواضعها." />
      ) : (
        <ul className="wk-marks" role="list">
          {items.map((it) => (
            <li key={it.id} className="wk-region-row">
              <div className="wk-region-row__head">
                <span className="wk-region-row__kind">{it.kind === 'ink' ? 'كتابة بالقلم' : it.kind === 'text_highlight' ? 'تظليل نص' : it.kind === 'bookmark' ? 'علامة' : 'تعليق'}</span>
                <StatusPill tone="warning">تحتاج إعادة ربط</StatusPill>
              </div>
              <p className="wk-muted">مكانها السابق: {it.where ?? 'غير معروف'}</p>
              {it.pageIndex != null && (
                <Button size="sm" variant="plain" icon={<MapPin size={16} />} onClick={() => onGoToPage(it.pageIndex!)}>
                  فتح الصفحة السابقة
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
