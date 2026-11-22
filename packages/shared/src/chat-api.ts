// Claude-style study chat (explain / question help / compare / free chat) on top of the contextual chat of §30.
// The conversation itself is the Study Book's contextual_thread + message (studybook-api.ts); this file adds what the
// chat surface needs on top: the model + effort the owner may pick per message (an allow-list — the server refuses
// anything else), the kind of conversation, per-message page tags (which lecture pages an answer explains, for the
// reader ↔ chat page sync), and the owner's remembered chat preferences.
import type { AnswerStyle } from './enums';
import type { SourceScope } from './scope';
import type { SelectionAnchor } from './studybook';

// ───────── models + effort (Claude-style picker) ─────────
/** Models the owner may choose for a chat answer. Verification of the answer always runs on the configured verifier. */
export const CHAT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type ChatModelId = (typeof CHAT_MODELS)[number];

export const CHAT_MODEL_INFO: Record<ChatModelId, { name: string; hint_ar: string }> = {
  'claude-opus-5-5': { name: 'Opus 5.5', hint_ar: 'الأدق' },
  'claude-sonnet-5-5': { name: 'Sonnet 5.5', hint_ar: 'متوازن' },
  'claude-haiku-5-5': { name: 'Haiku 5.5', hint_ar: 'الأسرع' },
};

/** `output_config.effort` levels; all three chat models accept all five. */
export const CHAT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];

export const CHAT_EFFORT_LABELS_AR: Record<ChatEffort, string> = {
  low: 'منخفض',
  medium: 'متوسط',
  high: 'عالٍ',
  xhigh: 'عالٍ جدًا',
  max: 'أقصى',
};

export const CHAT_EFFORT_HINTS_AR: Record<ChatEffort, string> = {
  low: 'أسرع وأرخص؛ للأسئلة البسيطة',
  medium: 'توازن بين السرعة والعمق',
  high: 'تفكير أعمق (الافتراضي للشرح الطبي)',
  xhigh: 'تفكير أعمق جدًا؛ أبطأ',
  max: 'أعمق تفكير ممكن؛ الأبطأ والأغلى',
};

// ───────── conversation kinds ─────────
export const CHAT_KINDS = ['chat', 'explain', 'question', 'compare'] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];
export const CHAT_KIND_LABELS_AR: Record<ChatKind, string> = {
  chat: 'محادثة',
  explain: 'شرح',
  question: 'مساعدة في سؤال',
  compare: 'مقارنة',
};

// ───────── per-message context + page tags ─────────
/** The context the owner attached to one message: the current page or a selection (chips in the composer). */
export interface ChatMessageContext {
  page_id?: string | null;
  region_ids?: string[];
  quote?: string | null;
}

export interface ChatUsageView {
  input_tokens: number | null;
  output_tokens: number | null;
  /** ESTIMATED (token counts × a static price table), not an invoice */
  cost_usd: number | null;
}

/** Fields the chat adds to a message (all optional so older clients/fixtures stay valid). */
export interface ChatMessageExtras {
  /** the model that actually served the answer (owner messages: the one asked for) */
  model?: string | null;
  effort?: ChatEffort | null;
  /** 0-based lecture page indexes the answer explains / cites (owner message: the attached page) */
  page_indexes?: number[];
  context?: ChatMessageContext | null;
  usage?: ChatUsageView | null;
  /** why a rejected answer was not completed (cancelled, provider error) */
  error?: { code: string; message: string } | null;
}

export interface ChatThreadExtras {
  kind?: ChatKind;
  /** the lecture's title (history list), null for a conversation not bound to one lecture */
  source_title?: string | null;
}

// ───────── requests ─────────
export interface ChatMessageCreateBody {
  text: string;
  style?: AnswerStyle;
  /** omitted → the task's configured model / effort */
  model?: ChatModelId;
  effort?: ChatEffort;
  /** this turn's kind (absent → the conversation's) */
  kind?: ChatKind;
  context?: ChatMessageContext | null;
  /** edit the last question / regenerate its answer: that owner message and everything after it are replaced */
  replace_from?: string | null;
}

export interface ChatThreadPatchBody {
  title: string;
}

export interface ChatThreadCreateBody {
  anchor: SelectionAnchor | null;
  scope: SourceScope;
  style?: AnswerStyle;
  socratic?: boolean;
  title?: string;
  kind?: ChatKind;
}

// ───────── preferences (remembered per user — each user's own vault) ─────────
export interface ChatPrefs {
  model: ChatModelId | null;
  effort: ChatEffort | null;
  /** «اشرح هذه الصفحة تلقائيًا» */
  auto_explain: boolean;
  /** «مزامنة الصفحات» */
  sync_pages: boolean;
}
export const DEFAULT_CHAT_PREFS: ChatPrefs = { model: null, effort: null, auto_explain: false, sync_pages: true };

export interface ChatPrefsResponse {
  prefs: ChatPrefs;
  /** the model / effort used when the owner chooses nothing (the task's configuration) */
  defaults: { model: string | null; effort: ChatEffort };
  /** models the configured provider can serve now (subset of CHAT_MODELS) */
  available_models: ChatModelId[];
}
