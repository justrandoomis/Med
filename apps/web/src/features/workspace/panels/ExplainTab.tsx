// «الشرح والسؤال» rail tab (§19, §20, §30): explain / simplify / translate / explain the figure for the current
// selection or page, ask about it (contextual chat), compare — always under the visible Source Lock and through
// the server's evidence pipeline. Results render with C1's ArtifactContent (chips → Evidence Peek → open the
// source → back); abstentions show their reason and an explicit «وسّع النطاق»; without an AI provider the tab
// says exactly why (the server's reason) instead of pretending.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Image as ImageIcon, Languages, Sparkles, Wand2, X } from 'lucide-react';
import {
  ANSWER_STYLES,
  ANSWER_STYLE_LABELS_AR,
  EXPLANATION_LEVELS,
  EXPLANATION_LEVEL_LABELS_AR,
  RETRY_STRATEGIES,
  RETRY_STRATEGY_LABELS_AR,
  type AnswerStyle,
  type ExplainResponse,
  type ExplanationLevel,
  type RetryStrategy,
  type SelectionAnchor,
  type SourcePageView,
  type SourceScope,
} from '@medlevo/shared';
import { Button, ErrorState, LoadingState, Menu, MenuItem, SegmentedControl, Select, StatusPill, TextField, buttonClass } from '../../../design';
import { errorMessage, isApiError } from '../../../lib/api';
import { useCapabilities } from '../../../lib/capabilities';
import { useSettings } from '../../../lib/settings';
import { ArtifactContent, BidiText, ScopeBadge, ScopePicker } from '../../evidence';
import { studybookApi, type ArtifactListItem } from '../../studybook/api';
import { defaultScopeFor, referencesOf, regionsUnder, shortQuote } from '../../studybook/model';
import { fetchRegions } from '../data/api';
import type { SourceDocument } from '../data/useSourceDocument';
import { aiRequestStore, usePendingAiRequest, type AiRequest } from '../model/aiActions';
import { fullPageLabel } from '../model/pages';
import { ChatPanel } from '../studybook/ChatPanel';
import '../studybook/studybook.css';

export interface ExplainTabProps {
  doc: SourceDocument;
  page: SourcePageView | null;
  pageIndex: number;
  online: boolean;
}

type ExplainAction = 'explain' | 'simplify' | 'translate' | 'explain_image';
type Mode = 'explain' | 'ask' | 'compare';

interface Context {
  anchor: SelectionAnchor;
  text: string;
  pageIndex: number;
}

interface RunState {
  status: 'idle' | 'running' | 'done' | 'error';
  action?: ExplainAction | 'compare';
  result?: ExplainResponse;
  error?: { message: string; code: string | null };
}

/** last result per source (the tab remounts when the rail switches tabs) */
const lastRun = new Map<string, { run: RunState; context: Context | null; mode: Mode }>();

const ACTION_LABELS: Record<ExplainAction, string> = { explain: 'اشرح', simplify: 'بسّط', translate: 'ترجم إلى العربية', explain_image: 'اشرح الشكل' };
const RUNNING_STAGE: Record<ExplainAction | 'compare', string> = {
  explain: 'يُبحث في مصادر النطاق ثم يُتحقق من كل جملة طبية قبل عرضها…',
  simplify: 'يُبسَّط من المصادر نفسها ثم يُتحقق من كل جملة…',
  translate: 'يُترجم ويُتحقق من أن كل جملة مدعومة بالنص الأصلي…',
  explain_image: 'يُقرأ الشكل وتعليقه ويُتحقق مما يذكره المصدر…',
  compare: 'يُبحث عن كل طرف في النطاق ثم يُتحقق من كل خلية…',
};

export function ExplainTab({ doc, page, pageIndex, online }: ExplainTabProps) {
  const caps = useCapabilities();
  const { settings } = useSettings();
  const sourceId = doc.detail.id;
  const explainGate = caps.feature('ai.explain');
  const chatGate = caps.feature('ai.chat');
  const compareGate = caps.feature('ai.summaries');
  const figureGate = caps.feature('ai.figure_explain');
  const saved = lastRun.get(sourceId);
  const [mode, setMode] = useState<Mode>(saved?.mode ?? 'explain');
  const [context, setContext] = useState<Context | null>(saved?.context ?? null);
  const [scope, setScope] = useState<SourceScope>(() => defaultScopeFor(doc.detail, settings.default_scope_mode));
  const [picking, setPicking] = useState(false);
  const [level, setLevel] = useState<ExplanationLevel>(settings.explanation_level);
  const [style, setStyle] = useState<AnswerStyle>(settings.answer_style);
  const [run, setRun] = useState<RunState>(saved?.run ?? { status: 'idle' });
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');
  const [askFocus, setAskFocus] = useState(0);
  const [history, setHistory] = useState<ArtifactListItem[]>([]);
  const abort = useRef<AbortController | null>(null);
  const pending = usePendingAiRequest();

  useEffect(() => {
    lastRun.set(sourceId, { run: run.status === 'running' ? { status: 'idle' } : run, context, mode });
  }, [sourceId, run, context, mode]);

  // the anchor of the current page when nothing is selected
  const pageAnchor = useMemo<SelectionAnchor | null>(() => (page ? { source_id: sourceId, version_id: page.version_id, page_id: page.id, region_ids: [] } : null), [page, sourceId]);
  const effective: Context | null = context ?? (pageAnchor ? { anchor: pageAnchor, text: '', pageIndex } : null);

  const loadHistory = () => {
    if (!online) return;
    void studybookApi
      .artifacts(sourceId, undefined, 30)
      .then((r) => setHistory(r.artifacts))
      .catch(() => undefined);
  };
  useEffect(loadHistory, [sourceId, online]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageHistory = history.filter((h) => h.anchor_page_id === (effective?.anchor.page_id ?? null)).slice(0, 6);

  /** precise anchor: the regions under the selection rectangles (best effort; the quote alone also works) */
  const withRegions = async (req: AiRequest): Promise<SelectionAnchor> => {
    if (!req.rects.length || !req.anchor.page_id) return req.anchor;
    try {
      const r = await fetchRegions(req.anchor.page_id);
      const ids = regionsUnder(r.regions, req.rects);
      return ids.length ? { ...req.anchor, region_ids: ids } : req.anchor;
    } catch {
      return req.anchor;
    }
  };

  const explain = async (action: ExplainAction, ctx: Context | null = effective, opts: { scope?: SourceScope; retry?: { artifact_id: string; strategy: RetryStrategy } } = {}) => {
    if (!ctx) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setMode('explain');
    setRun({ status: 'running', action });
    try {
      const result = await studybookApi.explain(
        { action, anchor: ctx.anchor, scope: opts.scope ?? scope, style, level, retry_of: opts.retry ?? null },
        ac.signal,
      );
      setRun({ status: 'done', action, result });
      loadHistory();
    } catch (e) {
      if (ac.signal.aborted) return;
      setRun({ status: 'error', action, error: { message: errorMessage(e, 'تعذّر إكمال الشرح.'), code: isApiError(e) ? e.code : null } });
    }
  };

  const compare = async () => {
    const items = [compareA.trim(), compareB.trim()].filter(Boolean);
    if (items.length < 2) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setRun({ status: 'running', action: 'compare' });
    try {
      const result = await studybookApi.compare({ items, scope, anchor: context?.anchor ?? null, style }, ac.signal);
      setRun({ status: 'done', action: 'compare', result });
    } catch (e) {
      if (ac.signal.aborted) return;
      setRun({ status: 'error', action: 'compare', error: { message: errorMessage(e, 'تعذّرت المقارنة.'), code: isApiError(e) ? e.code : null } });
    }
  };

  // a request from the selection toolbar (Explain / Simplify / Translate / Ask / Compare / Explain Image)
  useEffect(() => {
    if (!pending) return;
    aiRequestStore.clear(pending.id);
    void (async () => {
      const anchor = await withRegions(pending);
      const ctx: Context = { anchor, text: pending.text, pageIndex: pending.pageIndex };
      setContext(ctx);
      if (pending.action === 'ask') {
        setMode('ask');
        setAskFocus((n) => n + 1);
      } else if (pending.action === 'compare') {
        setMode('compare');
        setCompareA(shortQuote(pending.text, 200));
        setCompareB('');
      } else {
        const gate = pending.action === 'explain_image' ? figureGate : explainGate;
        if (gate.available) void explain(pending.action, ctx);
        else setMode('explain');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  useEffect(() => () => abort.current?.abort(), []);

  const scopeView = (
    <div className="sb-scope">
      <ScopeBadge scope={{ mode: scope.mode, source_ids: [scope.lecture_source_id ?? '', ...scope.reference_source_ids].filter(Boolean) }} />
      <Button size="sm" variant="plain" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
        {picking ? 'إخفاء النطاق' : 'غيّر النطاق'}
      </Button>
      {picking && (
        <ScopePicker
          value={scope}
          lectureSourceId={sourceId}
          references={referencesOf(doc.detail)}
          onApply={(s) => {
            setScope(s);
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      )}
    </div>
  );

  const result = run.result?.artifact ?? null;
  const reasonId = 'sb-explain-reason';
  const unavailable = !explainGate.available;

  return (
    <div className="wk-rail-section sb-explain">
      {/* what is being explained */}
      <div className="sb-context" aria-live="polite">
        {context?.text ? (
          <>
            <p className="sb-label">التحديد</p>
            <BidiText as="p" className="sb-quote" text={shortQuote(context.text, 360)} />
            <div className="sb-row">
              <span className="sb-muted">{doc.pages[context.pageIndex] ? fullPageLabel(doc.pages[context.pageIndex]!) : ''}</span>
              <Button size="sm" variant="plain" icon={<X size={14} />} onClick={() => setContext(null)}>
                استخدم الصفحة بدل التحديد
              </Button>
            </div>
          </>
        ) : (
          <p className="sb-muted">{page ? `لا يوجد تحديد؛ يُشرح ما في ${fullPageLabel(page)}. حدّد نصًا في الصفحة لتشرحه وحده.` : 'افتح صفحة لتشرحها.'}</p>
        )}
      </div>

      {scopeView}

      <SegmentedControl<Mode>
        label="نوع الطلب"
        options={[
          { value: 'explain', label: 'شرح' },
          { value: 'ask', label: 'سؤال' },
          { value: 'compare', label: 'مقارنة' },
        ]}
        value={mode}
        onValueChange={setMode}
        size="sm"
        fullWidth
      />

      <div className="sb-prefs">
        <Select label="المستوى" options={EXPLANATION_LEVELS.map((l) => ({ value: l, label: EXPLANATION_LEVEL_LABELS_AR[l] }))} value={level} onValueChange={setLevel} />
        <Select label="نمط الرد" options={ANSWER_STYLES.map((s) => ({ value: s, label: ANSWER_STYLE_LABELS_AR[s] }))} value={style} onValueChange={setStyle} />
      </div>
      <p className="sb-links">
        <Link className={buttonClass({ variant: 'plain', size: 'sm' })} to={`/explanation-rules?source_id=${encodeURIComponent(sourceId)}`}>
          قواعد الشرح لهذه المادة
        </Link>
        <Link className={buttonClass({ variant: 'plain', size: 'sm' })} to="/terms">
          قاموس المصطلحات
        </Link>
      </p>

      {unavailable && mode !== 'ask' && (
        <div className="wk-disabled-card" role="note" id={reasonId}>
          <p className="wk-disabled-card__title">الشرح غير متاح الآن</p>
          <p className="wk-muted">{explainGate.reason}</p>
        </div>
      )}

      {mode === 'explain' && (
        <div className="sb-actions" role="group" aria-label="أدوات الشرح">
          <Button variant="primary" size="sm" icon={<Sparkles size={16} />} disabled={unavailable || !effective || run.status === 'running'} aria-describedby={unavailable ? reasonId : undefined} onClick={() => void explain('explain')}>
            {ACTION_LABELS.explain}
          </Button>
          <Button variant="secondary" size="sm" icon={<Wand2 size={16} />} disabled={unavailable || !effective || run.status === 'running'} aria-describedby={unavailable ? reasonId : undefined} onClick={() => void explain('simplify')}>
            {ACTION_LABELS.simplify}
          </Button>
          <Button variant="secondary" size="sm" icon={<Languages size={16} />} disabled={unavailable || !context?.text || run.status === 'running'} title={!context?.text ? 'حدّد نصًا لترجمته.' : undefined} aria-describedby={unavailable ? reasonId : undefined} onClick={() => void explain('translate')}>
            {ACTION_LABELS.translate}
          </Button>
          {(page?.has_images || context?.text) && (
            <Button
              variant="secondary"
              size="sm"
              icon={<ImageIcon size={16} />}
              disabled={!figureGate.available || !effective || run.status === 'running'}
              aria-describedby={!figureGate.available ? 'sb-figure-reason' : undefined}
              onClick={() => void explain('explain_image')}
            >
              {ACTION_LABELS.explain_image}
            </Button>
          )}
          {!figureGate.available && (page?.has_images || context?.text) ? (
            <p id="sb-figure-reason" className="sb-reason">{`شرح الشكل: ${figureGate.reason}`}</p>
          ) : figureGate.available && (page?.has_images || context?.text) && caps.data?.features['ai.figure_explain']?.reason_ar ? (
            <p className="sb-muted">{caps.data.features['ai.figure_explain'].reason_ar}</p>
          ) : null}
        </div>
      )}

      {mode === 'compare' && (
        <form
          className="sb-compare"
          onSubmit={(e) => {
            e.preventDefault();
            void compare();
          }}
        >
          <TextField label="الطرف الأول" value={compareA} onChange={(e) => setCompareA(e.target.value)} maxLength={200} />
          <TextField label="الطرف الثاني" value={compareB} onChange={(e) => setCompareB(e.target.value)} maxLength={200} placeholder="مثلًا: CT abdomen" />
          <Button type="submit" variant="primary" size="sm" disabled={!compareGate.available || !compareA.trim() || !compareB.trim() || run.status === 'running'} aria-describedby={!compareGate.available ? 'sb-compare-reason' : undefined}>
            قارن في جدول
          </Button>
          {!compareGate.available && (
            <p id="sb-compare-reason" className="sb-reason" role="note">
              {compareGate.reason}
            </p>
          )}
        </form>
      )}

      {mode === 'ask' && (
        <ChatPanel
          sourceId={sourceId}
          page={page}
          anchor={context?.anchor ?? null}
          anchorText={context?.text || null}
          scope={scope}
          style={style}
          gate={chatGate}
          online={online}
          focusKey={askFocus}
        />
      )}

      {mode !== 'ask' && run.status === 'running' && (
        <div className="sb-running">
          <LoadingState inline stage={RUNNING_STAGE[run.action ?? 'explain']} />
          <Button size="sm" variant="plain" onClick={() => {
            abort.current?.abort();
            setRun({ status: 'idle' });
          }}>
            توقّف عن الانتظار
          </Button>
        </div>
      )}
      {mode !== 'ask' && run.status === 'error' && run.error && (
        <ErrorState
          inline
          title={run.error.code === 'AI_NOT_CONFIGURED' ? 'الذكاء الاصطناعي غير مُعدّ' : run.error.code === 'AI_BUDGET_EXCEEDED' ? 'بلغت الميزانية حدّها' : run.error.code === 'OUT_OF_SCOPE' ? 'خارج نطاق المصادر' : 'تعذّر إكمال الطلب'}
          message={run.error.message}
          onRetry={run.action && run.action !== 'compare' ? () => void explain(run.action as ExplainAction) : run.action === 'compare' ? () => void compare() : undefined}
        />
      )}
      {mode !== 'ask' && run.status === 'done' && result && (
        <div className="sb-result">
          <div className="sb-row">
            {run.result?.cached && <StatusPill tone="neutral">من محفوظاتك — النطاق والقواعد والنسخة نفسها</StatusPill>}
            {result.kind !== 'comparison' && !result.abstain && (
              <Menu
                label="اشرح بطريقة أخرى"
                trigger={
                  <Button size="sm" variant="plain" disabled={unavailable}>
                    لم أفهم — اشرح بطريقة أخرى
                  </Button>
                }
              >
                {RETRY_STRATEGIES.map((s) => (
                  <MenuItem key={s} onSelect={() => void explain((run.action as ExplainAction) ?? 'explain', context ?? effective, { retry: { artifact_id: result.id, strategy: s } })}>
                    {RETRY_STRATEGY_LABELS_AR[s]}
                  </MenuItem>
                ))}
              </Menu>
            )}
          </div>
          <ArtifactContent
            artifact={result}
            onWidenScope={(wider) => {
              // explicit owner action: the wider scope becomes the lock for this tab, then the request runs again
              setScope(wider);
              if (run.action === 'compare') void compare();
              else void explain((run.action as ExplainAction) ?? 'explain', context ?? effective, { scope: wider });
            }}
          />
        </div>
      )}

      {mode === 'explain' && pageHistory.length > 0 && (
        <details className="sb-history">
          <summary>{`شروح سابقة لهذه الصفحة (${pageHistory.length})`}</summary>
          <ul role="list">
            {pageHistory.map((h) => (
              <li key={h.id}>
                <Button
                  size="sm"
                  variant="plain"
                  onClick={() =>
                    void studybookApi
                      .artifact(h.id)
                      .then((r) => setRun({ status: 'done', action: 'explain', result: { artifact: r.artifact, cached: true } }))
                      .catch((e: unknown) => setRun({ status: 'error', error: { message: errorMessage(e), code: null } }))
                  }
                >
                  {h.title ?? 'شرح'}
                  {h.version_no > 1 ? ` (المحاولة ${h.version_no})` : ''}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
