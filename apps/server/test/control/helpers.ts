// Control Center test helpers: Golden Set sources processed by the REAL pipeline (without OCR tools, so scanned
// pages honestly become «unreadable» review items), plus small builders for rows owned by other tracks that the
// tests need as dependents (artifacts made under known rules).
import { newId } from '../../src/lib/ids';
import type { AiProvider } from '../../src/modules/ai/types';
import { MODULES } from '../../src/modules';
import { createProcessingModule, type ProcessingModuleOptions } from '../../src/modules/processing';
import { recordDependencies } from '../../src/modules/evidence/services';
import { resolveRules } from '../../src/modules/studybook/rules';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';
import { addSource, processVersion, type AddedSource } from '../processing/helpers';

export async function createControlApp(opts: { ai?: AiProvider | null; processing?: ProcessingModuleOptions } = {}): Promise<TestApp> {
  return createTestApp({
    ai: opts.ai ?? null,
    modules: MODULES.map((m) => (m.name === 'processing' ? { ...m, plugin: createProcessingModule(opts.processing ?? { tools: { pdftoppm: null, soffice: null }, ocr: false }) } : m)),
    jobs: { backoffBaseMs: 0, backoffMaxMs: 0 },
  });
}

export async function processed(t: TestApp, fixture: string, sourceType = 'lecture', title?: string): Promise<AddedSource> {
  const s = await addSource(t, fixture, 'pdf', { sourceType, title: title ?? `TEST FIXTURE ${fixture}` });
  const job = await processVersion(t, s.versionId);
  if (job.status !== 'completed' && job.status !== 'partial') throw new Error(`processing failed: ${job.status}`);
  await t.ctx.jobs.drain();
  return s;
}

export interface Api {
  get<T = any>(url: string): Promise<{ status: number; body: T }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  post<T = any>(url: string, payload?: unknown): Promise<{ status: number; body: T }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function api(t: TestApp, h: AuthHeaders): Api {
  return {
    async get(url) {
      const r = await t.app.inject({ method: 'GET', url, headers: h });
      return { status: r.statusCode, body: r.json() };
    },
    async post(url, payload) {
      const r = await t.app.inject({ method: 'POST', url, headers: h, payload: (payload ?? {}) as object });
      return { status: r.statusCode, body: r.json() };
    },
  };
}

/** A published artifact made under the CURRENT effective rules of its source (its rules_version is real). */
export function insertArtifactWithRules(
  t: TestApp,
  opts: { sourceId: string; kind?: string; params?: Record<string, unknown>; overrides?: Record<string, unknown>; model?: string | null; versionIds?: string[]; regionIds?: string[]; title?: string; frozen?: boolean },
): string {
  const rules = resolveRules(t.ctx, { sourceId: opts.sourceId, overrides: (opts.overrides ?? null) as never });
  const id = newId(t.ctx.clock.now());
  const now = t.ctx.clock.now();
  const params = { level: rules.level, dialect: rules.dialect, template: rules.template, ...(opts.params ?? {}) };
  const scope = { mode: 'lecture_only', version_ids: opts.versionIds ?? [], source_ids: [opts.sourceId] };
  t.ctx.db.run(
    `INSERT INTO artifact (id, lineage_id, version_no, kind, title, primary_source_id, scope_json, params_json, cache_key, rules_version, generator_version, verifier_version, model, status, is_frozen, created_at, published_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'g', 'v', ?, 'published', ?, ?, ?, ?)`,
    [id, id, opts.kind ?? 'explanation', opts.title ?? 'شرح اختبار (TEST)', opts.sourceId, JSON.stringify(scope), JSON.stringify(params), `key-${id}`, rules.rules_version, opts.model === undefined ? 'fake-model-1' : opts.model, opts.frozen ? 1 : 0, now, now, now],
  );
  if (opts.versionIds?.length || opts.regionIds?.length) recordDependencies(t.ctx, 'artifact', id, opts.versionIds ?? [], opts.regionIds ?? []);
  return id;
}

export function openItems(t: TestApp, kind?: string): Array<{ id: string; kind: string; entity_type: string; entity_id: string; source_id: string | null }> {
  return t.ctx.db.all(
    `SELECT id, kind, entity_type, entity_id, source_id FROM review_queue_item WHERE status = 'open' ${kind ? 'AND kind = ?' : ''} ORDER BY created_at, id`,
    kind ? [kind] : [],
  );
}
