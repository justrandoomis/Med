// Regression tests for the independent review of track C3 (Question Vault). Each block names the defect it pins:
//  R1 exact-duplicate fingerprint ignored «<» / «>» → medically different questions merged (§36)
//  R2 picture questions with the same words merged as exact duplicates (§36)
//  R3 a short line after the last option was glued into that option (silent content change, AC-11)
//  R4 a stem opening with the age («3. 60-year-old …») was not a question start; «10 - 15 mg/kg» was one
//  R5 a key labelled with a section label printed twice («Part A» ×2) was bound to the first one (AC-12)
//  R6 a replaced question source: old-version keys voted against the corrected key, and questions the new
//     version no longer contains stayed scorable with the old key (§18, AC-26)
//  R7 a printed key read by OCR with low confidence became a trusted, scorable source key (no guessing, §34)
//  R8 a key-correction alert listed the affected attempts only in affected_json — invisible in the alert view
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QuestionMutationResponse, TableStructure } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { bindKeys, keySection } from '../../src/modules/questions/keys';
import { parseQuestions, type ParserLine } from '../../src/modules/questions/parser';
import { fingerprint, refersToImage } from '../../src/modules/questions/text';
import { rawContent, validateQuestion } from '../../src/modules/questions/validate';
import { multipart } from '../sources/helpers';
import { api, correctTexts, createNode, createQuestionsApp, detail, listAll, local, questionAt, uploadAndProcess, type QApp } from './helpers';

let seq = 0;
function line(text: string, extra: Partial<ParserLine> = {}): ParserLine {
  seq++;
  return { text, regionId: `r${seq}`, regionKind: 'paragraph', pageIndex: 0, pageId: 'p0', bbox: null, regionStatus: 'extracted', confidence: null, textOrigin: 'digital', ...extra };
}
const lines = (...texts: string[]) => texts.map((t) => line(t));
const issueChecks = (q: { issues: Array<{ check: string; severity: string }> }) => q.issues.map((i) => `${i.check}:${i.severity}`);

describe('R1/R2 — exact-duplicate identity keeps comparison signs; pictures are never auto-merged', () => {
  it('«<» and «>» give different fingerprints', () => {
    expect(fingerprint('Serum sodium < 120 mmol/L. Next step?', ['A', 'B'])).not.toBe(fingerprint('Serum sodium > 120 mmol/L. Next step?', ['A', 'B']));
    expect(fingerprint('Potassium ≥ 6.5 mmol/L?', ['x'])).not.toBe(fingerprint('Potassium ≤ 6.5 mmol/L?', ['x']));
    expect(fingerprint('↑ ALP and ↓ albumin?', ['x'])).not.toBe(fingerprint('↓ ALP and ↑ albumin?', ['x']));
    // still insensitive to case, spacing and option order
    expect(fingerprint('Which  point is tender?', ['B', 'A'])).toBe(fingerprint('which point is tender?', ['A', 'B']));
  });

  it('refersToImage: named or pointed-at pictures only (no false blockers for «the values below» / «has been shown to»)', () => {
    expect(refersToImage('Which structure is shown in the image below?')).toBe(true);
    expect(refersToImage('Interpret this ECG.')).toBe(true);
    expect(refersToImage('The radiograph below shows which abnormality?')).toBe(true);
    expect(refersToImage('ما التشخيص حسب الصورة المرفقة؟')).toBe(true);
    expect(refersToImage('Which of the values below is within the reference range?')).toBe(false);
    expect(refersToImage('Which drug has been shown to reduce mortality?')).toBe(false);
  });
});

describe('R3/R4 — parser robustness: question starts and option continuation', () => {
  it('R4: a stem opening with the age is a question start; a value range line is stem text', () => {
    const r = parseQuestions(
      lines('1. Which?', 'A. x', 'B. y', '2. 60-year-old woman with fever. Which diagnosis?', 'A. a', 'B. b', '3. A child of 20 kg needs a dose of', '10 - 15 mg/kg of paracetamol. Which is correct?', 'A. 200 mg', 'B. 300 mg', '4. Next?', 'A. x', 'B. y'),
    );
    expect(r.questions.map((q) => q.printedNumber)).toEqual(['1', '2', '3', '4']);
    expect(r.questions[1]!.stem).toBe('60-year-old woman with fever. Which diagnosis?');
    expect(r.questions[2]!.stem).toBe('A child of 20 kg needs a dose of\n10 - 15 mg/kg of paracetamol. Which is correct?');
    expect(r.questions[2]!.options.map((o) => o.text)).toEqual(['200 mg', '300 mg']);
    expect(r.questions.every((q) => q.issues.length === 0)).toBe(true);
    // decimals are never numbering; «1- 25 mg» numeric options (other numbering style) still are options
    expect(parseQuestions(lines('3.5 mmol/L is the threshold')).questions).toHaveLength(0);
    const n = parseQuestions(lines('5. What dose?', '1- 25 mg', '2- 50 mg', '6. Next?', 'A. a', 'B. b'));
    expect(n.questions.map((q) => [q.printedNumber, q.options.map((o) => `${o.label}|${o.text}`)])).toEqual([
      ['5', ['1|25 mg', '2|50 mg']],
      ['6', ['A|a', 'B|b']],
    ]);
  });

  it('R4: the AC-11 raw reference keeps the numbers of a value line the parser kept as text (no false blocker)', () => {
    expect(rawContent('3. A child of 20 kg needs\n10 - 15 mg/kg of paracetamol\nA. 200 mg')).toBe('A child of 20 kg needs\n10 - 15 mg/kg of paracetamol\n200 mg');
    const v = validateQuestion({
      stem: 'A child of 20 kg needs\n10 - 15 mg/kg of paracetamol. Which is correct?',
      options: [
        { label: 'A', text: '200 mg' },
        { label: 'B', text: '300 mg' },
      ],
      qtype: 'sba',
      rawText: '3. A child of 20 kg needs\n10 - 15 mg/kg of paracetamol. Which is correct?\nA. 200 mg\nB. 300 mg',
      structural: [],
      figuresAttached: 0,
      uncertainRegions: [],
      answerStatus: 'source_key',
      conflictAr: null,
      unofficialMarks: [],
      createdBy: 'extraction',
      ownerReviewedFields: [],
    });
    expect(v.issues.find((i) => i.check === 'numbers_units_preserved')?.passed).toBe(true);
    expect(v.publishable).toBe(true);
  });

  it('R3: an unrelated line after the options is never glued into the last option — it is reported', () => {
    const r = parseQuestions(
      lines('1. Which imaging?', 'A. Ultrasound', 'B. PET scan', 'The following case relates to questions 2 and 3', 'A 45-year-old man has jaundice and fever.', '2. Which test next?', 'A. MRCP', 'B. ERCP', '3. Which diagnosis?', 'A. x', 'B. y'),
    );
    expect(r.questions.map((q) => q.printedNumber)).toEqual(['1', '2', '3']);
    expect(r.questions[0]!.options.map((o) => o.text)).toEqual(['Ultrasound', 'PET scan']);
    expect(issueChecks(r.questions[0]!)).toEqual(['options_complete:warning']);
    // the shared case text did not silently disappear: question 2 cannot be approved without looking at it
    expect(issueChecks(r.questions[1]!)).toEqual(['stem_complete:blocker']);
    expect(r.questions[1]!.issues[0]!.reason_ar).toContain('The following case relates to questions 2 and 3');
    // a title / instruction before the FIRST question is not reported
    expect(parseQuestions(lines('Final exam 2024', 'Choose one answer', '1. a?', 'A. x', 'B. y')).questions[0]!.issues).toEqual([]);
  });

  it('R3: real continuations are still joined (lower-case start, or an option stopping mid-phrase — across a page too)', () => {
    const r = parseQuestions([
      line('1. Which is the normal range?'),
      line('A. Laparoscopic'),
      line('appendicectomy'),
      line('B. Potassium 3.5 to'),
      line('5.0 mmol/L', { pageIndex: 1, pageId: 'p1' }),
      line('2. Next?', { pageIndex: 1, pageId: 'p1' }),
      line('A. a', { pageIndex: 1, pageId: 'p1' }),
      line('B. b', { pageIndex: 1, pageId: 'p1' }),
    ]);
    expect(r.questions[0]!.options.map((o) => o.text)).toEqual(['Laparoscopic appendicectomy', 'Potassium 3.5 to 5.0 mmol/L']);
    expect(r.questions[0]!.issues).toEqual([]);
  });

  it('R3: an option paragraph that swallowed the next questions’ introduction is a blocker', () => {
    const r = parseQuestions(lines('1. Which imaging?', 'A. Ultrasound', 'B. PET scan The following case relates to questions 2 and 3', '2. Next?', 'A. x', 'B. y'));
    expect(issueChecks(r.questions[0]!)).toContain('options_complete:blocker');
  });
});

describe('R5 — a section label printed twice never decides the binding (AC-12)', () => {
  it('Part A of two papers: the key «Part A» is ambiguous, not bound to the first one', () => {
    const r = parseQuestions(lines('Part A', '1. a?', 'A. x', 'B. y', 'Part B', '1. b?', 'A. x', 'B. y', 'Part A', '1. c?', 'A. x', 'B. y', 'Answer Key', 'Part A: 1. B'));
    expect(r.sections.map((s) => s.key)).toEqual(['A', 'B', 'A-3']);
    expect(r.keys).toHaveLength(1);
    expect(keySection(r.keys[0]!, r)).toEqual({ sectionKey: null, binding: 'ambiguous_section' });
    // a label printed once still binds
    const one = parseQuestions(lines('Part A', '1. a?', 'A. x', 'B. y', 'Part B', '1. b?', 'A. x', 'B. y', 'Answer Key', 'Part B: 1. A'));
    expect(keySection(one.keys[0]!, one)).toEqual({ sectionKey: 'B', binding: 'bound' });
  });

  it('key tables with a section column follow the same rule', () => {
    const table: TableStructure = {
      type: 'table',
      rows: 2,
      cols: 3,
      cells: [
        ['Section', 'Question', 'Answer'],
        ['A', '1', 'B'],
      ].flatMap((row, r) => row.map((text, c) => ({ r, c, text, header: r === 0 }))),
    };
    const r = parseQuestions([...lines('Part A', '1. a?', 'A. x', 'B. y', 'Part B', '1. b?', 'A. x', 'B. y', 'Part A', '1. c?', 'A. x', 'B. y'), line('', { regionKind: 'table', table })]);
    expect(r.keys).toHaveLength(1);
    expect(keySection(r.keys[0]!, r).binding).toBe('ambiguous_section');
  });
});

describe('through the real pipeline (upload → processing → extraction)', () => {
  let t: QApp;
  let course: string;
  beforeAll(async () => {
    t = await createQuestionsApp();
    course = (await createNode(t, 'Review course')).id;
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  it('R1/R2: look-alike questions stay separate questions; only suggestions with the reasons they differ', async () => {
    const x = await uploadAndProcess(t, course, 'lookalike_x.pdf', local('lookalike_x.pdf'), 'question_source', 'Lookalike X');
    const y = await uploadAndProcess(t, course, 'lookalike_y.pdf', local('lookalike_y.pdf'), 'question_source', 'Lookalike Y');
    const lt = questionAt(t, x.sourceId, '', '1');
    const gt = questionAt(t, y.sourceId, '', '1');
    expect(lt).not.toBe(gt);
    const figX = questionAt(t, x.sourceId, '', '2');
    const figY = questionAt(t, y.sourceId, '', '2');
    expect(figX).not.toBe(figY);
    // each keeps its own text and key
    const dGt = await detail(t, gt);
    expect(dGt.question.current.stem.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join(' ')).toContain('> 120');
    expect(dGt.question.occurrences).toHaveLength(1);
    expect(correctTexts((await detail(t, figY)).question)).toEqual(['Kidney']);
    expect(correctTexts((await detail(t, figX)).question)).toEqual(['Liver']);
    // suggestions only, with blockers
    const opsDup = dGt.question.duplicates.find((d) => d.other_question_id === lt);
    expect(opsDup?.status).toBe('suggested');
    expect(opsDup?.blockers.join(' ')).toContain('الأرقام أو الوحدات مختلفة');
    const figDup = (await detail(t, figY)).question.duplicates.find((d) => d.other_question_id === figX);
    expect(figDup?.status).toBe('suggested');
    expect(figDup?.blockers.join(' ')).toContain('صورة');
  });

  it('R5: two ambiguous section labels in one key block are both kept (no silent overwrite), unbound', async () => {
    const x = t.ctx.db.get<{ version_id: string }>(`SELECT o.source_version_id AS version_id FROM question_occurrence o JOIN source s ON s.id = o.source_id WHERE s.title = 'Lookalike X' LIMIT 1`)!;
    const parsed = parseQuestions(
      ['Part A', '1. a?', 'A. x', 'B. y', 'Part B', '1. b?', 'A. x', 'B. y', 'Part A', '1. c?', 'A. x', 'B. y', 'Part B', '1. d?', 'A. x', 'B. y', 'Answer Key', 'Part A: 1. B', 'Part B: 1. A'].map(
        (text) => line(text, { regionId: null, pageId: null }),
      ),
    );
    const res = t.ctx.db.tx(() => bindKeys(t.ctx, x.version_id, parsed, new Map()));
    expect(res.bound).toBe(0);
    expect(res.unbound.map((u) => [u.reason, u.sectionLabel, u.printedNumber])).toEqual([
      ['ambiguous_section', 'A', '1'],
      ['ambiguous_section', 'B', '1'],
    ]);
    const rows = t.ctx.db.all<{ key_label: string; binding: string; matched_occurrence_id: string | null }>(
      'SELECT key_label, binding, matched_occurrence_id FROM answer_key_entry WHERE source_version_id = ? ORDER BY section_key',
      [x.version_id],
    );
    expect(rows).toEqual([
      { key_label: 'B', binding: 'ambiguous_section', matched_occurrence_id: null },
      { key_label: 'A', binding: 'ambiguous_section', matched_occurrence_id: null },
    ]);
    // restore the real extraction of that file
    expect((await api(t).post('/api/questions/extract', { version_id: x.version_id })).statusCode).toBe(200);
    await t.ctx.jobs.drain();
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM answer_key_entry WHERE source_version_id = ? AND binding = 'bound'`, [x.version_id])!.n).toBe(2);
  });

  it('R7: a source key read by OCR with low confidence blocks scoring until the owner checks the key', async () => {
    const y = t.ctx.db.get<{ source_id: string; version_id: string }>(
      `SELECT o.source_id, o.source_version_id AS version_id FROM question_occurrence o JOIN source s ON s.id = o.source_id WHERE s.title = 'Lookalike Y' LIMIT 1`,
    )!;
    const qid = questionAt(t, y.source_id, '', '1');
    expect((await detail(t, qid)).scorable).toBe(true);
    // the key line was read by OCR with low confidence (simulated on the processed region)
    const keyRegion = t.ctx.db.get<{ region_id: string }>(
      `SELECT e.region_id FROM answer_key_entry e JOIN question_occurrence o ON o.id = e.matched_occurrence_id WHERE o.question_id = ? AND o.source_id = ?`,
      [qid, y.source_id],
    )!.region_id;
    t.ctx.db.run(`UPDATE source_region SET text_origin = 'ocr', confidence = 0.41 WHERE id = ?`, [keyRegion]);
    expect((await api(t).post('/api/questions/extract', { version_id: y.version_id })).statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const d = await detail(t, qid);
    expect(d.question.current.answer_status).toBe('source_key'); // the printed key is kept as printed…
    expect(d.scorable).toBe(false); // …but not trusted for scoring
    const issue = d.question.current.validation!.issues.find((i) => i.check === 'key_bound')!;
    expect(issue).toMatchObject({ passed: false, severity: 'blocker' });
    expect(issue.reason_ar).toContain('OCR');
    expect(d.review_items.some((i) => i.status === 'open' && i.reason.includes('OCR'))).toBe(true);
    // reviewing only the text does not vouch for the key
    const textOnly = await api(t).post(`/api/questions/${qid}/review`, { decision: 'accept', reviewed_fields: ['stem', 'options'], acknowledge_blockers: true });
    expect(textOnly.statusCode).toBe(200);
    expect((await detail(t, qid)).scorable).toBe(false);
    // the owner compared the key with the page
    const keyChecked = await api(t).post(`/api/questions/${qid}/review`, { decision: 'accept', reviewed_fields: ['key'], acknowledge_blockers: true });
    expect(keyChecked.statusCode).toBe(200);
    const after = await detail(t, qid);
    expect(after.scorable).toBe(true);
    expect(after.question.current.validation!.issues.find((i) => i.check === 'key_bound')?.severity).toBe('warning');
  });

  it('R6: a replaced question source — the corrected key wins (no false conflict), attempts stay, old-only questions are not scored', async () => {
    const v1 = await uploadAndProcess(t, course, 'replace_v1.pdf', local('replace_v1.pdf'), 'question_source', 'Replace Bank');
    const q1 = questionAt(t, v1.sourceId, '', '1');
    const q2old = questionAt(t, v1.sourceId, '', '2');
    const d1 = await detail(t, q1);
    expect(correctTexts(d1.question)).toEqual(['Obturator sign']);
    // an attempt on the version with the old key
    const attempted = d1.question.current;
    const now = t.ctx.clock.now();
    const attemptId = newId(now);
    t.ctx.db.run(
      `INSERT INTO question_attempt (id, question_id, question_version_id, selected_option_ids_json, is_correct, scored, answered_at, created_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
      [attemptId, q1, attempted.id, JSON.stringify([attempted.options.find((o) => o.source_label === 'B')!.id]), now, now],
    );

    const body = multipart({ note: 'نسخة مصححة' }, [{ name: 'replace_v2.pdf', data: local('replace_v2.pdf') }]);
    const rep = await t.app.inject({ method: 'POST', url: `/api/sources/${v1.sourceId}/versions`, headers: { ...t.h, 'content-type': body.contentType }, payload: body.payload });
    expect(rep.statusCode, rep.body).toBe(200);
    await t.ctx.jobs.drain();

    // Q1: same question (two occurrences), the corrected key of the version in force — not «conflicting»
    const a1 = await detail(t, q1);
    expect(a1.question.occurrences).toHaveLength(2);
    expect(a1.question.current.answer_status).toBe('source_key');
    expect(correctTexts(a1.question)).toEqual(['Murphy sign']);
    expect(a1.question.current.key_details?.notes_ar).toContain('«B»');
    expect(a1.scorable).toBe(true);
    // the attempted version is untouched; the change was a NEW version with an impact alert (AC-26)
    expect(a1.question.current.id).not.toBe(attempted.id);
    expect(a1.versions.find((v) => v.id === attempted.id)?.correct_option_ids).toEqual(attempted.correct_option_ids);
    expect(t.ctx.db.get<{ question_version_id: string; is_correct: number }>('SELECT question_version_id, is_correct FROM question_attempt WHERE id = ?', [attemptId])).toEqual({
      question_version_id: attempted.id,
      is_correct: 1,
    });
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM content_alert WHERE kind = 'key_corrected' AND affected_json LIKE ?`, [`%${attemptId}%`])!.n).toBe(1);
    // R8: the affected attempt is an item of the alert (the alerts view lists items), with what would change
    const item = t.ctx.db.get<{ impact: string; reason_ar: string }>(
      `SELECT i.impact, i.reason_ar FROM content_alert_item i JOIN content_alert a ON a.id = i.alert_id WHERE a.kind = 'key_corrected' AND i.dependent_type = 'question_attempt' AND i.dependent_id = ?`,
      [attemptId],
    )!;
    expect(item.impact).toBe('needs_review');
    expect(item.reason_ar).toContain('صحيحة وستكون خاطئة');

    // Q2 of the old version: kept (never deleted), but not scored and flagged for review
    const o2 = await detail(t, q2old);
    expect(o2.question.status).not.toBe('retired');
    expect(o2.scorable).toBe(false);
    expect(o2.unscorable_reason_ar).toContain('نسخة سابقة');
    expect(o2.review_items.some((i) => i.status === 'open' && i.reason.includes('نسخة سابقة'))).toBe(true);
    // Q2 as re-issued: its own question with its own key
    const v2 = t.ctx.db.get<{ current_version_id: string }>('SELECT current_version_id FROM source WHERE id = ?', [v1.sourceId])!.current_version_id;
    const q2new = t.ctx.db.get<{ question_id: string }>(`SELECT question_id FROM question_occurrence WHERE source_version_id = ? AND printed_number = '2'`, [v2])!.question_id;
    expect(q2new).not.toBe(q2old);
    const n2 = await detail(t, q2new);
    expect(correctTexts(n2.question)).toEqual(['Ultrasound']);
    expect(n2.scorable).toBe(true);

    // the owner can still review the old question and keep it (acknowledged → no longer blocking)
    const acc = await api(t).post(`/api/questions/${q2old}/review`, { decision: 'accept', reviewed_fields: ['stem', 'options'], acknowledge_blockers: true });
    expect(acc.statusCode).toBe(200);
    const after = acc.json() as QuestionMutationResponse;
    expect(after.validation?.issues.find((i) => i.check === 'scope')?.severity).toBe('warning');
    // listing the source shows all three questions, nothing was deleted
    expect((await listAll(t, `source_id=${v1.sourceId}`)).map((i) => i.id).sort()).toEqual([q1, q2old, q2new].sort());
  });
});
