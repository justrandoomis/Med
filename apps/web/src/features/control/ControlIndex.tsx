// The Control Center index: every section with ONE sentence of real state — no counters dashboard (§56).
import { ArrowUpLeft, Archive, Bell, BrainCircuit, ChevronLeft, ClipboardCheck, Cog, GitCompare, History, Layers3, ListOrdered, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { ErrorState, ListItem } from '../../design';
import { useSyncSnapshot } from '../../lib/sync';
import { usePageTitle } from '../../lib/usePageTitle';
import { ATTENTION_KEYS, SECTIONS, statusLine, type SectionKey } from './model';
import { useControlContext } from './shared';
import { useOnline } from '../../lib/useOnline';

const ICONS: Record<SectionKey, ReactNode> = {
  review: <ClipboardCheck size={20} />,
  alerts: <Bell size={20} />,
  sync: <GitCompare size={20} />,
  processing: <Cog size={20} />,
  sources: <ListOrdered size={20} />,
  intelligence: <BrainCircuit size={20} />,
  storage: <Archive size={20} />,
  profile: <Layers3 size={20} />,
  capabilities: <ShieldCheck size={20} />,
  history: <History size={20} />,
};

function Group({ title, keys }: { title: string; keys: SectionKey[] }) {
  const { overview } = useControlContext();
  const snap = useSyncSnapshot();
  return (
    <section className="cc-index__group" aria-label={title}>
      <h2 className="ml-group-header">{title}</h2>
      <ul role="list" className="ml-list">
        {SECTIONS.filter((s) => keys.includes(s.key)).map((s) => (
          <ListItem
            key={s.key}
            to={s.href}
            leading={ICONS[s.key]}
            title={s.label}
            subtitle={statusLine(s.key, overview, { conflicts: snap.conflicts, errors: snap.errors, pending: snap.pending }) ?? s.purpose}
            trailing={s.external ? <ArrowUpLeft size={16} aria-label="شاشة أخرى" /> : <ChevronLeft size={18} aria-hidden="true" />}
          />
        ))}
      </ul>
    </section>
  );
}

export function ControlIndex() {
  usePageTitle('مركز التحكم');
  const { overview, reloadOverview } = useControlContext();
  const online = useOnline();
  const rest = SECTIONS.filter((s) => !ATTENTION_KEYS.includes(s.key)).map((s) => s.key);
  return (
    <div className="cc-index">
      <header className="cc-head">
        <h1 className="ml-page__title">مركز التحكم</h1>
        <p className="cc-head__lede">مكان واحد لما ينتظر قرارك، وما يجري على الخادم، وما يؤثر في المحتوى المولّد. لا يُعاد توليد شيء من هنا دون أن تطلبه.</p>
      </header>
      {!overview && !online && <ErrorState inline title="بعض الأقسام تحتاج اتصالًا" message="الحالة التالية من هذا الجهاز فقط؛ أقسام الخادم تُحدَّث عند عودة الاتصال." onRetry={reloadOverview} />}
      <Group title="ينتظر قرارك أو انتباهك" keys={ATTENTION_KEYS} />
      <Group title="الإعدادات المؤثرة وبياناتك" keys={rest} />
    </div>
  );
}
