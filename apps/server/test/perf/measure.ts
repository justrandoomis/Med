// Measurement helpers for the MEDLEVO_PERF suite: wall time, memory (sampled + the process high-water mark), latency
// percentiles, and a results file per scenario. Numbers are whatever this machine measured — nothing is extrapolated.
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { CACHE_DIR } from './fixtures';

export const MB = 1024 * 1024;
export const mb = (n: number) => Math.round((n / MB) * 10) / 10;

export interface MemoryPeaks {
  /** sampled peaks during the measured block (the sampler cannot run while the event loop is blocked) */
  rssPeakMb: number;
  heapUsedPeakMb: number;
  externalPeakMb: number;
  /** RSS when the block started */
  rssStartMb: number;
  /** process high-water mark (getrusage maxrss) before / after — exact, but lifetime-wide for this test process */
  maxRssBeforeMb: number;
  maxRssAfterMb: number;
}

/** Samples process memory every `everyMs` while `fn` runs. */
export async function withMemory<T>(fn: () => Promise<T>, everyMs = 20): Promise<{ value: T; mem: MemoryPeaks; ms: number }> {
  globalThis.gc?.();
  const start = process.memoryUsage();
  const maxBefore = process.resourceUsage().maxRSS * 1024;
  let rss = start.rss;
  let heap = start.heapUsed;
  let ext = start.external;
  const sample = () => {
    const m = process.memoryUsage();
    rss = Math.max(rss, m.rss);
    heap = Math.max(heap, m.heapUsed);
    ext = Math.max(ext, m.external);
  };
  const timer = setInterval(sample, everyMs);
  const t0 = performance.now();
  try {
    const value = await fn();
    const ms = performance.now() - t0;
    sample();
    return {
      value,
      ms,
      mem: {
        rssPeakMb: mb(rss),
        heapUsedPeakMb: mb(heap),
        externalPeakMb: mb(ext),
        rssStartMb: mb(start.rss),
        maxRssBeforeMb: mb(maxBefore),
        maxRssAfterMb: mb(process.resourceUsage().maxRSS * 1024),
      },
    };
  } finally {
    clearInterval(timer);
  }
}

export function percentiles(samples: number[]): { n: number; min: number; p50: number; p95: number; max: number; mean: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { n: s.length, min: r(s[0] ?? 0), p50: r(at(0.5)), p95: r(at(0.95)), max: r(s[s.length - 1] ?? 0), mean: r(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)) };
}

/** Run `fn` `n` times (after `warmup` unmeasured runs) and return latency percentiles in ms. */
export async function latency(n: number, fn: (i: number) => Promise<unknown> | unknown, warmup = 3): Promise<ReturnType<typeof percentiles>> {
  for (let i = 0; i < warmup; i++) await fn(i);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    out.push(performance.now() - t0);
  }
  return percentiles(out);
}

export function environment(): Record<string, unknown> {
  return {
    node: process.version,
    cpus: cpus().length,
    cpu_model: cpus()[0]?.model ?? 'unknown',
    total_mem_mb: mb(totalmem()),
    platform: `${process.platform} ${process.arch}`,
    measured_at: new Date().toISOString(),
  };
}

export const RESULTS_DIR = process.env.MEDLEVO_PERF_OUT || join(dirname(CACHE_DIR), 'medlevo-perf-results');

/** Write a scenario's results (JSON) and print a compact summary to the test output. */
export function report(file: string, results: Record<string, unknown>): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `${file}.json`);
  writeFileSync(path, JSON.stringify({ environment: environment(), results }, null, 2));
  process.stdout.write(`\n[perf] ${file}\n${JSON.stringify(results, null, 2)}\n[perf] written to ${path}\n`);
  return path;
}
