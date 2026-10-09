// The evidence pipeline every generated answer goes through (§12, §17, §52, ARCHITECTURE §3.5–§3.7):
//   resolved scope (caller) → retrieve (scope-filtered in SQL before ranking) → nothing usable → ABSTAIN without
//   calling the model (specific reason, optional explicit wider scope) → evidence pack (aliases E1…En only for
//   in-scope evidence) → ctx.ai.generateStructured (untrusted content delimited; Source Lock re-checked) →
//   validateClaims per block → publish artifact + blocks + dependencies + search index.
// Uploaded text is DATA: nothing in an excerpt can change the scope, the aliases or the instructions (AC-29) —
// scope and aliases are decided here, before the model sees anything, and enforced again after it answers.
import {
  ABSTAIN_REASON_LABELS_AR,
  type AbstainReason,
  type AiTask,
  type AnswerStyle,
  type ExplanationRules,
  type SelectionAnchor,
  type SourceScope,
  type StudyArtifactView,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { ProviderImage, UntrustedBlock } from '../ai/types';
import {
  abstainFor,
  packFromCandidates,
  retrieve,
  VERIFIER_VERSION,
  type RetrievalAnchor,
  type RetrievalCandidate,
  type RetrievalPurpose,
  type ScopeReport,
} from '../evidence/services';
import { abstainView, artifactView, storedScope, type AbstainView, type ArtifactKind } from './artifacts';
import { indexArtifact, processGenerated, recordBlockDependencies, writeBlocks, type PackContext, type PreparedBlock, type ProcessResult } from './publish';
import { buildExplanationPrompt, GENERATOR_VERSION } from './rules';
import { generatedContentSchema, type GeneratedContentOut } from './schema';
import { terminologyVersion } from './terms';
import { shorten } from './text';

/** Abstain reasons a model may choose; anything else is mapped to insufficient_evidence. */
const MODEL_ABSTAIN: ReadonlySet<AbstainReason> = new Set(['not_found_in_scope', 'insufficient_evidence', 'conflict', 'real_patient_request', 'out_of_scope_request', 'unreadable_source']);

/** AI availability with the server's own Arabic reason (budget vs not configured vs unsupported). */
export function requireAi(ctx: AppContext, task: AiTask): void {
  if (ctx.ai.isAvailable(task)) return;
  const st = ctx.ai.status();
  const reason = st.tasks[task]?.reason_ar ?? ABSTAIN_REASON_LABELS_AR.ai_not_configured;
  const budgetBlocked = st.configured && !!st.tasks[task]?.model;
  throw new AppError(budgetBlocked ? 'AI_BUDGET_EXCEEDED' : 'AI_NOT_CONFIGURED', reason, 409, { task });
}

/**
 * Output-affecting settings that belong in every generated-content cache key besides scope / rules / versions
 * (ARCHITECTURE §3.7): the owner dictionary (prompt + retrieval expansion) and the models that generate and verify
 * (a changed MEDLEVO_MODEL_* override must not serve answers of the previous model as current).
 */
export function keySettings(ctx: AppContext, task: AiTask, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const st = ctx.ai.status();
  return {
    ...extra,
    terms: terminologyVersion(ctx),
    generator_model: st.tasks[task]?.model ?? null,
    verifier_model: st.tasks.verify_support?.model ?? null,
  };
}

export interface LineageInput {
  lineageId: string;
  versionNo: number;
  parentArtifactId: string | null;
}

export interface ArtifactBase {
  kind: ArtifactKind;
  title: string | null;
  primarySourceId: string | null;
  scope: ScopeReport;
  rules: ExplanationRules;
  cacheKey: string;
  params: Record<string, unknown>;
  anchor: SelectionAnchor | null;
  lineage?: LineageInput | null;
  jobId?: string | null;
}

/** Insert an artifact row (status as given). Returns its id. */
export function insertArtifact(ctx: AppContext, base: ArtifactBase, status: StudyArtifactView['status'], extra: { model?: string | null; abstain?: AbstainView | null } = {}): string {
  const now = ctx.clock.now();
  const id = newId(now);
  const lineageId = base.lineage?.lineageId ?? id;
  const versionNo = base.lineage?.versionNo ?? 1;
  ctx.db.run(
    `INSERT INTO artifact (id, lineage_id, version_no, kind, title, primary_source_id, scope_json, params_json, cache_key, rules_version, generator_version, verifier_version,
                           model, status, coverage_json, job_id, is_frozen, stale_reason, created_at, published_at, updated_at, abstain_json, removed_json, anchor_json, parent_artifact_id, scope_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, ?, ?, ?, ?, '[]', ?, ?, ?)`,
    [
      id,
      lineageId,
      versionNo,
      base.kind,
      base.title,
      base.primarySourceId,
      toJson(storedScope(base.scope)),
      toJson(base.params),
      base.cacheKey,
      base.rules.rules_version,
      GENERATOR_VERSION,
      VERIFIER_VERSION,
      extra.model ?? null,
      status,
      base.jobId ?? null,
      now,
      status === 'published' ? now : null,
      now,
      extra.abstain ? toJson(extra.abstain) : null,
      base.anchor ? toJson(base.anchor) : null,
      base.lineage?.parentArtifactId ?? null,
      base.scope.hash,
    ],
  );
  return id;
}

/** A published abstention (no blocks, no model output). Dependencies = the scope's versions. */
export function publishAbstention(ctx: AppContext, base: ArtifactBase, abstain: AbstainView, removed: ProcessResult['removed'] = []): StudyArtifactView {
  const id = ctx.db.tx(() => {
    const aid = insertArtifact(ctx, base, 'published', { abstain });
    if (removed.length) ctx.db.run('UPDATE artifact SET removed_json = ? WHERE id = ?', [toJson(removed), aid]);
    return aid;
  });
  return artifactView(ctx, id);
}

export interface PackedEvidence {
  pack: PackContext;
  candidates: RetrievalCandidate[];
  /** model-facing untrusted blocks for the evidence (E-aliases) */
  blocks: UntrustedBlock[];
  versionIds: string[];
}

/** Evidence → untrusted blocks labelled with their alias (the only thing a claim may cite). */
export function evidenceBlocks(pack: PackContext, forModel: Array<{ alias: string; source_label: string; quote: string }>): UntrustedBlock[] {
  return forModel.map((e) => ({ label: `evidence ${e.alias} — ${e.source_label}`, text: `[${e.alias}]\n${e.quote}` }));
}

export interface RetrievalSpec {
  query: string;
  anchor: RetrievalAnchor | null;
  k: number;
  purpose: RetrievalPurpose;
  maxEvidence?: number;
}

export type RetrieveOutcome = { kind: 'abstain'; abstain: AbstainView } | { kind: 'ok'; packed: PackedEvidence };

/** Scope-locked retrieval → pack, or a precise abstention (the model is NOT called in that case). */
export function retrieveAndPack(ctx: AppContext, scope: ScopeReport, spec: RetrievalSpec): RetrieveOutcome {
  const r = retrieve(ctx, { scope, query: spec.query, anchor: spec.anchor, k: spec.k, purpose: spec.purpose });
  const ab = abstainFor(ctx, r, scope);
  if (ab) return { kind: 'abstain', abstain: abstainView(ab.reason, ab.detail, ab.suggest_scope ?? null) };
  const p = packFromCandidates(ctx, scope, r.candidates, { maxItems: spec.maxEvidence ?? 24 });
  if (p.forModel.length === 0) {
    const why = p.refused.map((x) => x.reason_ar);
    return { kind: 'abstain', abstain: abstainView('not_found_in_scope', [r.searched.summary_ar, ...new Set(why)].join(' ')) };
  }
  const pack: PackContext = { aliasMap: p.aliasMap, regionAliases: {}, views: p.views };
  return {
    kind: 'ok',
    packed: { pack, candidates: r.candidates, blocks: evidenceBlocks(pack, p.forModel), versionIds: [...new Set(p.views.map((v) => v.version_id))] },
  };
}

export interface ModelCallSpec {
  task: AiTask;
  style: AnswerStyle;
  taskText: string;
  ownerInstruction?: string | null;
  strategy?: string | null;
  socratic?: boolean;
  /** extra untrusted blocks shown BEFORE the evidence (selection, previous answer, conversation) */
  leading?: UntrustedBlock[];
  extraInstructions?: string[];
  images?: ProviderImage[];
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  jobId?: string;
  terms?: Array<{ term_en: string; preferred_ar: string | null; abbreviation: string | null }>;
}

/** One model call with the GeneratedContent contract. */
export async function callModel(ctx: AppContext, scope: ScopeReport, rules: ExplanationRules, packed: PackedEvidence, m: ModelCallSpec, extraVersionIds: string[] = []): Promise<{ content: GeneratedContentOut; model: string }> {
  const prompt = buildExplanationPrompt({
    rules,
    style: m.style,
    task: m.taskText,
    ownerInstruction: m.ownerInstruction,
    strategy: m.strategy,
    socratic: m.socratic,
    terms: m.terms,
    extra: m.extraInstructions,
  });
  const res = await ctx.ai.generateStructured({
    task: m.task,
    schema: generatedContentSchema,
    system: prompt.system,
    input: [...(m.leading ?? []), ...packed.blocks],
    instruction: prompt.instruction,
    scope,
    sourceVersionIds: [...new Set([...packed.versionIds, ...extraVersionIds])],
    jobId: m.jobId,
    images: m.images,
    maxOutputTokens: m.maxOutputTokens ?? 6000,
    rulesVersion: rules.rules_version,
    signal: m.signal,
    timeoutMs: m.timeoutMs ?? 240_000,
  });
  return { content: res.output, model: res.model };
}

export interface SingleShotInput extends ArtifactBase {
  retrieval: RetrievalSpec;
  call: ModelCallSpec;
  /** regions a block explains by default (the anchor's) */
  defaultRegionIds: string[];
  /** blocks appended after validation (e.g. a figure's visual reading) */
  appendBlocks?: (r: ProcessResult) => PreparedBlock[];
  onPhase?: (phase: 'generating' | 'verifying') => void;
  /** turn the model's raw output into GeneratedContent (figure explanations wrap it) */
  extraVersionIds?: string[];
}

/** Retrieval → (abstain | model → validation → publish) for explanations, chat answers, comparisons, figures. */
export async function generateSingleShot(ctx: AppContext, input: SingleShotInput, preCall?: () => Promise<{ content: GeneratedContentOut; model: string }>): Promise<StudyArtifactView> {
  const r = retrieveAndPack(ctx, input.scope, input.retrieval);
  if (r.kind === 'abstain') return publishAbstention(ctx, input, r.abstain);
  input.onPhase?.('generating');
  const { content, model } = preCall ? await preCall() : await callModel(ctx, input.scope, input.rules, r.packed, input.call, input.extraVersionIds);
  return publishGenerated(ctx, input, r.packed, content, model);
}

/** Validate + publish one model answer for a single-shot artifact. */
export async function publishGenerated(ctx: AppContext, input: SingleShotInput, packed: PackedEvidence, content: GeneratedContentOut, model: string): Promise<StudyArtifactView> {
  if (content.abstain && content.blocks.length === 0) {
    const reason = MODEL_ABSTAIN.has(content.abstain.reason) ? content.abstain.reason : 'insufficient_evidence';
    return publishAbstention(ctx, input, abstainView(reason, content.abstain.detail ? shorten(content.abstain.detail, 600) : null));
  }
  input.onPhase?.('verifying');
  const processed = await processGenerated(ctx, content, {
    sectionKey: null,
    scope: input.scope,
    rules: input.rules,
    style: input.call.style,
    pack: packed.pack,
    defaultRegionIds: input.defaultRegionIds,
    jobId: input.call.jobId,
    signal: input.call.signal,
  });
  const extra = input.appendBlocks ? input.appendBlocks(processed) : [];
  const blocks = [...processed.blocks, ...extra.map((b, i) => ({ ...b, ord: processed.blocks.length + i }))];
  // a server warning (e.g. «explained from the caption only») is not an explanation by itself: when nothing
  // medical survived and nothing else was added, the answer is an abstention, never an empty «explained» result
  const substantiveExtra = extra.filter((b) => b.kind !== 'warning');
  if (processed.keptMedical === 0 && substantiveExtra.length === 0) {
    // nothing medical survived verification → an honest abstention, the removed sentences on demand
    const detail = processed.removed.length ? `حُذفت ${processed.removed.length} جملة لأنها لم تجتز التحقق من الأدلة؛ لا يُعرض جواب غير مدعوم.` : null;
    return publishAbstention(ctx, input, abstainView('insufficient_evidence', detail), processed.removed);
  }
  const missing = processed.droppedHeadings.map((h) => `لم تذكر المصادر المسموحة: ${h}`);
  if (content.coverage_note) missing.push(shorten(content.coverage_note, 400));
  const pagesCovered = new Set(blocks.flatMap((b) => b.meta?.page_ids ?? []));
  const coverage = { pages_covered: pagesCovered.size, ...(missing.length ? { missing_ar: missing } : {}) };
  const id = ctx.db.tx(() => {
    const aid = insertArtifact(ctx, input, 'published', { model });
    writeBlocks(ctx, aid, null, blocks);
    ctx.db.run('UPDATE artifact SET removed_json = ?, coverage_json = ? WHERE id = ?', [toJson(processed.removed), toJson(coverage), aid]);
    const baseVersions = input.anchor ? [input.anchor.version_id] : [];
    recordBlockDependencies(ctx, aid, blocks, baseVersions.filter((v) => input.scope.versionIds.includes(v)));
    indexArtifact(ctx, aid);
    return aid;
  });
  return artifactView(ctx, id);
}

/** Scope check for a selection anchor: its version must be the version the resolved lock uses (AC-05). */
export function assertAnchorInScope(scope: ScopeReport, anchor: SelectionAnchor): void {
  const v = scope.versionBySource[anchor.source_id];
  if (!v || v !== anchor.version_id) {
    throw new AppError('OUT_OF_SCOPE', 'التحديد من مصدر أو نسخة خارج النطاق المقفل (Source Lock). اختر نطاقًا يشمل هذه النسخة صراحةً.', 409, {
      source_id: anchor.source_id,
      version_id: anchor.version_id,
      scope: scope.describeAr,
    });
  }
}

/** The owner's request scope, pinned to the versions it resolved to (a thread / retry never drifts). */
export function pinnedScope(req: SourceScope, resolved: ScopeReport): SourceScope {
  return { ...req, version_pins: { ...resolved.versionBySource } };
}
