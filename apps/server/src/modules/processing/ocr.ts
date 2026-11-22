// Local OCR with tesseract.js 7 (WASM) and the bundled eng + ara "best_int" models. Nothing leaves the
// machine. A small pool of workers (default 1; the pipeline asks for one per page it processes in parallel) is created
// lazily and reused — each worker serializes its own recognitions, a request goes to the least busy worker, so two
// pages of a scanned lecture are read on two CPU cores at once (docs/PERFORMANCE.md «Processing parallelism»). The
// workers are terminated when the app closes. Bidi control marks that tesseract emits are stripped from every word.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { stripBidiControls } from '@medlevo/shared';
import type { Worker as TesseractWorker } from 'tesseract.js';

const require = createRequire(import.meta.url);
export const OCR_LANGS = ['eng', 'ara'] as const;
export const OCR_MODEL_VARIANT = '4.0.0_best_int';
export const OCR_ENGINE_LABEL = 'tesseract.js 7 (eng+ara, 4.0.0_best_int)';

export interface OcrWord {
  text: string;
  /** 0–100 */
  conf: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** height of the text line the word belongs to (px) — a stable size estimate for the whole line */
  lineHeight: number;
  /** sequential id of the OCR text line (words of one line form one row) */
  line: number;
}

export interface OcrResult {
  words: OcrWord[];
  /** mean word confidence (0–100), null when no words */
  confidence: number | null;
}

/** default upper bound for one recognition; a hung worker is terminated so later pages are not blocked */
export const OCR_TIMEOUT_MS = 5 * 60 * 1000;

export class OcrTimeoutError extends Error {
  constructor() {
    super('OCR recognition timed out');
    this.name = 'OcrTimeoutError';
  }
}

export interface OcrRequest {
  image: Buffer;
  /** per-recognition time limit (default OCR_TIMEOUT_MS) */
  timeoutMs?: number;
  /** restrict recognition to a pixel rectangle */
  rectangle?: { left: number; top: number; width: number; height: number };
  /** 'auto' (page, PSM 3), 'sparse' (scattered labels in a figure, PSM 11) or 'block' (one uniform block of text,
   *  PSM 6 — the re-read when the automatic segmentation skipped lines, G3 / AC-08) */
  mode?: 'auto' | 'sparse' | 'block';
}

function modelSource(lang: string): string | null {
  try {
    const pkg = require.resolve(`@tesseract.js-data/${lang}/package.json`);
    const file = join(dirname(pkg), OCR_MODEL_VARIANT, `${lang}.traineddata.gz`);
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/** Whether the bundled models are present (no worker is started). */
export function ocrModelsAvailable(): { ok: boolean; missing: string[] } {
  const missing = OCR_LANGS.filter((l) => !modelSource(l));
  return { ok: missing.length === 0, missing: [...missing] };
}

interface Slot {
  worker: Promise<TesseractWorker> | null;
  queue: Promise<unknown>;
  pending: number;
}

export class OcrEngine {
  private readonly slots: Slot[];
  private closed = false;

  constructor(
    private readonly dataDir: string,
    opts: { workers?: number } = {},
  ) {
    const n = Math.max(1, Math.min(8, Math.floor(opts.workers ?? 1)));
    this.slots = Array.from({ length: n }, () => ({ worker: null, queue: Promise.resolve(), pending: 0 }));
  }

  /** number of OCR workers (recognitions that can run at the same time) */
  get size(): number {
    return this.slots.length;
  }

  /** tesseract.js expects one directory holding <lang>.traineddata.gz → copy the bundled models once. */
  private prepareLangDir(): string {
    const dir = join(this.dataDir, 'tessdata');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const lang of OCR_LANGS) {
      const target = join(dir, `${lang}.traineddata.gz`);
      if (existsSync(target)) continue;
      const src = modelSource(lang);
      if (!src) throw new Error(`OCR model for ${lang} is missing`);
      copyFileSync(src, target);
    }
    return dir;
  }

  private async getWorker(slot: Slot): Promise<TesseractWorker> {
    if (this.closed) throw new Error('OCR engine closed');
    if (!slot.worker) {
      const langPath = this.prepareLangDir();
      const cachePath = join(this.dataDir, 'tessdata-cache');
      mkdirSync(cachePath, { recursive: true, mode: 0o700 });
      const { createWorker } = await import('tesseract.js');
      const created = createWorker([...OCR_LANGS], 1 /* LSTM only */, {
        langPath,
        cachePath,
        gzip: true,
        logger: () => undefined,
        errorHandler: () => undefined,
      });
      slot.worker = created;
      created.catch(() => {
        if (slot.worker === created) slot.worker = null;
      });
    }
    return slot.worker;
  }

  /** Drop the current worker (it is terminated in the background); the next request creates a new one. */
  private resetWorker(slot: Slot): void {
    const w = slot.worker;
    slot.worker = null;
    if (w) void w.then((x) => x.terminate()).catch(() => undefined);
  }

  recognize(req: OcrRequest): Promise<OcrResult> {
    // the least busy worker (ties: the first — a single page never starts a second worker)
    const slot = this.slots.reduce((a, b) => (b.pending < a.pending ? b : a));
    const limited = async (): Promise<OcrResult> => {
      let timer: NodeJS.Timeout | undefined;
      const state = { abandoned: false };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          state.abandoned = true;
          reject(new OcrTimeoutError());
        }, req.timeoutMs ?? OCR_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        return await Promise.race([run(state), timeout]);
      } catch (e) {
        // a recognition that never finishes would block the serialized queue forever: kill that worker
        if (e instanceof OcrTimeoutError) this.resetWorker(slot);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    };
    // `state.abandoned` is checked right before every worker call: a terminated tesseract.js worker must
    // never be used again (its async `send` would reject with nobody listening → unhandled rejection)
    const run = async (state: { abandoned: boolean }): Promise<OcrResult> => {
      const worker = await this.getWorker(slot);
      if (state.abandoned) throw new OcrTimeoutError();
      await worker.setParameters({ tessedit_pageseg_mode: (req.mode === 'sparse' ? '11' : req.mode === 'block' ? '6' : '3') as never });
      const options = req.rectangle ? { rectangle: req.rectangle } : {};
      if (state.abandoned) throw new OcrTimeoutError();
      const res = await worker.recognize(req.image, options, { blocks: true, text: false });
      const words: OcrWord[] = [];
      let lineNo = 0;
      for (const block of res.data.blocks ?? []) {
        for (const para of block.paragraphs ?? []) {
          for (const line of para.lines ?? []) {
            const rowHeight = line.rowAttributes?.rowHeight;
            const lineHeight = Math.max(1, typeof rowHeight === 'number' && rowHeight > 0 ? rowHeight : (line.bbox?.y1 ?? 0) - (line.bbox?.y0 ?? 0));
            lineNo++;
            for (const w of line.words ?? []) {
              const text = stripBidiControls(w.text ?? '').trim();
              if (!text) continue;
              words.push({ text, conf: w.confidence ?? 0, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, lineHeight, line: lineNo });
            }
          }
        }
      }
      const confidence = words.length ? words.reduce((s, w) => s + w.conf, 0) / words.length : null;
      return { words, confidence };
    };
    slot.pending++;
    const p = slot.queue.then(limited, limited).finally(() => {
      slot.pending--;
    });
    slot.queue = p.catch(() => undefined);
    return p;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      this.slots.map(async (slot) => {
        const w = slot.worker;
        slot.worker = null;
        if (!w) return;
        try {
          await (await w).terminate();
        } catch {
          // already gone
        }
      }),
    );
  }
}
