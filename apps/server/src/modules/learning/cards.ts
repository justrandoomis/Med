// Flashcards (§43): owner cards, cards from a selection, from a mistake, cloze (one card per index), image
// occlusion (one card per mask), edit / suspend / bury / tombstone delete / restore, impact resolution (AC-26) and
// duplicate suggestions (never merged automatically).
//
// Owner writing is never lost: a delete is a tombstone, a merge tombstones one card with merged_into_id, and the
// review log of every card stays as it is (append-only review_event).
import {
  ANSWER_STATUS_LABELS_AR,
  QUESTION_ORIGIN_LABELS_AR,
  SCORABLE_ANSWER_STATUSES,
  clozeIndexes,
  normalizeForSearch,
  type AnswerStatus,
  parseRichText,
  richTextFromPlain,
  richTextToPlain,
  type CardCreateRequest,
  type CardCreateResponse,
  type CardDuplicateDecisionRequest,
  type CardDuplicateSuggestion,
  type CardEvidenceSnapshot,
  type CardFromMistakeRequest,
  type CardFromSelectionRequest,
  type CardImpactResolveRequest,
  type CardUpdateRequest,
  type FlashcardDTO,
  type FlashcardKind,
  type FlashcardView,
  type OcclusionCreateRequest,
  type OcclusionMask,
  type Paragraph,
  type RichText,
  type RichTextInput,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { fromRegion, getViewsWithMissing, recordDependencies } from '../evidence/services';
import {
  pushTo,
  findCard,
  indexCard,
  liveCard,
  recomputeState,
  requireCard,
  resolveImpacts,
  srsContext,
  viewOf,
  viewsFor,
  type FlashcardRow,
  type ImageSpec,
} from './store';
import { dayEndMs, dayOf } from './time';

export const MAX_TEXT_CHARS = 20_000;
export const MAX_MASKS = 50;

// ───────── input normalization ─────────
export function toRich(input: RichTextInput | null | undefined, whatAr: string, opts: { required: boolean }): RichText {
  let rt: RichText;
  if (input === null || input === undefined) rt = { v: 1, paragraphs: [] };
  else if (typeof input === 'string') rt = richTextFromPlain(input);
  else {
    try {
      rt = parseRichText(input);
    } catch {
      throw new AppError('VALIDATION_FAILED', `صيغة ${whatAr} غير صالحة.`, 400);
    }
  }
  const plain = richTextToPlain(rt);
  if (opts.required && !plain.trim()) throw new AppError('VALIDATION_FAILED', `${whatAr} فارغ؛ اكتب نصًا للبطاقة.`, 400);
  if (plain.length > MAX_TEXT_CHARS) throw new AppError('PAYLOAD_TOO_LARGE', `${whatAr} أطول من الحد المسموح (${MAX_TEXT_CHARS} حرف).`, 413);
  return rt;
}

export interface CleanRefs {
  source_id: string | null;
  source_version_id: string | null;
  concept_id: string | null;
  topic_id: string | null;
  evidence_ids: string[];
  snapshot: Array<Omit<CardEvidenceSnapshot, 'available'>>;
  region_ids: string[];
  notes_ar: string[];
}

/** Keep only references that exist; say what was dropped (never a dangling citation). */
export function cleanRefs(
  ctx: AppContext,
  input: { source_id?: string | null; source_version_id?: string | null; concept_id?: string | null; topic_id?: string | null; evidence_ids?: string[] | null },
): CleanRefs {
  const notes: string[] = [];
  const ids = [...new Set((input.evidence_ids ?? []).filter((x) => typeof x === 'string' && x.length > 0))].slice(0, 50);
  const { evidence, missing } = getViewsWithMissing(ctx, ids);
  if (missing.length) notes.push(`لم تُربط ${missing.length === 1 ? 'إشارة دليل واحدة غير موجودة' : `${missing.length} إشارات أدلة غير موجودة`} بالبطاقة.`);
  let sourceId = input.source_id ?? null;
  let versionId = input.source_version_id ?? null;
  if (sourceId) {
    const s = ctx.db.get<{ id: string; current_version_id: string | null; frozen_version_id: string | null }>(
      'SELECT id, current_version_id, frozen_version_id FROM source WHERE id = ?',
      [sourceId],
    );
    if (!s) {
      notes.push('المصدر المحدد غير موجود؛ حُفظت البطاقة دون ربطها بمصدر.');
      sourceId = null;
      versionId = null;
    } else if (versionId) {
      const v = ctx.db.get<{ source_id: string }>('SELECT source_id FROM source_version WHERE id = ?', [versionId]);
      if (!v || v.source_id !== sourceId) {
        notes.push('نسخة المصدر المحددة لا تخص هذا المصدر؛ رُبطت البطاقة بالنسخة المعتمدة حاليًا.');
        versionId = s.frozen_version_id ?? s.current_version_id;
      }
    } else versionId = s.frozen_version_id ?? s.current_version_id;
  } else if (versionId) {
    const v = ctx.db.get<{ source_id: string }>('SELECT source_id FROM source_version WHERE id = ?', [versionId]);
    if (v) sourceId = v.source_id;
    else versionId = null;
  }
  if (!sourceId && evidence[0]) {
    sourceId = evidence[0].source_id;
    versionId = evidence[0].version_id;
  }
  let conceptId = input.concept_id ?? null;
  if (conceptId && !ctx.db.get('SELECT 1 AS x FROM concept WHERE id = ?', [conceptId])) {
    notes.push('المفهوم المحدد غير موجود؛ حُفظت البطاقة دون مفهوم.');
    conceptId = null;
  }
  let topicId = input.topic_id ?? null;
  if (topicId && !ctx.db.get('SELECT 1 AS x FROM topic WHERE id = ?', [topicId])) {
    notes.push('الموضوع المحدد غير موجود؛ حُفظت البطاقة دون موضوع.');
    topicId = null;
  }
  return {
    source_id: sourceId,
    source_version_id: versionId,
    concept_id: conceptId,
    topic_id: topicId,
    evidence_ids: evidence.map((e) => e.id),
    snapshot: evidence.map((e) => ({
      evidence_id: e.id,
      source_id: e.source_id,
      source_title: e.source_title,
      version_id: e.version_id,
      locator_label_ar: e.locator_label_ar,
      quote: e.quote,
    })),
    region_ids: evidence.map((e) => e.region_id).filter((x): x is string => !!x),
    notes_ar: notes,
  };
}

// ───────── insert ─────────
export interface NewCard {
  id: string;
  kind: FlashcardKind;
  front: RichText;
  back: RichText;
  refs: CleanRefs;
  /** 'generated' only for a preserved concurrent edit of a generated card (generation itself is server-side) */
  origin: FlashcardDTO['origin'];
  origin_ref: Record<string, unknown> | null;
  note_id: string | null;
  cloze_index: number | null;
  image: ImageSpec | null;
  suspended?: boolean;
  buried_until?: number | null;
  device_id: string | null;
  created_at: number;
  conflict_of_id?: string | null;
}

/** Insert one card (+ initial schedule cache, dependencies, search key, change feed). Inside a transaction. */
export function insertCard(ctx: AppContext, c: NewCard, touch: (t: string, id: string) => void): FlashcardRow {
  const now = ctx.clock.now();
  ctx.db.run(
    `INSERT INTO flashcard (id, kind, front_json, back_json, concept_id, topic_id, source_id, source_version_id, evidence_ids_json, origin,
                            origin_ref_json, suspended, buried_until, rev, device_id, created_at, updated_at, deleted_at, note_id, cloze_index,
                            image_json, conflict_of_id, merged_into_id, evidence_snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)`,
    [
      c.id,
      c.kind,
      toJson(c.front),
      toJson(c.back),
      c.refs.concept_id,
      c.refs.topic_id,
      c.refs.source_id,
      c.refs.source_version_id,
      toJson(c.refs.evidence_ids),
      c.origin,
      c.origin_ref ? toJson(c.origin_ref) : null,
      c.suspended ? 1 : 0,
      c.buried_until ?? null,
      c.device_id,
      c.created_at,
      now,
      c.note_id,
      c.cloze_index,
      c.image ? toJson(c.image) : null,
      c.conflict_of_id ?? null,
      toJson(c.refs.snapshot),
    ],
  );
  const row = findCard(ctx.db, c.id)!;
  recomputeState(ctx.db, row, srsContext(ctx), now);
  recordCardDependencies(ctx, row, c.refs.region_ids);
  indexCard(ctx.db, row);
  touch('flashcard', row.id);
  return row;
}

export function recordCardDependencies(ctx: AppContext, row: FlashcardRow, regionIds: string[] = []): void {
  const versions = new Set<string>();
  if (row.source_version_id) versions.add(row.source_version_id);
  const snaps = fromJson<Array<{ version_id: string }>>(row.evidence_snapshot_json, []) ?? [];
  for (const s of snaps) versions.add(s.version_id);
  const regions = regionIds.length
    ? regionIds
    : (fromJson<string[]>(row.evidence_ids_json, []) ?? []).length
      ? ctx.db
          .all<{ region_id: string | null }>(
            `SELECT region_id FROM evidence WHERE id IN (${(fromJson<string[]>(row.evidence_ids_json, []) ?? []).map(() => '?').join(',')})`,
            fromJson<string[]>(row.evidence_ids_json, []) ?? [],
          )
          .map((r) => r.region_id)
          .filter((x): x is string => !!x)
      : [];
  if (versions.size || regions.length) recordDependencies(ctx, 'flashcard', row.id, [...versions], regions);
}

function touchFn(ctx: AppContext) {
  return (t: string, id: string) => void ctx.sync.touch(t, id);
}

function existingNote(ctx: AppContext, firstId: string): FlashcardRow[] | null {
  const first = findCard(ctx.db, firstId);
  if (!first) return null;
  if (!first.note_id) return [first];
  return ctx.db.all<FlashcardRow>('SELECT * FROM flashcard WHERE note_id = ? ORDER BY cloze_index, created_at, id', [first.note_id]);
}

// ───────── create: owner / cloze ─────────
export function createCards(ctx: AppContext, req: CardCreateRequest, deviceId: string | null = null): CardCreateResponse {
  if (req.id) {
    const ex = existingNote(ctx, req.id);
    if (ex) return { cards: viewsFor(ctx, ex), created: false, duplicates: [], notes_ar: [] };
  }
  const now = ctx.clock.now();
  const refs = cleanRefs(ctx, req);
  const rows = ctx.db.tx(() => buildTextCards(ctx, { ...req, refs, origin: 'owner', origin_ref: null, deviceId, now }));
  const cards = viewsFor(ctx, rows);
  ctx.audit.record({ entityType: 'flashcard', entityId: rows[0]!.id, action: 'create', summary: `أنشأت ${cardsAr(rows.length)} (${req.kind === 'cloze' ? 'Cloze' : 'سؤال وجواب'}).` });
  return { cards, created: true, duplicates: duplicatesOf(ctx, rows.map((r) => r.id)), notes_ar: refs.notes_ar };
}

interface TextCardsInput {
  id?: string;
  kind: 'basic' | 'cloze';
  front: RichTextInput;
  back?: RichTextInput | null;
  refs: CleanRefs;
  origin: NewCard['origin'];
  origin_ref: Record<string, unknown> | null;
  deviceId: string | null;
  now: number;
}

function buildTextCards(ctx: AppContext, i: TextCardsInput): FlashcardRow[] {
  const touch = touchFn(ctx);
  const front = toRich(i.front, i.kind === 'cloze' ? 'نص الإكمال' : 'وجه البطاقة', { required: true });
  if (i.kind === 'basic') {
    const back = toRich(i.back, 'ظهر البطاقة', { required: true });
    const id = i.id ?? newId(i.now);
    return [insertCard(ctx, { id, kind: 'basic', front, back, refs: i.refs, origin: i.origin, origin_ref: i.origin_ref, note_id: null, cloze_index: null, image: null, device_id: i.deviceId, created_at: i.now }, touch)];
  }
  const text = richTextToPlain(front);
  const indexes = clozeIndexes(text);
  if (indexes.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'لا يوجد فراغ في النص. اكتب الجزء المخفي بالصيغة {{c1::الجواب}} (ويمكن إضافة تلميح: {{c1::الجواب::تلميح}}).', 400);
  }
  if (indexes.length > 50) throw new AppError('VALIDATION_FAILED', 'عدد الفراغات أكبر من الحد المسموح (50) في بطاقة واحدة.', 400);
  const back = toRich(i.back, 'الملاحظة الإضافية', { required: false });
  const noteId = i.id ?? newId(i.now);
  return indexes.map((n, k) =>
    insertCard(
      ctx,
      {
        id: k === 0 && i.id ? i.id : newId(i.now),
        kind: 'cloze',
        front,
        back,
        refs: i.refs,
        origin: i.origin,
        origin_ref: i.origin_ref,
        note_id: noteId,
        cloze_index: n,
        image: null,
        device_id: i.deviceId,
        created_at: i.now,
      },
      touch,
    ),
  );
}

// ───────── create: from a selection in a source ─────────
export function createFromSelection(ctx: AppContext, req: CardFromSelectionRequest): CardCreateResponse {
  if (req.id) {
    const ex = existingNote(ctx, req.id);
    if (ex) return { cards: viewsFor(ctx, ex), created: false, duplicates: [], notes_ar: [] };
  }
  const src = ctx.db.get<{ id: string; deleted_at: number | null }>('SELECT id, deleted_at FROM source WHERE id = ?', [req.source_id]);
  if (!src) throw new AppError('NOT_FOUND', 'المصدر غير موجود.', 404);
  if (src.deleted_at !== null) throw new AppError('CONFLICT', 'المصدر في سلة المحذوفات؛ استرجعه أولًا.', 409);
  const v = ctx.db.get<{ source_id: string }>('SELECT source_id FROM source_version WHERE id = ?', [req.version_id]);
  if (!v || v.source_id !== req.source_id) throw new AppError('VALIDATION_FAILED', 'نسخة المصدر لا تخص هذا المصدر.', 400);
  const quote = (req.quote ?? '').trim();
  if (!quote) throw new AppError('VALIDATION_FAILED', 'النص المحدد فارغ.', 400);

  const now = ctx.clock.now();
  return ctx.db.tx(() => {
    let evidenceIds = [...new Set(req.evidence_ids ?? [])];
    if (evidenceIds.length === 0) {
      if (!req.region_id) throw new AppError('VALIDATION_FAILED', 'حدّد الدليل أو المنطقة التي أُخذ منها النص حتى تُربط البطاقة بمصدرها.', 400);
      const region = ctx.db.get<{ version_id: string }>('SELECT version_id FROM source_region WHERE id = ?', [req.region_id]);
      if (!region || region.version_id !== req.version_id) throw new AppError('VALIDATION_FAILED', 'المنطقة المحددة لا تخص هذه النسخة من المصدر.', 400);
      const ev = fromRegion(ctx, req.region_id, { ...(req.start != null ? { start: req.start } : {}), ...(req.end != null ? { end: req.end } : {}) });
      evidenceIds = [ev.id];
    }
    const refs = cleanRefs(ctx, { source_id: req.source_id, source_version_id: req.version_id, concept_id: req.concept_id ?? null, topic_id: req.topic_id ?? null, evidence_ids: evidenceIds });
    const foreign = refs.snapshot.filter((s) => s.version_id !== req.version_id);
    if (foreign.length) throw new AppError('VALIDATION_FAILED', 'الدليل المحدد من نسخة أو مصدر آخر غير النص المحدد.', 400);
    if (refs.evidence_ids.length === 0) throw new AppError('INVALID_EVIDENCE', 'الدليل المحدد غير موجود؛ أعد تحديد النص.', 422);
    const kind = req.kind ?? 'basic';
    // the back defaults to the exact source excerpt, marked as an original quote with its evidence
    const back: RichTextInput | null =
      req.back !== undefined && req.back !== null && (typeof req.back !== 'string' || req.back.trim())
        ? req.back
        : kind === 'basic'
          ? quoteRich(refs.snapshot.map((s) => s.quote).join('\n'), refs.evidence_ids)
          : null;
    const rows = buildTextCards(ctx, {
      ...(req.id ? { id: req.id } : {}),
      kind,
      front: req.front,
      back,
      refs,
      origin: 'from_selection',
      origin_ref: { quote: clipText(quote, 2000), region_id: req.region_id ?? null },
      deviceId: null,
      now,
    });
    ctx.audit.record({ entityType: 'flashcard', entityId: rows[0]!.id, action: 'create_from_selection', summary: `أنشأت ${cardsAr(rows.length)} من نص محدد في المصدر.` });
    return { cards: viewsFor(ctx, rows), created: true, duplicates: duplicatesOf(ctx, rows.map((r) => r.id)), notes_ar: refs.notes_ar };
  });
}

function quoteRich(text: string, evidenceIds: string[]): RichText {
  const rt = richTextFromPlain(text);
  return {
    v: 1,
    paragraphs: rt.paragraphs.map((p) => ({ ...p, kind: 'quote' as const, runs: p.runs.map((r) => ({ ...r, kind: 'original_quote' as const, ev: evidenceIds })) })),
  };
}

// ───────── create: from a mistake ─────────
interface AttemptForCard {
  id: string;
  question_id: string;
  question_version_id: string;
  selected_option_ids_json: string | null;
  is_correct: number | null;
  confidence: string | null;
  hints_used: number;
  solution_viewed_before_answer: number;
}

export function createFromMistake(ctx: AppContext, req: CardFromMistakeRequest): CardCreateResponse {
  const a = ctx.db.get<AttemptForCard>(
    'SELECT id, question_id, question_version_id, selected_option_ids_json, is_correct, confidence, hints_used, solution_viewed_before_answer FROM question_attempt WHERE id = ?',
    [req.attempt_id],
  );
  if (!a) throw new AppError('NOT_FOUND', 'المحاولة غير موجودة على الخادم بعد؛ انتظر المزامنة ثم أعد المحاولة.', 404);
  const existing = ctx.db.get<FlashcardRow>(
    `SELECT * FROM flashcard WHERE origin = 'from_mistake' AND json_extract(origin_ref_json, '$.question_attempt_id') = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
    [a.id],
  );
  if (existing) return { cards: viewsFor(ctx, [existing]), created: false, duplicates: [], notes_ar: ['لهذه المحاولة بطاقة سابقة؛ أُعيدت كما هي.'] };
  if (req.id && findCard(ctx.db, req.id)) throw new AppError('CONFLICT', 'معرّف البطاقة مستخدم لبطاقة أخرى.', 409);

  const v = ctx.db.get<{ id: string; stem_json: string; correct_option_ids_json: string | null; explanation_json: string | null; answer_status: AnswerStatus }>(
    'SELECT id, stem_json, correct_option_ids_json, explanation_json, answer_status FROM question_version WHERE id = ?',
    [a.question_version_id],
  );
  if (!v) throw new AppError('NOT_FOUND', 'نسخة السؤال غير موجودة.', 404);
  const correct = fromJson<string[]>(v.correct_option_ids_json, []) ?? [];
  if (correct.length === 0 || !SCORABLE_ANSWER_STATUSES.includes(v.answer_status)) {
    throw new AppError('CONFLICT', 'مفتاح هذا السؤال غير محسوم؛ لا تُصنع بطاقة بجواب غير مؤكد. صحّح المفتاح أولًا من خزنة الأسئلة.', 409);
  }
  // provenance stays visible on the card itself (§0.3): a generated question / an AI-derived key is never shown as a
  // question or key from the owner's files
  const questionOrigin = ctx.db.get<{ origin_type: 'source' | 'generated' | 'owner' }>('SELECT origin_type FROM question WHERE id = ?', [a.question_id])?.origin_type ?? 'source';
  const options = ctx.db.all<{ id: string; source_label: string | null; ord: number; text_json: string }>(
    'SELECT id, source_label, ord, text_json FROM question_option WHERE question_version_id = ? ORDER BY ord',
    [v.id],
  );
  const labelOf = (o: { source_label: string | null; ord: number }) => o.source_label ?? String.fromCharCode(65 + o.ord);
  const optText = (o: { text_json: string }) => richTextToPlain(parseRichText(fromJson(o.text_json)));
  const stem = parseRichText(fromJson(v.stem_json));
  const front: RichText = {
    v: 1,
    paragraphs: [
      ...stem.paragraphs,
      ...options.flatMap((o) => richTextFromPlain(`${labelOf(o)}. ${optText(o)}`, { kind: 'li' }).paragraphs),
      ...(questionOrigin === 'generated' ? richTextFromPlain(`(${QUESTION_ORIGIN_LABELS_AR.generated} — ليس من ملفاتك)`).paragraphs : []),
    ],
  };
  const chosen = new Set(fromJson<string[]>(a.selected_option_ids_json, []) ?? []);
  const answerLines = options.filter((o) => correct.includes(o.id)).map((o) => `${labelOf(o)}. ${optText(o)}`);
  const backParas: Paragraph[] = [
    ...richTextFromPlain(`الإجابة: ${answerLines.join(' — ')}`).paragraphs,
    ...richTextFromPlain(`مصدر الإجابة: ${ANSWER_STATUS_LABELS_AR[v.answer_status]}${v.answer_status === 'ai_derived' ? ' — ليست مفتاحًا من ملفاتك' : ''}.`).paragraphs,
  ];
  const explanation = v.explanation_json ? parseRichText(fromJson(v.explanation_json)) : null;
  if (explanation && explanation.paragraphs.length) backParas.push(...explanation.paragraphs);
  const chosenLines = options.filter((o) => chosen.has(o.id)).map((o) => `${labelOf(o)}. ${optText(o)}`);
  if (a.is_correct === 0 && chosenLines.length) backParas.push(...richTextFromPlain(`اخترتَ: ${chosenLines.join(' — ')}`).paragraphs);
  const back: RichText = { v: 1, paragraphs: backParas };

  // evidence: answer evidence of the version + citations of the explanation's claims
  const claimIds = new Set<string>();
  for (const p of explanation?.paragraphs ?? []) for (const r of p.runs) if (r.claim) claimIds.add(r.claim);
  const evidenceIds = new Set(ctx.db.all<{ evidence_id: string }>('SELECT evidence_id FROM answer_evidence WHERE question_version_id = ?', [v.id]).map((r) => r.evidence_id));
  if (claimIds.size) {
    for (const r of ctx.db.all<{ evidence_id: string }>(`SELECT evidence_id FROM citation WHERE claim_id IN (${[...claimIds].map(() => '?').join(',')})`, [...claimIds])) evidenceIds.add(r.evidence_id);
  }
  const occ = ctx.db.get<{ source_id: string; source_version_id: string }>(
    `SELECT o.source_id, o.source_version_id FROM question_occurrence o JOIN source s ON s.id = o.source_id
      WHERE o.question_id = ? AND s.deleted_at IS NULL ORDER BY o.status = 'current' DESC, o.created_at LIMIT 1`,
    [a.question_id],
  );
  const link = occ
    ? null
    : ctx.db.get<{ lecture_source_id: string; lecture_version_id: string | null }>(
        `SELECT lecture_source_id, lecture_version_id FROM question_lecture_link WHERE question_id = ? AND status <> 'rejected' ORDER BY status = 'accepted' DESC, score DESC LIMIT 1`,
        [a.question_id],
      );
  const refs = cleanRefs(ctx, {
    source_id: occ?.source_id ?? link?.lecture_source_id ?? null,
    source_version_id: occ?.source_version_id ?? link?.lecture_version_id ?? null,
    evidence_ids: [...evidenceIds],
  });
  const now = ctx.clock.now();
  const id = req.id ?? newId(now);
  const row = ctx.db.tx(() => {
    const r = insertCard(
      ctx,
      {
        id,
        kind: 'mistake',
        front,
        back,
        refs,
        origin: 'from_mistake',
        origin_ref: { question_attempt_id: a.id, question_id: a.question_id, question_version_id: a.question_version_id, question_origin: questionOrigin, answer_status: v.answer_status },
        note_id: null,
        cloze_index: null,
        image: null,
        device_id: null,
        created_at: now,
      },
      touchFn(ctx),
    );
    ctx.audit.record({ entityType: 'flashcard', entityId: r.id, action: 'create_from_mistake', summary: 'أنشأت بطاقة من سؤال أخطأت فيه.' });
    return r;
  });
  return { cards: viewsFor(ctx, [row]), created: true, duplicates: duplicatesOf(ctx, [row.id]), notes_ar: refs.notes_ar };
}

// ───────── create: image occlusion ─────────
export function checkMask(m: { box: { x: number; y: number; w: number; h: number }; label: string }): void {
  const b = m.box;
  const ok = [b.x, b.y, b.w, b.h].every((n) => Number.isFinite(n)) && b.x >= 0 && b.y >= 0 && b.w >= 0.005 && b.h >= 0.005 && b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001;
  if (!ok) throw new AppError('VALIDATION_FAILED', 'منطقة الإخفاء خارج حدود الصورة أو صغيرة جدًا.', 400);
  if (!m.label.trim() || m.label.length > 300) throw new AppError('VALIDATION_FAILED', 'اكتب اسم الجزء المخفي (حتى 300 حرف).', 400);
}

export function createOcclusion(ctx: AppContext, req: OcclusionCreateRequest): CardCreateResponse {
  if (req.note_id) {
    const ex = ctx.db.all<FlashcardRow>('SELECT * FROM flashcard WHERE note_id = ? ORDER BY created_at, id', [req.note_id]);
    if (ex.length) return { cards: viewsFor(ctx, ex), created: false, duplicates: [], notes_ar: [] };
  }
  const img = ctx.db.get<{ id: string; file_id: string | null; source_id: string | null; version_id: string | null }>(
    'SELECT id, file_id, source_id, version_id FROM image_asset WHERE id = ?',
    [req.image_asset_id],
  );
  if (!img) throw new AppError('NOT_FOUND', 'الصورة غير موجودة.', 404);
  if (!img.file_id) throw new AppError('CONFLICT', 'لا يوجد ملف محفوظ لهذه الصورة؛ لا يمكن صنع بطاقة إخفاء منها.', 409);
  if (!Array.isArray(req.masks) || req.masks.length === 0) throw new AppError('VALIDATION_FAILED', 'حدّد منطقة واحدة على الأقل لإخفائها.', 400);
  if (req.masks.length > MAX_MASKS) throw new AppError('VALIDATION_FAILED', `عدد المناطق أكبر من الحد المسموح (${MAX_MASKS}).`, 400);
  for (const m of req.masks) checkMask(m);
  const now = ctx.clock.now();
  const masks: OcclusionMask[] = req.masks.map((m) => ({ id: m.id && /^[A-Za-z0-9_-]{1,64}$/.test(m.id) ? m.id : newId(now), box: { ...m.box }, label: m.label.trim() }));
  if (new Set(masks.map((m) => m.id)).size !== masks.length) throw new AppError('VALIDATION_FAILED', 'معرّفات المناطق مكررة.', 400);
  const prompt = req.prompt?.trim() || 'ما اسم الجزء المخفي في المنطقة المحددة؟';
  const refs = cleanRefs(ctx, { source_id: img.source_id, source_version_id: img.version_id, concept_id: req.concept_id ?? null, topic_id: req.topic_id ?? null });
  const noteId = req.note_id ?? newId(now);
  const rows = ctx.db.tx(() =>
    masks.map((m) =>
      insertCard(
        ctx,
        {
          id: newId(now),
          kind: 'image_occlusion',
          front: richTextFromPlain(prompt),
          back: richTextFromPlain(m.label),
          refs,
          origin: 'owner',
          origin_ref: { image_asset_id: img.id },
          note_id: noteId,
          cloze_index: null,
          image: { image_asset_id: img.id, masks, active_mask_id: m.id },
          device_id: null,
          created_at: now,
        },
        touchFn(ctx),
      ),
    ),
  );
  ctx.audit.record({ entityType: 'flashcard', entityId: rows[0]!.id, action: 'create_occlusion', summary: `أنشأت ${cardsAr(rows.length)} لإخفاء أجزاء من صورة.` });
  return { cards: viewsFor(ctx, rows), created: true, duplicates: [], notes_ar: refs.notes_ar };
}

// ───────── edit ─────────
export function updateCard(ctx: AppContext, id: string, req: CardUpdateRequest): { card: FlashcardView; notes_ar: string[] } {
  const notes: string[] = [];
  const out = ctx.db.tx(() => {
    const r = liveCard(ctx.db, id);
    if (req.base_rev !== r.rev) {
      throw new AppError('CONFLICT', 'عُدّلت هذه البطاقة على جهاز آخر بعد أن فتحتها؛ لم يُحفظ تعديلك فوقها. راجع النسخة الحالية ثم أعد التعديل.', 409, {
        card: viewOf(ctx, id),
      });
    }
    const now = ctx.clock.now();
    const set: Record<string, unknown> = {};
    if (req.front !== undefined) {
      const front = toRich(req.front, r.kind === 'cloze' ? 'نص الإكمال' : 'وجه البطاقة', { required: true });
      if (r.kind === 'cloze' && !r.note_id && r.cloze_index !== null && !clozeIndexes(richTextToPlain(front)).includes(r.cloze_index)) {
        throw new AppError('VALIDATION_FAILED', `النص بعد التعديل لا يحتوي الفراغ c${r.cloze_index} الذي تسأل عنه هذه البطاقة.`, 400);
      }
      set.front_json = toJson(front);
    }
    if (req.back !== undefined) set.back_json = toJson(toRich(req.back, 'ظهر البطاقة', { required: r.kind === 'basic' || r.kind === 'mistake' }));
    if (req.concept_id !== undefined || req.topic_id !== undefined) {
      // an explicit null unlinks; an absent field keeps the stored link
      const refs = cleanRefs(ctx, { concept_id: req.concept_id !== undefined ? req.concept_id : r.concept_id, topic_id: req.topic_id !== undefined ? req.topic_id : r.topic_id });
      notes.push(...refs.notes_ar);
      set.concept_id = refs.concept_id;
      set.topic_id = refs.topic_id;
    }
    let image: ImageSpec | null = fromJson<ImageSpec>(r.image_json);
    if (req.mask) {
      if (r.kind !== 'image_occlusion' || !image) throw new AppError('VALIDATION_FAILED', 'هذه البطاقة ليست بطاقة إخفاء صورة.', 400);
      checkMask(req.mask);
      const activeId = image.active_mask_id;
      image = { ...image, masks: image.masks.map((m) => (m.id === activeId ? { id: m.id, box: { ...req.mask!.box }, label: req.mask!.label.trim() } : m)) };
      set.image_json = toJson(image);
      set.back_json = toJson(richTextFromPlain(req.mask.label.trim()));
    }
    if (Object.keys(set).length === 0) return findCard(ctx.db, id)!;
    const cols = Object.keys(set);
    ctx.db.run(`UPDATE flashcard SET ${cols.map((c) => `${c} = ?`).join(', ')}, rev = rev + 1, updated_at = ? WHERE id = ?`, [...cols.map((c) => set[c]), now, id]);
    // siblings share the cloze text / the image masks
    // a cloze note is one text: front and «Back Extra» edits reach every card of the note
    if (r.note_id && r.kind === 'cloze' && (set.front_json !== undefined || set.back_json !== undefined)) syncClozeSiblings(ctx, findCard(ctx.db, id)!, notes);
    if (r.note_id && req.mask && image) {
      for (const s of ctx.db.all<FlashcardRow>('SELECT * FROM flashcard WHERE note_id = ? AND id <> ? AND deleted_at IS NULL', [r.note_id, id])) {
        const si = fromJson<ImageSpec>(s.image_json);
        if (!si) continue;
        ctx.db.run('UPDATE flashcard SET image_json = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [toJson({ ...si, masks: image.masks }), now, s.id]);
        ctx.sync.touch('flashcard', s.id);
      }
    }
    if (resolveImpacts(ctx.db, id, 'edited', now)) notes.push('اعتُبر تعديلك مراجعةً للتنبيه المرتبط بالبطاقة.');
    const after = findCard(ctx.db, id)!;
    indexCard(ctx.db, after);
    ctx.sync.touch('flashcard', id);
    ctx.audit.record({ entityType: 'flashcard', entityId: id, action: 'edit', summary: 'عدّلت بطاقة.', before: { rev: r.rev }, after: { rev: after.rev } });
    return after;
  });
  return { card: viewOf(ctx, out.id), notes_ar: notes };
}

/** A cloze text edit: siblings get the new text; new indexes get cards; cards of removed indexes are tombstoned. */
function syncClozeSiblings(ctx: AppContext, edited: FlashcardRow, notes: string[]): void {
  const now = ctx.clock.now();
  const text = richTextToPlain(parseRichText(fromJson(edited.front_json)));
  const wanted = new Set(clozeIndexes(text));
  if (wanted.size === 0) throw new AppError('VALIDATION_FAILED', 'لا يوجد فراغ في النص بعد التعديل. استخدم الصيغة {{c1::الجواب}}.', 400);
  const siblings = ctx.db.all<FlashcardRow>('SELECT * FROM flashcard WHERE note_id = ? AND deleted_at IS NULL', [edited.note_id]);
  const have = new Set<number>();
  for (const s of siblings) {
    if (s.cloze_index !== null && !wanted.has(s.cloze_index)) {
      ctx.db.run('UPDATE flashcard SET deleted_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [now, now, s.id]);
      indexCard(ctx.db, { ...s, deleted_at: now });
      ctx.sync.touch('flashcard', s.id);
      notes.push(`حُذفت بطاقة الفراغ c${s.cloze_index} لأن الفراغ لم يعد في النص (سجل مراجعاتها محفوظ ويمكن استرجاعها).`);
      continue;
    }
    if (s.cloze_index !== null) have.add(s.cloze_index);
    if (s.id !== edited.id) {
      ctx.db.run('UPDATE flashcard SET front_json = ?, back_json = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [edited.front_json, edited.back_json, now, s.id]);
      indexCard(ctx.db, { ...s, front_json: edited.front_json, back_json: edited.back_json });
      ctx.sync.touch('flashcard', s.id);
    }
  }
  for (const n of [...wanted].sort((a, b) => a - b)) {
    if (have.has(n)) continue;
    const refs = refsOfRow(ctx, edited);
    insertCard(
      ctx,
      {
        id: newId(now),
        kind: 'cloze',
        front: parseRichText(fromJson(edited.front_json)),
        back: parseRichText(fromJson(edited.back_json)),
        refs,
        // the new index's text is the note's text: a generated note stays visibly generated
        origin: edited.origin,
        origin_ref: fromJson(edited.origin_ref_json),
        note_id: edited.note_id,
        cloze_index: n,
        image: null,
        device_id: null,
        created_at: now,
      },
      touchFn(ctx),
    );
    notes.push(`أُضيفت بطاقة للفراغ الجديد c${n}.`);
  }
}

export function refsOfRow(ctx: AppContext, r: FlashcardRow): CleanRefs {
  const snapshot = fromJson<CleanRefs['snapshot']>(r.evidence_snapshot_json, []) ?? [];
  return {
    source_id: r.source_id,
    source_version_id: r.source_version_id,
    concept_id: r.concept_id,
    topic_id: r.topic_id,
    evidence_ids: fromJson<string[]>(r.evidence_ids_json, []) ?? [],
    snapshot,
    region_ids: [],
    notes_ar: [],
  };
}

// ───────── suspend / bury / delete / restore ─────────
function mutate(ctx: AppContext, id: string, sql: string, params: unknown[], audit: { action: string; summary: string }): FlashcardView {
  ctx.db.tx(() => {
    const r = requireCard(ctx.db, id);
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE flashcard SET ${sql}, rev = rev + 1, updated_at = ? WHERE id = ?`, [...params, now, id]);
    const after = findCard(ctx.db, id)!;
    indexCard(ctx.db, after);
    ctx.sync.touch('flashcard', id);
    ctx.audit.record({ entityType: 'flashcard', entityId: id, action: audit.action, summary: audit.summary, before: { rev: r.rev }, after: { rev: after.rev } });
  });
  return viewOf(ctx, id);
}

export function setSuspended(ctx: AppContext, id: string, suspended: boolean): FlashcardView {
  liveCard(ctx.db, id);
  return mutate(ctx, id, 'suspended = ?', [suspended ? 1 : 0], { action: suspended ? 'suspend' : 'unsuspend', summary: suspended ? 'أوقفت بطاقة مؤقتًا.' : 'أعدت بطاقة موقوفة.' });
}

export function bury(ctx: AppContext, id: string, until: number | null | undefined): FlashcardView {
  liveCard(ctx.db, id);
  const tz = srsContext(ctx).timezone;
  const now = ctx.clock.now();
  const t = until ?? dayEndMs(dayOf(now, tz), tz);
  if (t <= now) throw new AppError('VALIDATION_FAILED', 'وقت التأجيل يجب أن يكون في المستقبل.', 400);
  return mutate(ctx, id, 'buried_until = ?', [t], { action: 'bury', summary: 'أجّلت بطاقة.' });
}

export function unbury(ctx: AppContext, id: string): FlashcardView {
  liveCard(ctx.db, id);
  return mutate(ctx, id, 'buried_until = NULL', [], { action: 'unbury', summary: 'ألغيت تأجيل بطاقة.' });
}

export function deleteCard(ctx: AppContext, id: string): FlashcardView {
  const r = requireCard(ctx.db, id);
  if (r.deleted_at !== null) return viewOf(ctx, id);
  return mutate(ctx, id, 'deleted_at = ?', [ctx.clock.now()], { action: 'delete', summary: 'حذفت بطاقة (سجل مراجعاتها محفوظ ويمكن استرجاعها).' });
}

export function restoreCard(ctx: AppContext, id: string): FlashcardView {
  const r = requireCard(ctx.db, id);
  if (r.deleted_at === null) return viewOf(ctx, id);
  return mutate(ctx, id, 'deleted_at = NULL, merged_into_id = NULL', [], { action: 'restore', summary: 'استرجعت بطاقة محذوفة.' });
}

// ───────── impacts (AC-26) ─────────
export function resolveCardImpact(ctx: AppContext, id: string, req: CardImpactResolveRequest): FlashcardView {
  const card = liveCard(ctx.db, id);
  viewOf(ctx, id, { refresh: true });
  ctx.db.tx(() => {
    const now = ctx.clock.now();
    if (req.resolution === 'relearn') {
      ctx.db.run('INSERT INTO review_reset (id, card_id, at, reason, created_at) VALUES (?, ?, ?, ?, ?)', [newId(now), id, now, 'owner_relearn_after_source_change', now]);
      recomputeState(ctx.db, card, srsContext(ctx), now);
    } else if (req.resolution === 'move_to_current_version') {
      if (!card.source_id) throw new AppError('VALIDATION_FAILED', 'البطاقة غير مرتبطة بمصدر.', 400);
      const s = ctx.db.get<{ current_version_id: string | null; frozen_version_id: string | null; deleted_at: number | null }>(
        'SELECT current_version_id, frozen_version_id, deleted_at FROM source WHERE id = ?',
        [card.source_id],
      );
      const active = s ? (s.frozen_version_id ?? s.current_version_id) : null;
      if (!s || s.deleted_at !== null || !active) throw new AppError('CONFLICT', 'لا توجد نسخة حالية متاحة لهذا المصدر.', 409);
      ctx.db.run('UPDATE flashcard SET source_version_id = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [active, now, id]);
      recordDependencies(ctx, 'flashcard', id, [active]);
    }
    resolveImpacts(ctx.db, id, req.resolution, now);
    ctx.db.run('UPDATE flashcard SET rev = rev + 1, updated_at = ? WHERE id = ?', [now, id]);
    ctx.sync.touch('flashcard', id);
    const label = { keep: 'أبقيتها كما هي', relearn: 'أعدت جدولتها لإعادة التعلم (سجل المراجعات محفوظ)', move_to_current_version: 'نقلتها إلى النسخة الحالية من المصدر' }[req.resolution];
    ctx.audit.record({ entityType: 'flashcard', entityId: id, action: `impact_${req.resolution}`, summary: `راجعت بطاقة متأثرة بتغيير المصدر: ${label}.` });
  });
  return viewOf(ctx, id, { refresh: true });
}

// ───────── duplicates (suggestions only) ─────────
function cardText(r: Pick<FlashcardRow, 'front_json' | 'back_json' | 'kind'>): { front: string; all: string } {
  const front = richTextToPlain(parseRichText(fromJson(r.front_json))).replace(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, '$1');
  const back = richTextToPlain(parseRichText(fromJson(r.back_json)));
  return { front: normalizeForSearch(front).replace(/\s+/g, ' ').trim(), all: normalizeForSearch(`${front}\n${back}`).replace(/\s+/g, ' ').trim() };
}

function tokens(s: string): Set<string> {
  return new Set(s.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Duplicate suggestions among live cards (optionally only pairs that involve `onlyIds`). Never merges. */
export function findDuplicates(ctx: AppContext, onlyIds?: string[]): CardDuplicateSuggestion[] {
  const rows = ctx.db.all<FlashcardRow>(
    `SELECT * FROM flashcard WHERE deleted_at IS NULL AND kind <> 'image_occlusion' ORDER BY created_at, id LIMIT 20000`,
  );
  const decided = new Set(ctx.db.all<{ card_a_id: string; card_b_id: string }>('SELECT card_a_id, card_b_id FROM flashcard_duplicate_decision').map((d) => pairKey(d.card_a_id, d.card_b_id)));
  const only = onlyIds ? new Set(onlyIds) : null;
  const info = rows.map((r) => {
    const t = cardText(r);
    return { r, front: t.front, toks: tokens(t.all) };
  });
  const out: CardDuplicateSuggestion[] = [];
  const seen = new Set<string>();
  const consider = (a: (typeof info)[number], b: (typeof info)[number], kind: CardDuplicateSuggestion['kind'], sim: number) => {
    if (a.r.id === b.r.id) return;
    if (a.r.note_id && a.r.note_id === b.r.note_id) return; // cloze siblings are one note
    if (only && !only.has(a.r.id) && !only.has(b.r.id)) return;
    const k = pairKey(a.r.id, b.r.id);
    if (seen.has(k) || decided.has(k)) return;
    seen.add(k);
    const [x, y] = a.r.id < b.r.id ? [a, b] : [b, a];
    out.push({
      card_a_id: x.r.id,
      card_b_id: y.r.id,
      kind,
      similarity: Math.round(sim * 100) / 100,
      reason_ar: kind === 'same_front' ? 'للبطاقتين السؤال نفسه بعد توحيد الكتابة.' : `تتشابه كلمات البطاقتين بنسبة ${Math.round(sim * 100)}٪ (تقدير آلي) — قد تكونان مكررتين.`,
    });
  };
  // 1) same normalized front · 2) similar text within the same source (blocking keeps it cheap)
  const byFront = new Map<string, Array<(typeof info)[number]>>();
  for (const i of info) if (i.front) pushTo(byFront, i.front, i);
  const bySource = new Map<string, Array<(typeof info)[number]>>();
  for (const i of info) pushTo(bySource, i.r.source_id ?? '', i);
  const similar = (x: (typeof info)[number], y: (typeof info)[number]) => {
    if (x.toks.size < 4 || y.toks.size < 4) return;
    const sim = jaccard(x.toks, y.toks);
    if (sim >= 0.8) consider(x, y, 'similar', sim);
  };
  if (only) {
    // only pairs that involve the given cards: compare each of them with its blocks, not every pair
    for (const x of info) {
      if (!only.has(x.r.id)) continue;
      if (x.front) for (const y of byFront.get(x.front) ?? []) consider(x, y, 'same_front', 1);
      for (const y of bySource.get(x.r.source_id ?? '') ?? []) if (y.r.id !== x.r.id) similar(x, y);
    }
  } else {
    for (const group of byFront.values()) for (let a = 0; a < group.length; a++) for (let b = a + 1; b < group.length; b++) consider(group[a]!, group[b]!, 'same_front', 1);
    for (const group of bySource.values()) {
      if (group.length > 3000) continue;
      for (let a = 0; a < group.length; a++) for (let b = a + 1; b < group.length; b++) similar(group[a]!, group[b]!);
    }
  }
  return out.slice(0, 500);
}

function duplicatesOf(ctx: AppContext, ids: string[]): CardDuplicateSuggestion[] {
  return findDuplicates(ctx, ids).slice(0, 20);
}

export function decideDuplicate(ctx: AppContext, req: CardDuplicateDecisionRequest): { kept: FlashcardView | null } {
  if (req.card_a_id === req.card_b_id) throw new AppError('VALIDATION_FAILED', 'اختر بطاقتين مختلفتين.', 400);
  const a = requireCard(ctx.db, req.card_a_id);
  const b = requireCard(ctx.db, req.card_b_id);
  const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  const now = ctx.clock.now();
  if (req.decision === 'not_duplicate') {
    ctx.db.run(
      `INSERT INTO flashcard_duplicate_decision (card_a_id, card_b_id, decision, decided_at) VALUES (?, ?, 'not_duplicate', ?)
       ON CONFLICT(card_a_id, card_b_id) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at`,
      [x, y, now],
    );
    ctx.audit.record({ entityType: 'flashcard', entityId: x, action: 'duplicate_rejected', summary: 'أكدت أن بطاقتين ليستا مكررتين.' });
    return { kept: null };
  }
  const keepId = req.keep_id;
  if (!keepId || (keepId !== a.id && keepId !== b.id)) throw new AppError('VALIDATION_FAILED', 'حدّد البطاقة التي تبقى (keep_id) من البطاقتين.', 400);
  const drop = keepId === a.id ? b : a;
  if (a.deleted_at !== null || b.deleted_at !== null) throw new AppError('CONFLICT', 'إحدى البطاقتين محذوفة بالفعل.', 409);
  ctx.db.tx(() => {
    ctx.db.run('UPDATE flashcard SET deleted_at = ?, merged_into_id = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [now, keepId, now, drop.id]);
    indexCard(ctx.db, { ...drop, deleted_at: now });
    ctx.db.run(
      `INSERT INTO flashcard_duplicate_decision (card_a_id, card_b_id, decision, decided_at) VALUES (?, ?, 'merged', ?)
       ON CONFLICT(card_a_id, card_b_id) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at`,
      [x, y, now],
    );
    ctx.sync.touch('flashcard', drop.id);
    ctx.audit.record({ entityType: 'flashcard', entityId: drop.id, action: 'merge', summary: 'دمجت بطاقة مكررة في أخرى (البطاقة المدموجة وسجل مراجعاتها محفوظان ويمكن استرجاعها).', after: { merged_into_id: keepId } });
  });
  return { kept: viewOf(ctx, keepId) };
}

// ───────── helpers ─────────
export function cardsAr(n: number): string {
  if (n === 1) return 'بطاقة واحدة';
  if (n === 2) return 'بطاقتين';
  if (n <= 10) return `${n} بطاقات`;
  return `${n} بطاقة`;
}

function clipText(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
