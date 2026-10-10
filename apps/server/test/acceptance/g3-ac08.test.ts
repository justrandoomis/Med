// G3 / AC-08 — «a diagram's explanation keeps the direction of its arrows and its branches; any unreadable region is
// shown as uncertain and never becomes a fixed exam answer». Golden Set lecture (`lecture_appendicitis.pdf`, flowchart
// «Figure 1: Management pathway by Alvarado score» on printed page 14) uploaded through the REAL route and processed by
// the REAL pipeline (pdf.js + poppler + tesseract). The only fake is the AI: the TEST-ONLY scripted provider.
//
// Adversarial angles:
//   * the flowchart is read by OCR WITHOUT understanding: its labels are «uncertain», edges are never inferred — and OCR
//     really misreads the thresholds here («Score ≥ 7» / «Score ≤ 4» come out as other symbols). That text is still
//     indexed with the figure, so it reaches evidence packs: a generated MCQ resting on it must never be published as a
//     scored («fixed») answer, and an explanation sentence resting ONLY on it must not be shown as «linked»;
//   * a vision reading with arrows between ARABIC labels, mixed Arabic/English labels and three branches: in an RTL
//     paragraph a bare «→» between Arabic words is displayed pointing backwards (Unicode bidi: the arrow is not
//     mirrored) — the direction must be stated unambiguously and every branch kept, in order;
//   * the Image Quiz on the real processed figure: an uncertain mask label is never a fixed answer, also when the label
//     becomes uncertain after the quiz started.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DiagramStructure, EvidenceView, GenerateQuestionsResponse, GenerationRunView, ImageQuizView, StudyArtifactView } from '@medlevo/shared';
import type { ProviderRequest } from '../../src/modules/ai/types';
import { MODULES } from '../../src/modules';
import { createProcessingModule } from '../../src/modules/processing';
import { allSupported, evidenceIn, ScriptedAi } from '../exams/helpers';
import { createTestApp } from '../helpers/app';
import { createNode, golden, uploadAndProcess, type QApp } from '../questions/helpers';

const ai = new ScriptedAi();
let t: QApp;
let lecture: { sourceId: string; versionId: string };
let fig: { id: string; page_id: string };
let diagram: { id: string; text: string; structure_json: string; status: string };
let caption: { id: string; text: string };

beforeAll(async () => {
  const app = await createTestApp({
    ai,
    modules: MODULES.map((m) => (m.name === 'processing' ? { ...m, plugin: createProcessingModule({}) } : m)),
    jobs: { backoffBaseMs: 0, backoffMaxMs: 0 },
  });
  t = Object.assign(app, { h: await app.login() }) as QApp;
  const course = (await createNode(t, 'Surgery Course 1 (G3)')).id;
  lecture = await uploadAndProcess(t, course, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Acute Appendicitis (TEST FIXTURE)');
  fig = t.ctx.db.get<{ id: string; page_id: string }>(`SELECT id, page_id FROM source_region WHERE version_id = ? AND kind = 'figure' ORDER BY reading_order LIMIT 1`, [lecture.versionId])!;
  diagram = t.ctx.db.get(`SELECT id, text, structure_json, status FROM source_region WHERE parent_region_id = ? AND kind = 'diagram'`, [fig.id])!;
  caption = t.ctx.db.get(`SELECT id, text FROM source_region WHERE page_id = ? AND kind = 'caption'`, [fig.page_id])!;
  ai.on('verify_support', allSupported);
}, 240_000);

afterAll(async () => {
  await t?.close();
});

afterEach(() => {
  ai.off('generate_questions').off('validate_question').off('vision_figure').off('explain');
});

const api = {
  post: (url: string, payload: unknown) => t.app.inject({ method: 'POST', url, headers: t.h, payload: payload as never }),
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: t.h }),
  patch: (url: string, payload: unknown) => t.app.inject({ method: 'PATCH', url, headers: t.h, payload: payload as never }),
};
const lectureOnly = () => ({ mode: 'lecture_only' as const, lecture_source_id: lecture.sourceId });
/** the alias of the evidence block whose quote contains `needle`, or null */
const aliasOrNull = (req: ProviderRequest, needle: string): string | null => {
  for (const [alias, quote] of evidenceIn(req.prompt)) if (quote.includes(needle)) return alias;
  return null;
};
const blockText = (a: StudyArtifactView, kind: string) =>
  a.blocks
    .filter((b) => b.kind === kind)
    .map((b) => b.content.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n'))
    .join('\n');

async function generate(body: Record<string, unknown>): Promise<GenerationRunView> {
  const res = await api.post('/api/exams/generate', body);
  expect(res.statusCode, res.body).toBe(200);
  await t.ctx.jobs.drain();
  return ((await api.get(`/api/exams/generate/${(res.json() as GenerateQuestionsResponse).run.id}`)).json() as GenerateQuestionsResponse).run;
}

describe('G3 AC-08 — the flowchart as processed (real pipeline)', () => {
  it('labels are OCR readings without understanding: every node uncertain, no arrow inferred, the region «uncertain» — and the peek says so', async () => {
    expect(diagram.status).toBe('uncertain');
    const s = JSON.parse(diagram.structure_json) as DiagramStructure & { understanding?: string };
    expect(s.nodes.length).toBeGreaterThanOrEqual(6);
    expect(s.nodes.every((n) => n.certainty === 'uncertain')).toBe(true);
    expect(s.edges).toEqual([]); // the direction of an arrow is never guessed from OCR
    expect(s.understanding).toBe('labels_ocr_only');
    // the printed thresholds are «≥ 7» and «≤ 4»: what OCR stored is NOT that — exactly why it must stay uncertain
    expect(diagram.text).toContain('Alvarado score');
    expect(diagram.text).not.toContain('≥ 7');
    // evidence made from it (e.g. a selection on the figure) carries the uncertain status to the Evidence Peek
    const ev = await api.post('/api/evidence/from-region', { region_id: diagram.id });
    expect(ev.statusCode, ev.body).toBe(200);
    expect((ev.json() as { evidence: EvidenceView }).evidence.extraction_status).toBe('uncertain');
  });
});

describe('G3 AC-08 — an unreadable region never becomes a fixed exam answer', () => {
  const figurePageRequest = () => ({ lecture_source_id: lecture.sourceId, page_ids: [fig.page_id], topic: 'management pathway by Alvarado score', count: 1, difficulty: 'medium', item_types: ['recall'] });

  it('a generated MCQ whose key rests on the OCR-read flowchart labels is never published (the labels never even reach the generator as evidence)', async () => {
    const seen: string[] = [];
    ai.on('generate_questions', (req) => {
      seen.push(req.prompt);
      const d = aliasOrNull(req, 'Alvarado score ·');
      if (!d) return { abstain: { reason: 'insufficient_evidence', detail: 'the flowchart labels are not in the evidence' }, questions: [] };
      const quote = evidenceIn(req.prompt).get(d)!;
      const said = (text: string) => [{ text, claim: { support_type: 'directly_stated', evidence: [d] } }];
      return {
        abstain: null,
        questions: [
          {
            item_type: 'recall',
            learning_objective: 'Follow the management pathway of the lecture flowchart.',
            concepts: ['Alvarado score'],
            difficulty_est: 'medium',
            stem: 'In the management pathway of the lecture, which step follows a low Alvarado score?',
            options: [
              { key: 'A', text: 'Surgical review' },
              { key: 'B', text: 'Imaging (US / CT)' },
              { key: 'C', text: 'Observe, re-assess' },
              { key: 'D', text: 'Discharge without follow-up' },
            ],
            best_answer: 'C',
            explanation: said(`The pathway reads: ${quote}.`),
            distractors: [
              { option: 'A', explanation: said(`The pathway reads: ${quote}.`) },
              { option: 'B', explanation: said(`The pathway reads: ${quote}.`) },
              { option: 'D', explanation: said(`The pathway reads: ${quote}.`) },
            ],
          },
        ],
      };
    });
    ai.on('validate_question', () => ({ chosen_option: 'C', defensible_options: ['C'], answerable_from_evidence: true, clue_issues: [], issues: [], verdict: 'valid' }));
    const run = await generate(figurePageRequest());
    expect(run.candidates.filter((c) => c.status === 'published')).toEqual([]);
    expect(['abstained', 'needs_review']).toContain(run.status);
    // nothing published from this run: no generated question rests on the diagram region
    const leaked = t.ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM artifact_dependency WHERE dependent_type = 'question_version' AND region_id = ?`,
      [diagram.id],
    );
    expect(leaked?.n ?? 0).toBe(0);
    // the OCR reading of the flowchart never reached the generator as citable evidence
    for (const p of seen) expect([...evidenceIn(p).values()].some((q) => q.includes('Alvarado score ·'))).toBe(false);
  });

  it('control: the same page still yields a published question from its READABLE text (caption / paragraph)', async () => {
    ai.on('generate_questions', (req) => {
      const para = aliasOrNull(req, 'the score directs the next step')!;
      expect(para).toBeTruthy();
      const s = (text: string) => [{ text, claim: { support_type: 'directly_stated', evidence: [para] } }];
      return {
        abstain: null,
        questions: [
          {
            item_type: 'recall',
            learning_objective: 'Know what the Alvarado score is used for in the lecture.',
            concepts: ['Alvarado score'],
            difficulty_est: 'medium',
            stem: 'According to the lecture, what does the Alvarado score direct in suspected appendicitis?',
            options: [
              { key: 'A', text: 'The next management step' },
              { key: 'B', text: 'The antibiotic dose' },
              { key: 'C', text: 'The anaesthetic technique' },
              { key: 'D', text: 'The length of the incision' },
            ],
            best_answer: 'A',
            explanation: s('The score directs the next step: surgical review, imaging, or observation.'),
            distractors: ['B', 'C', 'D'].map((option) => ({ option, explanation: s('The score directs the next step: surgical review, imaging, or observation.') })),
          },
        ],
      };
    });
    ai.on('validate_question', () => ({ chosen_option: 'A', defensible_options: ['A'], answerable_from_evidence: true, clue_issues: [], issues: [], verdict: 'valid' }));
    const run = await generate({ ...figurePageRequest(), topic: 'what the Alvarado score directs' });
    expect(run.status, JSON.stringify(run)).toBe('completed');
    const q = (await api.get(`/api/questions/${run.candidates[0]!.question_id}`)).json();
    expect(q.question.current.answer_status).toBe('ai_derived');
    expect(q.scorable).toBe(true);
  });

  it('an explanation sentence that rests ONLY on the OCR-read labels is «needs review», never «linked»; a caption sentence stays linked', async () => {
    ai.on('vision_figure', (req) => {
      const d = aliasOrNull(req, 'Alvarado score ·')!;
      const c = aliasOrNull(req, 'Figure 1: Management pathway')!;
      expect(d && c).toBeTruthy();
      return {
        figure_kind: 'flowchart',
        content: {
          abstain: null,
          blocks: [
            {
              kind: 'paragraph',
              sentences: [
                { text: 'Figure 1: Management pathway by Alvarado score.', claim: { support_type: 'directly_stated', evidence: [c] } },
                { text: `The flowchart lists ${diagram.text.split(' · ').slice(2, 5).join(', ')}.`, claim: { support_type: 'derived', evidence: [d] } },
              ],
            },
          ],
        },
        visual_items: [],
      };
    });
    const res = await api.post('/api/studybook/explain', { action: 'explain_image', style: 'detailed', anchor: { source_id: lecture.sourceId, version_id: lecture.versionId, page_id: fig.page_id, region_ids: [fig.id] }, scope: lectureOnly() });
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json().artifact as StudyArtifactView;
    const claims = Object.values(a.claims);
    const cap = claims.find((c) => c.text.startsWith('Figure 1'))!;
    const fromLabels = claims.find((c) => c.text.startsWith('The flowchart lists'))!;
    expect(cap.verification_status).toBe('linked');
    expect(fromLabels.verification_status).toBe('needs_review');
    expect(fromLabels.issues.map((i) => i.reason_ar).join(' ')).toMatch(/غير مؤكدة/);
  });
});

describe('G3 AC-08 — the visual reading keeps arrow direction and branches (RTL-safe)', () => {
  it('arrows between Arabic / mixed / English labels are stated with words; all three branches kept in order; everything uncertain and flagged not-for-exam', async () => {
    ai.on('vision_figure', (req) => {
      const c = aliasOrNull(req, 'Figure 1: Management pathway')!;
      const arrow = (from: string, to: string) => ({ kind: 'arrow', description: 'سهم مرسوم بين مربعين', label_text: null, from, to, certainty: 'clear' });
      return {
        figure_kind: 'flowchart',
        content: { abstain: null, blocks: [{ kind: 'paragraph', sentences: [{ text: 'Figure 1: Management pathway by Alvarado score.', claim: { support_type: 'directly_stated', evidence: [c] } }] }] },
        visual_items: [
          arrow('Suspected appendicitis', 'Alvarado score'),
          arrow('Alvarado score', 'Score ≥ 7 · Surgical review'),
          arrow('Alvarado score', 'Score 5–6 · Imaging (US / CT)'),
          arrow('Alvarado score', 'Score ≤ 4 · Observe, re-assess'),
          arrow('ألم حول السرة', 'ألم الحفرة الحرقفية اليمنى'),
          arrow('الشك بالتهاب الزائدة', 'Alvarado score'),
          { kind: 'label', description: 'تسمية مطبوعة بوضوح', label_text: 'Alvarado score', from: null, to: null, certainty: 'clear' },
        ],
      };
    });
    const res = await api.post('/api/studybook/explain', {
      action: 'explain_image',
      style: 'detailed',
      instruction: 'اشرح المخطط بالترتيب',
      anchor: { source_id: lecture.sourceId, version_id: lecture.versionId, page_id: fig.page_id, region_ids: [fig.id] },
      scope: lectureOnly(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json().artifact as StudyArtifactView;
    const vb = a.blocks.find((b) => b.kind === 'figure')!;
    expect(vb.meta).toMatchObject({ not_for_exam_answer: true, visual: { items: 7, vision_used: true } });
    expect(vb.verification_status).toBe('needs_review');
    // a visual reading is never evidence: no claim on any of its runs
    expect(vb.content.paragraphs.every((p) => p.runs.every((x) => !x.claim))).toBe(true);
    const text = blockText(a, 'figure');
    const lines = text.split('\n').slice(1); // first line = the server's label «قراءة بصرية مولَّدة … ليست دليلًا»
    expect(text).toContain('ليست دليلًا');
    // every arrow / relation is uncertain (only the readable label is «مقروء نصيًا أيضًا»)
    expect(lines.filter((l) => l.startsWith('[سهم'))).toHaveLength(6);
    for (const l of lines.filter((x) => x.startsWith('[سهم'))) expect(l).toContain('غير مؤكد');
    // direction in words, never a bare arrow glyph whose visual direction flips inside Arabic text
    expect(text).not.toContain('→');
    expect(lines[4]).toContain('من «ألم حول السرة» إلى «ألم الحفرة الحرقفية اليمنى»');
    expect(lines[5]).toContain('من «الشك بالتهاب الزائدة» إلى «Alvarado score»');
    // the three branches leaving «Alvarado score» are all there, in the order drawn
    expect(lines[1]).toContain('من «Alvarado score» إلى «Score ≥ 7 · Surgical review»');
    expect(lines[2]).toContain('من «Alvarado score» إلى «Score 5–6 · Imaging (US / CT)»');
    expect(lines[3]).toContain('من «Alvarado score» إلى «Score ≤ 4 · Observe, re-assess»');
    // the clear label also printed in the OCR text is the only item not marked uncertain
    expect(lines[6]).toContain('مقروء نصيًا أيضًا');
  });

  it('a long flowchart: items beyond what is displayed are counted and said, never silently dropped', async () => {
    ai.on('vision_figure', (req) => {
      const c = aliasOrNull(req, 'Figure 1: Management pathway')!;
      return {
        figure_kind: 'flowchart',
        content: { abstain: null, blocks: [{ kind: 'paragraph', sentences: [{ text: 'Figure 1: Management pathway by Alvarado score.', claim: { support_type: 'directly_stated', evidence: [c] } }] }] },
        visual_items: Array.from({ length: 46 }, (_, i) => ({ kind: 'arrow', description: `فرع ${i + 1}`, label_text: null, from: `Step ${i + 1}`, to: `Step ${i + 2}`, certainty: 'clear' })),
      };
    });
    const res = await api.post('/api/studybook/explain', {
      action: 'explain_image',
      style: 'detailed',
      instruction: 'كل الفروع',
      anchor: { source_id: lecture.sourceId, version_id: lecture.versionId, page_id: fig.page_id, region_ids: [fig.id] },
      scope: lectureOnly(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json().artifact as StudyArtifactView;
    const vb = a.blocks.find((b) => b.kind === 'figure')!;
    const text = blockText(a, 'figure');
    expect(text).toContain('من «Step 40» إلى «Step 41»');
    expect(text).toMatch(/6 عناصر أخرى/);
    expect(vb.meta).toMatchObject({ not_for_exam_answer: true, visual: { items: 46, uncertain: 46 } });
  });
});

describe('G3 AC-08 — Image Quiz on the real processed flowchart', () => {
  it('an uncertain label is never asked; one marked uncertain after the quiz started is never graded', async () => {
    const img = t.ctx.db.get<{ id: string }>(`SELECT id FROM image_asset WHERE region_id = ?`, [fig.id])!;
    const overlay = async (body: Record<string, unknown>) => {
      const r = await api.post(`/api/media/images/${img.id}/overlays`, body);
      expect(r.statusCode, r.body).toBe(200);
      return r.json() as { id: string; rev: number; quiz_eligible: boolean };
    };
    // the threshold label OCR could not read reliably → the owner marks it uncertain
    const unsure = await overlay({ kind: 'occlusion_mask', shape: { type: 'rect', x: 0.02, y: 0.58, w: 0.28, h: 0.16 }, label: 'Score ≥ 7', certainty: 'uncertain' });
    expect(unsure.quiz_eligible).toBe(false);
    const only = await api.post('/api/media/quiz', { image_id: img.id });
    expect(only.statusCode).toBe(409);
    expect(only.body).not.toContain('Score ≥ 7');
    const sure = await overlay({ kind: 'occlusion_mask', shape: { type: 'rect', x: 0.36, y: 0.27, w: 0.28, h: 0.11 }, label: 'Alvarado score', certainty: 'from_caption' });
    const quiz = (await api.post('/api/media/quiz', { image_id: img.id })).json() as ImageQuizView;
    expect(quiz.masks).toHaveLength(1);
    expect(quiz.excluded).toHaveLength(1);
    expect(JSON.stringify(quiz)).not.toContain('Score ≥ 7');
    // later the owner doubts the remaining label too: it is no longer graded as a fixed answer
    const p = await api.patch(`/api/media/overlays/${sure.id}`, { base_rev: sure.rev, certainty: 'uncertain' });
    expect(p.statusCode, p.body).toBe(200);
    const ans = await api.post(`/api/media/quiz/${quiz.id}/answer`, { key: 'm1', answer: 'Alvarado score' });
    expect(ans.statusCode).toBe(409);
    expect(ans.body).not.toContain('Alvarado score');
  });
});
