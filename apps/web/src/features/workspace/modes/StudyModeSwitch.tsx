// The study-mode switch in the reading bar (§39). One menu, five modes; the current one is named in the trigger and
// marked in the list in words («الحالي») and with a check — never by colour alone. Choosing a mode re-arranges the
// same workspace (rail order, default section, panels, question density, what Exam mode hides); nothing is reloaded.
import { Check, GraduationCap } from 'lucide-react';
import { STUDY_MODES, STUDY_MODE_HINTS_AR, STUDY_MODE_LABELS_AR, type StudyMode } from '@medlevo/shared';
import { Button, IconButton, Menu, MenuItem } from '../../../design';

export function StudyModeSwitch({ mode, onChange, compact = false }: { mode: StudyMode; onChange: (m: StudyMode) => void; compact?: boolean }) {
  const label = `وضع الدراسة: ${STUDY_MODE_LABELS_AR[mode]}`;
  return (
    <Menu
      label="وضع الدراسة"
      align="end"
      trigger={
        compact ? (
          <IconButton label={label} icon={<GraduationCap size={20} />} />
        ) : (
          <Button size="sm" variant="plain" icon={<GraduationCap size={16} />} aria-label={label} className="wk-modeswitch" data-mode={mode}>
            {STUDY_MODE_LABELS_AR[mode]}
          </Button>
        )
      }
    >
      {STUDY_MODES.map((m) => (
        <MenuItem key={m} icon={m === mode ? <Check size={16} /> : <span className="wk-menu-blank" />} hint={m === mode ? 'الحالي' : undefined} onSelect={() => onChange(m)}>
          <span className="wk-modeswitch__item">
            <span className="wk-modeswitch__name">{STUDY_MODE_LABELS_AR[m]}</span>
            <span className="wk-modeswitch__hint">{STUDY_MODE_HINTS_AR[m]}</span>
          </span>
        </MenuItem>
      ))}
    </Menu>
  );
}
