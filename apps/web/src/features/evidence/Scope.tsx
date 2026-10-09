// Source Lock controls (§08, §09). ScopeBadge shows the locked scope; ScopePicker lets the owner choose a
// scope, previews exactly what the SERVER resolves (sources, origin, version, exclusions with reasons) and
// changes nothing until the owner presses «طبّق النطاق» — widening is always an explicit owner action.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import {
  SCOPE_MODE_LABELS_AR,
  SCOPE_MODES,
  SCOPE_ORIGIN_LABELS_AR,
  SOURCE_TYPE_LABELS_AR,
  stableStringify,
  type ScopeMode,
  type ScopeResolveResponse,
  type SourceDetail,
  type SourceScope,
  type SourceType,
} from '@medlevo/shared';
import { Button, Checkbox, StatusPill, Switch } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { BidiText } from './BidiText';
import { resolveScopePreview } from './api';
import { sourcesCountAr } from './model';

export interface ScopeBadgeProps {
  scope: { mode: ScopeMode; describe_ar?: string; describeAr?: string; source_ids?: string[]; sourceIds?: string[] };
  /** show the full description under the badge */
  detailed?: boolean;
  className?: string;
}

/** «المحاضرة فقط» badge with the server's description of the locked sources. */
export function ScopeBadge({ scope, detailed, className }: ScopeBadgeProps) {
  const describe = scope.describe_ar ?? scope.describeAr ?? '';
  const n = (scope.source_ids ?? scope.sourceIds ?? []).length;
  return (
    <span className={['ev-scope-badge', className].filter(Boolean).join(' ')}>
      <StatusPill tone="accent" icon={<Lock size={14} />}>
        <span className="ml-visually-hidden">نطاق المصادر: </span>
        {SCOPE_MODE_LABELS_AR[scope.mode]}
        {n > 1 ? <span className="ev-scope-badge__count">{` (${sourcesCountAr(n)})`}</span> : null}
      </StatusPill>
      {describe && (detailed ? <BidiText as="span" className="ev-scope-badge__detail" text={describe} /> : <span className="ml-visually-hidden">{describe}</span>)}
    </span>
  );
}

export interface ScopeCandidate {
  id: string;
  title: string;
  source_type: SourceType;
}

export interface ScopePickerProps {
  value: SourceScope;
  /** called only when the owner presses «طبّق النطاق», with the server-resolved preview */
  onApply: (scope: SourceScope, resolved: ScopeResolveResponse) => void;
  /** focal lecture (lecture modes) — defaults to value.lecture_source_id */
  lectureSourceId?: string;
  /** references the owner may choose; default: sources linked to the lecture as references */
  references?: ScopeCandidate[];
  onCancel?: () => void;
}

const MODE_DESC_AR: Record<ScopeMode, string> = {
  lecture_only: 'المحاضرة المحددة وحدها، بنسختها المثبّتة أو الحالية.',
  references_only: 'المراجع التي تختارها أدناه فقط.',
  lecture_plus_references: 'المحاضرة ومراجعها، مع تمييز مصدر كل دليل.',
  external: 'مصادر خارجية موثوقة ضمن إعداداتك.',
};

const EMPTY: SourceScope = { mode: 'lecture_only', reference_source_ids: [], version_pins: {}, include_my_notes: false };

export function ScopePicker({ value, onApply, lectureSourceId, references, onCancel }: ScopePickerProps) {
  const caps = useCapabilities();
  const external = caps.feature('external.evidence');
  const lecture = lectureSourceId ?? value.lecture_source_id;
  const [draft, setDraft] = useState<SourceScope>({ ...EMPTY, ...value, lecture_source_id: lecture });
  const [candidates, setCandidates] = useState<ScopeCandidate[] | null>(references ?? null);
  const [preview, setPreview] = useState<ScopeResolveResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (references) {
      setCandidates(references);
      return;
    }
    if (!lecture) {
      setCandidates([]);
      return;
    }
    let alive = true;
    api
      .get<SourceDetail>(`/sources/${encodeURIComponent(lecture)}`, { timeoutMs: 20_000 })
      .then((d) => {
        if (!alive) return;
        setCandidates(
          d.links
            .filter((l) => l.relation === 'reference_for' || l.relation === 'same_topic')
            .map((l) => ({ id: l.from_source_id === lecture ? l.to_source_id : l.from_source_id, title: l.other_title, source_type: l.other_type })),
        );
      })
      .catch(() => alive && setCandidates([]));
    return () => {
      alive = false;
    };
  }, [lecture, references]);

  const key = stableStringify(draft);
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      resolveScopePreview(draft)
        .then((r) => {
          if (mine !== seq.current) return;
          setPreview(r);
          setPreviewError(null);
        })
        .catch((e) => {
          if (mine !== seq.current) return;
          setPreview(null);
          setPreviewError(errorMessage(e));
        })
        .finally(() => mine === seq.current && setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = useMemo(() => stableStringify({ ...EMPTY, ...value, lecture_source_id: lecture }) !== key, [value, lecture, key]);
  const groupName = useId();
  const modes = SCOPE_MODES.map((m) => ({
    value: m,
    label: SCOPE_MODE_LABELS_AR[m],
    desc: m === 'external' && !external.available ? `غير متاح: ${external.reason ?? 'لم تُفعَّل الأدلة الخارجية.'}` : MODE_DESC_AR[m],
    disabled: m === 'external' ? !external.available : (m === 'lecture_only' || m === 'lecture_plus_references') && !lecture,
  }));
  const usesRefs = draft.mode !== 'lecture_only';
  const toggleRef = (id: string, on: boolean) =>
    setDraft((d) => ({ ...d, reference_source_ids: on ? [...new Set([...d.reference_source_ids, id])] : d.reference_source_ids.filter((x) => x !== id) }));

  return (
    <div className="ev-scope-picker">
      <fieldset className="ev-scope-modes">
        <legend className="ev-scope-picker__h">نطاق المصادر</legend>
        {modes.map((m) => (
          <label key={m.value} className="ev-scope-mode" data-disabled={m.disabled ? 'true' : undefined}>
            <input type="radio" name={groupName} value={m.value} checked={draft.mode === m.value} disabled={m.disabled} onChange={() => setDraft((d) => ({ ...d, mode: m.value }))} />
            <span className="ev-scope-mode__text">
              <span className="ev-scope-mode__label">{m.label}</span>
              <span className="ev-scope-mode__desc">{m.desc}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {usesRefs && (
        <fieldset className="ev-scope-picker__refs">
          <legend>المراجع المختارة</legend>
          {candidates === null ? (
            <p className="ev-note">جارٍ تحميل المراجع المرتبطة…</p>
          ) : candidates.length === 0 ? (
            <p className="ev-note">لا توجد مراجع مرتبطة بهذه المحاضرة. اربط مرجعًا من صفحة المصدر أولًا.</p>
          ) : (
            candidates.map((c) => (
              <Checkbox
                key={c.id}
                checked={draft.reference_source_ids.includes(c.id)}
                onCheckedChange={(on) => toggleRef(c.id, on)}
                label={<BidiText as="span" dir="rtl" text={c.title} />}
                description={SOURCE_TYPE_LABELS_AR[c.source_type]}
              />
            ))
          )}
          {draft.mode === 'lecture_plus_references' && draft.reference_source_ids.length === 0 && (
            <p className="ev-note">دون اختيار صريح تُستخدم المراجع المربوطة بالمحاضرة كما يعرضها الخادم أدناه.</p>
          )}
        </fieldset>
      )}
      <Switch
        checked={draft.include_my_notes}
        onCheckedChange={(on) => setDraft((d) => ({ ...d, include_my_notes: on }))}
        label="تضمين «ملاحظاتي»"
        description="مصدر شخصي منخفض الموثوقية؛ لا يتقدّم على مصدر أكاديمي."
      />
      <section className="ev-scope-picker__preview" aria-live="polite" aria-busy={loading}>
        <h3 className="ev-scope-picker__h">ما سيُبحث فيه</h3>
        {previewError ? (
          <p className="ev-note ev-note--danger" role="alert">
            {previewError}
          </p>
        ) : preview ? (
          <>
            <ul className="ev-scope-picker__list">
              {preview.sources.map((s) => (
                <li key={s.source_id}>
                  <BidiText as="span" dir="rtl" text={s.title} />
                  <span className="ev-scope-picker__meta">
                    {[SCOPE_ORIGIN_LABELS_AR[s.origin], `النسخة ${s.version_no}`, s.frozen ? 'مثبّتة' : null, s.pinned ? 'محددة يدويًا' : null, s.newer_version_exists ? 'توجد نسخة أحدث' : null]
                      .filter(Boolean)
                      .join('، ')}
                  </span>
                </li>
              ))}
            </ul>
            {preview.excluded.length > 0 && (
              <ul className="ev-scope-picker__excluded" aria-label="مصادر مستبعدة">
                {preview.excluded.map((x) => (
                  <li key={x.source_id}>
                    <BidiText as="span" dir="rtl" text={x.title ?? 'مصدر غير موجود'} />
                    <span className="ev-scope-picker__meta">{x.reason_ar}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="ev-note">جارٍ حساب النطاق…</p>
        )}
      </section>
      <div className="ev-scope-picker__actions">
        <Button variant="primary" disabled={!changed || !preview || loading} onClick={() => preview && onApply(draft, preview)}>
          طبّق النطاق
        </Button>
        <Button
          variant="plain"
          onClick={() => {
            setDraft({ ...EMPTY, ...value, lecture_source_id: lecture });
            onCancel?.();
          }}
        >
          إلغاء
        </Button>
      </div>
    </div>
  );
}
