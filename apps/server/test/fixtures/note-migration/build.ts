// TEST FIXTURE generator for P1-T2 step 3 («انقل ملاحظاتي إلى الإصدار الجديد», Scenario 4 note side). SYNTHETIC only: it
// reuses P1-T3's generator (test/fixtures/versions/build.ts: deterministic pseudo-text from a fixed word list, never a
// real course file) and builds versions of a lecture in which pages are inserted AND reordered:
//
//   v1 (40 pages)
//   v2 «inserted + reordered» (42 pages): v1 p.1–10, two NEW pages, v1 p.11–24, v1 p.36 (moved up), v1 p.25–35,
//       v1 p.37–40 — with the body of v1 p.30 rewritten (as in Scenario 4).
//
// So: p.5 → p.5 (safe), p.12 → p.14 (safe, shifted by the insertion), p.30 → p.33 (changed: needs review), and p.36 is a
// crossing move → p.27 (the page map marks it «moved», uncertain: needs review, with p.27 suggested).
//
// Two lectures with that shape:
//  * `insertedAndReordered()` — on top of Scenario 4 v1 itself (server tests, each in its own throwaway database);
//  * `ownLectureV1()` / `ownLectureV2()` — the same structure with ITS OWN text (Lecture 7), for the E2E run, which
//    shares one server per project with e2e/aos-p1-versions.spec.ts: Scenario 4's pages there would be found as a
//    duplicate or proposed as a version of the other spec's lecture. A tag makes each run's bytes unique.
import { pdfFrom, scenario4V1, scenario4V1Pages, sentences, type FixturePage } from '../versions/build';

export { scenario4V1 };

/** v1 page number → page number in the inserted-and-reordered version */
export function reorderedPageOf(v1Page: number): number {
  if (v1Page <= 10) return v1Page;
  if (v1Page <= 24) return v1Page + 2;
  if (v1Page === 36) return 27;
  if (v1Page <= 35) return v1Page + 3;
  return v1Page + 2;
}

/** The v2 shape above, from any 40-page v1 (`seed` picks the text of the inserted and rewritten pages). */
export function insertAndReorder(v1: FixturePage[], seed: number): FixturePage[] {
  const inserted: FixturePage[] = [
    { heading: 'New: Ultrasound of the wall - added slide A', lines: sentences(seed + 1, 8) },
    { heading: 'New: Ultrasound of the wall - added slide B', lines: sentences(seed + 2, 8) },
  ];
  const at = (p: number): FixturePage => (p === 30 ? { heading: v1[29]!.heading, lines: sentences(seed + 2030, 8) } : v1[p - 1]!);
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => at(a + k));
  return [...range(1, 10), ...inserted, ...range(11, 24), at(36), ...range(25, 35), ...range(37, 40)];
}

export function insertedAndReorderedPages(): FixturePage[] {
  return insertAndReorder(scenario4V1Pages(), 5000);
}
export const insertedAndReordered = (): Buffer => pdfFrom(insertedAndReorderedPages());

const TOPICS = ['Overview', 'Boundaries', 'Contents of the canal', 'Deep ring', 'Superficial ring', 'Walls', 'Hernias', 'Examination', 'Clinical notes', 'Review'];

/** Lecture 7 (TEST FIXTURE): 40 pages with the structure of Scenario 4 and text of its own. */
export function ownLecturePages(): FixturePage[] {
  const pages: FixturePage[] = [
    {
      heading: 'Lecture 7: The inguinal region',
      lines: ['TEST FIXTURE - synthetic structural document for automated tests. Not a medical reference.', 'Abdomen course - Lecture 7', 'Held on 21 October 2026', 'Department of Test Anatomy'],
    },
    { heading: 'Contents', lines: ['Overview ........ 3', 'Deep ring ........ 15', 'Hernias ........ 27', 'Review ........ 39'] },
  ];
  for (let i = 3; i <= 40; i++) {
    const topic = TOPICS[Math.min(TOPICS.length - 1, Math.floor((i - 3) / 4))]!;
    pages.push({ heading: `${topic} - section ${i}`, lines: sentences(20_000 + i, 8) });
  }
  return pages;
}
export const ownLectureV1 = (tag: string): Buffer => pdfFrom(ownLecturePages(), { tag });
export const ownLectureV2 = (tag: string): Buffer => pdfFrom(insertAndReorder(ownLecturePages(), 25_000), { tag });
