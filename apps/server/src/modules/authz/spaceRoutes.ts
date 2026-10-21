// The space-route allow-list (ARCHITECTURE_DELTA §5.5 gate 2, ADR-0003 §3.4). An existing or new module's route may be
// mounted under /api/spaces/:spaceId ONLY if it is listed here with its minimum access in THAT subject. The server
// refuses to start with an unlisted space route (authz onRoute hook), and a test enumerates the route table.
//
// P1-T1 step 1 lands the mechanism with an EMPTY list. In wave 2 only P1-T5 edits this file (official lectures,
// publications, the sources read routes of §5.5); `data`, `settings`, `control`, `auth`, `library`, `learning`,
// `exams`, `cases` and the sources write / purge routes are never listed.
import type { SpaceRouteGrant } from '../../system/binding';

export const SPACE_ROUTES: readonly SpaceRouteGrant[] = [];
