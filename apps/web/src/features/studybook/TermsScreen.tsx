// Terminology dictionary (§21) — /terms. The owner's own medical terms: English term, abbreviation, synonyms,
// Arabic explanation, accepted translation and the owner's preferred rendering. Used in explanation prompts
// (preferred renderings) and by search / retrieval expansion (synonyms, abbreviations). It NEVER edits source
// text. Nothing is seeded: an empty dictionary means no expansion. Data lives on the server (/api/studybook/terms).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookA, Pencil, Plus, Trash2 } from 'lucide-react';
import type { MedicalTermView } from '@medlevo/shared';
import { Bidi, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, IconButton, LoadingState, StatusPill, Term, TextArea, TextField, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { usePageTitle } from '../../lib/usePageTitle';
import { studybookApi } from './api';
import { EMPTY_TERM_FORM, TERM_ORIGIN_LABELS_AR, termFormFrom, termInputFrom, termMatches, validateTermForm, type TermForm } from './model';
import './studybook-screens.css';

type Load = { status: 'loading' } | { status: 'ready'; terms: MedicalTermView[] } | { status: 'error'; message: string };

export function TermsScreen() {
  usePageTitle('قاموس المصطلحات');
  const online = useOnline();
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ id: string | null; form: TermForm } | null>(null);
  const [deleting, setDeleting] = useState<MedicalTermView | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  const reload = async () => {
    setLoad((l) => (l.status === 'ready' ? l : { status: 'loading' }));
    try {
      const r = await studybookApi.terms();
      setLoad({ status: 'ready', terms: r.terms });
    } catch (e) {
      setLoad({ status: 'error', message: errorMessage(e, 'تعذّر تحميل قاموس المصطلحات.') });
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const terms = useMemo(() => (load.status === 'ready' ? load.terms : []), [load]);
  const shown = useMemo(() => terms.filter((t) => termMatches(t, query)), [terms, query]);

  return (
    <div className="ml-page ml-page--narrow sbx-page">
      <header className="ml-page__header">
        <h1 className="ml-page__title">قاموس المصطلحات</h1>
        <p className="ml-page__lede">مصطلحاتك وترجماتك المفضلة. تُستعمل في صياغة الشروح وفي البحث بالمرادفات والاختصارات، ولا تغيّر نص المصادر أبدًا.</p>
      </header>

      {!online && <p className="sbx-note" role="note">لا يوجد اتصال: القاموس محفوظ على الخادم، فلا يمكن تعديله الآن.</p>}

      <div className="sbx-toolbar">
        <TextField label="ابحث في القاموس" hideLabel placeholder="ابحث بالمصطلح أو الاختصار أو الترجمة" type="search" value={query} onChange={(e) => setQuery(e.target.value)} fieldClassName="sbx-search" />
        <Button ref={addButton} variant="primary" icon={<Plus size={16} />} disabled={!online || load.status !== 'ready'} onClick={() => setEditing({ id: null, form: { ...EMPTY_TERM_FORM } })}>
          أضف مصطلحًا
        </Button>
      </div>

      {load.status === 'loading' && <LoadingState stage="جارٍ تحميل القاموس…" />}
      {load.status === 'error' && <ErrorState message={load.message} onRetry={() => void reload()} />}
      {load.status === 'ready' && terms.length === 0 && (
        <EmptyState
          icon={<BookA size={28} />}
          title="القاموس فارغ"
          description={
            <>
              لم تُضف أي مصطلح بعد، ولا يأتي القاموس بمصطلحات جاهزة. أضف مثلًا <Term>McBurney&apos;s point</Term> مع ترجمتك المفضلة، فتظهر في الشروح كما تحب ويجده البحث بمرادفاته.
            </>
          }
          actions={
            <Button variant="secondary" icon={<Plus size={16} />} disabled={!online} onClick={() => setEditing({ id: null, form: { ...EMPTY_TERM_FORM } })}>
              أضف أول مصطلح
            </Button>
          }
        />
      )}
      {load.status === 'ready' && terms.length > 0 && (
        <>
          <p className="sbx-count" aria-live="polite">
            {query.trim() ? `${shown.length} من ${terms.length}` : termsCountAr(terms.length)}
          </p>
          {shown.length === 0 ? (
            <p className="sbx-note">لا يطابق البحث أي مصطلح.</p>
          ) : (
            <ul className="ml-group sbx-terms" role="list" aria-label="المصطلحات">
              {shown.map((t) => (
                <li key={t.id} className="ml-group__row sbx-term">
                  <div className="sbx-term__main">
                    <p className="sbx-term__title">
                      <Term>{t.term_en}</Term>
                      {t.abbreviation && (
                        <>
                          {' '}
                          <span className="sbx-term__abbr">
                            (<Term>{t.abbreviation}</Term>)
                          </span>
                        </>
                      )}
                    </p>
                    {(t.owner_preferred_ar || t.accepted_translation_ar) && (
                      <p className="sbx-term__ar">
                        {t.owner_preferred_ar ? (
                          <>
                            <span className="sbx-term__key">ترجمتك:</span> <Bidi dir="rtl">{t.owner_preferred_ar}</Bidi>
                          </>
                        ) : null}
                        {t.owner_preferred_ar && t.accepted_translation_ar ? <span aria-hidden="true"> · </span> : null}
                        {t.accepted_translation_ar ? (
                          <>
                            <span className="sbx-term__key">المعتمدة:</span> <Bidi dir="rtl">{t.accepted_translation_ar}</Bidi>
                          </>
                        ) : null}
                      </p>
                    )}
                    {t.synonyms.length > 0 && (
                      <p className="sbx-term__syn">
                        <span className="sbx-term__key">مرادفات:</span>{' '}
                        {t.synonyms.map((s, i) => (
                          <span key={s}>
                            {i > 0 ? '، ' : ''}
                            <Term>{s}</Term>
                          </span>
                        ))}
                      </p>
                    )}
                    {t.explanation_ar && <p className="sbx-term__exp">{t.explanation_ar}</p>}
                  </div>
                  <div className="sbx-term__side">
                    {t.origin !== 'owner' && <StatusPill tone="neutral">{TERM_ORIGIN_LABELS_AR[t.origin]}</StatusPill>}
                    <IconButton size="sm" label={`عدّل ${t.term_en}`} icon={<Pencil size={16} />} disabled={!online} onClick={() => setEditing({ id: t.id, form: termFormFrom(t) })} />
                    <IconButton size="sm" label={`احذف ${t.term_en}`} icon={<Trash2 size={16} />} disabled={!online} onClick={() => setDeleting(t)} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <p className="sbx-footer">
        تُطبَّق الترجمات المفضلة على الشروح الجديدة فقط؛ الشروح المحفوظة لا تتغير. يمكنك أيضًا ضبط <Link to="/explanation-rules">قواعد الشرح</Link>.
      </p>

      {editing && (
        <TermDialog
          key={editing.id ?? 'new'}
          initial={editing.form}
          editingId={editing.id}
          existing={terms}
          onClose={() => setEditing(null)}
          onSaved={(term, created) => {
            setLoad((l) => (l.status === 'ready' ? { status: 'ready', terms: upsert(l.terms, term) } : l));
            setEditing(null);
            toast.show({ title: created ? `أُضيف «${term.term_en}» إلى قاموسك.` : `حُفظ تعديل «${term.term_en}».`, tone: 'success' });
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={deleting ? `حذف «${deleting.term_en}» من القاموس` : 'حذف مصطلح'}
        impact="لن يُستعمل في صياغة الشروح الجديدة ولا في توسيع البحث بمرادفاته. نص المصادر والشروح المحفوظة لا يتغير."
        confirmLabel="احذف المصطلح"
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await studybookApi.deleteTerm(deleting.id);
          setLoad((l) => (l.status === 'ready' ? { status: 'ready', terms: l.terms.filter((x) => x.id !== deleting.id) } : l));
          toast.show({ title: `حُذف «${deleting.term_en}».`, tone: 'success' });
          setDeleting(null);
          addButton.current?.focus();
        }}
      />
    </div>
  );
}

function termsCountAr(n: number): string {
  if (n === 1) return 'مصطلح واحد';
  if (n === 2) return 'مصطلحان';
  if (n >= 3 && n <= 10) return `${n} مصطلحات`;
  return `${n} مصطلحًا`;
}

function upsert(list: MedicalTermView[], t: MedicalTermView): MedicalTermView[] {
  const i = list.findIndex((x) => x.id === t.id);
  const next = i >= 0 ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t];
  return next.sort((a, b) => a.term_en.localeCompare(b.term_en, 'en', { sensitivity: 'base' }));
}

function TermDialog({
  initial,
  editingId,
  existing,
  onClose,
  onSaved,
}: {
  initial: TermForm;
  editingId: string | null;
  existing: MedicalTermView[];
  onClose: () => void;
  onSaved: (t: MedicalTermView, created: boolean) => void;
}) {
  const [form, setForm] = useState<TermForm>(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const errors = validateTermForm(form, existing, editingId);
  const shownErrors = tried ? errors : {};
  const set = (k: keyof TermForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    setTried(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setError(null);
    try {
      const body = termInputFrom(form);
      const r = editingId ? await studybookApi.updateTerm(editingId, body) : await studybookApi.createTerm(body);
      onSaved(r.term, !editingId);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر حفظ المصطلح.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={editingId ? 'تعديل مصطلح' : 'مصطلح جديد'}
      description="المصطلح الإنجليزي كما يرد في مصادرك. الحقول الأخرى اختيارية."
      initialFocusRef={first}
      dismissible={!busy}
      footer={
        <>
          <Button variant="plain" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button variant="primary" type="submit" form="sbx-term-form" loading={busy} loadingLabel="جارٍ الحفظ…">
            {editingId ? 'احفظ التعديل' : 'أضف إلى القاموس'}
          </Button>
        </>
      }
    >
      <form
        id="sbx-term-form"
        className="sbx-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField ref={first} label="المصطلح بالإنجليزية" required dir="ltr" lang="en" autoComplete="off" spellCheck={false} maxLength={200} value={form.term_en} onChange={set('term_en')} error={shownErrors.term_en} />
        <TextField label="الاختصار" hint="مثل CBC أو MI (اختياري)" dir="ltr" lang="en" autoComplete="off" spellCheck={false} maxLength={40} value={form.abbreviation} onChange={set('abbreviation')} error={shownErrors.abbreviation} />
        <TextArea label="المرادفات" hint="افصل بينها بفاصلة أو سطر جديد. تُستعمل لتوسيع البحث." dir="ltr" lang="en" rows={2} value={form.synonyms} onChange={set('synonyms')} />
        <TextField label="الترجمة العربية المعتمدة" maxLength={200} value={form.accepted_translation_ar} onChange={set('accepted_translation_ar')} />
        <TextField label="ترجمتك المفضلة" hint="تُفضَّل في الشروح الجديدة؛ لا تغيّر نص المصدر." maxLength={200} value={form.owner_preferred_ar} onChange={set('owner_preferred_ar')} />
        <TextArea label="شرح عربي قصير" hint="ملاحظتك أنت؛ لا تُعامل كدليل من المصادر." rows={3} maxLength={2000} value={form.explanation_ar} onChange={set('explanation_ar')} />
        {error && <ErrorState inline message={error} />}
      </form>
    </Dialog>
  );
}
