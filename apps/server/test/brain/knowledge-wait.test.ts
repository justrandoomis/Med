// Production regression (robustness pass): extract_knowledge jobs failed with CONFLICT «لم تكتمل معالجة هذه النسخة
// بعد…» when they were claimed while their source version was still pending / processing (right after uploads, and
// after a restart re-processed a version). A version that is not processed yet is «not ready yet»: the job waits and
// looks again later (a deferral — no attempt spent), extracts once processing completes, and gives up only when
// processing ended failed. Synthetic TEST lecture rows, no AI.
import { EXTRACT_KNOWLEDGE_JOB_KIND } from '@medlevo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KNOWLEDGE_WAIT_FIRST_MS, KNOWLEDGE_WAIT_MAX_MS } from '../../src/modules/brain/run';
import { brainApp, createCourse, insertLecture, type BApp } from './helpers';

let t: BApp;
beforeEach(async () => {
  t = await brainApp();
});
afterEach(async () => {
  await t.close();
});

const PAGES = [[{ kind: 'heading', text: 'Sepsis' }, { kind: 'paragraph', text: 'Sepsis is defined as a TEST response to infection.' }]];

async function lectureIn(status: string): Promise<string> {
  const course = (await createCourse(t, 'Wait course (TEST)')).id;
  const l = insertLecture(t, course, 'W1 (TEST)', PAGES);
  t.ctx.db.run('UPDATE source_version SET processing_status = ? WHERE id = ?', [status, l.versionId]);
  return l.versionId;
}

describe('extract_knowledge waits for its version to be processed', () => {
  it('a job claimed while the version is processing is re-queued without spending an attempt, then succeeds', async () => {
    const versionId = await lectureIn('processing');
    const job = t.ctx.jobs.enqueue(EXTRACT_KNOWLEDGE_JOB_KIND, { version_id: versionId });

    await t.ctx.jobs.drain();
    let j = t.ctx.jobs.get(job.id)!;
    expect(j).toMatchObject({ status: 'queued', attempts: 0, error: { code: 'VERSION_NOT_PROCESSED', retryable: true } });
    expect(j.run_after).toBe(t.clock.now() + KNOWLEDGE_WAIT_FIRST_MS);

    // still processing at the next look: waits again, longer — still no attempt spent (maxAttempts 2 would be gone)
    t.clock.advance(KNOWLEDGE_WAIT_FIRST_MS);
    await t.ctx.jobs.drain();
    j = t.ctx.jobs.get(job.id)!;
    expect(j).toMatchObject({ status: 'queued', attempts: 0 });
    expect(j.run_after).toBe(t.clock.now() + 2 * KNOWLEDGE_WAIT_FIRST_MS);
    t.clock.advance(2 * KNOWLEDGE_WAIT_FIRST_MS);
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(job.id)).toMatchObject({ status: 'queued', attempts: 0 });

    // processing completes → the next look extracts
    t.ctx.db.run(`UPDATE source_version SET processing_status = 'ready' WHERE id = ?`, [versionId]);
    t.clock.advance(KNOWLEDGE_WAIT_MAX_MS);
    await t.ctx.jobs.drain();
    j = t.ctx.jobs.get(job.id)!;
    expect(j).toMatchObject({ status: 'completed', attempts: 1, error: null });
    expect(t.ctx.db.get('SELECT 1 AS x FROM concept_extraction WHERE version_id = ?', [versionId])).toBeTruthy();
  });

  it('a pending version waits too; the delay grows but never beyond the cap', async () => {
    const versionId = await lectureIn('pending');
    const job = t.ctx.jobs.enqueue(EXTRACT_KNOWLEDGE_JOB_KIND, { version_id: versionId });
    for (let i = 0; i < 8; i++) {
      await t.ctx.jobs.drain();
      const j = t.ctx.jobs.get(job.id)!;
      expect(j.status).toBe('queued');
      expect(j.run_after - t.clock.now()).toBe(Math.min(KNOWLEDGE_WAIT_FIRST_MS * 2 ** i, KNOWLEDGE_WAIT_MAX_MS));
      t.clock.advance(j.run_after - t.clock.now());
    }
    expect(t.ctx.db.get<{ deferrals: number; attempts: number }>('SELECT deferrals, attempts FROM processing_job WHERE id = ?', [job.id])).toEqual({ deferrals: 8, attempts: 0 });
  });

  it('gives up (not retryable) when processing ended failed', async () => {
    const versionId = await lectureIn('failed');
    const job = t.ctx.jobs.enqueue(EXTRACT_KNOWLEDGE_JOB_KIND, { version_id: versionId });
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(job.id)).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'VERSION_PROCESSING_FAILED', retryable: false } });
  });

  it('a version that keeps processing for ever stops waiting after the deferral cap', async () => {
    const versionId = await lectureIn('processing');
    const job = t.ctx.jobs.enqueue(EXTRACT_KNOWLEDGE_JOB_KIND, { version_id: versionId });
    t.ctx.db.run('UPDATE processing_job SET deferrals = 60 WHERE id = ?', [job.id]); // KNOWLEDGE_MAX_DEFERRALS reached
    for (let i = 0; i < 3; i++) {
      await t.ctx.jobs.drain();
      t.clock.advance(KNOWLEDGE_WAIT_MAX_MS);
    }
    expect(t.ctx.jobs.get(job.id)).toMatchObject({ status: 'failed', attempts: 2, error: { code: 'VERSION_NOT_PROCESSED' } });
  });
});
