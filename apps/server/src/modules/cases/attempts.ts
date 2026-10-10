// Case attempts: start (idempotent by client id), events (append-only, idempotent by event id), the run view (only
// what has been revealed — never an unchosen decision's appropriateness, explanation or branch) and the final report.
// The state is always obtained by replaying the pinned definition with the stored events (engine.ts); state_json is a
// snapshot for listing/backup readers only.
import {
  AUTHORED_DATA_NOTE_AR,
  CASE_FACT_KIND_LABELS_AR,
  CASE_KIND_LABELS_AR,
  CASE_ORIGIN_LABELS_AR,
  CASE_STAGE_TYPE_LABELS_AR,
  CHECKLIST_CATEGORY_LABELS_AR,
  DECISION_APPROPRIATENESS_LABELS_AR,
  OSCE_STATION_TYPE_LABELS_AR,
  caseEventInputSchema,
  caseStartRequestSchema,
  type CaseAttemptListResponse,
  type CaseDefinition,
  type CaseEventResponse,
  type CaseHistoryEntry,
  type CaseReportView,
  type CaseRunView,
  type CaseSentence,
  type CaseStoredEvent,
  type ChecklistResult,
  type EvidenceView,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { parseWith } from '../../lib/http';
import { newId } from '../../lib/ids';
import { getClaimViews, getViews } from '../evidence/services';
import { honestyFor, isPlayable, sentenceIsBacked, VOICE_UNAVAILABLE_AR } from './definition';
import { apply, EngineError, judgeChecklist, judgeViva, orderCheck, replay, type EngineState } from './engine';
import { aiJudge, requireJudge } from './judge';
import { definitionOf, eventsOf, getAttemptRow, getCaseRow, getVersionById, getVersionRow, scopeOf, validationOf, type AttemptRow, type EventRow } from './store';
import { clip, matchAny } from './text';

// ───────── loading ─────────
interface Loaded {
  attempt: AttemptRow;
  def: CaseDefinition;
  versionNo: number;
  caseRow: ReturnType<typeof getCaseRow>;
  events: CaseStoredEvent[];
  pinnedVersionIds: string[];
}

function toStored(e: EventRow): CaseStoredEvent {
  return { id: e.id, seq: e.seq, type: e.type as CaseStoredEvent['type'], payload: fromJson<Record<string, unknown>>(e.payload_json, {}) ?? {}, at: e.created_at };
}

function load(ctx: AppContext, attemptId: string): Loaded {
  const attempt = getAttemptRow(ctx, attemptId);
  const caseRow = getCaseRow(ctx, attempt.case_id, { includeDeleted: true });
  const version = attempt.case_version_id ? getVersionById(ctx, attempt.case_version_id) : getVersionRow(ctx, attempt.case_id, caseRow.current_version_no);
  return {
    attempt,
    def: definitionOf(version),
    versionNo: version.version_no,
    caseRow,
    events: eventsOf(ctx, attempt.id).map(toStored),
    pinnedVersionIds: scopeOf(version)?.resolved.versionIds ?? [],
  };
}

function engineError(e: unknown): never {
  if (e instanceof EngineError) {
    const status = e.code === 'UNKNOWN_REF' ? 400 : 409;
    throw new AppError(status === 400 ? 'BAD_REQUEST' : 'CONFLICT', e.message_ar, status, { reason: e.code });
  }
  throw e;
}

// ───────── start ─────────
export function startAttempt(ctx: AppContext, caseId: string, body: unknown): CaseRunView {
  const req = parseWith(caseStartRequestSchema, body ?? {}, 'body');
  const caseRow = getCaseRow(ctx, caseId);
  if (req.attempt_id) {
    const existing = ctx.db.get<AttemptRow>('SELECT * FROM case_attempt WHERE id = ?', [req.attempt_id]);
    if (existing) {
      if (existing.case_id !== caseRow.id) throw new AppError('CONFLICT', 'معرّف المحاولة مستخدم لحالة أخرى.', 409);
      return runView(ctx, existing.id);
    }
  }
  if (req.mode === 'voice') throw new AppError('FEATURE_DISABLED', VOICE_UNAVAILABLE_AR, 409, { mode: 'voice' });
  if (caseRow.current_version_no < 1) throw new AppError('CONFLICT', 'لم يكتمل توليد هذه الحالة بعد.', 409);
  const version = getVersionRow(ctx, caseRow.id, caseRow.current_version_no);
  const issues = validationOf(version);
  if (!isPlayable(issues)) {
    throw new AppError('CONFLICT', `لا يمكن بدء الحالة قبل إصلاح تعريفها: ${issues.filter((i) => i.severity === 'error').map((i) => i.message_ar).slice(0, 3).join(' ')}`, 409, {
      issues: issues.filter((i) => i.severity === 'error'),
    });
  }
  const def = definitionOf(version);
  const judge = def.kind === 'viva' ? req.judge : 'deterministic';
  if (judge === 'ai') requireJudge(ctx);
  const now = ctx.clock.now();
  const id = req.attempt_id ?? newId(now);
  const state = replay(def, []);
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO case_attempt (id, case_id, state_json, events_json, assessment_json, status, started_at, finished_at, updated_at, case_version_id, feedback, judge, mode, last_seq)
       VALUES (?, ?, ?, '[]', NULL, 'in_progress', ?, NULL, ?, ?, ?, ?, 'text', 0)`,
      [id, caseRow.id, toJson(state), now, now, version.id, req.feedback, judge],
    );
  });
  return runView(ctx, id);
}

// ───────── events ─────────
export async function postEvent(ctx: AppContext, attemptId: string, body: unknown): Promise<CaseEventResponse> {
  const input = parseWith(caseEventInputSchema, body, 'body');
  const dup = ctx.db.get<{ attempt_id: string }>('SELECT attempt_id FROM case_event WHERE id = ?', [input.event_id]);
  if (dup) {
    if (dup.attempt_id !== attemptId) throw new AppError('CONFLICT', 'معرّف الحدث مستخدم في محاولة أخرى.', 409);
    return { result: 'duplicate', run: runView(ctx, attemptId) };
  }
  const L = load(ctx, attemptId);
  const { type, event_id, ...rest } = input as Record<string, unknown> & { type: CaseStoredEvent['type']; event_id: string };
  const payload: Record<string, unknown> = { ...rest };

  // AI judge (viva, owner-chosen): the verdict is computed BEFORE the event is stored and saved inside it
  if (L.attempt.judge === 'ai' && L.def.kind === 'viva' && (type === 'viva_answer' || type === 'revise')) {
    const state = safeReplay(L);
    let questionId: string | null = null;
    let texts: string[] = [];
    const pending = state.viva?.pending ?? null;
    if (state.finished) {
      // the engine refuses this event below; no model call (and no cost) for it
    } else if (type === 'viva_answer') {
      // only the question actually pending is judged (a stale or wrong question is refused below without a call)
      if (pending && pending.question_id === payload.question_id && pending.follow_up_id === ((payload.follow_up_id as string | null | undefined) ?? null)) {
        questionId = String(payload.question_id);
        texts = [String(payload.text)];
      }
    } else {
      const target = state.viva?.answers.find((a) => a.event_id === payload.target_event_id);
      if (target) {
        questionId = target.question_id;
        texts = [String(payload.text)];
      }
    }
    const q = questionId ? L.def.viva?.questions.find((x) => x.id === questionId) : null;
    if (q) {
      const v = await aiJudge(ctx, q, texts);
      payload.judged = { covered: v.covered, model: v.model };
    }
  }

  const duplicate = ctx.db.tx(() => {
    // re-check inside the transaction: the same event id may have been stored while the AI judge was running
    const again = ctx.db.get<{ attempt_id: string }>('SELECT attempt_id FROM case_event WHERE id = ?', [event_id]);
    if (again) {
      if (again.attempt_id !== attemptId) throw new AppError('CONFLICT', 'معرّف الحدث مستخدم في محاولة أخرى.', 409);
      return true;
    }
    // re-read inside the transaction: the log is the truth
    const attempt = getAttemptRow(ctx, attemptId);
    const events = eventsOf(ctx, attemptId).map(toStored);
    let state: EngineState;
    let next: EngineState;
    const seq = attempt.last_seq + 1;
    const now = ctx.clock.now();
    try {
      state = replay(L.def, events);
      next = apply(L.def, state, { id: event_id, seq, type, payload, at: now }, { appending: true });
    } catch (e) {
      engineError(e);
    }
    ctx.db.run('INSERT INTO case_event (id, attempt_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', [event_id, attemptId, seq, type, toJson(payload), now]);
    const finishedNow = next.finished && !state.finished;
    const assessment = next.finished ? toJson(scoreSummary(L.def, next)) : null;
    ctx.db.run(
      `UPDATE case_attempt SET state_json = ?, last_seq = ?, status = ?, finished_at = COALESCE(finished_at, ?), assessment_json = COALESCE(?, assessment_json), updated_at = ? WHERE id = ?`,
      [toJson(next), seq, next.finished ? 'completed' : 'in_progress', finishedNow ? now : null, assessment, now, attemptId],
    );
    return false;
  });
  return { result: duplicate ? 'duplicate' : 'applied', run: runView(ctx, attemptId) };
}

function safeReplay(L: Loaded): EngineState {
  try {
    return replay(L.def, L.events);
  } catch (e) {
    engineError(e);
  }
}

function scoreSummary(def: CaseDefinition, state: EngineState): { score: { got: number; max: number } | null } {
  const items = judgeChecklist(def, state);
  if (items.length) return { score: { got: items.filter((i) => i.met).reduce((a, i) => a + i.item.points, 0), max: items.reduce((a, i) => a + i.item.points, 0) } };
  const viva = judgeViva(def, state);
  if (viva.length) return { score: { got: viva.reduce((a, q) => a + q.covered.length, 0), max: viva.reduce((a, q) => a + q.question.points.length, 0) } };
  return { score: null };
}

// ───────── run view ─────────
function revealedByAr(def: CaseDefinition, by: string): string {
  if (by === 'start') return 'معروضة منذ البداية';
  const [kind, id] = by.split(':');
  if (kind === 'stage') return `عند الوصول إلى «${def.stages.find((s) => s.id === id)?.title ?? id}»`;
  if (kind === 'decision') return `نتيجة اختيارك «${def.stages.flatMap((s) => s.decisions).find((d) => d.id === id)?.label ?? id}»`;
  if (kind === 'patient') return 'جواب المريض على سؤالك';
  return '';
}

function caseHeader(L: Loaded): CaseRunView['case'] {
  const d = L.def;
  return {
    id: L.caseRow.id,
    title: d.title,
    kind: d.kind,
    kind_label_ar: CASE_KIND_LABELS_AR[d.kind],
    origin: L.caseRow.origin,
    origin_label_ar: CASE_ORIGIN_LABELS_AR[L.caseRow.origin],
    summary: d.summary,
    objectives: d.objectives,
    authored_note_ar: AUTHORED_DATA_NOTE_AR,
    osce: d.osce
      ? { station_type: d.osce.station_type, station_label_ar: OSCE_STATION_TYPE_LABELS_AR[d.osce.station_type], candidate_instructions: d.osce.candidate_instructions, roles: d.osce.roles, minutes: d.osce.minutes }
      : null,
  };
}

function attemptHeader(L: Loaded): CaseRunView['attempt'] {
  const a = L.attempt;
  return { id: a.id, case_id: a.case_id, case_version_no: L.versionNo, status: a.status, feedback: a.feedback, judge: a.judge, mode: 'text', started_at: a.started_at, finished_at: a.finished_at, last_seq: a.last_seq };
}

const NO_PATIENT_RESPONSE_AR = 'المريض: لا تتوفر هذه المعلومة في سيناريو المحطة (لا يُخترع جواب غير معرّف).';

export function runView(ctx: AppContext, attemptId: string): CaseRunView {
  const L = load(ctx, attemptId);
  const def = L.def;
  const state = safeReplay(L);
  const showFeedback = L.attempt.feedback === 'immediate' || state.finished;
  const factById = new Map(def.facts.map((f) => [f.id, f]));
  const decisionById = new Map(def.stages.flatMap((s) => s.decisions.map((d) => [d.id, { d, s }] as const)));
  const itemsByText = new Map<string, string[]>();
  if (showFeedback && def.kind === 'osce') {
    for (const u of state.utterances) itemsByText.set(u.event_id, def.checklist.filter((c) => c.match.length && matchAny(u.text, c.match).matched).map((c) => c.text));
  }
  const claimIds: string[] = [];
  const history: CaseHistoryEntry[] = L.events.map((e) => {
    const base: CaseHistoryEntry = {
      event_id: e.id,
      seq: e.seq,
      type: e.type,
      at: e.at,
      stage_title: null,
      label: '',
      original_text: null,
      revised: false,
      feedback: null,
      revealed_fact_ids: state.revealed.filter((r) => r.seq === e.seq && r.seq > 0).map((r) => r.fact_id),
      patient_responses: [],
      no_response_ar: null,
      matched_items: [],
    };
    const p = e.payload;
    switch (e.type) {
      case 'choose': {
        const hit = decisionById.get(String(p.decision_id));
        base.stage_title = hit?.s.title ?? null;
        base.label = hit?.d.label ?? '';
        if (hit) {
          base.feedback = showFeedback
            ? { appropriateness: hit.d.appropriateness, appropriateness_label_ar: DECISION_APPROPRIATENESS_LABELS_AR[hit.d.appropriateness], consequence: hit.d.consequence || null, explanation: hit.d.explanation }
            : { appropriateness: null, appropriateness_label_ar: null, consequence: hit.d.consequence || null, explanation: [] };
          if (showFeedback) hit.d.explanation.forEach((s) => s.claim_id && claimIds.push(s.claim_id));
        }
        break;
      }
      case 'advance':
        base.stage_title = def.stages.find((s) => s.id === p.stage_id)?.title ?? null;
        base.label = 'تابعتَ إلى المرحلة التالية';
        break;
      case 'utterance': {
        const u = state.utterances.find((x) => x.event_id === e.id);
        base.label = u?.text ?? String(p.text ?? '');
        base.original_text = u && u.revisions > 0 ? u.original : null;
        base.revised = !!u && u.revisions > 0;
        base.patient_responses = (u?.responses ?? []).map((r) => ({ fact_id: r.fact_id, text: factById.get(r.fact_id)?.value ?? '' }));
        if (def.osce?.roles.includes('patient') && base.patient_responses.length === 0) base.no_response_ar = NO_PATIENT_RESPONSE_AR;
        base.matched_items = itemsByText.get(e.id) ?? [];
        break;
      }
      case 'viva_answer': {
        const a = state.viva?.answers.find((x) => x.event_id === e.id);
        const q = def.viva?.questions.find((x) => x.id === p.question_id);
        const f = q?.follow_ups.find((x) => x.id === p.follow_up_id);
        base.stage_title = f ? f.prompt : (q?.prompt ?? null);
        base.label = a?.text ?? String(p.text ?? '');
        base.original_text = a && a.revisions > 0 ? a.original : null;
        base.revised = !!a && a.revisions > 0;
        break;
      }
      case 'revise':
        base.label = 'صحّحتَ نصًا سابقًا (الأصل محفوظ في السجل)';
        break;
      case 'override_item':
        base.label = `حكمك على البند: ${p.met ? 'تحقق' : 'لم يتحقق'}${p.note ? ` — ${clip(String(p.note), 120)}` : ''}`;
        break;
      case 'finish':
        base.label = 'أنهيتَ المحاولة';
        break;
    }
    return base;
  });

  let stage: CaseRunView['stage'] = null;
  const cur = def.kind === 'case' && !state.finished ? def.stages.find((s) => s.id === state.stage_id) : undefined;
  if (cur) {
    const chosen = new Set(state.choices.filter((c) => c.stage_id === cur.id).map((c) => c.decision_id));
    stage = {
      id: cur.id,
      type: cur.type,
      type_label_ar: CASE_STAGE_TYPE_LABELS_AR[cur.type],
      title: cur.title,
      prompt: cur.prompt,
      select: cur.select,
      decisions: cur.decisions.map((d) => ({ id: d.id, label: d.label, chosen: chosen.has(d.id) })),
      can_advance: !state.stage_done && cur.select !== 'one',
      is_last: state.stage_done || (cur.next_stage_id === null && (cur.select !== 'one' || cur.decisions.every((d) => d.next_stage_id === null))),
    };
  }

  let viva: CaseRunView['viva'] = null;
  if (def.kind === 'viva' && def.viva && state.viva) {
    const pend = state.viva.pending;
    const qi = pend ? def.viva.questions.findIndex((q) => q.id === pend.question_id) : -1;
    const q = qi >= 0 ? def.viva.questions[qi]! : null;
    const f = q && pend?.follow_up_id ? q.follow_ups.find((x) => x.id === pend.follow_up_id) : null;
    viva = {
      current: q && pend ? { question_id: q.id, follow_up_id: pend.follow_up_id, prompt: f ? f.prompt : q.prompt, index: qi + 1, total: def.viva.questions.length, is_follow_up: !!f } : null,
      answered: new Set(state.viva.answers.map((a) => a.question_id)).size,
      total_questions: def.viva.questions.length,
    };
  }

  return {
    attempt: attemptHeader(L),
    case: caseHeader(L),
    facts: state.revealed
      .map((r) => {
        const f = factById.get(r.fact_id);
        return f ? { id: f.id, label: f.label, value: f.value, kind: f.kind, kind_label_ar: CASE_FACT_KIND_LABELS_AR[f.kind], revealed_by_ar: revealedByAr(def, r.by) } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    stage,
    history,
    viva,
    can_finish: !state.finished,
    finished: state.finished,
    claims: getClaimViews(ctx, claimIds, { pinnedVersionIds: L.pinnedVersionIds }),
    honesty: honestyFor(def),
    voice: { available: false, reason_ar: VOICE_UNAVAILABLE_AR },
  };
}

// ───────── report ─────────
function evidenceOf(list: CaseSentence[]): string[] {
  return list.filter((s) => s.status === 'linked' || s.status === 'needs_review').flatMap((s) => s.evidence_ids);
}

export function reportView(ctx: AppContext, attemptId: string): CaseReportView {
  const L = load(ctx, attemptId);
  const def = L.def;
  const state = safeReplay(L);
  if (!state.finished) throw new AppError('CONFLICT', 'أنهِ المحاولة أولًا لعرض التقرير.', 409);
  const claimIds = new Set<string>();
  const addClaims = (l: CaseSentence[]) => l.forEach((s) => s.claim_id && claimIds.add(s.claim_id));
  const gaps: Array<{ label_ar: string; ids: string[] }> = [];

  const judged = judgeChecklist(def, state);
  const checklist: ChecklistResult[] = judged.map((j) => {
    addClaims(j.item.rationale);
    if (!j.met) gaps.push({ label_ar: `راجع: ${j.item.text}`, ids: evidenceOf(j.item.rationale) });
    return {
      id: j.item.id,
      text: j.item.text,
      category: j.item.category,
      category_label_ar: CHECKLIST_CATEGORY_LABELS_AR[j.item.category],
      points: j.item.points,
      critical: j.item.critical,
      auto_met: j.auto_met,
      auto_reason_ar: j.auto_reason_ar,
      override: j.override ? { met: j.override.met, note: j.override.note, at: j.override.at } : null,
      met: j.met,
      rationale: j.item.rationale,
      evidence_note_ar: j.item.rationale.some(sentenceIsBacked) ? null : 'بند بلا دليل من مصادرك؛ عامله كتعريف مؤلف لا كحقيقة موثقة.',
    };
  });
  const score = checklist.length
    ? { got: checklist.filter((c) => c.met).reduce((a, c) => a + c.points, 0), max: checklist.reduce((a, c) => a + c.points, 0), label_ar: 'تقدير من بنود قائمة هذه الحالة فقط — ليس حكمًا على كفاءتك السريرية' }
    : null;

  const decisionById = new Map(def.stages.flatMap((s) => s.decisions.map((d) => [d.id, { d, s }] as const)));
  const decisions: CaseReportView['decisions'] = state.choices.map((c) => {
    const { d, s } = decisionById.get(c.decision_id)!;
    addClaims(d.explanation);
    return {
      stage_title: s.title,
      stage_type_label_ar: CASE_STAGE_TYPE_LABELS_AR[s.type],
      label: d.label,
      appropriateness: d.appropriateness,
      appropriateness_label_ar: DECISION_APPROPRIATENESS_LABELS_AR[d.appropriateness],
      consequence: d.consequence,
      explanation: d.explanation,
    };
  });
  const missed: CaseReportView['missed_appropriate'] = [];
  for (const sid of [...new Set(state.visited)]) {
    const s = def.stages.find((x) => x.id === sid);
    if (!s || s.select === 'none') continue;
    const chosen = state.choices.filter((c) => c.stage_id === s.id).map((c) => decisionById.get(c.decision_id)!.d);
    if (s.select === 'one' && chosen.some((d) => d.appropriateness === 'appropriate')) continue;
    if (s.select === 'one' && chosen.length === 0) continue; // never decided (finished early) — said in notes
    for (const d of s.decisions) {
      if (d.appropriateness !== 'appropriate' || chosen.includes(d)) continue;
      addClaims(d.explanation);
      missed.push({ stage_title: s.title, label: d.label, explanation: d.explanation });
      gaps.push({ label_ar: `راجع: ${d.label}`, ids: evidenceOf(d.explanation) });
    }
  }

  let viva: CaseReportView['viva'] = null;
  if (def.kind === 'viva') {
    const vj = judgeViva(def, state);
    viva = {
      questions: vj.map((q) => {
        const pointById = new Map(q.question.points.map((p) => [p.id, p]));
        q.question.points.forEach((p) => addClaims(p.rationale));
        const mis = q.misconceptions.map((m) => {
          const def_ = q.question.misconceptions.find((x) => x.id === m.id)!;
          addClaims(def_.correction);
          gaps.push({ label_ar: `صحّح مفهومًا: ${clip(def_.correction[0]?.text ?? m.phrase, 100)}`, ids: evidenceOf(def_.correction) });
          return { id: m.id, correction: def_.correction, matched_phrase: m.phrase };
        });
        for (const id of q.missed) {
          const p = pointById.get(id)!;
          gaps.push({ label_ar: `راجع: ${p.text}`, ids: evidenceOf(p.rationale) });
        }
        return {
          id: q.question.id,
          prompt: q.question.prompt,
          answers: q.answers.map((a) => ({
            text: a.text,
            original_text: a.revisions > 0 ? a.original : null,
            follow_up_prompt: a.follow_up_id ? (q.question.follow_ups.find((f) => f.id === a.follow_up_id)?.prompt ?? null) : null,
          })),
          covered: q.covered.map((c) => ({ id: c.id, text: pointById.get(c.id)!.text, by: c.by })),
          missed: q.missed.map((id) => ({ id, text: pointById.get(id)!.text, rationale: pointById.get(id)!.rationale })),
          misconceptions: mis,
          follow_ups_asked: q.follow_ups_asked.map((fid) => q.question.follow_ups.find((f) => f.id === fid)?.prompt ?? fid),
        };
      }),
      covered_points: vj.reduce((a, q) => a + q.covered.length, 0),
      total_points: vj.reduce((a, q) => a + q.question.points.length, 0),
    };
  }

  const isExamStation = def.osce?.station_type === 'examination' || def.checklist.some((c) => c.order !== null);
  const teaching: CaseSentence[] = [];
  for (const s of def.stages) if (state.visited.includes(s.id) || s.type === 'review') teaching.push(...s.teaching_points);
  addClaims(teaching);

  // review plan: evidence of the gaps, resolved to views (pages to re-read)
  const allIds = [...new Set(gaps.flatMap((g) => g.ids))];
  const views = new Map(getViews(ctx, allIds, { pinnedVersionIds: L.pinnedVersionIds }).map((v) => [v.id, v] as const));
  const review_plan = gaps
    .map((g) => ({ label_ar: g.label_ar, evidence: [...new Set(g.ids)].map((id) => views.get(id)).filter((v): v is EvidenceView => !!v) }))
    .filter((g, i, arr) => arr.findIndex((x) => x.label_ar === g.label_ar) === i);

  const notes: string[] = [];
  if (def.kind === 'case') {
    const unvisited = def.stages.filter((s) => !state.visited.includes(s.id) && s.type !== 'review');
    if (unvisited.length) notes.push(`لم تصل إلى: ${unvisited.map((s) => `«${s.title}»`).join('، ')} — إما لأنك أنهيت مبكرًا أو لأن مسار قراراتك لم يمر بها.`);
  }
  if (viva) {
    const unanswered = viva.questions.filter((q) => q.answers.length === 0);
    if (unanswered.length) notes.push(`لم تُجب عن ${unanswered.length} من الأسئلة؛ نقاطها محسوبة كفجوات.`);
  }
  const revisions = [...state.utterances, ...(state.viva?.answers ?? [])].filter((t) => t.revisions > 0).length;
  if (revisions) notes.push(`صحّحتَ ${revisions} من نصوصك؛ يُستخدم النص المصحح في التقييم، والنص الأصلي محفوظ في سجل المحاولة.`);
  const overrides = Object.keys(state.overrides).length;
  if (overrides) notes.push(`عدّلتَ الحكم على ${overrides} من البنود؛ يظهر حكمك وسببه بجانب الحكم الآلي.`);
  if (L.attempt.judge === 'ai') {
    const models = [...new Set((state.viva?.answers ?? []).map((a) => a.judged?.model).filter(Boolean))];
    notes.push(`حُكم على تغطية النقاط بنموذج ذكاء اصطناعي${models.length ? ` (${models.join('، ')})` : ''} ضمن النقاط المعرّفة فقط؛ اختيار أسئلة المتابعة بقواعد التعريف.`);
  }

  return {
    attempt: attemptHeader(L),
    case: caseHeader(L),
    checklist,
    score,
    decisions,
    missed_appropriate: missed,
    order_check: isExamStation ? orderCheck(judged) : null,
    viva,
    review_plan,
    teaching_points: teaching,
    honesty: honestyFor(def),
    notes_ar: notes,
    claims: getClaimViews(ctx, [...claimIds], { pinnedVersionIds: L.pinnedVersionIds }),
  };
}

export function listAttempts(ctx: AppContext, caseId: string | null, limit: number): CaseAttemptListResponse {
  const rows = ctx.db.all<AttemptRow & { title: string; kind: CaseDefinition['kind'] }>(
    `SELECT a.*, c.title, c.kind FROM case_attempt a JOIN clinical_case c ON c.id = a.case_id ${caseId ? 'WHERE a.case_id = ?' : ''} ORDER BY a.started_at DESC, a.id DESC LIMIT ?`,
    caseId ? [caseId, limit] : [limit],
  );
  return {
    attempts: rows.map((r) => ({
      id: r.id,
      case_id: r.case_id,
      case_title: r.title,
      kind: r.kind,
      status: r.status,
      started_at: r.started_at,
      finished_at: r.finished_at,
      score: fromJson<{ score: { got: number; max: number } | null }>(r.assessment_json, { score: null })?.score ?? null,
    })),
  };
}
