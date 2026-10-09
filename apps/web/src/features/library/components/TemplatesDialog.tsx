// Optional study templates (§05): pick one, get a suggested skeleton you can change freely.
import { useEffect, useState } from 'react';
import type { FromTemplateResponse, LibraryNodeView, TemplatesResponse } from '@medlevo/shared';
import { Bidi, Button, Dialog, ErrorState, LoadingState, TextField } from '../../../design';
import { api, errorMessage } from '../../../lib/api';
import { mutate, useQuery } from '../data';
import { Cover } from './Cover';
import { IsolatedList } from '../labels';

export function TemplatesDialog({ open, parentId, onClose, onCreated }: { open: boolean; parentId: string | null; onClose: () => void; onCreated: (node: LibraryNodeView) => void }) {
  const q = useQuery<TemplatesResponse>(open ? '/library/templates' : null, { cache: true });
  const [picked, setPicked] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPicked(null);
      setTitle('');
      setError(null);
    }
  }, [open]);
  const tpl = q.data?.templates.find((t) => t.key === picked) ?? null;
  const create = async () => {
    if (!tpl) return;
    setBusy(true);
    setError(null);
    try {
      const res = await mutate(() => api.post<FromTemplateResponse>('/library/nodes/from-template', { template_key: tpl.key, parent_id: parentId, title: title.trim() || undefined }));
      onCreated(res.node);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="قوالب الدراسة"
      description="قالب اختياري يقترح مجلدات بداية لمادة. كل شيء قابل لإعادة التسمية والنقل والحذف بعد الإنشاء."
      size="lg"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={create} disabled={!tpl} loading={busy} loadingLabel="جارٍ الإنشاء…">
            {tpl ? `إنشاء «${title.trim() || tpl.title_ar}»` : 'اختر قالبًا'}
          </Button>
        </>
      }
    >
      {q.loading && !q.data && <LoadingState stage="جارٍ تحميل القوالب…" inline />}
      {q.error && !q.data && <ErrorState inline message={q.error.message} onRetry={() => void q.refresh()} />}
      {q.data && (
        <div className="ml-stack">
          <ul className="ml-templates" aria-label="القوالب المتاحة">
            {q.data.templates.map((t) => (
              <li key={t.key}>
                <button type="button" className="ml-template" aria-pressed={picked === t.key} onClick={() => setPicked(t.key)}>
                  <Cover cover={t.cover} title={t.title_ar} size="mini" />
                  <span className="ml-template__text">
                    <span className="ml-template__title">
                      {t.title_ar} <Bidi dir="ltr">({t.title_en})</Bidi>
                    </span>
                    <span className="ml-template__desc">{t.description_ar}</span>
                    {picked === t.key && (
                      <span className="ml-template__folders">
                        المجلدات المقترحة: <IsolatedList parts={t.skeleton.map((f) => f.title)} />
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {tpl && <TextField label="اسم المادة" hint="اتركه فارغًا لاستخدام اسم القالب." value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tpl.title_ar} dir="auto" />}
          {error && (
            <p className="ml-field__error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
