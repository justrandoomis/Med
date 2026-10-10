// Processing overview (§48, §53, AC-03), retry / cancel through the jobs API, AI usage summaries labelled as
// ESTIMATES (§51, §56), storage measured from the data directory, sources & priorities, audit history in words,
// and the calm overview. Real pipeline, real job queue; the AI calls go through the orchestrator with the
// test-only FakeAiProvider.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ControlOverviewResponse, IntelligenceResponse, ProcessingOverviewResponse, SourcesPrioritiesResponse, StorageResponse } from '@medlevo/shared';
import { JobError } from '../../src/lib/errors';
import { newId } from '../../src/lib/ids';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { FakeAiProvider } from '../helpers/fake-ai';
import { addSource, processVersion } from '../processing/helpers';
import { api, createControlApp, type Api } from './helpers';

describe('processing overview, retry and cancel', () => {
  let t: TestApp;
  let h: AuthHeaders;
  let a: Api;
  let failOn: number | null = 1;
  let flaky = 0;
  beforeAll(async () => {
    t = await createControlApp({
      processing: {
        tools: { pdftoppm: null, soffice: null },
        ocr: false,
        hooks: {
          beforePage: (i) => {
            if (i === failOn) throw new Error('simulated parser crash on this page');
          },
        },
      },
    });
    // a test-only job kind whose failures the owner can retry
    t.ctx.jobs.register<{ n: number }, { ok: true }>('test_flaky', {
      version: '1',
      maxAttempts: 1,
      handler: async () => {
        flaky++;
        if (flaky === 1) throw new JobError('TEST_FAIL', 'فشل تجريبي محدد: الملف المؤقت غير موجود.', { retryable: false });
        return { ok: true };
      },
    });
    h = await t.login();
    a = api(t, h);
  }, 60_000);
  afterAll(async () => t?.close());

  it('shows the partial version page by page with the specific reason and what the gap means (AC-03)', async () => {
    const s = await addSource(t, 'lecture_appendicitis.pdf', 'pdf', { sourceType: 'lecture', title: 'Partial (TEST FIXTURE)' });
    const job = await processVersion(t, s.versionId);
    expect(job.status).toBe('partial');
    const r = await a.get<ProcessingOverviewResponse>('/api/control/processing');
    expect(r.status).toBe(200);
    const v = r.body.attention.find((x) => x.version_id === s.versionId)!;
    expect(v).toMatchObject({ processing_status: 'partial', is_active: true, source_title: 'Partial (TEST FIXTURE)' });
    expect(v.pages).toEqual([expect.objectContaining({ page_index: 1, label_ar: 'ص 12 (الصفحة 2 في الملف)', error_code: 'PAGE_PROCESSING_FAILED', owner_corrected: false })]);
    expect(v.pages[0]!.reason_ar).toMatch(/بقية الصفحات لم تتأثر/);
    expect(v.coverage_note_ar).toContain('التغطية غير كاملة');
    expect(v.summary!.coverage_complete).toBe(false);
    const recent = r.body.recent.find((j) => j.id === job.id)!;
    expect(recent).toMatchObject({ kind_label_ar: 'معالجة مصدر', status: 'partial', status_label_ar: 'اكتمل جزئيًا', can_retry: true, can_cancel: false });
    expect(recent.source).toMatchObject({ id: s.sourceId, version_id: s.versionId, version_no: 1 });
    expect(recent.retry_effect_ar).toContain('لا تُكرَّر');
    expect(recent.progress_label_ar ?? '').not.toMatch(/%/);
    expect(r.body.counts.partial).toBeGreaterThanOrEqual(1);
    // the failed page is re-processed alone through the sources API → the version becomes complete
    failOn = null;
    const re = await a.post(`/api/sources/versions/${s.versionId}/reprocess`, { page_indexes: [1] });
    expect(re.status).toBe(200);
    await t.ctx.jobs.drain();
    const after = await a.get<ProcessingOverviewResponse>('/api/control/processing');
    expect(after.body.attention.find((x) => x.version_id === s.versionId && x.processing_status === 'partial')).toBeUndefined();
  }, 60_000);

  it('a failed job explains why; retry through the jobs API resumes it; cancel stops a queued one without deleting anything', async () => {
    const j = t.ctx.jobs.enqueue('test_flaky', { n: 1 });
    await t.ctx.jobs.drain();
    let r = await a.get<ProcessingOverviewResponse>('/api/control/processing');
    const failed = r.body.recent.find((x) => x.id === j.id)!;
    expect(failed).toMatchObject({ status: 'failed', status_label_ar: 'فشل', can_retry: true, error: { code: 'TEST_FAIL', message: 'فشل تجريبي محدد: الملف المؤقت غير موجود.' } });
    expect(r.body.counts.failed).toBeGreaterThanOrEqual(1);
    expect((await a.post(`/api/jobs/${j.id}/retry`)).status).toBe(200);
    await t.ctx.jobs.drain();
    r = await a.get<ProcessingOverviewResponse>('/api/control/processing');
    expect(r.body.recent.find((x) => x.id === j.id)!.status).toBe('completed');

    const q = t.ctx.jobs.enqueue('test_flaky', { n: 2 }, { runAfter: t.ctx.clock.now() + 3_600_000 });
    r = await a.get<ProcessingOverviewResponse>('/api/control/processing');
    const queued = r.body.active.find((x) => x.id === q.id)!;
    expect(queued).toMatchObject({ status: 'queued', can_cancel: true });
    expect(queued.cancel_effect_ar).toContain('لا يُحذف شيء');
    expect((await a.post(`/api/jobs/${q.id}/cancel`)).status).toBe(200);
    r = await a.get<ProcessingOverviewResponse>('/api/control/processing');
    expect(r.body.active.find((x) => x.id === q.id)).toBeUndefined();
    expect(r.body.recent.find((x) => x.id === q.id)!.status).toBe('cancelled');
    // both owner actions are in the history, in words
    const hist = await a.get(`/api/control/history?entity_type=processing_job`);
    expect(hist.body.entries.map((e: { action_label_ar: string }) => e.action_label_ar)).toEqual(expect.arrayContaining(['إلغاء', 'إعادة محاولة']));
  });

  it('a job kind no module handles is explained, never shown as working', async () => {
    const orphan = t.ctx.db.run(
      `INSERT INTO processing_job (id, kind, status, input_json, version, created_at, run_after) VALUES (?, 'unknown_kind', 'queued', '{}', '1', ?, 0)`,
      [newId(t.ctx.clock.now()), t.ctx.clock.now()],
    );
    expect(orphan.changes).toBe(1);
    const r = await a.get<ProcessingOverviewResponse>('/api/control/processing');
    const j = r.body.active.find((x) => x.kind === 'unknown_kind')!;
    expect(j.explanation_ar).toContain('لا توجد وحدة');
    expect(j.can_retry).toBe(false);
  });
});

describe('intelligence: AI status, budget and usage labelled as estimates', () => {
  let t: TestApp;
  let a: Api;
  beforeAll(async () => {
    t = await createControlApp({ ai: new FakeAiProvider({ steps: [{ json: { ok: true } }, { json: { ok: true } }], usage: { inputTokens: 2000, outputTokens: 1000 } }) });
    a = api(t, await t.login());
  }, 60_000);
  afterAll(async () => t?.close());

  it('groups real usage records by month (owner timezone), task and model; costs are estimates', async () => {
    const scope = { mode: 'lecture_only' as const, sourceIds: [], versionIds: [], hash: 'h', describeAr: 'اختبار', includeMyNotes: false, allowExternal: false, versionBySource: {} };
    for (const task of ['explain', 'study_book'] as const) {
      await t.ctx.ai.generateStructured({ task, schema: z.object({ ok: z.boolean() }), system: 'test', input: 'test', scope: scope as never, sourceVersionIds: [] });
    }
    // one record from the previous month (owner timezone Asia/Baghdad), written as the orchestrator writes them
    t.ctx.db.run(
      `INSERT INTO usage_record (id, task, provider, model, input_tokens, output_tokens, estimated_cost_usd, latency_ms, status, created_at) VALUES (?, 'chat', 'fake', 'fake-model-1', 100, 50, 0.5, 10, 'error', ?)`,
      [newId(), Date.UTC(2026, 8, 20, 12)],
    );
    const r = await a.get<IntelligenceResponse>('/api/control/intelligence');
    expect(r.status).toBe(200);
    expect(r.body.ai.configured).toBe(true);
    expect(r.body.usage.estimated).toBe(true);
    expect(r.body.usage.note_ar).toContain('تقديرية');
    const [oct, sep] = r.body.usage.months;
    expect(oct!.month).toBe('2026-10');
    expect(oct!.calls).toBe(2);
    expect(oct!.ok).toBe(2);
    expect(oct!.input_tokens).toBe(4000);
    expect(oct!.estimated_cost_usd).toBeCloseTo(2 * (2000 * 3 + 1000 * 15) / 1e6, 6);
    expect(oct!.by_task.map((b) => b.key).sort()).toEqual(['explain', 'study_book']);
    expect(oct!.by_task.find((b) => b.key === 'explain')!.label_ar).toBe('الشرح من المصدر');
    expect(oct!.by_model).toEqual([expect.objectContaining({ key: 'fake-model-1', calls: 2 })]);
    expect(sep).toMatchObject({ month: '2026-09', calls: 1, errors: 1, estimated_cost_usd: 0.5 });
    expect(r.body.usage.months).toHaveLength(6);
    expect(r.body.ai.budget.estimated).toBe(true);
    expect(r.body.roles.find((x) => x.role === 'generation')).toMatchObject({ model: 'fake-model-1', env_var: 'MEDLEVO_MODEL_GENERATION' });
    expect(r.body.rules.explanation_level).toBe('medium');
  });

  it('without a provider: requires configuration with the reason; nothing pretends to work', async () => {
    const t2 = await createControlApp();
    try {
      const r = await api(t2, await t2.login()).get<IntelligenceResponse>('/api/control/intelligence');
      expect(r.body.ai.configured).toBe(false);
      expect(r.body.ai.tasks.explain).toMatchObject({ available: false });
      expect(r.body.ai.tasks.explain.reason_ar).toContain('ANTHROPIC_API_KEY');
      expect(r.body.roles.every((x) => x.model === null)).toBe(true);
      expect(r.body.notes_ar[0]).toContain('ANTHROPIC_API_KEY');
      expect(r.body.usage.months[0]!.calls).toBe(0);
    } finally {
      await t2.close();
    }
  });
});

describe('storage, sources & priorities, history, overview', () => {
  let t: TestApp;
  let a: Api;
  let lecture: { sourceId: string; versionId: string };
  beforeAll(async () => {
    t = await createControlApp();
    a = api(t, await t.login());
    lecture = await addSource(t, 'lecture_appendicitis.pdf', 'pdf', { sourceType: 'lecture', title: 'Lecture (TEST FIXTURE)' });
    const ref = await addSource(t, 'lecture_cholecystitis.pdf', 'pdf', { sourceType: 'course_reference', title: 'Reference (TEST FIXTURE)' });
    await processVersion(t, lecture.versionId);
    await processVersion(t, ref.versionId);
    await t.ctx.jobs.drain();
    t.ctx.db.run(`INSERT INTO source_link (id, from_source_id, to_source_id, relation, created_at) VALUES (?, ?, ?, 'reference_for', ?)`, [newId(), ref.sourceId, lecture.sourceId, t.ctx.clock.now()]);
  }, 60_000);
  afterAll(async () => t?.close());

  it('measures the data directory by category', async () => {
    const r = await a.get<StorageResponse>('/api/control/storage');
    expect(r.status).toBe(200);
    expect(r.body.database.bytes).toBeGreaterThan(0);
    const src = r.body.files.categories.find((c) => c.key === 'source_files')!;
    expect(src.files).toBe(2);
    const sizes = t.ctx.db.get<{ s: number }>(`SELECT SUM(size) AS s FROM stored_file WHERE id IN (SELECT file_id FROM source_version)`)!.s;
    expect(src.bytes).toBe(sizes);
    expect(r.body.backups).toEqual({ count: 0, bytes: 0 });
    expect(r.body.total_bytes).toBeGreaterThanOrEqual(r.body.database.bytes + r.body.files.bytes);
    expect(r.body.notes_ar[0]).toContain('مقيسة');
  });

  it('lists per-task priorities from the settings and each source with its selection reason and links', async () => {
    const patched = await t.app.inject({ method: 'PATCH', url: `/api/sources/${lecture.sourceId}`, headers: { cookie: (await t.login()).cookie, 'x-medlevo-csrf': '1' }, payload: { priority: 10, selection_reason: 'محاضرة الدكتور الأساسية' } });
    expect(patched.statusCode).toBe(200);
    const r = await a.get<SourcesPrioritiesResponse>('/api/control/sources');
    expect(r.body.purposes.map((p) => p.purpose)).toEqual(['lecture_explanation', 'source_question_practice', 'clinical_expansion']);
    expect(r.body.purposes[0]!.order).toEqual(t.ctx.settings.get().source_priority.lecture_explanation);
    const lec = r.body.sources.find((s) => s.id === lecture.sourceId)!;
    expect(lec).toMatchObject({ priority: 10, selection_reason: 'محاضرة الدكتور الأساسية', source_type_label_ar: 'محاضرة' });
    const ref = r.body.sources.find((s) => s.title === 'Reference (TEST FIXTURE)')!;
    expect(ref.reference_for).toEqual(['Lecture (TEST FIXTURE)']);
    expect(r.body.notes_ar.join(' ')).toContain('لا تقرر من «يفوز»');
  });

  it('shows the audit history in words with before → after facts and filters by entity type', async () => {
    const r = await a.get('/api/control/history?entity_type=source');
    expect(r.status).toBe(200);
    const e = r.body.entries.find((x: { entity_id: string; action: string }) => x.entity_id === lecture.sourceId && x.action === 'update');
    expect(e).toMatchObject({ entity_label_ar: 'مصدر', action_label_ar: 'تعديل', actor_label_ar: 'أنت', link: { href: `/sources/${lecture.sourceId}` } });
    expect(e.changes).toEqual(expect.arrayContaining([{ label: 'الأولوية', before: '0', after: '10' }]));
    expect(r.body.entity_types.find((x: { value: string }) => x.value === 'source').label_ar).toBe('مصدر');
    expect((await a.get('/api/control/history?limit=0')).status).toBe(400);
  });

  it('overview: one line of real state per section', async () => {
    const r = await a.get<ControlOverviewResponse>('/api/control/overview');
    expect(r.status).toBe(200);
    expect(r.body.review.open).toBe(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM review_queue_item WHERE status = 'open'`)!.n);
    expect(r.body.ai).toMatchObject({ configured: false, estimated: true });
    expect(r.body.processing.active).toBe(0);
  });
});
