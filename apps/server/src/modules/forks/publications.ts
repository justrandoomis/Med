// Course-only publications in the subject's space (P1-T5 step 3; ARCHITECTURE_DELTA §6.4, §7.6; ADR-0004 §2.4; PRD
// AOS-2.8, 4.14, 4.18, 5.12, 5.24, 5.27, 21.16, Q6 «course-only publications go live at once», Q7, Scenario 2).
//
//   POST  /publications                              publish (PublishRequest; `Idempotency-Key`) → PublicationView
//   POST  /publications/:id/versions                 republish (the author): deltas only; the same content = no-op
//   PATCH /publications/:id                          title / summary (a published VERSION never changes)
//   POST  /publications/:id/withdraw                 the author withdraws it (forks keep theirs; followed copies stop)
//   GET   /publications/:id                          the publication page
//   GET   /publications/:id/versions/:n/items        the items valid at n (stable ids; ink v2 on `accept-ink: 2`)
//   GET   /publications/:id/diff?from=&to=           what changes between two versions (UpstreamPreview)
//   GET   /lectures/:lectureId/publications          «الشروحات»: the active explanations of a lecture, newest first
// Every route is on the space-route allow-list (member access in THIS subject); each handler asserts its own decision
// (rules/publications.ts). The publish handler reads the AUTHOR'S OWN vault (their layers on their copy of the lecture)
// inside an explicit vault binding of the same viewer, writes the immutable content into the space in one
// transaction, then the system index (live head, moderation state). Nothing of anyone else's vault is ever read.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ACCEPT_INK_HEADER,
  defaultPersonalLayerId,
  IDEMPOTENCY_KEY_HEADER,
  lecturePublicationsQuerySchema,
  parseAcceptInk,
  patchPublicationSchema,
  publicationDiffQuerySchema,
  publicationItemsQuerySchema,
  publishRequestSchema,
  PUBLISHABLE_ANNOTATION_KINDS,
  republishSchema,
  sourceDocumentKey,
  STUDENT_EXPLANATION_LABEL_AR,
  withdrawPublicationSchema,
  type AnnotationAnchor,
  type LecturePublicationsResponse,
  type PatchPublicationRequest,
  type PublicationCard,
  type PublicationItemsResponse,
  type PublicationView,
  type PublishRequest,
  type RepublishRequest,
  type RichText,
  type UpstreamPreview,
  VAULT_SELF_USER,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson, type Db } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import { publicDirectory } from '../../system/directory';
import { registerPublicationRules, type PublicationResource } from '../authz/rules/publications';
import { ANNOTATION_DOC_SQL, NOTE_DOC_SQL } from '../annotations/layers';
import { derivedId, notFound, scopeOf, visibleLecture, type LectureRow, type SpaceScope } from '../lectures/store';
import { enqueuePublicationFanout } from './pubFanout';
import {
  hashItem,
  hashVersion,
  itemsAt,
  pageOf,
  parseItem,
  stableItemId,
  toDtos,
  upstreamPreview,
  versionRow,
  versionRows,
  type CanonicalAnnotation,
  type CanonicalItem,
  type PublicationItemRow,
  type PublicationVersionRow,
} from './pubItems';
import { forksSystem, publicationIndex, type PublicationRow } from './system';

const AR = {
  lectureNotPublished: 'لا يُنشر شرح إلا على محاضرة رسمية منشورة.',
  noCopy: 'ابدأ دراسة المحاضرة أولًا؛ الشرح يُنشر من طبقاتك على نسختك منها.',
  layerMissing: 'الطبقة المختارة غير موجودة في نسختك من هذه المحاضرة.',
  notYours: 'لا يُنشر شرح زميل تتابعه أو نسخة مأخوذة منه؛ انشر طبقة كتبتها أنت.',
  nothing: 'لا يوجد في الطبقات المختارة ما يُنشر على صفحات هذه المحاضرة؛ اكتب شرحك على صفحاتها أولًا.',
  notePages: 'صفحات الملاحظات المضافة لا تُنشر في هذا الإصدار بعد؛ ما عليها يبقى في نسختك.',
  withdrawn: 'سُحب هذا الشرح؛ لا يُنشر له إصدار جديد.',
} as const;

const SKIP_AR = {
  image: 'الصور لا تُنشر مع الشرح في هذا الإصدار؛ تبقى في نسختك.',
  bookmark: 'العلامات المرجعية شخصية ولا تُنشر.',
  link: 'الروابط تشير إلى مكتبتك ولا تُنشر.',
  note_page: 'ما على صفحات الملاحظات المضافة لا يُنشر في هذا الإصدار بعد؛ يبقى في نسختك.',
  off_page: 'ما ليس على صفحات المحاضرة (كتاب الدراسة، ملاحظة بلا صفحة) لا يُنشر.',
  other_author: 'عناصر كتبها غيرك لا تُنشر باسمك.',
  other_version: (n: number, used: number) => `ما كتبته على الإصدار ${n} من المحاضرة لا يدخل هذا الشرح؛ الشرح مبني على الإصدار ${used}.`,
} as const;

/** Layer kinds an author may publish: their own writing (a followed copy, a fork or a snapshot is someone else's). */
const OWN_LAYER_KINDS = new Set(['personal', 'explanation', 'answers']);
const PUBLISHABLE = new Set<string>(PUBLISHABLE_ANNOTATION_KINDS);

interface SnapshotItem {
  stableId: string;
  entity: 'annotation' | 'note';
  item: CanonicalItem;
  hash: string;
}

interface Snapshot {
  lectureVersionId: string;
  items: SnapshotItem[];
  skipped: Array<{ reason_ar: string; items: number }>;
  layerIds: string[];
}

interface AnnRow {
  id: string;
  kind: string;
  tool: string | null;
  anchor_json: string;
  data_json: string;
  layer: string;
  z: number;
  author_user_id: string | null;
  /** review P1-T5 s3 R3-A: the original author kept by P1-T2's layer copy / a fork (`attribution`), when there is one */
  attr_author: string | null;
}
interface NoteRowLite {
  id: string;
  title: string | null;
  body_json: string;
  anchor_json: string | null;
  origin: string;
  author_user_id: string | null;
  attr_author: string | null;
}

// review P1-T5 s3 R3-A: the attribution row of each item read with it (one LEFT JOIN, primary-key lookups)
const ANN_COLS = `a.id, a.kind, a.tool, a.anchor_json, a.data_json, a.layer, a.z, a.author_user_id, atr.author_user_id AS attr_author`;
const ANN_ATTR = `LEFT JOIN attribution atr ON atr.entity_type = 'annotation' AND atr.entity_id = a.id`;
const NOTE_COLS = `n.id, n.title, n.body_json, n.anchor_json, n.origin, n.author_user_id, atr.author_user_id AS attr_author`;
const NOTE_ATTR = `LEFT JOIN attribution atr ON atr.entity_type = 'note' AND atr.entity_id = n.id`;

/**
 * Who wrote an item, for the «not yours» check (review P1-T5 s3 R3-A): the row's own author when set (a followed copy),
 * otherwise the author its attribution names — P1-T2's «انسخ الطبقة» and a fork write `author_user_id = NULL` and keep
 * the original author in `attribution`, so a classmate's explanation copied into one's own layer stays HIS (PRD
 * AOS-4.18: the author survives fork, copy and merge). `vault:self` (the user's own earlier layer) is the viewer.
 */
function writerOf(row: { author_user_id: string | null; attr_author: string | null }, viewerId: string): string {
  if (row.author_user_id) return row.author_user_id;
  if (row.attr_author && row.attr_author !== VAULT_SELF_USER) return row.attr_author;
  return viewerId;
}

/**
 * What of an item's data is published (review P1-T5 s3 R3-D): the stroke as drawn, never a reference into the author's
 * vault — `audio_link` names the author's private recording (a follower's tap would reach nothing of theirs).
 */
function publishableData(data: Record<string, unknown>): Record<string, unknown> {
  if (!data || typeof data !== 'object') return data;
  const { audio_link: _audio, ...rest } = data;
  void _audio;
  const from = rest.recognized_from;
  if (from && typeof from === 'object' && 'audio_link' in (from as Record<string, unknown>)) {
    const { audio_link: _a2, ...stroke } = from as Record<string, unknown>;
    void _a2;
    rest.recognized_from = stroke;
  }
  return rest;
}

/** The lecture's published versions in the space (id → version_no, pages). */
function publishedVersionsOf(space: Db, lecture: Pick<LectureRow, 'id' | 'source_id'>): Map<string, { no: number; pages: number }> {
  const rows = space.all<{ id: string; version_no: number; pages: number }>(
    `SELECT v.id, v.version_no, (SELECT COUNT(*) FROM source_page p WHERE p.version_id = v.id) AS pages
       FROM source_version v JOIN official_version_publish p ON p.version_id = v.id AND p.lecture_id = ? WHERE v.source_id = ?`,
    [lecture.id, lecture.source_id],
  );
  return new Map(rows.map((r) => [r.id, { no: r.version_no, pages: r.pages }]));
}

export class PublicationsService {
  constructor(private readonly ctx: AppContext) {}

  private get index() {
    return publicationIndex(this.ctx);
  }

  // ───────────────────────── resources and lookups ─────────────────────────

  resource(scope: SpaceScope, row: PublicationRow): PublicationResource {
    return {
      type: 'publication',
      id: row.id,
      spaceId: row.space_id,
      authorUserId: row.author_user_id,
      status: row.status,
      viewerHoldsCopy: this.index.holds(scope.viewer.userId, row.id),
    };
  }

  /** The publication of THIS space the viewer may see (404 with the body of a missing id otherwise). */
  visible(scope: SpaceScope, id: string): PublicationRow {
    const row = this.index.get(id);
    if (!row || row.space_id !== scope.spaceId) throw notFound();
    this.ctx.authz.assert(scope.viewer, 'view', this.resource(scope, row));
    return row;
  }

  /**
   * The newest version this viewer may read (review P1-T5 s3 R3-B). An active explanation: its head, for every member.
   * Its author: always the head. A hidden one: the head for the subject's moderators (they decide on it). Anyone else
   * still allowed to see a hidden, withdrawn or author-deleted explanation holds a copy of it — they keep WHAT THEY HAD
   * (PRD AOS-18.7, Q14): versions up to the one their copy took, never one published after it or while it was hidden.
   */
  readableHead(scope: SpaceScope, row: PublicationRow): number {
    if (row.status === 'active' || row.author_user_id === scope.viewer.userId) return row.head_version_no;
    if (row.status === 'hidden_by_moderator') {
      const m = this.ctx.authz.memberships.accessToSpace(scope.viewer, row.space_id);
      if (m && !m.pending && m.access === 'moderator') return row.head_version_no;
    }
    const copy = this.index.copyOf(scope.viewer.userId, row.id);
    return copy && copy.ended_at === null ? Math.min(copy.applied_version_no, row.head_version_no) : 0;
  }

  // ───────────────────────── the author's snapshot (their own vault) ─────────────────────────

  private snapshot(scope: SpaceScope, lecture: LectureRow, publicationId: string, layerIds: readonly string[]): Snapshot {
    const { ctx } = this;
    const vaultId = forksSystem(ctx).vaultOfViewer(scope.viewer);
    if (!vaultId) throw notFound();
    const published = publishedVersionsOf(ctx.db, lecture);
    const docKey = sourceDocumentKey(lecture.source_id);
    const defaultId = defaultPersonalLayerId(docKey);
    const read = ctx.binding.run({ kind: 'vault', vaultId, viewer: scope.viewer }, () => {
      const vdb = ctx.db;
      const stub = vdb.get<{ id: string }>('SELECT id FROM source WHERE id = ? AND is_stub = 1 AND origin_space_id = ? AND deleted_at IS NULL', [lecture.source_id, scope.spaceId]);
      if (!stub) throw new AppError('CONFLICT', AR.noCopy, 409);
      const anns: AnnRow[] = [];
      const notes: NoteRowLite[] = [];
      for (const layerId of layerIds) {
        if (layerId === defaultId) {
          anns.push(...vdb.all<AnnRow>(`SELECT ${ANN_COLS} FROM annotation a ${ANN_ATTR} WHERE a.layer_id IS NULL AND a.deleted_at IS NULL AND ${ANNOTATION_DOC_SQL('a')} = ?`, [docKey]));
          notes.push(...vdb.all<NoteRowLite>(`SELECT ${NOTE_COLS} FROM note n ${NOTE_ATTR} WHERE n.layer_id IS NULL AND n.deleted_at IS NULL AND ${NOTE_DOC_SQL('n')} = ?`, [docKey]));
          continue;
        }
        const l = vdb.get<{ document_key: string; kind: string; deleted_at: number | null }>('SELECT document_key, kind, deleted_at FROM annotation_layer WHERE id = ?', [layerId]);
        if (!l || l.deleted_at !== null || l.document_key !== docKey) throw new AppError('NOT_FOUND', AR.layerMissing, 404);
        if (!OWN_LAYER_KINDS.has(l.kind)) throw new AppError('CONFLICT', AR.notYours, 409);
        anns.push(...vdb.all<AnnRow>(`SELECT ${ANN_COLS} FROM annotation a ${ANN_ATTR} WHERE a.layer_id = ? AND a.deleted_at IS NULL`, [layerId]));
        notes.push(...vdb.all<NoteRowLite>(`SELECT ${NOTE_COLS} FROM note n ${NOTE_ATTR} WHERE n.layer_id = ? AND n.deleted_at IS NULL`, [layerId]));
      }
      return { anns, notes };
    });

    const skipped = new Map<string, number>();
    const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    type Candidate = { authorItemId: string; entity: 'annotation' | 'note'; item: CanonicalItem; versionId: string };
    const candidates: Candidate[] = [];
    const placeOf = (anchor: AnnotationAnchor | null): { versionId: string } | { skip: string } => {
      if (!anchor) return { skip: SKIP_AR.off_page };
      if (anchor.type === 'note_page') return { skip: SKIP_AR.note_page };
      if (anchor.type !== 'page' || anchor.source_id !== lecture.source_id || !published.has(anchor.version_id)) return { skip: SKIP_AR.off_page };
      return { versionId: anchor.version_id };
    };
    for (const a of read.anns) {
      if (writerOf(a, scope.viewer.userId) !== scope.viewer.userId) {
        skip(SKIP_AR.other_author);
        continue;
      }
      if (!PUBLISHABLE.has(a.kind)) {
        skip(a.kind === 'image' ? SKIP_AR.image : a.kind === 'bookmark' ? SKIP_AR.bookmark : SKIP_AR.link);
        continue;
      }
      const anchor = fromJson<AnnotationAnchor>(a.anchor_json) ?? null;
      const at = placeOf(anchor);
      if ('skip' in at) {
        skip(at.skip);
        continue;
      }
      const item: CanonicalAnnotation = {
        t: 'annotation',
        kind: a.kind as CanonicalAnnotation['kind'],
        tool: a.tool,
        anchor: anchor!,
        data: publishableData((fromJson<Record<string, unknown>>(a.data_json) ?? {}) as Record<string, unknown>) as unknown as CanonicalAnnotation['data'],
        layer: a.layer as CanonicalAnnotation['layer'],
        z: a.z,
      };
      candidates.push({ authorItemId: a.id, entity: 'annotation', item, versionId: at.versionId });
    }
    for (const n of read.notes) {
      if (writerOf(n, scope.viewer.userId) !== scope.viewer.userId) {
        skip(SKIP_AR.other_author);
        continue;
      }
      const anchor = n.anchor_json ? (fromJson<AnnotationAnchor>(n.anchor_json) ?? null) : null;
      const at = placeOf(anchor);
      if ('skip' in at) {
        skip(at.skip);
        continue;
      }
      candidates.push({
        authorItemId: n.id,
        entity: 'note',
        item: { t: 'note', title: n.title, body: (fromJson<RichText>(n.body_json) ?? { v: 1, paragraphs: [] }) as RichText, anchor, origin: n.origin as 'owner' },
        versionId: at.versionId,
      });
    }
    // the explanation is built on ONE official version: the newest one the chosen layers have writing on (after
    // «انقل ملاحظاتي» the author's copies sit on the new version and the originals stay on the old one)
    let used: string | null = null;
    for (const c of candidates) if (!used || published.get(c.versionId)!.no > published.get(used)!.no) used = c.versionId;
    if (!used) throw new AppError('CONFLICT', AR.nothing, 409, { skipped: [...skipped].map(([reason_ar, items]) => ({ reason_ar, items })) });
    const usedNo = published.get(used)!.no;
    const items: SnapshotItem[] = [];
    for (const c of candidates) {
      if (c.versionId !== used) {
        skip(SKIP_AR.other_version(published.get(c.versionId)!.no, usedNo));
        continue;
      }
      items.push({ stableId: stableItemId(publicationId, c.authorItemId), entity: c.entity, item: c.item, hash: hashItem(c.item) });
    }
    return { lectureVersionId: used, items, skipped: [...skipped].map(([reason_ar, n]) => ({ reason_ar, items: n })), layerIds: [...layerIds] };
  }

  private pagesTotal(lectureVersionId: string): number {
    return this.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_page WHERE version_id = ?', [lectureVersionId])?.n ?? 0;
  }

  /** Write version n of a publication into the space (one transaction): new rows for added / changed items only. */
  private writeVersion(publicationId: string, versionNo: number, lecture: LectureRow, snap: Snapshot, authorUserId: string, changeNote: string | null): void {
    const { ctx } = this;
    const now = ctx.clock.now();
    const head = versionNo > 1 ? itemsAt(ctx.db, publicationId, versionNo - 1) : new Map<string, PublicationItemRow>();
    const next = new Map(snap.items.map((i) => [i.stableId, i]));
    const pages = new Set(snap.items.map((i) => pageOf(i.item)).filter((p): p is string => !!p));
    ctx.db.tx(() => {
      for (const [id, row] of head) {
        const n = next.get(id);
        if (!n || n.hash !== row.content_hash) ctx.db.run('UPDATE publication_item SET valid_to = ? WHERE publication_id = ? AND item_id = ? AND valid_from = ? AND valid_to IS NULL', [versionNo, publicationId, id, row.valid_from]);
      }
      for (const [id, n] of next) {
        const old = head.get(id);
        if (old && old.content_hash === n.hash) continue;
        ctx.db.run(
          `INSERT INTO publication_item (publication_id, item_id, valid_from, valid_to, entity_type, content_hash, row_json, source_crop) VALUES (?, ?, ?, NULL, ?, ?, ?, 0)`,
          [publicationId, id, versionNo, n.entity, n.hash, toJson(n.item)],
        );
      }
      ctx.db.run(
        `INSERT INTO publication_version (id, publication_id, version_no, lecture_id, lecture_version_id, author_user_id, change_note, item_count, pages_covered, pages_total,
                                          audio_recording_id, content_hash, derived_from_json, created_at, author_layer_ids_json, skipped_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
        [
          derivedId('pv', publicationId, String(versionNo)),
          publicationId,
          versionNo,
          lecture.id,
          snap.lectureVersionId,
          authorUserId,
          changeNote,
          snap.items.length,
          pages.size,
          this.pagesTotal(snap.lectureVersionId),
          hashVersion(snap.items.map((i) => ({ item_id: i.stableId, content_hash: i.hash }))),
          now,
          toJson(snap.layerIds),
          toJson(snap.skipped),
        ],
      );
    });
  }

  // ───────────────────────── publish / republish / patch / withdraw ─────────────────────────

  publish(scope: SpaceScope, body: PublishRequest, idempotencyKey: string | null): PublicationView {
    const { ctx } = this;
    const lecture = visibleLecture(ctx, scope, body.lecture_id);
    ctx.authz.assert(scope.viewer, 'create', { type: 'publication', id: '', spaceId: scope.spaceId, authorUserId: '', status: 'active' } as PublicationResource);
    if (lecture.status !== 'published' || !lecture.head_version_id) throw new AppError('CONFLICT', AR.lectureNotPublished, 409);
    if (body.note_page_ids && body.note_page_ids.length > 0) throw new AppError('FEATURE_DISABLED', AR.notePages, 409, { feature: 'publication_note_pages' });
    const key = idempotencyKey && /^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey) ? idempotencyKey : null;
    if (key) {
      const prior = this.index.byClientKey(scope.viewer.userId, key);
      if (prior) {
        if (prior.space_id !== scope.spaceId || prior.lecture_id !== lecture.id) throw new AppError('CONFLICT', 'هذا المفتاح استُعمل لنشر آخر؛ لم يتغير شيء.', 409);
        return this.view(scope, prior.id);
      }
    }
    // a retried request with the same key gets the same id (its space rows may already exist)
    const id = key ? derivedId('pub', scope.viewer.userId, key) : newId(ctx.clock.now());
    const snap = this.snapshot(scope, lecture, id, body.layer_ids);
    if (!versionRow(ctx.db, id, 1)) this.writeVersion(id, 1, lecture, snap, scope.viewer.userId, null);
    const now = ctx.clock.now();
    this.index.insert({
      id,
      space_id: scope.spaceId,
      lecture_id: lecture.id,
      subject_node_id: lecture.subject_node_id,
      author_user_id: scope.viewer.userId,
      kind: body.kind,
      title: body.title,
      summary: body.summary ?? null,
      visibility: body.visibility,
      head_version_no: 1,
      published_at: now,
      updated_at: now,
      client_key: key,
    });
    ctx.audit.record({ entityType: 'publication', entityId: id, action: 'publish', summary: `نُشر شرح «${body.title}» لأعضاء المادة (الإصدار 1)`, after: { lecture_id: lecture.id, items: snap.items.length } });
    return this.view(scope, id);
  }

  republish(scope: SpaceScope, id: string, body: RepublishRequest): PublicationView {
    const { ctx } = this;
    const row = this.visible(scope, id);
    ctx.authz.assert(scope.viewer, 'edit', this.resource(scope, row));
    const lecture = visibleLecture(ctx, scope, row.lecture_id);
    if (lecture.status !== 'published') throw new AppError('CONFLICT', AR.lectureNotPublished, 409);
    const snap = this.snapshot(scope, lecture, id, body.layer_ids);
    const head = versionRow(ctx.db, id, row.head_version_no);
    const hash = hashVersion(snap.items.map((i) => ({ item_id: i.stableId, content_hash: i.hash })));
    // the same content as the head (a retry after a lost answer, or nothing changed): the head, unchanged
    if (head && head.content_hash === hash && head.lecture_version_id === snap.lectureVersionId) return this.view(scope, id);
    const n = Math.max(row.head_version_no, ...versionRows(ctx.db, id).map((v) => v.version_no)) + 1;
    const counts = diffCounts(ctx.db, id, n - 1, snap);
    this.writeVersion(id, n, lecture, snap, scope.viewer.userId, body.change_note ?? null);
    this.index.setHead(id, n);
    ctx.audit.record({ entityType: 'publication', entityId: id, action: 'republish', summary: `نُشر الإصدار ${n} من «${row.title}»`, after: { version_no: n, ...counts } });
    enqueuePublicationFanout(ctx, { publication_id: id, version_no: n });
    return this.view(scope, id);
  }

  patch(scope: SpaceScope, id: string, body: PatchPublicationRequest): PublicationView {
    const row = this.visible(scope, id);
    this.ctx.authz.assert(scope.viewer, 'edit', this.resource(scope, row));
    this.index.patch(id, { title: body.title, summary: body.summary });
    return this.view(scope, id);
  }

  withdraw(scope: SpaceScope, id: string): PublicationView {
    const row = this.visible(scope, id);
    this.ctx.authz.assert(scope.viewer, 'withdraw', this.resource(scope, row));
    if (row.status !== 'withdrawn' && row.status !== 'author_deleted') {
      this.index.withdraw(id);
      this.ctx.audit.record({ entityType: 'publication', entityId: id, action: 'withdraw', summary: `سحب صاحبه الشرح «${row.title}»؛ تبقى النسخ التي أخذها غيره` });
    }
    return this.view(scope, id);
  }

  // ───────────────────────── reads ─────────────────────────

  view(scope: SpaceScope, id: string): PublicationView {
    const { ctx } = this;
    const row = this.visible(scope, id);
    // a holder of a hidden / withdrawn explanation reads the versions they had, not what came after (R3-B)
    const readable = this.readableHead(scope, row);
    const versions = versionRows(ctx.db, id).filter((v) => v.version_no <= readable);
    const head = versions.find((v) => v.version_no === Math.min(row.head_version_no, readable)) ?? versions[versions.length - 1] ?? null;
    const lecture = ctx.db.get<{ id: string; title: string }>('SELECT id, title FROM official_lecture WHERE id = ?', [row.lecture_id]);
    const dir = publicDirectory(ctx.system);
    const author = dir.userRefs(scope.viewer, [row.author_user_id]).get(row.author_user_id)!;
    const isAuthor = row.author_user_id === scope.viewer.userId;
    const copy = this.index.copyOf(scope.viewer.userId, id);
    const lectureVersionNo = new Map<string, number>();
    const versionNoOf = (versionId: string) => {
      if (!lectureVersionNo.has(versionId)) lectureVersionNo.set(versionId, ctx.db.get<{ version_no: number }>('SELECT version_no FROM source_version WHERE id = ?', [versionId])?.version_no ?? 0);
      return lectureVersionNo.get(versionId)!;
    };
    const res = this.resource(scope, row);
    const canReport = !isAuthor && row.status === 'active';
    return {
      id: row.id,
      space_id: row.space_id,
      lecture: { id: row.lecture_id, title: lecture?.title ?? '' },
      subject: { id: row.subject_node_id, kind: 'subject', title: dir.spaceTitle(scope.viewer, row.space_id) ?? '' },
      author,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      visibility: row.visibility,
      status: row.status,
      hidden: row.status === 'hidden_by_moderator' && row.hidden_reason_ar ? { reason_ar: row.hidden_reason_ar, at: row.hidden_at ?? row.updated_at } : null,
      head_version_no: row.head_version_no,
      versions: versions.map((v) => ({
        no: v.version_no,
        created_at: v.created_at,
        change_note: v.change_note,
        lecture_version_id: v.lecture_version_id,
        lecture_version_no: versionNoOf(v.lecture_version_id),
        item_count: v.item_count,
      })),
      completeness: { pages_covered: head?.pages_covered ?? 0, pages_total: head?.pages_total ?? 0 },
      origin_label_ar: STUDENT_EXPLANATION_LABEL_AR,
      viewer: {
        copy: copy && copy.ended_at === null ? (copy.mode === 'independent' ? 'independent_fork' : 'followed') : null,
        can_edit: isAuthor && ctx.authz.can(scope.viewer, 'edit', res).allowed,
        source_layer_ids: isAuthor && head ? (fromJson<string[]>(head.author_layer_ids_json) ?? []) : null,
        can_report: canReport,
      },
      snapshot: isAuthor && head ? { items: head.item_count, skipped: fromJson<Array<{ reason_ar: string; items: number }>>(head.skipped_json) ?? [] } : null,
      published_at: row.published_at,
      updated_at: row.updated_at,
    };
  }

  items(scope: SpaceScope, id: string, versionNo: number, pageId: string | undefined, inkFormat: 1 | 2): PublicationItemsResponse {
    const row = this.visible(scope, id);
    const v = versionRow(this.ctx.db, id, versionNo);
    if (!v || versionNo > this.readableHead(scope, row)) throw notFound();
    let rows = [...itemsAt(this.ctx.db, id, versionNo).values()];
    if (pageId) rows = rows.filter((r) => pageOf(parseItem(r)) === pageId);
    const dtos = toDtos(rows, { authorUserId: row.author_user_id, createdAt: v.created_at, inkFormat });
    return { publication_id: id, version_no: versionNo, items: dtos.items, notes: dtos.notes, note_pages: [], redacted: false };
  }

  diff(scope: SpaceScope, id: string, from: number, to: number): UpstreamPreview {
    const row = this.visible(scope, id);
    const readable = this.readableHead(scope, row);
    for (const n of [from, to]) if (n > readable || !versionRow(this.ctx.db, id, n)) throw notFound();
    return upstreamPreview(this.ctx.db, id, from, to);
  }

  list(scope: SpaceScope, lectureId: string, q: { cursor?: string; limit: number }): LecturePublicationsResponse {
    const { ctx } = this;
    const lecture = visibleLecture(ctx, scope, lectureId);
    let after: { updated_at: number; id: string } | null = null;
    if (q.cursor) {
      try {
        const v = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as unknown;
        if (!Array.isArray(v) || typeof v[0] !== 'number' || typeof v[1] !== 'string') throw new Error('cursor');
        after = { updated_at: v[0], id: v[1] };
      } catch {
        throw new AppError('VALIDATION_FAILED', 'مؤشر الصفحة غير صالح.', 400, { where: 'query', issues: [{ path: 'cursor', code: 'custom', message: 'مؤشر الصفحة غير صالح.' }] });
      }
    }
    // only what the viewer may see, filtered BEFORE paginating (active ones are visible to every member)
    const rows = this.index.activeOfLecture(scope.spaceId, lecture.id, after, q.limit + 1);
    const page = rows.slice(0, q.limit);
    const people = publicDirectory(ctx.system).userRefs(scope.viewer, page.map((r) => r.author_user_id));
    const items: PublicationCard[] = page.map((r) => {
      const head = versionRow(ctx.db, r.id, r.head_version_no);
      return {
        id: r.id,
        title: r.title,
        author: people.get(r.author_user_id)!,
        kind: r.kind,
        head_version_no: r.head_version_no,
        completeness: { pages_covered: head?.pages_covered ?? 0, pages_total: head?.pages_total ?? 0 },
        label_ar: STUDENT_EXPLANATION_LABEL_AR,
        updated_at: r.updated_at,
      };
    });
    const last = page[page.length - 1];
    return { items, next_cursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.updated_at, last.id])).toString('base64url') : null };
  }
}

function diffCounts(space: Db, publicationId: string, headNo: number, snap: Snapshot): { added: number; removed: number; changed: number } {
  const head = itemsAt(space, publicationId, headNo);
  let added = 0;
  let changed = 0;
  const next = new Set<string>();
  for (const i of snap.items) {
    next.add(i.stableId);
    const old = head.get(i.stableId);
    if (!old) added++;
    else if (old.content_hash !== i.hash) changed++;
  }
  let removed = 0;
  for (const id of head.keys()) if (!next.has(id)) removed++;
  return { added, removed, changed };
}

export type { PublicationVersionRow };

// ───────────────────────── routes (mounted under /api/spaces by the lectures plugin) ─────────────────────────

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const pubParams = z.object({ spaceId: id, publicationId: id });
const versionParams = pubParams.extend({ versionNo: z.coerce.number().int().min(1).max(1_000_000) });
const lectureParams = z.object({ spaceId: id, lectureId: id });

function idempotencyKeyOf(req: FastifyRequest): string | null {
  const v = req.headers[IDEMPOTENCY_KEY_HEADER];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** P1-T5 step 3: the publication routes of a subject's space (all on the allow-list, authz/spaceRoutes.ts). */
export function registerPublicationRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerPublicationRules(ctx.authz);
  const svc = new PublicationsService(ctx);
  // publishing reads a whole layer: a short per-client ceiling keeps one account from hammering it
  const WRITE = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } };
  app.post('/:spaceId/publications', WRITE, async (req) => svc.publish(scopeOf(ctx), parseBody(publishRequestSchema, req), idempotencyKeyOf(req)));
  app.post('/:spaceId/publications/:publicationId/versions', WRITE, async (req) => svc.republish(scopeOf(ctx), parseParams(pubParams, req).publicationId, parseBody(republishSchema, req)));
  app.patch('/:spaceId/publications/:publicationId', async (req) => svc.patch(scopeOf(ctx), parseParams(pubParams, req).publicationId, parseBody(patchPublicationSchema, req)));
  app.post('/:spaceId/publications/:publicationId/withdraw', async (req) => {
    parseBody(withdrawPublicationSchema, req);
    return svc.withdraw(scopeOf(ctx), parseParams(pubParams, req).publicationId);
  });
  app.get('/:spaceId/publications/:publicationId', async (req) => svc.view(scopeOf(ctx), parseParams(pubParams, req).publicationId));
  app.get('/:spaceId/publications/:publicationId/versions/:versionNo/items', async (req) => {
    const p = parseParams(versionParams, req);
    return svc.items(scopeOf(ctx), p.publicationId, p.versionNo, parseQuery(publicationItemsQuerySchema, req).page_id, parseAcceptInk(req.headers[ACCEPT_INK_HEADER]));
  });
  app.get('/:spaceId/publications/:publicationId/diff', async (req) => {
    const q = parseQuery(publicationDiffQuerySchema, req);
    return svc.diff(scopeOf(ctx), parseParams(pubParams, req).publicationId, q.from, q.to);
  });
  app.get('/:spaceId/lectures/:lectureId/publications', async (req) => svc.list(scopeOf(ctx), parseParams(lectureParams, req).lectureId, parseQuery(lecturePublicationsQuerySchema, req)));
}
