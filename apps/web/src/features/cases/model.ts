// Pure helpers for the cases feature: authoring drafts (the shared input schema IS the editing model), conversion of a
// stored definition back into an editable draft (sentences keep their evidence ids), local ids, phrases, labels.
import {
  type CaseDefinition,
  type CaseDefinitionInput,
  type CaseKind,
  type CaseSentence,
  type CaseSentenceInput,
  type ChecklistItemInput,
  type CaseStageInput,
  type CaseDecisionInput,
  type CaseFactInput,
  type VivaQuestionInput,
  type OsceInput,
} from '@medlevo/shared';

// Concrete (all-fields) draft types used by the editor — the input schema with defaults applied.
export type SentenceDraft = { text: string; evidence_ids: string[]; medical: boolean };
export type FactDraft = Required<CaseFactInput>;
export type DecisionDraft = Omit<Required<CaseDecisionInput>, 'explanation'> & { explanation: SentenceDraft[] };
export type StageDraft = Omit<Required<CaseStageInput>, 'decisions' | 'teaching_points'> & { decisions: DecisionDraft[]; teaching_points: SentenceDraft[] };
export type ChecklistDraft = Omit<Required<ChecklistItemInput>, 'rationale'> & { rationale: SentenceDraft[] };
export type OsceDraft = Required<OsceInput>;
export type VivaPointDraft = { id: string; text: string; match: string[]; rationale: SentenceDraft[] };
export type VivaFollowUpDraft = { id: string; prompt: string; when: { type: 'missing' | 'covered'; point_id: string } | { type: 'always' } };
export type VivaQuestionDraft = { id: string; prompt: string; points: VivaPointDraft[]; follow_ups: VivaFollowUpDraft[]; misconceptions: Array<{ id: string; match: string[]; correction: SentenceDraft[] }> };
export interface CaseDraft {
  kind: CaseKind;
  title: string;
  summary: string;
  language: 'ar' | 'en';
  objectives: string[];
  facts: FactDraft[];
  stages: StageDraft[];
  start_stage_id: string | null;
  checklist: ChecklistDraft[];
  osce: OsceDraft | null;
  viva: { questions: VivaQuestionDraft[]; max_follow_ups: number } | null;
}

/** A new local id with a prefix that is not used yet (f1, s2, d3, …). */
export function nextId(prefix: string, used: Iterable<string>): string {
  const taken = new Set(used);
  for (let i = 1; ; i++) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

export function allIds(d: CaseDraft): string[] {
  return [
    ...d.facts.map((f) => f.id),
    ...d.stages.map((s) => s.id),
    ...d.stages.flatMap((s) => s.decisions.map((x) => x.id)),
    ...d.checklist.map((c) => c.id),
    ...(d.osce?.patient_responses.map((r) => r.id) ?? []),
    ...(d.viva?.questions.flatMap((q) => [q.id, ...q.points.map((p) => p.id), ...q.follow_ups.map((f) => f.id), ...q.misconceptions.map((m) => m.id)]) ?? []),
  ];
}

export const sentence = (text = ''): SentenceDraft => ({ text, evidence_ids: [], medical: true });

export function newFact(used: string[]): FactDraft {
  return { id: nextId('f', used), label: '', value: '', kind: 'other', reveal: 'on_request' };
}
export function newDecision(used: string[]): DecisionDraft {
  return { id: nextId('d', used), label: '', appropriateness: 'appropriate', reveal_fact_ids: [], consequence: '', explanation: [], next_stage_id: null };
}
export function newStage(used: string[], type: StageDraft['type'] = 'history'): StageDraft {
  return { id: nextId('s', used), type, title: '', prompt: '', reveal_fact_ids: [], select: 'none', decisions: [], next_stage_id: null, teaching_points: [] };
}
export function newChecklistItem(used: string[], category: ChecklistDraft['category'] = 'history'): ChecklistDraft {
  return { id: nextId('c', used), text: '', category, points: 1, satisfied_by: [], match: [], order: null, critical: false, rationale: [] };
}
export function newVivaQuestion(used: string[]): VivaQuestionDraft {
  const qid = nextId('q', used);
  return { id: qid, prompt: '', points: [{ id: nextId('p', used), text: '', match: [], rationale: [] }], follow_ups: [], misconceptions: [] };
}

/** A starter draft per kind (the owner fills in the content). */
export function emptyDraft(kind: CaseKind): CaseDraft {
  const base: CaseDraft = { kind, title: '', summary: '', language: 'ar', objectives: [], facts: [], stages: [], start_stage_id: null, checklist: [], osce: null, viva: null };
  if (kind === 'case') {
    const s1 = { ...newStage([], 'presentation'), title: 'القصة الأولية' };
    const s2 = { ...newStage([s1.id], 'diagnosis'), title: 'التشخيص', select: 'one' as const };
    s1.next_stage_id = s2.id;
    return { ...base, stages: [s1, s2], start_stage_id: s1.id };
  }
  if (kind === 'osce') {
    return { ...base, osce: { station_type: 'history_taking', candidate_instructions: '', roles: ['patient', 'examiner'], minutes: null, patient_responses: [] }, checklist: [newChecklistItem([])] };
  }
  return { ...base, viva: { questions: [newVivaQuestion([])], max_follow_ups: 2 } };
}

const toSentenceDraft = (s: CaseSentence): SentenceDraft => ({ text: s.text, evidence_ids: s.evidence_ids, medical: s.medical });

/** A stored definition → an editable draft (sentences keep their evidence ids; claims are re-validated on save). */
export function draftFromDefinition(def: CaseDefinition): CaseDraft {
  return {
    kind: def.kind,
    title: def.title,
    summary: def.summary,
    language: def.language,
    objectives: [...def.objectives],
    facts: def.facts.map((f) => ({ ...f })),
    stages: def.stages.map((s) => ({
      ...s,
      reveal_fact_ids: [...s.reveal_fact_ids],
      decisions: s.decisions.map((d) => ({ ...d, reveal_fact_ids: [...d.reveal_fact_ids], explanation: d.explanation.map(toSentenceDraft) })),
      teaching_points: s.teaching_points.map(toSentenceDraft),
    })),
    start_stage_id: def.start_stage_id,
    checklist: def.checklist.map((c) => ({ ...c, satisfied_by: [...c.satisfied_by], match: [...c.match], rationale: c.rationale.map(toSentenceDraft) })),
    osce: def.osce ? { ...def.osce, roles: [...def.osce.roles], patient_responses: def.osce.patient_responses.map((r) => ({ ...r, match: [...r.match] })) } : null,
    viva: def.viva
      ? {
          max_follow_ups: def.viva.max_follow_ups,
          questions: def.viva.questions.map((q) => ({
            id: q.id,
            prompt: q.prompt,
            points: q.points.map((p) => ({ id: p.id, text: p.text, match: [...p.match], rationale: p.rationale.map(toSentenceDraft) })),
            follow_ups: q.follow_ups.map((f) => ({ ...f })),
            misconceptions: q.misconceptions.map((m) => ({ id: m.id, match: [...m.match], correction: m.correction.map(toSentenceDraft) })),
          })),
        }
      : null,
  };
}

const cleanSentences = (l: SentenceDraft[]): CaseSentenceInput[] => l.filter((s) => s.text.trim()).map((s) => ({ text: s.text.trim(), evidence_ids: s.evidence_ids, medical: s.medical }));
const cleanPhrases = (l: string[]) => [...new Set(l.map((p) => p.trim()).filter(Boolean))];

/** Draft → request body (empty sentences / phrases dropped; nothing else is changed). */
export function toInput(d: CaseDraft): CaseDefinitionInput {
  return {
    kind: d.kind,
    title: d.title.trim(),
    summary: d.summary.trim(),
    language: d.language,
    objectives: d.objectives.map((o) => o.trim()).filter(Boolean),
    facts: d.facts.map((f) => ({ ...f, label: f.label.trim(), value: f.value.trim() })),
    stages: d.kind === 'case' ? d.stages.map((s) => ({ ...s, decisions: s.decisions.map((x) => ({ ...x, explanation: cleanSentences(x.explanation) })), teaching_points: cleanSentences(s.teaching_points) })) : [],
    start_stage_id: d.kind === 'case' ? d.start_stage_id : null,
    checklist: d.checklist.map((c) => ({ ...c, match: cleanPhrases(c.match), rationale: cleanSentences(c.rationale) })),
    osce: d.kind === 'osce' && d.osce ? { ...d.osce, patient_responses: d.osce.patient_responses.map((r) => ({ ...r, match: cleanPhrases(r.match) })) } : null,
    viva:
      d.kind === 'viva' && d.viva
        ? {
            max_follow_ups: d.viva.max_follow_ups,
            questions: d.viva.questions.map((q) => ({
              id: q.id,
              prompt: q.prompt.trim(),
              points: q.points.map((p) => ({ id: p.id, text: p.text.trim(), match: cleanPhrases(p.match), rationale: cleanSentences(p.rationale) })),
              follow_ups: q.follow_ups,
              misconceptions: q.misconceptions.map((m) => ({ id: m.id, match: cleanPhrases(m.match), correction: cleanSentences(m.correction) })),
            })) as VivaQuestionInput[],
          }
        : null,
  };
}

/** «a, b، c» or one per line → phrases. */
export function splitPhrases(text: string): string[] {
  return text
    .split(/[\n,،؛;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}
export const joinPhrases = (l: string[]) => l.join('، ');

/** Draft problems the owner can fix before sending (the server validates everything again). */
export function draftProblems(d: CaseDraft): string[] {
  const out: string[] = [];
  if (!d.title.trim()) out.push('اكتب عنوانًا للحالة.');
  d.facts.forEach((f, i) => {
    if (!f.label.trim() || !f.value.trim()) out.push(`المعلومة ${i + 1}: اكتب العنوان والقيمة.`);
  });
  if (d.kind === 'case') {
    d.stages.forEach((s, i) => {
      if (!s.title.trim()) out.push(`المرحلة ${i + 1}: اكتب عنوانًا.`);
      s.decisions.forEach((x, j) => {
        if (!x.label.trim()) out.push(`المرحلة ${i + 1}، الخيار ${j + 1}: اكتب نص الخيار.`);
      });
    });
  }
  d.checklist.forEach((c, i) => {
    if (!c.text.trim()) out.push(`بند التقييم ${i + 1}: اكتب نص البند.`);
  });
  if (d.kind === 'osce' && !d.osce?.candidate_instructions.trim()) out.push('اكتب تعليمات المرشح للمحطة.');
  if (d.kind === 'viva') {
    d.viva?.questions.forEach((q, i) => {
      if (!q.prompt.trim()) out.push(`السؤال ${i + 1}: اكتب نص السؤال.`);
      q.points.forEach((p, j) => {
        if (!p.text.trim() || cleanPhrases(p.match).length === 0) out.push(`السؤال ${i + 1}، النقطة ${j + 1}: اكتب النقطة وعبارة واحدة على الأقل تطابقها.`);
      });
    });
  }
  return out;
}

/** «0:42» / «1:02:03» */
export function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function studyUrl(sourceId: string, at: { versionId?: string | null; pageId?: string | null; regionId?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (at.versionId) q.set('v', at.versionId);
  if (at.pageId) q.set('page_id', at.pageId);
  if (at.regionId) q.set('region', at.regionId);
  const s = q.toString();
  return `/study/${encodeURIComponent(sourceId)}${s ? `?${s}` : ''}`;
}

/** Arabic count phrase for points: «نقطة واحدة», «نقطتان», «3 نقاط», «11 نقطة». */
export function pointsAr(n: number): string {
  if (n === 1) return 'نقطة واحدة';
  if (n === 2) return 'نقطتان';
  if (n >= 3 && n <= 10) return `${n} نقاط`;
  return `${n} نقطة`;
}
