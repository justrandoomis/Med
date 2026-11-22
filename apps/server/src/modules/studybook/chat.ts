// Contextual chat (§30) and «Save AI answer as note» (§28).
//  * a thread is bound to its anchor + source + version + resolved scope; the scope is stored PINNED to the
//    versions it resolved to, so later messages never drift to another version or lecture, and a thread never
//    carries assumptions across lectures (history comes from this thread only)
//  * every assistant message goes through the same evidence pipeline as explanations
//    (status draft → verifying → final | abstained | rejected); drafts never carry content
//  * LITERAL style = verbatim quotes only; SOCRATIC mode = hint + guiding question
//  * a saved answer becomes a note (origin 'ai_answer', ai_record {question, context, evidence, model, date,
//    source versions}) through the annotations module's own sync handler; it stays labelled generated and is
//    never a new source of truth
import {
  CHAT_EFFORTS,
  DEFAULT_CHAT_PREFS,
  SOURCE_TYPE_LABELS_AR,
  sourceChipLabel,
  type AnnotationAnchor,
  type ChatAttachment,
  type ChatEffort,
  type ChatKind,
  type ChatMessageContext,
  type ChatModelId,
  type ChatPrefs,
  type ChatPrefsResponse,
  type ChatMessageView,
  type ChatPostResponse,
  type ChatThreadResponse,
  type ChatThreadView,
  type NoteDTO,
  type RichText,
  type SelectionAnchor,
  type SourceScope,
  type StudyArtifactView,
} from '@medlevo/shared';
import { normalizeForSearch, richTextFromPlain, richTextToPlain } from '@medlevo/shared';
import type { z } from 'zod';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { resolveScope, VERIFIER_VERSION } from '../evidence/services';
import { artifactView, storedScope, type AbstainView, type StoredScope } from './artifacts';
import { anchorRegions, isRealPatientRequest, realPatientAbstain } from './explain';
import { collectAiUsage, type AiTextEvent, type AiUsageEntry } from '../ai';
import { assertAnchorInScope, generateSingleShot, pinnedScope, publishAbstention, requireAi, type ArtifactBase, type SingleShotInput } from './generate';
import { GENERATOR_VERSION, resolveRules } from './rules';
import type { cardCreateSchema, chatPrefsSchema, messageCreateSchema, saveNoteSchema, threadCreateSchema, threadPatchSchema } from './schema';
import { termsForTexts } from './terms';
import { labelParagraph, paragraphOf, richText, shorten, stripClaims } from './text';
import { sha256 } from '../../lib/hash';

interface ThreadRow {
  id: string;
  source_id: string | null;
  version_id: string | null;
  anchor_json: string | null;
  scope_json: string;
  style: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  page_id: string | null;
  socratic: number;
  resolved_scope_json: string | null;
  scope_hash: string | null;
  archived_at: number | null;
  kind: string;
  deleted_at: number | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: 'owner' | 'assistant' | 'system_notice';
  content_json: string;
  status: ChatMessageView['status'];
  abstain_reason: string | null;
  artifact_id: string | null;
  created_at: number;
  style: string | null;
  reply_to_id: string | null;
  detail_json: string | null;
  updated_at: number | null;
  model: string | null;
  effort: string | null;
  page_indexes_json: string | null;
  context_json: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  /** (smart chat, 0471) the card a skill result shows; the skill that produced the turn */
  attachment_json: string | null;
  skill: string | null;
}

const MSG = {
  notFound: 'المحادثة المطلوبة غير موجودة.',
  archived: 'هذه المحادثة مؤرشفة؛ افتح محادثة جديدة.',
  scopeChanged: 'تغيّر نطاق المصادر الذي بُنيت عليه هذه المحادثة (حُذف مصدر أو نسخة منه). افتح محادثة جديدة كي لا تُنقل افتراضاتها إلى نطاق آخر.',
  messageNotFound: 'الرسالة المطلوبة غير موجودة.',
  notSavable: 'تُحفظ كملاحظة الإجابات المكتملة فقط (لا المسودات ولا الامتناعات).',
  noteRejected: 'تعذر حفظ الملاحظة.',
  replaceNotLast: 'يمكن تعديل آخر سؤال في المحادثة فقط (أو إعادة توليد آخر إجابة).',
  contextOutside: 'الصفحة أو التحديد المرفق ليس من نسخة المحاضرة التي بُنيت عليها هذه المحادثة.',
  cardMissing: 'ما تشير إليه هذه البطاقة غير موجود (ربما حُذف)؛ لم تُضف إلى المحادثة.',
  cardArtifact: 'نتيجة المقارنة أو شرح الشكل المطلوبة غير موجودة أو ليست من هذه المحاضرة.',
};

/** a thread the owner deleted is gone for every read and write (its messages stay for notes saved from them) */
function threadRow(ctx: AppContext, id: string): ThreadRow {
  const t = ctx.db.get<ThreadRow>('SELECT * FROM contextual_thread WHERE id = ?', [id]);
  if (!t || t.deleted_at !== null) throw new AppError('NOT_FOUND', MSG.notFound, 404, { thread_id: id });
  return t;
}

/** 0-based page indexes of page ids (unknown ids dropped), sorted and unique. */
function pageIndexesOf(ctx: AppContext, pageIds: Array<string | null | undefined>): number[] {
  const ids = [...new Set(pageIds.filter((x): x is string => !!x))];
  if (!ids.length) return [];
  const rows = ctx.db.all<{ page_index: number }>(`SELECT page_index FROM source_page WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  return [...new Set(rows.map((r) => r.page_index))].sort((a, b) => a - b);
}

function threadView(ctx: AppContext, t: ThreadRow): ChatThreadView {
  const sc = fromJson<StoredScope>(t.resolved_scope_json);
  const stats = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM message WHERE thread_id = ?', [t.id])!;
  const last = ctx.db.get<{ content_json: string }>(`SELECT content_json FROM message WHERE thread_id = ? AND status IN ('final','abstained') ORDER BY created_at DESC, id DESC LIMIT 1`, [t.id]);
  return {
    id: t.id,
    source_id: t.source_id,
    version_id: t.version_id,
    page_id: t.page_id,
    anchor: fromJson<SelectionAnchor>(t.anchor_json),
    scope: { mode: sc?.mode ?? 'lecture_only', source_ids: sc?.source_ids ?? [], version_ids: sc?.version_ids ?? [], describe_ar: sc?.describe_ar ?? '', hash: sc?.hash ?? '' },
    style: t.style as ChatThreadView['style'],
    socratic: t.socratic === 1,
    title: t.title,
    created_at: t.created_at,
    updated_at: t.updated_at,
    message_count: stats.n,
    last_message_preview: last ? shorten(richTextToPlain(fromJson<RichText>(last.content_json)), 140) || null : null,
    kind: (t.kind as ChatKind) ?? 'chat',
    source_title: t.source_id ? (ctx.db.get<{ title: string }>('SELECT title FROM source WHERE id = ?', [t.source_id])?.title ?? null) : null,
  };
}

/**
 * An answer still «draft / verifying» long after any generation could have finished (the server restarted or the
 * request died mid-way) is shown as not completed — never as still being written, and never with content.
 * Model calls time out after 4 minutes and verification batches after 2 minutes each; 30 minutes is far beyond.
 */
const STALE_DRAFT_MS = 30 * 60 * 1000;

function messageView(ctx: AppContext, m: MessageRow): ChatMessageView {
  const detail = fromJson<{ abstain?: AbstainView; error?: { code: string; message: string } }>(m.detail_json);
  const pending = m.role === 'assistant' && (m.status === 'draft' || m.status === 'verifying');
  if (pending && ctx.clock.now() - (m.updated_at ?? m.created_at) > STALE_DRAFT_MS) m = { ...m, status: 'rejected' };
  const settled = m.status === 'final' || m.status === 'abstained';
  let artifact: StudyArtifactView | null = null;
  if (m.role === 'assistant' && settled && m.artifact_id) {
    try {
      artifact = artifactView(ctx, m.artifact_id);
    } catch {
      artifact = null;
    }
  }
  return {
    id: m.id,
    thread_id: m.thread_id,
    role: m.role,
    status: m.status,
    style: (m.style as ChatMessageView['style']) ?? null,
    // drafts / verifying never expose content (§30: no unverified claim shown first)
    content: m.role === 'owner' || settled ? (fromJson<RichText>(m.content_json) ?? { v: 1, paragraphs: [] }) : { v: 1, paragraphs: [] },
    artifact,
    abstain: detail?.abstain ?? artifact?.abstain ?? null,
    reply_to_id: m.reply_to_id,
    created_at: m.created_at,
    model: m.model,
    effort: (m.effort as ChatEffort | null) ?? null,
    page_indexes: fromJson<number[]>(m.page_indexes_json) ?? [],
    context: fromJson<ChatMessageContext>(m.context_json),
    usage: m.role === 'assistant' && settled && (m.input_tokens !== null || m.cost_usd !== null) ? { input_tokens: m.input_tokens, output_tokens: m.output_tokens, cost_usd: m.cost_usd } : null,
    error: m.status === 'rejected' ? (detail?.error ?? null) : null,
    attachment: m.role === 'assistant' ? (fromJson<ChatAttachment>(m.attachment_json) ?? null) : null,
  };
}

export function createThread(ctx: AppContext, body: z.infer<typeof threadCreateSchema>): ChatThreadResponse {
  const scope = resolveScope(ctx, body.scope);
  const anchor = (body.anchor ?? null) as SelectionAnchor | null;
  if (anchor) assertAnchorInScope(scope, anchor);
  if (anchor?.page_id) {
    const p = ctx.db.get<{ version_id: string }>('SELECT version_id FROM source_page WHERE id = ?', [anchor.page_id]);
    if (!p || p.version_id !== anchor.version_id) throw new AppError('OUT_OF_SCOPE', 'الصفحة المحددة لا تنتمي إلى نسخة المصدر المحددة.', 409);
  }
  // the thread is bound to its passage: every anchor region must belong to the anchor's (locked) version
  if (anchor) anchorRegions(ctx, anchor);
  if (anchor?.block) {
    const lineage = ctx.db.get<{ primary_source_id: string | null }>('SELECT primary_source_id FROM artifact WHERE lineage_id = ? LIMIT 1', [anchor.block.lineage_id]);
    if (!lineage || lineage.primary_source_id !== anchor.source_id) {
      throw new AppError('OUT_OF_SCOPE', 'الفقرة المحددة ليست من كتاب دراسة لهذا المصدر.', 409, { lineage_id: anchor.block.lineage_id });
    }
  }
  const sourceId = anchor?.source_id ?? scope.sourceIds[0] ?? null;
  const versionId = anchor?.version_id ?? (sourceId ? (scope.versionBySource[sourceId] ?? null) : null);
  const now = ctx.clock.now();
  const id = newId(now);
  const kind: ChatKind = body.kind ?? 'chat';
  // a conversation not bound to a page / selection is named after its first question (postMessage) — null until then
  const title = body.title?.trim() || (anchor?.quote?.exact ? `حول: ${shorten(anchor.quote.exact, 60)}` : anchor?.page_id ? 'محادثة حول هذه الصفحة' : null);
  ctx.db.run(
    `INSERT INTO contextual_thread (id, source_id, version_id, anchor_json, scope_json, style, title, created_at, updated_at, page_id, socratic, resolved_scope_json, scope_hash, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sourceId,
      versionId,
      anchor ? toJson(anchor) : null,
      toJson(pinnedScope(body.scope as SourceScope, scope)),
      body.style,
      title,
      now,
      now,
      anchor?.page_id ?? null,
      body.socratic ? 1 : 0,
      toJson(storedScope(scope)),
      scope.hash,
      kind,
    ],
  );
  return { thread: threadView(ctx, threadRow(ctx, id)), messages: [] };
}

export function listThreads(ctx: AppContext, q: { source_id?: string; page_id?: string; limit?: number; scope?: 'all' | 'global'; q?: string }): ChatThreadView[] {
  const where = ['archived_at IS NULL', 'deleted_at IS NULL'];
  const params: unknown[] = [];
  if (q.scope === 'global') where.push('source_id IS NULL');
  const needle = q.q?.trim();
  if (needle) {
    // title or one of the owner's questions (plain substring; LIKE wildcards in the needle are escaped)
    const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(title LIKE ? ESCAPE '\\' OR id IN (SELECT thread_id FROM message WHERE role = 'owner' AND content_json LIKE ? ESCAPE '\\'))`);
    params.push(like, like);
  }
  if (q.source_id) {
    where.push('source_id = ?');
    params.push(q.source_id);
  }
  if (q.page_id) {
    where.push('page_id = ?');
    params.push(q.page_id);
  }
  const rows = ctx.db.all<ThreadRow>(`SELECT * FROM contextual_thread WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`, [...params, q.limit ?? 50]);
  return rows.map((t) => threadView(ctx, t));
}

export function getThread(ctx: AppContext, id: string): ChatThreadResponse {
  const t = threadRow(ctx, id);
  const msgs = ctx.db.all<MessageRow>('SELECT * FROM message WHERE thread_id = ? ORDER BY created_at, id', [id]);
  return { thread: threadView(ctx, t), messages: msgs.map((m) => messageView(ctx, m)) };
}

export function archiveThread(ctx: AppContext, id: string): ChatThreadView {
  threadRow(ctx, id);
  ctx.db.run('UPDATE contextual_thread SET archived_at = ?, updated_at = ? WHERE id = ?', [ctx.clock.now(), ctx.clock.now(), id]);
  return threadView(ctx, threadRow(ctx, id));
}

export function renameThread(ctx: AppContext, id: string, body: z.infer<typeof threadPatchSchema>): ChatThreadView {
  threadRow(ctx, id);
  ctx.db.run('UPDATE contextual_thread SET title = ?, updated_at = ? WHERE id = ?', [body.title.trim(), ctx.clock.now(), id]);
  return threadView(ctx, threadRow(ctx, id));
}

/** Deletes a conversation for the owner: gone from lists, reads and search; messages stay only for notes saved from them. */
export function deleteThread(ctx: AppContext, id: string): { deleted: true } {
  threadRow(ctx, id);
  ctx.db.tx(() => {
    ctx.db.run('UPDATE contextual_thread SET deleted_at = ?, updated_at = ? WHERE id = ?', [ctx.clock.now(), ctx.clock.now(), id]);
    ctx.db.run(`DELETE FROM owner_content_fts WHERE entity_type = 'message' AND entity_id IN (SELECT id FROM message WHERE thread_id = ?)`, [id]);
  });
  return { deleted: true };
}

// ───────── remembered chat preferences (one row in this user's own vault) ─────────
export function chatPrefs(ctx: AppContext): ChatPrefsResponse {
  const r = ctx.db.get<{ model: string | null; effort: string | null; auto_explain: number; sync_pages: number }>(`SELECT model, effort, auto_explain, sync_pages FROM chat_preference WHERE id = 'owner'`);
  const available = ctx.ai.selectableModels() as ChatModelId[];
  const prefs: ChatPrefs = r
    ? {
        // a remembered model this server can no longer serve falls back to the default (never sent, never a refusal loop)
        model: r.model && available.includes(r.model as ChatModelId) ? (r.model as ChatModelId) : null,
        effort: r.effort && (CHAT_EFFORTS as readonly string[]).includes(r.effort) ? (r.effort as ChatEffort) : null,
        auto_explain: r.auto_explain === 1,
        sync_pages: r.sync_pages === 1,
      }
    : { ...DEFAULT_CHAT_PREFS };
  return { prefs, defaults: ctx.ai.taskDefaults('chat'), available_models: available };
}

export function saveChatPrefs(ctx: AppContext, patch: z.infer<typeof chatPrefsSchema>): ChatPrefsResponse {
  const cur = chatPrefs(ctx).prefs;
  const next: ChatPrefs = { ...cur, ...patch };
  ctx.db.run(
    `INSERT INTO chat_preference (id, model, effort, auto_explain, sync_pages, updated_at) VALUES ('owner', ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET model = excluded.model, effort = excluded.effort, auto_explain = excluded.auto_explain, sync_pages = excluded.sync_pages, updated_at = excluded.updated_at`,
    [next.model, next.effort, next.auto_explain ? 1 : 0, next.sync_pages ? 1 : 0, ctx.clock.now()],
  );
  return chatPrefs(ctx);
}

type MessageInsert = Omit<MessageRow, 'created_at' | 'updated_at' | 'model' | 'effort' | 'page_indexes_json' | 'context_json' | 'input_tokens' | 'output_tokens' | 'cost_usd' | 'attachment_json' | 'skill'> &
  Partial<Pick<MessageRow, 'model' | 'effort' | 'page_indexes_json' | 'context_json' | 'attachment_json' | 'skill'>>;

function insertMessage(ctx: AppContext, m: MessageInsert): void {
  const now = ctx.clock.now();
  ctx.db.run(
    `INSERT INTO message (id, thread_id, role, content_json, status, abstain_reason, artifact_id, created_at, style, reply_to_id, detail_json, updated_at, model, effort, page_indexes_json, context_json, attachment_json, skill)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.thread_id, m.role, m.content_json, m.status, m.abstain_reason, m.artifact_id, now, m.style, m.reply_to_id, m.detail_json, now, m.model ?? null, m.effort ?? null, m.page_indexes_json ?? null, m.context_json ?? null, m.attachment_json ?? null, m.skill ?? null],
  );
}

function setMessage(
  ctx: AppContext,
  id: string,
  patch: Partial<Pick<MessageRow, 'status' | 'content_json' | 'abstain_reason' | 'artifact_id' | 'detail_json' | 'model' | 'page_indexes_json' | 'input_tokens' | 'output_tokens' | 'cost_usd'>>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    params.push(v);
  }
  sets.push('updated_at = ?');
  params.push(ctx.clock.now());
  ctx.db.run(`UPDATE message SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

function indexMessage(ctx: AppContext, id: string, rt: RichText): void {
  ctx.db.run(`DELETE FROM owner_content_fts WHERE entity_type = 'message' AND entity_id = ?`, [id]);
  const text = normalizeForSearch(richTextToPlain(rt));
  if (text.trim()) ctx.db.run(`INSERT INTO owner_content_fts (entity_type, entity_id, origin, text) VALUES ('message', ?, 'generated', ?)`, [id, text]);
}

/** The answer text (claims kept in runs, so chips render) — the published blocks in order. */
function answerRichText(a: StudyArtifactView): RichText {
  const paragraphs = a.blocks.flatMap((b) => b.content.paragraphs);
  if (a.abstain) return richTextFromPlain([a.abstain.reason_ar, a.abstain.detail ?? ''].filter(Boolean).join('\n'));
  return { v: 1, paragraphs };
}

const CHAT_TASK =
  'Answer the OWNER QUESTION about the selected passage (if any) using only the evidence excerpts. Previous turns of THIS conversation are given as generated, non-evidence context: do not treat earlier answers as evidence, and do not carry assumptions from other lectures.';

/** (chat UX) what each conversation kind adds to the task (the evidence rules stay those of CHAT_TASK). */
const KIND_TASK: Record<ChatKind, string | null> = {
  chat: null,
  explain:
    'The learner is reading the lecture page by page: explain the ATTACHED PAGE (or selection) in order, as a teacher would, covering every point on it that the evidence supports. Use headings and lists where they help.',
  question:
    'The learner needs help with a QUESTION (e.g. an exam MCQ): explain the concept it tests and why each option is right or wrong, from the evidence only. If the learner asks to be quizzed, ask one question at a time and wait.',
  compare:
    'The learner wants a COMPARISON: answer with a comparison_table block (one row per feature, one column per item compared), each cell a cited sentence, then a short paragraph with the key difference.',
};

export interface PostMessageOptions {
  signal?: AbortSignal;
  /** (Round 7 H4, §30) streaming endpoint hooks: the unverified draft text and the pipeline phase */
  onText?: (e: AiTextEvent) => void;
  onPhase?: (phase: 'generating' | 'verifying') => void;
}

const CANCELLED_AR = 'أوقفتَ الإجابة قبل اكتمالها؛ لم يُحفظ منها شيء ولم يُعرض منها ما لم يُتحقق منه.';

/**
 * (chat UX) The page / selection attached to one message, checked against the thread's lecture version (a context can
 * never widen the Source Lock: its version must be one the thread's pinned scope resolved to).
 */
function checkedContext(ctx: AppContext, t: ThreadRow, scope: { versionIds: string[] }, c: ChatMessageContext | null | undefined): { ctx: ChatMessageContext | null; versionId: string | null } {
  if (!c || (!c.page_id && !c.region_ids?.length && !c.quote?.trim())) return { ctx: null, versionId: null };
  let versionId: string | null = null;
  if (c.page_id) {
    const p = ctx.db.get<{ version_id: string }>('SELECT version_id FROM source_page WHERE id = ?', [c.page_id]);
    if (!p || (t.version_id ? p.version_id !== t.version_id : !scope.versionIds.includes(p.version_id))) throw new AppError('OUT_OF_SCOPE', MSG.contextOutside, 409, { page_id: c.page_id });
    versionId = p.version_id;
  }
  if (c.region_ids?.length) {
    const v = versionId ?? t.version_id;
    if (!v) throw new AppError('OUT_OF_SCOPE', MSG.contextOutside, 409);
    anchorRegions(ctx, { source_id: t.source_id ?? '', version_id: v, page_id: c.page_id ?? null, region_ids: c.region_ids });
    versionId = v;
  }
  return { ctx: { page_id: c.page_id ?? null, region_ids: c.region_ids ?? [], quote: c.quote?.trim() ? c.quote.trim().slice(0, 6000) : null }, versionId };
}

/** Pages of THIS lecture version an answer explains or cites (block page tags + cited evidence pages). */
function answerPages(ctx: AppContext, t: ThreadRow, a: StudyArtifactView, contextPages: number[]): number[] {
  const set = new Set<number>(contextPages);
  for (const b of a.blocks) for (const i of b.meta?.page_indexes ?? []) set.add(i);
  const blockPageIds = a.blocks.flatMap((b) => b.meta?.page_ids ?? []);
  for (const i of pageIndexesOf(ctx, blockPageIds)) set.add(i);
  for (const c of Object.values(a.claims)) {
    for (const ci of c.citations) {
      const e = ci.evidence;
      if (e.page_index !== null && (!t.version_id || e.version_id === t.version_id)) set.add(e.page_index);
    }
  }
  return [...set].sort((x, y) => x - y);
}

function sumUsage(usage: AiUsageEntry[]): { input: number | null; output: number | null; cost: number | null } {
  if (!usage.length) return { input: null, output: null, cost: null };
  const n = (v: number | null) => v ?? 0;
  return {
    input: usage.reduce((s, u) => s + n(u.inputTokens), 0),
    output: usage.reduce((s, u) => s + n(u.outputTokens), 0),
    cost: Math.round(usage.reduce((s, u) => s + u.costUsd, 0) * 1e8) / 1e8,
  };
}

/**
 * (chat UX) edit the last question / regenerate its answer: the owner message `fromId` (the LAST owner message of the
 * thread) and everything after it are removed before the new turn is written. Only the last turn can be replaced, so
 * the history the next answer sees is always the history the owner sees.
 */
function dropLastTurn(ctx: AppContext, t: ThreadRow, fromId: string): void {
  const m = ctx.db.get<MessageRow>('SELECT * FROM message WHERE id = ? AND thread_id = ?', [fromId, t.id]);
  if (!m || m.role !== 'owner') throw new AppError('NOT_FOUND', MSG.messageNotFound, 404, { message_id: fromId });
  const lastOwner = ctx.db.get<{ id: string }>(`SELECT id FROM message WHERE thread_id = ? AND role = 'owner' ORDER BY created_at DESC, id DESC LIMIT 1`, [t.id]);
  if (lastOwner?.id !== fromId) throw new AppError('CONFLICT', MSG.replaceNotLast, 409, { message_id: fromId });
  const doomed = ctx.db.all<{ id: string }>('SELECT id FROM message WHERE thread_id = ? AND (created_at > ? OR (created_at = ? AND id >= ?))', [t.id, m.created_at, m.created_at, m.id]).map((r) => r.id);
  if (!doomed.length) return;
  const qs = doomed.map(() => '?').join(',');
  ctx.db.run(`DELETE FROM owner_content_fts WHERE entity_type = 'message' AND entity_id IN (${qs})`, doomed);
  ctx.db.run(`DELETE FROM message WHERE id IN (${qs})`, doomed);
}

/**
 * (chat UX) a chosen model must be one the configured provider offers (or its default): checked BEFORE anything is
 * written or retrieved, so a refused model never leaves a half turn (the orchestrator enforces it again on the call).
 */
export function assertChatModel(ctx: AppContext, model: string | null | undefined): void {
  if (!model || model === ctx.ai.taskDefaults('chat').model || ctx.ai.selectableModels().includes(model)) return;
  throw new AppError('AI_NOT_CONFIGURED', 'النموذج المختار غير متاح على هذا الخادم. اختر نموذجًا آخر من القائمة أو اترك الاختيار الافتراضي.', 409, { model, reason: 'model_not_available' });
}

export async function postMessage(ctx: AppContext, threadId: string, body: z.infer<typeof messageCreateSchema>, opts: PostMessageOptions = {}): Promise<ChatPostResponse> {
  const t = threadRow(ctx, threadId);
  if (t.archived_at) throw new AppError('CONFLICT', MSG.archived, 409);
  const scope = resolveScope(ctx, fromJson<SourceScope>(t.scope_json));
  if (t.scope_hash && scope.hash !== t.scope_hash) throw new AppError('OUT_OF_SCOPE', MSG.scopeChanged, 409, { thread_id: t.id });
  const style = (body.style ?? t.style) as ChatThreadView['style'];
  const kind: ChatKind = body.kind ?? ((t.kind as ChatKind) || 'chat');
  const anchor = fromJson<SelectionAnchor>(t.anchor_json);
  const attached = checkedContext(ctx, t, scope, body.context);
  const rules = resolveRules(ctx, { sourceId: t.source_id, overrides: { socratic: t.socratic === 1 } });
  const realPatient = isRealPatientRequest(body.text);
  if (!realPatient) requireAi(ctx, 'chat');
  assertChatModel(ctx, body.model);
  if (body.replace_from) ctx.db.tx(() => dropLastTurn(ctx, t, body.replace_from!));

  // history BEFORE this question (this thread only); skill cards are not answers and never reach the model
  const history = ctx.db
    .all<MessageRow>(`SELECT * FROM message WHERE thread_id = ? AND status IN ('final','abstained') AND skill IS NULL ORDER BY created_at DESC, id DESC LIMIT 6`, [t.id])
    .reverse();

  const contextPages = pageIndexesOf(ctx, [attached.ctx?.page_id ?? null]);
  const ownerId = newId(ctx.clock.now());
  const answerId = newId(ctx.clock.now());
  ctx.db.tx(() => {
    insertMessage(ctx, {
      id: ownerId,
      thread_id: t.id,
      role: 'owner',
      content_json: toJson(richTextFromPlain(body.text))!,
      status: 'final',
      abstain_reason: null,
      artifact_id: null,
      style,
      reply_to_id: null,
      detail_json: null,
      model: body.model ?? null,
      effort: body.effort ?? null,
      page_indexes_json: toJson(contextPages),
      context_json: attached.ctx ? toJson(attached.ctx) : null,
    });
    insertMessage(ctx, {
      id: answerId,
      thread_id: t.id,
      role: 'assistant',
      content_json: toJson({ v: 1, paragraphs: [] })!,
      status: 'draft',
      abstain_reason: null,
      artifact_id: null,
      style,
      reply_to_id: ownerId,
      detail_json: null,
      effort: body.effort ?? null,
    });
    // a conversation is named after its first question (the owner can rename it)
    if (!t.title) ctx.db.run('UPDATE contextual_thread SET title = ? WHERE id = ? AND title IS NULL', [shorten(body.text.replace(/\s+/g, ' '), 70), t.id]);
    ctx.db.run('UPDATE contextual_thread SET updated_at = ? WHERE id = ?', [ctx.clock.now(), t.id]);
  });

  const base: ArtifactBase = {
    kind: 'chat_answer',
    title: `سؤال: ${shorten(body.text, 80)}`,
    primarySourceId: t.source_id,
    scope,
    rules,
    // chat answers are conversational: keyed per message (never served to another question)
    cacheKey: sha256(`chat|${t.id}|${answerId}|${GENERATOR_VERSION}|${VERIFIER_VERSION}`),
    params: { thread_id: t.id, message_id: answerId, style, socratic: t.socratic === 1, level: rules.level, language: 'ar', kind, model: body.model ?? null, effort: body.effort ?? null },
    anchor,
  };

  let artifact: StudyArtifactView;
  let usage: AiUsageEntry[] = [];
  try {
    if (realPatient) {
      artifact = publishAbstention(ctx, base, realPatientAbstain());
    } else {
      const selection = attached.ctx?.quote ?? anchor?.quote?.exact?.trim() ?? '';
      const leading = [];
      if (selection) leading.push({ label: 'SELECTION (text the learner selected in the source)', text: selection.slice(0, 6000) });
      if (history.length) {
        leading.push({
          label: 'CONVERSATION SO FAR (this thread only; answers are generated, NOT evidence)',
          text: history.map((h) => `${h.role === 'owner' ? 'Learner' : 'Previous answer (generated)'}: ${richTextToPlain(fromJson<RichText>(h.content_json)).slice(0, 1500)}`).join('\n\n'),
        });
      }
      // the message's own context (the page being read now) wins over the thread's anchor
      const retrievalAnchor = attached.ctx?.region_ids?.length
        ? { region_ids: attached.ctx.region_ids }
        : attached.ctx?.page_id
          ? { page_id: attached.ctx.page_id }
          : anchor?.region_ids?.length
            ? { region_ids: anchor.region_ids }
            : anchor?.page_id
              ? { page_id: anchor.page_id }
              : null;
      const kindTask = KIND_TASK[kind];
      const input: SingleShotInput = {
        ...base,
        retrieval: {
          query: [body.text, selection].join(' ').slice(0, 2000),
          anchor: retrievalAnchor,
          k: 8,
          purpose: 'lecture_explanation',
        },
        call: {
          task: 'chat',
          style,
          taskText: kindTask ? `${CHAT_TASK} ${kindTask}` : CHAT_TASK,
          ownerInstruction: body.text,
          socratic: t.socratic === 1,
          leading,
          terms: termsForTexts(ctx, [body.text, selection]),
          signal: opts.signal,
          onText: opts.onText,
          model: body.model ?? null,
          effort: body.effort ?? null,
        },
        defaultRegionIds: attached.ctx?.region_ids?.length ? attached.ctx.region_ids : (anchor?.region_ids ?? []),
        onPhase: (phase) => {
          if (phase === 'verifying') setMessage(ctx, answerId, { status: 'verifying' });
          opts.onPhase?.(phase);
        },
      };
      const run = await collectAiUsage(() => generateSingleShot(ctx, input));
      artifact = run.value;
      usage = run.usage;
    }
  } catch (e) {
    const err = e as { code?: string; messageAr?: string };
    // (Round 7 H4) the owner stopped a streaming answer: said as such, never as a server failure
    const error = opts.signal?.aborted ? { code: 'CANCELLED', message: CANCELLED_AR } : { code: err.code ?? 'INTERNAL', message: err.messageAr ?? 'تعذر إكمال الإجابة.' };
    setMessage(ctx, answerId, { status: 'rejected', detail_json: toJson({ error }) });
    throw e;
  }

  const rt = answerRichText(artifact);
  const spent = sumUsage(usage);
  ctx.db.tx(() => {
    setMessage(ctx, answerId, {
      status: artifact.abstain ? 'abstained' : 'final',
      content_json: toJson(rt)!,
      abstain_reason: artifact.abstain?.reason ?? null,
      artifact_id: artifact.id,
      detail_json: toJson({ abstain: artifact.abstain ?? undefined, removed: artifact.removed.length }),
      // the model that actually served the generation (the verifier is recorded on the artifact's claims)
      model: artifact.model ?? usage.find((u) => u.task === 'chat' && u.status === 'ok')?.model ?? null,
      page_indexes_json: toJson(artifact.abstain ? contextPages : answerPages(ctx, t, artifact, contextPages)),
      input_tokens: spent.input,
      output_tokens: spent.output,
      cost_usd: spent.cost,
    });
    if (!artifact.abstain) indexMessage(ctx, answerId, rt);
  });
  const msg = (id: string) => messageView(ctx, ctx.db.get<MessageRow>('SELECT * FROM message WHERE id = ?', [id])!);
  return { owner_message: msg(ownerId), answer: msg(answerId) };
}

// ───────── smart chat: skill results as cards (wp/smart-rail, 0471) ─────────
const CARD_LABELS_AR: Record<ChatAttachment['type'], string> = {
  mcq: 'أسئلة اختيار من متعدد من مصادرك',
  case: 'حالة سريرية من المحاضرة',
  cards: 'بطاقات مراجعة من صور المحاضرة',
  compare: 'مقارنة في جدول',
  figure: 'شرح الشكل',
  questions: 'أسئلة المحاضرة المرتبطة',
  sources: 'مصادر هذه المحادثة ونطاقها',
};

function assertIds(ctx: AppContext, table: 'question' | 'generated_question_candidate' | 'flashcard', ids: string[], extra = ''): void {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return;
  const n = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE id IN (${uniq.map(() => '?').join(',')})${extra}`, uniq)!.n;
  if (n !== uniq.length) throw new AppError('NOT_FOUND', MSG.cardMissing, 404, { table });
}

/**
 * Every id a card references must exist in this vault (a card never points at nothing, and never smuggles another
 * user's object in); compare / figure cards show an artifact the evidence pipeline already checked.
 */
function checkAttachment(ctx: AppContext, t: ThreadRow, a: ChatAttachment, artifactId: string | null | undefined): StudyArtifactView | null {
  switch (a.type) {
    case 'mcq':
      if (!ctx.db.get('SELECT 1 AS x FROM question_generation_run WHERE id = ?', [a.run_id])) throw new AppError('NOT_FOUND', MSG.cardMissing, 404, { run_id: a.run_id });
      assertIds(ctx, 'question', a.question_ids);
      assertIds(ctx, 'generated_question_candidate', a.pending_ids ?? []);
      return null;
    case 'case':
      if (!ctx.db.get('SELECT 1 AS x FROM clinical_case WHERE id = ? AND deleted_at IS NULL', [a.case_id])) throw new AppError('NOT_FOUND', MSG.cardMissing, 404, { case_id: a.case_id });
      return null;
    case 'cards':
      if (!ctx.db.get('SELECT 1 AS x FROM source_version WHERE id = ?', [a.version_id])) throw new AppError('NOT_FOUND', MSG.cardMissing, 404, { version_id: a.version_id });
      assertIds(ctx, 'flashcard', a.card_ids, ' AND deleted_at IS NULL');
      return null;
    case 'questions':
      assertIds(ctx, 'question', a.ids);
      return null;
    case 'sources':
      return null;
    case 'compare':
    case 'figure': {
      if (!artifactId) throw new AppError('VALIDATION_FAILED', MSG.cardArtifact, 400);
      let art: StudyArtifactView;
      try {
        art = artifactView(ctx, artifactId);
      } catch {
        throw new AppError('NOT_FOUND', MSG.cardArtifact, 404, { artifact_id: artifactId });
      }
      const kinds = a.type === 'compare' ? ['comparison'] : ['figure_explanation', 'explanation'];
      const owner = ctx.db.get<{ primary_source_id: string | null }>('SELECT primary_source_id FROM artifact WHERE id = ?', [artifactId]);
      if (!kinds.includes(art.kind) || (t.source_id && owner?.primary_source_id && owner.primary_source_id !== t.source_id)) {
        throw new AppError('OUT_OF_SCOPE', MSG.cardArtifact, 409, { artifact_id: artifactId });
      }
      return art;
    }
  }
}

/**
 * Append a skill result to a conversation: the owner's request + an assistant message carrying the card. Nothing is
 * generated here (the skill ran in its own module); the card is part of the history (reload, other devices) and is
 * never sent to the model as an answer. Compare / figure cards show the checked artifact itself.
 */
export function appendCard(ctx: AppContext, threadId: string, body: z.infer<typeof cardCreateSchema>): ChatPostResponse {
  const t = threadRow(ctx, threadId);
  if (t.archived_at) throw new AppError('CONFLICT', MSG.archived, 409);
  const scope = resolveScope(ctx, fromJson<SourceScope>(t.scope_json));
  if (t.scope_hash && scope.hash !== t.scope_hash) throw new AppError('OUT_OF_SCOPE', MSG.scopeChanged, 409, { thread_id: t.id });
  const attached = checkedContext(ctx, t, scope, body.context);
  const attachment = body.attachment as ChatAttachment;
  const art = checkAttachment(ctx, t, attachment, body.artifact_id);
  const contextPages = pageIndexesOf(ctx, [attached.ctx?.page_id ?? null]);
  const ownerId = newId(ctx.clock.now());
  const answerId = newId(ctx.clock.now());
  const content = art ? answerRichText(art) : richTextFromPlain(CARD_LABELS_AR[attachment.type]);
  ctx.db.tx(() => {
    insertMessage(ctx, {
      id: ownerId,
      thread_id: t.id,
      role: 'owner',
      content_json: toJson(richTextFromPlain(body.text))!,
      status: 'final',
      abstain_reason: null,
      artifact_id: null,
      style: t.style,
      reply_to_id: null,
      detail_json: null,
      page_indexes_json: toJson(contextPages),
      context_json: attached.ctx ? toJson(attached.ctx) : null,
      skill: body.skill,
    });
    insertMessage(ctx, {
      id: answerId,
      thread_id: t.id,
      role: 'assistant',
      content_json: toJson(content)!,
      status: art?.abstain ? 'abstained' : 'final',
      abstain_reason: art?.abstain?.reason ?? null,
      artifact_id: art?.id ?? null,
      style: t.style,
      reply_to_id: ownerId,
      detail_json: art?.abstain ? toJson({ abstain: art.abstain }) : null,
      page_indexes_json: toJson(art && !art.abstain ? answerPages(ctx, t, art, contextPages) : contextPages),
      context_json: null,
      attachment_json: toJson(attachment),
      skill: body.skill,
    });
    indexMessage(ctx, ownerId, richTextFromPlain(body.text));
    if (!t.title) ctx.db.run('UPDATE contextual_thread SET title = ? WHERE id = ? AND title IS NULL', [shorten(body.text.replace(/\s+/g, ' '), 70), t.id]);
    ctx.db.run('UPDATE contextual_thread SET updated_at = ? WHERE id = ?', [ctx.clock.now(), t.id]);
  });
  const msg = (id: string) => messageView(ctx, ctx.db.get<MessageRow>('SELECT * FROM message WHERE id = ?', [id])!);
  return { owner_message: msg(ownerId), answer: msg(answerId) };
}

// ───────── save answer as note (§28) ─────────
export function saveAnswerAsNote(ctx: AppContext, messageId: string, body: z.infer<typeof saveNoteSchema>): { note: NoteDTO; result: string } {
  const m = ctx.db.get<MessageRow>('SELECT * FROM message WHERE id = ?', [messageId]);
  if (!m) throw new AppError('NOT_FOUND', MSG.messageNotFound, 404);
  if (m.role !== 'assistant' || m.status !== 'final' || !m.artifact_id) throw new AppError('CONFLICT', MSG.notSavable, 409);
  const t = threadRow(ctx, m.thread_id);
  const a = artifactView(ctx, m.artifact_id);
  const question = m.reply_to_id ? richTextToPlain(fromJson<RichText>(ctx.db.get<{ content_json: string }>('SELECT content_json FROM message WHERE id = ?', [m.reply_to_id])?.content_json)) : '';
  const anchor = fromJson<SelectionAnchor>(t.anchor_json);

  // evidence of the answer's kept claims (citations are rows; the note keeps their ids + labels)
  const citations = Object.values(a.claims).flatMap((c) => c.citations.map((ci) => ({ claim: c, ev: ci.evidence })));
  const evidenceIds = [...new Set(citations.map((c) => c.ev.id))];
  const labels = [...new Set(citations.map((c) => `${sourceChipLabel(c.ev)} — ${c.ev.source_title}`))];
  const versions = [...new Set(citations.map((c) => `${c.ev.source_id}|${c.ev.version_id}|${c.ev.version_no}`))].map((s) => {
    const [source_id, version_id, version_no] = s.split('|');
    return { source_id, version_id, version_no: Number(version_no) };
  });
  const answer = stripClaims(answerRichText(a));
  const noteBody = richText([
    labelParagraph('إجابة مولَّدة بالذكاء الاصطناعي — محفوظة كملاحظة؛ ليست مصدرًا مستقلًا ولا دليلًا على نفسها'),
    question ? paragraphOf([{ text: `السؤال: ${question}` }]) : null,
    ...answer.paragraphs,
    labels.length ? paragraphOf([{ text: `الأدلة: ${labels.join('، ')}` }]) : paragraphOf([{ text: 'لا توجد أدلة مرتبطة بهذه الإجابة.' }]),
  ]);
  let noteAnchor: AnnotationAnchor | null = null;
  if (anchor?.block) {
    const art = ctx.db.get<{ version_no: number }>('SELECT version_no FROM artifact WHERE lineage_id = ? ORDER BY version_no DESC LIMIT 1', [anchor.block.lineage_id]);
    noteAnchor = { type: 'block', lineage_id: anchor.block.lineage_id, artifact_version: art?.version_no ?? 1, block_key: anchor.block.block_key };
  } else if (anchor?.page_id) {
    const p = ctx.db.get<{ page_index: number }>('SELECT page_index FROM source_page WHERE id = ?', [anchor.page_id]);
    if (p) noteAnchor = { type: 'page', source_id: anchor.source_id, version_id: anchor.version_id, page_id: anchor.page_id, page_index: p.page_index, space: 'page_norm' };
  }
  // the note id is the client's (a fresh ULID). It must never name another note: an existing note is only ever
  // this same answer saved before (→ the idempotent duplicate below); anything else — the owner's own note, a
  // deleted one in the trash, another answer — is refused, so nothing is overwritten or resurrected (§0.6).
  const existing = ctx.db.get<{ origin: string; ai_record_json: string | null }>('SELECT origin, ai_record_json FROM note WHERE id = ?', [body.note_id]);
  if (existing) {
    const rec = fromJson<{ context?: { message_id?: string } }>(existing.ai_record_json);
    if (existing.origin !== 'ai_answer' || rec?.context?.message_id !== m.id) {
      throw new AppError('CONFLICT', 'معرّف الملاحظة مستخدم لملاحظة أخرى؛ لم يُكتب فوقها شيء. أعد المحاولة لتُحفظ الإجابة في ملاحظة جديدة.', 409, { note_id: body.note_id });
    }
  }
  const sourceTitle = t.source_id ? ctx.db.get<{ title: string; source_type: keyof typeof SOURCE_TYPE_LABELS_AR }>('SELECT title, source_type FROM source WHERE id = ?', [t.source_id]) : undefined;
  const aiRecord = {
    kind: 'ai_answer',
    label_ar: 'مولَّد — ليس مصدرًا',
    question,
    context: {
      thread_id: t.id,
      message_id: m.id,
      artifact_id: a.id,
      source_id: t.source_id,
      source_title: sourceTitle?.title ?? null,
      version_id: t.version_id,
      page_id: t.page_id,
      quote: anchor?.quote?.exact ?? null,
      scope_ar: a.scope.describe_ar,
    },
    evidence_ids: evidenceIds,
    evidence_labels: labels,
    claim_ids: Object.keys(a.claims),
    verification: Object.values(a.claims).reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.verification_status]: (acc[c.verification_status] ?? 0) + 1 }), {}),
    model: a.model,
    rules_version: a.rules_version,
    generated_at: a.published_at ?? a.created_at,
    saved_at: ctx.clock.now(),
    source_versions: versions,
  };
  const res = ctx.sync.push([
    {
      op_id: `srvnote-${m.id}-${body.note_id}`.slice(0, 120),
      device_id: 'server',
      entity_type: 'note',
      entity_id: body.note_id,
      op: 'upsert',
      payload: { node_id: body.node_id ?? null, title: `إجابة محفوظة: ${shorten(question || a.title || '', 80)}`, body: noteBody, anchor: noteAnchor, origin: 'ai_answer', ai_record: aiRecord },
      client_ts: ctx.clock.now(),
    },
  ]).results[0]!;
  if (res.result === 'rejected' || !res.entity) throw new AppError('CONFLICT', res.detail ?? MSG.noteRejected, 409);
  return { note: res.entity as NoteDTO, result: res.result };
}
