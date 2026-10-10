// The case engine (§42): a PURE, deterministic state machine.
//
//   replay(definition, events) → state         same definition + same events → the same state (tested)
//   apply(definition, state, event) → state     refuses anything the definition does not allow
//   assess(definition, state) → assessment      checklist / viva coverage / order check / decisions review
//
// Patient facts are only ever READ from the (versioned, pinned) definition: the state holds fact ids, so a value can
// never change between steps or replays. Transitions follow the definition only (decision.next_stage_id ??
// stage.next_stage_id); an inappropriate decision continues the scenario with its authored consequence — the
// engine never invents a consequence, a harm, a finding or a patient answer.
import type { CaseDefinition, CaseStage, CaseStoredEvent, ChecklistItem, VivaQuestion } from '@medlevo/shared';
import { matchAny } from './text';

export class EngineError extends Error {
  constructor(
    readonly code: 'STAGE_MISMATCH' | 'NOT_ALLOWED' | 'UNKNOWN_REF' | 'FINISHED' | 'NOT_FINISHED',
    readonly message_ar: string,
  ) {
    super(message_ar);
    this.name = 'EngineError';
  }
}

export interface RevealRecord {
  fact_id: string;
  /** 'start' | 'stage:<id>' | 'decision:<id>' | 'patient:<response id>' */
  by: string;
  seq: number;
}

export interface ChoiceRecord {
  event_id: string;
  seq: number;
  stage_id: string;
  decision_id: string;
}

export interface TextRecord {
  event_id: string;
  seq: number;
  text: string;
  /** the text as first submitted (kept when revised) */
  original: string;
  revisions: number;
  /** OSCE: simulated patient responses (defined facts only) */
  responses: Array<{ response_id: string; fact_id: string }>;
}

export interface VivaAnswerRecord extends TextRecord {
  question_id: string;
  follow_up_id: string | null;
  /** AI judge verdict stored in the event (only defined point ids) — replay never calls a model */
  judged: null | { covered: string[]; model: string | null };
}

export interface EngineState {
  stage_id: string | null;
  /** the current stage's work is done (a final 'one' decision without a next stage) */
  stage_done: boolean;
  visited: string[];
  revealed: RevealRecord[];
  choices: ChoiceRecord[];
  utterances: TextRecord[];
  viva: null | {
    pending: { question_id: string; follow_up_id: string | null } | null;
    asked: Record<string, string[]>;
    answers: VivaAnswerRecord[];
  };
  overrides: Record<string, { met: boolean; note: string; at: number; event_id: string }>;
  finished: boolean;
  finished_at: number | null;
  last_seq: number;
}

const stageById = (def: CaseDefinition, id: string | null): CaseStage | null => (id ? (def.stages.find((s) => s.id === id) ?? null) : null);

function reveal(state: EngineState, ids: string[], by: string, seq: number): void {
  for (const id of ids) if (!state.revealed.some((r) => r.fact_id === id)) state.revealed.push({ fact_id: id, by, seq });
}

function enterStage(def: CaseDefinition, state: EngineState, id: string | null, seq: number): void {
  const s = stageById(def, id);
  state.stage_id = s ? s.id : state.stage_id;
  state.stage_done = !s;
  if (!s) return;
  state.visited.push(s.id);
  reveal(state, s.reveal_fact_ids, `stage:${s.id}`, seq);
  if (s.type === 'review' && s.select === 'none' && !s.next_stage_id) state.stage_done = true;
}

export function initialState(def: CaseDefinition): EngineState {
  const state: EngineState = {
    stage_id: null,
    stage_done: false,
    visited: [],
    revealed: [],
    choices: [],
    utterances: [],
    viva: null,
    overrides: {},
    finished: false,
    finished_at: null,
    last_seq: 0,
  };
  reveal(
    state,
    def.facts.filter((f) => f.reveal === 'start').map((f) => f.id),
    'start',
    0,
  );
  if (def.kind === 'case' && def.start_stage_id) enterStage(def, state, def.start_stage_id, 0);
  if (def.kind === 'viva' && def.viva?.questions.length) {
    state.viva = { pending: { question_id: def.viva.questions[0]!.id, follow_up_id: null }, asked: {}, answers: [] };
  }
  return state;
}

function clone(s: EngineState): EngineState {
  return structuredClone(s);
}

// ───────── viva helpers ─────────
function textsOf(state: EngineState, questionId: string): VivaAnswerRecord[] {
  return state.viva?.answers.filter((a) => a.question_id === questionId) ?? [];
}

/** Point ids covered for a question, from each answer's stored AI verdict or deterministic match. */
export function vivaCoverage(q: VivaQuestion, answers: VivaAnswerRecord[]): Map<string, 'match' | 'ai'> {
  const out = new Map<string, 'match' | 'ai'>();
  const defined = new Set(q.points.map((p) => p.id));
  for (const a of answers) {
    if (a.judged) {
      for (const id of a.judged.covered) if (defined.has(id) && !out.has(id)) out.set(id, 'ai');
      continue;
    }
    for (const p of q.points) if (!out.has(p.id) && matchAny(a.text, p.match).matched) out.set(p.id, 'match');
  }
  return out;
}

function nextVivaPrompt(def: CaseDefinition, state: EngineState, questionId: string): { question_id: string; follow_up_id: string | null } | null {
  const viva = def.viva!;
  const q = viva.questions.find((x) => x.id === questionId)!;
  const asked = state.viva!.asked[q.id] ?? [];
  if (asked.length < viva.max_follow_ups) {
    const covered = vivaCoverage(q, textsOf(state, q.id));
    for (const f of q.follow_ups) {
      if (asked.includes(f.id)) continue;
      const w = f.when;
      const ok = w.type === 'always' || (w.type === 'missing' && !covered.has(w.point_id)) || (w.type === 'covered' && covered.has(w.point_id));
      if (ok) return { question_id: q.id, follow_up_id: f.id };
    }
  }
  const i = viva.questions.findIndex((x) => x.id === q.id);
  const next = viva.questions[i + 1];
  return next ? { question_id: next.id, follow_up_id: null } : null;
}

/** The simulated patient answers a question about a defined fact however it is phrased («no nausea?» asks about nausea). */
function patientResponses(def: CaseDefinition, text: string): Array<{ response_id: string; fact_id: string }> {
  if (!def.osce || !def.osce.roles.includes('patient')) return [];
  const out: Array<{ response_id: string; fact_id: string }> = [];
  for (const r of def.osce.patient_responses) if (matchAny(text, r.match, 'off').matched) out.push({ response_id: r.id, fact_id: r.fact_id });
  return out;
}

// ───────── apply ─────────
/**
 * `appending`: the event is being added to the log now (stricter rules for new events; a stored log always replays).
 */
export function apply(def: CaseDefinition, prev: EngineState, ev: Pick<CaseStoredEvent, 'id' | 'seq' | 'type' | 'payload' | 'at'>, opts: { appending?: boolean } = {}): EngineState {
  const state = clone(prev);
  const p = ev.payload as Record<string, unknown>;
  // after finishing, only the owner's own verdict on an item may be added (kept beside the automatic one); a text
  // revised after the report was seen would silently turn into an «automatic» match
  if (state.finished && ev.type !== 'override_item' && (ev.type !== 'revise' || opts.appending)) {
    throw new EngineError(
      'FINISHED',
      ev.type === 'revise'
        ? 'انتهت هذه المحاولة؛ لا تُصحَّح النصوص بعد رؤية التقييم. صحّح الحكم على البند نفسه من التقرير (يظهر حكمك بجانب الحكم الآلي).'
        : 'انتهت هذه المحاولة؛ ابدأ محاولة جديدة لتغيير القرارات.',
    );
  }
  state.last_seq = ev.seq;

  switch (ev.type) {
    case 'choose': {
      if (def.kind !== 'case') throw new EngineError('NOT_ALLOWED', 'هذه المحاولة لا تُجاب بالاختيارات.');
      const stage = stageById(def, state.stage_id);
      if (!stage || p.stage_id !== stage.id) throw new EngineError('STAGE_MISMATCH', 'المرحلة الحالية تغيّرت؛ حدّث الصفحة.');
      if (state.stage_done) throw new EngineError('NOT_ALLOWED', 'اكتمل قرار هذه المرحلة.');
      if (stage.select === 'none') throw new EngineError('NOT_ALLOWED', 'هذه المرحلة للقراءة فقط؛ تابع إلى المرحلة التالية.');
      const d = stage.decisions.find((x) => x.id === p.decision_id);
      if (!d) throw new EngineError('UNKNOWN_REF', 'هذا الخيار غير موجود في تعريف المرحلة.');
      if (state.choices.some((c) => c.stage_id === stage.id && c.decision_id === d.id)) throw new EngineError('NOT_ALLOWED', 'اخترت هذا الخيار من قبل.');
      state.choices.push({ event_id: ev.id, seq: ev.seq, stage_id: stage.id, decision_id: d.id });
      reveal(state, d.reveal_fact_ids, `decision:${d.id}`, ev.seq);
      if (stage.select === 'one') {
        const next = d.next_stage_id ?? stage.next_stage_id;
        if (next) enterStage(def, state, next, ev.seq);
        else state.stage_done = true;
      }
      return state;
    }
    case 'advance': {
      if (def.kind !== 'case') throw new EngineError('NOT_ALLOWED', 'هذه المحاولة لا تحتوي مراحل.');
      const stage = stageById(def, state.stage_id);
      if (!stage || p.stage_id !== stage.id) throw new EngineError('STAGE_MISMATCH', 'المرحلة الحالية تغيّرت؛ حدّث الصفحة.');
      if (stage.select === 'one' && !state.stage_done) throw new EngineError('NOT_ALLOWED', 'اختر قرارًا في هذه المرحلة أولًا.');
      if (state.stage_done || !stage.next_stage_id) {
        state.stage_done = true;
        return state;
      }
      enterStage(def, state, stage.next_stage_id, ev.seq);
      return state;
    }
    case 'utterance': {
      if (def.kind !== 'osce') throw new EngineError('NOT_ALLOWED', 'الكتابة الحرة متاحة في محطات OSCE فقط.');
      const text = String(p.text ?? '');
      const responses = patientResponses(def, text);
      state.utterances.push({ event_id: ev.id, seq: ev.seq, text, original: text, revisions: 0, responses });
      for (const r of responses) reveal(state, [r.fact_id], `patient:${r.response_id}`, ev.seq);
      return state;
    }
    case 'viva_answer': {
      if (def.kind !== 'viva' || !state.viva || !def.viva) throw new EngineError('NOT_ALLOWED', 'هذه المحاولة ليست امتحانًا شفهيًا.');
      const pending = state.viva.pending;
      const followUp = (p.follow_up_id as string | null | undefined) ?? null;
      if (!pending || pending.question_id !== p.question_id || pending.follow_up_id !== followUp) {
        throw new EngineError('STAGE_MISMATCH', 'السؤال الحالي تغيّر؛ حدّث الصفحة.');
      }
      const text = String(p.text ?? '');
      const judgedRaw = p.judged as { covered?: unknown; model?: unknown } | undefined;
      const q = def.viva.questions.find((x) => x.id === pending.question_id)!;
      const defined = new Set(q.points.map((x) => x.id));
      const judged = judgedRaw && Array.isArray(judgedRaw.covered)
        ? { covered: (judgedRaw.covered as unknown[]).filter((x): x is string => typeof x === 'string' && defined.has(x)), model: typeof judgedRaw.model === 'string' ? judgedRaw.model : null }
        : null;
      state.viva.answers.push({ event_id: ev.id, seq: ev.seq, text, original: text, revisions: 0, responses: [], question_id: pending.question_id, follow_up_id: followUp, judged });
      if (followUp) state.viva.asked[pending.question_id] = [...(state.viva.asked[pending.question_id] ?? []), followUp];
      state.viva.pending = nextVivaPrompt(def, state, pending.question_id);
      return state;
    }
    case 'revise': {
      const target = String(p.target_event_id ?? '');
      const text = String(p.text ?? '');
      const u = state.utterances.find((x) => x.event_id === target);
      const a = state.viva?.answers.find((x) => x.event_id === target);
      const rec = u ?? a;
      if (!rec) throw new EngineError('UNKNOWN_REF', 'لا يوجد نص مكتوب بهذا المعرّف لتصحيحه.');
      rec.text = text;
      rec.revisions += 1;
      if (a) {
        const judgedRaw = p.judged as { covered?: unknown; model?: unknown } | undefined;
        if (judgedRaw && Array.isArray(judgedRaw.covered)) {
          const q = def.viva?.questions.find((x) => x.id === a.question_id);
          const defined = new Set(q?.points.map((x) => x.id) ?? []);
          a.judged = { covered: (judgedRaw.covered as unknown[]).filter((x): x is string => typeof x === 'string' && defined.has(x)), model: typeof judgedRaw.model === 'string' ? judgedRaw.model : null };
        } else if (a.judged) {
          a.judged = null; // a revision without a fresh verdict falls back to the deterministic match (said in the report)
        }
      }
      if (u) {
        // the revised text may ask about more; facts already shown stay shown (they cannot be un-seen)
        const responses = patientResponses(def, text);
        for (const r of responses) {
          if (!u.responses.some((x) => x.response_id === r.response_id)) u.responses.push(r);
          reveal(state, [r.fact_id], `patient:${r.response_id}`, ev.seq);
        }
      }
      return state;
    }
    case 'override_item': {
      if (!state.finished) throw new EngineError('NOT_FINISHED', 'تصحيح الحكم على البنود متاح بعد إنهاء المحاولة.');
      const id = String(p.item_id ?? '');
      const known = def.checklist.some((c) => c.id === id) || (def.viva?.questions.some((q) => q.points.some((x) => `${q.id}:${x.id}` === id)) ?? false);
      if (!known) throw new EngineError('UNKNOWN_REF', 'هذا البند غير موجود في قائمة التقييم.');
      state.overrides[id] = { met: p.met === true, note: String(p.note ?? ''), at: ev.at, event_id: ev.id };
      return state;
    }
    case 'finish': {
      state.finished = true;
      state.finished_at = ev.at;
      if (state.viva) state.viva.pending = null;
      return state;
    }
    default:
      throw new EngineError('NOT_ALLOWED', 'نوع حدث غير معروف.');
  }
}

/** Fold the whole log (events sorted by seq). Deterministic: no clock, no randomness, no model calls. */
export function replay(def: CaseDefinition, events: Array<Pick<CaseStoredEvent, 'id' | 'seq' | 'type' | 'payload' | 'at'>>): EngineState {
  let state = initialState(def);
  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) state = apply(def, state, ev);
  return state;
}

// ───────── assessment ─────────
export interface ItemJudgement {
  item: ChecklistItem;
  auto_met: boolean;
  auto_reason_ar: string;
  override: EngineState['overrides'][string] | null;
  met: boolean;
  /** token position of the first match (OSCE ordering) */
  first_at: { seq: number; at: number } | null;
}

export function judgeChecklist(def: CaseDefinition, state: EngineState): ItemJudgement[] {
  const chosen = new Set(state.choices.map((c) => c.decision_id));
  const decisionLabel = new Map(def.stages.flatMap((s) => s.decisions.map((d) => [d.id, d.label] as const)));
  const texts = [...state.utterances, ...(state.viva?.answers ?? [])].sort((a, b) => a.seq - b.seq);
  return def.checklist.map((item) => {
    let auto_met = false;
    let reason = '';
    let first_at: ItemJudgement['first_at'] = null;
    const by = item.satisfied_by.find((d) => chosen.has(d));
    if (by) {
      auto_met = true;
      reason = `تحقق باختيارك: «${decisionLabel.get(by) ?? by}».`;
    } else if (item.match.length) {
      let negated = false;
      for (const t of texts) {
        const m = matchAny(t.text, item.match);
        if (m.matched) {
          auto_met = true;
          reason = `ذكرتَ ما يطابق «${m.phrase}».`;
          first_at = { seq: t.seq, at: m.at ?? 0 };
          break;
        }
        if (m.negated_only) negated = true;
      }
      if (!auto_met) reason = negated ? 'ورد ما يطابق البند لكن بصيغة منفية، فلم يُحتسب.' : 'لم يرد في نصك ما يطابق هذا البند.';
    }
    if (!auto_met && !reason) {
      const labels = item.satisfied_by.map((d) => decisionLabel.get(d) ?? d);
      reason = labels.length ? `لم تختر: ${labels.map((l) => `«${l}»`).join('، ')}.` : 'لم يتحقق.';
    }
    const override = state.overrides[item.id] ?? null;
    return { item, auto_met, auto_reason_ar: reason, override, met: override ? override.met : auto_met, first_at };
  });
}

export interface VivaJudgement {
  question: VivaQuestion;
  answers: VivaAnswerRecord[];
  covered: Array<{ id: string; by: 'match' | 'ai' | 'owner' }>;
  missed: string[];
  misconceptions: Array<{ id: string; phrase: string }>;
  follow_ups_asked: string[];
  asked: boolean;
}

export function judgeViva(def: CaseDefinition, state: EngineState): VivaJudgement[] {
  if (!def.viva || !state.viva) return [];
  return def.viva.questions.map((q) => {
    const answers = textsOf(state, q.id);
    const auto = vivaCoverage(q, answers);
    const covered: VivaJudgement['covered'] = [];
    const missed: string[] = [];
    for (const p of q.points) {
      const o = state.overrides[`${q.id}:${p.id}`];
      if (o) {
        if (o.met) covered.push({ id: p.id, by: 'owner' });
        else missed.push(p.id);
      } else if (auto.has(p.id)) covered.push({ id: p.id, by: auto.get(p.id)! });
      else missed.push(p.id);
    }
    const misconceptions: VivaJudgement['misconceptions'] = [];
    for (const m of q.misconceptions) {
      for (const a of answers) {
        const r = matchAny(a.text, m.match);
        if (r.matched) {
          misconceptions.push({ id: m.id, phrase: r.phrase! });
          break;
        }
      }
    }
    return { question: q, answers, covered, missed, misconceptions, follow_ups_asked: state.viva!.asked[q.id] ?? [], asked: answers.length > 0 };
  });
}

/** OSCE examination order: matched ordered items must appear in non-decreasing expected order. */
export function orderCheck(judged: ItemJudgement[]): { assessed: boolean; in_order: boolean | null; note_ar: string } {
  const ordered = judged.filter((j) => j.item.order !== null && j.auto_met && j.first_at).sort((a, b) => a.first_at!.seq - b.first_at!.seq || a.first_at!.at - b.first_at!.at);
  if (ordered.length < 2) return { assessed: false, in_order: null, note_ar: 'لم يُقيَّم الترتيب: يلزم ذكر خطوتين مرتّبتين على الأقل.' };
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.item.order! < ordered[i - 1]!.item.order!) {
      return {
        assessed: true,
        in_order: false,
        note_ar: `ذكرتَ «${ordered[i]!.item.text}» قبل «${ordered[i - 1]!.item.text}»، والترتيب المحدد في المحطة عكس ذلك (حسب موضع ذكرها في نصك).`,
      };
    }
  }
  return { assessed: true, in_order: true, note_ar: 'وردت الخطوات المذكورة بالترتيب المحدد في المحطة (حسب موضع ذكرها في نصك).' };
}
