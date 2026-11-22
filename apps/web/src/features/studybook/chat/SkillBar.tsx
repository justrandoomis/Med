// Smart chat skill chips (wp/smart-rail): one quiet row above the composer — «اشرح الصفحة»، «لخّص»، «اسألني MCQ»،
// «حالة سريرية»، «قارن»، «بطاقات»، «سؤال من الصورة»، «اشرح الشكل»، «أسئلة المحاضرة»، «المصادر». A skill that cannot run
// is shown disabled, and the reason (the server's, e.g. no AI provider) is written under the row — never hidden.
// «اسألني MCQ» and «قارن» ask a few choices first in a small inline form (count + difficulty / the two terms).
import { useId, useState, type ReactNode } from 'react';
import { BookOpen, FileQuestion, Image as ImageIcon, Layers, ListChecks, ListTree, ScanSearch, Scale, Sparkles, Stethoscope, X } from 'lucide-react';
import { GENERATION_DIFFICULTIES, GENERATION_DIFFICULTY_LABELS_AR, type ChatSkillId, type GenerationDifficulty } from '@medlevo/shared';
import { Button, IconButton, SegmentedControl, Select, TextField } from '../../../design';
import { MCQ_COUNTS, type SkillDef } from './skills';

export interface SkillItem {
  def: SkillDef;
  available: boolean;
  /** why it cannot run now (the server's reason when there is one) */
  reason: string | null;
}

export interface SkillRunInput {
  count?: number;
  difficulty?: GenerationDifficulty;
  items?: string[];
}

export const SKILL_ICONS: Record<ChatSkillId, ReactNode> = {
  explain_page: <Sparkles size={14} />,
  summarize: <ListTree size={14} />,
  mcq: <ListChecks size={14} />,
  case: <Stethoscope size={14} />,
  compare: <Scale size={14} />,
  cards: <Layers size={14} />,
  figure_question: <FileQuestion size={14} />,
  explain_figure: <ImageIcon size={14} />,
  lecture_questions: <BookOpen size={14} />,
  sources: <ScanSearch size={14} />,
};

export interface SkillBarProps {
  items: SkillItem[];
  /** a skill is running (chips wait) */
  busy: boolean;
  /** the form of a skill opened from the «/» menu */
  formFor: ChatSkillId | null;
  onForm: (id: ChatSkillId | null) => void;
  onRun: (id: ChatSkillId, input: SkillRunInput) => void;
  /** prefill of the compare form (e.g. the selection) */
  compareSeed?: string;
}

export function SkillBar(p: SkillBarProps) {
  const base = useId();
  // one line per distinct reason, naming the skills it holds back
  const reasons = [...new Set(p.items.filter((i) => !i.available && i.reason).map((i) => i.reason!))];
  const reasonId = (r: string) => `${base}-r${reasons.indexOf(r)}`;
  const open = p.formFor ? p.items.find((i) => i.def.id === p.formFor) : undefined;
  return (
    <div className="ch-skills">
      <div className="ch-skills__row" role="group" aria-label="مهارات المحادثة">
        {p.items.map((it) => (
          <Button
            key={it.def.id}
            size="sm"
            variant="secondary"
            className="ch-skill"
            icon={SKILL_ICONS[it.def.id]}
            disabled={!it.available || p.busy}
            aria-describedby={!it.available && it.reason ? reasonId(it.reason) : undefined}
            aria-expanded={it.def.form ? p.formFor === it.def.id : undefined}
            title={!it.available && it.reason ? it.reason : it.def.hint}
            onClick={() => (it.def.form ? p.onForm(p.formFor === it.def.id ? null : it.def.id) : p.onRun(it.def.id, {}))}
          >
            {it.def.label}
          </Button>
        ))}
      </div>
      {reasons.length > 0 && (
        <ul className="ch-skills__reasons" aria-label="مهارات غير متاحة الآن">
          {reasons.map((r) => (
            <li key={r} id={reasonId(r)}>
              {`${p.items
                .filter((i) => !i.available && i.reason === r)
                .map((i) => `«${i.def.label}»`)
                .join('، ')}: ${r}`}
            </li>
          ))}
        </ul>
      )}
      {open?.available && open.def.form === 'mcq' && <McqForm busy={p.busy} onClose={() => p.onForm(null)} onRun={(input) => p.onRun('mcq', input)} />}
      {open?.available && open.def.form === 'compare' && <CompareForm busy={p.busy} seed={p.compareSeed} onClose={() => p.onForm(null)} onRun={(input) => p.onRun('compare', input)} />}
    </div>
  );
}

function FormHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="ch-skillform__head">
      <span className="ch-skillform__title">{title}</span>
      <IconButton size="sm" variant="plain" label="أغلق" icon={<X size={14} />} onClick={onClose} />
    </div>
  );
}

function McqForm({ busy, onClose, onRun }: { busy: boolean; onClose: () => void; onRun: (i: SkillRunInput) => void }) {
  const [count, setCount] = useState<string>('3');
  const [difficulty, setDifficulty] = useState<GenerationDifficulty>('hard');
  return (
    <form
      className="ch-skillform"
      aria-label="اسألني MCQ"
      onSubmit={(e) => {
        e.preventDefault();
        onRun({ count: Number(count), difficulty });
      }}
    >
      <FormHead title="اسألني MCQ" onClose={onClose} />
      <SegmentedControl label="عدد الأسئلة" showLabel size="sm" options={MCQ_COUNTS.map((n) => ({ value: String(n), label: String(n) }))} value={count} onValueChange={setCount} />
      <Select label="الصعوبة (تقديرية)" options={GENERATION_DIFFICULTIES.map((d) => ({ value: d, label: GENERATION_DIFFICULTY_LABELS_AR[d] }))} value={difficulty} onValueChange={(v) => setDifficulty(v as GenerationDifficulty)} />
      <p className="ch-muted">يُنشر السؤال بعد التحقق المستقل من مفتاحه ومن تفسير كل خيار؛ ما لا يجتاز يبقى بانتظار مراجعتك.</p>
      <Button type="submit" size="sm" variant="primary" disabled={busy}>
        ابدأ
      </Button>
    </form>
  );
}

function CompareForm({ busy, seed, onClose, onRun }: { busy: boolean; seed?: string; onClose: () => void; onRun: (i: SkillRunInput) => void }) {
  const [a, setA] = useState(seed ?? '');
  const [b, setB] = useState('');
  const ok = a.trim() && b.trim();
  return (
    <form
      className="ch-skillform"
      aria-label="قارن"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onRun({ items: [a.trim(), b.trim()] });
      }}
    >
      <FormHead title="قارن في جدول" onClose={onClose} />
      <TextField label="الطرف الأول" value={a} onChange={(e) => setA(e.target.value)} maxLength={200} />
      <TextField label="الطرف الثاني" value={b} onChange={(e) => setB(e.target.value)} maxLength={200} placeholder="مثلًا: CT abdomen" />
      <Button type="submit" size="sm" variant="primary" disabled={busy || !ok}>
        قارن في جدول
      </Button>
    </form>
  );
}
