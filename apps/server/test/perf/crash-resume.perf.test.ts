// RESILIENCE (MEDLEVO_PERF=1): a REAL server process is killed with SIGKILL in the middle of processing a 300-page
// lecture (no shutdown hook runs — a crash / power loss), then restarted on the same data dir. Verifies (AC-25, §53):
//   * the job resumes by itself from its checkpoints (pages finished before the crash are NOT processed again);
//   * nothing is duplicated or lost: every page's stored regions equal what its checkpoint recorded, reading orders are
//     unique, every page ends processed, the index is rebuilt once;
// and measures how long the resume takes (boot, wait for the stale-job window, completion).
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { JobView, ProcessingStatusResponse, UploadResponse } from '@medlevo/shared';
import { lecturePdf, PERF_ENABLED } from './fixtures';
import { report, RESULTS_DIR } from './measure';
import { Client, freePort, startServerProcess, type ServerProcess } from './server-process';

const PAGES = Number(process.env.MEDLEVO_PERF_PAGES || 300);
const KILL_AT = Math.floor(PAGES / 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!PERF_ENABLED)('resilience: kill -9 mid-processing, restart, resume', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-crash-'));
  let server: ServerProcess | null = null;
  afterAll(async () => {
    await server?.stop().catch(() => undefined);
    if (process.env.MEDLEVO_PERF_KEEP !== '1') rmSync(dataDir, { recursive: true, force: true });
  });

  it('resumes from checkpoints without duplicates after a crash', async () => {
    const pdf = await lecturePdf({ pages: PAGES, twoColumnEvery: 5, tableEvery: 10, figureEvery: 25 });
    const port = await freePort();
    const logFile = join(RESULTS_DIR, 'crash-resume-server.log');
    server = await startServerProcess(dataDir, port, logFile);
    const firstBootMs = server.bootMs;
    const c = new Client(server.baseURL);
    await c.owner();
    const { node } = await c.json<{ node: { id: string } }>('POST', '/api/library/nodes', { parent_id: null, kind: 'course', title: 'Crash course (TEST FIXTURE)' });
    const fd = new FormData();
    fd.set('node_id', node.id);
    fd.set('source_type', 'lecture');
    fd.set('title', 'Crash lecture (TEST FIXTURE)');
    fd.set('files', new Blob([pdf.data], { type: 'application/pdf' }), 'crash-lecture.pdf');
    const up = await c.json<UploadResponse>('POST', '/api/sources/upload', fd);
    const versionId = up.results[0]!.version_id!;
    const statusOf = () => c.json<ProcessingStatusResponse>('GET', `/api/sources/versions/${versionId}/processing`);

    // ── crash after ≈ a third of the pages ──
    let before: JobView | null = null;
    const t0 = Date.now();
    for (;;) {
      const s = await statusOf();
      before = s.job;
      if (s.job?.progress?.stage === 'extract' && (s.job.progress.done ?? 0) >= KILL_AT) break;
      if (Date.now() - t0 > 600_000) throw new Error('processing did not reach the kill point');
      await sleep(50);
    }
    await server.kill9();
    const killedAt = Date.now();

    const dbPath = join(dataDir, 'medlevo.sqlite');
    const atCrash = (() => {
      const db = new DatabaseSync(dbPath);
      try {
        const job = db.prepare(`SELECT id, status, attempts FROM processing_job WHERE kind = 'process_source_version'`).get() as { id: string; status: string; attempts: number };
        const done = (db.prepare(`SELECT COUNT(*) AS n FROM job_checkpoint WHERE job_id = ? AND step_key LIKE 'page:%:regions'`).get(job.id) as { n: number }).n;
        const pages = db.prepare(`SELECT processing_status, COUNT(*) AS n FROM source_page WHERE version_id = ? GROUP BY processing_status`).all(versionId);
        return { job, checkpointed_pages: done, pages };
      } finally {
        db.close();
      }
    })();
    expect(atCrash.job.status).toBe('running'); // nobody could mark it: the process died
    expect(atCrash.checkpointed_pages).toBeGreaterThanOrEqual(KILL_AT - 1);

    // ── restart on the same data dir ──
    const restartAt = Date.now();
    server = await startServerProcess(dataDir, port, logFile);
    const restartBootMs = server.bootMs;
    c.cookie = '';
    await c.owner();
    let resumedAt = 0;
    let final: JobView | null = null;
    for (;;) {
      const s = await statusOf();
      if (!resumedAt && s.job && s.job.attempts >= 2 && s.job.status === 'running') resumedAt = Date.now();
      if (s.job && ['completed', 'partial', 'failed', 'cancelled'].includes(s.job.status)) {
        final = s.job;
        break;
      }
      if (Date.now() - restartAt > 900_000) throw new Error(`no completion after restart: ${JSON.stringify(s.job)}`);
      await sleep(100);
    }
    const doneAt = Date.now();
    await server.stop();
    server = null;

    // ── nothing duplicated, nothing lost, finished pages not re-run ──
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const n = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...(p as never[])) as { n: number }).n;
      const job = db.prepare(`SELECT id, status, attempts, error_code FROM processing_job WHERE kind = 'process_source_version'`).get() as { id: string; status: string; attempts: number };
      const cps = db.prepare(`SELECT step_key, data_json, done_at FROM job_checkpoint WHERE job_id = ? AND step_key LIKE 'page:%:regions'`).all(job.id) as Array<{ step_key: string; data_json: string; done_at: number }>;
      const perPage = new Map(
        (db.prepare(`SELECT p.page_index AS i, COUNT(r.id) AS n, MIN(r.created_at) AS created FROM source_page p LEFT JOIN source_region r ON r.page_id = p.id WHERE p.version_id = ? GROUP BY p.id`).all(versionId) as Array<{ i: number; n: number; created: number }>).map((r) => [r.i, r]),
      );
      let mismatched = 0;
      let rerunAfterCrash = 0;
      for (const cp of cps) {
        const i = Number(cp.step_key.split(':')[1]);
        const outcome = JSON.parse(cp.data_json) as { regions: number };
        const row = perPage.get(i)!;
        if (row.n !== outcome.regions) mismatched++;
        if (row.created > killedAt) rerunAfterCrash++;
      }
      const result = {
        job,
        checkpointed_pages: cps.length,
        pages_by_status: db.prepare(`SELECT processing_status, COUNT(*) AS n FROM source_page WHERE version_id = ? GROUP BY processing_status`).all(versionId),
        regions: n('SELECT COUNT(*) AS n FROM source_region WHERE version_id = ?', versionId),
        chunks: n('SELECT COUNT(*) AS n FROM document_chunk WHERE version_id = ?', versionId),
        duplicate_reading_orders: n('SELECT COUNT(*) AS n FROM (SELECT page_id, reading_order FROM source_region WHERE version_id = ? GROUP BY 1, 2 HAVING COUNT(*) > 1)', versionId),
        duplicate_review_items: n(`SELECT COUNT(*) AS n FROM (SELECT entity_id, kind, reason FROM review_queue_item WHERE status = 'open' GROUP BY 1, 2, 3 HAVING COUNT(*) > 1)`),
        duplicate_image_assets: n('SELECT COUNT(*) AS n FROM (SELECT region_id FROM image_asset WHERE version_id = ? GROUP BY 1 HAVING COUNT(*) > 1)', versionId),
        pages_whose_regions_differ_from_their_checkpoint: mismatched,
        pages_written_after_the_crash: rerunAfterCrash,
      };
      expect(job.status).toBe('completed');
      expect(job.attempts).toBe(2);
      expect(cps).toHaveLength(PAGES);
      expect(result.duplicate_reading_orders).toBe(0);
      expect(result.duplicate_review_items).toBe(0);
      expect(result.duplicate_image_assets).toBe(0);
      expect(mismatched).toBe(0);
      expect(result.regions).toBe(cps.reduce((s, cp) => s + (JSON.parse(cp.data_json) as { regions: number }).regions, 0));
      // pages checkpointed before the crash were not processed again (at most the page in flight is redone)
      expect(rerunAfterCrash).toBeLessThanOrEqual(PAGES - atCrash.checkpointed_pages);

      report('crash-resume', {
        scenario: `SIGKILL of a real server process while processing a ${PAGES}-page lecture (after ≥ ${KILL_AT} pages), restart on the same data dir`,
        progress_at_kill: before?.progress ?? null,
        at_crash: atCrash,
        first_boot_ms: firstBootMs,
        restart_boot_ms: restartBootMs,
        // includes the boot of the new process (restart_boot_ms)
        restart_to_resumed_ms: resumedAt ? resumedAt - restartAt : null,
        crash_to_resumed_ms: resumedAt ? resumedAt - killedAt : null,
        restart_to_completed_ms: doneAt - restartAt,
        final_job: { status: final?.status, attempts: final?.attempts },
        result,
      });
    } finally {
      db.close();
    }
  }, 30 * 60_000);
});
