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
  SOURCE_TYPE_LABELS_AR,
  sourceChipLabel,
  type AnnotationAnchor,
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
import { assertAnchorInScope, generateSingleShot, pinnedScope, publishAbstention, requireAi, type ArtifactBase, type SingleShotInput } from './generate';
import { GENERATOR_VERSION, resolveRules } from './rules';
import type { messageCreateSchema, saveNoteSchema, threadCreateSchema } from './schema';
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
}

const MSG = {
  notFound: 'المحادثة المطلوبة غير موجودة.',
  archived: 'هذه المحادثة مؤرشفة؛ افتح محادثة جديدة.',
  scopeChanged: 'تغيّر نطاق المصادر الذي بُنيت عليه هذه المحادثة (حُذف مصدر أو نسخة منه). افتح محادثة جديدة كي لا تُنقل افتراضاتها إلى نطاق آخر.',
  messageNotFound: 'الرسالة المطلوبة غير موجودة.',
  notSavable: 'تُحفظ كملاحظة الإجابات المكتملة فقط (لا المسودات ولا الامتناعات).',
  noteRejected: 'تعذر حفظ الملاحظة.',
};

function threadRow(ctx: AppContext, id: string): ThreadRow {
  const t = ctx.db.get<ThreadRow>('SELECT * FROM contextual_thread WHERE id = ?', [id]);
  if (!t) throw new AppError('NOT_FOUND', MSG.notFound, 404, { thread_id: id });
  return t;
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
  };
}

/**
 * An answer still «draft / verifying» long after any generation could have finished (the server restarted or the
 * request died mid-way) is shown as not completed — never as still being written, and never with content.
 * Model calls time out after 4 minutes and verification batches after 2 minutes each; 30 minutes is far beyond.
 */
const STALE_DRAFT_MS = 30 * 60 * 1000;

function messageView(ctx: AppContext, m: MessageRow): ChatMessageView {
  const detail = fromJson<{ abstain?: AbstainView }>(m.detail_json);
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
  const title = body.title?.trim() || (anchor?.quote?.exact ? `حول: ${shorten(anchor.quote.exact, 60)}` : 'محادثة حول هذه الصفحة');
  ctx.db.run(
    `INSERT INTO contextual_thread (id, source_id, version_id, anchor_json, scope_json, style, title, created_at, updated_at, page_id, socratic, resolved_scope_json, scope_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  );
  return { thread: threadView(ctx, threadRow(ctx, id)), messages: [] };
}

export function listThreads(ctx: AppContext, q: { source_id?: string; page_id?: string; limit?: number }): ChatThreadView[] {
  const where = ['archived_at IS NULL'];
  const params: unknown[] = [];
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

function insertMessage(ctx: AppContext, m: Omit<MessageRow, 'created_at' | 'updated_at'>): void {
  const now = ctx.clock.now();
  ctx.db.run(
    `INSERT INTO message (id, thread_id, role, content_json, status, abstain_reason, artifact_id, created_at, style, reply_to_id, detail_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.thread_id, m.role, m.content_json, m.status, m.abstain_reason, m.artifact_id, now, m.style, m.reply_to_id, m.detail_json, now],
  );
}

function setMessage(ctx: AppContext, id: string, patch: Partial<Pick<MessageRow, 'status' | 'content_json' | 'abstain_reason' | 'artifact_id' | 'detail_json'>>): void {
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

export async function postMessage(ctx: AppContext, threadId: string, body: z.infer<typeof messageCreateSchema>, opts: { signal?: AbortSignal } = {}): Promise<ChatPostResponse> {
  const t = threadRow(ctx, threadId);
  if (t.archived_at) throw new AppError('CONFLICT', MSG.archived, 409);
  const scope = resolveScope(ctx, fromJson<SourceScope>(t.scope_json));
  if (t.scope_hash && scope.hash !== t.scope_hash) throw new AppError('OUT_OF_SCOPE', MSG.scopeChanged, 409, { thread_id: t.id });
  const style = (body.style ?? t.style) as ChatThreadView['style'];
  const anchor = fromJson<SelectionAnchor>(t.anchor_json);
  const rules = resolveRules(ctx, { sourceId: t.source_id, overrides: { socratic: t.socratic === 1 } });
  const realPatient = isRealPatientRequest(body.text);
  if (!realPatient) requireAi(ctx, 'chat');

  // history BEFORE this question (this thread only)
  const history = ctx.db
    .all<MessageRow>(`SELECT * FROM message WHERE thread_id = ? AND status IN ('final','abstained') ORDER BY created_at DESC, id DESC LIMIT 6`, [t.id])
    .reverse();

  const ownerId = newId(ctx.clock.now());
  const answerId = newId(ctx.clock.now());
  ctx.db.tx(() => {
    insertMessage(ctx, { id: ownerId, thread_id: t.id, role: 'owner', content_json: toJson(richTextFromPlain(body.text))!, status: 'final', abstain_reason: null, artifact_id: null, style, reply_to_id: null, detail_json: null });
    insertMessage(ctx, { id: answerId, thread_id: t.id, role: 'assistant', content_json: toJson({ v: 1, paragraphs: [] })!, status: 'draft', abstain_reason: null, artifact_id: null, style, reply_to_id: ownerId, detail_json: null });
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
    params: { thread_id: t.id, message_id: answerId, style, socratic: t.socratic === 1, level: rules.level, language: 'ar' },
    anchor,
  };

  let artifact: StudyArtifactView;
  try {
    if (realPatient) {
      artifact = publishAbstention(ctx, base, realPatientAbstain());
    } else {
      const selection = anchor?.quote?.exact?.trim() ?? '';
      const leading = [];
      if (selection) leading.push({ label: 'SELECTION (text the learner selected in the source)', text: selection.slice(0, 6000) });
      if (history.length) {
        leading.push({
          label: 'CONVERSATION SO FAR (this thread only; answers are generated, NOT evidence)',
          text: history.map((h) => `${h.role === 'owner' ? 'Learner' : 'Previous answer (generated)'}: ${richTextToPlain(fromJson<RichText>(h.content_json)).slice(0, 1500)}`).join('\n\n'),
        });
      }
      const input: SingleShotInput = {
        ...base,
        retrieval: {
          query: [body.text, selection].join(' ').slice(0, 2000),
          anchor: anchor?.region_ids?.length ? { region_ids: anchor.region_ids } : anchor?.page_id ? { page_id: anchor.page_id } : null,
          k: 8,
          purpose: 'lecture_explanation',
        },
        call: {
          task: 'chat',
          style,
          taskText: CHAT_TASK,
          ownerInstruction: body.text,
          socratic: t.socratic === 1,
          leading,
          terms: termsForTexts(ctx, [body.text, selection]),
          signal: opts.signal,
        },
        defaultRegionIds: anchor?.region_ids ?? [],
        onPhase: (phase) => {
          if (phase === 'verifying') setMessage(ctx, answerId, { status: 'verifying' });
        },
      };
      artifact = await generateSingleShot(ctx, input);
    }
  } catch (e) {
    const err = e as { code?: string; messageAr?: string };
    setMessage(ctx, answerId, { status: 'rejected', detail_json: toJson({ error: { code: err.code ?? 'INTERNAL', message: err.messageAr ?? 'تعذر إكمال الإجابة.' } }) });
    throw e;
  }

  const rt = answerRichText(artifact);
  ctx.db.tx(() => {
    setMessage(ctx, answerId, {
      status: artifact.abstain ? 'abstained' : 'final',
      content_json: toJson(rt)!,
      abstain_reason: artifact.abstain?.reason ?? null,
      artifact_id: artifact.id,
      detail_json: toJson({ abstain: artifact.abstain ?? undefined, removed: artifact.removed.length }),
    });
    if (!artifact.abstain) indexMessage(ctx, answerId, rt);
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
