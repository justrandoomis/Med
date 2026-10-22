// «هذه المحاضرة موجودة رسميًا — اربطها؟» (P1-T5 step 2; ARCHITECTURE_DELTA §6.9 steps 1–2; PRD AOS-19H.3, X8 c).
//
//  * Candidates are computed IN THE VAULT: the private source's fingerprints (P1-T3, computed in the user's own vault)
//    are compared with the fingerprints of the published official lectures of the subjects the user belongs to, read
//    through `ctx.dbs.space()` — nothing about the private file leaves the vault and nothing is written anywhere. P1-T3's
//    pure `matchLinkCandidates` decides (same sha256, or ≥ 60 % of the official pages matched safely).
//  * Linking creates (or reuses) the stub and the personal copy, then COPIES every item of the private version onto the
//    official version with P1-T2's copy rules (`runReanchorCopyAcross`): deterministic ids, previous anchors kept,
//    uncertain items left for review. The private source and its rows stay byte-identical. A repeated link copies
//    nothing.
import { itemsCountAr, type LinkCandidateInput, type LinkToOfficialRequest, type LinkToOfficialResponse, type OfficialLinkCandidate, type OfficialLinkCandidatesResponse, type OfficialLinkStatus, type OfficialLinkStatusResponse, type PageFingerprintInput } from '@medlevo/shared';
import { createHash } from 'node:crypto';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { AppError } from '../../lib/errors';
import type { Viewer } from '../../system/binding';
import { publicDirectory } from '../../system/directory';
import { linkedPendingCount, recordPrivateLink, runReanchorCopyAcross, type PrivateLinkRow } from '../annotations/reanchorCopy';
import { FINGERPRINT_ALGO, minhashFromBlob, readFingerprints } from '../processing/fingerprint';
import { matchLinkCandidates } from '../versions/candidates';
import { CopiesService, ensurePersonalLayer, getCopy, memberOf, notFound, refreshHoldings } from './copies';
import { ensureStub, openableLecture, publishedVersions, recordStubFiles, spaceDb } from './stubs';
import { forksSystem } from './system';

const NOT_A_MATCH_AR = 'لا تتطابق صفحات ملفك مع هذه المحاضرة الرسمية بما يكفي للربط (يلزم الملف نفسه أو تطابق 60% من الصفحات على الأقل). لم يتغير شيء.';
const MAX_PER_SPACE = 10;

interface PrivateSource {
  id: string;
  title: string;
  version_id: string;
  content_hash: string;
}

function privateSource(ctx: AppContext, sourceId: string): PrivateSource {
  const s = ctx.db.get<{ id: string; title: string; is_stub: number; deleted_at: number | null; v: string | null }>(
    'SELECT id, title, is_stub, deleted_at, COALESCE(frozen_version_id, current_version_id) AS v FROM source WHERE id = ?',
    [sourceId],
  );
  if (!s || s.deleted_at !== null || s.is_stub === 1 || !s.v) throw notFound();
  const v = ctx.db.get<{ content_hash: string }>('SELECT content_hash FROM source_version WHERE id = ?', [s.v])!;
  return { id: s.id, title: s.title, version_id: s.v, content_hash: v.content_hash };
}

/** Fingerprints of a version in ANOTHER database (the same rows `readFingerprints` reads in the bound one). */
function fingerprintsIn(db: Db, versionId: string): PageFingerprintInput[] {
  return db
    .all<{ page_id: string; page_index: number; text_norm_hash: string | null; text_minhash: Uint8Array | null; image_dhash: string | null; layout_hash: string | null; text_len: number }>(
      `SELECT p.id AS page_id, p.page_index, f.text_norm_hash, f.text_minhash, f.image_dhash, f.layout_hash, COALESCE(f.text_len, 0) AS text_len
         FROM source_page p LEFT JOIN page_fingerprint f ON f.page_id = p.id AND f.algo = ?
        WHERE p.version_id = ? ORDER BY p.page_index`,
      [FINGERPRINT_ALGO, versionId],
    )
    .map((r) => ({ page_id: r.page_id, page_index: r.page_index, text_norm_hash: r.text_norm_hash, minhash: minhashFromBlob(r.text_minhash), dhash: r.image_dhash, layout_hash: r.layout_hash, text_len: r.text_len }));
}

interface OfficialHead {
  lecture_id: string;
  title: string;
  subject_node_id: string;
  version_id: string;
  version_no: number;
  content_hash: string;
  shared: number;
}

/** Published heads of a space worth comparing: the same bytes, or at least one page with the same normalised text. */
function headsWorthComparing(space: Db, target: PrivateSource, hashes: readonly string[]): OfficialHead[] {
  const inHashes = hashes.length ? `f.text_norm_hash IN (${hashes.map(() => '?').join(',')})` : '0';
  return space.all<OfficialHead>(
    `SELECT l.id AS lecture_id, l.title, l.subject_node_id, v.id AS version_id, v.version_no, v.content_hash,
            (CASE WHEN v.content_hash = ? THEN 1000 ELSE 0 END) + (SELECT COUNT(*) FROM page_fingerprint f WHERE f.version_id = v.id AND ${inHashes}) AS shared
       FROM official_lecture l JOIN source_version v ON v.id = l.head_version_id
      WHERE l.status = 'published' AND l.takedown_at IS NULL
        AND (v.content_hash = ? OR EXISTS (SELECT 1 FROM page_fingerprint f WHERE f.version_id = v.id AND ${inHashes}))
      ORDER BY shared DESC LIMIT ?`,
    [target.content_hash, ...hashes, target.content_hash, ...hashes, MAX_PER_SPACE],
  );
}

export function linkCandidates(ctx: AppContext, viewer: Viewer, sourceId: string): OfficialLinkCandidatesResponse {
  const src = privateSource(ctx, sourceId);
  const pages = readFingerprints(ctx, src.version_id);
  const hashes = [...new Set(pages.map((p) => p.text_norm_hash).filter((h): h is string => !!h))].slice(0, 900);
  const target: LinkCandidateInput = { source_id: src.id, version_id: src.version_id, title: src.title, content_hash: src.content_hash, pages };
  const dir = publicDirectory(ctx.system);
  const out: OfficialLinkCandidate[] = [];
  for (const m of forksSystem(ctx).spacesOfViewer(viewer)) {
    const space = spaceDb(ctx, m.spaceId);
    if (!space) continue;
    const heads = headsWorthComparing(space, src, hashes);
    if (heads.length === 0) continue;
    const inputs: LinkCandidateInput[] = heads.map((h) => ({ source_id: h.lecture_id, version_id: h.version_id, title: h.title, content_hash: h.content_hash, pages: fingerprintsIn(space, h.version_id) }));
    const subjectTitle = dir.spaceTitle(viewer, m.spaceId) ?? '';
    for (const c of matchLinkCandidates(target, inputs)) {
      const h = heads.find((x) => x.version_id === c.version_id)!;
      out.push({
        space_id: m.spaceId,
        subject: { id: h.subject_node_id, kind: 'subject', title: subjectTitle },
        lecture_id: h.lecture_id,
        title: h.title,
        version_id: h.version_id,
        version_no: h.version_no,
        basis: c.basis,
        matched_pages: c.matched_pages,
        total_pages: c.total_pages,
        basis_ar: [`هذه المحاضرة موجودة رسميًا في مادة ${subjectTitle || '…'}.`, ...c.basis_ar],
      });
    }
  }
  out.sort((a, b) => (a.basis === b.basis ? 0 : a.basis === 'sha256' ? -1 : 1) || b.matched_pages / Math.max(1, b.total_pages) - a.matched_pages / Math.max(1, a.total_pages));
  return { source_id: sourceId, candidates: out.slice(0, 10) };
}

const linkHash = (b: LinkToOfficialRequest) => createHash('sha256').update(JSON.stringify({ link: [b.source_id, b.space_id, b.lecture_id, b.to_version_id] })).digest('hex');

export function linkToOfficial(ctx: AppContext, viewer: Viewer, body: LinkToOfficialRequest, deviceId: string | null): LinkToOfficialResponse {
  const copies = new CopiesService(ctx);
  const hash = linkHash(body);
  const replay = getCopy(ctx, body.id);
  if (replay && replay.client_body_hash !== hash) throw new AppError('CONFLICT', 'هذا المعرّف مستخدم لنسخة أخرى؛ لم يتغير شيء.', 409);
  if (!memberOf(ctx, viewer, body.space_id)) throw notFound();
  const space = spaceDb(ctx, body.space_id);
  if (!space) throw notFound();
  const lecture = openableLecture(space, body.lecture_id);
  if (!lecture) throw notFound();
  const version = publishedVersions(space, lecture).find((v) => v.id === body.to_version_id);
  if (!version) throw notFound();
  const src = privateSource(ctx, body.source_id);
  // only a real twin is linked: the same file, or ≥ 60 % of the official pages matched
  const match = matchLinkCandidates(
    { source_id: src.id, version_id: src.version_id, title: src.title, content_hash: src.content_hash, pages: readFingerprints(ctx, src.version_id) },
    [{ source_id: lecture.id, version_id: version.id, title: lecture.title, content_hash: version.content_hash, pages: fingerprintsIn(space, version.id) }],
  );
  if (match.length === 0) throw new AppError('CONFLICT', NOT_A_MATCH_AR, 409);

  const subjectTitle = publicDirectory(ctx.system).spaceTitle(viewer, body.space_id) ?? '';
  const stub = ensureStub(ctx, { spaceId: body.space_id, lectureId: lecture.id, versionIds: [version.id], folderId: null, subjectTitle });
  recordStubFiles(ctx, stub);
  const now = ctx.clock.now();
  const row = ctx.db.tx(() => {
    const existing = replay ?? ctx.db.get<{ id: string }>(`SELECT id FROM document_copy WHERE source_id = ? AND mode = 'personal' AND deleted_at IS NULL`, [stub.sourceId]);
    if (existing) return getCopy(ctx, existing.id)!;
    const layerId = ensurePersonalLayer(ctx, stub.sourceId, deviceId);
    ctx.db.run(
      `INSERT INTO document_copy (id, source_id, origin_space_id, origin_lecture_id, mode, update_policy, reanchor_policy, personal_layer_id, client_body_hash, created_device_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'personal', 'preview', 'preview', ?, ?, ?, ?, ?)`,
      [body.id, stub.sourceId, body.space_id, lecture.id, layerId, hash, deviceId, now, now],
    );
    return getCopy(ctx, body.id)!;
  });
  // the copy itself (one transaction in the vault); nothing of the private source changes
  const run = runReanchorCopyAcross(ctx, { from_version_id: src.version_id, to_version_id: version.id }, { deviceId });
  const r = run.report;
  const summary = {
    total: r.total,
    copied: r.copied + r.already_moved,
    needs_review: r.needs_review,
    kept: r.kept,
    summary_ar: linkSummaryAr(r.copied + r.already_moved, r.needs_review, r.kept, run.note_pages),
    note_pages: run.note_pages,
  };
  // (C2, X8 c) the link itself is remembered, so what could not be placed is listed in the review list of the official
  // copy and can be copied across by hand later — even when this link copied nothing
  recordPrivateLink(ctx, { private_version_id: src.version_id, to_version_id: version.id, private_source_id: src.id, stub_source_id: stub.sourceId, space_id: body.space_id, lecture_id: lecture.id, counts_json: JSON.stringify(summary) });
  refreshHoldings(ctx, viewer.userId, stub.sourceId);
  return { copy: copies.view(viewer, row), job_id: null, summary };
}

/**
 * What the link did, said where everything is (review P1-T5 s2 R-C; C2 X8 c). Items that could not be placed safely
 * are listed in the review list of the OFFICIAL copy («ملاحظاتي ← إعادة ربط»), from where they are copied by hand or
 * kept on the private lecture; the originals stay on the private lecture, unchanged.
 */
export function linkSummaryAr(copied: number, notPlaced: number, kept: number, notePages: { total: number; copied: number; items: number } = { total: 0, copied: 0, items: 0 }): string {
  const parts = [copied > 0 ? `نُسخ ${itemsCountAr(copied)} إلى النسخة الرسمية` : 'لم يُنسخ شيء إلى النسخة الرسمية'];
  if (notePages.copied === 1) parts.push('ونُسخت صفحة الملاحظات المضافة بما عليها');
  else if (notePages.copied > 1) parts.push(`ونُسخت ${notePages.copied} صفحات ملاحظات مضافة بما عليها`);
  // verb before its subject stays singular in Arabic («لم يُنسخ عنصران»); the clause after it agrees with the count
  if (notPlaced === 1) parts.push('لم يُنسخ عنصر واحد تلقائيًا لأن صفحته تغيّرت أو لم يُعثر على مكانه بأمان: تجده في «ملاحظاتي ← إعادة ربط» في النسخة الرسمية لتنسخه بنفسك أو تبقيه');
  else if (notPlaced > 1) parts.push(`لم يُنسخ ${itemsCountAr(notPlaced)} تلقائيًا لأن صفحاتها تغيّرت أو لم يُعثر على أماكنها بأمان: تجدها في «ملاحظاتي ← إعادة ربط» في النسخة الرسمية لتنسخها بنفسك أو تبقيها`);
  if (kept > 0) parts.push(`بقي ${itemsCountAr(kept)} من طبقات القراءة فقط في محاضرتك الخاصة`);
  return `${parts.join('؛ ')}. محاضرتك الخاصة وكل ما عليها لم يتغيّر.`;
}

/**
 * (Phase 1 completion C2, AOS-19H.3 «the library offers the link», 19I.2) The official state of a few library rows, in
 * the viewer's own vault: a stub names its official lecture; a linked private lecture names its official copy and the
 * items still waiting in its review list; an unlinked LECTURE with an official twin in a member subject offers it. Ids
 * not in this vault are absent from the answer (another user's ids tell nothing).
 */
export function linkStatus(ctx: AppContext, viewer: Viewer, sourceIds: readonly string[]): OfficialLinkStatusResponse {
  const dir = publicDirectory(ctx.system);
  const members = new Set(forksSystem(ctx).spacesOfViewer(viewer).map((m) => m.spaceId));
  const subjectTitle = (spaceId: string) => dir.spaceTitle(viewer, spaceId) ?? '';
  const out: OfficialLinkStatus[] = [];
  for (const id of sourceIds) {
    const s = ctx.db.get<{ id: string; is_stub: number; deleted_at: number | null; source_type: string; origin_space_id: string | null; origin_lecture_id: string | null }>(
      'SELECT id, is_stub, deleted_at, source_type, origin_space_id, origin_lecture_id FROM source WHERE id = ?',
      [id],
    );
    if (!s || s.deleted_at !== null) continue;
    const row: OfficialLinkStatus = { source_id: id, official: null, linked: null, candidate: null };
    if (s.is_stub === 1) {
      if (s.origin_space_id && s.origin_lecture_id) row.official = { space_id: s.origin_space_id, lecture_id: s.origin_lecture_id, subject_title: subjectTitle(s.origin_space_id) };
      out.push(row);
      continue;
    }
    const link = ctx.db.get<PrivateLinkRow>('SELECT * FROM private_link WHERE private_source_id = ? ORDER BY updated_at DESC LIMIT 1', [id]);
    if (link && ctx.db.get('SELECT 1 AS x FROM source WHERE id = ? AND deleted_at IS NULL', [link.stub_source_id])) {
      row.linked = { stub_source_id: link.stub_source_id, space_id: link.space_id, lecture_id: link.lecture_id, subject_title: subjectTitle(link.space_id), pending: linkedPendingCount(ctx, link) };
    } else if (s.source_type === 'lecture' && members.size > 0) {
      // only lectures are matched (the reader's copy bar asks the same), and only while the viewer belongs to a subject
      try {
        const best = linkCandidates(ctx, viewer, id).candidates[0];
        if (best) row.candidate = { space_id: best.space_id, lecture_id: best.lecture_id, title: best.title, subject_title: best.subject.title };
      } catch (e) {
        if (!(e instanceof AppError)) throw e; // a source without a version yet: nothing to offer
      }
    }
    out.push(row);
  }
  return { statuses: out };
}
