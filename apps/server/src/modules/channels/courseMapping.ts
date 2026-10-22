// AOS-21.5 — the mapping from a user's personal course node to the shared channel course, read from the PERSONAL side
// (ARCHITECTURE_DELTA §4.2 «Courses»: the channel `course` node is shared; the user's `library_node` of kind `course`
// stays in her vault, untouched). The mapping itself is the user's «تابع المادة» with that node as the place new
// official lectures go (`course_follow.library_folder_id`, written by PUT /subjects/:id/follow, which already refuses
// a node the viewer's own vault does not hold). This file only reads it back:
//   GET /api/channels/course-mappings?library_node_id= → CourseMappingsResponse
// Only the viewer's own live follows, only subjects the one policy still lets her see; the personal node is read from
// the request's own bound vault (another user's node id is simply unknown here).
import type { CourseMappingsResponse, CourseMappingView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { Viewer } from '../../system/binding';

interface FollowRow {
  subject_node_id: string;
  subject_title: string;
  library_folder_id: string;
  add_new_lectures: number;
  created_at: number;
}

export function courseMappings(ctx: AppContext, viewer: Viewer, libraryNodeId?: string): CourseMappingsResponse {
  const sys = ctx.system.db;
  const rows = sys.all<FollowRow>(
    `SELECT f.subject_node_id, n.title AS subject_title, f.library_folder_id, f.add_new_lectures, f.created_at
       FROM course_follow f JOIN channel_node n ON n.id = f.subject_node_id
      WHERE f.user_id = ? AND f.ended_at IS NULL AND f.library_folder_id IS NOT NULL ${libraryNodeId ? 'AND f.library_folder_id = ?' : ''}
      ORDER BY f.created_at, f.subject_node_id`,
    libraryNodeId ? [viewer.userId, libraryNodeId] : [viewer.userId],
  );
  const mappings: CourseMappingView[] = [];
  for (const r of rows) {
    if (!ctx.authz.can(viewer, 'view', { type: 'channel_node', id: r.subject_node_id }).allowed) continue;
    // the nearest shared `course` node above the subject (the Semester / Course level)
    const course = sys.get<{ id: string; title: string; starts_on: string | null; ends_on: string | null }>(
      `SELECT n.id, n.title, n.starts_on, n.ends_on FROM channel_closure c JOIN channel_node n ON n.id = c.ancestor_id
        WHERE c.descendant_id = ? AND n.kind = 'course' ORDER BY c.depth LIMIT 1`,
      [r.subject_node_id],
    );
    // the personal node, from the viewer's own vault (the request is bound to it)
    const node = ctx.db.get<{ id: string; kind: string; title: string }>('SELECT id, kind, title FROM library_node WHERE id = ? AND deleted_at IS NULL', [r.library_folder_id]);
    mappings.push({
      library_node_id: r.library_folder_id,
      library_node: node ?? null,
      subject: { id: r.subject_node_id, kind: 'subject', title: r.subject_title },
      course: course ? { id: course.id, kind: 'course', title: course.title, starts_on: course.starts_on, ends_on: course.ends_on } : null,
      add_new_lectures: r.add_new_lectures === 1,
      mapped_at: r.created_at,
    });
  }
  return { mappings };
}
