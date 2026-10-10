// Create MCQ from a selection (§30, §37–§38, track F3). The selection (page + regions + quote of the lecture's locked
// version) is the FOCUS of the regular generation pipeline — lecture-only scope, independent validator, evidence checks
// on the explanation and every distractor, bounded repairs. What comes back is shown as it is:
//  * published  → a generated question in the vault («سؤال مولد بواسطة MedLevo من المصادر المحددة») with «تدرّب عليه»;
//  * needs review → «لم يُنشر» with the failed checks (it waits in the review queue, never in an exam);
//  * abstained  → the reason and the suggestion (lower the difficulty, more pages, or widen the scope explicitly).
// Without an AI provider the panel says why (capability reason) and offers nothing that pretends to work.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FilePlus2, X } from 'lucide-react';
import {
  GENERATED_ITEM_TYPES,
  GENERATED_ITEM_TYPE_LABELS_AR,
  GENERATED_ORIGIN_LABEL_AR,
  GENERATION_DIFFICULTIES,
  GENERATION_DIFFICULTY_LABELS_AR,
  type GeneratedItemType,
  type GenerationDifficulty,
  type GenerationRunView,
} from '@medlevo/shared';
import { Button, ErrorState, IconButton, Select, StatusPill, buttonClass } from '../../../design';
import { errorMessage } from '../../../lib/api';
import { useCapabilities } from '../../../lib/capabilities';
import { BidiText } from '../../evidence';
import { examsApi } from '../../exams/api';
import { regionsUnder, shortQuote } from '../../studybook/model';
import { fetchRegions } from '../data/api';
import type { McqRequest } from '../model/mcqRequest';

const TERMINAL = new Set(['completed', 'partial', 'needs_review', 'abstained', 'failed']);

function tone(status: GenerationRunView['status']): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  if (status === 'completed') return 'success';
  if (status === 'partial' || status === 'needs_review' || status === 'abstained') return 'warning';
  if (status === 'failed') return 'danger';
  return 'info';
}

export function CreateMcqPanel({ request, pageLabel, onClose }: { request: McqRequest; pageLabel: string; onClose: () => void }) {
  const caps = useCapabilities();
  const gate = caps.feature('ai.generate_questions');
  const [difficulty, setDifficulty] = useState<GenerationDifficulty>('hard');
  const [itemType, setItemType] = useState<GeneratedItemType | 'any'>('any');
  const [language, setLanguage] = useState<'en' | 'ar'>('en');
  const [run, setRun] = useState<GenerationRunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const reasonId = `mcq-why-${request.id}`;

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // a new selection starts a new request
  useEffect(() => {
    setRun(null);
    setError(null);
    window.clearTimeout(timer.current);
  }, [request.id]);

  const poll = (id: string) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        const r = (await examsApi.run(id)).run;
        setRun(r);
        if (!TERMINAL.has(r.status)) poll(id);
      } catch (e) {
        setError(errorMessage(e, 'تعذّر متابعة حالة التوليد.'));
      }
    }, 1500);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let regionIds: string[] = [];
      if (request.rects.length) {
        try {
          regionIds = regionsUnder((await fetchRegions(request.page_id)).regions, request.rects);
        } catch {
          regionIds = []; // the quote alone also anchors the request
        }
      }
      const res = await examsApi.generate({
        lecture_source_id: request.source_id,
        anchor: { page_id: request.page_id, region_ids: regionIds, quote: request.text || null },
        count: 1,
        difficulty,
        item_types: itemType === 'any' ? [] : [itemType],
        language,
        origin: 'selection',
      });
      setRun(res.run);
      if (!TERMINAL.has(res.run.status)) poll(res.run.id);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر بدء إنشاء السؤال.'));
    } finally {
      setBusy(false);
    }
  };

  const running = !!run && !TERMINAL.has(run.status);
  return (
    <section className="wk-mcq" aria-label="إنشاء سؤال اختيار من متعدد من التحديد">
      <div className="wk-mcq__head">
        <h3 className="wk-mcq__title">
          أنشئ سؤال اختيار من متعدد <bdi dir="ltr">(Create MCQ)</bdi>
        </h3>
        <IconButton label="إغلاق إنشاء السؤال" icon={<X size={16} />} size="sm" onClick={onClose} />
      </div>
      <p className="wk-muted">{`من التحديد في ${pageLabel} — من هذه المحاضرة فقط (Source Lock). يُتحقق من السؤال ومن تفسير كل خيار قبل نشره.`}</p>
      {request.text && <BidiText as="p" className="wk-mcq__quote" text={shortQuote(request.text, 360)} />}
      {!gate.available ? (
        <div className="wk-disabled-card" role="note" id={reasonId}>
          <p className="wk-disabled-card__title">إنشاء الأسئلة غير متاح الآن</p>
          <p className="wk-muted">{gate.reason ?? 'توليد الأسئلة يتطلب مزود ذكاء اصطناعي مضبوطًا على الخادم.'}</p>
        </div>
      ) : null}
      <div className="wk-mcq__fields">
        <Select
          label="الصعوبة (تقديرية)"
          options={GENERATION_DIFFICULTIES.map((d) => ({ value: d, label: GENERATION_DIFFICULTY_LABELS_AR[d] }))}
          value={difficulty}
          onValueChange={(v) => setDifficulty(v as GenerationDifficulty)}
        />
        <Select
          label="نوع السؤال"
          options={[{ value: 'any', label: 'الأنسب للمقطع' }, ...GENERATED_ITEM_TYPES.map((x) => ({ value: x, label: GENERATED_ITEM_TYPE_LABELS_AR[x] }))]}
          value={itemType}
          onValueChange={(v) => setItemType(v as GeneratedItemType | 'any')}
        />
        <Select
          label="لغة السؤال"
          options={[
            { value: 'en', label: 'الإنجليزية' },
            { value: 'ar', label: 'العربية (المصطلحات بالإنجليزية)' },
          ]}
          value={language}
          onValueChange={(v) => setLanguage(v as 'en' | 'ar')}
        />
      </div>
      <div className="wk-rail-actions">
        <Button
          variant="primary"
          size="sm"
          icon={<FilePlus2 size={16} />}
          loading={busy}
          disabled={!gate.available || running}
          aria-describedby={!gate.available ? reasonId : undefined}
          onClick={() => void submit()}
        >
          أنشئ السؤال
        </Button>
      </div>
      {error && <ErrorState inline message={error} />}
      {run && (
        <div className="wk-mcq__result" aria-live="polite">
          <p>
            <StatusPill tone={tone(run.status)}>{run.status_label_ar}</StatusPill>
          </p>
          <p className="wk-muted">{run.summary_ar}</p>
          {run.abstain && <p className="wk-muted">{run.abstain.suggestion_ar}</p>}
          {run.candidates.map((c) => (
            <div key={c.id} className="wk-mcq__cand">
              <BidiText as="p" text={c.stem_preview} />
              {c.status === 'published' && c.question_id ? (
                <>
                  <p className="wk-muted">{GENERATED_ORIGIN_LABEL_AR}</p>
                  <div className="wk-rail-actions">
                    <Link to={`/questions/${encodeURIComponent(c.question_id)}`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                      افتح السؤال
                    </Link>
                    <Link to={`/practice?question_id=${encodeURIComponent(c.question_id)}`} className={buttonClass({ variant: 'plain', size: 'sm' })}>
                      تدرّب عليه
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <p className="wk-muted">{c.status === 'needs_review' ? 'لم يُنشر: ينتظر مراجعتك في قائمة المراجعة ولن يدخل أي اختبار.' : 'رُفض ولم يُنشر.'}</p>
                  {c.issues.length > 0 && (
                    <ul className="wk-mcq__issues">
                      {c.issues.slice(0, 4).map((i, k) => (
                        <li key={k}>{i.reason_ar}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          ))}
          {TERMINAL.has(run.status) && (
            <Link to="/exams/generate" className={buttonClass({ variant: 'plain', size: 'sm' })}>
              كل طلبات توليد الأسئلة
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
