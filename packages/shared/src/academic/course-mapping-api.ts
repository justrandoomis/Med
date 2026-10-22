// AOS-21.5 (ARCHITECTURE_DELTA §4.2 «Courses»): a channel `course` node is SHARED; a user's personal `library_node` of
// kind `course` stays in that user's vault, untouched. The mapping between the two is the user's «تابع المادة» with that
// personal node as the place new official lectures go (course_follow.library_folder_id). These are the views that read
// the mapping back from the PERSONAL side (Phase 1 completion C1).
import { z } from 'zod';

/** One of the viewer's mappings: a personal node of HER vault → a channel subject (and the shared course above it). */
export interface CourseMappingView {
  library_node_id: string;
  /** the personal node as it is now; null when it was deleted (new lectures then go to «موادي من القنوات») */
  library_node: { id: string; kind: string; title: string } | null;
  subject: { id: string; kind: 'subject'; title: string };
  /** the shared channel course (the Semester / Course level) above the subject; null when the tree has none */
  course: { id: string; kind: 'course'; title: string; starts_on: string | null; ends_on: string | null } | null;
  add_new_lectures: boolean;
  /** when the mapping was made (ms) */
  mapped_at: number;
}

/** GET /api/channels/course-mappings?library_node_id= — the viewer's own mappings (never anyone else's). */
export interface CourseMappingsResponse {
  mappings: CourseMappingView[];
}

export const courseMappingsQuerySchema = z
  .object({ library_node_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional() })
  .strict();
