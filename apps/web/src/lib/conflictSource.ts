// AOS-20.19 «حالة التعارض واضحة»: every conflict the app shows says WHERE the newer copy came from — «جهاز آخر لك»
// (the same account, another of its devices) or «مستخدم آخر» (another person). It is decided from what the client
// knows for certain, never guessed:
//   * an op of the account's own vault (outbox `target` absent or 'vault'): a vault has one writer — its user. The
//     server records the SESSION's user as the actor of every op (AOS-21.29) and refuses a write to another user's
//     vault, so the newer copy there can only come from another device of the same account (or this account's own
//     earlier write that a server job applied for it) → «جهاز آخر لك»;
//   * an op of a subject space (`space:<id>`), or a shared record whose newer state names who wrote it: another person
//     unless the record says it was this account → «مستخدم آخر»;
//   * a decision on a shared record (a membership, a report…) taken by someone else first: the record's `decided_by`.
// Multi-writer layers (Phase 4) merge concurrent edits without a conflict at all (AOS-20.19, second half): nothing
// here is shown for them.
import type { SyncTarget } from './localdb';

export type ConflictSource = 'own_device' | 'other_user';

export const CONFLICT_SOURCE_AR: Record<ConflictSource, string> = {
  own_device: 'جهاز آخر لك',
  other_user: 'مستخدم آخر',
};

/** «نسخة محفوظة من تعارض» on a note kept from a conflict of the account's own vault (always another of its devices). */
export const VAULT_CONFLICT_COPY_AR = `نسخة محفوظة من تعارض مع ${CONFLICT_SOURCE_AR.own_device}`;

type UserLike = string | { id?: unknown } | null | undefined;

function idOf(u: UserLike): string | null {
  if (typeof u === 'string') return u || null;
  if (u && typeof u === 'object' && typeof u.id === 'string') return u.id || null;
  return null;
}

/** The person a server copy names as its writer, when it names one (author / actor / last editor / decider). */
export function writerOf(entity: unknown): string | null {
  if (!entity || typeof entity !== 'object') return null;
  const e = entity as Record<string, UserLike>;
  for (const key of ['updated_by', 'actor_user_id', 'decided_by', 'author_user_id'] as const) {
    const id = idOf(e[key]);
    if (id) return id;
  }
  return null;
}

/**
 * Where the newer copy of a synced record came from. `viewerUserId` is the signed-in account (null when the page does
 * not know it yet: then only the target decides).
 */
export function syncConflictSource(op: { target?: SyncTarget | null; resultEntity?: unknown }, viewerUserId: string | null): ConflictSource {
  const writer = writerOf(op.resultEntity);
  const inSpace = typeof op.target === 'string' && op.target.startsWith('space:');
  if (!inSpace) {
    // the vault's only writer is its user: a writer field there names this account (an item authored by someone else
    // in the vault — a followed explanation — is read-only and never conflicts)
    return 'own_device';
  }
  if (writer && viewerUserId && writer === viewerUserId) return 'own_device';
  return 'other_user';
}

/** Who took a decision first on a shared record (`decided_by` of the record now on the server). */
export function decisionSource(decidedBy: UserLike, viewerUserId: string | null): ConflictSource {
  const id = idOf(decidedBy);
  return id && viewerUserId && id === viewerUserId ? 'own_device' : 'other_user';
}

/**
 * The sentence an admin reads when their decision found the request already decided: by another person (named), or
 * by themselves on another of their devices.
 */
export function decidedElsewhereAr(decidedBy: { id: string; display_name: string } | null, viewerUserId: string | null): string {
  const source = decisionSource(decidedBy, viewerUserId);
  // (C3 review R5) the record names the account, not the device: a retry from THIS device after a lost answer lands
  // here too, so both are said — never «another device» as a certainty
  if (source === 'own_device') return `قرّرتَ هذا الطلب قبل قليل (من هذا الجهاز أو من ${CONFLICT_SOURCE_AR.own_device})؛ لم يُسجَّل القرار مرة ثانية.`;
  const who = decidedBy?.display_name ? `«${decidedBy.display_name}»` : 'مشرف آخر';
  return `سبقك ${CONFLICT_SOURCE_AR.other_user}: قرّر ${who} هذا الطلب قبلك، فلم يُسجَّل قرارك. القائمة محدّثة الآن.`;
}
