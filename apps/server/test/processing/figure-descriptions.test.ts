// Automatic figure descriptions for image-heavy lectures (modules/processing/figures.ts) with the TEST-ONLY scripted
// provider (never registered in production): nothing is sent without a key or without a standing ai_processing
// consent; with both, every cropped figure and image-only page is described once (the picture is sent, the source is
// never changed), a diagnosis is kept as «stated» only when the slide's text / caption says it, the owner's correction
// wins and survives a re-run, an exhausted budget stops sending with an honest status, search finds a figure by a
// finding, image flashcards (one now / drafts reviewed before spaced repetition) and image MCQs — published only when
// the answer rests on the lecture text or an owner-confirmed description, otherwise left in the review queue.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CardCreateResponse,
  FigureDescriptionResponse,
  FigureDescriptionsResponse,
  FigureDescriptionView,
  FlashcardView,
  GenerateQuestionsResponse,
  GenerationRunView,
  QuestionDetailResponse,
  SearchResponse,
} from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import type { ProviderRequest } from '../../src/modules/ai/types';
import { buildChunks, writeChunks } from '../../src/modules/processing/chunks';
import { answerSupportedBy } from '../../src/modules/exams/generation/pipeline';
import { enqueueFigureDescriptionFollowUp, groundDescription } from '../../src/modules/processing/figures';
import { encodePng } from '../../src/modules/processing/png';
import { createTestApp } from '../helpers/app';
import { grantAiConsent } from '../helpers/consent';
import { solid } from '../helpers/images';
import { allSupported, evidenceIn, ScriptedAi } from '../exams/helpers';
import { api, createNode, type QApp } from '../questions/helpers';

/** A provider whose data leaves the deployment (like Anthropic): content is sent only with the owner's consent. */
class LeavingAi extends ScriptedAi {
  readonly dataLeavesDeployment = true;
}

const ai = new LeavingAi();
let t: QApp;
let lecture: { sourceId: string; versionId: string; pages: string[]; figure: string; caption: string; label: string; figure2: string };

const P = {
  adeno: 'Colorectal adenocarcinoma shows irregular malignant glands invading the submucosa with desmoplastic stroma.',
  adenoma: 'Tubular adenoma is a benign polyp with dysplastic tubular glands confined to the mucosa.',
  hyper: 'Hyperplastic polyps show serrated crypts without any dysplasia of the epithelium.',
  crohn: 'Crohn disease shows transmural inflammation with non-caseating granulomas in the bowel wall.',
};
const CAPTION = 'Figure 2: Colorectal adenocarcinoma (H&E, ×40)';

function png(rgb: [number, number, number]): Buffer {
  return encodePng(solid(24, 16, rgb));
}

async function insertImageLecture(courseId: string) {
  const { ctx } = t;
  const now = ctx.clock.now();
  const sourceId = newId(now);
  const versionId = newId(now);
  const pages = [newId(now), newId(now), newId(now)];
  const f1 = await ctx.files.put(png([200, 80, 120]), { mime: 'image/png', originalName: 'crop1.png' });
  const f2 = await ctx.files.put(png([90, 90, 200]), { mime: 'image/png', originalName: 'page2.png' });
  const f3 = await ctx.files.put(png([20, 160, 40]), { mime: 'image/png', originalName: 'crop3.png' });
  const ids = { figure: newId(now), caption: newId(now), label: newId(now), figure2: newId(now) };
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO source (id, title, source_type, node_id, course_node_id, processing_status, sort_order, created_at, updated_at) VALUES (?, ?, 'lecture', ?, ?, 'ready', ?, ?, ?)`,
      [sourceId, 'Colon pathology (TEST FIXTURE)', courseId, courseId, now, now, now],
    );
    ctx.db.run(
      `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, file_name, format, page_count, processing_status, created_at)
       VALUES (?, ?, 1, 'original', ?, 'application/pdf', 'colon.pdf', 'pdf', 3, 'ready', ?)`,
      [versionId, sourceId, newId(now), now],
    );
    ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [versionId, sourceId]);
    pages.forEach((id, i) =>
      ctx.db.run(
        `INSERT INTO source_page (id, version_id, page_index, kind, text_status, processing_status, render_file_id, created_at, updated_at) VALUES (?, ?, ?, 'slide', 'digital', 'ready', ?, ?, ?)`,
        [id, versionId, i, i === 1 ? f2.id : null, now, now],
      ),
    );
    const region = (id: string, page: string, kind: string, order: number, text: string | null, bbox: object | null, parent: string | null = null) =>
      ctx.db.run(
        `INSERT INTO source_region (id, version_id, page_id, parent_region_id, kind, reading_order, bbox_json, text, text_origin, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'digital', 'extracted', ?, ?)`,
        [id, versionId, page, parent, kind, order, bbox ? JSON.stringify(bbox) : null, text, now, now],
      );
    region(newId(now), pages[0]!, 'heading', 0, 'Colon tumours', null);
    Object.values(P).forEach((text, i) => region(newId(now), pages[0]!, 'paragraph', i + 1, text, null));
    region(ids.figure, pages[0]!, 'figure', 10, null, { x: 0.1, y: 0.4, w: 0.8, h: 0.5 });
    region(ids.label, pages[0]!, 'text_block', 11, 'Malignant glands', { x: 0.5, y: 0.6, w: 0.1, h: 0.05 }, ids.figure);
    region(ids.caption, pages[0]!, 'caption', 12, CAPTION, { x: 0.1, y: 0.92, w: 0.8, h: 0.04 });
    region(newId(now), pages[0]!, 'paragraph', 13, 'Normal colonic mucosa shows straight test-tube crypts with goblet cells.', null);
    region(ids.figure2, pages[0]!, 'figure', 14, null, { x: 0.2, y: 0.05, w: 0.6, h: 0.3 });
    region(newId(now), pages[2]!, 'paragraph', 0, 'Summary: colorectal tumours are graded by gland formation.', null);
    const asset = (fileId: string, page: string, regionId: string, caption: string | null, captionRegion: string | null) =>
      ctx.db.run(
        `INSERT INTO image_asset (id, file_id, source_id, version_id, page_id, region_id, caption_region_id, origin, image_kind, caption, match_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'source', 'unknown', ?, 'unverified', ?)`,
        [newId(now), fileId, sourceId, versionId, page, regionId, captionRegion, caption, now],
      );
    asset(f1.id, pages[0]!, ids.figure, CAPTION, ids.caption);
    asset(f3.id, pages[0]!, ids.figure2, null, null);
  });
  writeChunks(ctx, versionId, sourceId, buildChunks(ctx, versionId));
  return { sourceId, versionId, pages, ...ids };
}

const describeOutput = (req: ProviderRequest) => {
  if (req.prompt.includes('FIGURE CAPTION')) {
    return {
      legible: true,
      image_type: 'histology',
      stain: 'H&E',
      magnification: '×40',
      findings: ['Irregular malignant glands invading the submucosa', 'Desmoplastic stroma'],
      labels: [{ text: 'Malignant glands', points_to: 'the irregular glands' }],
      graph: null,
      diagnosis: { text: 'Colorectal adenocarcinoma', basis: 'caption', quote: 'Colorectal adenocarcinoma' },
      caption_ar: 'شريحة نسيجية لسرطانة غدية في القولون',
      caption_en: 'Histology of colorectal adenocarcinoma',
    };
  }
  if (req.prompt.includes('SLIDE TEXT')) {
    return {
      legible: true,
      image_type: 'histology',
      stain: null,
      magnification: null,
      findings: ['Straight crypts with goblet cells'],
      labels: [],
      graph: null,
      // the model CLAIMS the slide says it, but the quote is not in the slide text → a suggestion
      diagnosis: { text: 'Ulcerative colitis', basis: 'slide_text', quote: 'ulcerative colitis' },
      caption_ar: 'غشاء مخاطي للقولون',
      caption_en: 'Colonic mucosa',
    };
  }
  // the image-only page (no text around it)
  return {
    legible: true,
    image_type: 'gross',
    stain: null,
    magnification: null,
    findings: ['Nodular liver surface with fibrous septa'],
    labels: [],
    graph: null,
    diagnosis: { text: 'Liver cirrhosis', basis: 'suggestion', quote: null },
    caption_ar: 'عينة عيانية لكبد مع تليف وعقيدات',
    caption_en: 'Gross liver with fibrosis and nodules',
  };
};

beforeAll(async () => {
  const app = await createTestApp({ ai, jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
  const h = await app.login();
  t = Object.assign(app, { h }) as QApp;
  const course = (await createNode(t, 'Pathology (TEST)')).id;
  lecture = await insertImageLecture(course);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

const list = async () => {
  const res = await api(t).get(`/api/processing/versions/${lecture.versionId}/figure-descriptions`);
  expect(res.statusCode).toBe(200);
  return res.json() as FigureDescriptionsResponse;
};
const byRegion = (l: FigureDescriptionsResponse, regionId: string | null) => l.items.find((d) => d.region_id === regionId)!;
const runCount = () => t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM figure_description_run')!.n;

describe('figure descriptions: nothing is sent without a key or a consent', () => {
  it('without the owner’s ai_processing consent: nothing is queued or sent; the reader says how to enable it', async () => {
    ai.on('describe_figure', describeOutput);
    expect(enqueueFigureDescriptionFollowUp(t.ctx, lecture.versionId, 'process-job-1')).toBe(false);
    expect(runCount()).toBe(0);
    const l = await list();
    expect(l.can_describe.available).toBe(false);
    expect(l.can_describe.consent_required).toBe(true);
    const res = await api(t).post(`/api/processing/versions/${lecture.versionId}/figure-descriptions/describe`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONSENT_REQUIRED');
    expect(ai.calls).toHaveLength(0);
  });

  it('without an AI key: no follow-up job and the route refuses honestly', async () => {
    const bare = await createTestApp({ ai: null });
    try {
      const h = await bare.login();
      expect(enqueueFigureDescriptionFollowUp(bare.ctx, 'no-version', 'job')).toBe(false);
      const res = await bare.app.inject({ method: 'POST', url: `/api/processing/versions/${lecture.versionId}/figure-descriptions/describe`, headers: h, payload: {} });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('AI_NOT_CONFIGURED');
    } finally {
      await bare.close();
    }
  });
});

describe('figure descriptions with a key and a standing consent', () => {
  it('the follow-up describes every figure and image-only page once; the picture is sent; the source is unchanged; diagnoses are grounded', async () => {
    grantAiConsent(t, 'scripted-test');
    const before = t.ctx.db.all('SELECT id, text, structure_json, status FROM source_region WHERE version_id = ? ORDER BY id', [lecture.versionId]);
    expect(enqueueFigureDescriptionFollowUp(t.ctx, lecture.versionId, 'process-job-1')).toBe(true);
    // idempotent per processing run
    expect(enqueueFigureDescriptionFollowUp(t.ctx, lecture.versionId, 'process-job-1')).toBe(false);
    await t.ctx.jobs.drain();
    const calls = ai.callsFor('describe_figure');
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.images).toHaveLength(1);
      expect(c.images![0]!.mime).toBe('image/png');
    }
    const l = await list();
    expect(l.run?.status).toBe('completed');
    expect(l.run?.trigger).toBe('auto');
    expect(l.counts.described).toBe(3);
    const fig = byRegion(l, lecture.figure);
    expect(fig.status).toBe('described');
    expect(fig.label_ar).toBe('وصف آلي — راجعه');
    expect(fig.owner_reviewed).toBe(false);
    expect(fig.content?.diagnosis).toEqual({ text: 'Colorectal adenocarcinoma', basis: 'caption', quote: 'Colorectal adenocarcinoma' });
    expect(fig.image_url).toMatch(/^\/api\/files\//);
    // the model said «slide_text» but the quote is not on the slide → «اقتراح — غير مؤكد»
    expect(byRegion(l, lecture.figure2).content?.diagnosis?.basis).toBe('suggestion');
    const page = l.items.find((d) => d.target === 'page')!;
    expect(page.page_id).toBe(lecture.pages[1]);
    expect(page.content?.diagnosis?.basis).toBe('suggestion');
    expect(t.ctx.db.all('SELECT id, text, structure_json, status FROM source_region WHERE version_id = ? ORDER BY id', [lecture.versionId])).toEqual(before);
  });

  it('grounding is deterministic: a quote that is not in the caption / slide text is never kept as stated', () => {
    const base = describeOutput({ prompt: 'FIGURE CAPTION' } as ProviderRequest) as Parameters<typeof groundDescription>[0];
    expect(groundDescription(base, '', CAPTION).diagnosis?.basis).toBe('caption');
    expect(groundDescription(base, '', 'Figure 2: normal mucosa').diagnosis?.basis).toBe('suggestion');
    expect(groundDescription({ ...base, diagnosis: { text: 'Crohn disease', basis: 'caption', quote: 'Colorectal adenocarcinoma' } }, '', CAPTION).diagnosis?.basis).toBe('suggestion');
  });

  it('the owner’s correction wins and is kept when the pictures are described again', async () => {
    const fig = byRegion(await list(), lecture.figure);
    const edit = await api(t).post(`/api/processing/figure-descriptions/${fig.id}/review`, {
      decision: 'edit',
      content: { caption_ar: 'سرطانة غدية في القولون — صحّحتها', findings: ['Irregular malignant glands', 'Desmoplasia'] },
    });
    expect(edit.statusCode).toBe(200);
    const edited = (edit.json() as FigureDescriptionResponse).description;
    expect(edited.owner_status).toBe('edited');
    expect(edited.label_ar).toBe('وصف راجعته بنفسك');
    ai.on('describe_figure', (req) => (req.prompt.includes('FIGURE CAPTION') ? { ...(describeOutput(req) as object), caption_ar: 'نسخة ثانية من الوصف الآلي' } : describeOutput(req)));
    const res = await api(t).post(`/api/processing/versions/${lecture.versionId}/figure-descriptions/describe`, { force: true });
    expect(res.statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const after = byRegion(await list(), lecture.figure);
    expect(after.owner_status).toBe('edited');
    expect(after.content?.caption_ar).toBe('سرطانة غدية في القولون — صحّحتها');
    expect(after.content?.findings).toEqual(['Irregular malignant glands', 'Desmoplasia']);
    // the model's version is refreshed beside the owner's
    expect(after.machine?.caption_ar).toBe('نسخة ثانية من الوصف الآلي');
    ai.on('describe_figure', describeOutput);
  });

  it('search finds a figure by a finding (English and Arabic) and opens the page at the figure', async () => {
    const en = (await api(t).get('/api/search?q=desmoplasia&types=figures')).json() as SearchResponse;
    const hit = en.results.find((r) => r.type === 'figures');
    expect(hit).toBeTruthy();
    expect(hit!.location).toMatchObject({ source_id: lecture.sourceId, page_id: lecture.pages[0], region_id: lecture.figure });
    expect(hit!.origin).toBe('owner_typed');
    const ar = (await api(t).get(`/api/search?q=${encodeURIComponent('تليف')}&types=figures`)).json() as SearchResponse;
    const page = ar.results.find((r) => r.type === 'figures');
    expect(page?.location?.page_id).toBe(lecture.pages[1]);
    expect(page?.origin).toBe('generated');
    // a rejected description is no longer found
    const pageDesc = (await list()).items.find((d) => d.target === 'page')!;
    await api(t).post(`/api/processing/figure-descriptions/${pageDesc.id}/review`, { decision: 'reject' });
    const gone = (await api(t).get(`/api/search?q=${encodeURIComponent('تليف')}&types=figures`)).json() as SearchResponse;
    expect(gone.results.filter((r) => r.type === 'figures')).toHaveLength(0);
    await api(t).post(`/api/processing/figure-descriptions/${pageDesc.id}/review`, { decision: 'reset' });
  });

  it('an exhausted monthly budget stops sending: the remaining pictures are skipped with the reason', async () => {
    const callsBefore = ai.callsFor('describe_figure').length;
    // spending recorded this month leaves room for exactly one more (scripted) call
    const usageId = newId(t.ctx.clock.now());
    t.ctx.db.run(
      `INSERT INTO usage_record (id, job_id, task, provider, model, input_tokens, output_tokens, estimated_cost_usd, latency_ms, status, source_version_ids_json, rules_version, verification_status, request_ref, created_at)
       VALUES (?, NULL, 'explain', 'scripted-test', 'scripted-model-1', 0, 0, ?, 0, 'ok', '[]', 'test', NULL, NULL, ?)`,
      [usageId, 20 - 0.0015 - t.ctx.ai.budget().spent_usd, t.ctx.clock.now()],
    );
    try {
      const res = await api(t).post(`/api/processing/versions/${lecture.versionId}/figure-descriptions/describe`, { force: true });
      expect(res.statusCode).toBe(200);
      await t.ctx.jobs.drain();
      expect(ai.callsFor('describe_figure').length - callsBefore).toBe(1);
      const l = await list();
      expect(l.run?.status).toBe('partial');
      expect(l.run?.reason_ar).toContain('بلغت التكلفة التقديرية');
    } finally {
      t.ctx.db.run('DELETE FROM usage_record WHERE id = ?', [usageId]);
    }
  });
});

describe('image flashcards from a described figure', () => {
  it('«اصنع بطاقة من الصورة»: the original picture on the front (labels covered), the description on the back', async () => {
    const fig = byRegion(await list(), lecture.figure);
    const res = await api(t).post('/api/learning/cards/from-figure', { description_id: fig.id, hide_labels: true });
    expect(res.statusCode).toBe(200);
    const card = (res.json() as CardCreateResponse).cards[0]!;
    expect(card.kind).toBe('image_occlusion');
    expect(card.suspended).toBe(false);
    expect(card.origin).toBe('owner'); // the description is owner-corrected
    expect(card.image?.masks).toHaveLength(1);
    expect(card.image?.masks[0]!.label).toBe('Malignant glands');
    expect(card.image?.masks[0]!.box.x).toBeCloseTo(0.5, 5);
    const back = JSON.stringify(card.back);
    expect(back).toContain('صحّحتها');
    const review = await api(t).get(`/api/learning/cards/${card.id}/review`);
    expect(review.statusCode).toBe(200);
    expect(review.json().image.url).toMatch(/^\/api\/learning\/media\//);
  });

  it('«بطاقات من كل صور المحاضرة»: drafts kept out of spaced repetition until the owner accepts them (FSRS untouched)', async () => {
    const res = await api(t).post('/api/learning/cards/from-figures', { version_id: lecture.versionId });
    expect(res.statusCode).toBe(200);
    const made = (res.json() as CardCreateResponse).cards;
    expect(made).toHaveLength(2); // the first figure already has a card
    expect(made.every((c) => c.suspended && (c.origin_ref as { draft?: boolean }).draft === true && c.origin === 'generated')).toBe(true);
    expect(JSON.stringify(made[0]!.back)).toContain('وصف آلي — راجعه');
    const drafts = (await api(t).get(`/api/learning/cards/figure-drafts?version_id=${lecture.versionId}`)).json() as { items: FlashcardView[] };
    expect(drafts.items).toHaveLength(2);
    const accepted = (await api(t).post(`/api/learning/cards/${made[0]!.id}/draft`, { decision: 'accept' })).json().card as FlashcardView;
    expect(accepted.suspended).toBe(false);
    expect(accepted.review_state.state).toBe('new');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event WHERE card_id = ?', [made[0]!.id])!.n).toBe(0);
    const discarded = (await api(t).post(`/api/learning/cards/${made[1]!.id}/draft`, { decision: 'discard' })).json().card as FlashcardView;
    expect(discarded.deleted_at).not.toBeNull();
    expect(((await api(t).get(`/api/learning/cards/figure-drafts?version_id=${lecture.versionId}`)).json() as { items: FlashcardView[] }).items).toHaveLength(0);
    expect((await list()).counts.draft_cards).toBe(0);
  });
});

describe('image MCQs from a described figure', () => {
  const VALID = { chosen_option: 'B', defensible_options: ['B'], answerable_from_evidence: true, clue_issues: [], issues: [], verdict: 'valid' };
  const question = (prompt: string, best: string) => {
    const ev = [...evidenceIn(prompt).entries()];
    const alias = (needle: string) => ev.find(([, q]) => q.includes(needle))![0];
    const s = (needle: string) => ({ text: ev.find(([, q]) => q.includes(needle))![1].trim(), claim: { support_type: 'directly_stated', evidence: [alias(needle)] } });
    return {
      item_type: 'recall',
      learning_objective: 'Recognise the histology of colorectal adenocarcinoma on a lecture slide.',
      concepts: ['colorectal adenocarcinoma'],
      difficulty_est: 'medium',
      stem: 'A colonic biopsy from the lecture is shown in the image. What is the most likely diagnosis of the lesion shown?',
      options: [
        { key: 'A', text: 'Tubular adenoma' },
        { key: 'B', text: best },
        { key: 'C', text: 'Hyperplastic polyp' },
        { key: 'D', text: 'Crohn disease' },
      ],
      best_answer: 'B',
      explanation: [s('invading the submucosa')],
      distractors: [
        { option: 'A', explanation: [s('confined to the mucosa')] },
        { option: 'C', explanation: [s('serrated crypts')] },
        { option: 'D', explanation: [s('transmural inflammation')] },
      ],
    };
  };
  const generate = async (body: Record<string, unknown>): Promise<GenerationRunView> => {
    const res = await api(t).post('/api/exams/generate', body);
    if (res.statusCode !== 200) throw new Error(`generate failed ${res.statusCode} ${res.body}`);
    await t.ctx.jobs.drain();
    return ((await api(t).get(`/api/exams/generate/${(res.json() as GenerateQuestionsResponse).run.id}`)).json() as GenerateQuestionsResponse).run;
  };
  let fig: FigureDescriptionView;

  beforeAll(async () => {
    fig = byRegion(await list(), lecture.figure);
    ai.on('validate_question', () => VALID).on('verify_support', allSupported);
  });

  it('published when the lecture text states the answer: the picture is sent and shown with the question', async () => {
    ai.calls.length = 0;
    ai.on('generate_questions', (req) => ({ abstain: null, questions: [question(req.prompt, 'Adenocarcinoma')] }));
    const run = await generate({ lecture_source_id: lecture.sourceId, figure: { description_id: fig.id }, count: 1, difficulty: 'medium' });
    expect(run.status).toBe('completed');
    expect(run.request.origin).toBe('figure');
    const gen = ai.callsFor('generate_questions')[0]!;
    expect(gen.images).toHaveLength(1);
    expect(gen.prompt).toContain('OWNER-CONFIRMED DESCRIPTION');
    expect(ai.callsFor('validate_question')[0]!.images).toHaveLength(1);
    const qid = run.candidates[0]!.question_id!;
    const detail = (await api(t).get(`/api/questions/${qid}`)).json() as QuestionDetailResponse;
    expect(detail.question.figure).toMatchObject({ description_id: fig.id, source_id: lecture.sourceId, region_id: lecture.figure });
    expect(detail.question.figure!.image_url).toMatch(/^\/api\/files\//);
    expect(detail.question.current.validation?.issues.find((i) => i.check === 'images_attached')?.passed).toBe(true);
  });

  it('an unsupported diagnosis (only in an unconfirmed description, not in the lecture) is never published — it stays in review', async () => {
    const fig2 = byRegion(await list(), lecture.figure2); // machine description; its diagnosis is a suggestion
    ai.calls.length = 0;
    ai.on('generate_questions', (req) => ({ abstain: null, questions: [question(req.prompt, 'Ulcerative colitis')] }));
    const run = await generate({ lecture_source_id: lecture.sourceId, figure: { description_id: fig2.id }, count: 1, difficulty: 'medium' });
    expect(run.status).toBe('needs_review');
    expect(run.candidates[0]!.question_id).toBeNull();
    expect(run.candidates[0]!.issues.map((i) => i.reason_ar).join(' ')).toContain('لا يذكرها نص المحاضرة');
    // the unconfirmed suggestion was never handed to the generator as data
    expect(ai.callsFor('generate_questions')[0]!.prompt).not.toContain('Ulcerative colitis');
    expect(ai.callsFor('generate_questions')[0]!.prompt).toContain('UNCONFIRMED');
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM review_queue_item WHERE entity_type = 'generated_question_candidate' AND entity_id = ?`, [run.candidates[0]!.id])!.n).toBe(1);
  });

  it('once the owner confirms that diagnosis in the description, the same question may be published', async () => {
    const fig2 = byRegion(await list(), lecture.figure2);
    const res = await api(t).post(`/api/processing/figure-descriptions/${fig2.id}/review`, { decision: 'edit', content: { diagnosis: { text: 'Ulcerative colitis' } } });
    expect((res.json() as FigureDescriptionResponse).description.content?.diagnosis?.basis).toBe('owner');
    ai.on('generate_questions', (req) => ({ abstain: null, questions: [question(req.prompt, 'Ulcerative colitis')] }));
    const run = await generate({ lecture_source_id: lecture.sourceId, figure: { description_id: fig2.id }, count: 1, difficulty: 'medium' });
    expect(run.status).toBe('completed');
  });

  it('the answer-support check needs every significant word (no synonym is assumed)', () => {
    expect(answerSupportedBy('Adenocarcinoma', P.adeno)).toBe(true);
    expect(answerSupportedBy('Signet ring cell carcinoma', P.adeno)).toBe(false);
    expect(answerSupportedBy('Crohn disease', P.crohn)).toBe(true);
  });
});
