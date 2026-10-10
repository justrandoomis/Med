// /cases/new?kind=case|osce|viva and /cases/:caseId/edit — the owner writes a case BY HAND (no AI needed, §42):
// fixed patient facts, stages with decisions (appropriateness, the facts they reveal, an authored consequence, branch),
// a checklist (each item satisfied by decisions or by typed phrases), an OSCE station or viva questions, and an
// explanation for anything medical — with evidence the owner attaches from the case's sources (suggested by a
// deterministic search inside the chosen lecture). Saving creates a new version; the server validates everything and
// says what is missing. The unsaved draft is kept on this device so nothing typed is lost.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Link2, Plus, Save, Search, Trash2 } from 'lucide-react';
import {
  CASE_FACT_KINDS,
  CASE_FACT_KIND_LABELS_AR,
  CASE_KIND_LABELS_AR,
  CASE_STAGE_TYPES,
  CASE_STAGE_TYPE_LABELS_AR,
  CHECKLIST_CATEGORIES,
  CHECKLIST_CATEGORY_LABELS_AR,
  DECISION_APPROPRIATENESS,
  DECISION_APPROPRIATENESS_LABELS_AR,
  OSCE_ROLES,
  OSCE_ROLE_LABELS_AR,
  OSCE_STATION_TYPES,
  OSCE_STATION_TYPE_LABELS_AR,
  type CaseKind,
  type EvidenceView,
  type SourceScope,
} from '@medlevo/shared';
import { Breadcrumbs, Button, Checkbox, Dialog, ErrorState, IconButton, LoadingState, SegmentedControl, Select, TextArea, TextField } from '../../design';
import { errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText, CitationChip, evidenceApi } from '../evidence';
import { useLibrary } from '../library/useLibrary';
import { casesApi } from './api';
import { AuthoredLabel } from './components';
import {
  allIds,
  draftFromDefinition,
  draftProblems,
  emptyDraft,
  joinPhrases,
  newChecklistItem,
  newDecision,
  newFact,
  newStage,
  newVivaQuestion,
  nextId,
  sentence,
  splitPhrases,
  toInput,
  type CaseDraft,
  type SentenceDraft,
} from './model';
import './cases.css';

const LECTURE_TYPES = new Set(['lecture', 'course_reference', 'textbook', 'guideline', 'practical_manual', 'my_notes', 'image_atlas']);

interface EvidenceCtx {
  scope: SourceScope | null;
  views: Map<string, EvidenceView>;
  remember: (v: EvidenceView[]) => void;
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="cs-edit__section">
      <h2 className="cs-section__title">{title}</h2>
      {hint && <p className="cs-muted">{hint}</p>}
      {children}
    </section>
  );
}

/** A comma / line separated list of phrases, kept as typed until it loses focus. */
function PhrasesField({ label, hint, value, onChange }: { label: string; hint?: string; value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(joinPhrases(value));
  useEffect(() => setText(joinPhrases(value)), [value]);
  return <TextField label={label} hint={hint ?? 'افصل بين العبارات بفاصلة. تُطابَق بعد توحيد أشكال الحروف العربية، ولا يُحتسب الذكر المنفي.'} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(splitPhrases(text))} />;
}

function EvidencePicker({ open, onClose, ctx, initial, onPick }: { open: boolean; onClose: () => void; ctx: EvidenceCtx; initial: string; onPick: (v: EvidenceView) => void }) {
  const [q, setQ] = useState(initial);
  const [results, setResults] = useState<EvidenceView[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = useCallback(
    async (text: string) => {
      if (!ctx.scope || text.trim().length < 2) return;
      setBusy(true);
      setError(null);
      try {
        const r = await casesApi.suggestEvidence({ scope: ctx.scope, text: text.trim(), limit: 8 });
        setResults(r.evidence);
        setNote(r.abstain_ar ?? r.searched_ar);
        ctx.remember(r.evidence);
      } catch (e) {
        setError(errorMessage(e, 'تعذّر البحث في المصادر.'));
      } finally {
        setBusy(false);
      }
    },
    [ctx],
  );
  useEffect(() => {
    if (open) {
      setQ(initial);
      setResults(null);
      void search(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title="أرفق دليلًا من مصادر الحالة" size="lg" description="ابحث في المحاضرة المختارة فقط، ثم اختر المقتطف الذي يثبت الجملة. يتحقق الخادم من الدليل عند الحفظ.">
      {!ctx.scope ? (
        <p className="cs-muted">اختر المحاضرة (نطاق الأدلة) في أعلى الصفحة أولًا.</p>
      ) : (
        <>
          <form
            className="cs-form-row"
            onSubmit={(e) => {
              e.preventDefault();
              void search(q);
            }}
          >
            <TextField label="ابحث عن" value={q} onChange={(e) => setQ(e.target.value)} />
            <Button type="submit" variant="secondary" icon={<Search size={16} />} loading={busy}>
              ابحث
            </Button>
          </form>
          {error && <ErrorState inline message={error} />}
          {note && <p className="cs-muted">{note}</p>}
          {results && results.length === 0 && <p className="cs-muted">لا مقتطفات مطابقة داخل النطاق.</p>}
          <ul className="cs-ev-results">
            {results?.map((v) => (
              <li key={v.id} className="cs-ev-result">
                <BidiText className="cs-ev-result__quote" text={v.quote.length > 400 ? `${v.quote.slice(0, 399)}…` : v.quote} />
                <div className="ml-cluster">
                  <span className="cs-muted">
                    <BidiText as="span" text={`${v.source_title} — ${v.locator_label_ar}`} />
                  </span>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      onPick(v);
                      onClose();
                    }}
                  >
                    أرفق
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}

function SentenceListEditor({ label, hint, value, onChange, ctx }: { label: string; hint?: string; value: SentenceDraft[]; onChange: (v: SentenceDraft[]) => void; ctx: EvidenceCtx }) {
  const [picking, setPicking] = useState<number | null>(null);
  const set = (i: number, patch: Partial<SentenceDraft>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <fieldset className="cs-sentences-edit">
      <legend className="cs-sentences-edit__legend">{label}</legend>
      {hint && <p className="cs-muted">{hint}</p>}
      {value.map((s, i) => (
        <div key={i} className="cs-sentence-edit">
          <TextArea label={`الجملة ${i + 1}`} rows={2} value={s.text} onChange={(e) => set(i, { text: e.target.value })} />
          <Checkbox checked={s.medical} onCheckedChange={(v) => set(i, { medical: v })} label="معلومة طبية (تحتاج دليلًا)" />
          <div className="cs-sentence-edit__ev">
            {s.evidence_ids.map((id) => {
              const v = ctx.views.get(id);
              return (
                <span key={id} className="cs-ev-chip">
                  {v ? <CitationChip evidence={v} /> : <span className="cs-muted">دليل محفوظ</span>}
                  <IconButton size="sm" label="أزل هذا الدليل" icon={<Trash2 size={14} />} onClick={() => set(i, { evidence_ids: s.evidence_ids.filter((x) => x !== id) })} />
                </span>
              );
            })}
            {s.medical && (
              <Button size="sm" variant="secondary" icon={<Link2 size={14} />} disabled={!ctx.scope || s.evidence_ids.length >= 8} onClick={() => setPicking(i)}>
                أرفق دليلًا
              </Button>
            )}
            <IconButton label={`احذف الجملة ${i + 1}`} icon={<Trash2 size={16} />} onClick={() => onChange(value.filter((_, j) => j !== i))} />
          </div>
        </div>
      ))}
      <Button size="sm" variant="plain" icon={<Plus size={14} />} onClick={() => onChange([...value, sentence()])}>
        أضف جملة
      </Button>
      <EvidencePicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        ctx={ctx}
        initial={picking !== null ? (value[picking]?.text ?? '') : ''}
        onPick={(v) => {
          if (picking === null) return;
          const s = value[picking]!;
          if (!s.evidence_ids.includes(v.id)) set(picking, { evidence_ids: [...s.evidence_ids, v.id] });
        }}
      />
    </fieldset>
  );
}

function FactPicker({ label, facts, value, onChange }: { label: string; facts: CaseDraft['facts']; value: string[]; onChange: (v: string[]) => void }) {
  if (facts.length === 0) return null;
  return (
    <fieldset className="cs-facts-pick">
      <legend className="cs-sentences-edit__legend">{label}</legend>
      {facts.map((f) => (
        <Checkbox key={f.id} checked={value.includes(f.id)} onCheckedChange={(on) => onChange(on ? [...value, f.id] : value.filter((x) => x !== f.id))} label={f.label || 'معلومة بلا عنوان'} />
      ))}
    </fieldset>
  );
}

const DRAFT_KEY = (id: string) => `medlevo.cases.editor.${id}`;
/** A local draft based on an OLDER version (the case was saved elsewhere since, or a save was refused): kept apart so
 * that editing the current version never overwrites it, until the owner restores or discards it. */
const STALE_KEY = (draftKey: string) => `${draftKey}.stale`;
type StoredDraft = { base: number; draft: CaseDraft };

export function CaseEditor() {
  const { caseId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const kindParam = (['case', 'osce', 'viva'].includes(params.get('kind') ?? '') ? params.get('kind') : 'case') as CaseKind;
  const draftKey = DRAFT_KEY(caseId ?? `new-${kindParam}`);
  const lib = useLibrary();
  const sources = useMemo(() => (lib.data?.sources ?? []).filter((s) => LECTURE_TYPES.has(s.source_type) && !s.deleted_at), [lib.data]);
  const [draft, setDraft] = useState<CaseDraft | null>(caseId ? null : emptyDraft(kindParam));
  const [baseVersion, setBaseVersion] = useState<number | undefined>(undefined);
  const [lecture, setLecture] = useState('');
  const [scopeMode, setScopeMode] = useState<'lecture_only' | 'lecture_plus_references'>('lecture_only');
  const [views, setViews] = useState<Map<string, EvidenceView>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [restored, setRestored] = useState(false);
  const [stale, setStale] = useState<StoredDraft | null>(null);
  const dirty = useRef(false);
  usePageTitle(caseId ? 'تعديل الحالة' : `${CASE_KIND_LABELS_AR[kindParam]} جديدة`);

  const remember = useCallback((list: EvidenceView[]) => setViews((m) => new Map([...m, ...list.map((v) => [v.id, v] as const)])), []);
  const scope: SourceScope | null = lecture ? { mode: scopeMode, lecture_source_id: lecture, reference_source_ids: [], version_pins: {}, include_my_notes: false } : null;
  const ctx: EvidenceCtx = useMemo(() => ({ scope, views, remember }), [scope?.lecture_source_id, scopeMode, views, remember]); // eslint-disable-line react-hooks/exhaustive-deps

  // load an existing case (and its evidence for display)
  useEffect(() => {
    if (!caseId) return;
    let cancelled = false;
    void (async () => {
      try {
        const c = await casesApi.get(caseId);
        if (cancelled) return;
        let d = draftFromDefinition(c.definition);
        try {
          const saved = window.localStorage.getItem(draftKey);
          if (saved) {
            const parsed = JSON.parse(saved) as StoredDraft;
            if (parsed.base === c.version_no) {
              d = parsed.draft;
              setRestored(true);
            } else if (parsed.draft) {
              // never dropped silently: set aside, offered below until the owner restores or discards it
              window.localStorage.setItem(STALE_KEY(draftKey), saved);
              window.localStorage.removeItem(draftKey);
            }
          }
          const aside = window.localStorage.getItem(STALE_KEY(draftKey));
          if (aside) {
            const parsed = JSON.parse(aside) as StoredDraft;
            if (parsed.draft?.kind === c.kind) setStale(parsed);
          }
        } catch {
          // ignore a broken local draft
        }
        setDraft(d);
        setBaseVersion(c.version_no);
        if (c.scope?.lecture_source_id) setLecture(c.scope.lecture_source_id);
        if (c.scope?.mode === 'lecture_plus_references') setScopeMode('lecture_plus_references');
        const ids = [
          ...c.definition.stages.flatMap((s) => [...s.teaching_points, ...s.decisions.flatMap((x) => x.explanation)]),
          ...c.definition.checklist.flatMap((x) => x.rationale),
          ...(c.definition.viva?.questions.flatMap((q) => [...q.points.flatMap((p) => p.rationale), ...q.misconceptions.flatMap((m) => m.correction)]) ?? []),
        ].flatMap((s) => s.evidence_ids);
        if (ids.length) {
          const r = await evidenceApi.fetchEvidenceBatch([...new Set(ids)]);
          if (!cancelled) remember(r.evidence);
        }
      } catch (e) {
        if (!cancelled) setLoadError(errorMessage(e, 'تعذّر تحميل الحالة.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId, draftKey, remember]);

  // a new case: restore an unsaved local draft
  useEffect(() => {
    if (caseId) return;
    try {
      const saved = window.localStorage.getItem(draftKey);
      if (saved) {
        const parsed = JSON.parse(saved) as { base: number; draft: CaseDraft };
        if (parsed.draft?.kind === kindParam) {
          setDraft(parsed.draft);
          setRestored(true);
        }
      }
    } catch {
      // ignore
    }
  }, [caseId, draftKey, kindParam]);

  // keep the unsaved draft on this device
  useEffect(() => {
    if (!draft || !dirty.current) return;
    const t = window.setTimeout(() => {
      try {
        window.localStorage.setItem(draftKey, JSON.stringify({ base: baseVersion ?? 0, draft }));
      } catch {
        // storage full / private mode: the draft stays in memory
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [draft, draftKey, baseVersion]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const up = (fn: (d: CaseDraft) => void) =>
    setDraft((d) => {
      if (!d) return d;
      const n = structuredClone(d);
      fn(n);
      dirty.current = true;
      return n;
    });

  if (loadError) return <ErrorState message={loadError} />;
  if (!draft) return <LoadingState stage="جارٍ تحميل الحالة…" />;
  const ids = allIds(draft);
  const decisions = draft.stages.flatMap((s) => s.decisions.map((x) => ({ id: x.id, label: `${s.title || 'مرحلة'}: ${x.label || 'خيار'}` })));
  const stageOptions = [{ value: '', label: '— لا شيء (نهاية) —' }, ...draft.stages.map((s) => ({ value: s.id, label: s.title || CASE_STAGE_TYPE_LABELS_AR[s.type] }))];

  const save = async () => {
    const p = draftProblems(draft);
    setProblems(p);
    if (p.length) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body = { definition: toInput(draft), scope, ...(baseVersion ? { base_version_no: baseVersion } : {}) };
      const c = caseId ? await casesApi.update(caseId, body) : await casesApi.create(body);
      dirty.current = false;
      try {
        window.localStorage.removeItem(draftKey);
      } catch {
        // ignore
      }
      navigate(`/cases/${encodeURIComponent(c.id)}`);
    } catch (e) {
      setSaveError(errorMessage(e, 'تعذّر حفظ الحالة. مسودتك محفوظة على هذا الجهاز.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ml-page cs-page cs-edit">
      <Breadcrumbs items={[{ label: 'الحالات وOSCE', to: '/cases' }, { label: caseId ? 'تعديل' : `${CASE_KIND_LABELS_AR[draft.kind]} جديدة` }]} />
      <header className="ml-page__header cs-head">
        <div>
          <h1 className="ml-page__title">{caseId ? 'تعديل الحالة' : `${CASE_KIND_LABELS_AR[draft.kind]} جديدة`}</h1>
          <p className="ml-page__lede">
            تفاصيل المريض والسيناريو التي تكتبها تُعرض موسومة <AuthoredLabel />. كل معلومة طبية في الشروح يُفضَّل أن ترفق لها دليلًا من مصادرك.
          </p>
        </div>
        <Button variant="primary" icon={<Save size={16} />} loading={saving} onClick={() => void save()}>
          احفظ
        </Button>
      </header>
      {stale && baseVersion !== undefined && (
        <div className="cs-note cs-note--warn" role="status">
          <p>
            على هذا الجهاز مسودة لم تُحفظ كتبتها على النسخة {stale.base}، والحالة الآن في النسخة {baseVersion} (حُفظت من مكان آخر). لم تُحذف مسودتك.
            استعادتها تضعها في المحرر، وحفظها يُنشئ نسخة جديدة فوق النسخة {baseVersion} (تبقى كل النسخ السابقة في السجل).
          </p>
          <div className="ml-cluster">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setDraft(stale.draft);
                dirty.current = true;
                setStale(null);
                setRestored(true);
                try {
                  window.localStorage.removeItem(STALE_KEY(draftKey));
                } catch {
                  // the restored draft is saved under the current version by the effect below
                }
              }}
            >
              استعد مسودتي
            </Button>
            <Button
              size="sm"
              variant="plain"
              onClick={() => {
                setStale(null);
                try {
                  window.localStorage.removeItem(STALE_KEY(draftKey));
                } catch {
                  // ignore
                }
              }}
            >
              تجاهلها
            </Button>
          </div>
        </div>
      )}
      {restored && (
        <p className="cs-note">
          استُعيدت مسودة لم تُحفظ بعد من هذا الجهاز.{' '}
          <Button
            size="sm"
            variant="plain"
            onClick={() => {
              try {
                window.localStorage.removeItem(draftKey);
              } catch {
                // ignore
              }
              window.location.reload();
            }}
          >
            تجاهل المسودة
          </Button>
        </p>
      )}

      <Section title="الأساسيات">
        <TextField label="العنوان" value={draft.title} onChange={(e) => up((d) => void (d.title = e.target.value))} maxLength={200} required />
        <TextArea label={draft.kind === 'viva' ? 'مقدمة (اختيارية)' : 'القصة الأولية (بيانات تعليمية مؤلفة)'} rows={3} value={draft.summary} onChange={(e) => up((d) => void (d.summary = e.target.value))} />
        <TextArea label="أهداف التعلّم (هدف في كل سطر)" rows={2} value={draft.objectives.join('\n')} onChange={(e) => up((d) => void (d.objectives = e.target.value.split('\n')))} />
        <div className="cs-form-row">
          <Select label="نطاق الأدلة: المحاضرة" value={lecture} onValueChange={setLecture} options={[{ value: '', label: lib.loading && !lib.data ? 'جارٍ التحميل…' : 'بلا مصادر (لا يمكن إرفاق أدلة)' }, ...sources.map((s) => ({ value: s.id, label: s.title }))]} />
          <SegmentedControl
            label="النطاق"
            showLabel
            value={scopeMode}
            onValueChange={(v) => setScopeMode(v)}
            options={[
              { value: 'lecture_only', label: 'المحاضرة فقط' },
              { value: 'lecture_plus_references', label: 'المحاضرة + مراجعها' },
            ]}
          />
        </div>
      </Section>

      <Section title="المعلومات الثابتة عن المريض" hint="قيم لا تتغير أثناء المحاولة. «من البداية» تظهر فورًا؛ «عند الطلب» تكشفها مرحلة أو قرار أو جواب المريض.">
        {draft.facts.map((f, i) => (
          <div key={f.id} className="cs-row">
            <TextField label="العنوان" value={f.label} onChange={(e) => up((d) => void (d.facts[i]!.label = e.target.value))} />
            <TextField label="القيمة" value={f.value} onChange={(e) => up((d) => void (d.facts[i]!.value = e.target.value))} />
            <Select label="النوع" value={f.kind} onValueChange={(v) => up((d) => void (d.facts[i]!.kind = v))} options={CASE_FACT_KINDS.map((k) => ({ value: k, label: CASE_FACT_KIND_LABELS_AR[k] }))} />
            <Select label="تظهر" value={f.reveal} onValueChange={(v) => up((d) => void (d.facts[i]!.reveal = v))} options={[{ value: 'start', label: 'من البداية' }, { value: 'on_request', label: 'عند الطلب' }]} />
            <IconButton label={`احذف المعلومة ${f.label || i + 1}`} icon={<Trash2 size={16} />} onClick={() => up((d) => void d.facts.splice(i, 1))} />
          </div>
        ))}
        <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => up((d) => void d.facts.push(newFact(ids)))}>
          أضف معلومة
        </Button>
      </Section>

      {draft.kind === 'case' && (
        <Section title="المراحل والقرارات" hint="التفرع فقط لمرحلة «قرار واحد». الخيار غير المناسب يكمل السيناريو بالأثر الذي تكتبه أنت — لا يُخترع أثر.">
          {draft.stages.map((s, i) => (
            <fieldset key={s.id} className="cs-stage-edit">
              <legend className="cs-stage-edit__legend">
                المرحلة {i + 1}
                {draft.start_stage_id === s.id ? ' (البداية)' : ''}
              </legend>
              <div className="cs-form-row">
                <Select label="النوع" value={s.type} onValueChange={(v) => up((d) => void (d.stages[i]!.type = v))} options={CASE_STAGE_TYPES.map((t) => ({ value: t, label: CASE_STAGE_TYPE_LABELS_AR[t] }))} />
                <TextField label="العنوان" value={s.title} onChange={(e) => up((d) => void (d.stages[i]!.title = e.target.value))} />
                <Select
                  label="الإجابة"
                  value={s.select}
                  onValueChange={(v) =>
                    up((d) => {
                      d.stages[i]!.select = v;
                      if (v === 'many') d.stages[i]!.decisions.forEach((x) => (x.next_stage_id = null));
                    })
                  }
                  options={[
                    { value: 'none', label: 'قراءة ثم متابعة' },
                    { value: 'one', label: 'قرار واحد' },
                    { value: 'many', label: 'عدة اختيارات' },
                  ]}
                />
              </div>
              <TextArea label="السؤال أو التعليمات" rows={2} value={s.prompt} onChange={(e) => up((d) => void (d.stages[i]!.prompt = e.target.value))} />
              <FactPicker label="تكشف عند الوصول إليها" facts={draft.facts} value={s.reveal_fact_ids} onChange={(v) => up((d) => void (d.stages[i]!.reveal_fact_ids = v))} />
              <Select label="المرحلة التالية" value={s.next_stage_id ?? ''} onValueChange={(v) => up((d) => void (d.stages[i]!.next_stage_id = v || null))} options={stageOptions.filter((o) => o.value !== s.id)} />
              {s.select !== 'none' &&
                s.decisions.map((x, j) => (
                  <div key={x.id} className="cs-decision-edit">
                    <div className="cs-form-row">
                      <TextField label={`الخيار ${j + 1}`} value={x.label} onChange={(e) => up((d) => void (d.stages[i]!.decisions[j]!.label = e.target.value))} />
                      <Select
                        label="الحكم"
                        value={x.appropriateness}
                        onValueChange={(v) => up((d) => void (d.stages[i]!.decisions[j]!.appropriateness = v))}
                        options={DECISION_APPROPRIATENESS.map((a) => ({ value: a, label: DECISION_APPROPRIATENESS_LABELS_AR[a] }))}
                      />
                      {s.select === 'one' && (
                        <Select label="يتفرع إلى" value={x.next_stage_id ?? ''} onValueChange={(v) => up((d) => void (d.stages[i]!.decisions[j]!.next_stage_id = v || null))} options={[{ value: '', label: 'المرحلة التالية للمرحلة' }, ...stageOptions.slice(1)]} />
                      )}
                      <IconButton label={`احذف الخيار ${j + 1}`} icon={<Trash2 size={16} />} onClick={() => up((d) => void d.stages[i]!.decisions.splice(j, 1))} />
                    </div>
                    <FactPicker label="يكشف" facts={draft.facts} value={x.reveal_fact_ids} onChange={(v) => up((d) => void (d.stages[i]!.decisions[j]!.reveal_fact_ids = v))} />
                    <TextArea label="الأثر في السيناريو (اختياري)" rows={2} value={x.consequence} onChange={(e) => up((d) => void (d.stages[i]!.decisions[j]!.consequence = e.target.value))} />
                    <SentenceListEditor label="لماذا؟ (الشرح)" value={x.explanation} onChange={(v) => up((d) => void (d.stages[i]!.decisions[j]!.explanation = v))} ctx={ctx} />
                  </div>
                ))}
              {s.select !== 'none' && (
                <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => up((d) => void d.stages[i]!.decisions.push(newDecision(ids)))}>
                  أضف خيارًا
                </Button>
              )}
              <SentenceListEditor label="نقاط تعليمية (تظهر في المراجعة)" value={s.teaching_points} onChange={(v) => up((d) => void (d.stages[i]!.teaching_points = v))} ctx={ctx} />
              <div className="ml-cluster">
                {draft.start_stage_id !== s.id && (
                  <Button size="sm" variant="plain" onClick={() => up((d) => void (d.start_stage_id = s.id))}>
                    اجعلها البداية
                  </Button>
                )}
                <Button size="sm" variant="plain" icon={<Trash2 size={14} />} onClick={() => up((d) => {
                  d.stages.splice(i, 1);
                  if (d.start_stage_id === s.id) d.start_stage_id = d.stages[0]?.id ?? null;
                })}>
                  احذف المرحلة
                </Button>
              </div>
            </fieldset>
          ))}
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => up((d) => {
            const st = newStage(ids);
            d.stages.push(st);
            if (!d.start_stage_id) d.start_stage_id = st.id;
          })}>
            أضف مرحلة
          </Button>
        </Section>
      )}

      {draft.kind === 'osce' && draft.osce && (
        <Section title="المحطة" hint="المريض يجيب فقط بالمعلومات المعرّفة هنا؛ سؤال لا يطابق أي عبارة يُجاب بأن المعلومة غير متوفرة.">
          <div className="cs-form-row">
            <Select label="نوع المحطة" value={draft.osce.station_type} onValueChange={(v) => up((d) => void (d.osce!.station_type = v))} options={OSCE_STATION_TYPES.map((s) => ({ value: s, label: OSCE_STATION_TYPE_LABELS_AR[s] }))} />
            <TextField label="المدة المقترحة (دقائق)" type="number" min={1} max={30} value={draft.osce.minutes ?? ''} onChange={(e) => up((d) => void (d.osce!.minutes = e.target.value ? Math.min(30, Math.max(1, Number(e.target.value))) : null))} />
          </div>
          <TextArea label="تعليمات المرشح" rows={3} value={draft.osce.candidate_instructions} onChange={(e) => up((d) => void (d.osce!.candidate_instructions = e.target.value))} />
          <fieldset className="cs-facts-pick">
            <legend className="cs-sentences-edit__legend">الأدوار</legend>
            {OSCE_ROLES.map((r) => (
              <Checkbox key={r} checked={draft.osce!.roles.includes(r)} onCheckedChange={(on) => up((d) => void (d.osce!.roles = on ? [...d.osce!.roles, r] : d.osce!.roles.filter((x) => x !== r)))} label={OSCE_ROLE_LABELS_AR[r]} />
            ))}
          </fieldset>
          <h3 className="cs-section__sub">ردود المريض</h3>
          {draft.osce.patient_responses.map((r, i) => (
            <div key={r.id} className="cs-row">
              <PhrasesField label="عندما يسأل عن" value={r.match} onChange={(v) => up((d) => void (d.osce!.patient_responses[i]!.match = v))} />
              <Select label="يجيب بالمعلومة" value={r.fact_id} onValueChange={(v) => up((d) => void (d.osce!.patient_responses[i]!.fact_id = v))} options={[{ value: '', label: 'اختر معلومة' }, ...draft.facts.map((f) => ({ value: f.id, label: f.label || f.id }))]} />
              <IconButton label="احذف الرد" icon={<Trash2 size={16} />} onClick={() => up((d) => void d.osce!.patient_responses.splice(i, 1))} />
            </div>
          ))}
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} disabled={draft.facts.length === 0} onClick={() => up((d) => void d.osce!.patient_responses.push({ id: nextId('r', ids), match: [], fact_id: d.facts[0]?.id ?? '' }))}>
            أضف ردًا للمريض
          </Button>
          {draft.facts.length === 0 && <p className="cs-muted">أضف معلومات ثابتة أولًا ليجيب بها المريض.</p>}
        </Section>
      )}

      {draft.kind !== 'viva' && (
        <Section title="قائمة التقييم (Checklist)" hint={draft.kind === 'case' ? 'كل بند يتحقق باختيار قرار محدد.' : 'كل بند يتحقق إذا كتب المرشح عبارة تطابقه. «الترتيب» لمحطات الفحص فقط.'}>
          {draft.checklist.map((c, i) => (
            <fieldset key={c.id} className="cs-stage-edit">
              <legend className="cs-stage-edit__legend">البند {i + 1}</legend>
              <div className="cs-form-row">
                <TextField label="البند" value={c.text} onChange={(e) => up((d) => void (d.checklist[i]!.text = e.target.value))} />
                <Select label="الفئة" value={c.category} onValueChange={(v) => up((d) => void (d.checklist[i]!.category = v))} options={CHECKLIST_CATEGORIES.map((k) => ({ value: k, label: CHECKLIST_CATEGORY_LABELS_AR[k] }))} />
                <TextField label="النقاط" type="number" min={1} max={5} value={c.points} onChange={(e) => up((d) => void (d.checklist[i]!.points = Math.min(5, Math.max(1, Number(e.target.value) || 1))))} />
              </div>
              {draft.kind === 'case' ? (
                <fieldset className="cs-facts-pick">
                  <legend className="cs-sentences-edit__legend">يتحقق بالقرار</legend>
                  {decisions.length === 0 && <p className="cs-muted">أضف خيارات في المراحل أولًا.</p>}
                  {decisions.map((x) => (
                    <Checkbox key={x.id} checked={c.satisfied_by.includes(x.id)} onCheckedChange={(on) => up((d) => void (d.checklist[i]!.satisfied_by = on ? [...c.satisfied_by, x.id] : c.satisfied_by.filter((y) => y !== x.id)))} label={x.label} />
                  ))}
                </fieldset>
              ) : (
                <div className="cs-form-row">
                  <PhrasesField label="يتحقق إذا ذكر" value={c.match} onChange={(v) => up((d) => void (d.checklist[i]!.match = v))} />
                  <TextField label="الترتيب (اختياري)" type="number" min={1} max={60} value={c.order ?? ''} onChange={(e) => up((d) => void (d.checklist[i]!.order = e.target.value ? Number(e.target.value) : null))} />
                </div>
              )}
              <Checkbox checked={c.critical} onCheckedChange={(v) => up((d) => void (d.checklist[i]!.critical = v))} label="بند أساسي" />
              <SentenceListEditor label="لماذا هذا البند؟ (مع دليل)" value={c.rationale} onChange={(v) => up((d) => void (d.checklist[i]!.rationale = v))} ctx={ctx} />
              <Button size="sm" variant="plain" icon={<Trash2 size={14} />} onClick={() => up((d) => void d.checklist.splice(i, 1))}>
                احذف البند
              </Button>
            </fieldset>
          ))}
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => up((d) => void d.checklist.push(newChecklistItem(ids)))}>
            أضف بندًا
          </Button>
        </Section>
      )}

      {draft.kind === 'viva' && draft.viva && (
        <Section title="أسئلة الامتحان الشفهي" hint="سؤال المتابعة يُختار بعد كل إجابة بالقواعد التي تحددها هنا (نقطة لم تُذكر، أو ذُكرت، أو دائمًا) — دون كشف الحل.">
          <TextField label="أقصى عدد لأسئلة المتابعة لكل سؤال" type="number" min={0} max={3} value={draft.viva.max_follow_ups} onChange={(e) => up((d) => void (d.viva!.max_follow_ups = Math.min(3, Math.max(0, Number(e.target.value) || 0))))} />
          {draft.viva.questions.map((q, i) => (
            <fieldset key={q.id} className="cs-stage-edit">
              <legend className="cs-stage-edit__legend">السؤال {i + 1}</legend>
              <TextArea label="السؤال" rows={2} value={q.prompt} onChange={(e) => up((d) => void (d.viva!.questions[i]!.prompt = e.target.value))} />
              <h3 className="cs-section__sub">النقاط المتوقعة</h3>
              {q.points.map((p, j) => (
                <div key={p.id} className="cs-decision-edit">
                  <div className="cs-form-row">
                    <TextField label={`النقطة ${j + 1}`} value={p.text} onChange={(e) => up((d) => void (d.viva!.questions[i]!.points[j]!.text = e.target.value))} />
                    <PhrasesField label="تتحقق إذا ذكر" value={p.match} onChange={(v) => up((d) => void (d.viva!.questions[i]!.points[j]!.match = v))} />
                    <IconButton label={`احذف النقطة ${j + 1}`} icon={<Trash2 size={16} />} onClick={() => up((d) => void d.viva!.questions[i]!.points.splice(j, 1))} />
                  </div>
                  <SentenceListEditor label="التعليل (مع دليل)" value={p.rationale} onChange={(v) => up((d) => void (d.viva!.questions[i]!.points[j]!.rationale = v))} ctx={ctx} />
                </div>
              ))}
              <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => up((d) => void d.viva!.questions[i]!.points.push({ id: nextId('p', ids), text: '', match: [], rationale: [] }))}>
                أضف نقطة
              </Button>
              <h3 className="cs-section__sub">أسئلة المتابعة</h3>
              {q.follow_ups.map((f, j) => (
                <div key={f.id} className="cs-row">
                  <TextField label="سؤال المتابعة" value={f.prompt} onChange={(e) => up((d) => void (d.viva!.questions[i]!.follow_ups[j]!.prompt = e.target.value))} />
                  <Select
                    label="متى"
                    value={f.when.type === 'always' ? 'always' : `${f.when.type}:${f.when.point_id}`}
                    onValueChange={(v) =>
                      up((d) => {
                        const [type, pid] = v.split(':');
                        d.viva!.questions[i]!.follow_ups[j]!.when = type === 'always' ? { type: 'always' } : { type: type as 'missing' | 'covered', point_id: pid! };
                      })
                    }
                    options={[
                      { value: 'always', label: 'دائمًا' },
                      ...q.points.flatMap((p) => [
                        { value: `missing:${p.id}`, label: `إذا لم يذكر: ${p.text || p.id}` },
                        { value: `covered:${p.id}`, label: `إذا ذكر: ${p.text || p.id}` },
                      ]),
                    ]}
                  />
                  <IconButton label="احذف سؤال المتابعة" icon={<Trash2 size={16} />} onClick={() => up((d) => void d.viva!.questions[i]!.follow_ups.splice(j, 1))} />
                </div>
              ))}
              <Button size="sm" variant="plain" icon={<Plus size={14} />} onClick={() => up((d) => void d.viva!.questions[i]!.follow_ups.push({ id: nextId('fu', ids), prompt: '', when: { type: 'always' } }))}>
                أضف سؤال متابعة
              </Button>
              <h3 className="cs-section__sub">مفاهيم خاطئة شائعة</h3>
              {q.misconceptions.map((m, j) => (
                <div key={m.id} className="cs-decision-edit">
                  <div className="cs-form-row">
                    <PhrasesField label="إذا وردت العبارة" value={m.match} onChange={(v) => up((d) => void (d.viva!.questions[i]!.misconceptions[j]!.match = v))} />
                    <IconButton label="احذف المفهوم" icon={<Trash2 size={16} />} onClick={() => up((d) => void d.viva!.questions[i]!.misconceptions.splice(j, 1))} />
                  </div>
                  <SentenceListEditor label="التصحيح (مع دليل)" value={m.correction} onChange={(v) => up((d) => void (d.viva!.questions[i]!.misconceptions[j]!.correction = v))} ctx={ctx} />
                </div>
              ))}
              <Button size="sm" variant="plain" icon={<Plus size={14} />} onClick={() => up((d) => void d.viva!.questions[i]!.misconceptions.push({ id: nextId('m', ids), match: [], correction: [] }))}>
                أضف مفهومًا خاطئًا
              </Button>
              <Button size="sm" variant="plain" icon={<Trash2 size={14} />} onClick={() => up((d) => void d.viva!.questions.splice(i, 1))}>
                احذف السؤال
              </Button>
            </fieldset>
          ))}
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => up((d) => void d.viva!.questions.push(newVivaQuestion(ids)))}>
            أضف سؤالًا
          </Button>
        </Section>
      )}

      {problems.length > 0 && (
        <div className="cs-note cs-note--warn" role="alert">
          <p>أكمل ما يلي قبل الحفظ:</p>
          <ul className="cs-list">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {saveError && <ErrorState inline message={saveError} />}
      <div className="cs-edit__footer">
        <Button variant="primary" size="lg" icon={<Save size={18} />} loading={saving} onClick={() => void save()}>
          احفظ {caseId ? 'نسخة جديدة' : 'الحالة'}
        </Button>
        <p className="cs-muted">يتحقق الخادم من الروابط بين المراحل والقرارات ومن الأدلة، ويخبرك بما ينقص قبل التشغيل.</p>
      </div>
    </div>
  );
}
