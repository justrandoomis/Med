// «انشر كمحاضرة رسمية» (P1-T5 step 2; ARCHITECTURE_DELTA §6.9 step 3; PRD AOS-19H.4; lectures-api `lectureFromVaultSchema`).
//
// A Subject Moderator (or a platform admin, who moderates every space) promotes a private source of THEIR OWN vault to
// an official lecture of this subject: the file is registered in the space by its sha256 — a new `stored_file` row in
// the space for the same content-addressed blob, no byte copy — and the lecture and its first version are created and
// processed in the space exactly like an upload (P1-T5 step 1's ingest). It starts as the moderator's draft and is
// published through the normal flow. The moderator's own ink stays private in their vault; their client links it
// afterwards with POST /api/copies/link (copy, never move). The vault is only READ, through the copy services' second
// handle; nothing else of it leaves.
import { existsSync, statSync } from 'node:fs';
import type { LectureFromVaultRequest, LectureFromVaultResponse } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { blobPathFor } from '../files/blobs';
import type { LecturesService } from '../lectures/service';
import { getLecture, type SpaceScope, ViewBuilder } from '../lectures/store';
import { forksSystem } from './system';

const NOT_FOUND_AR = 'المصدر غير موجود في مكتبتك.';

export async function promoteFromVault(ctx: AppContext, scope: SpaceScope, body: LectureFromVaultRequest, lectures: LecturesService): Promise<LectureFromVaultResponse> {
  if (!scope.powers.officialModerator) {
    throw new AppError('FORBIDDEN', 'نشر محاضرة رسمية من مكتبتك لمشرف المادة فقط.', 403);
  }
  const vaultId = forksSystem(ctx).vaultOfViewer(scope.viewer);
  if (!vaultId) throw new AppError('NOT_FOUND', NOT_FOUND_AR, 404);
  const vault = ctx.dbs.vault(vaultId);
  const src = vault.get<{ id: string; is_stub: number; deleted_at: number | null; v: string | null }>(
    'SELECT id, is_stub, deleted_at, COALESCE(frozen_version_id, current_version_id) AS v FROM source WHERE id = ?',
    [body.source_id],
  );
  if (!src || src.deleted_at !== null || src.is_stub === 1 || !src.v) throw new AppError('NOT_FOUND', NOT_FOUND_AR, 404);
  const version = vault.get<{ file_id: string | null; original_file_id: string | null; file_name: string | null; content_hash: string }>(
    'SELECT file_id, original_file_id, file_name, content_hash FROM source_version WHERE id = ?',
    [src.v],
  )!;
  const fileId = version.original_file_id ?? version.file_id;
  const file = fileId ? vault.get<{ sha256: string; size: number }>('SELECT sha256, size FROM stored_file WHERE id = ?', [fileId]) : undefined;
  if (!file) throw new AppError('CONFLICT', 'لا يوجد ملف لهذا المصدر في مكتبتك (ربما صفحات ملاحظات فقط).', 409);
  // the same bytes are already an official lecture of this subject: answer with it, never a duplicate
  const twin = ctx.db.get<{ id: string }>(
    `SELECT l.id FROM official_lecture l JOIN source_version v ON v.source_id = l.source_id WHERE v.content_hash = ? AND l.status <> 'withdrawn' LIMIT 1`,
    [version.content_hash],
  );
  if (twin) throw new AppError('CONFLICT', 'هذا الملف منشور رسميًا في هذه المادة من قبل.', 409, { lecture_id: twin.id });
  let path = blobPathFor(ctx.config.filesDir, file.sha256);
  if (!existsSync(path)) {
    if (!(await ctx.blobs.ensureLocal(file.sha256, file.size))) throw new AppError('CONFLICT', 'ملف هذا المصدر غير متاح على الخادم الآن؛ أعد المحاولة لاحقًا.', 409);
    path = blobPathFor(ctx.config.filesDir, file.sha256);
  }
  const lecture = lectures.create(scope, { title: body.title, lecture_no: body.lecture_no ?? null });
  // the content-addressed blob is read in place (never moved or deleted here); the space gets its own file row
  const up = await lectures.upload(scope, lecture.id, { tmpPath: path, fileName: version.file_name ?? `${body.title}.pdf`, size: statSync(path).size, truncated: false });
  ctx.audit.record({ entityType: 'official_lecture', entityId: lecture.id, action: 'promote_from_vault', summary: `نشر «${body.title}» من مكتبة المشرف كمحاضرة رسمية (مسودة)`, after: { version_id: up.version_id } });
  return { lecture: new ViewBuilder(ctx, scope).lecture(getLecture(ctx, lecture.id)!), version_id: up.version_id, job_id: up.job_id };
}
