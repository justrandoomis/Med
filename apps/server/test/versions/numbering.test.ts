// P1-T3 step 1 — lecture numbering, date, title and subject detection (PRD AOS-3.2, 3.3, 3.4, 3.7, 3.18).
// Pure detection first (file names and first-page text, Arabic-Indic digits, ordinal words, noisy names), then the
// stored behaviour: a certain number is stored with origin 'detected'; an uncertain one stays in the review queue with
// NO downstream effect until the owner confirms; a human decision is never overridden by a later analysis.
import { afterEach, describe, expect, it } from 'vitest';
import type { ImportSuggestionView, SourceIdentityResponse } from '@medlevo/shared';
import {
  arabicNumberWord,
  cleanTitleFromFileName,
  detectLectureDate,
  detectLectureNumber,
  proposeTitle,
  suggestSubjects,
  toLatinDigits,
} from '../../src/modules/sources/classify';
import { pdfFrom, scenario4V1 } from '../fixtures/versions/build';
import type { TestApp } from '../helpers/app';
import { addSource, createProcessingApp, processVersion } from '../processing/helpers';

describe('lecture number detection (pure)', () => {
  const num = (name: string, page = '') => detectLectureNumber(name, page);

  it.each([
    ['Lecture 5.pdf', 5],
    ['Lec 05 - Abdomen.pdf', 5],
    ['abdomen_lec5_final (1).pdf', 5],
    ['LECTURE-12 thorax.pptx', 12],
    ['Lecture No. 7 renal.pdf', 7],
    ['3rd lecture - limbs.pdf', 3],
    ['محاضرة ٥.pdf', 5],
    ['المحاضرة رقم ١٢ - الكلية.pdf', 12],
    ['محاضرة (8) فسلجة.pdf', 8],
    ['المحاضرة الخامسة - البطن.pdf', 5],
    ['المحاضرة الأولى.docx', 1],
    ['المحاضرة الحادية عشرة.pdf', 11],
    ['المحاضرة الثانية عشرة.pdf', 12],
    ['المحاضرة العشرون.pdf', 20],
    ['المحاضرة الحادية والعشرون.pdf', 21],
    ['lecture five.pdf', 5],
  ])('%s → %i, certain', (name, n) => {
    const d = num(name);
    expect(d?.value).toBe(n);
    expect(d?.certainty).toBe('certain');
    expect(d!.reasons_ar.join(' ')).toContain('في اسم الملف');
  });

  it('reads the first pages too (Arabic-Indic digits and ordinal words)', () => {
    expect(num('abdomen.pdf', 'جامعة الاختبار\nالمحاضرة الخامسة\nجدار البطن')).toMatchObject({ value: 5, certainty: 'certain' });
    expect(num('notes.pdf', 'Anatomy — محاضرة ٧')).toMatchObject({ value: 7, certainty: 'certain' });
    expect(num('Lecture 5.pdf', 'Lecture 5: The anterior abdominal wall')).toMatchObject({ value: 5, certainty: 'certain' });
  });

  it('a copy suffix «(1)», a year and a page number are not lecture numbers', () => {
    expect(num('Abdomen final (1).pdf')).toBeNull();
    expect(num('Anatomy 2024 exam.pdf')).toBeNull();
    expect(num('notes.pdf', 'Page 3 of 40')).toBeNull();
  });

  it('uncertain: weak hints only, disagreeing mentions, one file holding two lectures', () => {
    expect(num('L5 abdomen.pdf')).toMatchObject({ value: 5, certainty: 'uncertain' });
    expect(num('05 - Abdomen.pdf')).toMatchObject({ value: 5, certainty: 'uncertain' });
    const disagree = num('Lecture 5.pdf', 'Lecture 6: the posterior wall');
    expect(disagree?.certainty).toBe('uncertain');
    expect(disagree!.reasons_ar.join(' ')).toContain('أرقام مختلفة');
    expect(num('Lectures 5 & 6.pdf')?.certainty).toBe('uncertain');
    expect(num('المحاضرتان 5 و6.pdf')?.certainty).toBe('uncertain');
  });

  it('number words and digits', () => {
    expect(toLatinDigits('محاضرة ١٢ و ۳')).toBe('محاضرة 12 و 3');
    expect(arabicNumberWord('الخامسه')).toBe(5);
    expect(arabicNumberWord('الحاديه عشره')).toBe(11);
    expect(arabicNumberWord('الثالثه والعشرون')).toBe(23);
    expect(arabicNumberWord('الكليه')).toBeNull();
  });
});

describe('lecture date, title, subject (pure)', () => {
  it('dates: month names are certain, a day/month swap is uncertain', () => {
    expect(detectLectureDate('x.pdf', 'Held on 14 October 2026')).toMatchObject({ value: '2026-10-14', certainty: 'certain' });
    expect(detectLectureDate('x.pdf', 'October 14, 2026')).toMatchObject({ value: '2026-10-14', certainty: 'certain' });
    expect(detectLectureDate('x.pdf', 'ألقيت في ١٤ تشرين الأول ٢٠٢٦')).toMatchObject({ value: '2026-10-14', certainty: 'certain' });
    expect(detectLectureDate('x.pdf', '١٤ أكتوبر ٢٠٢٦')).toMatchObject({ value: '2026-10-14', certainty: 'certain' });
    expect(detectLectureDate('lec 2026-10-14.pdf', '')).toMatchObject({ value: '2026-10-14', certainty: 'certain' });
    expect(detectLectureDate('x.pdf', '14/10/2026')).toMatchObject({ value: '2026-10-14', certainty: 'certain' });
    expect(detectLectureDate('x.pdf', '03/04/2026')).toMatchObject({ value: '2026-04-03', certainty: 'uncertain' });
    expect(detectLectureDate('x.pdf', '31/02/2026')).toBeNull();
    expect(detectLectureDate('x.pdf', '14 October 2026 and 21 October 2026')?.certainty).toBe('uncertain');
  });

  it('titles: noise removed from names, the first heading preferred, the original kept by the caller', () => {
    expect(cleanTitleFromFileName('Abdomen lec5 final (1).pdf')).toBe('Abdomen lec5');
    expect(cleanTitleFromFileName('Copy of Renal physiology - Copy (2).pptx')).toBe('Renal physiology');
    expect(cleanTitleFromFileName('محاضرة الكلية نهائي نسخة 2.pdf')).toBe('محاضرة الكلية');
    expect(cleanTitleFromFileName('Thorax_v2_updated.pdf')).toBe('Thorax');
    expect(proposeTitle('Abdomen lec5 final (1).pdf', 'Lecture 5: The anterior abdominal wall', 'Abdomen lec5 final (1)')).toMatchObject({
      value: 'Lecture 5: The anterior abdominal wall',
      certainty: 'uncertain',
    });
    expect(proposeTitle('Abdomen lec5 final (1).pdf', 'Contents', 'Abdomen lec5 final (1)')?.value).toBe('Abdomen lec5');
    expect(proposeTitle('Abdomen.pdf', null, 'Abdomen')).toBeNull();
  });

  it('subjects: folder names found in the file name or the cover, bilingual; never more than 3', () => {
    const nodes = [
      { id: 'n-anat', title: 'Anatomy', kind: 'subject', path: ['Year 2', 'Anatomy'] },
      { id: 'n-phys', title: 'الفسلجة', kind: 'subject', path: ['Year 2', 'الفسلجة'] },
      { id: 'n-abd', title: 'Abdomen', kind: 'course', path: ['Year 2', 'Anatomy', 'Abdomen'] },
    ];
    const a = suggestSubjects('تشريح البطن محاضرة 3.pdf', '', nodes);
    expect(a[0]?.node.id).toBe('n-anat');
    const b = suggestSubjects('Renal physiology lec 4.pdf', '', nodes);
    expect(b[0]?.node.id).toBe('n-phys');
    expect(b[0]!.reasons_ar.join(' ')).toContain('اسم الملف');
    const c = suggestSubjects('lec 5.pdf', 'Abdomen course - Lecture 5', nodes);
    expect(c[0]?.node.id).toBe('n-abd');
    expect(c[0]!.reasons_ar.join(' ')).toContain('الصفحة الأولى');
    expect(suggestSubjects('random notes.pdf', 'nothing here', nodes)).toEqual([]);
  });
});

describe('stored identity (processing → analysis job)', () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  async function identity(sourceId: string): Promise<SourceIdentityResponse> {
    const h = await t.login();
    const res = await t.app.inject({ method: 'GET', url: `/api/versions/sources/${sourceId}/identity`, headers: h });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as SourceIdentityResponse;
  }

  it('a certain number and date are stored as «detected»; the title is only proposed', async () => {
    t = await createProcessingApp();
    const { sourceId, versionId } = await addSource(t, 'x.pdf', 'pdf', { data: scenario4V1(), fileName: 'Abdomen lec5 final (1).pdf', title: 'Abdomen lec5 final (1)' });
    await processVersion(t, versionId);
    const id = await identity(sourceId);
    expect(id.identity).toMatchObject({ lecture_no: 5, lecture_no_origin: 'detected', held_on: '2026-10-14', held_on_origin: 'detected', title: 'Abdomen lec5 final (1)' });
    expect(id.identity.original_file_name).toBe('Abdomen lec5 final (1).pdf');
    const title = id.suggestions.find((s) => s.field === 'title');
    expect(title).toMatchObject({ status: 'open', value: { field: 'title', title: 'Lecture 5: The anterior abdominal wall' } });
    expect(id.analysis?.state).toBe('ready');
  });

  it('an uncertain number waits in the queue with no effect; accept stores it as the owner’s; a re-run never overrides', async () => {
    t = await createProcessingApp();
    const h = await t.login();
    // the file name says 5, the first page says 6 → uncertain
    const pdf = pdfFrom([{ heading: 'Lecture 6: The posterior wall', lines: ['TEST FIXTURE - synthetic.', 'Some body text for the page.'] }, { heading: 'Part two', lines: ['More text.'] }]);
    const { sourceId, versionId } = await addSource(t, 'x.pdf', 'pdf', { data: pdf, fileName: 'Lecture 5.pdf', title: 'Lecture 5' });
    await processVersion(t, versionId);
    let id = await identity(sourceId);
    expect(id.identity.lecture_no).toBeNull(); // no downstream effect
    const s = id.suggestions.find((x) => x.field === 'lecture_no')!;
    expect(s).toMatchObject({ status: 'open', certainty: 'uncertain' });
    expect(s.reasons_ar.join(' ')).toContain('أرقام مختلفة');
    // ordering ignores it until confirmed
    const node = t.ctx.db.get<{ node_id: string | null }>('SELECT node_id FROM source WHERE id = ?', [sourceId]);
    expect(node?.node_id ?? null).toBeNull();

    const res = await t.app.inject({ method: 'POST', url: `/api/versions/suggestions/${s.id}/decide`, headers: h, payload: { action: 'accept' } });
    expect(res.statusCode, res.body).toBe(200);
    id = await identity(sourceId);
    expect(id.identity).toMatchObject({ lecture_no: (s.value as { lecture_no: number }).lecture_no, lecture_no_origin: 'owner' });

    // the owner changes it; a new analysis of the same version never overrides the owner
    const patch = await t.app.inject({ method: 'PATCH', url: `/api/versions/sources/${sourceId}/identity`, headers: h, payload: { lecture_no: 9 } });
    expect(patch.statusCode, patch.body).toBe(200);
    await processVersion(t, versionId, { reason: 'reprocess' });
    id = await identity(sourceId);
    expect(id.identity).toMatchObject({ lecture_no: 9, lecture_no_origin: 'owner' });
  });

  it('a rejected suggestion is remembered and never proposed again', async () => {
    t = await createProcessingApp();
    const h = await t.login();
    const { sourceId, versionId } = await addSource(t, 'x.pdf', 'pdf', { data: scenario4V1(), fileName: 'Abdomen lec5 final (1).pdf', title: 'Abdomen lec5 final (1)' });
    await processVersion(t, versionId);
    const title = (await identity(sourceId)).suggestions.find((x) => x.field === 'title') as ImportSuggestionView;
    const res = await t.app.inject({ method: 'POST', url: `/api/versions/suggestions/${title.id}/decide`, headers: h, payload: { action: 'reject' } });
    expect(res.statusCode, res.body).toBe(200);
    await processVersion(t, versionId, { reason: 'reprocess' });
    const after = (await identity(sourceId)).suggestions.filter((x) => x.field === 'title');
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('rejected');
    expect(t.ctx.db.get<{ title: string }>('SELECT title FROM source WHERE id = ?', [sourceId])!.title).toBe('Abdomen lec5 final (1)');
  });
});
