// TEST TOOLING ONLY — never imported by src/ and never used in production.
// Boots the REAL app (database, processing pipeline, evidence module, jobs, Study Book) with a deterministic,
// clearly fake AI provider so a browser check can look at generated content without an API key. The "generator"
// copies the FIRST SENTENCE of each evidence excerpt it was handed, verbatim, as a directly-stated claim citing that
// alias (so the server's real validation links it); the "verifier" answers «supported». It writes no medicine of
// its own. Usage: node --import tsx apps/server/test/studybook/browser-server.ts (env as for src/index.ts).
import { mkdirSync } from 'node:fs';
import type { AiTask } from '@medlevo/shared';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { openDb } from '../../src/db/db';
import { migrate } from '../../src/db/migrate';
import type { AiProvider, ProviderRequest, ProviderResponse, ProviderUsage } from '../../src/modules/ai/types';

function claimsIn(prompt: string): Array<{ index: number }> {
  const out: Array<{ index: number }> = [];
  const re = /CLAIM \[(\d+)\]: /g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) out.push({ index: Number(m[1]) });
  return out;
}

function evidenceIn(prompt: string): Array<{ alias: string; region?: string; text: string }> {
  const out: Array<{ alias: string; region?: string; text: string }> = [];
  const re = /\n\[(E\d+)\](?: \[(R\d+)\])?\n([\s\S]*?)\n<\/untrusted_content/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) out.push({ alias: m[1]!, region: m[2], text: m[3]! });
  return out;
}

/** first sentence of an excerpt, verbatim (a substring of the quote) */
function firstSentence(text: string): string {
  const t = text.trim();
  const m = /^[\s\S]{12,260}?[.!?؟](?=\s|$)/.exec(t);
  return (m ? m[0] : t.slice(0, 200)).trim();
}

class GroundedFakeAi implements AiProvider {
  readonly name = 'fake-test-only';
  supports(task: AiTask): boolean {
    return task !== 'vision_figure' && task !== 'embed' && task !== 'transcribe';
  }
  modelFor(): string {
    return 'fake-grounded-copy (test only)';
  }
  estimateCostUsd(_m: string, u: ProviderUsage): number {
    return (u.inputTokens + u.outputTokens) / 10_000_000;
  }
  async generateStructured(req: ProviderRequest): Promise<ProviderResponse> {
    const base = { model: this.modelFor(), usage: { inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: 200 }, requestRef: 'fake' };
    if (req.task === 'verify_support') return { ...base, json: { results: claimsIn(req.prompt).map((c) => ({ index: c.index, verdict: 'supported', reason: 'test-only verifier' })) } };
    const ev = evidenceIn(req.prompt).slice(0, 5);
    if (ev.length === 0) return { ...base, json: { blocks: [], abstain: { reason: 'insufficient_evidence', detail: 'لا مقتطفات.' }, coverage_note: null } };
    const blocks = ev.map((e, i) => ({
      kind: i === 0 ? 'paragraph' : i === ev.length - 1 ? 'exam_pearl' : 'paragraph',
      sentences: [{ text: firstSentence(e.text), claim: { support_type: 'directly_stated', evidence: [e.alias] }, original_quote: false }],
      ...(e.region ? { explains_regions: [e.region] } : {}),
    }));
    if (req.task === 'compare') {
      const header = (/header is exactly (\[[^\]]*\])/.exec(req.prompt)?.[1] ?? '["الجانب","أ","ب"]').replace(/\\"/g, '"');
      const cols = (JSON.parse(header) as string[]).length;
      const rows = ev.slice(0, 3).map((e) => [{ text: 'من المصدر', claim: null }, ...Array.from({ length: cols - 1 }, (_, c) => (c === 0 ? { text: firstSentence(e.text), claim: { support_type: 'directly_stated', evidence: [e.alias] } } : { text: 'غير مذكور في المصادر المسموحة', claim: null }))]);
      return { ...base, json: { blocks: [{ kind: 'comparison_table', sentences: [], table: { header: JSON.parse(header) as string[], rows } }], abstain: null, coverage_note: null } };
    }
    return { ...base, json: { blocks: [{ kind: 'heading', sentences: [{ text: 'من نص المصدر', claim: null }] }, ...blocks], abstain: null, coverage_note: null } };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = await buildApp({ config, overrides: { db, aiProvider: new GroundedFakeAi() } });
  await app.ready();
  app.ctx.jobs.start();
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(`TEST-ONLY study book server (fake grounded provider) on ${config.host}:${config.port}\n`);
  const stop = () => void app.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((e: unknown) => {
  process.stderr.write(`failed: ${(e as Error)?.stack ?? String(e)}\n`);
  process.exit(1);
});
