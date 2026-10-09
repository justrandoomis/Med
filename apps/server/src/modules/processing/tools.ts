// External converters used by the pipeline (poppler pdftoppm, LibreOffice soffice). Each run happens in
// an isolated temp directory with a timeout; the whole process group is killed on timeout/abort; temp
// files are always removed. Inputs are written under generated names (never the uploaded file name).
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ToolPaths {
  /** absolute path of pdftoppm, or null when unavailable */
  pdftoppm: string | null;
  /** absolute path of soffice (LibreOffice), or null when unavailable */
  soffice: string | null;
}

/** Find an executable on PATH (no shell). */
export function findExecutable(name: string, pathEnv = process.env.PATH ?? ''): string | null {
  const candidates = isAbsolute(name) ? [name] : pathEnv.split(delimiter).filter(Boolean).map((d) => join(d, name));
  for (const c of candidates) {
    try {
      if (!statSync(c).isFile()) continue;
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      // not here
    }
  }
  return null;
}

export function detectTools(overrides: Partial<ToolPaths> = {}): ToolPaths {
  return {
    pdftoppm: overrides.pdftoppm !== undefined ? overrides.pdftoppm : findExecutable('pdftoppm'),
    soffice:
      overrides.soffice !== undefined ? overrides.soffice : (findExecutable('soffice') ?? findExecutable('libreoffice')),
  };
}

export class ToolError extends Error {
  constructor(
    readonly code: 'TOOL_TIMEOUT' | 'TOOL_FAILED' | 'TOOL_ABORTED' | 'TOOL_NO_OUTPUT',
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Run a command without a shell; resolve on exit code 0. Kills the process group on timeout/abort. */
export function runCommand(cmd: string, args: string[], opts: RunOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new ToolError('TOOL_ABORTED', 'aborted'));
      return;
    }
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', // own process group → kill(-pid) reaches LibreOffice's children
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 64_000) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 64_000) stderr += d.toString('utf8');
    });
    let settled = false;
    const killTree = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      reject(new ToolError('TOOL_TIMEOUT', `${cmd} timed out after ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);
    timer.unref();
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree();
      reject(new ToolError('TOOL_ABORTED', 'aborted'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new ToolError('TOOL_FAILED', e.message));
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new ToolError('TOOL_FAILED', `${cmd} exited with code ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

async function withTempDir<T>(tmpRoot: string, prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(tmpRoot, prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface RenderOptions {
  pdftoppm: string;
  /** PDF file path (internal store path) */
  pdfPath: string;
  /** 1-based page number */
  pageNumber: number;
  dpi: number;
  /** crop rectangle in rendered pixels (top-left origin of the rendered crop box, /Rotate applied) */
  crop?: { x: number; y: number; w: number; h: number };
  tmpRoot: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Render one PDF page (or a crop of it) to PNG with poppler. */
export async function renderPdfPage(o: RenderOptions): Promise<Buffer> {
  return withTempDir(o.tmpRoot, 'render-', async (dir) => {
    const outPrefix = join(dir, 'page');
    // -cropbox: render the CROP box (what readers show and what pdfjs reports as the page view), not the
    // media box — otherwise OCR words and figure crops are offset on pages whose CropBox ≠ MediaBox.
    const args = ['-f', String(o.pageNumber), '-l', String(o.pageNumber), '-r', String(o.dpi), '-cropbox', '-png', '-singlefile'];
    if (o.crop) {
      args.push(
        '-x', String(Math.max(0, Math.floor(o.crop.x))),
        '-y', String(Math.max(0, Math.floor(o.crop.y))),
        '-W', String(Math.max(1, Math.ceil(o.crop.w))),
        '-H', String(Math.max(1, Math.ceil(o.crop.h))),
      );
    }
    args.push(o.pdfPath, outPrefix);
    await runCommand(o.pdftoppm, args, { timeoutMs: o.timeoutMs ?? 120_000, signal: o.signal });
    try {
      return await readFile(`${outPrefix}.png`);
    } catch {
      throw new ToolError('TOOL_NO_OUTPUT', 'pdftoppm produced no image');
    }
  });
}

export interface ConvertOptions {
  soffice: string;
  input: Uint8Array;
  /** extension that tells LibreOffice the input type */
  inputExt: 'doc' | 'ppt' | 'docx' | 'pptx' | 'rtf' | 'odt' | 'odp';
  tmpRoot: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Convert an office document to PDF with LibreOffice headless, in an isolated temp dir with its own
 * user profile (-env:UserInstallation) so concurrent/previous runs and the owner's profile never interfere.
 */
export async function convertToPdf(o: ConvertOptions): Promise<Buffer> {
  return withTempDir(o.tmpRoot, 'lo-', async (dir) => {
    const inDir = join(dir, 'in');
    const outDir = join(dir, 'out');
    const profile = join(dir, 'profile');
    await mkdir(inDir, { mode: 0o700 });
    await mkdir(outDir, { mode: 0o700 });
    await mkdir(profile, { mode: 0o700 });
    const inputPath = join(inDir, `source.${o.inputExt}`);
    await writeFile(inputPath, o.input, { mode: 0o600 });
    await runCommand(
      o.soffice,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless',
        '--invisible',
        '--norestore',
        '--nologo',
        '--nodefault',
        '--nolockcheck',
        '--nofirststartwizard',
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        inputPath,
      ],
      {
        timeoutMs: o.timeoutMs ?? 180_000,
        signal: o.signal,
        cwd: dir,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8', TMPDIR: dir },
      },
    );
    try {
      const pdf = await readFile(join(outDir, 'source.pdf'));
      if (pdf.length < 8 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a pdf');
      return pdf;
    } catch {
      throw new ToolError('TOOL_NO_OUTPUT', 'LibreOffice produced no PDF');
    }
  });
}
