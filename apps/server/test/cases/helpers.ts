// Cases test helpers: owner-authored TEST definitions (synthetic teaching scenarios built on the Golden Set
// appendicitis fixture — not medical reference material) and small request helpers.
import type { CaseDefinitionInput, CaseRunView, CaseSaveRequest } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import type { AuthHeaders, TestApp } from '../helpers/app';

export function appendicitisCase(over: Partial<CaseDefinitionInput> = {}): CaseDefinitionInput {
  return {
    kind: 'case',
    title: 'Right iliac fossa pain (TEST CASE)',
    summary: 'A synthetic teaching scenario for automated tests.',
    language: 'ar',
    objectives: ['Recognize the typical migration of pain'],
    facts: [
      { id: 'f_story', label: 'القصة', value: 'Ahmad, 24 years, abdominal pain since yesterday', kind: 'story', reveal: 'start' },
      { id: 'f_migration', label: 'مكان الألم', value: 'Pain began around the umbilicus and moved to the right iliac fossa', kind: 'history', reveal: 'on_request' },
      { id: 'f_temp', label: 'الحرارة', value: '37.8 °C', kind: 'vital', reveal: 'on_request' },
      { id: 'f_rif', label: 'جس الحفرة الحرقفية اليمنى', value: "Tenderness at McBurney's point", kind: 'examination', reveal: 'on_request' },
      { id: 'f_wbc', label: 'تعداد الكريات البيض', value: 'WBC 13 ×10⁹/L', kind: 'investigation', reveal: 'on_request' },
      { id: 'f_ct', label: 'CT abdomen', value: 'Inflamed appendix', kind: 'imaging', reveal: 'on_request' },
    ],
    stages: [
      { id: 's_present', type: 'presentation', title: 'القصة الأولية', prompt: 'اقرأ القصة.', reveal_fact_ids: ['f_migration', 'f_temp'], select: 'none', next_stage_id: 's_exam' },
      {
        id: 's_exam',
        type: 'examination',
        title: 'الفحص',
        prompt: 'ماذا تفحص؟',
        select: 'many',
        next_stage_id: 's_inv',
        decisions: [
          { id: 'd_palpate', label: 'Palpate the right iliac fossa', appropriateness: 'appropriate', reveal_fact_ids: ['f_rif'] },
          { id: 'd_murphy', label: "Check Murphy's sign", appropriateness: 'inappropriate', consequence: 'لا يضيف هذا الفحص معلومة جديدة في هذا السيناريو.' },
        ],
      },
      {
        id: 's_inv',
        type: 'investigations',
        title: 'الفحوص',
        prompt: 'اختر الفحوص.',
        select: 'many',
        next_stage_id: 's_dx',
        decisions: [
          { id: 'd_cbc', label: 'Full blood count', appropriateness: 'appropriate', reveal_fact_ids: ['f_wbc'] },
          { id: 'd_ct', label: 'CT abdomen', appropriateness: 'appropriate', reveal_fact_ids: ['f_ct'] },
          { id: 'd_mri', label: 'MRI brain', appropriateness: 'inappropriate' },
        ],
      },
      {
        id: 's_dx',
        type: 'diagnosis',
        title: 'التشخيص',
        prompt: 'ما التشخيص الأرجح؟',
        select: 'one',
        next_stage_id: 's_mx',
        decisions: [
          { id: 'd_appendicitis', label: 'Acute appendicitis', appropriateness: 'appropriate' },
          { id: 'd_chole', label: 'Acute cholecystitis', appropriateness: 'inappropriate', consequence: 'الألم في الحفرة الحرقفية اليمنى لا يتوافق؛ أعد النظر.', next_stage_id: 's_reconsider' },
        ],
      },
      { id: 's_reconsider', type: 'differentials', title: 'إعادة النظر', prompt: 'راجع موضع الألم.', select: 'none', next_stage_id: 's_mx' },
      {
        id: 's_mx',
        type: 'management',
        title: 'التدبير',
        prompt: 'ما الخطوة التالية؟',
        select: 'one',
        next_stage_id: null,
        decisions: [
          { id: 'd_surgery', label: 'Surgical review', appropriateness: 'appropriate' },
          { id: 'd_discharge', label: 'Discharge home', appropriateness: 'inappropriate', consequence: 'يعود المريض في الصباح بالألم نفسه.' },
        ],
      },
    ],
    start_stage_id: 's_present',
    checklist: [
      { id: 'c_palpate', text: 'Examined the right iliac fossa', category: 'examination', points: 2, satisfied_by: ['d_palpate'] },
      { id: 'c_cbc', text: 'Requested a full blood count', category: 'investigations', points: 1, satisfied_by: ['d_cbc'] },
      { id: 'c_dx', text: 'Reached the diagnosis', category: 'diagnosis', points: 2, satisfied_by: ['d_appendicitis'], critical: true },
      { id: 'c_mx', text: 'Referred for surgical review', category: 'management', points: 1, satisfied_by: ['d_surgery'] },
    ],
    ...over,
  };
}

export function osceHistoryStation(over: Partial<CaseDefinitionInput> = {}): CaseDefinitionInput {
  return {
    kind: 'osce',
    title: 'OSCE: abdominal pain history (TEST)',
    facts: [
      { id: 'f_onset', label: 'بداية الألم', value: 'بدأ الألم أمس حول السرة', kind: 'history', reveal: 'on_request' },
      { id: 'f_nausea', label: 'الغثيان', value: 'نعم، أشعر بغثيان منذ الصباح', kind: 'history', reveal: 'on_request' },
    ],
    osce: {
      station_type: 'history_taking',
      candidate_instructions: 'خذ القصة المرضية من مريض يشكو ألمًا في البطن.',
      roles: ['patient', 'examiner'],
      minutes: 8,
      patient_responses: [
        { id: 'r_onset', match: ['متى بدأ', 'when did the pain start', 'onset'], fact_id: 'f_onset' },
        { id: 'r_nausea', match: ['غثيان', 'nausea'], fact_id: 'f_nausea' },
      ],
    },
    checklist: [
      { id: 'o_onset', text: 'Asked about the onset of pain', category: 'history', match: ['متى بدأ', 'onset', 'when did the pain start'], order: 1 },
      { id: 'o_nausea', text: 'Asked about nausea', category: 'history', match: ['غثيان', 'nausea'], order: 2 },
      { id: 'o_fever', text: 'Asked about fever', category: 'history', match: ['حرارة', 'حمى', 'fever'], order: 3 },
    ],
    ...over,
  };
}

export function vivaDefinition(over: Partial<CaseDefinitionInput> = {}): CaseDefinitionInput {
  return {
    kind: 'viva',
    title: 'Viva: appendicitis investigations (TEST)',
    viva: {
      max_follow_ups: 2,
      questions: [
        {
          id: 'q1',
          prompt: 'What investigations help when appendicitis is suspected?',
          points: [
            { id: 'p_wbc', text: 'White cell count', match: ['white cell count', 'wbc', 'كريات البيض'] },
            { id: 'p_us', text: 'Ultrasound first-line in children and pregnancy', match: ['ultrasound', 'الأمواج فوق الصوتية'] },
            { id: 'p_ct', text: 'CT abdomen in adults when uncertain', match: ['ct'] },
          ],
          follow_ups: [
            { id: 'f_us', prompt: 'And in children or pregnant women?', when: { type: 'missing', point_id: 'p_us' } },
            { id: 'f_ct', prompt: 'And in adults when the diagnosis is uncertain?', when: { type: 'missing', point_id: 'p_ct' } },
          ],
          misconceptions: [{ id: 'm_murphy', match: ["murphy's sign", 'murphy sign'], correction: [{ text: "Murphy's sign belongs to the gallbladder, not the appendix.", medical: true }] }],
        },
        {
          id: 'q2',
          prompt: 'Name one differential diagnosis.',
          points: [{ id: 'p_ectopic', text: 'Ectopic pregnancy', match: ['ectopic', 'الحمل خارج الرحم'] }],
        },
      ],
    },
    ...over,
  };
}

export async function createCase(t: TestApp, h: AuthHeaders, definition: CaseDefinitionInput, scope: CaseSaveRequest['scope'] = null) {
  const res = await t.app.inject({ method: 'POST', url: '/api/cases', headers: h, payload: { definition, scope } });
  if (res.statusCode !== 200) throw new Error(`create case failed: ${res.statusCode} ${res.body}`);
  return res.json();
}

export async function start(t: TestApp, h: AuthHeaders, caseId: string, body: Record<string, unknown> = {}): Promise<CaseRunView> {
  const res = await t.app.inject({ method: 'POST', url: `/api/cases/${caseId}/attempts`, headers: h, payload: body });
  if (res.statusCode !== 200) throw new Error(`start failed: ${res.statusCode} ${res.body}`);
  return res.json();
}

export async function ev(t: TestApp, h: AuthHeaders, attemptId: string, event: Record<string, unknown>) {
  return t.app.inject({ method: 'POST', url: `/api/cases/attempts/${attemptId}/events`, headers: h, payload: { event_id: newId(), ...event } });
}

export async function evOk(t: TestApp, h: AuthHeaders, attemptId: string, event: Record<string, unknown>): Promise<CaseRunView> {
  const res = await ev(t, h, attemptId, event);
  if (res.statusCode !== 200) throw new Error(`event failed: ${res.statusCode} ${res.body}`);
  return res.json().run;
}
