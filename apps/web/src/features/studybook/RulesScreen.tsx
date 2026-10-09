// Explanation Rules (§19) — /explanation-rules[?node_id=|?source_id=]. How explanations and the Study Book are
// written: the subject template, level, language style and optional parts. Layers: owner settings (level, style,
// Socratic, custom instruction — edited in /settings) → the owner's general rules → the library folder's template
// and the folder's own rules (nearest folder wins) → per-request choices. A template structures an explanation;
// it never justifies adding a fact the sources do not state (the server drops empty template sections).
// Any change makes a new rules version: new explanations use it; saved ones are never rewritten.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Info } from 'lucide-react';
import {
  EXPLANATION_LEVELS,
  EXPLANATION_LEVEL_LABELS_AR,
  EXPLANATION_TEMPLATES,
  EXPLANATION_TEMPLATE_LABELS_AR,
  type ExplanationRules,
  type ExplanationRulesPatch,
  type ExplanationRulesResponse,
  type ExplanationTemplateKey,
  type LibraryNodeView,
  type LibraryTreeResponse,
} from '@medlevo/shared';
import { Button, ConfirmDialog, ErrorState, LoadingState, Select, StatusPill, Switch, Term, useToast, type SelectOption } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { usePageTitle } from '../../lib/usePageTitle';
import { studybookApi } from './api';
import { mergeRulesPatch, ruleSourceAr } from './model';
import './studybook-screens.css';

const TEMPLATE_KEYS = Object.keys(EXPLANATION_TEMPLATES) as ExplanationTemplateKey[];
const DIALECT_LABELS_AR: Record<ExplanationRules['dialect'], string> = { fusha_simple: 'عربية فصحى مبسّطة', iraqi_teaching: 'أسلوب تدريس عراقي' };
const INCLUDE_LABELS_AR: Record<keyof ExplanationRules['include'], { label: string; description: string }> = {
  clinical_notes: { label: 'ملاحظات سريرية', description: 'فقط ما تذكره المصادر من أهمية سريرية، مع أدلته.' },
  exam_pearls: { label: 'نقاط امتحانية', description: 'ما يُسأل عنه كما ورد في المصادر.' },
  memory_hooks: { label: 'وسائل حفظ', description: 'تُوسم «وسيلة حفظ مولدة» ولا تُعامل كحقيقة علمية.' },
  examples: { label: 'أمثلة تعليمية', description: 'تُوسم «مثال تعليمي مولد»؛ ليست حالات حقيقية ولا من المصدر.' },
  mini_questions: { label: 'أسئلة تحقق قصيرة', description: 'سؤال واحد على الأكثر للتأكد من الفهم.' },
};
const INCLUDE_KEYS = Object.keys(INCLUDE_LABELS_AR) as Array<keyof ExplanationRules['include']>;

type Tri = 'inherit' | 'on' | 'off';
const TRI_OPTIONS: SelectOption<Tri>[] = [
  { value: 'inherit', label: 'كما في المستوى الأعلى' },
  { value: 'on', label: 'نعم' },
  { value: 'off', label: 'لا' },
];
const tri = (v: boolean | undefined): Tri => (v === undefined ? 'inherit' : v ? 'on' : 'off');
const fromTri = (v: Tri): boolean | undefined => (v === 'inherit' ? undefined : v === 'on');

/** Folder options with their path, e.g. «الجراحة › الجهاز الهضمي». */
function folderOptions(nodes: readonly LibraryNodeView[]): Array<{ id: string; label: string }> {
  const live = nodes.filter((n) => !n.deleted_at && !n.archived_at);
  const byId = new Map(live.map((n) => [n.id, n]));
  const path = (n: LibraryNodeView): string => {
    const parts: string[] = [];
    let cur: LibraryNodeView | undefined = n;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id) && parts.length < 8) {
      seen.add(cur.id);
      parts.unshift(cur.title);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return parts.join(' › ');
  };
  return live.map((n) => ({ id: n.id, label: path(n) })).sort((a, b) => a.label.localeCompare(b.label, 'ar'));
}

export function RulesScreen() {
  usePageTitle('قواعد الشرح');
  const online = useOnline();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const nodeId = params.get('node_id');
  const sourceId = params.get('source_id');
  const [data, setData] = useState<ExplanationRulesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folders, setFolders] = useState<Array<{ id: string; label: string }>>([]);
  const [draft, setDraft] = useState<ExplanationRulesPatch>({});
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const r = await studybookApi.rules({ node_id: nodeId ?? undefined, source_id: nodeId ? undefined : (sourceId ?? undefined) });
      setData(r);
      setDraft(nodeId ? (r.layers.node?.override ?? {}) : (r.layers.owner ?? {}));
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل قواعد الشرح.'));
    }
  };
  useEffect(() => {
    setData(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, sourceId]);
  useEffect(() => {
    void api
      .get<LibraryTreeResponse>('/library/tree')
      .then((t) => setFolders(folderOptions(t.nodes)))
      .catch(() => setFolders([]));
  }, []);

  const scopeOptions = useMemo<SelectOption<string>[]>(() => [{ value: '', label: 'القواعد العامة (كل المجلدات)' }, ...folders.map((f) => ({ value: f.id, label: f.label }))], [folders]);
  const editingNode = !!nodeId;
  const node = data?.layers.node ?? null;
  const saved = editingNode ? (node?.override ?? {}) : (data?.layers.owner ?? {});
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);

  const save = async () => {
    setBusy(true);
    try {
      const r = editingNode ? await studybookApi.saveNodeRules(nodeId!, draft) : await studybookApi.saveOwnerRules(draft);
      setData(r);
      setDraft(editingNode ? (r.layers.node?.override ?? {}) : (r.layers.owner ?? {}));
      toast.show({ title: 'حُفظت قواعد الشرح. تُطبَّق على الشروح الجديدة؛ المحفوظ لا يتغير.', tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e, 'تعذّر حفظ القواعد.'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const set = (change: ExplanationRulesPatch) => setDraft((d) => mergeRulesPatch(d, change));
  const unset = (field: keyof ExplanationRulesPatch) =>
    setDraft((d) => {
      const n = { ...d };
      delete n[field];
      return n;
    });
  const setInclude = (k: keyof ExplanationRules['include'], v: boolean | undefined) =>
    setDraft((d) => {
      const inc: Partial<ExplanationRules['include']> = { ...(d.include ?? {}) };
      if (v === undefined) delete inc[k];
      else inc[k] = v;
      const n: ExplanationRulesPatch = { ...d, include: inc };
      if (Object.keys(inc).length === 0) delete n.include;
      return n;
    });

  const rules = data?.rules ?? null;
  const templateSections = rules ? (EXPLANATION_TEMPLATES[rules.template] as readonly string[]) : [];

  return (
    <div className="ml-page ml-page--narrow sbx-page">
      <header className="ml-page__header">
        <h1 className="ml-page__title">قواعد الشرح</h1>
        <p className="ml-page__lede">كيف تُكتب الشروح وكتاب الدراسة: قالب المادة والمستوى وأسلوب اللغة والإضافات. القالب يرتّب الشرح فقط، ولا يبرّر إضافة معلومة غير موجودة في مصادرك.</p>
      </header>

      <div className="sbx-toolbar">
        <Select
          label="القواعد التي تعدّلها"
          options={scopeOptions}
          value={nodeId ?? ''}
          onValueChange={(v) => setParams(v ? { node_id: v } : {}, { replace: true })}
          fieldClassName="sbx-search"
        />
      </div>

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!data && !error && <LoadingState stage="جارٍ تحميل قواعد الشرح…" />}

      {data && rules && (
        <>
          <section className="sbx-section" aria-labelledby="sbx-effective-h">
            <h2 id="sbx-effective-h" className="sbx-section__title">
              {editingNode && node ? `القواعد المطبَّقة في «${node.title}»` : sourceId && node ? `القواعد المطبَّقة على مصادر «${node.title}»` : 'القواعد المطبَّقة'}
            </h2>
            <dl className="ml-group sbx-facts">
              <Fact label="القالب" value={EXPLANATION_TEMPLATE_LABELS_AR[rules.template]} from={ruleSourceAr('template', data.layers)} />
              <Fact label="المستوى" value={EXPLANATION_LEVEL_LABELS_AR[rules.level]} from={ruleSourceAr('level', data.layers)} />
              <Fact label="أسلوب اللغة" value={DIALECT_LABELS_AR[rules.dialect]} from={ruleSourceAr('dialect', data.layers)} />
              <Fact label="المصطلحات الإنجليزية" value={rules.keep_english_terms ? 'تبقى بالإنجليزية مع شرح عربي' : 'المصطلح العربي المعتمد أولًا'} from={ruleSourceAr('keep_english_terms', data.layers)} />
              <Fact label="الأسلوب السقراطي" value={rules.socratic ? 'مفعّل' : 'غير مفعّل'} from={ruleSourceAr('socratic', data.layers)} />
              <Fact label="الإضافات" value={INCLUDE_KEYS.filter((k) => rules.include[k]).map((k) => INCLUDE_LABELS_AR[k].label).join('، ') || 'لا شيء'} from={data.layers.node?.override?.include ? `خاص بـ «${data.layers.node.title}»` : data.layers.owner?.include ? 'قواعدك العامة' : 'الافتراضي'} />
            </dl>
            {templateSections.length > 0 && (
              <p className="sbx-note">
                {`أقسام قالب ${EXPLANATION_TEMPLATE_LABELS_AR[rules.template]}: ${templateSections.join('، ')}. يُكتب القسم فقط إذا ذكرته مصادرك، وما لم تذكره يُعرض كـ«غير مغطى» بدل اختلاقه.`}
              </p>
            )}
            <p className="sbx-version">
              نسخة القواعد: <bdi dir="ltr">{rules.rules_version}</bdi> — تتغير مع أي تعديل، فتُنشأ الشروح الجديدة بها ولا يُعاد استخدام شرح محفوظ بقواعد أخرى.
            </p>
            {rules.custom_instruction && (
              <p className="sbx-note sbx-note--icon">
                <Info size={16} aria-hidden="true" />
                <span>
                  تعليمتك العامة (من الإعدادات): «<bdi>{rules.custom_instruction}</bdi>» — تُعامل كتفضيل في الصياغة، لا كمصدر.
                </span>
              </p>
            )}
          </section>

          <section className="sbx-section" aria-labelledby="sbx-edit-h">
            <h2 id="sbx-edit-h" className="sbx-section__title">
              {editingNode ? `قواعد خاصة بـ «${node?.title ?? 'هذا المجلد'}» ومجلداته الفرعية` : 'قواعدك العامة'}
            </h2>
            {!editingNode && (
              <p className="sbx-note">
                المستوى وأسلوب اللغة والأسلوب السقراطي وتعليمتك العامة تُضبط في <Link to="/settings#reading">الإعدادات</Link>. هنا ما يخص الشروح فقط.
              </p>
            )}
            {editingNode && node?.template_key && (
              <p className="sbx-note">{`قالب المجلد في المكتبة: ${EXPLANATION_TEMPLATE_LABELS_AR[node.template_key as ExplanationTemplateKey] ?? node.template_key}. يمكنك تغييره هنا للشروح فقط.`}</p>
            )}
            <div className="ml-group">
              <div className="ml-group__row sbx-grid">
                <Select<string>
                  label="قالب الشرح"
                  options={[...(editingNode ? [{ value: '', label: 'كما في المستوى الأعلى' }] : []), ...TEMPLATE_KEYS.map((k) => ({ value: k, label: EXPLANATION_TEMPLATE_LABELS_AR[k] }))]}
                  value={draft.template ?? (editingNode ? '' : 'general')}
                  onValueChange={(v) => (v ? set({ template: v as ExplanationTemplateKey }) : unset('template'))}
                />
                {editingNode && (
                  <>
                    <Select<string>
                      label="المستوى"
                      options={[{ value: '', label: 'كما في المستوى الأعلى' }, ...EXPLANATION_LEVELS.map((l) => ({ value: l, label: EXPLANATION_LEVEL_LABELS_AR[l] }))]}
                      value={draft.level ?? ''}
                      onValueChange={(v) => (v ? set({ level: v as ExplanationRules['level'] }) : unset('level'))}
                    />
                    <Select<string>
                      label="أسلوب اللغة"
                      options={[{ value: '', label: 'كما في المستوى الأعلى' }, { value: 'fusha_simple', label: DIALECT_LABELS_AR.fusha_simple }, { value: 'iraqi_teaching', label: DIALECT_LABELS_AR.iraqi_teaching }]}
                      value={draft.dialect ?? ''}
                      onValueChange={(v) => (v ? set({ dialect: v as ExplanationRules['dialect'] }) : unset('dialect'))}
                    />
                  </>
                )}
              </div>
              {editingNode ? (
                <>
                  <div className="ml-group__row sbx-grid">
                    <Select<Tri> label="إبقاء المصطلحات بالإنجليزية" options={TRI_OPTIONS} value={tri(draft.keep_english_terms)} onValueChange={(v) => (fromTri(v) === undefined ? unset('keep_english_terms') : set({ keep_english_terms: fromTri(v) }))} />
                    <Select<Tri> label="الأسلوب السقراطي" options={TRI_OPTIONS} value={tri(draft.socratic)} onValueChange={(v) => (fromTri(v) === undefined ? unset('socratic') : set({ socratic: fromTri(v) }))} />
                  </div>
                  <div className="ml-group__row sbx-grid">
                    {INCLUDE_KEYS.map((k) => (
                      <Select<Tri> key={k} label={INCLUDE_LABELS_AR[k].label} hint={INCLUDE_LABELS_AR[k].description} options={TRI_OPTIONS} value={tri(draft.include?.[k])} onValueChange={(v) => setInclude(k, fromTri(v))} />
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="ml-group__row">
                    <Switch
                      label="إبقاء المصطلحات الطبية بالإنجليزية"
                      description={
                        <>
                          مثل <Term>McBurney&apos;s point</Term> و<Term>CT abdomen</Term>، مع شرحها بالعربية. عند الإيقاف يُستعمل المصطلح العربي المعتمد مع الإنجليزي بين قوسين أول مرة.
                        </>
                      }
                      checked={draft.keep_english_terms ?? rules.keep_english_terms}
                      onCheckedChange={(v) => set({ keep_english_terms: v })}
                    />
                  </div>
                  {INCLUDE_KEYS.map((k) => (
                    <div className="ml-group__row" key={k}>
                      <Switch label={INCLUDE_LABELS_AR[k].label} description={INCLUDE_LABELS_AR[k].description} checked={draft.include?.[k] ?? rules.include[k]} onCheckedChange={(v) => setInclude(k, v)} />
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="sbx-actions">
              <Button variant="primary" onClick={() => void save()} loading={busy} loadingLabel="جارٍ الحفظ…" disabled={!online || !dirty}>
                احفظ القواعد
              </Button>
              {dirty && (
                <Button variant="plain" onClick={() => setDraft(saved)} disabled={busy}>
                  تراجع عن التغييرات
                </Button>
              )}
              {editingNode && node?.override && (
                <Button variant="plain" onClick={() => setConfirmClear(true)} disabled={!online || busy}>
                  أزل القواعد الخاصة بهذا المجلد
                </Button>
              )}
              {!online && <StatusPill tone="warning">لا يوجد اتصال — القواعد محفوظة على الخادم</StatusPill>}
            </div>
          </section>
        </>
      )}

      <p className="sbx-footer">
        الترجمات المفضلة للمصطلحات تُضبط في <Link to="/terms">قاموس المصطلحات</Link>.
      </p>

      <ConfirmDialog
        open={confirmClear}
        title="إزالة القواعد الخاصة بالمجلد"
        impact="تعود شروح هذا المجلد إلى القواعد العامة وقالب المجلد. الشروح المحفوظة لا تتغير."
        confirmLabel="أزل القواعد الخاصة"
        onCancel={() => setConfirmClear(false)}
        onConfirm={async () => {
          const r = await studybookApi.clearNodeRules(nodeId!);
          setData(r);
          setDraft(r.layers.node?.override ?? {});
          setConfirmClear(false);
          toast.show({ title: 'أُزيلت القواعد الخاصة بالمجلد.', tone: 'success' });
        }}
      />
    </div>
  );
}

function Fact({ label, value, from }: { label: string; value: string; from: string }) {
  return (
    <div className="ml-group__row sbx-fact">
      <dt>{label}</dt>
      <dd>
        <span>{value}</span>
        <span className="sbx-fact__from">{from}</span>
      </dd>
    </div>
  );
}
