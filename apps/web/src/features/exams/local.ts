// Local-first persistence of practice / exam attempts (ARCHITECTURE §3.4, §4; spec §39, §47).
//
//  * The exam attempt state (answers, timer, pause, current question, flags) is written to IndexedDB FIRST
//    (Dexie table examAttempts) together with an 'exam_attempt' upsert in the outbox — one transaction, never
//    waiting for the network. The payload is always the FULL state (the outbox coalesces unsent upserts).
//  * A practice answer that the owner checks is also an append-only 'question_attempt' (client ULID, idempotent).
//  * The delivered session (items without keys) is cached in kv so an exam created online can be taken offline
//    and resumed after a reload or crash.
//  * Appliers bring server copies in without overwriting unsynced local writes.
import type { ExamAttemptDTO, ExamSessionView, MistakeType, QuestionAttemptDTO, QuestionAttemptSyncPayload } from '@medlevo/shared';
import { kvGet, kvSet, type ExamAttemptRow, type MedLevoDB, type QuestionAttemptRow } from '../../lib/localdb';
import { writeAndEnqueue, type SyncApplier, type SyncEngine } from '../../lib/sync';
import { mergeStates, stateFromDTO, syncPayload, type LocalExamState } from './model';

/** Dexie row of an exam attempt: the indexed fields of localdb.ts + the runner state (non-indexed fields). */
export interface LocalExamAttemptRow extends ExamAttemptRow {
  state: LocalExamState;
  /** server revision last seen (diagnostics) */
  serverRev?: number | null;
}

/** Dexie row of a question attempt (camelCase like localdb.ts; the server accepts camelCase payload keys too). */
export interface LocalQuestionAttemptRow extends QuestionAttemptRow {
  examItemIndex?: number | null;
  solutionViewedBeforeAnswer?: boolean;
  flagged?: boolean;
  mistakeType?: MistakeType | null;
  mistakeOrigin?: 'auto' | 'owner' | null;
  isCorrect?: boolean | null;
  scored?: boolean;
}

const SESSION_KEY = (attemptId: string) => `exams.session.${attemptId}`;
const WRITTEN_DRAFT_KEY = (questionId: string) => `exams.written.draft.${questionId}`;

export async function cacheSession(db: MedLevoDB, s: ExamSessionView): Promise<void> {
  await kvSet(db, SESSION_KEY(s.attempt.id), s);
}

export async function cachedSession(db: MedLevoDB, attemptId: string): Promise<ExamSessionView | null> {
  return (await kvGet<ExamSessionView>(db, SESSION_KEY(attemptId))) ?? null;
}

export async function localAttempt(db: MedLevoDB, attemptId: string): Promise<LocalExamAttemptRow | null> {
  return ((await db.examAttempts.get(attemptId)) as LocalExamAttemptRow | undefined) ?? null;
}

/** Unsynced local writes for an entity (pending / conflict / rejected ops). */
export async function hasLocalOps(db: MedLevoDB, entityType: string, id: string): Promise<boolean> {
  const n = await db.outbox
    .where('[entity_type+entity_id]')
    .equals([entityType, id])
    .filter((o) => o.status === 'pending')
    .count();
  return n > 0;
}

/** The state to resume from: local unsynced writes merged with the server copy (per item, never dropping). */
export async function resumeState(db: MedLevoDB, session: ExamSessionView): Promise<LocalExamState> {
  const server = stateFromDTO(session.attempt);
  const local = await localAttempt(db, session.attempt.id);
  if (!local?.state) return server;
  return mergeStates(local.state, server);
}

/** Save the runner state locally + enqueue the full-state upsert (one transaction). */
export async function saveState(db: MedLevoDB, meta: { attemptId: string; examId: string; startedAt: number }, state: LocalExamState, now = Date.now()): Promise<void> {
  const row: LocalExamAttemptRow = {
    id: meta.attemptId,
    examId: meta.examId,
    status: state.status,
    startedAt: meta.startedAt,
    updatedAt: now,
    syncState: 'pending_sync',
    state,
  };
  await writeAndEnqueue(db, db.examAttempts, row, { entity_type: 'exam_attempt', op: 'upsert', payload: syncPayload(state, now), client_ts: now });
}

/** A checked practice answer as an append-only question attempt (idempotent by its client id). */
export async function recordQuestionAttempt(db: MedLevoDB, p: QuestionAttemptSyncPayload, now = Date.now()): Promise<void> {
  if (await db.questionAttempts.get(p.id)) return; // already recorded on this device (append-only)
  const row: LocalQuestionAttemptRow = {
    id: p.id,
    questionId: p.question_id,
    questionVersionId: p.question_version_id,
    examAttemptId: p.exam_attempt_id ?? null,
    examItemIndex: p.exam_item_index ?? null,
    selectedOptionIds: p.selected_option_ids,
    confidence: p.confidence ?? null,
    hintsUsed: p.hints_used ?? 0,
    solutionViewedBeforeAnswer: p.solution_viewed_before_answer ?? false,
    timeMs: p.time_ms ?? null,
    flagged: p.flagged ?? false,
    answeredAt: p.answered_at,
    updatedAt: now,
    createdAt: now,
    syncState: 'pending_sync',
  };
  const payload: QuestionAttemptSyncPayload = { ...p };
  await writeAndEnqueue(db, db.questionAttempts, row, { entity_type: 'question_attempt', op: 'append', payload, client_ts: now });
}

/** Owner edit of the mistake type (the answer itself never changes): an upsert of the derived signal only. */
export async function saveMistakeType(db: MedLevoDB, attempt: Pick<QuestionAttemptDTO, 'id' | 'question_id' | 'question_version_id' | 'answered_at'>, type: MistakeType | null, now = Date.now()): Promise<void> {
  const cur = (await db.questionAttempts.get(attempt.id)) as LocalQuestionAttemptRow | undefined;
  const row: LocalQuestionAttemptRow = {
    ...(cur ?? { id: attempt.id, questionId: attempt.question_id, questionVersionId: attempt.question_version_id, answeredAt: attempt.answered_at, createdAt: now }),
    mistakeType: type,
    mistakeOrigin: 'owner',
    updatedAt: now,
    syncState: 'pending_sync',
  };
  await writeAndEnqueue(db, db.questionAttempts, row, { entity_type: 'question_attempt', op: 'upsert', payload: { mistake_type: type }, client_ts: now });
}

export async function loadWrittenDraft(db: MedLevoDB, questionId: string): Promise<string> {
  return (await kvGet<string>(db, WRITTEN_DRAFT_KEY(questionId))) ?? '';
}
export async function saveWrittenDraft(db: MedLevoDB, questionId: string, text: string): Promise<void> {
  await kvSet(db, WRITTEN_DRAFT_KEY(questionId), text);
}

// ───────── appliers ─────────
const examAttemptApplier: SyncApplier = async (change, { db, localOps }) => {
  const dto = change.entity as ExamAttemptDTO | null;
  if (!dto || typeof dto !== 'object' || !dto.id) return;
  const cur = (await db.examAttempts.get(dto.id)) as LocalExamAttemptRow | undefined;
  const server = stateFromDTO(dto);
  // unsynced local writes win per item (merge), a finished server copy is final
  const pending = localOps.some((o) => o.status === 'pending');
  const state = pending && cur?.state ? mergeStates(cur.state, server) : server;
  await db.examAttempts.put({
    ...(cur ?? {}),
    id: dto.id,
    examId: dto.exam_id,
    status: state.status,
    startedAt: dto.started_at,
    updatedAt: Math.max(cur?.updatedAt ?? 0, dto.updated_at),
    syncState: cur?.syncState ?? 'synced',
    state,
    serverRev: dto.rev,
  } as LocalExamAttemptRow);
};

const questionAttemptApplier: SyncApplier = async (change, { db, localOps }) => {
  const dto = change.entity as QuestionAttemptDTO | null;
  if (!dto || typeof dto !== 'object' || !dto.id) return;
  if (localOps.some((o) => o.status === 'pending')) return; // a local edit is on its way
  const cur = (await db.questionAttempts.get(dto.id)) as LocalQuestionAttemptRow | undefined;
  const row: LocalQuestionAttemptRow = {
    ...(cur ?? {}),
    id: dto.id,
    questionId: dto.question_id,
    questionVersionId: dto.question_version_id,
    examAttemptId: dto.exam_attempt_id,
    examItemIndex: dto.exam_item_index,
    selectedOptionIds: dto.selected_option_ids,
    confidence: dto.confidence,
    hintsUsed: dto.hints_used,
    solutionViewedBeforeAnswer: dto.solution_viewed_before_answer,
    timeMs: dto.time_ms,
    flagged: dto.flagged,
    mistakeType: dto.mistake_type,
    mistakeOrigin: dto.mistake_origin,
    isCorrect: dto.is_correct,
    scored: dto.scored,
    answeredAt: dto.answered_at,
    createdAt: dto.created_at,
    updatedAt: Math.max(cur?.updatedAt ?? 0, dto.created_at),
    syncState: cur?.syncState ?? 'synced',
    rev: dto.rev,
  };
  await db.questionAttempts.put(row);
};

let registered: SyncEngine | null = null;

/** Registers the exams appliers once per engine (called by the exams screens). */
export function registerExamAppliers(engine: SyncEngine): void {
  if (registered === engine) return;
  registered = engine;
  engine.registerApplier('exam_attempt', examAttemptApplier);
  engine.registerApplier('question_attempt', questionAttemptApplier);
}

export const __test = { examAttemptApplier, questionAttemptApplier };
