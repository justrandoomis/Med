// Sync entity handlers 'flashcard' and 'review_event' (ARCHITECTURE §3.4, §47, AC-23 server side, AC-24).
// Payloads match the web Dexie rows (apps/web/src/lib/localdb.ts FlashcardRow / ReviewEventRow — camelCase) and
// the shared DTOs (snake_case); both spellings are accepted.
//
//  flashcard     upsert: absent → insert · base_rev == rev → apply (rev+1) · same content re-sent → duplicate ·
//                stale / missing base_rev with different content → KEEP BOTH (the incoming edit becomes a new card with
//                conflict_of_id, like notes) → conflict_kept_both · same content, other flags (suspend / bury) → merged ·
//                an edit of a card deleted elsewhere → kept as a new card (the delete stays) → conflict_kept_both.
//                delete: tombstone (deleted_at, rev+1) · already deleted → duplicate · stale delete of a card edited
//                elsewhere since → the edited card is kept → conflict_kept_both · unknown card → rejected with reason.
//                'generated' cards cannot be created from a device (generation is server-side and evidence-checked).
//  review_event  append-only, idempotent by id (a re-sent event → duplicate, never counted twice). An event for an
//                unknown or deleted card is REJECTED with the reason (recorded in sync_operation, returned to the
//                device) — never silently dropped and never applied. delete is refused.
import { FLASHCARD_KINDS, clozeIndexes, richTextToPlain, stableStringify, type SyncOp } from '@medlevo/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { SyncApplyResult, SyncEntityHandler, SyncTx } from '../sync/registry';
import { checkMask, cleanRefs, insertCard, recordCardDependencies, toRich, type CleanRefs } from './cards';
import { eventDTO, findCard, indexCard, resolveImpacts, viewsFor, type FlashcardRow, type ImageSpec, type ReviewEventRow } from './store';
import { insertReviewEvent, reviewEventSchema } from './review';

export const MAX_SYNC_PAYLOAD_CHARS = 200_000;

// ───────── payload normalization (Dexie rows are camelCase) ─────────
function snake(k: string): string {
  return k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
export function normalizeKeys(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const s = snake(k);
    if (s !== k && Object.prototype.hasOwnProperty.call(v, s)) continue; // the snake_case key wins
    out[s] = val;
  }
  return out;
}

const id = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'معرّف غير صالح.');
const unit = z.number().refine((n) => Number.isFinite(n) && n >= 0 && n <= 1, 'قيمة خارج حدود الصورة.');
const maskSchema = z.object({ id, box: z.object({ x: unit, y: unit, w: unit, h: unit }), label: z.string().trim().min(1).max(300) });

const flashcardPayloadSchema = z.object({
  id: id.optional(),
  kind: z.enum(FLASHCARD_KINDS),
  front: z.unknown(),
  back: z.unknown(),
  image: z.object({ image_asset_id: id, masks: z.array(maskSchema).min(1).max(50), active_mask_id: id.optional() }).nullable().optional(),
  note_id: id.nullable().optional(),
  cloze_index: z.number().int().min(1).max(999).nullable().optional(),
  concept_id: id.nullable().optional(),
  topic_id: id.nullable().optional(),
  source_id: id.nullable().optional(),
  source_version_id: id.nullable().optional(),
  evidence_ids: z.array(id).max(50).optional(),
  origin: z.enum(['owner', 'generated', 'from_mistake', 'from_selection']).optional(),
  origin_ref: z.record(z.string(), z.unknown()).nullable().optional(),
  suspended: z.boolean().optional(),
  buried_until: z.number().int().nonnegative().nullable().optional(),
  created_at: z.number().int().nonnegative().optional(),
});

// the review event as a device sends it; an id inside the payload must match the op's entity id (checked by parse)
const reviewEventPayloadSchema = reviewEventSchema.extend({ id: id.optional() });
type FlashcardPayload = z.infer<typeof flashcardPayloadSchema>;

function parse<S extends z.ZodType>(schema: S, op: SyncOp, whatAr: string): z.output<S> {
  let size = 0;
  try {
    size = JSON.stringify(op.payload ?? null).length;
  } catch {
    throw new AppError('VALIDATION_FAILED', `تعذّر قراءة بيانات ${whatAr}.`, 400);
  }
  if (size > MAX_SYNC_PAYLOAD_CHARS) throw new AppError('PAYLOAD_TOO_LARGE', `بيانات ${whatAr} أكبر من الحد المسموح للمزامنة.`, 413);
  const r = schema.safeParse(normalizeKeys(op.payload));
  if (!r.success) {
    const where = r.error.issues[0]?.path.join('.') || 'payload';
    throw new AppError('VALIDATION_FAILED', `رفض الخادم ${whatAr} لأن بياناتها غير صالحة (${where}).`, 400);
  }
  const data = r.data as { id?: string };
  if (data.id !== undefined && data.id !== op.entity_id) throw new AppError('VALIDATION_FAILED', `معرّف ${whatAr} داخل البيانات لا يطابق معرّف العملية.`, 400);
  return r.data;
}

interface Fields {
  kind: FlashcardRow['kind'];
  front_json: string;
  back_json: string;
  image_json: string | null;
  cloze_index: number | null;
  note_id: string | null;
  refs: CleanRefs;
  origin: FlashcardRow['origin'];
  origin_ref_json: string | null;
  suspended: number;
  buried_until: number | null;
}

function sameSet(a: string[], b: string[]): boolean {
  const x = new Set(a);
  return x.size === new Set(b).size && b.every((v) => x.has(v));
}

/**
 * Validate a payload into stored fields (content rules per kind). For an existing card, a field the payload does
 * not carry keeps its stored value (the web Dexie row has no cloze index, image, note, concept or topic fields), and
 * unchanged references are kept exactly as stored — never re-resolved to another version, never silently dropped
 * (a citation whose evidence disappeared stays in the snapshot, shown as unavailable).
 */
function fieldsOf(ctx: AppContext, p: FlashcardPayload, present: Set<string>, existing: FlashcardRow | null): Fields {
  if (!existing && p.origin === 'generated') {
    throw new AppError('VALIDATION_FAILED', 'لا تُنشأ بطاقات «مولدة» من الجهاز؛ التوليد يتم على الخادم ويُتحقق من أدلته.', 400);
  }
  const has = (k: string) => present.has(k);
  const keep = (k: string) => !!existing && !has(k);
  const front = toRich(p.front as never, p.kind === 'cloze' ? 'نص الإكمال' : 'وجه البطاقة', { required: true });
  const back = toRich((p.back ?? null) as never, 'ظهر البطاقة', { required: p.kind === 'basic' || p.kind === 'mistake' });
  let clozeIndex: number | null = null;
  let image: ImageSpec | null = null;
  if (p.kind === 'cloze') {
    const idx = clozeIndexes(richTextToPlain(front));
    if (idx.length === 0) throw new AppError('VALIDATION_FAILED', 'بطاقة الإكمال لا تحتوي فراغًا بالصيغة {{c1::الجواب}}.', 400);
    const stored = existing?.kind === 'cloze' ? existing.cloze_index : null;
    clozeIndex = (has('cloze_index') ? (p.cloze_index ?? null) : stored) ?? (idx.length === 1 ? idx[0]! : null);
    if (clozeIndex === null) throw new AppError('VALIDATION_FAILED', 'حدّد رقم الفراغ (cloze_index) لهذه البطاقة: النص فيه أكثر من فراغ.', 400);
    if (!idx.includes(clozeIndex)) throw new AppError('VALIDATION_FAILED', `الفراغ c${clozeIndex} غير موجود في نص البطاقة.`, 400);
  }
  if (p.kind === 'image_occlusion') {
    if (has('image')) {
      if (!p.image) throw new AppError('VALIDATION_FAILED', 'بطاقة إخفاء الصورة تحتاج الصورة ومناطق الإخفاء.', 400);
      if (!ctx.db.get('SELECT 1 AS x FROM image_asset WHERE id = ?', [p.image.image_asset_id])) throw new AppError('VALIDATION_FAILED', 'الصورة المحددة غير موجودة على الخادم.', 400);
      for (const m of p.image.masks) checkMask(m);
      if (new Set(p.image.masks.map((m) => m.id)).size !== p.image.masks.length) throw new AppError('VALIDATION_FAILED', 'معرّفات مناطق الإخفاء مكررة.', 400);
      const active = p.image.active_mask_id ?? (p.image.masks.length === 1 ? p.image.masks[0]!.id : undefined);
      if (!active || !p.image.masks.some((m) => m.id === active)) throw new AppError('VALIDATION_FAILED', 'حدّد المنطقة التي تسأل عنها هذه البطاقة (active_mask_id).', 400);
      image = { image_asset_id: p.image.image_asset_id, masks: p.image.masks.map((m) => ({ id: m.id, box: { ...m.box }, label: m.label })), active_mask_id: active };
    } else {
      image = existing?.kind === 'image_occlusion' ? fromJson<ImageSpec>(existing.image_json) : null;
      if (!image) throw new AppError('VALIDATION_FAILED', 'بطاقة إخفاء الصورة تحتاج الصورة ومناطق الإخفاء.', 400);
    }
  }
  const storedEvidence = existing ? (fromJson<string[]>(existing.evidence_ids_json, []) ?? []) : [];
  const evidenceUnchanged = !!existing && (!has('evidence_ids') || sameSet(p.evidence_ids ?? [], storedEvidence));
  const refs = cleanRefs(ctx, {
    source_id: keep('source_id') ? existing!.source_id : (p.source_id ?? null),
    source_version_id: keep('source_version_id') ? existing!.source_version_id : (p.source_version_id ?? null),
    concept_id: keep('concept_id') ? existing!.concept_id : (p.concept_id ?? null),
    topic_id: keep('topic_id') ? existing!.topic_id : (p.topic_id ?? null),
    evidence_ids: evidenceUnchanged ? [] : (p.evidence_ids ?? []),
  });
  if (evidenceUnchanged) {
    refs.evidence_ids = storedEvidence;
    refs.snapshot = fromJson<CleanRefs['snapshot']>(existing!.evidence_snapshot_json, []) ?? [];
    refs.region_ids = [];
  }
  return {
    kind: p.kind,
    front_json: JSON.stringify(front),
    back_json: JSON.stringify(back),
    image_json: image ? toJson(image) : null,
    cloze_index: clozeIndex,
    note_id: has('note_id') ? (p.note_id ?? null) : (existing?.note_id ?? null),
    refs,
    origin: existing ? existing.origin : (p.origin ?? 'owner'),
    origin_ref_json: has('origin_ref') ? (p.origin_ref ? toJson(p.origin_ref) : null) : (existing?.origin_ref_json ?? null),
    suspended: has('suspended') ? (p.suspended ? 1 : 0) : (existing?.suspended ?? 0),
    buried_until: has('buried_until') ? (p.buried_until ?? null) : (existing?.buried_until ?? null),
  };
}

function contentKey(f: Pick<Fields, 'kind' | 'front_json' | 'back_json' | 'image_json' | 'cloze_index' | 'note_id'> & { concept_id: string | null; topic_id: string | null; source_id: string | null; source_version_id: string | null; evidence_ids: string[] }): string {
  return stableStringify({
    kind: f.kind,
    front: fromJson(f.front_json),
    back: fromJson(f.back_json),
    image: fromJson(f.image_json),
    cloze_index: f.cloze_index,
    note_id: f.note_id,
    concept_id: f.concept_id,
    topic_id: f.topic_id,
    source_id: f.source_id,
    source_version_id: f.source_version_id,
    evidence_ids: [...f.evidence_ids].sort(),
  });
}

const rowContent = (r: FlashcardRow) =>
  contentKey({ ...r, evidence_ids: fromJson<string[]>(r.evidence_ids_json, []) ?? [] });
const fieldsContent = (f: Fields) =>
  contentKey({ ...f, concept_id: f.refs.concept_id, topic_id: f.refs.topic_id, source_id: f.refs.source_id, source_version_id: f.refs.source_version_id, evidence_ids: f.refs.evidence_ids });

function clampCreated(createdAt: number | undefined, now: number): number {
  return typeof createdAt === 'number' && createdAt > 0 && createdAt <= now ? createdAt : now;
}

function serializeCard(ctx: AppContext, cardId: string): unknown | null {
  const r = findCard(ctx.db, cardId);
  return r ? viewsFor(ctx, [r])[0]! : null;
}

/**
 * The live conflict copy of `original` that already holds this content (G7 / AC-24: the same stale edit arriving again
 * under a new op id must not create a second identical card). A copy stands alone, so its note_id is not compared.
 */
function existingConflictCopy(tx: SyncTx, original: FlashcardRow, f: Fields): FlashcardRow | undefined {
  const want = fieldsContent({ ...f, note_id: null });
  return tx.db
    .all<FlashcardRow>('SELECT * FROM flashcard WHERE conflict_of_id = ? AND deleted_at IS NULL', [original.id])
    .find((c) => rowContent(c) === want);
}

function copyAsConflict(ctx: AppContext, original: FlashcardRow, f: Fields, tx: SyncTx, createdAt: number): string {
  const same = existingConflictCopy(tx, original, f);
  if (same) return same.id;
  const copyId = newId(tx.now);
  insertCard(
    ctx,
    {
      id: copyId,
      kind: f.kind,
      front: fromJson(f.front_json) as never,
      back: fromJson(f.back_json) as never,
      refs: f.refs,
      origin: f.origin,
      origin_ref: fromJson(f.origin_ref_json),
      // a preserved concurrent edit stands alone (it is not another card of the original's note)
      note_id: null,
      cloze_index: f.cloze_index,
      image: fromJson<ImageSpec>(f.image_json),
      suspended: f.suspended === 1,
      buried_until: f.buried_until,
      device_id: tx.deviceId,
      created_at: createdAt,
      conflict_of_id: original.id,
    },
    tx.touch,
  );
  return copyId;
}

export function flashcardHandler(ctx: AppContext): SyncEntityHandler {
  return {
    serialize: (cardId) => serializeCard(ctx, cardId),
    apply(op: SyncOp, tx: SyncTx): SyncApplyResult {
      if (op.op === 'append') throw new AppError('BAD_REQUEST', 'العملية «append» غير مدعومة للبطاقات؛ استخدم upsert أو delete.', 400);
      const existing = findCard(tx.db, op.entity_id);

      if (op.op === 'delete') {
        if (!existing) throw new AppError('NOT_FOUND', 'البطاقة غير موجودة على الخادم؛ لا شيء لحذفه.', 404);
        if (existing.deleted_at !== null) return { result: 'duplicate', entity: serializeCard(ctx, existing.id) };
        if (op.base_rev !== undefined && op.base_rev !== null && op.base_rev !== existing.rev) {
          return {
            result: 'conflict_kept_both',
            entity: serializeCard(ctx, existing.id),
            detail: 'عُدّلت هذه البطاقة على جهاز آخر بعد أن حذفتها؛ بقيت البطاقة المعدّلة محفوظة. احذفها مجددًا إن أردت.',
          };
        }
        tx.db.run('UPDATE flashcard SET deleted_at = ?, rev = rev + 1, updated_at = ?, device_id = ? WHERE id = ?', [tx.now, tx.now, tx.deviceId, existing.id]);
        indexCard(tx.db, { ...existing, deleted_at: tx.now });
        tx.touch('flashcard', existing.id);
        return { result: 'applied', entity: serializeCard(ctx, existing.id) };
      }

      const p = parse(flashcardPayloadSchema, op, 'البطاقة');
      const present = new Set(Object.keys(normalizeKeys(op.payload)));
      const f = fieldsOf(ctx, p, present, existing);
      const notes = f.refs.notes_ar;
      if (!existing) {
        insertCard(
          ctx,
          {
            id: op.entity_id,
            kind: f.kind,
            front: fromJson(f.front_json) as never,
            back: fromJson(f.back_json) as never,
            refs: f.refs,
            origin: f.origin,
            origin_ref: fromJson(f.origin_ref_json),
            note_id: f.note_id,
            cloze_index: f.cloze_index,
            image: fromJson<ImageSpec>(f.image_json),
            suspended: f.suspended === 1,
            buried_until: f.buried_until,
            device_id: tx.deviceId,
            created_at: clampCreated(p.created_at, tx.now),
          },
          tx.touch,
        );
        return notes.length ? { result: 'merged', entity: serializeCard(ctx, op.entity_id), detail: notes.join(' ') } : { result: 'applied', entity: serializeCard(ctx, op.entity_id) };
      }

      const sameContent = rowContent(existing) === fieldsContent(f);
      const sameFlags = existing.suspended === f.suspended && (existing.buried_until ?? null) === (f.buried_until ?? null);
      if (existing.deleted_at !== null) {
        if (sameContent) return { result: 'duplicate', entity: serializeCard(ctx, existing.id), detail: 'البطاقة محذوفة على الخادم.' };
        const copyId = copyAsConflict(ctx, existing, f, tx, clampCreated(p.created_at, tx.now));
        return {
          result: 'conflict_kept_both',
          entity: serializeCard(ctx, existing.id),
          detail: `حُذفت هذه البطاقة على جهاز آخر بينما عدّلتها هنا؛ حُفظ تعديلك بطاقةً جديدة (${copyId}) ولم يُلغَ الحذف.`,
        };
      }
      if (op.base_rev !== undefined && op.base_rev !== null && op.base_rev === existing.rev) {
        if (sameContent && sameFlags) return { result: 'duplicate', entity: serializeCard(ctx, existing.id) };
        tx.db.run(
          `UPDATE flashcard SET kind = ?, front_json = ?, back_json = ?, image_json = ?, cloze_index = ?, note_id = ?, concept_id = ?, topic_id = ?,
                  source_id = ?, source_version_id = ?, evidence_ids_json = ?, evidence_snapshot_json = ?, origin_ref_json = COALESCE(?, origin_ref_json),
                  suspended = ?, buried_until = ?, rev = rev + 1, updated_at = ?, device_id = ? WHERE id = ?`,
          [
            f.kind,
            f.front_json,
            f.back_json,
            f.image_json,
            f.cloze_index,
            f.note_id,
            f.refs.concept_id,
            f.refs.topic_id,
            f.refs.source_id,
            f.refs.source_version_id,
            toJson(f.refs.evidence_ids),
            toJson(f.refs.snapshot),
            f.origin_ref_json,
            f.suspended,
            f.buried_until,
            tx.now,
            tx.deviceId,
            existing.id,
          ],
        );
        const after = findCard(tx.db, existing.id)!;
        if (!sameContent) {
          resolveImpacts(tx.db, existing.id, 'edited', tx.now);
          recordCardDependencies(ctx, after, f.refs.region_ids);
        }
        indexCard(tx.db, after);
        tx.touch('flashcard', existing.id);
        return notes.length ? { result: 'merged', entity: serializeCard(ctx, existing.id), detail: notes.join(' ') } : { result: 'applied', entity: serializeCard(ctx, existing.id) };
      }
      // stale (or unknown) base: never overwrite another device's edit silently
      if (sameContent) {
        if (sameFlags) return { result: 'duplicate', entity: serializeCard(ctx, existing.id) };
        // suspend / bury are preferences: the later change wins by the device time (§3.4); an older one is not applied
        if (typeof op.client_ts !== 'number' || op.client_ts <= existing.updated_at) {
          return { result: 'merged', entity: serializeCard(ctx, existing.id), detail: 'تغيير الإيقاف/التأجيل أقدم من تغيير أحدث على جهاز آخر؛ بقيت الحالة الأحدث.' };
        }
        tx.db.run('UPDATE flashcard SET suspended = ?, buried_until = ?, rev = rev + 1, updated_at = ?, device_id = ? WHERE id = ?', [f.suspended, f.buried_until, tx.now, tx.deviceId, existing.id]);
        tx.touch('flashcard', existing.id);
        return { result: 'merged', entity: serializeCard(ctx, existing.id), detail: 'دُمج تغيير الإيقاف/التأجيل؛ محتوى البطاقة لم يتغير.' };
      }
      const copyId = copyAsConflict(ctx, existing, f, tx, clampCreated(p.created_at, tx.now));
      return {
        result: 'conflict_kept_both',
        entity: serializeCard(ctx, existing.id),
        detail: `عُدّلت البطاقة على جهاز آخر قبل وصول تعديلك؛ احتُفظ بالنسختين: تعديلك محفوظ بطاقةً جديدة (${copyId}).`,
      };
    },
  };
}

export function reviewEventHandler(ctx: AppContext): SyncEntityHandler {
  const serialize = (eventId: string) => {
    const r = ctx.db.get<ReviewEventRow>('SELECT * FROM review_event WHERE id = ?', [eventId]);
    return r ? eventDTO(r) : null;
  };
  return {
    serialize,
    apply(op: SyncOp, tx: SyncTx): SyncApplyResult {
      if (op.op === 'delete') throw new AppError('CONFLICT', 'لا تُحذف المراجعات؛ هي سجل تعلمك.', 409);
      const p = parse(reviewEventPayloadSchema, op, 'المراجعة');
      const res = insertReviewEvent(ctx, op.entity_id, p, { deviceId: tx.deviceId, touch: tx.touch });
      if (!res.inserted && res.row.card_id !== p.card_id) {
        return { result: 'duplicate', entity: eventDTO(res.row), detail: 'يوجد حدث مراجعة بالمعرّف نفسه لبطاقة أخرى؛ بقي الحدث الأول كما هو.' };
      }
      return { result: res.inserted ? 'applied' : 'duplicate', entity: eventDTO(res.row) };
    },
  };
}

export function registerLearningSync(ctx: AppContext): void {
  ctx.sync.registerEntity('flashcard', flashcardHandler(ctx));
  ctx.sync.registerEntity('review_event', reviewEventHandler(ctx));
}

