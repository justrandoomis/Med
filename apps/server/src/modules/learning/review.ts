// Reviews (§43, AC-23 server side, AC-24): the append-only review log, the due queue in the owner's day, the review
// payload of a card (occlusion without answer leaks), the SRS configuration for offline parity, cache rebuild and
// the forgetting forecast (an ESTIMATE from the review log, §44).
import {
  REVIEW_RATING_FSRS,
  clozeSegments,
  detectDir,
  parseRichText,
  richTextToPlain,
  segmentRuns,
  type CardReviewPayload,
  type FlashcardView,
  type ForgettingForecastView,
  type Paragraph,
  type CardQueueItem,
  type CardQueueResponse,
  type ReviewRating,
  type RichText,
  type Run,
  type SrsConfigView,
  type SrsRebuildResponse,
} from '@medlevo/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { hmacSha256, safeEqual } from '../../lib/hash';
import { deriveKey, loadOrCreateServerSecret } from '../../lib/secret';
import { TS_FSRS_VERSION, foldReviews, intervalLabelAr, previewIntervals, retrievabilityAt, toStateView, type FoldEvent } from './srs';
import {
  pushTo,
  chunks,
  findCard,
  recomputeState,
  refreshAllImpacts,
  refreshImpacts,
  srsContext,
  statesFor,
  storedImpacts,
  toView,
  viewExtras,
  viewsFor,
  type FlashcardRow,
  type ImageSpec,
  type ReviewEventRow,
} from './store';
import { dayEndMs, dayOf, dayStartMs, DAY_MS } from './time';

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

// ───────── review events (append-only, idempotent) ─────────
export const reviewEventSchema = z.object({
  card_id: z.string().trim().min(1).max(64),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  reviewed_at: z.number().int().min(0),
  duration_ms: z.number().int().min(0).max(24 * 3600 * 1000).nullable().optional(),
});
export type ReviewEventInput = z.infer<typeof reviewEventSchema>;

export const REJECT_UNKNOWN_CARD_AR = 'البطاقة غير موجودة على الخادم، فلم تُحتسب هذه المراجعة. إن كانت البطاقة على جهازك فزامنها أولًا ثم أعد إرسال المراجعة.';
export const REJECT_DELETED_CARD_AR = 'البطاقة محذوفة، فلم تُحتسب هذه المراجعة. استرجع البطاقة إن أردت متابعة مراجعتها، ثم أعد إرسالها.';

/**
 * Insert one review event (idempotent by id) and re-fold the card. Inside a transaction.
 * An event for an unknown / deleted card is REFUSED with the reason (never silently dropped, never applied).
 */
export function insertReviewEvent(
  ctx: AppContext,
  id: string,
  input: ReviewEventInput,
  opts: { deviceId: string | null; touch: (t: string, id: string) => void },
): { row: ReviewEventRow; inserted: boolean } {
  const existing = ctx.db.get<ReviewEventRow>('SELECT * FROM review_event WHERE id = ?', [id]);
  if (existing) return { row: existing, inserted: false };
  const card = findCard(ctx.db, input.card_id);
  if (!card) throw new AppError('NOT_FOUND', REJECT_UNKNOWN_CARD_AR, 404, { card_id: input.card_id });
  if (card.deleted_at !== null) throw new AppError('CONFLICT', REJECT_DELETED_CARD_AR, 409, { card_id: input.card_id });
  const now = ctx.clock.now();
  let reviewedAt = input.reviewed_at;
  const context: Record<string, unknown> = {};
  if (reviewedAt > now + MAX_FUTURE_SKEW_MS) {
    // a device clock ahead of the server: the review is kept, at the server time, with the original value recorded
    context.client_reviewed_at = reviewedAt;
    context.clamped = 'future_clock';
    reviewedAt = now;
  }
  ctx.db.run(
    `INSERT INTO review_event (id, card_id, rating, reviewed_at, duration_ms, device_id, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, card.id, input.rating, reviewedAt, input.duration_ms ?? null, opts.deviceId, Object.keys(context).length ? toJson(context) : null, now],
  );
  recomputeState(ctx.db, card, srsContext(ctx), now);
  opts.touch('review_event', id);
  opts.touch('flashcard', card.id);
  return { row: ctx.db.get<ReviewEventRow>('SELECT * FROM review_event WHERE id = ?', [id])!, inserted: true };
}

// ───────── SRS configuration (offline parity) ─────────
export function srsConfig(ctx: AppContext): SrsConfigView {
  const srs = srsContext(ctx);
  // a fixed sample folded LIVE with these params: a client fold of the same input must give the same result
  const created = Date.UTC(2026, 0, 5, 6, 0, 0);
  const events: FoldEvent[] = [
    { id: '01SAMPLE0000000000000000E1', rating: 3, reviewed_at: created + 60_000 },
    { id: '01SAMPLE0000000000000000E2', rating: 3, reviewed_at: created + 11 * 60_000 },
    { id: '01SAMPLE0000000000000000E3', rating: 1, reviewed_at: created + 3 * DAY_MS },
    { id: '01SAMPLE0000000000000000E4', rating: 4, reviewed_at: created + 3 * DAY_MS + 15 * 60_000 },
    { id: '01SAMPLE0000000000000000E5', rating: 2, reviewed_at: created + 9 * DAY_MS },
  ];
  const at = created + 12 * DAY_MS;
  const fold = foldReviews(srs.params, created, events, []);
  const v = toStateView('parity-sample', srs.params, fold, at);
  return {
    algorithm: srs.algorithm,
    library: { name: 'ts-fsrs', version: TS_FSRS_VERSION },
    params: srs.params,
    params_key: srs.key,
    daily_new_limit: srs.dailyNewLimit,
    timezone: srs.timezone,
    replay: {
      order: 'reviewed_at, id',
      initial: 'createEmptyCard(card.created_at)',
      resets: 'forget(card, at, false)',
      duplicates: 'one event per id',
      rating_map: REVIEW_RATING_FSRS,
      note_ar:
        'المواعيد مشتقة من سجل المراجعات بخوارزمية FSRS-6 (مكتبة ts-fsrs) وبإعدادات ثابتة دون عشوائية: الأحداث تُرتّب حسب وقت المراجعة ثم المعرّف، ولا يُحتسب الحدث المكرر مرتين. أوقات الاستحقاق محفوظة بتوقيت UTC فلا تتغير بتغيير منطقة الجهاز؛ «اليوم» وحد البطاقات الجديدة يحسبان بمنطقتك الزمنية في الإعدادات. تحسب المكتبة الأيام المنقضية بين مراجعتين بالتقويم UTC.',
    },
    parity_check: {
      created_at: created,
      events: events.map((e) => ({ id: e.id, rating: e.rating, reviewed_at: e.reviewed_at })),
      resets: [],
      at,
      expected: {
        state: v.state,
        due_at: v.due_at,
        stability: v.stability,
        difficulty: v.difficulty,
        reps: v.reps,
        lapses: v.lapses,
        last_review_at: v.last_review_at,
        retrievability: v.retrievability,
      },
    },
  };
}

/** Recompute every cached schedule with the current parameters (explicit, e.g. after changing desired retention). */
export function rebuildAll(ctx: AppContext): SrsRebuildResponse {
  const srs = srsContext(ctx);
  const now = ctx.clock.now();
  const cards = ctx.db.all<Pick<FlashcardRow, 'id' | 'created_at'>>('SELECT id, created_at FROM flashcard');
  let changed = 0;
  ctx.db.tx(() => {
    for (const c of cards) {
      const before = ctx.db.get<{ due_at: number; state: string; params_key: string | null }>('SELECT due_at, state, params_key FROM review_state WHERE card_id = ?', [c.id]);
      const fold = recomputeState(ctx.db, c, srs, now);
      if (!before || before.due_at !== fold.card.due.getTime() || before.params_key !== srs.key) {
        changed++;
        ctx.sync.touch('flashcard', c.id);
      }
    }
  });
  ctx.audit.record({ entityType: 'review_state', entityId: 'all', action: 'rebuild', summary: `أعيد حساب جدولة ${cards.length} بطاقة من سجل المراجعات (${srs.algorithm}).` });
  return { cards: cards.length, changed, algorithm: srs.algorithm };
}

// ───────── queue ─────────
interface QueueOptions {
  limit: number;
  sourceId?: string | null;
}

export function reviewQueue(ctx: AppContext, o: QueueOptions): CardQueueResponse {
  const srs = srsContext(ctx);
  const now = ctx.clock.now();
  const today = dayOf(now, srs.timezone);
  const start = dayStartMs(today, srs.timezone);
  const end = dayEndMs(today, srs.timezone);
  const params: unknown[] = [];
  let where = 'deleted_at IS NULL';
  if (o.sourceId) {
    where += ' AND source_id = ?';
    params.push(o.sourceId);
  }
  const all = ctx.db.all<FlashcardRow>(`SELECT * FROM flashcard WHERE ${where} ORDER BY created_at, id`, params);
  const suspended = all.filter((c) => c.suspended === 1).length;
  const buried = all.filter((c) => c.suspended === 0 && c.buried_until !== null && c.buried_until > now).length;
  const active = all.filter((c) => c.suspended === 0 && (c.buried_until === null || c.buried_until <= now));
  const states = statesFor(ctx.db, active, srs, now);
  refreshAllImpacts(ctx);
  const impacts = storedImpacts(ctx.db, active.map((c) => c.id));

  const introducedToday =
    ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_state WHERE first_review_at >= ? AND first_review_at < ?', [start, end])?.n ?? 0;
  const newLimitLeft = Math.max(0, srs.dailyNewLimit - introducedToday);

  const learning: FlashcardRow[] = [];
  const due: FlashcardRow[] = [];
  const fresh: FlashcardRow[] = [];
  let dueToday = 0;
  let nextDue: number | null = null;
  for (const c of active) {
    const s = states.get(c.id)!;
    const isUnseen = s.view.state === 'new' && s.eventCount === 0;
    if (isUnseen) {
      fresh.push(c);
      continue;
    }
    if (s.view.due_at < end) dueToday++;
    if (s.view.due_at <= now) (s.view.state === 'learning' || s.view.state === 'relearning' ? learning : due).push(c);
    else nextDue = nextDue === null ? s.view.due_at : Math.min(nextDue, s.view.due_at);
  }
  const byDue = (a: FlashcardRow, b: FlashcardRow) => states.get(a.id)!.view.due_at - states.get(b.id)!.view.due_at || (a.id < b.id ? -1 : 1);
  learning.sort(byDue);
  due.sort(byDue);
  const newToday = fresh.slice(0, newLimitLeft);
  const picked: Array<{ row: FlashcardRow; reason: CardQueueItem['reason'] }> = [
    ...learning.map((row) => ({ row, reason: 'learning' as const })),
    ...due.map((row) => ({ row, reason: 'due' as const })),
    ...newToday.map((row) => ({ row, reason: 'new' as const })),
  ].slice(0, o.limit);
  const extras = viewExtras(ctx.db, picked.map((p) => p.row));
  const items: CardQueueItem[] = picked.map(({ row, reason }) => {
    const card = toView(ctx.db, row, states.get(row.id)!, impacts.get(row.id) ?? [], extras);
    const overdueDays = Math.floor((now - card.review_state.due_at) / DAY_MS);
    const reason_ar =
      reason === 'new'
        ? 'بطاقة جديدة ضمن حدّك اليومي للبطاقات الجديدة.'
        : reason === 'learning'
          ? 'قيد التعلّم: خطوة قصيرة حان وقتها.'
          : overdueDays >= 1
            ? `مستحقة منذ ${overdueDays === 1 ? 'يوم' : overdueDays === 2 ? 'يومين' : `${overdueDays} أيام`}.`
            : 'حان موعد مراجعتها.';
    return { card, reason, reason_ar };
  });
  return {
    day: today,
    timezone: srs.timezone,
    counts: {
      due_now: learning.length + due.length,
      due_today: dueToday,
      new_available: newToday.length,
      new_limit: srs.dailyNewLimit,
      new_introduced_today: introducedToday,
      suspended,
      buried,
      needs_review: [...impacts.values()].filter((v) => v.some((i) => i.active && i.resolved_at === null)).length,
    },
    items,
    next_due_at: nextDue,
    algorithm: srs.algorithm,
  };
}

// ───────── review payload ─────────
function runsFor(text: string, dir: 'rtl' | 'ltr', marks?: Run['marks']): Run[] {
  return segmentRuns(text, dir).map((r) => (marks ? { ...r, marks } : r));
}

/** Cloze text → RichText with the asked index hidden (front) or revealed and emphasized (back). */
export function clozeRich(text: string, index: number, side: 'front' | 'back'): RichText {
  const segs = clozeSegments(text, index, side);
  const paragraphs: Paragraph[] = [];
  let line: Array<{ t: string; role: string }> = [];
  const flush = () => {
    const plain = line.map((s) => s.t).join('');
    if (plain.trim()) {
      const dir = detectDir(plain);
      const runs: Run[] = [];
      for (const s of line) runs.push(...runsFor(s.t, dir, s.role === 'text' ? undefined : s.role === 'blank' ? ['b'] : ['b', 'u']));
      paragraphs.push({ dir, runs });
    }
    line = [];
  };
  for (const s of segs) {
    const parts = s.t.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) flush();
      if (p) line.push({ t: p, role: s.role });
    });
  }
  flush();
  return { v: 1, paragraphs };
}

let mediaKey: { dir: string; key: Buffer } | null = null;
function key(ctx: AppContext): Buffer {
  if (!mediaKey || mediaKey.dir !== ctx.config.dataDir) mediaKey = { dir: ctx.config.dataDir, key: deriveKey(loadOrCreateServerSecret(ctx.config.dataDir), 'learning-card-media') };
  return mediaKey.key;
}
export const CARD_MEDIA_TTL_MS = 2 * 60 * 60 * 1000;

/** Opaque token bound to a CARD (not a file id or name): the image of an occlusion card. */
export function createCardMediaToken(ctx: AppContext, cardId: string): { token: string; expiresAt: number } {
  const expiresAt = ctx.clock.now() + CARD_MEDIA_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ c: cardId, e: expiresAt })).toString('base64url');
  return { token: `${payload}.${hmacSha256(key(ctx), payload).toString('base64url')}`, expiresAt };
}

export function verifyCardMediaToken(ctx: AppContext, token: string): string | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), hmacSha256(key(ctx), payload).toString('base64url'))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { c?: unknown; e?: unknown };
    if (typeof d.c !== 'string' || typeof d.e !== 'number' || ctx.clock.now() >= d.e) return null;
    return d.c;
  } catch {
    return null;
  }
}

/** The file behind an occlusion card's media token (null when the card / image is gone). */
export function cardMediaFile(ctx: AppContext, cardId: string): string | null {
  const c = findCard(ctx.db, cardId);
  if (!c || c.deleted_at !== null || c.kind !== 'image_occlusion') return null;
  const spec = fromJson<ImageSpec>(c.image_json);
  if (!spec) return null;
  return ctx.db.get<{ file_id: string | null }>('SELECT file_id FROM image_asset WHERE id = ?', [spec.image_asset_id])?.file_id ?? null;
}

export function reviewPayload(ctx: AppContext, cardId: string): CardReviewPayload {
  const row = findCard(ctx.db, cardId);
  if (!row) throw new AppError('NOT_FOUND', 'البطاقة غير موجودة.', 404);
  if (row.deleted_at !== null) throw new AppError('CONFLICT', 'البطاقة محذوفة.', 409);
  const srs = srsContext(ctx);
  const now = ctx.clock.now();
  const state = statesFor(ctx.db, [row], srs, now).get(row.id)!;
  const view: FlashcardView = toView(ctx.db, row, state, refreshImpacts(ctx, [row]).get(row.id) ?? []);
  let front: RichText = view.front;
  let back: RichText = view.back;
  let image: CardReviewPayload['image'] = null;
  if (row.kind === 'cloze' && row.cloze_index !== null) {
    const text = richTextToPlain(view.front);
    front = clozeRich(text, row.cloze_index, 'front');
    const extra = view.back.paragraphs;
    back = { v: 1, paragraphs: [...clozeRich(text, row.cloze_index, 'back').paragraphs, ...extra] };
  } else if (row.kind === 'image_occlusion') {
    const spec = fromJson<ImageSpec>(row.image_json);
    if (!spec || !cardMediaFile(ctx, row.id)) throw new AppError('CONFLICT', 'صورة البطاقة لم تعد متاحة؛ راجع البطاقة أو احذفها.', 409);
    const t = createCardMediaToken(ctx, row.id);
    // masks WITHOUT labels and a neutral alt: nothing on the front reveals the answer (no file name / caption / title).
    // Mask ids may be chosen by a client (e.g. «caecum»), so the payload carries positional ids only.
    image = {
      url: `/api/learning/media/${t.token}`,
      expires_at: t.expiresAt,
      alt_ar: 'صورة البطاقة؛ المنطقة المطلوب تسميتها محددة بإطار مميز.',
      masks: spec.masks.map((m, i) => ({ id: `m${i + 1}`, box: { ...m.box }, active: m.id === spec.active_mask_id })),
    };
  }
  const due = previewIntervals(srs.params, state.card, now);
  const intervals = {} as CardReviewPayload['intervals'];
  for (const r of [1, 2, 3, 4] as ReviewRating[]) intervals[r] = { due_at: due[r], label_ar: intervalLabelAr(due[r] - now) };
  return {
    card_id: row.id,
    kind: row.kind,
    rev: row.rev,
    front,
    back,
    image,
    intervals,
    state: view.review_state,
    needs_review: view.needs_review,
    impacts: view.impacts,
    evidence: view.evidence,
    origin_label_ar: view.origin_label_ar,
  };
}

// ───────── forgetting forecast (estimate) ─────────
export function forgettingForecast(ctx: AppContext, opts: { sourceId?: string | null; horizons?: number[] } = {}): ForgettingForecastView {
  const srs = srsContext(ctx);
  const now = ctx.clock.now();
  const horizons = (opts.horizons?.length ? opts.horizons : [1, 7, 30]).filter((d) => d >= 0 && d <= 365).slice(0, 6);
  const params: unknown[] = [];
  let where = 'f.deleted_at IS NULL AND f.suspended = 0';
  if (opts.sourceId) {
    where += ' AND f.source_id = ?';
    params.push(opts.sourceId);
  }
  const rows = ctx.db.all<FlashcardRow & { source_title: string | null }>(
    `SELECT f.*, s.title AS source_title FROM flashcard f LEFT JOIN source s ON s.id = f.source_id WHERE ${where}`,
    params,
  );
  const states = statesFor(ctx.db, rows, srs, now);
  const reviewed = rows.filter((r) => states.get(r.id)!.view.last_review_at !== null && states.get(r.id)!.view.state !== 'new');
  const recallAt = (r: FlashcardRow, days: number) => retrievabilityAt(srs.params, states.get(r.id)!.card, now + days * DAY_MS);
  const summarize = (list: FlashcardRow[], days: number) => {
    const vals = list.map((r) => recallAt(r, days)).filter((x): x is number => x !== null);
    return {
      avg: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000 : null,
      below: vals.filter((v) => v < srs.desiredRetention).length,
    };
  };
  const groups = new Map<string, FlashcardRow[]>();
  for (const r of reviewed) pushTo(groups, r.source_id ?? '', r);
  const titles = new Map(rows.map((r) => [r.source_id ?? '', (r as { source_title: string | null }).source_title]));
  return {
    generated_at: now,
    algorithm: srs.algorithm,
    estimate_note_ar:
      'تقدير لاحتمال التذكّر محسوب من سجل مراجعاتك بخوارزمية FSRS، وليس قياسًا يقينيًا للذاكرة. لا يدّعي معرفة ما نسيته فعلًا؛ المراجعة وحدها تختبر ذلك.',
    horizons_days: horizons,
    overall: horizons.map((d) => {
      const s = summarize(reviewed, d);
      return { days: d, cards: reviewed.length, avg_recall: s.avg, below_desired: s.below };
    }),
    by_source: [...groups.entries()]
      .map(([sid, list]) => ({
        source_id: sid || null,
        label: sid ? (titles.get(sid) ?? 'مصدر محذوف') : 'بطاقات غير مرتبطة بمصدر',
        cards: list.length,
        now_avg: summarize(list, 0).avg,
        at: horizons.map((d) => {
          const s = summarize(list, d);
          return { days: d, avg_recall: s.avg, below_desired: s.below };
        }),
      }))
      .sort((a, b) => (a.now_avg ?? 1) - (b.now_avg ?? 1)),
    not_estimated: {
      cards: rows.length - reviewed.length,
      reason_ar: 'بطاقات لم تُراجع بعد: لا يوجد سجل يُبنى عليه تقدير، فلا يُعرض لها رقم.',
    },
    desired_retention: srs.desiredRetention,
  };
}

/** Views of cards by ids in the given order (missing ids skipped). */
export function cardViews(ctx: AppContext, ids: string[]): FlashcardView[] {
  const rows: FlashcardRow[] = [];
  for (const chunk of chunks(ids, 400)) rows.push(...ctx.db.all<FlashcardRow>(`SELECT * FROM flashcard WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is FlashcardRow => !!r);
  return viewsFor(ctx, ordered);
}

export { toStateView, parseRichText };
