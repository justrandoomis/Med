// (Phase 1 completion C2, AOS-19H.1) What hangs on ONE official lecture identity, for the signed-in member — a VAULT
// read: the identity and its published versions come from the subject's space (members only, published lectures
// only), the copies, linked private lectures and personal objects from the viewer's OWN vault, the explanations from
// the system publication index (active ones, plus the viewer's own and the ones they hold a copy of).
//
// The stub of a lecture keeps the space's ids (source, versions, pages), so every personal object that points at the
// stub source points at the identity. Objects are answered as a list by kind: later phases (cards from the official
// layer, question banks, shared recordings) add kinds without a contract change.
import { LECTURE_IDENTITY_OBJECT_KINDS, type LectureIdentityLinks, type LectureIdentityObjectKind, type LectureIdentityQuery } from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { Viewer } from '../../system/binding';
import { publicDirectory } from '../../system/directory';
import { memberOf, notFound } from './copies';
import { openableLecture, publishedVersions, spaceDb, spaceLecture, stubOf } from './stubs';
import { publicationIndex } from './system';

const count = (ctx: AppContext, sql: string, params: readonly string[]): number => ctx.db.get<{ n: number }>(sql, params)?.n ?? 0;

/** The viewer's own objects on the stub source, by kind (0 for every kind before «ابدأ الدراسة»). */
function objectsOn(ctx: AppContext, stubSourceId: string | null): LectureIdentityLinks['objects'] {
  const counts = new Map<LectureIdentityObjectKind, number>(LECTURE_IDENTITY_OBJECT_KINDS.map((k) => [k, 0]));
  if (stubSourceId) {
    const versions = `SELECT id FROM source_version WHERE source_id = ?`;
    counts.set(
      'annotation',
      count(
        ctx,
        `SELECT COUNT(DISTINCT t.annotation_id) AS n FROM annotation_target t JOIN source_page p ON p.id = t.target_id JOIN annotation a ON a.id = t.annotation_id
          WHERE t.target_type = 'source_page' AND a.deleted_at IS NULL AND p.version_id IN (${versions})`,
        [stubSourceId],
      ),
    );
    counts.set(
      'note',
      count(ctx, `SELECT COUNT(*) AS n FROM note n JOIN source_page p ON n.anchor_target_key = 'source_page:' || p.id WHERE n.deleted_at IS NULL AND p.version_id IN (${versions})`, [stubSourceId]),
    );
    counts.set('question', count(ctx, `SELECT COUNT(DISTINCT question_id) AS n FROM question_occurrence WHERE source_id = ?`, [stubSourceId]));
    counts.set('card', count(ctx, `SELECT COUNT(*) AS n FROM flashcard WHERE source_id = ? AND deleted_at IS NULL`, [stubSourceId]));
    counts.set(
      'recording',
      count(ctx, `SELECT COUNT(*) AS n FROM audio_recording r JOIN source s ON s.id = r.source_id WHERE r.linked_source_id = ? AND s.deleted_at IS NULL`, [stubSourceId]),
    );
  }
  return LECTURE_IDENTITY_OBJECT_KINDS.map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
}

export function lectureIdentity(ctx: AppContext, viewer: Viewer, q: LectureIdentityQuery): LectureIdentityLinks {
  // membership first: a stranger learns nothing (the body of a missing item)
  const member = memberOf(ctx, viewer, q.space_id);
  if (!member) throw notFound();
  const space = spaceDb(ctx, q.space_id);
  if (!space) throw notFound();
  const stub = stubOf(ctx, q.space_id, q.lecture_id);
  const held = stub && stub.deleted_at === null ? stub : null;
  // a published lecture (or a withdrawn one the member already studies): drafts never leave the space
  const lecture = openableLecture(space, q.lecture_id, { allowWithdrawn: held !== null }) ?? (held ? spaceLecture(space, q.lecture_id) : null);
  if (!lecture || lecture.takedown_at !== null || (lecture.status !== 'published' && lecture.status !== 'withdrawn')) throw notFound();

  const heldVersions = new Set(held ? ctx.db.all<{ id: string }>('SELECT id FROM source_version WHERE source_id = ?', [held.id]).map((r) => r.id) : []);
  const versions = publishedVersions(space, lecture).map((v) => ({ id: v.id, version_no: v.version_no, published_at: v.published_at, held: heldVersions.has(v.id) }));
  const copies = held
    ? ctx.db
        .all<{ id: string; mode: LectureIdentityLinks['copies'][number]['mode']; publication_id: string | null }>(
          'SELECT id, mode, publication_id FROM document_copy WHERE source_id = ? AND deleted_at IS NULL ORDER BY created_at, id',
          [held.id],
        )
        .map((c) => ({ id: c.id, mode: c.mode, publication_id: c.publication_id }))
    : [];
  const linked = held
    ? ctx.db.all<{ source_id: string; title: string }>(
        `SELECT DISTINCT s.id AS source_id, s.title FROM private_link l JOIN source s ON s.id = l.private_source_id
          WHERE l.stub_source_id = ? AND s.deleted_at IS NULL ORDER BY s.title, s.id`,
        [held.id],
      )
    : [];
  const index = publicationIndex(ctx);
  const publications = index
    .ofLecture(q.space_id, q.lecture_id)
    .map((p) => ({ p, mine: p.author_user_id === viewer.userId, holds: index.holds(viewer.userId, p.id) }))
    .filter(({ p, mine, holds }) => p.status === 'active' || mine || holds)
    .map(({ p, mine, holds }) => ({ id: p.id, title: p.title, head_version_no: p.head_version_no, status: p.status, mine, held: holds }));

  return {
    identity: {
      space_id: q.space_id,
      lecture_id: lecture.id,
      title: lecture.title,
      lecture_no: lecture.lecture_no,
      held_on: lecture.held_on,
      subject_title: publicDirectory(ctx.system).spaceTitle(viewer, q.space_id) ?? '',
      status: lecture.status === 'published' ? 'published' : 'withdrawn',
    },
    versions,
    stub_source_id: held?.id ?? null,
    copies,
    linked_private: linked,
    publications,
    objects: objectsOn(ctx, held?.id ?? null),
  };
}
