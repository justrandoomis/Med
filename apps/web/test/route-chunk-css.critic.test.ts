// Release R1-a critic pass (2026-10-21): every lazily loaded screen must carry the feature stylesheets of what it
// renders. A feature's CSS (`src/features/<f>/*.css`) is code-split with the screen that imports it, so a component
// that uses a class defined only in ANOTHER feature's stylesheet is unstyled whenever the owner opens its screen
// directly (a bookmark, a reload, a link from elsewhere) — it looked right only after visiting the other feature first.
// Found on the versions tab of a lecture (`/sources/:id` → «النسخ»): opened directly, the version rows had no padding
// and no separators (`.ml-upload__*` lives in `upload/upload.css`, imported by the upload screens only); the same held
// for the compare screen's action row and the lecture tab's contents list.
//
// Rule checked here, statically: for every module loaded through `import('./…')` (the route screens and other lazy
// chunks), each `ml-…` class used by a feature module in its static import graph is defined in global CSS, in CSS
// reachable from the app entry (`main.tsx`, always loaded), or in CSS that this graph itself imports.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const FEATURES = join(SRC, 'features');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const ALL = walk(SRC).filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes(`${join('/', 'dev', '/')}`));
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** class → stylesheets that define it */
const DEFINED = new Map<string, Set<string>>();
for (const css of ALL.filter((f) => f.endsWith('.css'))) {
  for (const m of stripComments(readFileSync(css, 'utf8')).matchAll(/\.(ml-[A-Za-z0-9_-]+)/g)) {
    if (!DEFINED.has(m[1]!)) DEFINED.set(m[1]!, new Set());
    DEFINED.get(m[1]!)!.add(css);
  }
}
const isFeatureCss = (f: string) => f.startsWith(FEATURES + '/');

function resolveModule(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const staticSpecs = (f: string) =>
  [...readFileSync(f, 'utf8').matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]|^\s*import\s+['"](\.[^'"]+)['"]/gm)].map((m) => (m[1] ?? m[2])!);
const dynamicSpecs = (f: string) => [...readFileSync(f, 'utf8').matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]!);

function cssClosure(file: string, seen: Set<string>): void {
  if (seen.has(file) || !existsSync(file)) return;
  seen.add(file);
  for (const m of readFileSync(file, 'utf8').matchAll(/@import\s+['"](\.[^'"]+)['"]/g)) cssClosure(resolve(dirname(file), m[1]!), seen);
}

/** the static import graph of one module: its TS/TSX modules and the stylesheets they import */
function graphOf(root: string): { modules: Set<string>; css: Set<string> } {
  const modules = new Set<string>();
  const css = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const m = stack.pop()!;
    if (modules.has(m)) continue;
    modules.add(m);
    for (const spec of staticSpecs(m)) {
      if (spec.endsWith('.css')) cssClosure(resolve(dirname(m), spec), css);
      else {
        const target = resolveModule(m, spec);
        if (target && /\.tsx?$/.test(target)) stack.push(target);
      }
    }
  }
  return { modules, css };
}

/** classes a lazily loaded module renders without the stylesheet that defines them → «class (file) ← user» */
function unstyledClasses(root: string, eagerCss: Set<string>): string[] {
  const { modules, css } = graphOf(root);
  const out = new Set<string>();
  for (const m of modules) {
    if (!m.startsWith(FEATURES + '/')) continue;
    for (const k of stripComments(readFileSync(m, 'utf8')).matchAll(/\b(ml-[A-Za-z0-9_-]+)/g)) {
      const defs = [...(DEFINED.get(k[1]!) ?? [])];
      if (!defs.length || defs.some((c) => !isFeatureCss(c) || eagerCss.has(c) || css.has(c))) continue;
      out.add(`${k[1]} (${defs.map((c) => c.slice(FEATURES.length + 1)).join(' | ')}) ← ${m.slice(FEATURES.length + 1)}`);
    }
  }
  return [...out].sort();
}

describe('route chunks carry the CSS of what they render (R1-a critic)', () => {
  const eagerCss = graphOf(join(SRC, 'main.tsx')).css;
  const lazyRoots = new Set<string>();
  for (const f of ALL.filter((x) => /\.tsx?$/.test(x))) {
    for (const spec of dynamicSpecs(f)) {
      const r = resolveModule(f, spec);
      if (r && /\.tsx?$/.test(r)) lazyRoots.add(r);
    }
  }

  it('finds the lazy screens (sanity)', () => {
    expect(lazyRoots.size).toBeGreaterThan(40);
    expect([...lazyRoots].some((r) => r.endsWith(join('sources', 'SourceScreen.tsx')))).toBe(true);
    expect([...lazyRoots].some((r) => r.endsWith(join('sources', 'CompareScreen.tsx')))).toBe(true);
  });

  it('the lecture screen (versions tab, lecture tab) and the compare screen are styled when opened directly', () => {
    const offenders: Record<string, string[]> = {};
    for (const screen of ['SourceScreen.tsx', 'CompareScreen.tsx', 'LectureOrderScreen.tsx']) {
      const bad = unstyledClasses(join(FEATURES, 'sources', screen), eagerCss);
      if (bad.length) offenders[screen] = bad;
    }
    expect(offenders).toEqual({});
  });

  it('no lazily loaded module anywhere renders another feature’s classes without importing that stylesheet', () => {
    const offenders: Record<string, string[]> = {};
    for (const root of [...lazyRoots].sort()) {
      const bad = unstyledClasses(root, eagerCss);
      if (bad.length) offenders[root.slice(SRC.length + 1)] = bad;
    }
    expect(offenders).toEqual({});
  });
});
