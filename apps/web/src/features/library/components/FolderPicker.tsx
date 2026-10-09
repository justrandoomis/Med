// Destination picker (move / upload / restore): the library tree as one radio group, indented by
// depth. Native radios give keyboard support (arrows move, Space selects) on every platform.
// Destinations that would create a cycle are disabled WITH the reason.
import { useId, useMemo, useState } from 'react';
import { Folder } from 'lucide-react';
import { LIBRARY_NODE_KIND_LABELS_AR, normalizeForSearch, type LibraryNodeView } from '@medlevo/shared';
import { Button, Dialog, TextField } from '../../../design';
import { errorMessage } from '../../../lib/api';
import { childrenOf, type LibraryIndex, pathOf } from '../model';
import { folderTone } from './Cover';

interface Row {
  node: LibraryNodeView | null;
  depth: number;
}

function flatten(index: LibraryIndex): Row[] {
  const out: Row[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of childrenOf(index, parent, 'manual')) {
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export interface FolderPickerProps {
  index: LibraryIndex;
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  /** offer «the library itself» (root) as a destination */
  allowRoot?: boolean;
  /** return a reason to disable a destination */
  disabledReason?: (node: LibraryNodeView) => string | null;
  label: string;
}

export function FolderPicker({ index, value, onChange, allowRoot, disabledReason, label }: FolderPickerProps) {
  const name = useId();
  const [q, setQ] = useState('');
  const rows = useMemo(() => flatten(index), [index]);
  const filtered = useMemo(() => {
    const tokens = normalizeForSearch(q).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return rows;
    return rows.filter((r) => r.node && tokens.every((t) => normalizeForSearch(r.node!.title).includes(t)));
  }, [rows, q]);
  const searching = q.trim().length > 0;
  return (
    <div className="ml-stack" style={{ ['--ml-stack-gap' as string]: 'var(--ml-space-2)' }}>
      {rows.length > 8 && <TextField label="ابحث عن مجلد" type="search" value={q} onChange={(e) => setQ(e.target.value)} dir="auto" />}
      <fieldset className="ml-fieldset">
        <legend className="ml-visually-hidden">{label}</legend>
        <div className="ml-picker">
          {allowRoot && !searching && (
            <label className="ml-picker__row" style={{ ['--depth' as string]: 0 }}>
              <input type="radio" name={name} checked={value === null} onChange={() => onChange(null)} />
              <span>المكتبة (المستوى الأعلى)</span>
            </label>
          )}
          {filtered.map(({ node, depth }) => {
            const n = node!;
            const why = disabledReason?.(n) ?? null;
            const path = searching ? pathOf(index, n.parent_id).map((p) => p.title).join(' / ') : '';
            return (
              <label key={n.id} className="ml-picker__row" style={{ ['--depth' as string]: searching ? 0 : depth }}>
                <input type="radio" name={name} checked={value === n.id} disabled={!!why} onChange={() => onChange(n.id)} aria-describedby={why ? `${name}-${n.id}` : undefined} />
                <span className="ml-row__icon" data-color={folderTone(n)} aria-hidden="true" style={{ width: '1.5rem', height: '1.5rem' }}>
                  <Folder size={14} />
                </span>
                <span className="ml-row__text">
                  <span className="ml-row__title"><bdi>{n.title}</bdi></span>
                  <span className="ml-row__sub">{path ? <bdi>{path}</bdi> : LIBRARY_NODE_KIND_LABELS_AR[n.kind]}</span>
                </span>
                {why && (
                  <span id={`${name}-${n.id}`} className="ml-picker__why">
                    {why}
                  </span>
                )}
              </label>
            );
          })}
          {filtered.length === 0 && !allowRoot && <p className="ml-group__row">لا توجد مجلدات بعد. أنشئ دفترًا أو مجلدًا أولًا.</p>}
          {filtered.length === 0 && searching && <p className="ml-group__row">لا يوجد مجلد بهذا الاسم.</p>}
        </div>
      </fieldset>
    </div>
  );
}

/** Move a node or a source to another folder (the keyboard alternative to drag & drop). */
export function MoveDialog({
  open,
  title,
  index,
  initial,
  allowRoot,
  disabledReason,
  confirmLabel = 'نقل إلى هنا',
  requireChange = true,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  index: LibraryIndex;
  /** the preselected destination (the current place when moving) */
  initial: string | null;
  allowRoot: boolean;
  disabledReason?: (node: LibraryNodeView) => string | null;
  confirmLabel?: string;
  /**
   * true (moving): confirming the preselected place would be a no-op, so a different one must be
   * chosen. false (restoring, choosing a destination): the preselected place itself is a valid answer.
   */
  requireChange?: boolean;
  onConfirm: (target: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effective = target === undefined ? initial : target;
  const cannotConfirm = (requireChange && effective === initial) || (effective === null && !allowRoot);
  const run = async () => {
    if (cannotConfirm) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(effective);
      setTarget(undefined);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (busy) return;
    setTarget(undefined);
    setError(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={run} loading={busy} disabled={cannotConfirm} loadingLabel="جارٍ النقل…">
            {confirmLabel}
          </Button>
        </>
      }
    >
      <FolderPicker index={index} value={effective} onChange={setTarget} allowRoot={allowRoot} disabledReason={disabledReason} label={title} />
      {error && (
        <p className="ml-field__error" role="alert">
          {errorMessage(error)}
        </p>
      )}
    </Dialog>
  );
}
