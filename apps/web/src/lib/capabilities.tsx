// Capability registry client (spec §61, ARCHITECTURE §0.7, §4).
// GET /api/capabilities tells the UI which features really work right now. Controls for anything
// else are disabled WITH the reason — never a button that silently does nothing.
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import type { CapabilitiesResponse, FeatureKey, FeatureState, FeatureStatus } from '@medlevo/shared';
import { api, isApiError } from './api';

const CACHE_KEY = 'medlevo.capabilities.v1';

/** Features that need the server/network even when the app shell works offline (§47, AC-23). */
const NEEDS_CONNECTION: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  'upload',
  'processing.pdf',
  'processing.docx',
  'processing.pptx',
  'processing.images',
  'processing.zip',
  'processing.legacy_office',
  'processing.ocr',
  'processing.vision',
  'workspace.handwriting_recognition',
  'search.semantic',
  'ai.explain',
  'ai.chat',
  'ai.study_book',
  'ai.summaries',
  'ai.figure_explain',
  'ai.generate_questions',
  'ai.grade_written',
  'ai.cases',
  'external.evidence',
  'external.images',
  'questions.extraction',
  'questions.matching',
  'backup',
  'export.pdf',
  'export.docx',
]);

export const FEATURE_STATE_REASONS_AR: Record<Exclude<FeatureState, 'available'>, string> = {
  not_implemented: 'هذه الميزة لم تُبنَ بعد، لذلك هي معطّلة.',
  requires_configuration: 'تحتاج هذه الميزة إعدادًا على الخادم (مثل مفتاح مزوّد AI) قبل أن تعمل.',
  requires_connection: 'تحتاج هذه الميزة اتصالًا بالإنترنت.',
  requires_native: 'هذه الميزة غير مدعومة في هذا المتصفح وتحتاج تطبيقًا أصليًا.',
  disabled_by_owner: 'عطّلت هذه الميزة من الإعدادات.',
};

export type CapabilitiesStatus = 'loading' | 'ready' | 'stale' | 'error';

interface CapabilitiesState {
  status: CapabilitiesStatus;
  data: CapabilitiesResponse | null;
  error: string | null;
  fetchedAt: number | null;
}

function readCache(): { data: CapabilitiesResponse; fetchedAt: number } | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: CapabilitiesResponse; fetchedAt: number };
    return parsed?.data?.features ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(data: CapabilitiesResponse, fetchedAt: number) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ data, fetchedAt }));
  } catch {
    // ignore
  }
}

class CapabilitiesStore {
  private state: CapabilitiesState;
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;

  constructor() {
    const cached = typeof window !== 'undefined' ? readCache() : null;
    this.state = cached
      ? { status: 'stale', data: cached.data, error: null, fetchedAt: cached.fetchedAt }
      : { status: 'loading', data: null, error: null, fetchedAt: null };
  }

  get = (): CapabilitiesState => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private set(s: Partial<CapabilitiesState>) {
    this.state = { ...this.state, ...s };
    this.listeners.forEach((l) => l());
  }

  /** Fetch (deduplicated). Keeps the last known data when the server is unreachable. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = api
      // background (runs on reconnect, e.g. while the owner writes): never redirect on 401
      .get<CapabilitiesResponse>('/capabilities', { timeoutMs: 20_000, skipAuthRedirect: true })
      .then((data) => {
        const now = Date.now();
        writeCache(data, now);
        this.set({ status: 'ready', data, error: null, fetchedAt: now });
      })
      .catch((e: unknown) => {
        const msg = isApiError(e) ? e.message : 'تعذّر التحقق من الميزات المتاحة.';
        this.set({ status: this.state.data ? 'stale' : 'error', error: msg });
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** For tests. */
  reset(data: CapabilitiesResponse | null) {
    this.state = data ? { status: 'ready', data, error: null, fetchedAt: Date.now() } : { status: 'loading', data: null, error: null, fetchedAt: null };
    this.listeners.forEach((l) => l());
  }
}

export const capabilitiesStore = new CapabilitiesStore();

function onlineNow() {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export interface FeatureGateState {
  available: boolean;
  state: FeatureState | 'unknown';
  reason: string | null;
}

/** Resolves a feature's live status, overlaying "needs connection" while offline. */
export function resolveFeature(data: CapabilitiesResponse | null, key: FeatureKey, online: boolean): FeatureGateState {
  const status: FeatureStatus | undefined = data?.features?.[key];
  if (!status) {
    return data
      ? { available: false, state: 'not_implemented', reason: FEATURE_STATE_REASONS_AR.not_implemented }
      : { available: false, state: 'unknown', reason: online ? 'جارٍ التحقق من توفر هذه الميزة…' : 'تعذّر التحقق من توفر هذه الميزة دون اتصال.' };
  }
  if (status.state === 'available') {
    if (!online && NEEDS_CONNECTION.has(key)) return { available: false, state: 'requires_connection', reason: FEATURE_STATE_REASONS_AR.requires_connection };
    return { available: true, state: 'available', reason: null };
  }
  return { available: false, state: status.state, reason: status.reason_ar || FEATURE_STATE_REASONS_AR[status.state] };
}

/**
 * Live capabilities. Fetches once per app session and again when connectivity returns.
 * `feature(key)` → { available, state, reason } (reason in Arabic when unavailable).
 */
export function useCapabilities() {
  const state = useSyncExternalStore(capabilitiesStore.subscribe, capabilitiesStore.get, capabilitiesStore.get);
  const online = useSyncExternalStore(subscribeOnline, onlineNow, () => true);
  // fetch when first needed, and re-check whenever connectivity changes
  useEffect(() => {
    if (online && state.status !== 'ready') void capabilitiesStore.refresh();
  }, [online, state.status]);
  return {
    ...state,
    online,
    refresh: () => capabilitiesStore.refresh(),
    feature: (key: FeatureKey) => resolveFeature(state.data, key, online),
  };
}

export interface FeatureGateProps {
  feature: FeatureKey;
  /**
   * Content to gate. A function receives the gate state (render your own disabled control + reason);
   * plain children are shown disabled (inert) with the reason underneath when unavailable.
   */
  children: ReactNode | ((gate: FeatureGateState) => ReactNode);
  /** Hide the reason text (only when the reason is shown elsewhere, e.g. in a tooltip). */
  hideReason?: boolean;
  className?: string;
}

export function FeatureGate({ feature, children, hideReason, className }: FeatureGateProps) {
  const caps = useCapabilities();
  const gate = caps.feature(feature);
  if (typeof children === 'function') return <>{children(gate)}</>;
  if (gate.available) return <>{children}</>;
  return (
    <div className={className ? `ml-feature-gate ${className}` : 'ml-feature-gate'} data-feature={feature} data-state={gate.state}>
      <div className="ml-feature-gate__content" inert aria-disabled="true">
        {children}
      </div>
      {!hideReason && gate.reason && (
        <p className="ml-feature-gate__reason">
          <Info size={16} aria-hidden="true" />
          <span>{gate.reason}</span>
        </p>
      )}
    </div>
  );
}
