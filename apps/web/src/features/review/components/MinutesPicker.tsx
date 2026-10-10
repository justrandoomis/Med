// «كم دقيقة لديك؟» — the one-tap revision duration (§45). Common durations as a segmented control, plus «أخرى» for
// an exact number (5–240, the server's range). Keyboard: arrows move between the choices.
import { useState } from 'react';
import { SegmentedControl, TextField } from '../../../design';

export const MINUTE_PRESETS = ['10', '20', '30', '45', '60'] as const;
export const MIN_MINUTES = 5;
export const MAX_MINUTES = 240;
type Choice = (typeof MINUTE_PRESETS)[number] | 'other';

export function clampMinutes(n: number): number {
  if (!Number.isFinite(n)) return 20;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n)));
}

export function MinutesPicker({ value, onChange, label = 'المدة المتاحة بالدقائق' }: { value: number; onChange: (m: number) => void; label?: string }) {
  const isPreset = (MINUTE_PRESETS as readonly string[]).includes(String(value));
  const [choice, setChoice] = useState<Choice>(isPreset ? (String(value) as Choice) : 'other');
  const [custom, setCustom] = useState(isPreset ? '' : String(value));
  const error = choice === 'other' && custom !== '' && (Number(custom) < MIN_MINUTES || Number(custom) > MAX_MINUTES) ? `اختر بين ${MIN_MINUTES} و${MAX_MINUTES} دقيقة.` : undefined;
  return (
    <div className="lw-minutes">
      <SegmentedControl<Choice>
        label={label}
        showLabel
        options={[...MINUTE_PRESETS.map((m) => ({ value: m as Choice, label: m })), { value: 'other', label: 'أخرى' }]}
        value={choice}
        onValueChange={(v) => {
          setChoice(v);
          if (v !== 'other') onChange(Number(v));
          else if (custom) onChange(clampMinutes(Number(custom)));
        }}
      />
      {choice === 'other' && (
        <TextField
          label="عدد الدقائق"
          type="number"
          inputMode="numeric"
          min={MIN_MINUTES}
          max={MAX_MINUTES}
          dir="ltr"
          value={custom}
          error={error}
          hint={error ? undefined : `من ${MIN_MINUTES} إلى ${MAX_MINUTES} دقيقة.`}
          onChange={(e) => {
            setCustom(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value && Number.isFinite(n)) onChange(clampMinutes(n));
          }}
          fieldClassName="lw-minutes__custom"
        />
      )}
    </div>
  );
}
