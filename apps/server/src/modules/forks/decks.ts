// The deck of a publication — «ادرس هذه البطاقات» (AOS-21.27; ARCHITECTURE_DELTA §10.4 «community cards are copy-on-use
// into the vault. Each user keeps their own FSRS state»).
//
//  * Publishing (publications.ts, PublishRequest `include_cards`): the author's OWN text cards on the lecture (cards in
//    their vault whose `source_id` is their copy of it — basic and cloze; not picture cards, generated cards, cards from
//    mistakes or cards copied from someone else's deck) are written into the space as `publication_card` rows with the
//    same version model as the explanation's items: one STABLE id per card in every version, a row per content change.
//    Only the text and the kind are published — no evidence id, concept, file, review event or schedule.
//  * Studying (vault routes under /api/copies/decks): a member copies the deck into their OWN vault — ordinary
//    `flashcard` rows of that vault. Their review log (`review_event`) and FSRS state (`review_state`) live there and are
//    nobody else's: one student's reviews never touch another's, and the author's later edits never touch either.
//  * Updates: a newer deck version is offered as a preview (counts + what of the student's own edits stays). Applying it
//    adds new cards, rewrites the text of the changed cards the student did NOT edit (card id, review log and schedule
//    unchanged), and tombstones removed ones the student did not edit (their review log stays). A card the student
//    edited is theirs: its text is never overwritten. «تخطَّ هذا الإصدار» skips that version.
//  * Who may: an approved member of the subject (anybody else gets the body of a missing item), not the author, while
//    the publication is active. A hidden / withdrawn publication stops updating; the copied cards stay.
import { createHash } from 'node:crypto';
import {
  deckUpdateSummaryAr,
  PUBLICATION_DECK_MAX_CARDS,
  parseRichText,
  stableStringify,
  type ApplyDeckUpdateRequest,
  type ApplyDeckUpdateResponse,
  type DeckCardView,
  type DeckCopyView,
  type DeckUpdatePreview,
  type PublicationDeckView,
  type RichText,
  type StudyDeckRequest,
  type StudyDeckResponse,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson, type Db } from '../../db/db';
import { AppError } from '../../lib/errors';
import type { Viewer } from '../../system/binding';
import { publicDirectory } from '../../system/directory';
import type { PublicationResource } from '../authz/rules/publications';
import { insertCard, type CleanRefs } from '../learning/cards';
import { findCard, indexCard, type FlashcardRow } from '../learning/store';
import { memberOf, notFound } from './copies';
import { publicationStatusNoteAr } from './following';
import { stableItemId, versionRow } from './pubItems';
import { derivedId, spaceDb, stubOf } from './stubs';
import { publicationIndex, type PublicationRow } from './system';

const AR = {
  noCards: 'لا توجد بطاقات في هذا الشرح لتدرسها.',
  noCopy: 'لم تبدأ دراسة بطاقات هذا الشرح بعد.',
  stale: 'صدر إصدار أحدث من البطاقات بعد أن فتحت التغييرات؛ راجعها من جديد قبل التطبيق. لم يتغير شيء.',
  formerMember: 'لم تعد عضوًا في هذه المادة؛ بطاقاتك باقية في مراجعتك، ولا تصلها تحديثات الشرح.',
} as const;

const SKIP_AR = {
  picture: 'بطاقات الإخفاء على الصور لا تُنشر في هذا الإصدار؛ تبقى عندك.',
  generated: 'البطاقات المولَّدة آليًا لا تُنشر باسمك؛ تبقى عندك.',
  mistake: 'بطاقات أخطائك شخصية ولا تُنشر.',
  other_author: 'بطاقات أخذتها من شرح زميل لا تُنشر باسمك.',
  too_many: `يُنشر ${PUBLICATION_DECK_MAX_CARDS} بطاقة على الأكثر مع الشرح؛ البقية تبقى عندك.`,
} as const;

// ───────────────────────── the canonical card (what is published) ─────────────────────────

export interface CanonicalCard {
  t: 'card';
  kind: 'basic' | 'cloze';
  front: RichText;
  back: RichText;
  cloze_index: number | null;
  /** the cloze note the card belongs to (stable per publication), so a reader's siblings stay one note */
  note_key: string | null;
}

export interface DeckSnapshotCard {
  stableId: string;
  item: CanonicalCard;
  hash: string;
}

export interface PublicationCardRow {
  publication_id: string;
  card_id: string;
  valid_from: number;
  valid_to: number | null;
  content_hash: string;
  row_json: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const hashCard = (c: CanonicalCard) => sha(stableStringify(c));

/** The text of a vault card as an update compares it (edit detection; independent of rev and schedule). */
function textHash(kind: string, frontJson: string, backJson: string, clozeIndex: number | null): string {
  return sha(stableStringify({ kind, front: fromJson(frontJson), back: fromJson(backJson), cloze_index: clozeIndex }));
}

// ───────────────────────── the author's side (publish / republish) ─────────────────────────

/**
 * The author's publishable cards on their copy of the lecture — read in the BOUND vault (the author's own; the caller
 * binds it). Their ids become stable ids of this publication; what is left out is counted per reason.
 */
export function readAuthorDeck(ctx: AppContext, sourceId: string, publicationId: string): { cards: DeckSnapshotCard[]; skipped: Map<string, number> } {
  const rows = ctx.db.all<FlashcardRow>(
    'SELECT * FROM flashcard WHERE source_id = ? AND deleted_at IS NULL AND merged_into_id IS NULL ORDER BY created_at, id',
    [sourceId],
  );
  const copied = new Set(ctx.db.all<{ card_id: string }>('SELECT card_id FROM deck_copy_card').map((r) => r.card_id));
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  const cards: DeckSnapshotCard[] = [];
  for (const r of rows) {
    if (copied.has(r.id)) {
      skip(SKIP_AR.other_author);
      continue;
    }
    if (r.kind !== 'basic' && r.kind !== 'cloze') {
      skip(r.kind === 'mistake' ? SKIP_AR.mistake : SKIP_AR.picture);
      continue;
    }
    if (r.origin === 'generated') {
      skip(SKIP_AR.generated);
      continue;
    }
    if (r.origin === 'from_mistake') {
      skip(SKIP_AR.mistake);
      continue;
    }
    if (cards.length >= PUBLICATION_DECK_MAX_CARDS) {
      skip(SKIP_AR.too_many);
      continue;
    }
    const item: CanonicalCard = {
      t: 'card',
      kind: r.kind,
      front: parseRichText(fromJson(r.front_json)),
      back: parseRichText(fromJson(r.back_json)),
      cloze_index: r.kind === 'cloze' ? r.cloze_index : null,
      note_key: r.kind === 'cloze' && r.note_id ? stableItemId(publicationId, `note:${r.note_id}`) : null,
    };
    cards.push({ stableId: stableItemId(publicationId, `card:${r.id}`), item, hash: hashCard(item) });
  }
  return { cards, skipped };
}

/** The cards valid at version n of a publication, by stable id (space handle). */
export function cardsAt(space: Db, publicationId: string, versionNo: number): Map<string, PublicationCardRow> {
  if (versionNo <= 0) return new Map();
  const rows = space.all<PublicationCardRow>(
    'SELECT * FROM publication_card WHERE publication_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY card_id',
    [publicationId, versionNo, versionNo],
  );
  return new Map(rows.map((r) => [r.card_id, r]));
}

/** Write the deck of version n into the space (inside the caller's transaction): rows for added / changed cards only. */
export function writeDeckVersion(space: Db, publicationId: string, versionNo: number, cards: readonly DeckSnapshotCard[]): void {
  const head = versionNo > 1 ? cardsAt(space, publicationId, versionNo - 1) : new Map<string, PublicationCardRow>();
  const next = new Map(cards.map((c) => [c.stableId, c]));
  for (const [id, row] of head) {
    const n = next.get(id);
    if (!n || n.hash !== row.content_hash) space.run('UPDATE publication_card SET valid_to = ? WHERE publication_id = ? AND card_id = ? AND valid_from = ? AND valid_to IS NULL', [versionNo, publicationId, id, row.valid_from]);
  }
  for (const [id, n] of next) {
    const old = head.get(id);
    if (old && old.content_hash === n.hash) continue;
    space.run('INSERT INTO publication_card (publication_id, card_id, valid_from, valid_to, content_hash, row_json) VALUES (?, ?, ?, NULL, ?, ?)', [publicationId, id, versionNo, n.hash, toJson(n.item)]);
  }
}

function diffCards(space: Db, publicationId: string, from: number, to: number) {
  const a = cardsAt(space, publicationId, from);
  const b = cardsAt(space, publicationId, to);
  const added: PublicationCardRow[] = [];
  const changed: PublicationCardRow[] = [];
  const removed: PublicationCardRow[] = [];
  for (const [id, row] of b) {
    const old = a.get(id);
    if (!old) added.push(row);
    else if (old.content_hash !== row.content_hash) changed.push(row);
  }
  for (const [id, row] of a) if (!b.has(id)) removed.push(row);
  return { added, changed, removed };
}

const parseCard = (r: Pick<PublicationCardRow, 'row_json'>) => fromJson<CanonicalCard>(r.row_json) as CanonicalCard;

function cardView(r: PublicationCardRow): DeckCardView {
  const c = parseCard(r);
  return { item_id: r.card_id, kind: c.kind, front: c.front, back: c.back, cloze_index: c.cloze_index };
}

// ───────────────────────── the reader's side (their own vault) ─────────────────────────

interface DeckCopyRow {
  id: string;
  origin_space_id: string;
  publication_id: string;
  author_user_id: string;
  applied_version_no: number;
  skipped_version_no: number | null;
  created_device_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface DeckCopyCardRow {
  copy_id: string;
  item_id: string;
  card_id: string;
  applied_hash: string;
}

interface Pub {
  pub: PublicationRow;
  space: Db;
}

function pubOf(ctx: AppContext, viewer: Viewer, spaceId: string, publicationId: string): Pub {
  if (!memberOf(ctx, viewer, spaceId)) throw notFound();
  const pub = publicationIndex(ctx).get(publicationId);
  if (!pub || pub.space_id !== spaceId) throw notFound();
  const space = spaceDb(ctx, spaceId);
  if (!space) throw notFound();
  return { pub, space };
}

function resource(ctx: AppContext, viewer: Viewer, pub: PublicationRow): PublicationResource {
  return { type: 'publication', id: pub.id, spaceId: pub.space_id, authorUserId: pub.author_user_id, status: pub.status, viewerHoldsCopy: publicationIndex(ctx).holds(viewer.userId, pub.id) };
}

function copyOf(ctx: AppContext, publicationId: string): DeckCopyRow | null {
  return ctx.db.get<DeckCopyRow>('SELECT * FROM deck_copy WHERE publication_id = ? AND deleted_at IS NULL', [publicationId]) ?? null;
}

function mappings(ctx: AppContext, copyId: string): Map<string, DeckCopyCardRow> {
  return new Map(ctx.db.all<DeckCopyCardRow>('SELECT * FROM deck_copy_card WHERE copy_id = ?', [copyId]).map((r) => [r.item_id, r]));
}

/** The student changed this card's text (or deleted it) since the deck last wrote it: it is theirs now. */
function editedByStudent(ctx: AppContext, m: DeckCopyCardRow): boolean {
  const card = findCard(ctx.db, m.card_id);
  if (!card || card.deleted_at !== null) return true;
  return textHash(card.kind, card.front_json, card.back_json, card.cloze_index) !== m.applied_hash;
}

/** The newest deck version the copy could move to, with its preview (null: nothing waits). */
function pendingUpdate(ctx: AppContext, copy: DeckCopyRow, p: Pub | null): DeckUpdatePreview | null {
  if (!p || p.pub.status !== 'active') return null;
  const head = p.pub.head_version_no;
  if (head <= copy.applied_version_no || copy.skipped_version_no === head) return null;
  const d = diffCards(p.space, p.pub.id, copy.applied_version_no, head);
  const counts = { added: d.added.length, removed: d.removed.length, changed: d.changed.length };
  if (counts.added + counts.removed + counts.changed === 0) return null;
  const m = mappings(ctx, copy.id);
  let kept = 0;
  for (const r of [...d.changed, ...d.removed]) {
    const map = m.get(r.card_id);
    if (map && editedByStudent(ctx, map)) kept++;
  }
  return {
    publication_id: p.pub.id,
    from_version_no: copy.applied_version_no,
    to_version_no: head,
    change_note: versionRow(p.space, p.pub.id, head)?.change_note ?? null,
    counts,
    kept_yours: kept,
    summary_ar: deckUpdateSummaryAr(counts, kept),
  };
}

function copyView(ctx: AppContext, viewer: Viewer, copy: DeckCopyRow): DeckCopyView {
  const pub = publicationIndex(ctx).get(copy.publication_id);
  const member = memberOf(ctx, viewer, copy.origin_space_id);
  const space = member ? spaceDb(ctx, copy.origin_space_id) : null;
  const p = pub && space ? { pub, space } : null;
  const live =
    ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deck_copy_card m JOIN flashcard f ON f.id = m.card_id WHERE m.copy_id = ? AND f.deleted_at IS NULL', [copy.id])?.n ?? 0;
  const authorId = pub?.author_user_id ?? copy.author_user_id;
  return {
    publication_id: copy.publication_id,
    space_id: copy.origin_space_id,
    title: pub?.title ?? '',
    author: publicDirectory(ctx.system).userRefs(viewer, [authorId]).get(authorId)!,
    applied_version_no: copy.applied_version_no,
    head_version_no: pub?.head_version_no ?? copy.applied_version_no,
    cards: live,
    status_note_ar: !member ? AR.formerMember : pub ? publicationStatusNoteAr(pub) : null,
    update: pendingUpdate(ctx, copy, p),
    created_at: copy.created_at,
  };
}

/** A published card as a new card of the bound vault (an ordinary owner card: the student's from now on). */
function insertDeckCard(ctx: AppContext, copy: DeckCopyRow, r: PublicationCardRow, versionNo: number, refs: CleanRefs, deviceId: string | null): DeckCopyCardRow {
  const c = parseCard(r);
  const cardId = derivedId('fc', copy.id, r.card_id);
  const row = insertCard(
    ctx,
    {
      id: cardId,
      kind: c.kind,
      front: c.front,
      back: c.back,
      refs,
      origin: 'owner',
      origin_ref: { publication_deck: { space_id: copy.origin_space_id, publication_id: copy.publication_id, item_id: r.card_id, version_no: versionNo, author_user_id: copy.author_user_id } },
      note_id: c.note_key ? derivedId('fn', copy.id, c.note_key) : null,
      cloze_index: c.cloze_index,
      image: null,
      device_id: deviceId,
      created_at: ctx.clock.now(),
    },
    (t, id) => void ctx.sync.touch(t, id),
  );
  const m: DeckCopyCardRow = { copy_id: copy.id, item_id: r.card_id, card_id: row.id, applied_hash: textHash(row.kind, row.front_json, row.back_json, row.cloze_index) };
  ctx.db.run('INSERT INTO deck_copy_card (copy_id, item_id, card_id, applied_hash) VALUES (?, ?, ?, ?) ON CONFLICT(copy_id, item_id) DO UPDATE SET card_id = excluded.card_id, applied_hash = excluded.applied_hash', [
    m.copy_id,
    m.item_id,
    m.card_id,
    m.applied_hash,
  ]);
  return m;
}

/** The student's copy of the lecture, when they have one: the copied cards link to it (by-lecture review, forecast). */
function refsFor(ctx: AppContext, spaceId: string, lectureId: string): CleanRefs {
  const stub = stubOf(ctx, spaceId, lectureId);
  const live = stub && stub.deleted_at === null ? stub : null;
  return { source_id: live?.id ?? null, source_version_id: live?.current_version_id ?? null, concept_id: null, topic_id: null, evidence_ids: [], snapshot: [], region_ids: [], notes_ar: [] };
}

/** GET /api/copies/decks/:publicationId?space_id= — the deck the viewer may read, and their copy of it. */
export function deckOf(ctx: AppContext, viewer: Viewer, spaceId: string, publicationId: string): PublicationDeckView {
  const p = pubOf(ctx, viewer, spaceId, publicationId);
  ctx.authz.assert(viewer, 'view', resource(ctx, viewer, p.pub));
  const copy = copyOf(ctx, publicationId);
  const isAuthor = p.pub.author_user_id === viewer.userId;
  // a reader of a hidden / withdrawn explanation reads the deck version their copy took, never one published after it
  const readable = p.pub.status === 'active' || isAuthor ? p.pub.head_version_no : copy ? Math.min(copy.applied_version_no, p.pub.head_version_no) : p.pub.head_version_no;
  const cards = [...cardsAt(p.space, publicationId, readable).values()].map(cardView);
  return {
    publication_id: publicationId,
    space_id: spaceId,
    version_no: readable,
    card_count: cards.length,
    cards,
    viewer: {
      is_author: isAuthor,
      can_study: !copy && cards.length > 0 && ctx.authz.can(viewer, 'follow', resource(ctx, viewer, p.pub)).allowed,
      copy: copy ? copyView(ctx, viewer, copy) : null,
    },
  };
}

/** POST /api/copies/decks — «ادرس هذه البطاقات»: copy the head's cards into the viewer's vault (a replay reopens it). */
export function studyDeck(ctx: AppContext, viewer: Viewer, body: StudyDeckRequest, deviceId: string | null): StudyDeckResponse {
  const p = pubOf(ctx, viewer, body.space_id, body.publication_id);
  ctx.authz.assert(viewer, 'view', resource(ctx, viewer, p.pub));
  const existing = copyOf(ctx, p.pub.id);
  if (existing) return { deck: copyView(ctx, viewer, existing), created: false, copied: 0 };
  // a member who is not the author, while the explanation is active (the same rule as following it)
  ctx.authz.assert(viewer, 'follow', resource(ctx, viewer, p.pub));
  const versionNo = p.pub.head_version_no;
  const rows = [...cardsAt(p.space, p.pub.id, versionNo).values()];
  if (rows.length === 0) throw new AppError('CONFLICT', AR.noCards, 409);
  const refs = refsFor(ctx, body.space_id, p.pub.lecture_id);
  const now = ctx.clock.now();
  const copy: DeckCopyRow = {
    id: derivedId('dk', viewer.userId, p.pub.id),
    origin_space_id: body.space_id,
    publication_id: p.pub.id,
    author_user_id: p.pub.author_user_id,
    applied_version_no: versionNo,
    skipped_version_no: null,
    created_device_id: deviceId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO deck_copy (id, origin_space_id, publication_id, author_user_id, applied_version_no, skipped_version_no, created_device_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
      [copy.id, copy.origin_space_id, copy.publication_id, copy.author_user_id, versionNo, deviceId, now, now],
    );
    for (const r of rows) insertDeckCard(ctx, copy, r, versionNo, refs, deviceId);
    ctx.audit.record({ entityType: 'deck_copy', entityId: copy.id, action: 'create', summary: `نُسخت ${rows.length} بطاقة من «${p.pub.title}» (الإصدار ${versionNo}) إلى مراجعتك`, after: { publication_id: p.pub.id, cards: rows.length } });
  });
  return { deck: copyView(ctx, viewer, copyOf(ctx, p.pub.id)!), created: true, copied: rows.length };
}

/** POST /api/copies/decks/:publicationId/update — «طبّق التحديث» / «تخطَّ هذا الإصدار» (idempotent; stale → 409). */
export function applyDeckUpdate(ctx: AppContext, viewer: Viewer, publicationId: string, body: ApplyDeckUpdateRequest): ApplyDeckUpdateResponse {
  const copy = copyOf(ctx, publicationId);
  if (!copy) throw notFound();
  if (!memberOf(ctx, viewer, copy.origin_space_id)) throw new AppError('CONFLICT', AR.formerMember, 409);
  const p = pubOf(ctx, viewer, copy.origin_space_id, publicationId);
  const head = p.pub.head_version_no;
  // a replay (a lost answer, a second device): a version already applied / skipped changes nothing
  if (body.version_no <= copy.applied_version_no || (body.skip && copy.skipped_version_no === body.version_no)) {
    return { deck: copyView(ctx, viewer, copy), skipped: !!body.skip, applied: body.skip ? null : { added: 0, updated: 0, removed: 0, kept_yours: 0 } };
  }
  const note = publicationStatusNoteAr(p.pub);
  if (note) throw new AppError('CONFLICT', note, 409);
  if (body.version_no !== head) throw new AppError('CONFLICT', AR.stale, 409, { head_version_no: head });
  const now = ctx.clock.now();
  if (body.skip) {
    ctx.db.run('UPDATE deck_copy SET skipped_version_no = ?, updated_at = ? WHERE id = ?', [head, now, copy.id]);
    return { deck: copyView(ctx, viewer, copyOf(ctx, publicationId)!), skipped: true, applied: null };
  }
  const d = diffCards(p.space, publicationId, copy.applied_version_no, head);
  const refs = refsFor(ctx, copy.origin_space_id, p.pub.lecture_id);
  const out = { added: 0, updated: 0, removed: 0, kept_yours: 0 };
  ctx.db.tx(() => {
    const m = mappings(ctx, copy.id);
    for (const r of d.added) {
      insertDeckCard(ctx, copy, r, head, refs, null);
      out.added++;
    }
    for (const r of d.changed) {
      const map = m.get(r.card_id);
      if (!map) {
        insertDeckCard(ctx, copy, r, head, refs, null);
        out.added++;
        continue;
      }
      if (editedByStudent(ctx, map)) {
        out.kept_yours++;
        continue;
      }
      // the text only: the card id, its review log and its schedule stay exactly as they are
      const c = parseCard(r);
      ctx.db.run('UPDATE flashcard SET front_json = ?, back_json = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [toJson(c.front), toJson(c.back), now, map.card_id]);
      const after = findCard(ctx.db, map.card_id)!;
      indexCard(ctx.db, after);
      ctx.sync.touch('flashcard', after.id);
      ctx.db.run('UPDATE deck_copy_card SET applied_hash = ? WHERE copy_id = ? AND item_id = ?', [textHash(after.kind, after.front_json, after.back_json, after.cloze_index), copy.id, r.card_id]);
      out.updated++;
    }
    for (const r of d.removed) {
      const map = m.get(r.card_id);
      if (!map) continue;
      if (editedByStudent(ctx, map)) {
        out.kept_yours++;
        continue;
      }
      // a tombstone (restorable); the review log is append-only and stays
      ctx.db.run('UPDATE flashcard SET deleted_at = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [now, now, map.card_id]);
      const after = findCard(ctx.db, map.card_id)!;
      indexCard(ctx.db, after);
      ctx.sync.touch('flashcard', after.id);
      out.removed++;
    }
    ctx.db.run('UPDATE deck_copy SET applied_version_no = ?, skipped_version_no = NULL, updated_at = ? WHERE id = ?', [head, now, copy.id]);
    ctx.audit.record({
      entityType: 'deck_copy',
      entityId: copy.id,
      action: 'apply_update',
      summary: `طُبّق الإصدار ${head} من بطاقات «${p.pub.title}» (أُضيف ${out.added}، عُدّل ${out.updated}، حُذف ${out.removed}؛ بقي ${out.kept_yours} كما عدّلتَه، ولم يتغير شيء من سجل مراجعاتك)`,
    });
  });
  return { deck: copyView(ctx, viewer, copyOf(ctx, publicationId)!), skipped: false, applied: out };
}
