// Impact preview → explicit apply (§48): «تغيير model أو rule أو source priority مؤثر لا يعيد توليد مكتبتي كلها
// تلقائيًا. اعرض أثرًا متوقعًا وخيار تطبيق واضحًا.»
//
// How the preview is computed (no guessing):
//  * rules / rule-affecting settings — the change is applied inside a transaction that is ROLLED BACK, and the
//    studybook rules engine (resolveRules) is asked for the effective rules of every source before and after. An
//    artifact is «affected» when the rules its cache key was built with (reconstructed and VERIFIED against its
//    stored rules_version) would differ after the change: a new identical request would no longer reuse it.
//    Artifacts whose stored rules cannot be reconstructed are counted as «not comparable» (made under earlier rules
//    or request-specific options — not reused by default requests anyway).
//  * source priority — not part of any cache key: nothing becomes stale; stored content whose scope mixes
//    reordered source types is counted as «could differ if you regenerate it».
//  * model — generator / verifier models are part of the cache key (studybook keySettings): published content of
//    the role's tasks would no longer be reused. Models are server settings: preview only.
// Applying never regenerates, never edits an artifact, never marks anything stale.
import {
  IMPACT_SETTING_KEYS,
  ownerSettingsSchema,
  stableStringify,
  type ExplanationRules,
  type ImpactArtifactView,
  type ImpactChange,
  type ImpactPreviewResponse,
  type ModelRole,
  type OwnerSettings,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { sha256 } from '../../lib/hash';
import { validationError } from '../../lib/http';
import { TASK_ROLE } from '../ai/providers';
import { readOverride, resolveRules, rulesPatchSchema, rulesVersionOf } from '../studybook/rules';
import { MODEL_ENV, modelRoles } from './intelligence';
import { ARTIFACT_KIND_LABELS_AR, oneLine } from './labels';

type Rules = Omit<ExplanationRules, 'rules_version'>;
const RULE_FIELDS = ['template', 'level', 'dialect', 'custom_instruction', 'keep_english_terms', 'show_original_text', 'include', 'socratic'] as const;
type RuleField = (typeof RULE_FIELDS)[number];

const FIELD_LABELS_AR: Record<RuleField, string> = {
  template: 'قالب الشرح',
  level: 'مستوى الشرح',
  dialect: 'أسلوب اللغة',
  custom_instruction: 'تعليماتك الخاصة للشرح',
  keep_english_terms: 'إبقاء المصطلحات الإنجليزية',
  show_original_text: 'عرض النص الأصلي',
  include: 'الأجزاء الاختيارية (أمثلة، لآلئ امتحان، أسئلة تحقق…)',
  socratic: 'الأسلوب السقراطي',
};

const SETTING_LABELS_AR: Record<string, string> = {
  explanation_level: 'مستوى الشرح الافتراضي',
  dialect: 'أسلوب اللغة',
  custom_instruction: 'تعليماتك الخاصة للشرح',
  socratic_default: 'الأسلوب السقراطي افتراضيًا',
  check_question_density: 'كثافة أسئلة التحقق',
  answer_style: 'أسلوب الإجابة الافتراضي',
  source_priority: 'أولوية المصادر لكل مهمة',
};

const VALUE_LABELS_AR: Record<string, Record<string, string>> = {
  level: { simple: 'مبسّط', brief: 'موجز', medium: 'متوسط', detailed: 'مفصّل', expert: 'متقدّم', exam_focus: 'مركّز على الامتحان' },
  dialect: { fusha_simple: 'عربية فصحى مبسّطة', iraqi_teaching: 'أسلوب تدريس عراقي' },
  answer_style: { simple: 'بسيط', short: 'قصير', detailed: 'مفصّل', expert: 'متقدّم', literal: 'حرفي من المصدر' },
  check_question_density: { off: 'إيقاف', low: 'قليلة', medium: 'متوسطة' },
};
VALUE_LABELS_AR.explanation_level = VALUE_LABELS_AR.level!;

function valueAr(key: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'نعم' : 'لا';
  const s = String(v ?? '—');
  return VALUE_LABELS_AR[key]?.[s] ?? s;
}

/** artifact kind → the AI task its generator ran (for model impact) */
const KIND_TASK: Record<string, keyof typeof TASK_ROLE> = {
  study_book: 'study_book',
  summary: 'summarize',
  explanation: 'explain',
  figure_explanation: 'vision_figure',
  comparison: 'compare',
  chat_answer: 'chat',
  mind_map: 'summarize',
  flowchart: 'summarize',
  case_explanation: 'case_sim',
};

interface ArtifactRow {
  id: string;
  kind: string;
  title: string | null;
  status: string;
  primary_source_id: string | null;
  params_json: string;
  scope_json: string;
  rules_version: string;
  is_frozen: number;
  model: string | null;
  source_title: string | null;
}

class Rollback extends Error {}

/** Run `apply` then `compute` inside a transaction that is always rolled back (nothing persists). */
function dryRun<T>(ctx: AppContext, apply: () => void, compute: () => T): T {
  let out: T | undefined;
  try {
    ctx.db.tx(() => {
      apply();
      out = compute();
      throw new Rollback('dry run');
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out as T;
}

function candidates(ctx: AppContext): ArtifactRow[] {
  // only content a request could REUSE today (canReuse: published / partial)
  return ctx.db.all<ArtifactRow>(
    `SELECT a.id, a.kind, a.title, a.status, a.primary_source_id, a.params_json, a.scope_json, a.rules_version, a.is_frozen, a.model, s.title AS source_title
       FROM artifact a LEFT JOIN source s ON s.id = a.primary_source_id
      WHERE a.status IN ('published','partial') AND (a.primary_source_id IS NULL OR s.deleted_at IS NULL)
      ORDER BY a.updated_at DESC`,
  );
}

const same = (a: unknown, b: unknown) => stableStringify(a ?? null) === stableStringify(b ?? null);

function stripVersion(r: ExplanationRules | Rules): Rules {
  const { rules_version: _v, ...rest } = r as ExplanationRules;
  return rest;
}

/** The rules the artifact's cache key was built with, reconstructed and verified against its rules_version. */
function artifactRules(a: ArtifactRow, current: Rules): Rules | null {
  const p = fromJson<Record<string, unknown>>(a.params_json, {}) ?? {};
  const stored = p.rules && typeof p.rules === 'object' ? (p.rules as Record<string, unknown>) : null;
  let r: Rules;
  if (stored && RULE_FIELDS.every((f) => f in stored)) {
    r = stripVersion(stored as unknown as ExplanationRules);
  } else {
    r = {
      ...current,
      include: { ...current.include },
      ...(typeof p.level === 'string' ? { level: p.level as Rules['level'] } : {}),
      ...(typeof p.dialect === 'string' ? { dialect: p.dialect as Rules['dialect'] } : {}),
      ...(typeof p.template === 'string' ? { template: p.template as Rules['template'] } : {}),
    };
  }
  return rulesVersionOf(r) === a.rules_version ? r : null;
}

function changedFields(a: Rules, b: Rules): RuleField[] {
  return RULE_FIELDS.filter((f) => !same(a[f], b[f]));
}

function fieldValueAr(f: RuleField, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'نعم' : 'لا';
  if (f === 'custom_instruction') return v ? `«${oneLine(String(v), 60)}»` : '(لا شيء)';
  if (f === 'level' || f === 'dialect') return valueAr(f, v);
  if (f === 'include' && v && typeof v === 'object') {
    const on = Object.entries(v as Record<string, boolean>).filter(([, x]) => x).length;
    return `${on} مفعّلة`;
  }
  return String(v ?? '—');
}

interface RulesState {
  before: Map<string, Rules>;
  after: Map<string, Rules>;
}

function sourceKey(id: string | null): string {
  return id ?? '';
}

function rulesFor(ctx: AppContext, sourceIds: Array<string | null>): Map<string, Rules> {
  const out = new Map<string, Rules>();
  for (const id of sourceIds) {
    const k = sourceKey(id);
    if (!out.has(k)) out.set(k, stripVersion(resolveRules(ctx, { sourceId: id })));
  }
  return out;
}

function applyRulesChange(ctx: AppContext, change: ImpactChange): void {
  const now = ctx.clock.now();
  if (change.kind === 'settings') {
    ctx.settings.patch(change.patch as Record<string, unknown>);
  } else if (change.kind === 'rules_owner') {
    const patch = rulesPatchSchema.parse(change.patch);
    const before = readOverride(ctx, 'owner', 'owner');
    const merged = { ...(before ?? {}), ...patch, include: { ...(before?.include ?? {}), ...(patch.include ?? {}) } };
    ctx.db.run(
      `INSERT INTO explanation_rule_override (target_type, target_id, rules_json, updated_at) VALUES ('owner', 'owner', ?, ?)
       ON CONFLICT (target_type, target_id) DO UPDATE SET rules_json = excluded.rules_json, updated_at = excluded.updated_at`,
      [toJson(merged), now],
    );
  } else if (change.kind === 'rules_node') {
    if (change.patch === null) ctx.db.run(`DELETE FROM explanation_rule_override WHERE target_type = 'node' AND target_id = ?`, [change.node_id]);
    else
      ctx.db.run(
        `INSERT INTO explanation_rule_override (target_type, target_id, rules_json, updated_at) VALUES ('node', ?, ?, ?)
         ON CONFLICT (target_type, target_id) DO UPDATE SET rules_json = excluded.rules_json, updated_at = excluded.updated_at`,
        [change.node_id, toJson(rulesPatchSchema.parse(change.patch)), now],
      );
  }
}

/** Validates the change; throws VALIDATION_FAILED / NOT_FOUND with Arabic reasons. */
export function validateChange(ctx: AppContext, change: ImpactChange): void {
  if (change.kind === 'settings') {
    const keys = Object.keys(change.patch ?? {});
    if (keys.length === 0) throw new AppError('VALIDATION_FAILED', 'لا يوجد تغيير لمعاينته.', 400, { where: 'body', issues: [{ path: 'change.patch', code: 'too_small', message: 'هذا الحقل مطلوب.' }] });
    const bad = keys.filter((k) => !(IMPACT_SETTING_KEYS as readonly string[]).includes(k));
    if (bad.length) {
      throw new AppError('VALIDATION_FAILED', 'هذه الإعدادات لا تؤثر في المحتوى المولّد؛ غيّرها من صفحة الإعدادات مباشرة.', 400, {
        where: 'body',
        issues: [{ path: 'change.patch', code: 'unrecognized_keys', message: `حقول غير معروفة: ${bad.join('، ')}.` }],
      });
    }
    const parsed = ownerSettingsSchema.safeParse({ ...ctx.settings.get(), ...change.patch });
    if (!parsed.success) throw validationError(parsed.error, 'body');
  } else if (change.kind === 'rules_owner') {
    const r = rulesPatchSchema.safeParse(change.patch);
    if (!r.success) throw validationError(r.error, 'body');
  } else if (change.kind === 'rules_node') {
    const node = ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM library_node WHERE id = ?', [change.node_id]);
    if (!node || node.deleted_at !== null) throw new AppError('NOT_FOUND', 'المجلد غير موجود.', 404);
    if (change.patch !== null) {
      const r = rulesPatchSchema.safeParse(change.patch);
      if (!r.success) throw validationError(r.error, 'body');
    }
  }
}

/** A token bound to the change AND to the current rules state (settings + rule overrides + AI models). */
function stateToken(ctx: AppContext, change: ImpactChange): string {
  const overrides = ctx.db.all<{ target_type: string; target_id: string; rules_json: string }>(
    'SELECT target_type, target_id, rules_json FROM explanation_rule_override ORDER BY target_type, target_id',
  );
  const models = modelRoles(ctx).map((r) => [r.role, r.model]);
  return sha256(stableStringify({ change, settings: ctx.settings.get(), overrides, models })).slice(0, 32);
}

function view(a: ArtifactRow, reason: string): ImpactArtifactView {
  return {
    id: a.id,
    title: oneLine(a.title, 200),
    kind: a.kind,
    kind_label_ar: ARTIFACT_KIND_LABELS_AR[a.kind] ?? a.kind,
    status: a.status,
    source_id: a.primary_source_id,
    source_title: oneLine(a.source_title, 200),
    frozen: a.is_frozen === 1,
    reason_ar: a.is_frozen === 1 ? `${reason} وهو مثبّت (تجميد) على نسخته أصلًا.` : reason,
  };
}

const MAX_LISTED = 200;

function describeSettings(before: OwnerSettings, patch: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const prev = (before as Record<string, unknown>)[k];
    if (same(prev, v)) continue;
    if (k === 'source_priority') {
      const n = Object.keys(v as object).filter((p) => !same((prev as Record<string, unknown>)[p], (v as Record<string, unknown>)[p])).length;
      out.push(`${SETTING_LABELS_AR[k]}: يتغير ترتيب أنواع المصادر في ${n === 1 ? 'مهمة واحدة' : n === 2 ? 'مهمتين' : `${n} مهام`}.`);
    } else if (k === 'custom_instruction') {
      out.push(`${SETTING_LABELS_AR[k]}: ${prev ? `«${oneLine(String(prev), 60)}»` : '(لا شيء)'} ← ${v ? `«${oneLine(String(v), 60)}»` : '(لا شيء)'}`);
    } else {
      out.push(`${SETTING_LABELS_AR[k] ?? k}: ${valueAr(k, prev)} ← ${valueAr(k, v)}`);
    }
  }
  return out;
}

function rulesImpact(ctx: AppContext, change: ImpactChange, arts: ArtifactRow[]): { affected: ImpactArtifactView[]; affectedCount: number; unaffected: number; notComparable: number; changedSources: number } {
  const sourceIds = [...new Set<string | null>([null, ...arts.map((a) => a.primary_source_id)])];
  const before = rulesFor(ctx, sourceIds);
  const after = dryRun(ctx, () => applyRulesChange(ctx, change), () => rulesFor(ctx, sourceIds));
  const state: RulesState = { before, after };
  let unaffected = 0;
  let notComparable = 0;
  let affectedCount = 0;
  const affected: ImpactArtifactView[] = [];
  const changedSources = [...state.before.keys()].filter((k) => changedFields(state.before.get(k)!, state.after.get(k)!).length > 0).length;
  for (const a of arts) {
    const r0 = state.before.get(sourceKey(a.primary_source_id))!;
    const r1 = state.after.get(sourceKey(a.primary_source_id))!;
    const own = artifactRules(a, r0);
    if (!own) {
      notComparable++;
      continue;
    }
    const overridden = changedFields(r0, own);
    const projected: Rules = { ...r1, include: { ...r1.include } };
    for (const f of overridden) (projected as Record<string, unknown>)[f] = own[f];
    if (rulesVersionOf(projected) === a.rules_version) {
      unaffected++;
      continue;
    }
    affectedCount++;
    if (affected.length < MAX_LISTED) {
      const diff = changedFields(own, projected)
        .map((f) => `${FIELD_LABELS_AR[f]} (${fieldValueAr(f, own[f])} ← ${fieldValueAr(f, projected[f])})`)
        .join('، ');
      affected.push(view(a, `صُنع بقواعد يتغير فيها: ${diff}. يبقى كما هو للقراءة، لكن طلبًا جديدًا مماثلًا سيُولَّد بالقواعد الجديدة (عند طلبك فقط) بدل إعادة استخدامه.`));
    }
  }
  return { affected, affectedCount, unaffected, notComparable, changedSources };
}

function priorityMayDiffer(ctx: AppContext, before: OwnerSettings, patch: Partial<OwnerSettings>, arts: ArtifactRow[]): number {
  const next = patch.source_priority;
  if (!next) return 0;
  const moved = new Set<string>();
  for (const [purpose, list] of Object.entries(next)) {
    const prev = (before.source_priority as Record<string, string[]>)[purpose] ?? [];
    const all = new Set([...prev, ...(list as string[])]);
    for (const t of all) if (prev.indexOf(t) !== (list as string[]).indexOf(t)) moved.add(t);
  }
  if (moved.size === 0) return 0;
  let n = 0;
  for (const a of arts) {
    const scope = fromJson<{ version_ids?: string[] }>(a.scope_json, {}) ?? {};
    const ids = (scope.version_ids ?? []).filter((x) => typeof x === 'string').slice(0, 200);
    if (ids.length < 2) continue;
    const types = new Set(
      ctx.db
        .all<{ t: string }>(`SELECT DISTINCT s.source_type AS t FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id IN (${ids.map(() => '?').join(',')})`, ids)
        .map((r) => r.t)
        .filter((t) => moved.has(t)),
    );
    if (types.size >= 2) n++;
  }
  return n;
}

function modelImpact(ctx: AppContext, role: ModelRole, model: string, arts: ArtifactRow[]): ImpactPreviewResponse {
  const roles = modelRoles(ctx);
  const current = roles.find((r) => r.role === role)?.model ?? null;
  const env = MODEL_ENV[role];
  const base = {
    not_comparable_count: 0,
    may_differ_count: 0,
    regenerates_automatically: false as const,
    can_apply: false,
    confirm_token: null,
  };
  if (!ctx.ai.configured || !current) {
    return {
      ...base,
      change_ar: [`نموذج ${role === 'generation' ? 'التوليد' : role === 'verification' ? 'التحقق' : 'الرؤية'}: ${model}`],
      affected: [],
      affected_count: 0,
      unaffected_count: arts.length,
      effects_ar: ['لا يوجد مزود ذكاء اصطناعي مهيأ على الخادم الآن، فلا يستخدم أي محتوى مخزّن نموذجًا يمكن استبداله.'],
      apply_note_ar: `يُضبط النموذج على الخادم: ${env}=${model} ثم إعادة تشغيل الخادم، بعد ضبط ANTHROPIC_API_KEY.`,
    };
  }
  if (current === model) {
    return {
      ...base,
      change_ar: [`النموذج المطلوب (${model}) هو النموذج الحالي نفسه.`],
      affected: [],
      affected_count: 0,
      unaffected_count: arts.length,
      effects_ar: ['لا تغيير.'],
      apply_note_ar: 'لا يوجد ما يُطبَّق.',
    };
  }
  const affected: ImpactArtifactView[] = [];
  let count = 0;
  for (const a of arts) {
    if (!a.model) continue; // deterministic content uses no model
    const task = KIND_TASK[a.kind];
    const hit = role === 'verification' || (task !== undefined && TASK_ROLE[task] === role);
    if (!hit) continue;
    count++;
    if (affected.length < MAX_LISTED) {
      affected.push(
        view(
          a,
          role === 'verification'
            ? `تحقّق منه النموذج الحالي (${current})؛ بعد التغيير لن يُعاد استخدامه لطلب جديد مماثل، ويبقى كما هو للقراءة.`
            : `ولّده النموذج الحالي (${current})؛ بعد التغيير لن يُعاد استخدامه لطلب جديد مماثل، ويبقى كما هو للقراءة.`,
        ),
      );
    }
  }
  return {
    ...base,
    change_ar: [`نموذج ${role === 'generation' ? 'التوليد' : role === 'verification' ? 'التحقق' : 'الرؤية'}: ${current} ← ${model}`],
    affected,
    affected_count: count,
    unaffected_count: arts.length - count,
    effects_ar: [
      'لن يُعاد توليد أي شيء تلقائيًا. المحتوى المخزّن يبقى كما هو ويمكنك قراءته.',
      'الطلبات الجديدة فقط ستستخدم النموذج الجديد؛ لا تُخلط نتائج نموذجين في المحتوى نفسه.',
    ],
    apply_note_ar: `النماذج إعداد على الخادم وليست من إعداداتك الشخصية: اضبط ${env}=${model} في ملف إعدادات الخادم ثم أعد تشغيله. لا يمكن تطبيقه من هنا.`,
  };
}

export function previewImpact(ctx: AppContext, change: ImpactChange): ImpactPreviewResponse {
  validateChange(ctx, change);
  const arts = candidates(ctx);
  if (change.kind === 'model') return modelImpact(ctx, change.role, change.model, arts);

  const changeAr: string[] = [];
  const effects: string[] = ['لن يُعاد توليد أي شيء تلقائيًا، ولن يُعدَّل أي محتوى مخزّن أو يُعلَّم قديمًا. يتغير فقط ما تطلبه بعد التطبيق.'];
  let mayDiffer = 0;
  if (change.kind === 'settings') {
    const before = ctx.settings.get();
    changeAr.push(...describeSettings(before, change.patch as Record<string, unknown>));
    mayDiffer = priorityMayDiffer(ctx, before, change.patch as Partial<OwnerSettings>, arts);
    if (change.patch.source_priority) {
      effects.push('أولوية المصادر تحدد من أين يبدأ البحث عن الأدلة، ولا تقرر من يفوز عند التعارض. ليست جزءًا من مفتاح التخزين، فالمحتوى المخزّن يُعاد استخدامه كما هو.');
      if (mayDiffer) effects.push(`${mayDiffer} من المحتوى المخزّن نطاقه يضم أنواع مصادر تغيّر ترتيبها؛ قد يختلف لو أعدت توليده بنفسك.`);
    }
    if (change.patch.answer_style !== undefined && !same(change.patch.answer_style, before.answer_style)) {
      effects.push('أسلوب الإجابة الافتراضي يُطبَّق على الطلبات الجديدة فقط.');
    }
  } else if (change.kind === 'rules_owner') {
    changeAr.push('قواعد الشرح العامة (الطبقة الخاصة بك فوق الإعدادات).');
  } else {
    const node = ctx.db.get<{ title: string }>('SELECT title FROM library_node WHERE id = ?', [change.node_id]);
    changeAr.push(change.patch === null ? `إزالة قواعد الشرح الخاصة بـ «${oneLine(node?.title, 80)}».` : `قواعد الشرح الخاصة بـ «${oneLine(node?.title, 80)}».`);
  }
  const r = rulesImpact(ctx, change, arts);
  if (changeAr.length === 0) changeAr.push('لا يتغير شيء فعليًا عن القيم الحالية.');
  if (r.affectedCount === 0 && r.changedSources === 0 && !(change.kind === 'settings' && change.patch.source_priority)) {
    effects.push('هذا التغيير لا يغيّر القواعد الفعلية لأي مصدر.');
  }
  return {
    change_ar: changeAr,
    affected: r.affected,
    affected_count: r.affectedCount,
    unaffected_count: r.unaffected,
    not_comparable_count: r.notComparable,
    may_differ_count: mayDiffer,
    regenerates_automatically: false,
    effects_ar: effects,
    can_apply: true,
    apply_note_ar: 'يُطبَّق التغيير فقط عند تأكيدك، ويُسجَّل في السجل مع هذا الأثر.',
    confirm_token: stateToken(ctx, change),
  };
}

export interface Forwarder {
  (method: 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<{ statusCode: number; body: string }>;
}

/** Apply after an explicit confirmation. Rules overrides are written by their owning module (studybook route). */
export async function applyImpact(ctx: AppContext, change: ImpactChange, token: string, forward: Forwarder): Promise<{ effects_ar: string[]; preview: ImpactPreviewResponse }> {
  if (change.kind === 'model') {
    throw new AppError('FEATURE_DISABLED', `النماذج إعداد على الخادم: اضبط ${MODEL_ENV[change.role]} في ملف إعدادات الخادم ثم أعد تشغيله. لا يمكن تطبيقه من التطبيق.`, 409);
  }
  validateChange(ctx, change);
  if (token !== stateToken(ctx, change)) {
    throw new AppError('CONFLICT', 'تغيّرت الإعدادات أو القواعد منذ المعاينة. اعرض الأثر من جديد ثم أكّد.', 409, { reason: 'preview_stale' });
  }
  const preview = previewImpact(ctx, change);
  if (change.kind === 'settings') {
    ctx.settings.patch(change.patch as Record<string, unknown>);
  } else {
    const url = change.kind === 'rules_owner' ? '/api/studybook/rules/owner' : `/api/studybook/rules/nodes/${encodeURIComponent(change.node_id)}`;
    const res = change.kind === 'rules_node' && change.patch === null ? await forward('DELETE', url) : await forward('PUT', url, change.patch);
    if (res.statusCode >= 400) {
      const msg = (fromJson<{ error?: { message?: string } }>(res.body, {}) ?? {}).error?.message;
      throw new AppError(res.statusCode === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', msg ?? 'تعذّر حفظ قواعد الشرح.', res.statusCode === 404 ? 404 : 400);
    }
  }
  const effects = [
    'طُبّق التغيير.',
    preview.affected_count
      ? `${preview.affected_count} من المحتوى المخزّن لن يُعاد استخدامه لطلب جديد مماثل؛ بقي كما هو ولم يُعَد توليده.`
      : 'لا يوجد محتوى مخزّن يتأثر.',
    'لم يُعَد توليد أي شيء تلقائيًا.',
  ];
  ctx.audit.record({
    entityType: 'control',
    entityId: change.kind === 'rules_node' ? change.node_id : change.kind,
    action: 'apply_change',
    summary: `تطبيق تغيير بعد معاينة أثره: ${preview.change_ar.join(' · ')}`.slice(0, 500),
    after: { affected: preview.affected_count, unaffected: preview.unaffected_count, not_comparable: preview.not_comparable_count, may_differ: preview.may_differ_count, regenerated: 0 },
  });
  return { effects_ar: effects, preview };
}
