// «التنبيهات» — /notifications (P1-T4 step 3; IA §4.9; PRD AOS-18.13, 21.31). One inbox for join decisions, new lectures
// and versions in followed subjects, followed-explanation updates, moderation outcomes, reports to moderate, note
// migrations and quota warnings. Grouped by day in the viewer's time zone; unread is said in text («غير مقروء»), never
// only a dot; each row opens its target (the target re-checks access) and is marked read. Push is not offered: the
// server says why. A copy of the last inbox is shown offline, read-only, with when it was saved.
import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight,
  BookOpen,
  CheckCheck,
  Flag,
  Gauge,
  Inbox,
  Megaphone,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  UserCheck,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import type { NotificationKind, NotificationPrefsResponse, NotificationView } from '@medlevo/shared';
import { Button, EmptyState, ErrorState, LoadingState, SegmentedControl, StatusPill, Switch, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { dayKey, formatDate, formatTime } from '../../lib/time';
import { withCache } from '../channels/cache';
import { CachedBanner, ReasonedButton } from '../channels/ui';
import { notificationsApi, setUnreadCount } from './api';
import './notifications.css';

const KIND_ICON: Record<NotificationKind, LucideIcon> = {
  join_requested: UserPlus,
  join_decided: UserCheck,
  invitation: UserPlus,
  official_lecture_new: BookOpen,
  official_version: RefreshCw,
  subject_update: Megaphone,
  publication_updated: RefreshCw,
  moderation: ShieldCheck,
  report_received: Flag,
  reanchor_ready: ArrowLeftRight,
  quota_warning: Gauge,
};

type Filter = 'all' | 'unread';

interface Loaded {
  items: NotificationView[];
  next: string | null;
  unread: number;
  cachedAt: number | null;
}

/** «اليوم» / «أمس» / a date — the heading of a day of notifications. */
export function dayHeading(ms: number, now = Date.now()): string {
  const d = dayKey(ms);
  if (d === dayKey(now)) return 'اليوم';
  if (d === dayKey(now - 86_400_000)) return 'أمس';
  return formatDate(ms);
}

function groupByDay(items: NotificationView[]): Array<{ key: string; heading: string; items: NotificationView[] }> {
  const out: Array<{ key: string; heading: string; items: NotificationView[] }> = [];
  for (const n of items) {
    const key = dayKey(n.created_at);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(n);
    else out.push({ key, heading: dayHeading(n.created_at), items: [n] });
  }
  return out;
}

export function NotificationsScreen() {
  usePageTitle('التنبيهات');
  const toast = useToast();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: Loaded | null }>({ loading: true, error: null, data: null });
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const prefsId = useId();

  useEffect(() => {
    let alive = true;
    withCache(`notifications.${filter}`, () => notificationsApi.list({ unread: filter === 'unread' }))
      .then(({ data, cachedAt }) => {
        if (!alive) return;
        setState({ loading: false, error: null, data: { items: data.items, next: data.next_cursor, unread: data.unread_count, cachedAt } });
        if (cachedAt === null) setUnreadCount(data.unread_count);
      })
      .catch((e) => alive && setState({ loading: false, error: errorMessage(e), data: null }));
    return () => {
      alive = false;
    };
  }, [filter, attempt]);

  const loadMore = useCallback(async () => {
    const cur = state.data;
    if (!cur?.next) return;
    setMore(true);
    try {
      const r = await notificationsApi.list({ unread: filter === 'unread', cursor: cur.next });
      setState((s) => (s.data ? { ...s, data: { ...s.data, items: [...s.data.items, ...r.items], next: r.next_cursor, unread: r.unread_count } } : s));
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setMore(false);
    }
  }, [filter, state.data, toast]);

  const markRead = useCallback(
    async (body: { ids: string[] } | { all: true }) => {
      const r = await notificationsApi.markRead(body);
      const now = Date.now();
      setState((s) =>
        s.data
          ? {
              ...s,
              data: {
                ...s.data,
                unread: r.unread_count,
                items: s.data.items.map((n) => ('all' in body || body.ids.includes(n.id) ? { ...n, read_at: n.read_at ?? now } : n)),
              },
            }
          : s,
      );
      setUnreadCount(r.unread_count);
    },
    [],
  );

  const open = async (n: NotificationView) => {
    if (!n.read_at) await markRead({ ids: [n.id] }).catch(() => undefined);
    if (n.link) navigate(n.link);
  };

  const data = state.data;
  const offline = data?.cachedAt != null;
  return (
    <div className="ml-page ml-page--narrow nt-screen">
      <header className="ml-page__header nt-header">
        <h1 className="ml-page__title">التنبيهات</h1>
        <p className="ml-page__lede">{data ? (data.unread > 0 ? `${data.unread} غير مقروءة` : 'لا جديد غير مقروء') : ' '}</p>
      </header>
      {offline && <CachedBanner at={data.cachedAt!} />}
      <div className="nt-toolbar">
        <SegmentedControl
          label="ما يُعرض"
          value={filter}
          onValueChange={(v) => {
            setFilter(v);
            setState((s) => ({ ...s, loading: true }));
          }}
          options={[
            { value: 'all', label: 'الكل' },
            { value: 'unread', label: 'غير المقروءة' },
          ]}
        />
        <ReasonedButton
          icon={<CheckCheck size={18} />}
          reason={offline ? 'يحتاج اتصالًا بالخادم.' : !data || data.unread === 0 ? 'لا توجد تنبيهات غير مقروءة.' : null}
          onClick={() => void markRead({ all: true }).catch((e) => toast.show({ title: errorMessage(e), tone: 'danger' }))}
        >
          علّم الكل كمقروء
        </ReasonedButton>
      </div>

      {state.loading && !data ? (
        <LoadingState stage="جارٍ تحميل التنبيهات…" />
      ) : state.error && !data ? (
        <ErrorState message={state.error} onRetry={() => setAttempt((a) => a + 1)} />
      ) : data && data.items.length === 0 ? (
        <EmptyState
          icon={<Inbox size={28} />}
          title={filter === 'unread' ? 'لا توجد تنبيهات غير مقروءة' : 'لا توجد تنبيهات بعد'}
          description="تصلك هنا قرارات طلبات الانضمام، والمحاضرات والإصدارات الجديدة في موادك، وتحديثات الشروح التي تتابعها، وقرارات الإشراف."
        />
      ) : (
        data && (
          <div className="nt-days">
            {groupByDay(data.items).map((g) => (
              <section key={g.key} aria-label={g.heading} className="nt-day">
                <h2 className="ml-group-header">{g.heading}</h2>
                <ul role="list" className="ml-list">
                  {g.items.map((n) => (
                    <NotificationRow key={n.id} n={n} offline={offline} onOpen={() => void open(n)} onRead={() => void markRead({ ids: [n.id] }).catch((e) => toast.show({ title: errorMessage(e), tone: 'danger' }))} />
                  ))}
                </ul>
              </section>
            ))}
            {data.next && (
              <Button onClick={() => void loadMore()} loading={more} loadingLabel="جارٍ التحميل…">
                اعرض الأقدم
              </Button>
            )}
          </div>
        )
      )}

      <section className="nt-prefs" aria-labelledby={`${prefsId}-h`}>
        <h2 id={`${prefsId}-h`} className="ml-visually-hidden">
          تفضيلات التنبيهات
        </h2>
        <Button variant="plain" icon={<SlidersHorizontal size={18} />} aria-expanded={prefsOpen} aria-controls={prefsId} onClick={() => setPrefsOpen((o) => !o)}>
          تفضيلات التنبيهات
        </Button>
        {prefsOpen && (
          <div id={prefsId}>
            <PrefsPanel />
          </div>
        )}
      </section>
    </div>
  );
}

/** One notification (IA §8.2 NotificationRow): icon, the server's Arabic line, who and when, unread in text. */
function NotificationRow({ n, offline, onOpen, onRead }: { n: NotificationView; offline: boolean; onOpen: () => void; onRead: () => void }) {
  const Icon = KIND_ICON[n.kind] ?? Inbox;
  const unread = !n.read_at;
  const body = (
    <>
      <span className="nt-row__text">{n.text_ar}</span>
      <span className="nt-row__meta">
        {n.actor && <span>{n.actor.display_name}</span>}
        <time dateTime={new Date(n.created_at).toISOString()}>{formatTime(n.created_at)}</time>
      </span>
    </>
  );
  return (
    <li className={`ml-list__row nt-row${unread ? ' nt-row--unread' : ''}`}>
      <Icon size={20} aria-hidden="true" className="nt-row__icon" />
      {n.link ? (
        <Link
          to={n.link}
          className="nt-row__main"
          onClick={(e) => {
            e.preventDefault();
            onOpen();
          }}
        >
          {body}
        </Link>
      ) : (
        <div className="nt-row__main">{body}</div>
      )}
      <div className="nt-row__end">
        {unread && <StatusPill tone="accent">غير مقروء</StatusPill>}
        {unread && !offline && (
          <Button size="sm" variant="plain" onClick={onRead}>
            علّم كمقروء
          </Button>
        )}
      </div>
    </li>
  );
}

/** Which kinds reach the in-app inbox; push is not offered on this server and says why. */
function PrefsPanel() {
  const toast = useToast();
  const [prefs, setPrefs] = useState<NotificationPrefsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    notificationsApi
      .prefs()
      .then(setPrefs)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  if (error) return <ErrorState inline message={error} />;
  if (!prefs) return <LoadingState inline stage="جارٍ تحميل التفضيلات…" />;
  const toggle = async (kind: NotificationKind, enabled: boolean) => {
    const before = prefs;
    setPrefs({ ...prefs, prefs: prefs.prefs.map((p) => (p.kind === kind ? { ...p, in_app: enabled } : p)) });
    try {
      setPrefs(await notificationsApi.putPrefs({ prefs: [{ kind, channel: 'in_app', enabled }] }));
    } catch (e) {
      setPrefs(before);
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };
  return (
    <div className="ml-stack nt-prefs__panel">
      <div className="ml-group">
        {prefs.prefs.map((p) => (
          <div key={p.kind} className="ml-group__row">
            <Switch label={p.label_ar} checked={p.in_app} onCheckedChange={(v) => void toggle(p.kind, v)} />
          </div>
        ))}
      </div>
      <p className="ml-group-footer">
        <strong>الإشعارات خارج التطبيق: </strong>
        {prefs.push.available ? 'متاحة على هذا الجهاز.' : (prefs.push.reason_ar ?? 'غير متاحة على هذا الجهاز.')}
      </p>
    </div>
  );
}
