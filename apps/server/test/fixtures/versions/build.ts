// TEST FIXTURE generator for P1-T3 (lecture identity, page fingerprints, version page maps, link candidates).
// Everything here is SYNTHETIC: deterministic pseudo-text built from a fixed word list, never a real course file and
// never a medical reference. The committed PDFs next to this file (scenario4-v1.pdf, scenario4-v2.pdf) are the output
// of `writeCommittedFixtures()`; test/versions/fixtures.test.ts checks they are byte-identical to a fresh build, so the
// files can always be regenerated and nothing hand-made hides in them.
//
// Scenario 4 (PRD «تحديث المحاضرة الرسمية»): version 1 has 40 pages; version 2 inserts 2 pages after p.10 and rewrites
// the body of p.30. Every page carries a printed footer «Page N» that follows its NEW position, so a fingerprint that
// kept footers would see every page after the insertion as changed.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePdf, text, type GenPage } from '../../helpers/pdfgen';

export const VERSIONS_FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

const WORDS = (
  'fascia aponeurosis rectus sheath linea alba transversus oblique inguinal ligament canal spermatic cord ' +
  'epigastric artery vein nerve dermatome umbilicus peritoneum preperitoneal fat iliac crest pubic tubercle ' +
  'conjoint tendon deep ring superficial ring hernia direct indirect triangle lateral medial border fibres ' +
  'muscle layer lymph drainage segmental supply innervation thoracoabdominal subcostal iliohypogastric ilioinguinal ' +
  'genital femoral branch course relation surface marking landmark incision laparotomy midline paramedian ' +
  'transverse closure suture tension wound healing collagen strength cough impulse reduction examination'
).split(/\s+/);

/** mulberry32: a small deterministic PRNG (same output on every machine). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` sentences of 9–14 words, deterministic for `seed`. */
export function sentences(seed: number, count: number): string[] {
  const r = prng(seed);
  const out: string[] = [];
  for (let s = 0; s < count; s++) {
    const n = 9 + Math.floor(r() * 6);
    const w: string[] = [];
    for (let i = 0; i < n; i++) w.push(WORDS[Math.floor(r() * WORDS.length)]!);
    w[0] = w[0]!.charAt(0).toUpperCase() + w[0]!.slice(1);
    out.push(`${w.join(' ')}.`);
  }
  return out;
}

export interface FixturePage {
  heading: string;
  lines: string[];
}

/** One A4 page: heading, body lines, and the printed footer «Page N» (N = the page's position in ITS file). */
function renderPage(p: FixturePage, printedNo: number | null): GenPage {
  let content = text(56, 780, 18, p.heading, { bold: true });
  let y = 740;
  for (const l of p.lines) {
    content += text(56, y, 11, l);
    y -= 22;
  }
  if (printedNo !== null) content += text(280, 30, 9, `Page ${printedNo}`);
  return { content };
}

export function pdfFrom(pages: FixturePage[], opts: { footer?: boolean; tag?: string } = {}): Buffer {
  const gen = pages.map((p, i) => renderPage(p, opts.footer === false ? null : i + 1));
  const pdf = makePdf(gen);
  // a re-export of identical content: same pages, different bytes (a trailing comment changes the sha256 only)
  return opts.tag ? Buffer.concat([pdf, Buffer.from(`% ${opts.tag}\n`, 'latin1')]) : pdf;
}

const TOPICS = ['Introduction', 'Surface anatomy', 'Muscles of the wall', 'Rectus sheath', 'Inguinal canal', 'Blood supply', 'Nerve supply', 'Lymph drainage', 'Clinical notes', 'Summary'];

/** Scenario 4 version 1: 40 pages (title page, printed contents page, 38 content pages). */
export function scenario4V1Pages(): FixturePage[] {
  const pages: FixturePage[] = [
    {
      heading: 'Lecture 5: The anterior abdominal wall',
      lines: ['TEST FIXTURE - synthetic structural document for automated tests. Not a medical reference.', 'Abdomen course - Lecture 5', 'Held on 14 October 2026', 'Department of Test Anatomy'],
    },
    {
      heading: 'Contents',
      lines: ['Introduction ........ 3', 'Muscles of the wall ........ 8', 'Inguinal canal ........ 14', 'Blood supply ........ 22', 'Clinical notes ........ 31', 'Summary ........ 39'],
    },
  ];
  for (let i = 3; i <= 40; i++) {
    const topic = TOPICS[Math.min(TOPICS.length - 1, Math.floor((i - 3) / 4))]!;
    pages.push({ heading: `${topic} - part ${i}`, lines: sentences(1000 + i, 8) });
  }
  return pages;
}

/** Scenario 4 version 2: p.1–10, two NEW pages, then v1 p.11–40 with the body of v1 p.30 rewritten (42 pages). */
export function scenario4V2Pages(): FixturePage[] {
  const v1 = scenario4V1Pages();
  const inserted: FixturePage[] = [
    { heading: 'New: Ultrasound of the wall - added slide A', lines: sentences(5001, 8) },
    { heading: 'New: Ultrasound of the wall - added slide B', lines: sentences(5002, 8) },
  ];
  const rest = v1.slice(10).map((p, k) => (k + 11 === 30 ? { heading: p.heading, lines: sentences(7030, 8) } : p));
  return [...v1.slice(0, 10), ...inserted, ...rest];
}

/** A different lecture of the same course (link-candidate negative): no page in common with Scenario 4. */
export function unrelatedDeckPages(): FixturePage[] {
  const pages: FixturePage[] = [{ heading: 'Lecture 9: The posterior abdominal wall', lines: ['TEST FIXTURE - synthetic structural document for automated tests. Not a medical reference.', 'Abdomen course - Lecture 9'] }];
  for (let i = 2; i <= 20; i++) pages.push({ heading: `Kidney and ureter - part ${i}`, lines: sentences(9000 + i, 8) });
  return pages;
}

export const scenario4V1 = (): Buffer => pdfFrom(scenario4V1Pages());
export const scenario4V2 = (): Buffer => pdfFrom(scenario4V2Pages());
/** the same 40 pages as v1, re-exported (different bytes, identical content) */
export const scenario4V1Reexport = (): Buffer => pdfFrom(scenario4V1Pages(), { tag: 'TEST FIXTURE re-export' });
export const unrelatedDeck = (): Buffer => pdfFrom(unrelatedDeckPages());

export const COMMITTED = {
  'scenario4-v1.pdf': scenario4V1,
  'scenario4-v2.pdf': scenario4V2,
} as const;

/** Regenerates the committed PDFs (run once by hand when the generator changes). */
export function writeCommittedFixtures(dir = VERSIONS_FIXTURE_DIR): void {
  for (const [name, build] of Object.entries(COMMITTED)) writeFileSync(join(dir, name), build());
}
