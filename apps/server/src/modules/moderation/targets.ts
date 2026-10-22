// What moderation can act on (P1-T4 step 2; review W2-step0 N3 — the seam T4 and T5 agreed on). Moderation owns the
// reports, the queue, the actions, the notices and the audit; the CONTENT stays with its owner track, which registers a
// handler per target type from its own plugin — P1-T5 step 3: `publication` (system index) and `publication_version`
// (the subject's space). Moderation never reads another track's tables:
//   resolve(target)              → the subject (scope) it belongs to, its title, its author, whether it is hidden,
//                                  and an in-app link — or null when it does not exist
//   visibleTo(viewer, target, i) → may this person see it right now (members of its subject while visible; the author
//                                  and the moderators while hidden …) — false is answered with the 404 of a missing id
//   setState(target, state, by)  → hide or restore it. Never deletes and never touches anyone's copy: followers and
//                                  forks keep what they had (PRD AOS-18.7, «copy, never move»)
// A type without a handler does not exist as far as any route can tell (404).
import type { ModerationTarget, ReportTargetType } from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { Viewer } from '../../system/binding';

export interface ModerationTargetInfo {
  /** the subject (or node) whose moderators decide */
  scopeNodeId: string;
  title: string;
  authorUserId: string | null;
  state: 'visible' | 'hidden';
  /** the in-app route that opens it (access re-checked there), or null */
  link: string | null;
}

export interface ModerationTargetHandler {
  type: ReportTargetType;
  resolve(target: ModerationTarget): ModerationTargetInfo | null;
  visibleTo(viewer: Viewer, target: ModerationTarget, info: ModerationTargetInfo): boolean;
  setState(target: ModerationTarget, state: 'visible' | 'hidden', by: { userId: string; reasonAr: string; actionId: string }): void;
}

export class ModerationTargets {
  private readonly handlers = new Map<ReportTargetType, ModerationTargetHandler>();

  /** `override` only for tests that stand in for the owner track's handler. */
  register(handler: ModerationTargetHandler, opts: { override?: boolean } = {}): void {
    if (this.handlers.has(handler.type) && !opts.override) throw new Error(`moderation target already registered: ${handler.type}`);
    this.handlers.set(handler.type, handler);
  }

  handler(type: ReportTargetType): ModerationTargetHandler | null {
    return this.handlers.get(type) ?? null;
  }

  types(): ReportTargetType[] {
    return [...this.handlers.keys()];
  }
}

const instances = new WeakMap<object, ModerationTargets>();

/** The target registry of an application context (created on first use: registration order does not matter). */
export function moderationTargetsOf(ctx: AppContext): ModerationTargets {
  let r = instances.get(ctx.system);
  if (!r) {
    r = new ModerationTargets();
    instances.set(ctx.system, r);
  }
  return r;
}
