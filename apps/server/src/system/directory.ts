// The public directory of the system DB (Academic OS P1-T5 step 1): the few fields OTHER users may see — a person's
// display name (UserRef, ARCHITECTURE_DELTA §7.1) and a subject space's title — read at request time, so a renamed or
// deleted account shows its current name («طالب سابق») everywhere at once (PRD Q14, AOS-21.44).
//
// It lives in src/system/ (the only layer that touches the system DB handle, import-boundary test) and takes the
// viewer like every repository: the caller has already been authorised for the content that names these people
// (e.g. gate 2 bound the subject's space), and nothing else about an account — login name, status details, devices —
// ever leaves here.
import type { UserRef } from '@medlevo/shared';
import type { Viewer } from './binding';
import type { SystemRepos } from './repos';

export const FORMER_USER_AR = 'طالب سابق';

export interface PublicDirectory {
  /** Display references for user ids (unknown or deleted accounts → «طالب سابق», `former: true`). */
  userRefs(viewer: Viewer, ids: readonly (string | null | undefined)[]): Map<string, UserRef>;
  /** The title of a registered space (the subject's name at creation; P1-T4 keeps it current), or null. */
  spaceTitle(viewer: Viewer, spaceId: string): string | null;
}

export function publicDirectory(system: SystemRepos): PublicDirectory {
  const db = system.db;
  return {
    userRefs(_viewer, ids) {
      const wanted = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
      const out = new Map<string, UserRef>();
      for (let i = 0; i < wanted.length; i += 500) {
        const chunk = wanted.slice(i, i + 500);
        const rows = db.all<{ id: string; display_name: string; status: string }>(
          `SELECT id, display_name, status FROM user_account WHERE id IN (${chunk.map(() => '?').join(',')})`,
          chunk,
        );
        for (const r of rows) {
          const former = r.status === 'deleted' || !r.display_name.trim();
          out.set(r.id, { id: r.id, display_name: former ? FORMER_USER_AR : r.display_name, avatar_url: null, ...(former ? { former: true } : {}) });
        }
      }
      for (const id of wanted) if (!out.has(id)) out.set(id, { id, display_name: FORMER_USER_AR, avatar_url: null, former: true });
      return out;
    },
    spaceTitle(_viewer, spaceId) {
      return db.get<{ title: string }>('SELECT title FROM space WHERE id = ?', [spaceId])?.title ?? null;
    },
  };
}
