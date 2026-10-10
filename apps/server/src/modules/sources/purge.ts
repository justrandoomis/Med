// Impact preview + permanent purge for library subtrees and sources (§05, §18, §49).
//
// Both work on the same "purge set", materialized into TEMP tables so even very large sources
// (thousands of pages / regions) never hit SQL parameter limits:
//   nodes (subtree) → sources in them (+ explicit sources) → versions → pages / regions → evidence …
//
// Policy (documented in docs/modules/library-sources.md):
//  * DELETED with the purge: the nodes and sources, their versions, pages, regions, chunks, evidence,
//    image/audio assets, artifacts whose primary source is purged (blocks, claims, citations),
//    questions that occur ONLY in purged versions (their versions, options, keys, attempts, links),
//    flashcards made from the purged sources (review events/state), the owner's ink/annotations on
//    the purged pages and note pages, notes inside purged folders or anchored to purged sources,
//    study sessions, threads, progress, tags/topic links of purged entities.
//  * KEPT but UNLINKED: content outside the purge set that cited purged evidence (claims → needs_review,
//    artifacts → stale, a `source_deleted` content alert lists them), questions that also occur in
//    other sources (only the purged occurrences go), sources outside the subtree that pointed at a
//    purged subject/course node.
//  * Every delete happens in ONE transaction. Any other table (e.g. added later by another module)
//    that still references the purge set without ON DELETE CASCADE/SET NULL aborts the purge before
//    anything is deleted. Stored files referenced by nothing else are removed AFTER the commit.
import { rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { PROCESS_JOB_KIND, stableStringify, type ImpactReport } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { safeEqual, sha256 } from '../../lib/hash';
import { newId } from '../../lib/ids';
import { deriveKey, loadOrCreateServerSecret } from '../../lib/secret';
import { pruneAnnotationImages } from '../annotations/images';

/** temp table → id source */
const SETS = [
  'node',
  'source',
  'version',
  'page',
  'region',
  'evidence',
  'artifact',
  'block',
  'claim',
  'question',
  'qversion',
  'qoption',
  'flashcard',
  'note_page',
  'annotation',
  'note',
  'session',
  'thread',
  'image',
  'audio',
  'segment',
] as const;
type PurgeSetName = (typeof SETS)[number];

const T = (s: PurgeSetName) => `temp.purge_${s}`;
const IN = (s: PurgeSetName) => `(SELECT id FROM ${T(s)})`;

/** parent table → purge set holding the ids that will be deleted from it */
const PARENT_SET: Record<string, PurgeSetName> = {
  library_node: 'node',
  source: 'source',
  source_version: 'version',
  source_page: 'page',
  source_region: 'region',
  evidence: 'evidence',
  artifact: 'artifact',
  content_block: 'block',
  claim: 'claim',
  question: 'question',
  question_version: 'qversion',
  question_option: 'qoption',
  flashcard: 'flashcard',
  note_page: 'note_page',
  annotation: 'annotation',
  note: 'note',
  study_session: 'session',
  contextual_thread: 'thread',
  image_asset: 'image',
  audio_asset: 'audio',
  transcript_segment: 'segment',
};

/** Foreign keys (child table.column) this purge deletes/unlinks explicitly. */
const HANDLED_FKS = new Set([
  'library_node.parent_id',
  'source.node_id',
  'source.subject_node_id',
  'source.course_node_id',
  'source_link.from_source_id',
  'source_link.to_source_id',
  'source_version.source_id',
  'source_version.derived_from_version_id',
  'source_page.version_id',
  'source_region.version_id',
  'source_region.page_id',
  'source_region.parent_region_id',
  'document_chunk.version_id',
  'document_chunk.source_id',
  'concept_mention.region_id',
  'concept_mention.version_id',
  'evidence.version_id',
  'evidence.source_id',
  'evidence.page_id',
  'evidence.region_id',
  'artifact.primary_source_id',
  'content_block.artifact_id',
  'citation.evidence_id',
  'artifact_dependency.source_version_id',
  'note_page.node_id',
  'note_page.source_id',
  'note.node_id',
  'image_asset.source_id',
  'image_asset.version_id',
  'image_asset.page_id',
  'image_asset.region_id',
  'image_asset.caption_region_id',
  'media_overlay.image_id',
  'audio_asset.source_id',
  'transcript_segment.audio_id',
  'question.course_node_id',
  'question_version.question_id',
  'question_version.derived_from_version_id',
  'question_option.question_version_id',
  'question_option.region_id',
  'question_occurrence.question_id',
  'question_occurrence.question_version_id',
  'question_occurrence.source_id',
  'question_occurrence.source_version_id',
  'answer_key_entry.source_version_id',
  'answer_key_entry.page_id',
  'answer_key_entry.region_id',
  'answer_key_entry.matched_occurrence_id',
  'answer_evidence.question_version_id',
  'answer_evidence.option_id',
  'answer_evidence.evidence_id',
  'question_lecture_link.question_id',
  'question_lecture_link.lecture_source_id',
  'question_duplicate.question_a_id',
  'question_duplicate.question_b_id',
  'question_attempt.question_id',
  'question_attempt.question_version_id',
  'written_attempt.question_id',
  'written_attempt.question_version_id',
  'review_event.card_id',
  'review_state.card_id',
  'review_reset.card_id',
  'flashcard_impact.card_id',
  'source_progress.source_id',
  'study_session.source_id',
  'study_session.version_id',
  'contextual_thread.source_id',
  'contextual_thread.version_id',
  'message.thread_id',
]);

/** Columns that reference stored_file and are cleared by this purge (collected before deleting). */
const FILE_COLUMNS_SQL = `
  SELECT file_id AS f FROM source_version WHERE id IN ${IN('version')}
  UNION SELECT original_file_id FROM source_version WHERE id IN ${IN('version')}
  UNION SELECT display_file_id FROM source_version WHERE id IN ${IN('version')}
  UNION SELECT thumbnail_file_id FROM source_page WHERE id IN ${IN('page')}
  UNION SELECT render_file_id FROM source_page WHERE id IN ${IN('page')}
  UNION SELECT file_id FROM image_asset WHERE id IN ${IN('image')}
  UNION SELECT file_id FROM audio_asset WHERE id IN ${IN('audio')}`;

export interface PurgeTarget {
  /** root of a library subtree (the node and everything below it) */
  nodeId?: string;
  /** explicit sources (in addition to the sources inside the subtree) */
  sourceIds?: string[];
}

export interface ImpactCounts {
  nodes: number;
  sources: number;
  versions: number;
  pages: number;
  annotations: number;
  notes: number;
  questions: number;
  flashcards: number;
  artifacts: number;
  attempts: number;
  review_events: number;
  /** contextual study conversations about the purged sources (deleted with them) */
  threads: number;
  /** the owner's note pages (paper pages of a notebook / inserted after a source's pages) deleted with it — track F1 */
  note_pages: number;
  /** derived things OUTSIDE the purge set that cite it (kept, marked for review) */
  external_dependents: number;
}

// ───────── Arabic copy ─────────
/** Arabic counted noun with correct agreement for Latin digits (1, 2, 3–10, 11+). */
export function countAr(n: number, forms: { one: string; two: string; few: string; many: string }): string {
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  const mod100 = n % 100;
  if (mod100 >= 3 && mod100 <= 10) return `${n} ${forms.few}`;
  return `${n} ${forms.many}`;
}

const NOUNS = {
  nodes: { one: 'مجلد واحد', two: 'مجلدان', few: 'مجلدات', many: 'مجلدًا' },
  sources: { one: 'مصدر واحد', two: 'مصدران', few: 'مصادر', many: 'مصدرًا' },
  versions: { one: 'نسخة واحدة', two: 'نسختان', few: 'نسخ', many: 'نسخة' },
  pages: { one: 'صفحة واحدة', two: 'صفحتان', few: 'صفحات', many: 'صفحة' },
  annotations: { one: 'تعليق أو كتابة واحدة', two: 'تعليقان', few: 'تعليقات وكتابات', many: 'تعليقًا وكتابة' },
  notes: { one: 'ملاحظة واحدة', two: 'ملاحظتان', few: 'ملاحظات', many: 'ملاحظة' },
  questions: { one: 'سؤال واحد', two: 'سؤالان', few: 'أسئلة', many: 'سؤالًا' },
  attempts: { one: 'محاولة إجابة واحدة', two: 'محاولتا إجابة', few: 'محاولات إجابة', many: 'محاولة إجابة' },
  flashcards: { one: 'بطاقة واحدة', two: 'بطاقتان', few: 'بطاقات', many: 'بطاقة' },
  review_events: { one: 'مراجعة واحدة', two: 'مراجعتان', few: 'مراجعات', many: 'مراجعة' },
  threads: { one: 'محادثة واحدة', two: 'محادثتان', few: 'محادثات', many: 'محادثة' },
  note_pages: { one: 'صفحة ملاحظات واحدة', two: 'صفحتا ملاحظات', few: 'صفحات ملاحظات', many: 'صفحة ملاحظات' },
  artifacts: { one: 'شرح أو ملخص مولَّد واحد', two: 'شرحان أو ملخصان مولَّدان', few: 'شروح وملخصات مولَّدة', many: 'شرحًا وملخصًا مولَّدًا' },
  external_dependents: { one: 'عنصر واحد', two: 'عنصران', few: 'عناصر', many: 'عنصرًا' },
} as const;

export function impactLinesAr(c: ImpactCounts, mode: 'purge' | 'trash'): string[] {
  const lines: string[] = [];
  const verb = mode === 'purge' ? 'سيُحذف نهائيًا' : 'سيُنقل إلى سلة المحذوفات';
  if (c.nodes > 0) {
    const inside = c.nodes === 1 ? 'بداخله' : c.nodes === 2 ? 'بداخلهما' : 'بداخلها';
    lines.push(`${verb}: ${countAr(c.nodes, NOUNS.nodes)} وكل ما ${inside}.`);
  }
  if (c.sources > 0) {
    const parts = [c.versions > 0 ? countAr(c.versions, NOUNS.versions) : null, c.pages > 0 ? countAr(c.pages, NOUNS.pages) : null].filter(Boolean);
    lines.push(`${verb}: ${countAr(c.sources, NOUNS.sources)}${parts.length ? ` (${parts.join('، ')})` : ''}.`);
  }
  if (mode === 'trash') {
    if (c.annotations + c.notes + c.note_pages + c.questions + c.flashcards + c.artifacts + c.threads > 0) {
      lines.push('كتابتك وملاحظاتك وأسئلتك المرتبطة تبقى محفوظة، وتعود كما هي عند الاستعادة.');
    }
    if (lines.length === 0) lines.push('العنصر فارغ.');
    lines.push('لن تستخدم أدوات الدراسة هذا المحتوى ما دام في السلة، ويمكنك استعادته في أي وقت.');
    return lines;
  }
  if (c.annotations > 0) lines.push(`كتابتك بالقلم وتعليقاتك على هذه الصفحات: ${countAr(c.annotations, NOUNS.annotations)}.`);
  if (c.notes > 0) lines.push(`ملاحظاتك داخلها أو المرتبطة بها: ${countAr(c.notes, NOUNS.notes)}.`);
  if (c.note_pages > 0) lines.push(`صفحات ملاحظاتك الورقية (مع ما كتبته وأدرجته عليها): ${countAr(c.note_pages, NOUNS.note_pages)}.`);
  if (c.questions > 0) {
    lines.push(
      `أسئلة لا توجد إلا في هذه المصادر: ${countAr(c.questions, NOUNS.questions)}` +
        (c.attempts > 0 ? `، ومعها ${countAr(c.attempts, NOUNS.attempts)}.` : '.'),
    );
  }
  if (c.flashcards > 0) {
    lines.push(
      `بطاقات مصنوعة من هذه المصادر: ${countAr(c.flashcards, NOUNS.flashcards)}` +
        (c.review_events > 0 ? `، ومعها سجل ${countAr(c.review_events, NOUNS.review_events)}.` : '.'),
    );
  }
  if (c.artifacts > 0) lines.push(`محتوى مولَّد من هذه المصادر: ${countAr(c.artifacts, NOUNS.artifacts)}.`);
  if (c.threads > 0) lines.push(`محادثات الدراسة المرتبطة بهذه المصادر ورسائلها: ${countAr(c.threads, NOUNS.threads)}.`);
  if (c.external_dependents > 0) {
    lines.push(
      `${countAr(c.external_dependents, NOUNS.external_dependents)} خارج هذا العنصر يستشهد بهذه المصادر: لن يُحذف، لكن تُزال روابط الأدلة منه ويُعلَّم للمراجعة.`,
    );
  }
  if (lines.length === 0) lines.push('العنصر فارغ: لا يحتوي على مصادر أو ملاحظات.');
  return lines;
}

// ───────── purge set ─────────
function ensureTempTables(ctx: AppContext): void {
  for (const s of SETS) ctx.db.exec(`CREATE TEMP TABLE IF NOT EXISTS purge_${s} (id TEXT PRIMARY KEY)`);
}

function jsonField(col: string, path: string): string {
  return `(CASE WHEN json_valid(${col}) THEN json_extract(${col}, '${path}') END)`;
}

/** Fill the TEMP purge tables. Must run inside a transaction (the caller's). */
function fillPurgeSet(ctx: AppContext, target: PurgeTarget): void {
  const db = ctx.db;
  ensureTempTables(ctx);
  for (const s of SETS) db.run(`DELETE FROM ${T(s)}`);
  if (target.nodeId) {
    db.run(
      `INSERT INTO ${T('node')} (id)
       WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT n.id FROM library_node n JOIN sub ON n.parent_id = sub.id)
       SELECT id FROM sub`,
      [target.nodeId],
    );
  }
  db.run(`INSERT OR IGNORE INTO ${T('source')} (id) SELECT id FROM source WHERE node_id IN ${IN('node')}`);
  for (const id of target.sourceIds ?? []) db.run(`INSERT OR IGNORE INTO ${T('source')} (id) SELECT id FROM source WHERE id = ?`, [id]);
  db.run(`INSERT INTO ${T('version')} (id) SELECT id FROM source_version WHERE source_id IN ${IN('source')}`);
  db.run(`INSERT INTO ${T('page')} (id) SELECT id FROM source_page WHERE version_id IN ${IN('version')}`);
  db.run(`INSERT INTO ${T('region')} (id) SELECT id FROM source_region WHERE version_id IN ${IN('version')}`);
  db.run(
    `INSERT INTO ${T('evidence')} (id) SELECT id FROM evidence
     WHERE version_id IN ${IN('version')} OR source_id IN ${IN('source')} OR page_id IN ${IN('page')} OR region_id IN ${IN('region')}`,
  );
  db.run(`INSERT INTO ${T('artifact')} (id) SELECT id FROM artifact WHERE primary_source_id IN ${IN('source')}`);
  db.run(`INSERT INTO ${T('block')} (id) SELECT id FROM content_block WHERE artifact_id IN ${IN('artifact')}`);
  db.run(`INSERT INTO ${T('claim')} (id) SELECT id FROM claim WHERE owner_type = 'content_block' AND owner_id IN ${IN('block')}`);
  // questions that occur ONLY in purged versions (a question also found elsewhere survives)
  db.run(
    `INSERT INTO ${T('question')} (id)
     SELECT q.id FROM question q
     WHERE q.origin_type = 'source'
       AND EXISTS (SELECT 1 FROM question_occurrence o WHERE o.question_id = q.id
                   AND (o.source_version_id IN ${IN('version')} OR o.source_id IN ${IN('source')}))
       AND NOT EXISTS (SELECT 1 FROM question_occurrence o WHERE o.question_id = q.id
                   AND o.source_version_id NOT IN ${IN('version')} AND o.source_id NOT IN ${IN('source')})`,
  );
  db.run(`INSERT INTO ${T('qversion')} (id) SELECT id FROM question_version WHERE question_id IN ${IN('question')}`);
  db.run(`INSERT INTO ${T('qoption')} (id) SELECT id FROM question_option WHERE question_version_id IN ${IN('qversion')}`);
  db.run(
    `INSERT INTO ${T('flashcard')} (id) SELECT id FROM flashcard
     WHERE source_id IN ${IN('source')} OR source_version_id IN ${IN('version')}`,
  );
  db.run(
    `INSERT INTO ${T('note_page')} (id) SELECT id FROM note_page WHERE node_id IN ${IN('node')} OR source_id IN ${IN('source')}`,
  );
  db.run(
    `INSERT OR IGNORE INTO ${T('annotation')} (id)
     SELECT annotation_id FROM annotation_target
     WHERE (target_type = 'source_page' AND target_id IN ${IN('page')})
        OR (target_type = 'note_page' AND target_id IN ${IN('note_page')})
        OR (target_type = 'artifact_block' AND instr(target_id, ':') > 0
            AND substr(target_id, 1, instr(target_id, ':') - 1) IN (SELECT lineage_id FROM artifact WHERE id IN ${IN('artifact')}))`,
  );
  db.run(
    `INSERT OR IGNORE INTO ${T('annotation')} (id)
     SELECT id FROM annotation
     WHERE ${jsonField('anchor_json', '$.page_id')} IN ${IN('page')}
        OR ${jsonField('anchor_json', '$.source_id')} IN ${IN('source')}
        OR ${jsonField('anchor_json', '$.version_id')} IN ${IN('version')}
        OR ${jsonField('anchor_json', '$.note_page_id')} IN ${IN('note_page')}`,
  );
  db.run(
    `INSERT INTO ${T('note')} (id) SELECT id FROM note
     WHERE node_id IN ${IN('node')}
        OR ${jsonField('anchor_json', '$.source_id')} IN ${IN('source')}
        OR ${jsonField('anchor_json', '$.page_id')} IN ${IN('page')}
        OR ${jsonField('anchor_json', '$.note_page_id')} IN ${IN('note_page')}`,
  );
  db.run(
    `INSERT INTO ${T('session')} (id) SELECT id FROM study_session WHERE source_id IN ${IN('source')} OR version_id IN ${IN('version')}`,
  );
  db.run(
    `INSERT INTO ${T('thread')} (id) SELECT id FROM contextual_thread WHERE source_id IN ${IN('source')} OR version_id IN ${IN('version')}`,
  );
  db.run(
    `INSERT INTO ${T('image')} (id) SELECT id FROM image_asset
     WHERE source_id IN ${IN('source')} OR version_id IN ${IN('version')} OR page_id IN ${IN('page')}
        OR region_id IN ${IN('region')} OR caption_region_id IN ${IN('region')}`,
  );
  db.run(`INSERT INTO ${T('audio')} (id) SELECT id FROM audio_asset WHERE source_id IN ${IN('source')}`);
  db.run(`INSERT INTO ${T('segment')} (id) SELECT id FROM transcript_segment WHERE audio_id IN ${IN('audio')}`);
}

interface ExternalDependent {
  type: string;
  id: string;
}

/** Derived things outside the purge set that depend on it (they are kept and marked for review). */
function externalDependents(ctx: AppContext): ExternalDependent[] {
  const rows = ctx.db.all<ExternalDependent>(
    `SELECT DISTINCT dependent_type AS type, dependent_id AS id FROM artifact_dependency
     WHERE source_version_id IN ${IN('version')}
       AND NOT (dependent_type = 'artifact' AND dependent_id IN ${IN('artifact')})
       AND NOT (dependent_type = 'question_version' AND dependent_id IN ${IN('qversion')})
       AND NOT (dependent_type = 'flashcard' AND dependent_id IN ${IN('flashcard')})
     UNION
     SELECT DISTINCT 'claim', c.claim_id FROM citation c
     WHERE c.evidence_id IN ${IN('evidence')} AND c.claim_id NOT IN ${IN('claim')}
     UNION
     SELECT DISTINCT 'question_version', ae.question_version_id FROM answer_evidence ae
     WHERE ae.evidence_id IN ${IN('evidence')} AND ae.question_version_id NOT IN ${IN('qversion')}
     UNION
     SELECT DISTINCT 'question_version', qv.id FROM question_version qv
     WHERE qv.derived_from_version_id IN ${IN('qversion')} AND qv.id NOT IN ${IN('qversion')}`,
  );
  return rows;
}

function count(ctx: AppContext, sql: string): number {
  return ctx.db.get<{ n: number }>(sql)?.n ?? 0;
}

function computeCounts(ctx: AppContext): ImpactCounts {
  return {
    nodes: count(ctx, `SELECT COUNT(*) AS n FROM ${T('node')}`),
    sources: count(ctx, `SELECT COUNT(*) AS n FROM ${T('source')}`),
    versions: count(ctx, `SELECT COUNT(*) AS n FROM ${T('version')}`),
    pages: count(ctx, `SELECT COUNT(*) AS n FROM ${T('page')}`),
    annotations: count(ctx, `SELECT COUNT(*) AS n FROM annotation WHERE id IN ${IN('annotation')} AND deleted_at IS NULL`),
    notes: count(ctx, `SELECT COUNT(*) AS n FROM note WHERE id IN ${IN('note')} AND deleted_at IS NULL`),
    questions: count(ctx, `SELECT COUNT(*) AS n FROM ${T('question')}`),
    flashcards: count(ctx, `SELECT COUNT(*) AS n FROM flashcard WHERE id IN ${IN('flashcard')} AND deleted_at IS NULL`),
    artifacts: count(ctx, `SELECT COUNT(DISTINCT lineage_id) AS n FROM artifact WHERE id IN ${IN('artifact')}`),
    attempts:
      count(ctx, `SELECT COUNT(*) AS n FROM question_attempt WHERE question_id IN ${IN('question')}`) +
      count(ctx, `SELECT COUNT(*) AS n FROM written_attempt WHERE question_id IN ${IN('question')}`),
    review_events: count(ctx, `SELECT COUNT(*) AS n FROM review_event WHERE card_id IN ${IN('flashcard')}`),
    threads: count(ctx, `SELECT COUNT(*) AS n FROM ${T('thread')}`),
    note_pages: count(ctx, `SELECT COUNT(*) AS n FROM note_page WHERE id IN ${IN('note_page')} AND deleted_at IS NULL`),
    external_dependents: externalDependents(ctx).length,
  };
}

// ───────── confirm token ─────────
const TOKEN_TTL_MS = 15 * 60 * 1000;
let tokenKeyCache: { dir: string; key: Buffer } | null = null;

function tokenKey(ctx: AppContext): Buffer {
  if (!tokenKeyCache || tokenKeyCache.dir !== ctx.config.dataDir) {
    tokenKeyCache = { dir: ctx.config.dataDir, key: deriveKey(loadOrCreateServerSecret(ctx.config.dataDir), 'purge-confirm') };
  }
  return tokenKeyCache.key;
}

export type PurgeKind = 'library_node' | 'source';

function fingerprint(counts: ImpactCounts): string {
  return sha256(stableStringify(counts)).slice(0, 32);
}

export function createConfirmToken(ctx: AppContext, kind: PurgeKind, id: string, counts: ImpactCounts): string {
  const payload = Buffer.from(JSON.stringify({ k: kind, i: id, e: ctx.clock.now() + TOKEN_TTL_MS, f: fingerprint(counts) })).toString('base64url');
  const sig = createHmac('sha256', tokenKey(ctx)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

const TOKEN_INVALID_AR = 'رمز التأكيد غير صالح أو انتهت صلاحيته. اعرض أثر الحذف من جديد ثم أكّد.';

/** Verifies the token and that the impact has not changed since it was shown. Throws AppError. */
export function verifyConfirmToken(ctx: AppContext, kind: PurgeKind, id: string, token: string | undefined, counts: ImpactCounts): void {
  if (!token || token.length > 1024) throw new AppError('BAD_REQUEST', 'الحذف النهائي يتطلب تأكيدًا: اعرض أثر الحذف أولًا ثم أكّد.', 400);
  const dot = token.indexOf('.');
  const payload = dot > 0 ? token.slice(0, dot) : '';
  const sig = dot > 0 ? token.slice(dot + 1) : '';
  const expected = createHmac('sha256', tokenKey(ctx)).update(payload).digest('base64url');
  if (!payload || !safeEqual(sig, expected)) throw new AppError('BAD_REQUEST', TOKEN_INVALID_AR, 400);
  let data: { k?: unknown; i?: unknown; e?: unknown; f?: unknown };
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('BAD_REQUEST', TOKEN_INVALID_AR, 400);
  }
  if (data.k !== kind || data.i !== id || typeof data.e !== 'number' || ctx.clock.now() > data.e) {
    throw new AppError('BAD_REQUEST', TOKEN_INVALID_AR, 400);
  }
  if (data.f !== fingerprint(counts)) {
    throw new AppError('CONFLICT', 'تغيّر محتوى هذا العنصر منذ عرض أثر الحذف. راجع الأثر الجديد ثم أكّد مرة أخرى.', 409);
  }
}

// ───────── public API ─────────
/** Impact counts for a subtree / sources. Read-only (runs in its own transaction to see a consistent snapshot). */
export function computeImpact(ctx: AppContext, target: PurgeTarget): ImpactCounts {
  return ctx.db.tx(() => {
    fillPurgeSet(ctx, target);
    const c = computeCounts(ctx);
    for (const s of SETS) ctx.db.run(`DELETE FROM ${T(s)}`);
    return c;
  });
}

export function buildImpactReport(ctx: AppContext, kind: PurgeKind, id: string, target: PurgeTarget, mode: 'purge' | 'trash'): ImpactReport {
  const c = computeImpact(ctx, target);
  const report: ImpactReport = {
    nodes: c.nodes,
    sources: c.sources,
    versions: c.versions,
    pages: c.pages,
    annotations: c.annotations,
    notes: c.notes,
    questions: c.questions,
    flashcards: c.flashcards,
    artifacts: c.artifacts,
    lines_ar: impactLinesAr(c, mode),
  };
  if (mode === 'purge') report.confirm_token = createConfirmToken(ctx, kind, id, c);
  return report;
}

interface FkRow {
  tbl: string;
  col: string;
  parent: string;
  on_delete: string;
}

function foreignKeys(ctx: AppContext): FkRow[] {
  return ctx.db.all<FkRow>(
    `SELECT m.name AS tbl, p."from" AS col, p."table" AS parent, p.on_delete AS on_delete
     FROM sqlite_master m, pragma_foreign_key_list(m.name) p
     WHERE m.type = 'table'`,
  );
}

/** Any FK into the purge set that this purge does not handle (e.g. a table added later) blocks the purge. */
function assertNoUnhandledReferences(ctx: AppContext): void {
  for (const fk of foreignKeys(ctx)) {
    const set = PARENT_SET[fk.parent];
    if (!set) continue;
    if (HANDLED_FKS.has(`${fk.tbl}.${fk.col}`)) continue;
    if (['CASCADE', 'SET NULL', 'SET DEFAULT'].includes(fk.on_delete.toUpperCase())) continue;
    const hit = ctx.db.get(`SELECT 1 AS x FROM "${fk.tbl}" WHERE "${fk.col}" IN ${IN(set)} LIMIT 1`);
    if (hit) {
      throw new AppError(
        'CONFLICT',
        `تعذّر الحذف النهائي: بيانات أخرى (${fk.tbl}) ما زالت مرتبطة بهذا المحتوى ولا يعرف هذا الإصدار كيف يحذفها بأمان. لم يُحذف أي شيء.`,
        409,
        { table: fk.tbl, column: fk.col },
      );
    }
  }
}

export interface PurgeResult {
  counts: ImpactCounts;
  removedFiles: number;
}

/**
 * Permanently delete the purge set in ONE transaction (verifying the confirm token against the
 * current impact inside it), then remove stored files nothing references any more.
 */
export function executePurge(
  ctx: AppContext,
  kind: PurgeKind,
  id: string,
  target: PurgeTarget,
  token: string | undefined,
  audit: { summary: string; before: unknown },
): PurgeResult {
  const db = ctx.db;
  const now = ctx.clock.now();
  const { counts, fileIds, versionIds } = db.tx(() => {
    fillPurgeSet(ctx, target);
    const counts = computeCounts(ctx);
    verifyConfirmToken(ctx, kind, id, token, counts);
    assertNoUnhandledReferences(ctx);

    const fileIds = db.all<{ f: string | null }>(FILE_COLUMNS_SQL).map((r) => r.f).filter((f): f is string => !!f);
    const versionIds = db.all<{ id: string }>(`SELECT id FROM ${T('version')}`).map((r) => r.id);

    // ids to announce to sync clients (entity → null = deleted)
    const touches: Array<[string, string]> = [];
    const collect = (type: string, sql: string) => {
      for (const r of db.all<{ id: string }>(sql)) touches.push([type, r.id]);
    };
    collect('annotation', `SELECT id FROM ${T('annotation')}`);
    collect('note', `SELECT id FROM ${T('note')}`);
    collect('note_page', `SELECT id FROM ${T('note_page')}`);
    collect('flashcard', `SELECT id FROM ${T('flashcard')}`);
    collect('study_session', `SELECT id FROM ${T('session')}`);
    collect('review_event', `SELECT id FROM review_event WHERE card_id IN ${IN('flashcard')}`);
    collect('question_attempt', `SELECT id FROM question_attempt WHERE question_id IN ${IN('question')}`);

    // derived content outside the purge set: keep, unlink, flag (§18)
    const external = externalDependents(ctx);
    db.run(
      `UPDATE claim SET verification_status = 'needs_review', updated_at = ?
       WHERE id IN (SELECT claim_id FROM citation WHERE evidence_id IN ${IN('evidence')}) AND id NOT IN ${IN('claim')}`,
      [now],
    );
    db.run(
      `UPDATE artifact SET status = 'stale', stale_reason = ?, updated_at = ?
       WHERE id IN (SELECT dependent_id FROM artifact_dependency WHERE dependent_type = 'artifact' AND source_version_id IN ${IN('version')})
         AND id NOT IN ${IN('artifact')} AND status NOT IN ('superseded', 'failed')`,
      ['حُذف مصدر يعتمد عليه هذا المحتوى نهائيًا.', now],
    );

    // evidence graph
    db.run(`DELETE FROM verification_result WHERE subject_type = 'claim' AND subject_id IN ${IN('claim')}`);
    db.run(`DELETE FROM citation WHERE evidence_id IN ${IN('evidence')} OR claim_id IN ${IN('claim')}`);
    db.run(`UPDATE concept SET definition_claim_id = NULL WHERE definition_claim_id IN ${IN('claim')}`);
    db.run(`DELETE FROM claim WHERE id IN ${IN('claim')}`);
    db.run(`DELETE FROM answer_evidence WHERE evidence_id IN ${IN('evidence')} OR question_version_id IN ${IN('qversion')}`);
    // flashcards outside the purge set: drop references to purged evidence (no dangling citations)
    const purgedEvidence = new Set(db.all<{ id: string }>(`SELECT id FROM ${T('evidence')}`).map((r) => r.id));
    for (const fc of purgedEvidence.size === 0
      ? []
      : db.all<{ id: string; evidence_ids_json: string }>(
          `SELECT id, evidence_ids_json FROM flashcard WHERE id NOT IN ${IN('flashcard')} AND evidence_ids_json <> '[]'`,
        )) {
      let ids: unknown;
      try {
        ids = JSON.parse(fc.evidence_ids_json);
      } catch {
        continue;
      }
      if (!Array.isArray(ids)) continue;
      const purged = purgedEvidence;
      const kept = ids.filter((e) => typeof e === 'string' && !purged.has(e));
      if (kept.length !== ids.length) {
        db.run('UPDATE flashcard SET evidence_ids_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(kept), now, fc.id]);
        touches.push(['flashcard', fc.id]);
      }
    }
    db.run(`DELETE FROM evidence WHERE id IN ${IN('evidence')}`);

    // threads, artifacts
    db.run(`DELETE FROM message WHERE thread_id IN ${IN('thread')}`);
    db.run(`DELETE FROM contextual_thread WHERE id IN ${IN('thread')}`);
    db.run(`DELETE FROM content_block WHERE artifact_id IN ${IN('artifact')}`);
    db.run(`DELETE FROM artifact_dependency WHERE source_version_id IN ${IN('version')} OR (dependent_type = 'artifact' AND dependent_id IN ${IN('artifact')})`);
    db.run(`DELETE FROM artifact WHERE id IN ${IN('artifact')}`);
    db.run(`DELETE FROM concept_mention WHERE version_id IN ${IN('version')} OR region_id IN ${IN('region')}`);

    // media
    db.run(`DELETE FROM media_overlay WHERE image_id IN ${IN('image')}`);
    db.run(`DELETE FROM image_asset WHERE id IN ${IN('image')}`);
    db.run(
      `DELETE FROM media_region_link WHERE to_region_id IN ${IN('region')} OR to_page_id IN ${IN('page')}
         OR (from_type = 'transcript_segment' AND from_id IN ${IN('segment')})
         OR (from_type = 'annotation' AND from_id IN ${IN('annotation')})`,
    );
    db.run(`DELETE FROM transcript_segment WHERE id IN ${IN('segment')}`);
    db.run(`DELETE FROM audio_asset WHERE id IN ${IN('audio')}`);

    // questions
    db.run(
      `UPDATE answer_key_entry SET matched_occurrence_id = NULL
       WHERE source_version_id NOT IN ${IN('version')}
         AND matched_occurrence_id IN (SELECT id FROM question_occurrence WHERE source_version_id IN ${IN('version')} OR source_id IN ${IN('source')})`,
    );
    db.run(`DELETE FROM answer_key_entry WHERE source_version_id IN ${IN('version')}`);
    db.run(`DELETE FROM question_occurrence WHERE source_version_id IN ${IN('version')} OR source_id IN ${IN('source')} OR question_id IN ${IN('question')}`);
    db.run(`UPDATE question_option SET region_id = NULL WHERE region_id IN ${IN('region')} AND id NOT IN ${IN('qoption')}`);
    db.run(`DELETE FROM question_attempt WHERE question_id IN ${IN('question')}`);
    db.run(`DELETE FROM written_attempt WHERE question_id IN ${IN('question')}`);
    db.run(`DELETE FROM question_lecture_link WHERE question_id IN ${IN('question')} OR lecture_source_id IN ${IN('source')}`);
    db.run(`DELETE FROM question_duplicate WHERE question_a_id IN ${IN('question')} OR question_b_id IN ${IN('question')}`);
    db.run(`DELETE FROM question_fts WHERE question_id IN ${IN('question')}`);
    db.run(`DELETE FROM question_option WHERE id IN ${IN('qoption')}`);
    // a question version OUTSIDE the purge set (e.g. a generated variant) that was derived from a purged
    // one keeps existing; only its lineage pointer goes (otherwise the FK would abort the whole purge)
    db.run(
      `UPDATE question_version SET derived_from_version_id = NULL
       WHERE derived_from_version_id IN ${IN('qversion')} AND id NOT IN ${IN('qversion')}`,
    );
    db.run(`DELETE FROM question_version WHERE id IN ${IN('qversion')}`);
    db.run(`DELETE FROM question WHERE id IN ${IN('question')}`);
    db.run(`UPDATE question SET course_node_id = NULL, updated_at = ? WHERE course_node_id IN ${IN('node')}`, [now]);

    // learning + owner writing tied to the purged content
    db.run(`DELETE FROM review_event WHERE card_id IN ${IN('flashcard')}`);
    db.run(`DELETE FROM review_reset WHERE card_id IN ${IN('flashcard')}`);
    db.run(`DELETE FROM flashcard_impact WHERE card_id IN ${IN('flashcard')}`);
    db.run(`DELETE FROM review_state WHERE card_id IN ${IN('flashcard')}`);
    db.run(`DELETE FROM flashcard WHERE id IN ${IN('flashcard')}`);
    db.run(`DELETE FROM annotation WHERE id IN ${IN('annotation')}`); // annotation_target cascades
    db.run(`DELETE FROM note WHERE id IN ${IN('note')}`);
    db.run(`DELETE FROM note_page WHERE id IN ${IN('note_page')}`);
    db.run(`DELETE FROM study_session WHERE id IN ${IN('session')}`);
    db.run(`DELETE FROM source_progress WHERE source_id IN ${IN('source')}`);
    db.run(
      `DELETE FROM owner_content_fts WHERE (entity_type = 'note' AND entity_id IN ${IN('note')})
         OR (entity_type = 'flashcard' AND entity_id IN ${IN('flashcard')})
         OR (entity_type = 'transcript_segment' AND entity_id IN ${IN('segment')})
         OR (entity_type = 'annotation' AND entity_id IN ${IN('annotation')})`,
    );
    db.run(
      `DELETE FROM review_queue_item WHERE source_id IN ${IN('source')}
         OR (entity_type = 'source' AND entity_id IN ${IN('source')})
         OR (entity_type = 'source_version' AND entity_id IN ${IN('version')})
         OR (entity_type = 'source_page' AND entity_id IN ${IN('page')})
         OR (entity_type = 'source_region' AND entity_id IN ${IN('region')})
         OR (entity_type = 'question' AND entity_id IN ${IN('question')})
         OR (entity_type = 'question_version' AND entity_id IN ${IN('qversion')})
         OR (entity_type = 'annotation' AND entity_id IN ${IN('annotation')})`,
    );
    for (const [entityType, set] of [
      ['library_node', 'node'],
      ['source', 'source'],
      ['question', 'question'],
      ['flashcard', 'flashcard'],
      ['note', 'note'],
    ] as const) {
      db.run(`DELETE FROM tag_link WHERE entity_type = ? AND entity_id IN ${IN(set)}`, [entityType]);
      db.run(`DELETE FROM topic_link WHERE entity_type = ? AND entity_id IN ${IN(set)}`, [entityType]);
    }

    // the source registry itself
    db.run(`DELETE FROM document_chunk WHERE version_id IN ${IN('version')} OR source_id IN ${IN('source')}`);
    db.run(`DELETE FROM source_region WHERE id IN ${IN('region')}`);
    db.run(`DELETE FROM source_page WHERE id IN ${IN('page')}`);
    db.run(`DELETE FROM source_link WHERE from_source_id IN ${IN('source')} OR to_source_id IN ${IN('source')}`);
    db.run(`UPDATE source_version SET derived_from_version_id = NULL WHERE derived_from_version_id IN ${IN('version')} AND id NOT IN ${IN('version')}`);
    db.run(`DELETE FROM source_version WHERE id IN ${IN('version')}`);
    db.run(`UPDATE source SET subject_node_id = NULL WHERE subject_node_id IN ${IN('node')} AND id NOT IN ${IN('source')}`);
    db.run(`UPDATE source SET course_node_id = NULL WHERE course_node_id IN ${IN('node')} AND id NOT IN ${IN('source')}`);
    db.run(`DELETE FROM content_alert WHERE source_id IN ${IN('source')} OR source_version_id IN ${IN('version')}`);
    db.run(`DELETE FROM source WHERE id IN ${IN('source')}`);
    db.run(`DELETE FROM library_node WHERE id IN ${IN('node')}`);

    if (external.length > 0) {
      db.run(
        `INSERT INTO content_alert (id, kind, severity, source_id, source_version_id, summary, affected_json, status, created_at)
         VALUES (?, 'source_deleted', 'fact_change', ?, NULL, ?, ?, 'open', ?)`,
        [
          newId(now),
          kind === 'source' ? id : null,
          `حُذف نهائيًا: ${audit.summary}. أُزيلت روابط الأدلة من ${countAr(external.length, NOUNS.external_dependents)} يعتمد عليه، وتحتاج مراجعة.`,
          JSON.stringify(external.map((d) => ({ type: d.type, id: d.id, impact: 'needs_review' }))),
          now,
        ],
      );
    }

    for (const [type, entityId] of touches) ctx.sync.touch(type, entityId);
    ctx.audit.record({
      entityType: kind,
      entityId: id,
      action: 'purge',
      summary: `حذف نهائي: ${audit.summary}`,
      before: audit.before,
      after: { counts },
    });
    for (const s of SETS) db.run(`DELETE FROM ${T(s)}`);
    return { counts, fileIds: [...new Set(fileIds)], versionIds };
  });

  cancelProcessingOf(ctx, versionIds);
  let removedFiles = 0;
  for (const f of fileIds) if (removeStoredFileIfUnreferenced(ctx, f)) removedFiles++;
  // pictures placed on the purged pages (image annotations, annotations module): removed once no other page shows them
  try {
    pruneAnnotationImages(ctx);
  } catch (e) {
    ctx.log.warn({ err: e }, 'could not prune annotation images after a purge');
  }
  return { counts, removedFiles };
}

/**
 * Processing jobs of versions that no longer exist would otherwise stay queued and later end as
 * «failed» (version not found) in the owner's job list. They are cancelled right after the purge.
 */
function cancelProcessingOf(ctx: AppContext, versionIds: readonly string[]): void {
  if (versionIds.length === 0) return;
  const jobs = ctx.db.all<{ id: string }>(
    `SELECT id FROM processing_job
     WHERE kind = ? AND status IN ('queued', 'running', 'waiting_for_input') AND json_valid(input_json)
       AND json_extract(input_json, '$.version_id') IN (SELECT value FROM json_each(?))`,
    [PROCESS_JOB_KIND, JSON.stringify(versionIds)],
  );
  for (const j of jobs) {
    try {
      ctx.jobs.cancel(j.id);
    } catch (e) {
      ctx.log.warn({ err: e, jobId: j.id }, 'could not cancel processing of a purged version');
    }
  }
}

/**
 * Delete a stored_file row + its blob when NO table references it any more (checked through every
 * foreign key into stored_file, so tables added by other modules are covered). Runs after commit.
 */
export function removeStoredFileIfUnreferenced(ctx: AppContext, fileId: string): boolean {
  const refs = foreignKeys(ctx).filter((fk) => fk.parent === 'stored_file');
  let path: string | null = null;
  const removed = ctx.db.tx(() => {
    for (const fk of refs) {
      if (ctx.db.get(`SELECT 1 AS x FROM "${fk.tbl}" WHERE "${fk.col}" = ? LIMIT 1`, [fileId])) return false;
    }
    const file = ctx.files.stat(fileId);
    if (!file) return false;
    path = ctx.files.path(fileId);
    ctx.db.run('DELETE FROM stored_file WHERE id = ?', [fileId]);
    return true;
  });
  if (removed && path) {
    try {
      rmSync(path, { force: true });
    } catch (e) {
      ctx.log.warn({ err: e, fileId }, 'could not remove purged blob');
    }
  }
  return removed;
}
