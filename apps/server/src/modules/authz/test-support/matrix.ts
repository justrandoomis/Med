// The generated permission matrix (PRD X9, AOS-2.14, 18.6, 21.37; ARCHITECTURE_DELTA §5.7; P1-T4 step 1).
//
// A matrix spec states, for ONE resource type, the expected outcome of every (principal, action, target) — written
// from ARCHITECTURE_DELTA §5.3 / PRD §4.3, independently of the rules that implement them. `runMatrix` asks the real
// policy (`ctx.authz.can`) for every combination of every spec and reports each mismatch, so a rule that grants too
// much, or hides what should be a 403 (or the other way round), fails with its exact case.
//
// Tracks add their resources by adding a spec (P1-T5: official_lecture, publication, layer, file …); the matrix test
// refuses to pass while a resource type has a registered rule and no spec (`uncoveredResourceTypes`).
// Test support only: imported by tests, never by a route.
import type { Viewer } from '../../../system/binding';
import type { Action, Authz, Decision, Resource, ResourceType } from '../policy';

/** allow · 403 FORBIDDEN (or another visible refusal) · 404 (hidden, the body of a missing id) · 403 MEMBERSHIP_PENDING */
export type Outcome = 'allow' | 'forbidden' | 'hidden' | 'pending';

/** Every action of the policy, so an action nobody thought of is still asked (and must be denied). */
export const ALL_ACTIONS: readonly Action[] = [
  'view', 'list', 'create', 'edit', 'delete', 'publish', 'approve', 'withdraw', 'moderate',
  'fork', 'follow', 'comment', 'suggest', 'vote', 'rate', 'write_layer', 'manage_members', 'manage_codes',
  'assign_role', 'record', 'share_recording', 'view_audit', 'view_stats', 'set_quota', 'operate',
];

/**
 * Every resource type of the policy (a `Record` over the union, so adding a type to `Resource` without listing it here
 * fails to compile). The matrix asks every type — those no rule decides on yet must be hidden from everyone (deny by
 * default), so a forgotten rule shows up as a test failure instead of an accidental allow (review P1-T4 step 1).
 */
const RESOURCE_TYPE_SET: Record<ResourceType, true> = {
  platform: true,
  vault: true,
  channel_node: true,
  space: true,
  official_lecture: true,
  publication: true,
  layer: true,
  discussion: true,
  collab_doc: true,
  room: true,
  recording: true,
  file: true,
};
export const ALL_RESOURCE_TYPES = Object.keys(RESOURCE_TYPE_SET) as ResourceType[];

/** A well-formed resource of each type that names nothing in particular (for the deny-by-default sweep). */
export function sampleResource(type: ResourceType, ids: { spaceId: string; vaultId: string; ownerUserId: string; nodeId: string }): Resource {
  switch (type) {
    case 'platform':
      return { type, operation: 'GET /api/data/backups' };
    case 'vault':
      return { type, vaultId: ids.vaultId, ownerUserId: ids.ownerUserId };
    case 'channel_node':
      return { type, id: ids.nodeId };
    case 'space':
      return { type, id: ids.spaceId };
    case 'official_lecture':
      return { type, spaceId: ids.spaceId, id: 'L-SAMPLE', status: 'published', subjectNodeId: ids.nodeId };
    case 'publication':
      return { type, id: 'P-SAMPLE' };
    case 'layer':
      return { type, db: `s:${ids.spaceId}`, id: 'LY-SAMPLE', kind: 'group_comments', ownerUserId: ids.ownerUserId };
    case 'discussion':
      return { type, spaceId: ids.spaceId, threadId: 'T-SAMPLE', audience: 'course', audienceRef: null };
    case 'collab_doc':
      return { type, spaceId: ids.spaceId, id: 'CD-SAMPLE' };
    case 'room':
      return { type, spaceId: ids.spaceId, id: 'R-SAMPLE' };
    case 'recording':
      return { type, db: `s:${ids.spaceId}`, id: 'REC-SAMPLE' };
    case 'file':
      return { type, db: `s:${ids.spaceId}`, fileId: 'F-SAMPLE' };
  }
}

/** Resource types no registered rule decides on (deny by default: everyone gets the 404). */
export function unruledResourceTypes(authz: Authz): ResourceType[] {
  const ruled = new Set(authz.rules().map((r) => r.resource));
  return ALL_RESOURCE_TYPES.filter((t) => !ruled.has(t));
}

export interface MatrixTarget {
  /** a readable name used in failure messages */
  key: string;
  resource: Resource;
}

export interface MatrixSpec {
  resource: ResourceType;
  /** the actions to ask (default: every action) */
  actions?: readonly Action[];
  targets: readonly MatrixTarget[];
  expect(principal: string, action: Action, target: string): Outcome;
}

export interface MatrixPrincipal {
  key: string;
  viewer: Viewer;
}

export function outcomeOf(d: Decision): Outcome {
  if (d.allowed) return 'allow';
  if (!d.reason || d.reason.hide) return 'hidden';
  return d.reason.code === 'MEMBERSHIP_PENDING' ? 'pending' : 'forbidden';
}

export interface MatrixReport {
  cases: number;
  failures: string[];
  /** cases per resource type */
  byResource: Record<string, number>;
  /** outcomes seen (a matrix where every case is «hidden» proves little) */
  outcomes: Record<Outcome, number>;
}

export function runMatrix(authz: Authz, principals: readonly MatrixPrincipal[], specs: readonly MatrixSpec[]): MatrixReport {
  const report: MatrixReport = { cases: 0, failures: [], byResource: {}, outcomes: { allow: 0, forbidden: 0, hidden: 0, pending: 0 } };
  for (const spec of specs) {
    for (const target of spec.targets) {
      if (target.resource.type !== spec.resource) throw new Error(`matrix spec ${spec.resource}: target ${target.key} is a ${target.resource.type}`);
      for (const action of spec.actions ?? ALL_ACTIONS) {
        for (const p of principals) {
          const want = spec.expect(p.key, action, target.key);
          const got = outcomeOf(authz.can(p.viewer, action, target.resource));
          report.cases++;
          report.byResource[spec.resource] = (report.byResource[spec.resource] ?? 0) + 1;
          report.outcomes[got]++;
          if (got !== want) report.failures.push(`${spec.resource}:${action} ${target.key} as ${p.key}: expected ${want}, got ${got}`);
        }
      }
    }
  }
  return report;
}

/** Resource types some registered rule decides on but no spec covers (the matrix must gain every new resource). */
export function uncoveredResourceTypes(authz: Authz, specs: readonly MatrixSpec[]): ResourceType[] {
  const covered = new Set(specs.map((s) => s.resource));
  const ruled = new Set(authz.rules().map((r) => r.resource));
  return [...ruled].filter((t) => !covered.has(t)).sort();
}
