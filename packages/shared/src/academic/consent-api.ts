// AI-processing consent and the written data-use policy (AOS-21.42; PRD NFR-PR1, Q8; ARCHITECTURE_DELTA §5.6, §10.6;
// IA §4.14 «الخصوصية والبيانات»). Phase 1 completion, track C1.
//
// Nothing of a user's own content (their notes, uploads, handwriting crops, selections, questions — anything in their
// vault) is sent to an AI provider OUTSIDE the deployment until that user has recorded an `ai_processing` consent that
// NAMES that provider (system `consent_record`, kind `ai_processing`, scope `{"providers":[…]}`, with the version of the
// exact Arabic text shown). Without it the AI features answer 409 CONSENT_REQUIRED (`details.kind = 'ai_processing'`)
// before anything is sent, and `/api/ai/status` reports every task unavailable with the reason. Withdrawing stops every
// further send at once. Official content processed in a subject space is not the user's content and is not gated here;
// lecture audio and transcripts additionally need the subject's lecturer policy (Phase 3, AOS-21.39).
import { z } from 'zod';

/** Version of the consent text below; a consent given to another version is not accepted as current. */
export const AI_CONSENT_TEXT_VERSION = 'ai-processing-2026-10-22';
/** Version of the data-use policy page. */
export const DATA_POLICY_VERSION = 'data-policy-2026-10-22';

/** Display names of the AI providers an adapter may report (`AiProvider.name`). */
export const AI_PROVIDER_LABELS_AR: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'Anthropic (نماذج Claude)',
});
export function aiProviderLabelAr(id: string): string {
  return AI_PROVIDER_LABELS_AR[id] ?? id;
}

/** The exact consent text shown before «أوافق» (versioned by AI_CONSENT_TEXT_VERSION). `{provider}` is the label. */
export function aiConsentTextAr(providerLabel: string): string[] {
  return [
    `أوافق على أن يُرسل الخادم إلى ${providerLabel} ما أطلب معالجته بالذكاء الاصطناعي من محتواي: النص الذي أحدده، ومقاطع من محاضراتي وملفاتي، وصور كتابتي اليدوية حين أطلب قراءتها، وملاحظاتي حين أختار «استخدم ملاحظاتي».`,
    'يُرسل ما يلزم الطلب فقط، لمعالجة طلبي فقط. لا يستخدم MedLevo بياناتي لتدريب أي نموذج ولا يرسلها لهذا الغرض.',
    'لا يدخل في أي طلب شيء من بيانات مستخدم آخر الخاصة.',
    'أستطيع سحب موافقتي في أي وقت من هذه الصفحة؛ يتوقف الإرسال فورًا، ولا يمكن استرجاع ما عولج قبل السحب.',
  ];
}

export interface AiConsentView {
  kind: 'ai_processing';
  /** the AI provider configured on this server (null: none — nothing is ever sent anywhere) */
  provider: { id: string; label_ar: string; leaves_deployment: boolean } | null;
  /** an active consent covering the configured provider */
  granted: boolean;
  /** providers the active consent names */
  providers: string[];
  granted_at: number | null;
  /** the version the active consent was given to (null when none) */
  text_version: string | null;
  /** the current consent text and its version (what «أوافق» agrees to) */
  current_text_version: string;
  text_ar: string[];
  /** the earlier consents of this user, newest first (granted / withdrawn), for «سجل الموافقات» */
  history: Array<{ providers: string[]; text_version: string; granted_at: number; revoked_at: number | null }>;
  policy_version: string;
}

export const aiConsentPutSchema = z.discriminatedUnion('granted', [
  z.object({ granted: z.literal(true), provider: z.string().min(1).max(64), text_version: z.string().min(1).max(64) }).strict(),
  z.object({ granted: z.literal(false) }).strict(),
]);
export type AiConsentPut = z.infer<typeof aiConsentPutSchema>;

export const AI_CONSENT_AR = {
  required: (providerLabel: string) =>
    `لا يُرسل شيء من محتواك إلى مزوّد ذكاء اصطناعي خارجي دون موافقتك. لم توافق بعد على إرسال محتواك إلى ${providerLabel}؛ وافق من «أنا» ← «الخصوصية والبيانات» إن أردت استخدام هذه الميزة. باقي الميزات تعمل دونها.`,
  staleText: 'تغيّر نص الموافقة منذ فتحت الصفحة. أعد تحميلها واقرأ النص الحالي قبل الموافقة.',
  wrongProvider: 'هذا المزوّد ليس المزوّد المضبوط على الخادم الآن؛ أعد تحميل الصفحة.',
  noProvider: 'لا يوجد مزوّد ذكاء اصطناعي مضبوط على هذا الخادم، فلا يُرسل شيء إلى أي جهة.',
} as const;

/** One section of the written data-use policy page («سياسة استخدام البيانات»). */
export interface PolicySection {
  title: string;
  body: string[];
}

/** The written data-use policy (Arabic; versioned by DATA_POLICY_VERSION). Shown at /me/privacy/policy. */
export const DATA_USE_POLICY_AR: readonly PolicySection[] = Object.freeze([
  {
    title: 'ما نحفظه وأين',
    body: [
      'لكل حساب خزنة خاصة على الخادم فيها ملفاتك وملاحظاتك وكتابتك وبطاقاتك ومحاولاتك. المحتوى الرسمي لكل مادة محفوظ في مساحة المادة ويراه أعضاؤها فقط.',
      'الملفات الكبيرة محفوظة مرة واحدة بحسب محتواها، وإذا فُعّل التخزين في Cloudflare R2 تُرفع إليه مشفّرة.',
    ],
  },
  {
    title: 'من يرى بياناتك',
    body: [
      'لا تعرض أي شاشة في التطبيق بياناتك الخاصة لمستخدم آخر أو لمشرف أو لمسؤول المنصة.',
      'ما تنشره أنت (شرح منشور لزملاء المادة) يراه أعضاء المادة فقط، وتستطيع سحبه.',
      'من يدير الخادم يستطيع تقنيًا الوصول إلى الملفات والنسخ الاحتياطية، وتُشفَّر النسخ قبل خروجها من الخادم.',
    ],
  },
  {
    title: 'الذكاء الاصطناعي',
    body: [
      'لا يُرسل شيء من محتواك إلى مزوّد ذكاء اصطناعي خارج الخادم إلا بعد موافقتك المسجّلة التي تسمّي المزوّد، ولما تطلبه أنت فقط.',
      'يُرسل ما يلزم الطلب فقط: النص المحدد ومقاطع المصادر داخل النطاق الذي اخترته، وصور الكتابة حين تطلب قراءتها، وملاحظاتك حين تختار «استخدم ملاحظاتي».',
      'لا يستخدم MedLevo بياناتك لتدريب أي نموذج، ولا يرسلها لهذا الغرض. تخضع معالجة المزوّد لشروط واجهته البرمجية التجارية.',
      'لا يدخل في نطاق أي طلب شيء من بيانات مستخدم آخر الخاصة.',
      'الإجابة المبنية على المحتوى الرسمي وحده قد يُعاد استخدامها لزملائك في المادة نفسها؛ أما ما بُني على شيء خاص بك فيُحفظ لك وحدك ولا يُعرض لغيرك.',
      'تسجيلات المحاضرات ونصوصها لا تُرسل إلى مزوّد خارجي إلا إذا سمحت سياسة المادة بذلك ووافقت أنت (ميزة لاحقة).',
    ],
  },
  {
    title: 'حدود الاستخدام والتكلفة',
    body: ['لكل حساب ولكل مادة حد شهري تقديري لاستخدام الذكاء الاصطناعي وحد لمساحة التخزين؛ يُرفض الطلب قبل إرساله إذا تجاوز الحد، ولا يُخفَّض أثره بصمت.'],
  },
  {
    title: 'حقوقك',
    body: [
      'تستطيع تنزيل نسخة من بياناتك، وحذف حسابك، وسحب موافقتك على معالجة الذكاء الاصطناعي في أي وقت من «أنا» ← «الخصوصية والبيانات».',
      'سحب الموافقة يوقف الإرسال فورًا، ولا يمكن استرجاع ما عولج قبل السحب.',
      'تنتهي النسخ الاحتياطية بانتهاء مدة الاحتفاظ بها.',
    ],
  },
]);
