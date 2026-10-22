// Corrections of official lectures (P1-T5 step 1; ARCHITECTURE_DELTA §6.7; PRD AOS-18.9; review W2-step0 N1).
//
// Today's owner corrections (control/corrections.ts) rewrite an uncited region in place — unusable for official text:
// the citations and pins of other people live in their vaults, out of reach. So:
//   * the regions of a PUBLISHED official version are immutable: a moderator's correction of the HEAD version creates
//     version n+1 (kind 'owner_correction', `derived_from_version_id` = the corrected one) by a job that copies the
//     version's pages and regions with deterministic ids, applies the corrected text (origin 'owner'), rebuilds that
//     version's search chunks and publishes it through the normal flow (page map from the previous head, updates feed);
//   * a DRAFT version (never published) is corrected in place;
//   * a contributor's correction is a proposal (`official_correction.status = 'open'`) in the moderators' queue;
//     accepting it applies it as above, rejecting it changes nothing.
import { stripBidiControls, type OfficialCorrectionRequest, type OfficialCorrectionResponse, type OfficialCorrectionStatus, type OfficialCorrectionView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { buildChunks, writeChunks } from '../processing/chunks';
import { type LecturesService } from './service';
import { derivedId, getLecture, lectureResource, type LectureRow, notFound, publishOf, type SpaceScope, versionOf, ViewBuilder, visibleLecture, visibleVersion } from './store';

export const OFFICIAL_CORRECTION_JOB = 'official_correction';

interface CorrectionRow {
  id: string;
  lecture_id: string;
  version_id: string;
  items_json: string;
  note: string | null;
  proposed_by: string;
  status: OfficialCorrectionStatus;
  result_version_id: string | null;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}
type Item = { region_id: string; text: string };

const AR = {
  notHead: 'صحّح الإصدار الحالي المنشور من المحاضرة؛ الإصدارات السابقة لا تتغير.',
  processing: 'تجري معالجة هذا الإصدار الآن؛ صحّحه بعد انتهائها.',
  closed: 'أُغلق هذا الاقتراح من قبل.',
  headMoved: 'صدر إصدار أحدث منذ هذا الاقتراح؛ اطلب اقتراحه على الإصدار الحالي.',
  takenDown: 'سُحبت ملفات هذه المحاضرة بطلب صاحب الحقوق؛ لا يمكن تصحيح نصها.',
};

/** Corrected text: logical order, no bidi controls (AC-20), no invisible control characters, NFC. */
function clean(text: string): string {
  return stripBidiControls(text)
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- corrected text keeps newline and tab only
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .normalize('NFC')
    .trim();
}

function processingRunning(ctx: AppContext, versionId: string): boolean {
  return !!ctx.db.get(`SELECT 1 AS x FROM processing_job WHERE kind = 'process_source_version' AND status IN ('queued','running') AND json_extract(input_json, '$.version_id') = ? LIMIT 1`, [versionId]);
}

/** Every region of the request must belong to `versionId` (404 otherwise: another version's ids never leak). */
function checkRegions(ctx: AppContext, versionId: string, items: readonly Item[]): void {
  for (const it of items) {
    const r = ctx.db.get<{ version_id: string }>('SELECT version_id FROM source_region WHERE id = ?', [it.region_id]);
    if (!r || r.version_id !== versionId) throw notFound();
  }
}

/** Apply corrected text to regions of a version (in place) and rebuild its search chunks. Inside a transaction. */
function applyInPlace(ctx: AppContext, versionId: string, sourceId: string, items: readonly Item[], regionMap?: Map<string, string>): void {
  const now = ctx.clock.now();
  for (const it of items) {
    const id = regionMap?.get(it.region_id) ?? it.region_id;
    ctx.db.run(`UPDATE source_region SET text = ?, text_origin = 'owner', status = 'owner_reviewed', updated_at = ? WHERE id = ? AND version_id = ?`, [clean(it.text) || null, now, id, versionId]);
  }
  writeChunks(ctx, versionId, sourceId, buildChunks(ctx, versionId));
}

const columnsOf = (ctx: AppContext, table: string) => ctx.db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);

/**
 * Copy a published version into a new version (deterministic ids from the correction id — a retried job finds the copy
 * already there, in ONE transaction with the rest). Pages, regions, figure assets and the DOCX rendition are copied;
 * files are shared (same stored_file rows: the bytes did not change). Returns the new version id and the region map.
 */
function copyVersion(ctx: AppContext, fromId: string, newVersionId: string): Map<string, string> {
  const from = ctx.db.get<Record<string, unknown>>('SELECT * FROM source_version WHERE id = ?', [fromId])!;
  const no = (ctx.db.get<{ m: number }>('SELECT MAX(version_no) AS m FROM source_version WHERE source_id = ?', [from.source_id as string])?.m ?? 0) + 1;
  const now = ctx.clock.now();
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    ctx.db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] as string | number | null));
  };
  insert('source_version', { ...from, id: newVersionId, version_no: no, kind: 'owner_correction', derived_from_version_id: fromId, created_at: now });
  const pageMap = new Map<string, string>();
  for (const p of ctx.db.all<Record<string, unknown>>('SELECT * FROM source_page WHERE version_id = ? ORDER BY page_index', [fromId])) {
    const id = derivedId('ocp', p.id as string, newVersionId);
    pageMap.set(p.id as string, id);
    insert('source_page', { ...p, id, version_id: newVersionId, created_at: now, updated_at: now });
  }
  const regions = ctx.db.all<Record<string, unknown>>('SELECT * FROM source_region WHERE version_id = ?', [fromId]);
  const regionMap = new Map<string, string>(regions.map((r) => [r.id as string, derivedId('ocr', r.id as string, newVersionId)]));
  // parents before children (a region's parent_region_id must exist when it is inserted)
  const done = new Set<string>();
  const byId = new Map(regions.map((r) => [r.id as string, r]));
  const put = (r: Record<string, unknown>) => {
    const id = r.id as string;
    if (done.has(id)) return;
    const parent = r.parent_region_id as string | null;
    if (parent && byId.has(parent)) put(byId.get(parent)!);
    insert('source_region', {
      ...r,
      id: regionMap.get(id)!,
      version_id: newVersionId,
      page_id: r.page_id ? pageMap.get(r.page_id as string) ?? null : null,
      parent_region_id: parent ? regionMap.get(parent) ?? null : null,
      created_at: now,
      updated_at: now,
    });
    done.add(id);
  };
  for (const r of regions) put(r);
  const assetCols = columnsOf(ctx, 'image_asset');
  for (const a of ctx.db.all<Record<string, unknown>>('SELECT * FROM image_asset WHERE version_id = ?', [fromId])) {
    const row: Record<string, unknown> = { ...a, id: derivedId('oci', a.id as string, newVersionId), version_id: newVersionId };
    if (assetCols.includes('page_id')) row.page_id = a.page_id ? pageMap.get(a.page_id as string) ?? null : null;
    if (assetCols.includes('region_id')) row.region_id = a.region_id ? regionMap.get(a.region_id as string) ?? null : null;
    if (assetCols.includes('caption_region_id')) row.caption_region_id = a.caption_region_id ? regionMap.get(a.caption_region_id as string) ?? null : null;
    insert('image_asset', row);
  }
  for (const r of ctx.db.all<Record<string, unknown>>('SELECT * FROM version_rendition WHERE version_id = ?', [fromId])) insert('version_rendition', { ...r, version_id: newVersionId });
  return regionMap;
}

export class CorrectionsService {
  constructor(
    private readonly ctx: AppContext,
    private readonly lectures: LecturesService,
  ) {}

  private row(id: string): CorrectionRow | null {
    return this.ctx.db.get<CorrectionRow>('SELECT * FROM official_correction WHERE id = ?', [id]) ?? null;
  }

  private insert(c: { lectureId: string; versionId: string; items: Item[]; note: string | null; by: string; status: OfficialCorrectionStatus; resultVersionId?: string | null; decidedBy?: string | null }): string {
    const now = this.ctx.clock.now();
    const id = newId(now);
    this.ctx.db.run(
      `INSERT INTO official_correction (id, lecture_id, version_id, items_json, note, proposed_by, status, result_version_id, decided_by, decided_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, c.lectureId, c.versionId, toJson(c.items), c.note, c.by, c.status, c.resultVersionId ?? null, c.decidedBy ?? null, c.decidedBy ? now : null, now, now],
    );
    return id;
  }

  /** POST /lectures/:id/corrections */
  request(scope: SpaceScope, lectureId: string, body: OfficialCorrectionRequest): OfficialCorrectionResponse {
    const { ctx } = this;
    const lecture = visibleLecture(ctx, scope, lectureId);
    const res = lectureResource(scope, lecture);
    const canEdit = ctx.authz.can(scope.viewer, 'edit', res).allowed;
    if (!canEdit) ctx.authz.assert(scope.viewer, 'suggest', res); // 403 for a student, 404 for what cannot be seen
    // a draft version is seen by the moderators and the lecture's uploader only (404 for anyone else)
    const v = visibleVersion(ctx, scope, lecture, body.version_id);
    if (lecture.takedown_at) throw new AppError('CONFLICT', AR.takenDown, 409);
    const published = publishOf(ctx, v.id);
    checkRegions(ctx, v.id, body.items);
    const items: Item[] = body.items.map((i) => ({ region_id: i.region_id, text: i.text }));
    const note = body.note ?? null;
    if (!canEdit) {
      const id = ctx.db.tx(() => {
        const cid = this.insert({ lectureId, versionId: v.id, items, note, by: scope.viewer.userId, status: 'open' });
        ctx.audit.record({ entityType: 'official_correction', entityId: cid, action: 'propose', summary: `اقتراح تصحيح في «${lecture.title}»`, after: { version_id: v.id, regions: items.length } });
        return cid;
      });
      return { version_id: null, created_new_version: false, review_item_id: id };
    }
    if (!published) {
      if (processingRunning(ctx, v.id)) throw new AppError('CONFLICT', AR.processing, 409);
      ctx.db.tx(() => {
        applyInPlace(ctx, v.id, lecture.source_id, items);
        this.insert({ lectureId, versionId: v.id, items, note, by: scope.viewer.userId, status: 'applied', resultVersionId: v.id, decidedBy: scope.viewer.userId });
        ctx.audit.record({ entityType: 'official_lecture', entityId: lectureId, action: 'correct_draft', summary: `تصحيح مسودة «${lecture.title}»`, after: { version_id: v.id, regions: items.length } });
      });
      return { version_id: v.id, created_new_version: false, review_item_id: null };
    }
    if (lecture.head_version_id !== v.id) throw new AppError('CONFLICT', AR.notHead, 409);
    const cid = ctx.db.tx(() => this.insert({ lectureId, versionId: v.id, items, note, by: scope.viewer.userId, status: 'queued', decidedBy: scope.viewer.userId }));
    this.enqueue(cid);
    return { version_id: derivedId('ocv', cid), created_new_version: true, review_item_id: null };
  }

  private enqueue(correctionId: string): void {
    this.ctx.jobs.enqueue(OFFICIAL_CORRECTION_JOB, { correction_id: correctionId }, { idempotencyKey: `${OFFICIAL_CORRECTION_JOB}:${correctionId}` });
  }

  /** GET /subject/corrections — the official moderators' queue. */
  list(scope: SpaceScope, q: { status?: OfficialCorrectionStatus; lecture_id?: string }): OfficialCorrectionView[] {
    if (!scope.powers.officialModerator) throw new AppError('FORBIDDEN', 'قائمة التصحيحات لمشرفي المادة فقط.', 403);
    const where: string[] = [];
    const params: string[] = [];
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    if (q.lecture_id) {
      where.push('lecture_id = ?');
      params.push(q.lecture_id);
    }
    const rows = this.ctx.db.all<CorrectionRow>(`SELECT * FROM official_correction ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT 200`, params);
    const views = new ViewBuilder(this.ctx, scope);
    views.preload(rows.flatMap((r) => [r.proposed_by, r.decided_by]));
    return rows.map((r) => this.view(views, r));
  }

  private view(views: ViewBuilder, r: CorrectionRow): OfficialCorrectionView {
    const lecture = getLecture(this.ctx, r.lecture_id);
    const v = versionOf(this.ctx, r.version_id);
    const items = fromJson<Item[]>(r.items_json) ?? [];
    return {
      id: r.id,
      lecture: { id: r.lecture_id, title: lecture?.title ?? '' },
      version: { id: r.version_id, version_no: v?.version_no ?? 0 },
      items: items.map((it) => {
        const reg = this.ctx.db.get<{ text: string | null; page_index: number | null }>(
          'SELECT r.text, p.page_index FROM source_region r LEFT JOIN source_page p ON p.id = r.page_id WHERE r.id = ?',
          [it.region_id],
        );
        return { region_id: it.region_id, page_index: reg?.page_index ?? null, before: reg?.text ?? null, after: it.text };
      }),
      note: r.note,
      proposed_by: views.user(r.proposed_by),
      status: r.status,
      result_version_id: r.result_version_id,
      decided_by: r.decided_by ? views.user(r.decided_by) : null,
      decided_at: r.decided_at,
      decision_note: r.decision_note,
      failure_reason_ar: r.failure_reason,
      created_at: r.created_at,
    };
  }

  /** POST /lectures/:id/corrections/:correctionId/decide */
  decide(scope: SpaceScope, lectureId: string, correctionId: string, decision: 'accept' | 'reject', note: string | null): OfficialCorrectionView {
    const { ctx } = this;
    const lecture = getLecture(ctx, lectureId);
    if (!lecture) throw notFound();
    ctx.authz.assert(scope.viewer, 'edit', lectureResource(scope, lecture));
    if (!scope.powers.officialModerator) throw new AppError('FORBIDDEN', 'يقرر التصحيحات مشرف المادة فقط.', 403);
    const r = this.row(correctionId);
    if (!r || r.lecture_id !== lectureId) throw notFound();
    if (r.status !== 'open') throw new AppError('CONFLICT', AR.closed, 409, { status: r.status });
    const now = ctx.clock.now();
    if (decision === 'reject') {
      ctx.db.tx(() => {
        ctx.db.run(`UPDATE official_correction SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?`, [scope.viewer.userId, now, note, now, r.id]);
        ctx.audit.record({ entityType: 'official_correction', entityId: r.id, action: 'reject', summary: `رفض اقتراح تصحيح في «${lecture.title}»` });
      });
    } else {
      const published = publishOf(ctx, r.version_id);
      const items = fromJson<Item[]>(r.items_json) ?? [];
      if (!published) {
        if (processingRunning(ctx, r.version_id)) throw new AppError('CONFLICT', AR.processing, 409);
        ctx.db.tx(() => {
          applyInPlace(ctx, r.version_id, lecture.source_id, items);
          ctx.db.run(`UPDATE official_correction SET status = 'applied', result_version_id = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?`, [r.version_id, scope.viewer.userId, now, note, now, r.id]);
        });
      } else {
        if (lecture.head_version_id !== r.version_id) throw new AppError('CONFLICT', AR.headMoved, 409);
        ctx.db.run(`UPDATE official_correction SET status = 'queued', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?`, [scope.viewer.userId, now, note, now, r.id]);
        this.enqueue(r.id);
      }
      ctx.audit.record({ entityType: 'official_correction', entityId: r.id, action: 'accept', summary: `قبول اقتراح تصحيح في «${lecture.title}»` });
    }
    const views = new ViewBuilder(ctx, scope);
    return this.view(views, this.row(r.id)!);
  }

  /** The job: copy the head version, apply the correction, publish the new version, queue its page map. */
  runJob(correctionId: string): { version_id: string | null; status: OfficialCorrectionStatus } {
    const { ctx } = this;
    const r = this.row(correctionId);
    if (!r) return { version_id: null, status: 'failed' };
    if (r.status !== 'queued') return { version_id: r.result_version_id, status: r.status };
    const lecture = getLecture(ctx, r.lecture_id);
    const fail = (reason: string) => {
      ctx.db.run(`UPDATE official_correction SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?`, [reason, ctx.clock.now(), r.id]);
      return { version_id: null, status: 'failed' as const };
    };
    const newVersionId = derivedId('ocv', r.id);
    if (lecture && publishOf(ctx, newVersionId)) {
      // a retry after this job already published the corrected version (it stopped before recording it): finish the
      // bookkeeping only — never «failed» for a correction students already see (review R3); the page-map job has an
      // idempotent key, so queueing it again is safe
      ctx.db.run(`UPDATE official_correction SET status = 'applied', result_version_id = ?, updated_at = ? WHERE id = ?`, [newVersionId, ctx.clock.now(), r.id]);
      this.lectures.enqueuePageMap(lecture.id, r.version_id, newVersionId);
      return { version_id: newVersionId, status: 'applied' };
    }
    if (!lecture || lecture.status === 'withdrawn') return fail('سُحبت المحاضرة قبل تطبيق التصحيح.');
    if (lecture.head_version_id !== r.version_id) return fail(AR.headMoved);
    const items = fromJson<Item[]>(r.items_json) ?? [];
    ctx.db.tx(() => {
      if (!versionOf(ctx, newVersionId)) {
        const regionMap = copyVersion(ctx, r.version_id, newVersionId);
        applyInPlace(ctx, newVersionId, lecture.source_id, items, regionMap);
        ctx.db.run('INSERT INTO official_version_upload (version_id, lecture_id, uploaded_by, kind, created_at) VALUES (?, ?, ?, ?, ?)', [newVersionId, lecture.id, r.proposed_by, 'correction', ctx.clock.now()]);
      }
    });
    this.lectures.publishVersion(r.decided_by ?? r.proposed_by, lecture as LectureRow, newVersionId, { changeNote: r.note, kind: 'correction' });
    ctx.db.run(`UPDATE official_correction SET status = 'applied', result_version_id = ?, updated_at = ? WHERE id = ?`, [newVersionId, ctx.clock.now(), r.id]);
    this.lectures.enqueuePageMap(lecture.id, r.version_id, newVersionId);
    return { version_id: newVersionId, status: 'applied' };
  }
}
