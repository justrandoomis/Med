// AOS-21.46 «لا تفترض أن الذكاء الاصطناعي مجاني أو بلا حد» — the web part (track C3). Wherever an AI action is offered,
// the account's remaining AI allowance is visible, from the server's own view (`GET /api/accounts/me/quota`, C1:
// `QuotaView.ai` — remaining_usd, resets_at, blocked_reason_ar, the numbers the atomic reservation checks). Honest:
//   * the amounts are ESTIMATES and say so;
//   * an allowance the server did not give is never invented (an older server: computed from limit − used, never < 0;
//     no limit: what was used this month; nothing known: said so, no number);
//   * blocked: the server's own reason (no provider, no consent, allowance spent, the deployment ceiling);
//   * offline: the last answer this device heard, said as such with its time.
// One request per account and minute at most (all notes on a screen share it); an AI action calls `spent()` so the
// number follows the spending. Kept per account (`userStorage`), never shown to another account in this browser.
import { useEffect, useSyncExternalStore } from 'react';
import { Gauge } from 'lucide-react';
import type { QuotaView } from '@medlevo/shared';
import { Bidi } from '../design/components/Bidi';
import { api, errorMessage } from './api';
import { formatDate, formatDateTime } from './time';
import { onStorageAccountChange, readJson, storageAccount, userStorage, writeJson } from './userStorage';

const CACHE_KEY = 'medlevo.aiAllowance.v1';
/** an answer younger than this is not asked again */
const FRESH_MS = 60_000;

interface AllowanceState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  quota: QuotaView | null;
  fetchedAt: number | null;
  /** the server could not be reached for a newer answer: the shown quota is this device's last one */
  stale: boolean;
  error: string | null;
}

function isQuota(q: unknown): q is QuotaView {
  const ai = q && typeof q === 'object' ? (q as { ai?: unknown }).ai : null;
  return !!ai && typeof ai === 'object' && typeof (ai as { used_usd_est?: unknown }).used_usd_est === 'number';
}

function readCache(): { quota: QuotaView; fetchedAt: number } | null {
  const c = readJson<{ quota: QuotaView; fetchedAt: number }>(userStorage, CACHE_KEY);
  return c && isQuota(c.quota) && typeof c.fetchedAt === 'number' ? c : null;
}

class AiAllowanceStore {
  private state: AllowanceState = this.initial();
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;

  constructor() {
    onStorageAccountChange(() => {
      this.inFlight = null;
      this.set(this.initial());
    });
  }

  private initial(): AllowanceState {
    const cached = typeof window !== 'undefined' ? readCache() : null;
    // this device's last answer is shown at once; `ensure()` asks again when it is older than FRESH_MS
    return cached ? { status: 'ready', quota: cached.quota, fetchedAt: cached.fetchedAt, stale: false, error: null } : { status: 'idle', quota: null, fetchedAt: null, stale: false, error: null };
  }

  get = (): AllowanceState => this.state;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private set(s: Partial<AllowanceState>) {
    this.state = { ...this.state, ...s };
    this.listeners.forEach((l) => l());
  }

  /** Ask the server unless a fresh answer is already here (deduplicated). */
  ensure(): void {
    const s = this.state;
    if (this.inFlight) return;
    if (s.status === 'ready' && s.fetchedAt !== null && Date.now() - s.fetchedAt < FRESH_MS) return;
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const asked = storageAccount()?.userId ?? null;
    if (!this.state.quota) this.set({ status: 'loading' });
    this.inFlight = api
      .get<QuotaView>('/accounts/me/quota', { timeoutMs: 20_000, skipAuthRedirect: true })
      .then((quota) => {
        if ((storageAccount()?.userId ?? null) !== asked) return;
        // an answer without the AI part (an older or a different server) is not an allowance: nothing is invented
        if (!isQuota(quota)) throw new Error('الخادم لم يُرسل رصيد الذكاء الاصطناعي');
        const now = Date.now();
        writeJson(userStorage, CACHE_KEY, { quota, fetchedAt: now });
        this.set({ status: 'ready', quota, fetchedAt: now, stale: false, error: null });
      })
      .catch((e: unknown) => {
        if ((storageAccount()?.userId ?? null) !== asked) return;
        const message = e instanceof Error && !('status' in e) ? e.message : errorMessage(e);
        this.set(this.state.quota ? { status: 'ready', stale: true, error: message } : { status: 'error', error: message });
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** An AI action ran (or was refused): the allowance changed — ask again now. */
  spent(): void {
    void this.refresh();
  }

  /** Tests only. */
  reset(): void {
    this.inFlight = null;
    this.state = { status: 'idle', quota: null, fetchedAt: null, stale: false, error: null };
    this.listeners.forEach((l) => l());
  }
}

export const aiAllowanceStore = new AiAllowanceStore();

const usd = (n: number): string => `$${(Number.isFinite(n) ? Math.max(0, n) : 0).toFixed(2)}`;

export interface AllowanceLine {
  tone: 'neutral' | 'warning';
  /** the whole sentence, logical order (screen readers, tests) */
  text: string;
  /** the amount as read: «$0.42 من $1.00» or «$0.58»; null when blocked */
  amount: string | null;
  /** the parts the view isolates as LTR runs */
  parts: { lead: string; remaining: string | null; limit: string | null; tail: string | null };
}

/** The sentence for the account's AI allowance (pure; `tz` for the reset day). */
export function aiAllowanceLine(q: QuotaView, tz?: string): AllowanceLine {
  const ai = q.ai;
  if (ai.blocked_reason_ar) {
    const lead = `الذكاء الاصطناعي متوقف لحسابك الآن: ${ai.blocked_reason_ar}`;
    return { tone: 'warning', text: lead, amount: null, parts: { lead, remaining: null, limit: null, tail: null } };
  }
  if (ai.limit_usd === null) {
    const lead = 'لا حد شهري لحسابك للذكاء الاصطناعي؛ استُخدم هذا الشهر (تقديري):';
    const used = usd(ai.used_usd_est);
    return { tone: 'neutral', text: `${lead} ${used}`, amount: used, parts: { lead, remaining: used, limit: null, tail: null } };
  }
  const remaining = usd(ai.remaining_usd ?? ai.limit_usd - ai.used_usd_est);
  const limit = usd(ai.limit_usd);
  const lead = 'المتبقي من رصيدك للذكاء الاصطناعي هذا الشهر (تقديري):';
  const tail = typeof ai.resets_at === 'number' ? `يتجدد في ${formatDate(ai.resets_at, tz)}.` : null;
  const amount = `${remaining} من ${limit}`;
  return { tone: 'neutral', text: [lead, amount, tail].filter(Boolean).join(' '), amount, parts: { lead, remaining, limit, tail } };
}

function useAiAllowance(): AllowanceState {
  const state = useSyncExternalStore(aiAllowanceStore.subscribe, aiAllowanceStore.get, aiAllowanceStore.get);
  useEffect(() => {
    aiAllowanceStore.ensure();
  }, []);
  return state;
}

/**
 * The account's remaining AI allowance, next to an AI action (`role="note"`, «رصيد الذكاء الاصطناعي»). Nothing while
 * the first answer is on its way.
 */
export function AiAllowanceNote({ className }: { className?: string }) {
  const s = useAiAllowance();
  if (s.status === 'idle' || s.status === 'loading') return null;
  const cls = ['ml-ai-allowance', className].filter(Boolean).join(' ');
  if (!s.quota) {
    return (
      <p role="note" aria-label="رصيد الذكاء الاصطناعي" className={cls} data-tone="neutral">
        <Gauge size={16} aria-hidden="true" />
        <span>تعذّر معرفة رصيدك للذكاء الاصطناعي الآن{s.error ? ` (${s.error})` : ''}. يُحسب كل طلب على رصيدك عند تنفيذه.</span>
      </p>
    );
  }
  const line = aiAllowanceLine(s.quota);
  const { lead, remaining, limit, tail } = line.parts;
  return (
    <p role="note" aria-label="رصيد الذكاء الاصطناعي" className={cls} data-tone={line.tone}>
      <Gauge size={16} aria-hidden="true" />
      <span>
        {lead}
        {remaining && (
          <>
            {' '}
            <Bidi dir="ltr">{remaining}</Bidi>
          </>
        )}
        {limit && (
          <>
            {' من '}
            <Bidi dir="ltr">{limit}</Bidi>
          </>
        )}
        {tail && ` ${tail}`}
        {s.stale && s.fetchedAt !== null && ` (آخر ما عرفه هذا الجهاز: ${formatDateTime(s.fetchedAt)})`}
      </span>
    </p>
  );
}
