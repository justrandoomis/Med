// The evaluation harness (§57): a throwaway MedLevo server (own temporary data directory, own database, the real
// modules) into which the TEST FIXTURE files are uploaded through the real API and processed by the real pipeline.
// The owner's library is never touched: fixtures are never shown as study material (fixtures/golden/README.md).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PROCESS_JOB_KIND, SESSION_COOKIE_NAME, type EvalMode, type EvalSystemFingerprint } from '@medlevo/shared';
import { buildApp } from '../../../app';
import { REPO_ROOT, loadConfig } from '../../../config';
import type { AppContext } from '../../../context';
import { AI_RULES_VERSION } from '../../ai/orchestrator';
import { VERIFIER_VERSION } from '../../evidence/claims';
import { INDEX_VERSION } from '../../processing/chunks';
import { PIPELINE_VERSION } from '../../processing/pipeline';
import { MATCHER_VERSION } from '../../questions/match';
import { PARSER_VERSION } from '../../questions/parser';
import { GENERATOR_VERSION as STUDYBOOK_GENERATOR_VERSION } from '../../studybook/rules';
import { SOURCES, type SourceKey } from './catalogue';
import { EvalScriptedProvider } from './scripted';

export interface LoadedSource {
  sourceId: string;
  versionId: string;
  /** terminal job state of the processing ('completed' | 'partial' | …) */
  processing: string;
  /** set when the upload / processing failed: dependent cases are reported as evaluation errors with this reason */
  error: string | null;
}

export interface EvalHarness {
  app: FastifyInstance;
  ctx: AppContext;
  mode: EvalMode;
  /** cookie + CSRF headers of the evaluation owner */
  headers: Record<string, string>;
  provider: EvalScriptedProvider | null;
  sources: Map<SourceKey, LoadedSource>;
  dataDir: string;
  /** null when the mode can run here; otherwise why AI axes cannot (live mode without a key) */
  aiBlockedReasonAr: string | null;
  inject(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; json: unknown; body: string }>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  mode: EvalMode;
  /** repository root (fixtures/ lives there) */
  repoRoot?: string;
  /** progress lines (CLI) */
  log?: (line: string) => void;
}

const OWNER = { username: 'evaluation', password: 'evaluation-only-password-1' };

function multipart(fields: Record<string, string>, file: { name: string; data: Buffer; contentType: string }): { payload: Buffer; contentType: string } {
  const boundary = `----medlevoeval${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`, 'utf8'));
  chunks.push(file.data, Buffer.from('\r\n'), Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export async function createHarness(opts: HarnessOptions): Promise<EvalHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-eval-'));
  const log = opts.log ?? (() => undefined);
  const liveKey = process.env.ANTHROPIC_API_KEY?.trim() || '';
  // isolated env: nothing of the owner's .env (data dir, origin) reaches this server; the key only in live mode
  const env: Record<string, string> = {
    NODE_ENV: 'development',
    MEDLEVO_DATA_DIR: dataDir,
    MEDLEVO_ORIGIN: 'http://localhost:5173',
    MEDLEVO_LOG_LEVEL: 'silent',
    MEDLEVO_SCRYPT_LOG_N: '12',
    MEDLEVO_AI_MONTHLY_BUDGET_USD: opts.mode === 'live' ? (process.env.MEDLEVO_AI_MONTHLY_BUDGET_USD ?? '20') : '20',
    ANTHROPIC_API_KEY: opts.mode === 'live' ? liveKey : '',
  };
  if (opts.mode === 'live') {
    for (const k of ['MEDLEVO_MODEL_GENERATION', 'MEDLEVO_MODEL_VERIFICATION', 'MEDLEVO_MODEL_VISION'] as const) {
      const v = process.env[k]?.trim();
      if (v) env[k] = v;
    }
  }
  const config = loadConfig(env);
  const provider = opts.mode === 'scripted' ? new EvalScriptedProvider() : null;
  const app = await buildApp({
    config,
    // scripted: the evaluation-only provider; live: whatever the configuration gives (null without a key)
    overrides: { aiProvider: opts.mode === 'scripted' ? provider : undefined, jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } },
  });
  await app.ready();
  const ctx = app.ctx;

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-medlevo-csrf': '1', 'user-agent': 'medlevo-eval' },
    payload: { ...OWNER, ...(process.env.MEDLEVO_SETUP_TOKEN ? { setup_token: process.env.MEDLEVO_SETUP_TOKEN } : {}) },
  });
  if (setup.statusCode !== 200) {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`evaluation server: owner setup failed (${setup.statusCode})`);
  }
  const raw = setup.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? '']).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))?.split(';')[0] ?? '';
  const headers = { cookie, 'x-medlevo-csrf': '1', 'user-agent': 'medlevo-eval' };

  const inject: EvalHarness['inject'] = async (method, url, payload) => {
    const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as never }) });
    let json: unknown = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, body: res.body };
  };

  const aiBlockedReasonAr =
    opts.mode === 'live' && !ctx.ai.configured
      ? 'التقييم بنموذج حقيقي (live) يحتاج مزود ذكاء اصطناعي مضبوطًا على الخادم (ANTHROPIC_API_KEY)، وهو غير مضبوط هنا؛ محاور الذكاء الاصطناعي لم تُشغَّل.'
      : null;

  return {
    app,
    ctx,
    mode: opts.mode,
    headers,
    provider,
    sources: new Map(),
    dataDir,
    aiBlockedReasonAr,
    inject,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
      log(`removed the evaluation data directory ${dataDir}`);
    },
  };
}

/** Upload (or quick-add) every needed fixture through the real API, in catalogue order, and run all jobs. */
export async function loadSources(h: EvalHarness, keys: SourceKey[], opts: { repoRoot?: string; log?: (line: string) => void } = {}): Promise<void> {
  const root = opts.repoRoot ?? REPO_ROOT;
  const log = opts.log ?? (() => undefined);
  const courses = new Map<string, string>();
  const nodeFor = async (course: string): Promise<string> => {
    const have = courses.get(course);
    if (have) return have;
    const r = await h.inject('POST', '/api/library/nodes', { parent_id: null, kind: 'course', title: `Evaluation ${course} (TEST FIXTURE)` });
    if (r.status !== 200) throw new Error(`evaluation: creating a course failed (${r.status})`);
    const id = (r.json as { node: { id: string } }).node.id;
    courses.set(course, id);
    return id;
  };
  for (const key of keys) {
    const def = SOURCES[key];
    const started = Date.now();
    const name = def.file.split('/').pop()!;
    let loaded: LoadedSource;
    try {
      const data = readFileSync(join(root, 'fixtures', def.file));
      const nodeId = await nodeFor(def.course);
      const ext = name.split('.').pop()!.toLowerCase();
      const body = def.quickAdd
        ? multipart({ node_id: nodeId, title: def.title }, { name, data, contentType: MIME[ext] ?? 'application/octet-stream' })
        : multipart({ node_id: nodeId, source_type: def.sourceType, title: def.title, on_duplicate: 'create' }, { name, data, contentType: MIME[ext] ?? 'application/octet-stream' });
      const res = await h.app.inject({
        method: 'POST',
        url: def.quickAdd ? '/api/questions/quick-add' : '/api/sources/upload',
        headers: { ...h.headers, 'content-type': body.contentType },
        payload: body.payload,
      });
      if (res.statusCode !== 200) throw new Error(`upload refused (${res.statusCode})`);
      const json = res.json() as { results?: Array<{ status: string; source_id?: string; version_id?: string }>; source_id?: string; version_id?: string };
      const r = def.quickAdd ? { status: 'accepted', source_id: json.source_id, version_id: json.version_id } : json.results?.[0];
      if (!r || r.status !== 'accepted' || !r.source_id || !r.version_id) throw new Error(`upload not accepted (${r?.status ?? 'no result'})`);
      await h.ctx.jobs.drain();
      const job = h.ctx.db.get<{ status: string }>(`SELECT status FROM processing_job WHERE kind = ? AND input_json LIKE ? ORDER BY created_at DESC LIMIT 1`, [PROCESS_JOB_KIND, `%${r.version_id}%`]);
      const version = h.ctx.db.get<{ processing_status: string }>('SELECT processing_status FROM source_version WHERE id = ?', [r.version_id]);
      const state = job?.status ?? version?.processing_status ?? 'unknown';
      loaded = { sourceId: r.source_id, versionId: r.version_id, processing: state, error: state === 'failed' || state === 'cancelled' ? `processing ${state}` : null };
    } catch (e) {
      loaded = { sourceId: '', versionId: '', processing: 'failed', error: (e as Error).message };
    }
    h.sources.set(key, loaded);
    log(`  ${def.file} → ${loaded.error ? `ERROR ${loaded.error}` : loaded.processing} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  }
}

function pkgVersion(root: string, name: string): string {
  for (const base of [join(root, 'node_modules'), join(root, 'apps', 'server', 'node_modules')]) {
    try {
      return (JSON.parse(readFileSync(join(base, name, 'package.json'), 'utf8')) as { version: string }).version;
    } catch {
      // try the next location
    }
  }
  return 'unknown';
}

/** Every version a result depends on — the basis of compare-and-rollback (docs/EVALUATION.md). */
export function systemFingerprint(ctx: AppContext, mode: EvalMode, repoRoot = REPO_ROOT): EvalSystemFingerprint {
  let commit: string | null = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim() || null;
  } catch {
    commit = null;
  }
  const st = ctx.ai.status();
  return {
    app_version: ctx.config.appVersion,
    git_commit: commit,
    node: process.version,
    versions: {
      pipeline: PIPELINE_VERSION,
      index: INDEX_VERSION,
      question_parser: PARSER_VERSION,
      question_matcher: MATCHER_VERSION,
      ai_rules: AI_RULES_VERSION,
      studybook_generator: STUDYBOOK_GENERATOR_VERSION,
      claim_verifier: VERIFIER_VERSION,
      'ocr.tesseract.js': pkgVersion(repoRoot, 'tesseract.js'),
      'ocr.data.eng': pkgVersion(repoRoot, '@tesseract.js-data/eng'),
      'ocr.data.ara': pkgVersion(repoRoot, '@tesseract.js-data/ara'),
      'pdf.pdfjs-dist': pkgVersion(repoRoot, 'pdfjs-dist'),
    },
    models:
      mode === 'live' && st.configured
        ? Object.fromEntries((['explain', 'verify_support', 'vision_figure'] as const).map((t) => [t, st.tasks[t]?.model ?? null]))
        : null,
  };
}
