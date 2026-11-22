// Claude-style model + effort picker in the composer: a compact button («Sonnet 5.5 · عالٍ») opening a popover with two
// radio groups. «تلقائي» = the server's configured model / effort for the task. Models the server cannot serve are shown
// disabled with the reason (never a silent no-op). The choice is remembered per user on the server (chat/prefs).
import { useId } from 'react';
import { ChevronDown, Cpu } from 'lucide-react';
import { CHAT_EFFORTS, CHAT_EFFORT_HINTS_AR, CHAT_EFFORT_LABELS_AR, CHAT_MODELS, CHAT_MODEL_INFO, type ChatEffort, type ChatModelId } from '@medlevo/shared';
import { Button, Popover } from '../../../design';

export interface ModelEffortValue {
  model: ChatModelId | null;
  effort: ChatEffort | null;
}

export interface ModelEffortMenuProps {
  value: ModelEffortValue;
  onChange: (v: ModelEffortValue) => void;
  /** models the server offers now (others are disabled) */
  available: readonly ChatModelId[];
  /** what «تلقائي» means (the configured model id / effort) */
  defaults: { model: string | null; effort: ChatEffort };
  disabled?: boolean;
}

function modelName(id: string | null): string {
  if (!id) return 'تلقائي';
  return (CHAT_MODEL_INFO as Record<string, { name: string }>)[id]?.name ?? id;
}

export function modelEffortSummary(v: ModelEffortValue, defaults: ModelEffortMenuProps['defaults']): string {
  const m = v.model ? modelName(v.model) : `${modelName(defaults.model)} (تلقائي)`;
  const e = CHAT_EFFORT_LABELS_AR[v.effort ?? defaults.effort];
  return `${m} · ${e}`;
}

export function ModelEffortMenu({ value, onChange, available, defaults, disabled }: ModelEffortMenuProps) {
  const id = useId();
  const summary = modelEffortSummary(value, defaults);
  return (
    <Popover
      label="النموذج ومستوى التفكير"
      align="start"
      className="ch-picker"
      trigger={
        <Button size="sm" variant="plain" className="ch-picker__trigger" icon={<Cpu size={14} />} disabled={disabled} aria-label={`النموذج ومستوى التفكير: ${summary}`}>
          <span className="ch-picker__summary">{summary}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      }
    >
      <fieldset className="ch-picker__group">
        <legend className="ch-picker__legend">النموذج</legend>
        <label className="ch-picker__option">
          <input type="radio" name={`${id}-model`} checked={value.model === null} onChange={() => onChange({ ...value, model: null })} />
          <span className="ch-picker__name">تلقائي</span>
          <span className="ch-picker__hint">{`الإعداد الافتراضي (${modelName(defaults.model)})`}</span>
        </label>
        {CHAT_MODELS.map((m) => {
          const off = !available.includes(m);
          return (
            <label key={m} className="ch-picker__option" data-disabled={off || undefined}>
              <input type="radio" name={`${id}-model`} checked={value.model === m} disabled={off} onChange={() => onChange({ ...value, model: m })} />
              <bdi dir="ltr" className="ch-picker__name">
                {CHAT_MODEL_INFO[m].name}
              </bdi>
              <span className="ch-picker__hint">{off ? 'غير متاح على هذا الخادم' : CHAT_MODEL_INFO[m].hint_ar}</span>
            </label>
          );
        })}
      </fieldset>
      <fieldset className="ch-picker__group">
        <legend className="ch-picker__legend">مستوى التفكير</legend>
        <label className="ch-picker__option">
          <input type="radio" name={`${id}-effort`} checked={value.effort === null} onChange={() => onChange({ ...value, effort: null })} />
          <span className="ch-picker__name">تلقائي</span>
          <span className="ch-picker__hint">{`الافتراضي (${CHAT_EFFORT_LABELS_AR[defaults.effort]})`}</span>
        </label>
        {CHAT_EFFORTS.map((e) => (
          <label key={e} className="ch-picker__option">
            <input type="radio" name={`${id}-effort`} checked={value.effort === e} onChange={() => onChange({ ...value, effort: e })} />
            <span className="ch-picker__name">{CHAT_EFFORT_LABELS_AR[e]}</span>
            <span className="ch-picker__hint">{CHAT_EFFORT_HINTS_AR[e]}</span>
          </label>
        ))}
      </fieldset>
      <p className="ch-picker__note">يُتحقق من كل إجابة بالأدلة نفسها أيًّا كان النموذج؛ النماذج الأدق والتفكير الأعمق أبطأ وأغلى.</p>
    </Popover>
  );
}
