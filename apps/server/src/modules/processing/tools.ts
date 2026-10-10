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
  /** receives poppler's stderr (it reports damaged content there while still exiting 0) */
  onDiagnostics?: (stderr: string) => void;
}

/**
 * Whether poppler's diagnostics say the page content could not be decoded (e.g. «Syntax Error (125734): Unknown
 * compression method in flate stream», «Syntax Error: XObject 'Im0' is unknown»). Warnings do not count.
 */
export function popplerReportsDamage(stderr: string): boolean {
  return stderr.split('\n').some((l) => /\berror\b/i.test(l) && !/warning/i.test(l));
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
    const { stderr } = await runCommand(o.pdftoppm, args, { timeoutMs: o.timeoutMs ?? 120_000, signal: o.signal });
    o.onDiagnostics?.(stderr);
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
 * LibreOffice must never reach the network for an uploaded document (§49, G8 security): a DOC / PPT / PPTX can hold a
 * picture that is only a LINK (`r:link`, `TargetMode="External"`, INCLUDEPICTURE) to any host — LibreOffice fetched it
 * while converting (an SSRF from an uploaded file: internal addresses, metadata services). Every conversion therefore
 * runs with a fresh profile whose settings block untrusted referer links and send all HTTP(S) through a proxy on a
 * closed loopback port, and with the same proxy in the environment (LibreOffice's «system» proxy reads it).
 */
const NO_NETWORK_PROXY = 'http://127.0.0.1:1';
const NO_NETWORK_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetProxyType" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetHTTPProxyName" oor:op="fuse"><value>127.0.0.1</value></prop></item>
<item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetHTTPProxyPort" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetHTTPSProxyName" oor:op="fuse"><value>127.0.0.1</value></prop></item>
<item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetHTTPSProxyPort" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetNoProxy" oor:op="fuse"><value></value></prop></item>
</oor:items>
`;

/** Environment of a LibreOffice run: no inherited variables, every proxy variable pointing at a closed port. */
export function officeEnv(dir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    LANG: 'C.UTF-8',
    TMPDIR: dir,
    http_proxy: NO_NETWORK_PROXY,
    https_proxy: NO_NETWORK_PROXY,
    HTTP_PROXY: NO_NETWORK_PROXY,
    HTTPS_PROXY: NO_NETWORK_PROXY,
    ftp_proxy: NO_NETWORK_PROXY,
    no_proxy: '',
    NO_PROXY: '',
  };
}

/**
 * Convert an office document to PDF with LibreOffice headless, in an isolated temp dir with its own
 * user profile (-env:UserInstallation) so concurrent/previous runs and the owner's profile never interfere.
 * The profile is pre-seeded so the conversion never fetches anything (see NO_NETWORK_XCU).
 */
export async function convertToPdf(o: ConvertOptions): Promise<Buffer> {
  return withTempDir(o.tmpRoot, 'lo-', async (dir) => {
    const inDir = join(dir, 'in');
    const outDir = join(dir, 'out');
    const profile = join(dir, 'profile');
    await mkdir(inDir, { mode: 0o700 });
    await mkdir(outDir, { mode: 0o700 });
    await mkdir(join(profile, 'user'), { recursive: true, mode: 0o700 });
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'), NO_NETWORK_XCU, { mode: 0o600 });
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
        env: officeEnv(dir),
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
