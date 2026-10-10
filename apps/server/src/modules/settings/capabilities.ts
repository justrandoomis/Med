// Capability registry (§61): every feature has a live, honest state. Unfinished features are
// 'not_implemented' with an Arabic reason; AI features need a configured provider. Modules call
// ctx.capabilities.set(key, state, reason_ar) when they register (e.g. 'available').
import { FEATURE_KEYS, type AiTask, type CapabilitiesResponse, type FeatureKey, type FeatureState, type FeatureStatus } from '@medlevo/shared';
import type { AiOrchestrator } from '../ai/orchestrator';
import type { Clock } from '../../lib/time';

const NOT_IMPLEMENTED_AR = 'لم تُبنَ هذه الميزة بعد في هذا الإصدار.';
const AI_REQUIRES_CONFIG_AR = 'تتطلب ضبط مزود ذكاء اصطناعي على الخادم (ANTHROPIC_API_KEY).';

/** Features that cannot work without an AI provider. */
export const AI_DEPENDENT_FEATURES: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  'ai.explain',
  'ai.chat',
  'ai.study_book',
  'ai.summaries',
  'ai.figure_explain',
  'ai.generate_questions',
  'ai.grade_written',
  'ai.cases',
  'ai.answer_check',
  'processing.vision',
  // (track F4) handwriting recognition reads pictures of the owner's strokes with a vision provider
  'workspace.handwriting_recognition',
]);

/**
 * (track F4) Features that need one specific AI task: a configured provider that cannot run it (e.g. no vision) still
 * leaves the feature `requires_configuration`, with the reason.
 */
export const FEATURE_AI_TASK: Partial<Record<FeatureKey, { task: AiTask; reason_ar: string; not_configured_ar: string }>> = {
  'workspace.handwriting_recognition': {
    task: 'ink_recognize',
    reason_ar: 'قراءة الخط اليدوي تحتاج مزود ذكاء اصطناعي يدعم قراءة الصور (vision)، والمزود المضبوط على الخادم لا يدعمها.',
    not_configured_ar:
      'قراءة الخط اليدوي تحتاج مزود ذكاء اصطناعي يقرأ الصور (vision) مضبوطًا على الخادم (ANTHROPIC_API_KEY)، وهو غير مضبوط. كتابتك نفسها تُحفظ وتعمل كاملة دونه، ويمكنك كتابة النص بنفسك.',
  },
  // (track F3) the on-demand Vision step for figures reads the figure's crop with a vision model
  'processing.vision': {
    task: 'vision_figure',
    reason_ar: 'قراءة بنية الأشكال (العقد والأسهم والاتجاه) تحتاج مزود ذكاء اصطناعي يدعم قراءة الصور (vision)، والمزود المضبوط على الخادم لا يدعمها.',
    not_configured_ar:
      'قراءة بنية الأشكال بالرؤية الحاسوبية تحتاج مزود ذكاء اصطناعي يقرأ الصور مضبوطًا على الخادم (ANTHROPIC_API_KEY)، وهو غير مضبوط. تسميات الرسوم تُقرأ دونه بالـOCR فقط وتبقى «غير مؤكدة»، ولا تُستنتج الأسهم.',
  },
};

interface Entry {
  state: FeatureState;
  reason_ar?: string;
}

export class CapabilityRegistry {
  private readonly entries = new Map<FeatureKey, Entry>();

  constructor(
    private readonly ai: Pick<AiOrchestrator, 'configured' | 'providerName' | 'budget'> & { supportsTask?: (task: AiTask) => boolean },
    private readonly clock: Clock,
    private readonly appVersion: string,
  ) {
    for (const key of FEATURE_KEYS) this.entries.set(key, { state: 'not_implemented', reason_ar: NOT_IMPLEMENTED_AR });
  }

  /** Declare the implementation state of a feature (called by the owning module at registration). */
  set(key: FeatureKey, state: FeatureState, reason_ar?: string): void {
    if (!(FEATURE_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown feature key: ${key}`);
    if (state !== 'available' && !reason_ar) throw new Error(`Feature ${key} is ${state}: an Arabic reason is required`);
    this.entries.set(key, reason_ar ? { state, reason_ar } : { state });
  }

  get(key: FeatureKey): FeatureStatus {
    const e = this.entries.get(key) ?? { state: 'not_implemented' as const, reason_ar: NOT_IMPLEMENTED_AR };
    if (AI_DEPENDENT_FEATURES.has(key) && !this.ai.configured) {
      if (e.state === 'available') return { key, state: 'requires_configuration', reason_ar: FEATURE_AI_TASK[key]?.not_configured_ar ?? AI_REQUIRES_CONFIG_AR };
      if (e.state === 'not_implemented') {
        return { key, state: 'requires_configuration', reason_ar: `${AI_REQUIRES_CONFIG_AR} كما أن الميزة نفسها لم تُبنَ بعد.` };
      }
    }
    const needs = FEATURE_AI_TASK[key];
    if (needs && e.state === 'available' && this.ai.configured && this.ai.supportsTask && !this.ai.supportsTask(needs.task)) {
      return { key, state: 'requires_configuration', reason_ar: needs.reason_ar };
    }
    const out: FeatureStatus = { key, state: e.state };
    if (e.reason_ar) out.reason_ar = e.reason_ar;
    return out;
  }

  isAvailable(key: FeatureKey): boolean {
    return this.get(key).state === 'available';
  }

  snapshot(): CapabilitiesResponse {
    const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, this.get(k)])) as Record<FeatureKey, FeatureStatus>;
    const ai: CapabilitiesResponse['ai'] = { configured: this.ai.configured };
    if (this.ai.providerName) ai.provider = this.ai.providerName;
    ai.budget_remaining_usd = this.ai.configured ? this.ai.budget().remaining_usd : null;
    return { features, ai, server_time: this.clock.now(), app_version: this.appVersion };
  }
}
