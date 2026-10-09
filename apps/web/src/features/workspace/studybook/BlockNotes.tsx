// The owner's notes on Study Book paragraphs (§24, §25, AC-22). A note is anchored SEMANTICALLY to a block —
// {lineage_id, block_key} — not to a position, so it stays attached when a regenerated version keeps that block
// (same section + source regions + kind). A note whose block is not in the version shown is listed as needing
// re-anchoring: it is never moved to another paragraph and never deleted. Notes are written to this device first
// (IndexedDB + outbox) and synced; they are the owner's writing, not evidence.
import { useMemo, useState } from 'react';
import { NotebookPen } from 'lucide-react';
import { richTextFromPlain, richTextToPlain, type AnnotationAnchor, type ContentBlockView, type RichText } from '@medlevo/shared';
import { Button, StatusPill, TextArea, useToast } from '../../../design';
import { getDb } from '../../../lib/localdb';
import { useLive } from '../data/hooks';
import { saveNote, type WorkspaceNoteRow } from '../data/local';
import { shortQuote } from '../../studybook/model';

export interface BlockNotesProps {
  lineageId: string;
  versionNo: number;
  blocks: readonly ContentBlockView[];
  /** the block at the top of the book view (where a new note goes) */
  topBlockKey: string | null;
  onJump: (blockKey: string) => void;
}

export function blockText(b: ContentBlockView | undefined): string {
  if (!b) return '';
  return richTextToPlain(b.content).replace(/\s+/g, ' ').trim();
}

function noteText(n: WorkspaceNoteRow): string {
  const body = n.body as RichText | null;
  return body && Array.isArray(body.paragraphs) ? richTextToPlain(body) : '';
}

export function BlockNotes({ lineageId, versionNo, blocks, topBlockKey, onJump }: BlockNotesProps) {
  const toast = useToast();
  const prefix = `artifact_block:${lineageId}:`;
  const notes = useLive<WorkspaceNoteRow[]>(
    async () => {
      const rows = (await getDb().notes.where('anchorKey').startsWith(prefix).toArray()) as WorkspaceNoteRow[];
      return rows.filter((n) => !n.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    [prefix],
    [],
  );
  const byKey = useMemo(() => new Map(blocks.map((b) => [b.block_key, b])), [blocks]);
  // a note goes on a content block (headings are not paragraphs to annotate)
  const target = useMemo(() => {
    const top = topBlockKey ? byKey.get(topBlockKey) : undefined;
    if (top && top.kind !== 'heading') return top;
    const sorted = [...blocks].sort((a, b) => a.ord - b.ord);
    const i = top ? sorted.findIndex((b) => b.block_key === top.block_key) : -1;
    return sorted.slice(Math.max(0, i)).find((b) => b.kind !== 'heading') ?? null;
  }, [topBlockKey, byKey, blocks]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!target || !text.trim()) return;
    setBusy(true);
    try {
      const anchor: AnnotationAnchor = { type: 'block', lineage_id: lineageId, artifact_version: versionNo, block_key: target.block_key, quote: { exact: shortQuote(blockText(target), 300) } };
      await saveNote(getDb(), { body: richTextFromPlain(text.trim()), anchor, title: null });
      setText('');
      toast.show({ title: 'حُفظت الملاحظة على هذا الجهاز، وتُزامن عند الاتصال. تبقى مرتبطة بهذه الفقرة في النسخ اللاحقة إن بقيت.', tone: 'success' });
    } catch {
      toast.show({ title: 'تعذّر حفظ الملاحظة على هذا الجهاز. تحقق من مساحة التخزين ثم أعد المحاولة.', tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const keyOf = (n: WorkspaceNoteRow) => (n.anchorKey ?? '').slice(prefix.length);
  return (
    <details className="sb-versions sb-blocknotes">
      <summary>{notes.length ? `ملاحظاتي على هذا الكتاب (${notes.length})` : 'ملاحظاتي على هذا الكتاب'}</summary>
      {notes.length > 0 && (
        <ul role="list">
          {notes.map((n) => {
            const k = keyOf(n);
            const b = byKey.get(k);
            return (
              <li key={n.id} className="sb-blocknote">
                <p className="sb-blocknote__text">{shortQuote(noteText(n), 240)}</p>
                {b ? (
                  <Button size="sm" variant="plain" onClick={() => onJump(k)}>
                    {`على: «${shortQuote(blockText(b), 60)}»`}
                  </Button>
                ) : (
                  <StatusPill tone="warning">فقرتها ليست في هذه النسخة — تحتاج إعادة ربط (لم تُنقل)</StatusPill>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="sb-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="sb-muted">{target ? `تُربط الملاحظة بالفقرة الظاهرة أعلى الكتاب: «${shortQuote(blockText(target), 90)}»` : 'لا توجد فقرة لربط ملاحظة بها بعد.'}</p>
        <TextArea label="ملاحظة على هذه الفقرة" rows={2} value={text} onChange={(e) => setText(e.target.value)} disabled={!target} />
        <div className="sb-row">
          <Button type="submit" size="sm" variant="secondary" icon={<NotebookPen size={16} />} loading={busy} disabled={!target || !text.trim()}>
            احفظ الملاحظة
          </Button>
        </div>
      </form>
    </details>
  );
}
