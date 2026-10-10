// Learning store: flashcard rows ↔ views, the review_state cache of the FSRS fold, card impacts (AC-26) and the
// owner settings the learning module depends on.
import {
  CONTENT_ALERT_KIND_LABELS_AR,
  FLASHCARD_KIND_LABELS_AR,
  FLASHCARD_ORIGIN_LABELS_AR,
  normalizeForSearch,
  parseRichText,
  richTextToPlain,
  type CardEvidenceSnapshot,
  type CardImpactKind,
  type CardImpactResolution,
  type CardImpactView,
  type CardState,
  type ContentAlertKind,
  type FlashcardDTO,
  type FlashcardKind,
  type FlashcardView,
  type OcclusionMask,
  type ReviewEventDTO,
  type ReviewRating,
  type ReviewStateView,
  type RichText,
  type SrsParams,
} from '@medlevo/shared';
import { createHash } from 'node:crypto';
import type { Card } from 'ts-fsrs';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { algorithmString, cardFromCache, foldReviews, paramsKey, srsParams, toStateView, type FoldEvent, type FoldResult } from './srs';

// ───────── settings ─────────
export interface SrsContext {
  params: SrsParams;
  key: string;
  algorithm: string;
  timezone: string;
  dailyNewLimit: number;
  desiredRetention: number;
}

export function srsContext(ctx: AppContext): SrsContext {
  const s = ctx.settings.get();
  const params = srsParams(s.desired_retention);
  return {
    params,
    key: paramsKey(params),
    algorithm: algorithmString(params),
    timezone: s.timezone,
    dailyNewLimit: s.daily_new_cards,
    desiredRetention: s.desired_retention,
  };
}

// ───────── rows ─────────
export interface FlashcardRow {
  id: string;
  kind: FlashcardKind;
  front_json: string;
  back_json: string;
  concept_id: string | null;
  topic_id: string | null;
  source_id: string | null;
  source_version_id: string | null;
  evidence_ids_json: string;
  origin: FlashcardDTO['origin'];
  origin_ref_json: string | null;
  suspended: number;
  buried_until: number | null;
  rev: number;
  device_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  note_id: string | null;
  cloze_index: number | null;
  image_json: string | null;
  conflict_of_id: string | null;
  merged_into_id: string | null;
  evidence_snapshot_json: string;
}

export interface ImageSpec {
  image_asset_id: string;
  masks: OcclusionMask[];
  active_mask_id?: string;
}

export interface ReviewEventRow {
  id: string;
  card_id: string;
  rating: ReviewRating;
  reviewed_at: number;
  duration_ms: number | null;
  device_id: string | null;
  context_json: string | null;
  created_at: number;
}

interface ReviewStateRow {
  card_id: string;
  algorithm: string;
  state: CardState;
  due_at: number;
  stability: number | null;
  difficulty: number | null;
  reps: number;
  lapses: number;
  last_review_at: number | null;
  updated_at: number;
  params_key: string | null;
  event_count: number;
  learning_steps: number;
  scheduled_days: number;
  first_review_at: number | null;
}

export function findCard(db: Db, id: string): FlashcardRow | null {
  return db.get<FlashcardRow>('SELECT * FROM flashcard WHERE id = ?', [id]) ?? null;
}

export function requireCard(db: Db, id: string): FlashcardRow {
  const r = findCard(db, id);
  if (!r) throw new AppError('NOT_FOUND', 'البطاقة غير موجودة.', 404);
  return r;
}

export function liveCard(db: Db, id: string): FlashcardRow {
  const r = requireCard(db, id);
  if (r.deleted_at !== null) throw new AppError('CONFLICT', 'البطاقة محذوفة؛ استرجعها أولًا إن أردت تعديلها.', 409);
  return r;
}

export function eventDTO(r: ReviewEventRow): ReviewEventDTO {
  return { id: r.id, card_id: r.card_id, rating: r.rating, reviewed_at: r.reviewed_at, duration_ms: r.duration_ms, device_id: r.device_id };
}

export function cardEvents(db: Db, cardId: string): ReviewEventRow[] {
  return db.all<ReviewEventRow>('SELECT * FROM review_event WHERE card_id = ? ORDER BY reviewed_at, id', [cardId]);
}

export function cardResets(db: Db, cardId: string): number[] {
  return db.all<{ at: number }>('SELECT at FROM review_reset WHERE card_id = ? ORDER BY at, id', [cardId]).map((r) => r.at);
}

// ───────── review_state cache ─────────
/** Re-fold a card's whole history and store the cache row. Call inside the writer's transaction. */
export function recomputeState(db: Db, card: Pick<FlashcardRow, 'id' | 'created_at'>, srs: SrsContext, now: number): FoldResult {
  const events: FoldEvent[] = cardEvents(db, card.id).map((e) => ({ id: e.id, rating: e.rating, reviewed_at: e.reviewed_at }));
  const fold = foldReviews(srs.params, card.created_at, events, cardResets(db, card.id));
  writeState(db, card.id, srs, fold, now);
  return fold;
}

function writeState(db: Db, cardId: string, srs: SrsContext, fold: FoldResult, now: number): void {
  const c = fold.card;
  const isNew = c.state === 0;
  db.run(
    `INSERT INTO review_state (card_id, algorithm, state, due_at, stability, difficulty, reps, lapses, last_review_at, updated_at,
                               params_key, event_count, learning_steps, scheduled_days, first_review_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(card_id) DO UPDATE SET algorithm = excluded.algorithm, state = excluded.state, due_at = excluded.due_at,
       stability = excluded.stability, difficulty = excluded.difficulty, reps = excluded.reps, lapses = excluded.lapses,
       last_review_at = excluded.last_review_at, updated_at = excluded.updated_at, params_key = excluded.params_key,
       event_count = excluded.event_count, learning_steps = excluded.learning_steps, scheduled_days = excluded.scheduled_days,
       first_review_at = excluded.first_review_at`,
    [
      cardId,
      srs.algorithm,
      ['new', 'learning', 'review', 'relearning'][c.state]!,
      c.due.getTime(),
      isNew ? null : c.stability,
      isNew ? null : c.difficulty,
      c.reps,
      c.lapses,
      c.last_review ? c.last_review.getTime() : null,
      now,
      srs.key,
      fold.eventCount,
      c.learning_steps,
      c.scheduled_days,
      fold.firstReviewAt,
    ],
  );
}

export interface CachedState {
  view: ReviewStateView;
  card: Card;
  firstReviewAt: number | null;
  eventCount: number;
}

/** Cached fold for many cards; rows missing or computed with other params are recomputed (and stored). */
export function statesFor(db: Db, cards: Array<Pick<FlashcardRow, 'id' | 'created_at'>>, srs: SrsContext, now: number): Map<string, CachedState> {
  const out = new Map<string, CachedState>();
  for (const chunk of chunks(cards, 400)) {
    const rows = db.all<ReviewStateRow>(`SELECT * FROM review_state WHERE card_id IN (${chunk.map(() => '?').join(',')})`, chunk.map((c) => c.id));
    const byId = new Map(rows.map((r) => [r.card_id, r]));
    for (const c of chunk) {
      const r = byId.get(c.id);
      if (r && r.params_key === srs.key) {
        const card = cardFromCache(r);
        const fold: FoldResult = { card, eventCount: r.event_count, firstReviewAt: r.first_review_at };
        out.set(c.id, { view: toStateView(c.id, srs.params, fold, now), card, firstReviewAt: r.first_review_at, eventCount: r.event_count });
      } else {
        const fold = db.tx(() => recomputeState(db, c, srs, now));
        out.set(c.id, { view: toStateView(c.id, srs.params, fold, now), card: fold.card, firstReviewAt: fold.firstReviewAt, eventCount: fold.eventCount });
      }
    }
  }
  return out;
}

/** Append to a list held in a map (no copy per append). */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// ───────── impacts (AC-26) ─────────
interface ImpactRow {
  card_id: string;
  kind: CardImpactKind;
  ref: string;
  alert_id: string | null;
  reason_ar: string;
  detected_at: number;
  active: number;
  resolved_at: number | null;
  resolution: CardImpactResolution | null;
}

interface Detected {
  kind: CardImpactKind;
  ref: string;
  alert_id: string | null;
  reason_ar: string;
  detected_at: number;
  /** the owner already handled the alert globally */
  resolved?: { at: number; resolution: CardImpactResolution };
  /** when the cause itself happened (e.g. the trash time) — a cause that happens AGAIN after the owner resolved it
   *  (same card, kind and ref) flags the card again */
  occurred_at?: number | null;
}

function snapshotOf(r: Pick<FlashcardRow, 'evidence_snapshot_json'>): Array<Omit<CardEvidenceSnapshot, 'available'>> {
  return fromJson<Array<Omit<CardEvidenceSnapshot, 'available'>>>(r.evidence_snapshot_json, []) ?? [];
}

function detectImpacts(db: Db, cards: FlashcardRow[], now: number): Map<string, Detected[]> {
  const out = new Map<string, Detected[]>();
  const add = (id: string, d: Detected) => pushTo(out, id, d);
  const live = cards.filter((c) => c.deleted_at === null);
  for (const chunk of chunks(live, 400)) {
    const ids = chunk.map((c) => c.id);
    const qs = ids.map(() => '?').join(',');
    // 1) content alerts (sources module → evidence onSourceVersionChanged) that list the card
    const items = db.all<{ dependent_id: string; alert_id: string; impact: string; reason_ar: string | null; kind: ContentAlertKind; summary: string; status: string; created_at: number; resolved_at: number | null }>(
      `SELECT i.dependent_id, i.alert_id, i.impact, i.reason_ar, a.kind, a.summary, a.status, a.created_at, a.resolved_at
         FROM content_alert_item i JOIN content_alert a ON a.id = i.alert_id
        WHERE i.dependent_type = 'flashcard' AND i.dependent_id IN (${qs})`,
      ids,
    );
    const alerted = new Set<string>();
    for (const it of items) {
      if (it.impact === 'still_valid') continue;
      alerted.add(it.dependent_id);
      const d: Detected = {
        kind: 'source_changed',
        ref: it.alert_id,
        alert_id: it.alert_id,
        reason_ar: `${CONTENT_ALERT_KIND_LABELS_AR[it.kind] ?? 'تغيّر المصدر'}: ${it.reason_ar ?? it.summary} راجع البطاقة: هل ما زال جوابها صحيحًا؟ سجل مراجعاتك محفوظ.`,
        detected_at: it.created_at,
      };
      if (it.status === 'resolved') d.resolved = { at: it.resolved_at ?? now, resolution: 'alert_resolved' };
      add(it.dependent_id, d);
    }
    // 2) sources of the cards (trash / newer version)
    const srcIds = [...new Set(chunk.map((c) => c.source_id).filter((x): x is string => !!x))];
    const sources = new Map(
      (srcIds.length
        ? db.all<{ id: string; title: string; deleted_at: number | null; current_version_id: string | null; frozen_version_id: string | null }>(
            `SELECT id, title, deleted_at, current_version_id, frozen_version_id FROM source WHERE id IN (${srcIds.map(() => '?').join(',')})`,
            srcIds,
          )
        : []
      ).map((s) => [s.id, s]),
    );
    // 3) evidence of the snapshots
    const evIds = [...new Set(chunk.flatMap((c) => snapshotOf(c).map((s) => s.evidence_id)))];
    const evidence = new Map(
      (evIds.length
        ? db.all<{ id: string; source_id: string; deleted_at: number | null }>(
            `SELECT e.id, e.source_id, s.deleted_at FROM evidence e JOIN source s ON s.id = e.source_id WHERE e.id IN (${evIds.map(() => '?').join(',')})`,
            evIds,
          )
        : []
      ).map((e) => [e.id, e]),
    );
    for (const c of chunk) {
      const s = c.source_id ? sources.get(c.source_id) : undefined;
      if (c.source_id && (!s || s.deleted_at !== null)) {
        add(c.id, {
          kind: 'source_trashed',
          ref: c.source_id,
          alert_id: null,
          occurred_at: s?.deleted_at ?? null,
          reason_ar: s ? `مصدر البطاقة «${s.title}» في سلة المحذوفات؛ استرجعه أو راجع البطاقة.` : 'مصدر البطاقة لم يعد موجودًا (حُذف نهائيًا)؛ البطاقة وسجل مراجعاتها محفوظان.',
          detected_at: s?.deleted_at ?? now,
        });
      } else if (s && c.source_version_id && s.current_version_id && s.current_version_id !== c.source_version_id && s.frozen_version_id !== c.source_version_id && !alerted.has(c.id)) {
        add(c.id, {
          kind: 'newer_version',
          ref: s.current_version_id,
          alert_id: null,
          reason_ar: `رُفعت نسخة أحدث من «${s.title}» بعد إنشاء البطاقة؛ البطاقة ما زالت على النسخة التي صُنعت منها.`,
          detected_at: now,
        });
      }
      for (const snap of snapshotOf(c)) {
        const e = evidence.get(snap.evidence_id);
        if (!e || e.deleted_at !== null) {
          // the evidence row is gone (source purged / re-processed) or its source is in the trash
          add(c.id, {
            kind: 'evidence_unavailable',
            ref: snap.evidence_id,
            alert_id: null,
            occurred_at: e?.deleted_at ?? null,
            reason_ar: `${e ? `مصدر الدليل المستشهد به (${snap.source_title} — ${snap.locator_label_ar}) في سلة المحذوفات` : `الدليل المستشهد به (${snap.source_title} — ${snap.locator_label_ar}) لم يعد متاحًا`}؛ نصه المحفوظ: «${clip(snap.quote, 120)}». راجع البطاقة؛ سجل مراجعاتك محفوظ.`,
            detected_at: now,
          });
        }
      }
      // 4) cards made from a mistake: the question got a new version (key / explanation correction)
      if (c.origin === 'from_mistake') {
        const ref = fromJson<{ question_id?: string; question_version_id?: string }>(c.origin_ref_json, {}) ?? {};
        if (ref.question_id && ref.question_version_id) {
          const q = db.get<{ current_version_id: string | null }>('SELECT current_version_id FROM question WHERE id = ?', [ref.question_id]);
          if (q?.current_version_id && q.current_version_id !== ref.question_version_id) {
            const why = questionChange(db, ref.question_version_id, q.current_version_id);
            if (why) add(c.id, { kind: 'question_changed', ref: q.current_version_id, alert_id: null, reason_ar: why, detected_at: now });
          }
        }
      }
    }
  }
  return out;
}

function questionChange(db: Db, fromVersionId: string, toVersionId: string): string | null {
  const v = (id: string) =>
    db.get<{ correct_option_ids_json: string | null; explanation_json: string | null; stem_json: string; answer_status: string }>(
      'SELECT correct_option_ids_json, explanation_json, stem_json, answer_status FROM question_version WHERE id = ?',
      [id],
    );
  const a = v(fromVersionId);
  const b = v(toVersionId);
  if (!a || !b) return null;
  const keys = (json: string | null) => {
    const ids = fromJson<string[]>(json, []) ?? [];
    if (ids.length === 0) return '';
    return db
      .all<{ option_key: string }>(`SELECT option_key FROM question_option WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY option_key`, ids)
      .map((o) => o.option_key)
      .join(',');
  };
  if (keys(a.correct_option_ids_json) !== keys(b.correct_option_ids_json) || a.answer_status !== b.answer_status) {
    return 'تغيّر مفتاح إجابة السؤال الذي صُنعت منه البطاقة بعد إنشائها؛ تحقّق من جواب البطاقة قبل مراجعتها.';
  }
  if ((a.explanation_json ?? '') !== (b.explanation_json ?? '')) return 'صُحّح شرح السؤال الذي صُنعت منه البطاقة؛ قد يحتاج ظهر البطاقة تحديثًا.';
  if (a.stem_json !== b.stem_json) return 'صُحّح نص السؤال الذي صُنعت منه البطاقة؛ قارن وجه البطاقة بالنسخة الجديدة.';
  return null;
}

/**
 * Recompute the impacts of cards and persist them (flashcard_impact). A card whose needs_review flag changed is
 * touched so devices pull the new flag. Returns impact views by card id.
 */
export function refreshImpacts(ctx: AppContext, cards: FlashcardRow[]): Map<string, CardImpactView[]> {
  const now = ctx.clock.now();
  const detected = detectImpacts(ctx.db, cards, now);
  const out = new Map<string, CardImpactView[]>();
  ctx.db.tx(() => {
    for (const chunk of chunks(cards, 400)) {
      const ids = chunk.map((c) => c.id);
      const existing = ctx.db.all<ImpactRow>(`SELECT * FROM flashcard_impact WHERE card_id IN (${ids.map(() => '?').join(',')})`, ids);
      const byCard = new Map<string, ImpactRow[]>();
      for (const r of existing) pushTo(byCard, r.card_id, r);
      for (const c of chunk) {
        const before = byCard.get(c.id) ?? [];
        const wasFlagged = before.some((r) => r.active === 1 && r.resolved_at === null);
        const found = c.deleted_at === null ? (detected.get(c.id) ?? []) : [];
        const foundKeys = new Set(found.map((d) => `${d.kind}\u0000${d.ref}`));
        for (const d of found) {
          const prev = before.find((r) => r.kind === d.kind && r.ref === d.ref);
          if (!prev) {
            ctx.db.run(
              `INSERT INTO flashcard_impact (card_id, kind, ref, alert_id, reason_ar, detected_at, active, resolved_at, resolution) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
              [c.id, d.kind, d.ref, d.alert_id, d.reason_ar, d.detected_at, d.resolved?.at ?? null, d.resolved?.resolution ?? null],
            );
          } else if (prev.resolved_at !== null && typeof d.occurred_at === 'number' && d.occurred_at > prev.resolved_at) {
            // the cause happened again after the owner resolved it (e.g. the source was restored and trashed again)
            ctx.db.run(
              `UPDATE flashcard_impact SET active = 1, reason_ar = ?, alert_id = ?, detected_at = ?, resolved_at = NULL, resolution = NULL
                WHERE card_id = ? AND kind = ? AND ref = ?`,
              [d.reason_ar, d.alert_id, d.detected_at, c.id, d.kind, d.ref],
            );
          } else {
            ctx.db.run(
              `UPDATE flashcard_impact SET active = 1, reason_ar = ?, alert_id = ?,
                      resolved_at = COALESCE(resolved_at, ?), resolution = COALESCE(resolution, ?)
                WHERE card_id = ? AND kind = ? AND ref = ?`,
              [d.reason_ar, d.alert_id, d.resolved?.at ?? null, d.resolved?.resolution ?? null, c.id, d.kind, d.ref],
            );
          }
        }
        for (const r of before) {
          if (r.active === 1 && !foundKeys.has(`${r.kind}\u0000${r.ref}`)) {
            ctx.db.run('UPDATE flashcard_impact SET active = 0 WHERE card_id = ? AND kind = ? AND ref = ?', [c.id, r.kind, r.ref]);
          }
        }
        const after = ctx.db.all<ImpactRow>('SELECT * FROM flashcard_impact WHERE card_id = ? ORDER BY detected_at, kind, ref', [c.id]);
        const isFlagged = after.some((r) => r.active === 1 && r.resolved_at === null);
        if (isFlagged !== wasFlagged) ctx.sync.touch('flashcard', c.id);
        out.set(c.id, after.map(impactView));
      }
    }
  });
  return out;
}

function impactView(r: ImpactRow): CardImpactView {
  return {
    kind: r.kind,
    ref: r.ref,
    alert_id: r.alert_id,
    reason_ar: r.reason_ar,
    detected_at: r.detected_at,
    active: r.active === 1,
    resolved_at: r.resolved_at,
    resolution: r.resolution,
  };
}

// The causes of impacts change rarely (alerts, sources, evidence, question versions, cards); a cheap signature of
// them lets the read paths skip the full recompute when nothing changed since the last one.
const impactMemo = new WeakMap<Db, string>();

function impactSignature(db: Db): string {
  const parts = [
    db.get(`SELECT COUNT(*) AS c, MAX(updated_at) AS u, SUM(rev) AS r FROM flashcard`),
    db.get(`SELECT COUNT(*) AS c, MAX(rowid) AS r, SUM(CASE WHEN impact = 'still_valid' THEN 1 ELSE 0 END) AS v FROM content_alert_item WHERE dependent_type = 'flashcard'`),
    db.get(`SELECT COUNT(*) AS c, SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS s, MAX(resolved_at) AS r FROM content_alert`),
    db.get(`SELECT COUNT(*) AS c, group_concat(id || ':' || COALESCE(deleted_at, '') || ':' || COALESCE(current_version_id, '') || ':' || COALESCE(frozen_version_id, ''), ',') AS g FROM source`),
    db.get(`SELECT COUNT(*) AS c, MAX(rowid) AS r FROM evidence`),
    db.get(`SELECT COUNT(*) AS c, MAX(created_at) AS m FROM question_version`),
    db.get(`SELECT SUM(v.rowid) AS s FROM question q JOIN question_version v ON v.id = q.current_version_id`),
  ];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Recompute the impacts of every live card when one of their causes changed (memoized by a signature). */
export function refreshAllImpacts(ctx: AppContext): void {
  if (impactMemo.get(ctx.db) === impactSignature(ctx.db)) return;
  refreshImpacts(ctx, ctx.db.all<FlashcardRow>('SELECT * FROM flashcard WHERE deleted_at IS NULL'));
  impactMemo.set(ctx.db, impactSignature(ctx.db));
}

/** Impacts as stored (no recompute) — for serialize() on pull. */
export function storedImpacts(db: Db, cardIds: string[]): Map<string, CardImpactView[]> {
  const out = new Map<string, CardImpactView[]>();
  for (const chunk of chunks(cardIds, 400)) {
    for (const r of db.all<ImpactRow>(`SELECT * FROM flashcard_impact WHERE card_id IN (${chunk.map(() => '?').join(',')}) ORDER BY detected_at, kind, ref`, chunk)) {
      pushTo(out, r.card_id, impactView(r));
    }
  }
  return out;
}

export function resolveImpacts(db: Db, cardId: string, resolution: CardImpactResolution, now: number): number {
  return db.run('UPDATE flashcard_impact SET resolved_at = ?, resolution = ? WHERE card_id = ? AND active = 1 AND resolved_at IS NULL', [now, resolution, cardId]).changes;
}

// ───────── views ─────────
function evidenceAvailability(db: Db, snaps: Array<Omit<CardEvidenceSnapshot, 'available'>>): CardEvidenceSnapshot[] {
  if (snaps.length === 0) return [];
  const rows = db.all<{ id: string; deleted_at: number | null }>(
    `SELECT e.id, s.deleted_at FROM evidence e JOIN source s ON s.id = e.source_id WHERE e.id IN (${snaps.map(() => '?').join(',')})`,
    snaps.map((s) => s.evidence_id),
  );
  const ok = new Set(rows.filter((r) => r.deleted_at === null).map((r) => r.id));
  return snaps.map((s) => ({ ...s, available: ok.has(s.evidence_id) }));
}

/** Batch lookups toView needs (relearn markers, evidence still available) — avoids per-card queries for lists. */
export interface ViewExtras {
  resets: Map<string, number[]>;
  available: Set<string>;
}

export function viewExtras(db: Db, rows: Array<Pick<FlashcardRow, 'id' | 'evidence_snapshot_json'>>): ViewExtras {
  const resets = new Map<string, number[]>();
  const available = new Set<string>();
  for (const chunk of chunks(rows, 400)) {
    for (const r of db.all<{ card_id: string; at: number }>(`SELECT card_id, at FROM review_reset WHERE card_id IN (${chunk.map(() => '?').join(',')}) ORDER BY at, id`, chunk.map((c) => c.id))) {
      pushTo(resets, r.card_id, r.at);
    }
  }
  const ev = [...new Set(rows.flatMap((r) => snapshotOf(r).map((s) => s.evidence_id)))];
  for (const chunk of chunks(ev, 400)) {
    for (const e of db.all<{ id: string }>(`SELECT e.id FROM evidence e JOIN source s ON s.id = e.source_id WHERE s.deleted_at IS NULL AND e.id IN (${chunk.map(() => '?').join(',')})`, chunk)) available.add(e.id);
  }
  return { resets, available };
}

export function toView(
  db: Db,
  r: FlashcardRow,
  state: CachedState,
  impacts: CardImpactView[],
  extras?: ViewExtras,
): FlashcardView {
  const image = fromJson<ImageSpec>(r.image_json);
  const dto: FlashcardDTO = {
    id: r.id,
    kind: r.kind,
    front: parseRichText(fromJson(r.front_json)),
    back: parseRichText(fromJson(r.back_json)),
    image: image ? { image_asset_id: image.image_asset_id, masks: image.masks, ...(image.active_mask_id ? { active_mask_id: image.active_mask_id } : {}) } : null,
    concept_id: r.concept_id,
    topic_id: r.topic_id,
    source_id: r.source_id,
    source_version_id: r.source_version_id,
    evidence_ids: fromJson<string[]>(r.evidence_ids_json, []) ?? [],
    origin: r.origin,
    origin_ref: fromJson<Record<string, unknown>>(r.origin_ref_json),
    suspended: r.suspended === 1,
    buried_until: r.buried_until,
    rev: r.rev,
    device_id: r.device_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  };
  return {
    ...dto,
    note_id: r.note_id,
    cloze_index: r.cloze_index,
    conflict_of_id: r.conflict_of_id,
    merged_into_id: r.merged_into_id,
    schedule_resets: extras ? (extras.resets.get(r.id) ?? []) : cardResets(db, r.id),
    review_state: state.view,
    estimated_mastered: state.view.state === 'review' && (state.view.stability ?? 0) >= 21,
    needs_review: r.deleted_at === null && impacts.some((i) => i.active && i.resolved_at === null),
    impacts,
    evidence: extras ? snapshotOf(r).map((x) => ({ ...x, available: extras.available.has(x.evidence_id) })) : evidenceAvailability(db, snapshotOf(r)),
    origin_label_ar: FLASHCARD_ORIGIN_LABELS_AR[r.origin],
    kind_label_ar: FLASHCARD_KIND_LABELS_AR[r.kind],
  };
}

/** Views for many rows (states from the cache, impacts as stored unless `refresh`). */
export function viewsFor(ctx: AppContext, rows: FlashcardRow[], opts: { refresh?: boolean } = {}): FlashcardView[] {
  const srs = srsContext(ctx);
  const now = ctx.clock.now();
  const states = statesFor(ctx.db, rows, srs, now);
  const impacts = opts.refresh ? refreshImpacts(ctx, rows) : storedImpacts(ctx.db, rows.map((r) => r.id));
  const extras = viewExtras(ctx.db, rows);
  return rows.map((r) => toView(ctx.db, r, states.get(r.id)!, impacts.get(r.id) ?? [], extras));
}

export function viewOf(ctx: AppContext, id: string, opts: { refresh?: boolean } = {}): FlashcardView {
  return viewsFor(ctx, [requireCard(ctx.db, id)], opts)[0]!;
}

// ───────── search index (owner_content_fts, entity 'flashcard') ─────────
export function indexCard(db: Db, r: Pick<FlashcardRow, 'id' | 'front_json' | 'back_json' | 'origin' | 'deleted_at'>): void {
  db.run(`DELETE FROM owner_content_fts WHERE entity_type = 'flashcard' AND entity_id = ?`, [r.id]);
  if (r.deleted_at !== null) return;
  const text = normalizeForSearch(
    [richTextToPlain(safeRich(r.front_json)), richTextToPlain(safeRich(r.back_json))].filter(Boolean).join('\n'),
  );
  if (!text.trim()) return;
  db.run(`INSERT INTO owner_content_fts (entity_type, entity_id, origin, text) VALUES ('flashcard', ?, ?, ?)`, [r.id, r.origin, text]);
}

function safeRich(json: string): RichText | null {
  try {
    return parseRichText(fromJson(json));
  } catch {
    return null;
  }
}

export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export { toJson };
