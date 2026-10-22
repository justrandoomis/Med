// The space-route allow-list (ARCHITECTURE_DELTA §5.5 gate 2, ADR-0003 §3.4). An existing or new module's route may be
// mounted under /api/spaces/:spaceId ONLY if it is listed here with its minimum access in THAT subject. The server
// refuses to start with an unlisted space route (authz onRoute hook), and a test enumerates the route table.
//
// P1-T1 step 1 landed the mechanism with an EMPTY list. In wave 2 only P1-T5 edits this file (official lectures,
// publications, the sources read routes of §5.5); `data`, `settings`, `control`, `auth`, `library`, `learning`,
// `exams`, `cases` and the sources write / purge routes are never listed.
//
// Wave-2 step 0 DECLARED every route P1-T5 needs, with its minimum access and the authz check its handler makes, but
// registered none: the allow-list in force (`SPACE_ROUTES`) holds only declarations with `mounted: true`. P1-T5 step 1
// mounts the official-lecture, subject-content and re-mounted read routes (all served by `modules/lectures`). P1-T5
// flips `mounted` in the same change that mounts the handler (test/lectures/space-routes.contract.test.ts then requires
// the handler to exist; the boot hook refuses a mounted route that is not listed).
//
// Minimum access is gate 2 only — the coarse «may this viewer bind this subject's space for this route». It is
// computed per subject (membership or role on the subject node or an ancestor), never across subjects:
//  * `member`    — an approved member (or any role) of the subject;
//  * `moderator` — a moderating role in the subject (Subject Moderator, Assistant, Admin above it);
//  * `guest_publication` — not used in Phase 1: publications are course-only (public ones are Phase 2, PRD Q6).
// Contributor powers (drafts, uploads, attachments, correction proposals) are open to members at gate 2 and narrowed by
// the handler's `check` (authz rules in `rules/lectures.ts`, `rules/publications.ts`), as are author-only actions.
import type { SpaceAccess, SpaceRouteGrant } from '../../system/binding';
import type { Action, ResourceType } from './policy';

export interface SpaceRouteDeclaration extends SpaceRouteGrant {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** the module whose plugin mounts the handler */
  module: 'lectures' | 'forks' | 'sources' | 'versions' | 'files' | 'studybook';
  owner: 'P1-T5';
  /** the P1-T5 step that mounts it (BUILD_PLAN §3.7) */
  step: 1 | 2 | 3;
  /** true once the handler is mounted: only then is the route on the allow-list */
  mounted: boolean;
  /** the authz decision the handler asserts on top of gate 2 (`ctx.authz.assert(viewer, action, resource)`) */
  check: { action: Action; resource: ResourceType };
  /** where the route is specified */
  ref: string;
}

const S = '/api/spaces/:spaceId';

function declare(
  method: SpaceRouteDeclaration['method'],
  rest: string,
  minAccess: SpaceAccess,
  module: SpaceRouteDeclaration['module'],
  step: SpaceRouteDeclaration['step'],
  check: [Action, ResourceType],
  ref: string,
  mounted = false,
): SpaceRouteDeclaration {
  return { method, path: `${S}${rest}`, minAccess, module, owner: 'P1-T5', step, mounted, check: { action: check[0], resource: check[1] }, ref };
}

/** P1-T5 step 1 (BUILD_PLAN §3.7): the handler is mounted by the lectures module (`modules/lectures`). */
const MOUNTED = true;

export const SPACE_ROUTE_DECLARATIONS: readonly SpaceRouteDeclaration[] = [
  // ───── official lectures (§7.4; step 1) ─────
  declare('GET', '/lectures', 'member', 'lectures', 1, ['list', 'official_lecture'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  declare('POST', '/lectures', 'member', 'lectures', 1, ['create', 'official_lecture'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  declare('GET', '/lectures/:lectureId', 'member', 'lectures', 1, ['view', 'official_lecture'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  // title / number / date (lectures-api `patchOfficialLectureSchema`): a moderator, or a contributor on their own draft
  declare('PATCH', '/lectures/:lectureId', 'member', 'lectures', 1, ['edit', 'official_lecture'], 'ARCHITECTURE_DELTA §7.4; review W2-step0 R9', MOUNTED),
  declare('POST', '/lectures/:lectureId/upload', 'member', 'lectures', 1, ['create', 'official_lecture'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  declare('POST', '/lectures/:lectureId/approve', 'moderator', 'lectures', 1, ['approve', 'official_lecture'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  declare('POST', '/lectures/:lectureId/versions/:versionId/publish', 'moderator', 'lectures', 1, ['publish', 'official_lecture'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  declare('GET', '/lectures/:lectureId/versions/:versionId/compare/:toVersionId', 'member', 'lectures', 1, ['view', 'official_lecture'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  declare('POST', '/lectures/:lectureId/page-map/decisions', 'moderator', 'lectures', 1, ['edit', 'official_lecture'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  declare('POST', '/lectures/:lectureId/withdraw', 'moderator', 'lectures', 1, ['withdraw', 'official_lecture'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  // a contributor's correction goes to the review queue (rule action 'suggest'); a moderator's creates a new official
  // version (§6.7; rule action 'edit') — the handler asserts edit, else suggest
  declare('POST', '/lectures/:lectureId/corrections', 'member', 'lectures', 1, ['edit', 'official_lecture'], 'ARCHITECTURE_DELTA §7.4, §6.7', MOUNTED),
  declare('GET', '/lectures/:lectureId/offline-package', 'member', 'lectures', 1, ['view', 'official_lecture'], 'ARCHITECTURE_DELTA §5.5', MOUNTED),
  // «انشر كمحاضرة رسمية» (AOS-19H.4): with the private-lecture link of step 2
  declare('POST', '/lectures/from-vault', 'moderator', 'lectures', 2, ['create', 'official_lecture'], 'ARCHITECTURE_DELTA §7.4, §6.9', MOUNTED),

  // ───── subject content: attachments, exam dates, updates feed (§7.4, 3010; step 1) ─────
  declare('GET', '/subject/attachments', 'member', 'lectures', 1, ['list', 'space'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  // a contributor's attachment starts as a draft a moderator publishes (§5.3 «d»)
  declare('POST', '/subject/attachments', 'member', 'lectures', 1, ['publish', 'space'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  declare('PATCH', '/subject/attachments/:attachmentId', 'moderator', 'lectures', 1, ['publish', 'space'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  declare('GET', '/subject/exam-dates', 'member', 'lectures', 1, ['list', 'space'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  declare('PUT', '/subject/exam-dates/:examDateId', 'moderator', 'lectures', 1, ['publish', 'space'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  declare('DELETE', '/subject/exam-dates/:examDateId', 'moderator', 'lectures', 1, ['publish', 'space'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  declare('GET', '/subject/events', 'member', 'lectures', 1, ['list', 'space'], 'ARCHITECTURE_DELTA §7.4', MOUNTED),
  // P1-T5 step 1 additions (review W2-step0 N1; AOS-18.9, 18.11): the corrections queue and its decision, the duplicate
  // files of the subject — official moderators of THIS subject (the handler narrows «moderator» access: an Assistant
  // passes gate 2 but holds no power over official content, Q5)
  declare('GET', '/subject/corrections', 'moderator', 'lectures', 1, ['list', 'space'], 'ARCHITECTURE_DELTA §6.7; P1-T5 step 1', MOUNTED),
  declare('POST', '/lectures/:lectureId/corrections/:correctionId/decide', 'moderator', 'lectures', 1, ['edit', 'official_lecture'], 'ARCHITECTURE_DELTA §6.7; P1-T5 step 1', MOUNTED),
  declare('GET', '/subject/duplicates', 'moderator', 'lectures', 1, ['list', 'space'], 'ARCHITECTURE_DELTA §5.3; P1-T5 step 1 (AOS-18.11)', MOUNTED),

  // ───── existing read routes re-mounted on the space for official content (§5.5; published versions only, drafts
  //       for moderators — the handler checks the lecture's status). Paths keep the existing modules' own params.
  //       P1-T5 step 1: the lectures module mounts them and calls those modules' own services inside the space
  //       binding (the sources / versions / files plugins themselves stay vault-only); `module` names whose view it is. ─────
  // Their ids name a source, page, version or file — not a lecture — so `check` alone cannot see the lecture's status
  // (review W2-step0, note for P1-T5): each handler first resolves the OWNING official lecture or subject attachment
  // in this space and applies ITS rules — a draft only for moderators and its uploader, nothing of a withdrawn lecture's
  // files once a rights takedown ran, a `moderators` attachment only for moderators — and an id that is not in this
  // space, or belongs to no published lecture the viewer may see, answers the body of a missing route (404).
  declare('GET', '/sources/:id', 'member', 'sources', 1, ['view', 'official_lecture'], 'ARCHITECTURE_DELTA §5.5', MOUNTED),
  declare('GET', '/sources/:id/versions/:versionId/pages', 'member', 'sources', 1, ['view', 'official_lecture'], 'ARCHITECTURE_DELTA §5.5', MOUNTED),
  declare('GET', '/sources/pages/:id/regions', 'member', 'sources', 1, ['view', 'official_lecture'], 'ARCHITECTURE_DELTA §5.5', MOUNTED),
  declare('GET', '/sources/versions/:id/processing', 'moderator', 'sources', 1, ['view', 'official_lecture'], 'ARCHITECTURE_DELTA §5.5', MOUNTED),
  declare('POST', '/sources/versions/:id/reprocess', 'moderator', 'sources', 1, ['edit', 'official_lecture'], 'ARCHITECTURE_DELTA §5.5', MOUNTED),
  declare('GET', '/versions/pages/:id/thumbnail', 'member', 'versions', 1, ['view', 'official_lecture'], 'ARCHITECTURE_DELTA §5.5', MOUNTED),
  declare('GET', '/versions/versions/:id/toc', 'member', 'versions', 1, ['view', 'official_lecture'], 'ARCHITECTURE_DELTA §5.5', MOUNTED),
  declare('GET', '/versions/versions/:id/files', 'member', 'versions', 1, ['view', 'official_lecture'], 'ARCHITECTURE_DELTA §5.5', MOUNTED),
  declare('GET', '/files/:id', 'member', 'files', 1, ['view', 'file'], 'ARCHITECTURE_DELTA §5.5', MOUNTED),
  declare('GET', '/files/:id/meta', 'member', 'files', 1, ['view', 'file'], 'ARCHITECTURE_DELTA §5.5', MOUNTED),
  // NOT mounted in step 1: a signed link to a SPACE file cannot be redeemed yet — P1-T1's `GET /api/files/t/:token`
  // binds vaults only (system/tenancy.ts bindingForFileToken); the space's own GET /files/:id serves members meanwhile
  declare('POST', '/files/:id/token', 'member', 'files', 1, ['view', 'file'], 'ARCHITECTURE_DELTA §5.5'),
  // official-only shared Study Book artifacts stored in the space (read only; generated from a vault-bound request)
  declare('GET', '/studybook/artifacts', 'member', 'studybook', 2, ['view', 'official_lecture'], 'ARCHITECTURE_DELTA §5.5, §10.6'),
  declare('GET', '/studybook/artifacts/:id', 'member', 'studybook', 2, ['view', 'official_lecture'], 'ARCHITECTURE_DELTA §5.5, §10.6'),

  // ───── course-only publications (§7.6, Phase 1 part; step 3). Suggestions are Phase 2 and not declared. ─────
  // P1-T5 step 3 mounts them (forks/publications.ts, registered by the lectures plugin under /api/spaces)
  declare('POST', '/publications', 'member', 'forks', 3, ['create', 'publication'], 'ARCHITECTURE_DELTA §7.6', MOUNTED),
  // author only (the rule answers 403 to a member who can see it, 404 to anyone else)
  declare('POST', '/publications/:publicationId/versions', 'member', 'forks', 3, ['edit', 'publication'], 'ARCHITECTURE_DELTA §7.6', MOUNTED),
  declare('PATCH', '/publications/:publicationId', 'member', 'forks', 3, ['edit', 'publication'], 'ARCHITECTURE_DELTA §7.6', MOUNTED),
  declare('POST', '/publications/:publicationId/withdraw', 'member', 'forks', 3, ['withdraw', 'publication'], 'ARCHITECTURE_DELTA §7.6', MOUNTED),
  declare('GET', '/publications/:publicationId', 'member', 'forks', 3, ['view', 'publication'], 'ARCHITECTURE_DELTA §7.6', MOUNTED),
  declare('GET', '/publications/:publicationId/versions/:versionNo/items', 'member', 'forks', 3, ['view', 'publication'], 'ARCHITECTURE_DELTA §7.6, §5.2', MOUNTED),
  declare('GET', '/publications/:publicationId/diff', 'member', 'forks', 3, ['view', 'publication'], 'ARCHITECTURE_DELTA §7.6', MOUNTED),
  declare('GET', '/lectures/:lectureId/publications', 'member', 'forks', 3, ['list', 'publication'], 'ARCHITECTURE_DELTA §7.6', MOUNTED),
];

/** The allow-list in force: declarations whose handler is mounted (P1-T5 step 1: the lectures module's routes). */
export const SPACE_ROUTES: readonly SpaceRouteGrant[] = SPACE_ROUTE_DECLARATIONS.filter((d) => d.mounted);
