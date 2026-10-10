// G2 / AC-06 — model output that points to an evidence_id or a PAGE that does not exist is rejected and never becomes
// a visible, valid citation. Real pipeline on the Golden Set; AI = the TEST-ONLY scripted provider.
// Adversarial angles beyond the module tests: alias spellings that a naive lookup would accept (prototype keys,
// case / whitespace / zero-padding variants), raw ids of real evidence (in and out of the lock), fabricated
// region aliases, and «citations» written into the TEXT (an «(ص 99)» / «[E5]» / «p. 31» page reference in a claim,
// a heading, a mnemonic, a coverage note or a table header) — the model has no page field, so text is the only
// place it can name a page.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatPostResponse, ChatThreadResponse, EvidenceView, ExplainResponse, StudyArtifactView } from '@medlevo/shared';
import { fromRegion } from '../../src/modules/evidence/services';
import { linkReference, regionWith } from '../evidence/helpers';
import { aliasFor, content, evidenceIn, lectureOnly, S, ScriptedAi, studyLibrary, type StudyLib } from '../studybook/helpers';

const ai = new ScriptedAi();
let lib: StudyLib;
let us: { id: string; page_id: string };

beforeAll(async () => {
  lib = await studyLibrary(ai);
  linkReference(lib.t, lib.lecture.sourceId, lib.reference.sourceId);
  const r = regionWith(lib.t, lib.lecture.versionId, 'Ultrasound is the first-line');
  us = { id: r.id, page_id: r.page_id };
}, 180_000);
afterAll(async () => {
  await lib?.t.close();
});
afterEach(() => {
  ai.verdict = () => 'supported';
  if (ai.errors.length) throw new Error(`scripted generator failed: ${ai.errors.splice(0).map(String).join(' | ')}`);
});

const post = async <T>(url: string, payload: unknown): Promise<{ status: number; body: T & { error?: { code: string } } }> => {
  const res = await lib.t.app.inject({ method: 'POST', url, headers: lib.h, payload: payload as object });
  return { status: res.statusCode, body: res.json() };
};
const get = async (url: string) => lib.t.app.inject({ method: 'GET', url, headers: lib.h });
const anchor = () => ({ source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, page_id: us.page_id, region_ids: [us.id] });
const explain = (extra: Record<string, unknown> = {}) => post<ExplainResponse>('/api/studybook/explain', { action: 'explain', style: 'detailed', anchor: anchor(), scope: lectureOnly(lib), ...extra });
const visibleText = (a: StudyArtifactView) =>
  a.blocks
    .map((b) => [b.content, ...(b.table ? [...b.table.header, ...b.table.rows.flat()] : [])].map((rt) => rt.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n')).join('\n'))
    .join('\n');
const citedIds = (a: StudyArtifactView) => Object.values(a.claims).flatMap((c) => c.citations.map((x) => x.evidence.id));
const US = 'Ultrasound is the first-line imaging test in children and in pregnant women.';
let n = 0;
/** each request gets a unique instruction → a unique cache key */
const fresh = () => `G2 AC-06 probe ${++n}`;

describe('G2 AC-06 — invalid evidence ids never become citations', () => {
  it('unknown, fabricated, prototype-key and look-alike aliases, and raw ids (in or out of the lock), are all removed', async () => {
    const inScopeRaw = fromRegion(lib.t.ctx, us.id).id; // a REAL evidence row, but never handed out as an alias
    const refRaw = fromRegion(lib.t.ctx, regionWith(lib.t, lib.reference.versionId, 'Murphy').id).id;
    const bad = ['E99', 'E0', 'E-1', 'e1', ' E1', 'E1 ', 'E01', 'E1,E2', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', inScopeRaw, refRaw, '../E1', 'E1​'];
    ai.once('explain', (req) => {
      const good = aliasFor(req, 'Ultrasound is the first-line');
      return content([
        { kind: 'paragraph', sentences: [S.c(US, [good], 'directly_stated'), ...bad.map((b) => S.c(`${US.replace('.', '')} (${JSON.stringify(b)}).`, [b], 'derived'))] },
        // a claim citing a good alias AND a bad one is rejected as a whole — the bad id never rides along
        { kind: 'paragraph', sentences: [S.c(US, [good, 'E42'], 'directly_stated')] },
      ]);
    });
    const r = await explain({ instruction: fresh() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const a = r.body.artifact;
    const ids = citedIds(a);
    expect(ids.length).toBeGreaterThan(0); // the one good claim is cited
    const pack = new Set(ids);
    expect(pack.has(refRaw)).toBe(false);
    // every citation is a real, in-lock evidence row of the lecture
    for (const c of Object.values(a.claims)) for (const x of c.citations) expect(x.evidence.source_id).toBe(lib.lecture.sourceId);
    expect(a.removed.length).toBe(bad.length + 1);
    for (const rm of a.removed) expect(rm.reason_ar.length).toBeGreaterThan(5);
    // no citation row exists for any rejected claim (DB, not just the view)
    const rows = lib.t.ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM citation ci JOIN claim cl ON cl.id = ci.claim_id JOIN content_block b ON b.id = cl.owner_id WHERE b.artifact_id = ? AND cl.verification_status = 'rejected'`,
      [a.id],
    )!.n;
    expect(rows).toBe(0);
    // the server never even asked the verifier about them
    const verifier = ai.callsFor('verify_support').map((c) => c.prompt).join('\n');
    for (const b of ['__proto__', 'constructor', refRaw]) expect(verifier).not.toContain(JSON.stringify(b));
  });

  it('a fabricated region alias (R99 / __proto__) never decides which page a block «explains»', async () => {
    ai.once('explain', (req) => content([{ kind: 'paragraph', sentences: [S.c(US, [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')], explains_regions: ['R99', '__proto__', 'constructor'] }]));
    const r = await explain({ instruction: fresh() });
    const block = r.body.artifact.blocks[0]!;
    expect(block.source_region_ids).toEqual([us.id]);
    expect(block.meta?.page_ids).toEqual([us.page_id]);
  });

  it('the evidence API answers «missing» / 404 for ids that do not exist — the web never gets a view to draw a chip from', async () => {
    const real = fromRegion(lib.t.ctx, us.id).id;
    const batch = await post<{ evidence: EvidenceView[]; missing: string[] }>('/api/evidence/batch', { ids: [real, 'E1', 'does-not-exist', '__proto__'] });
    expect(batch.status).toBe(200);
    expect(batch.body.evidence.map((e) => e.id)).toEqual([real]);
    expect(batch.body.missing.sort()).toEqual(['E1', '__proto__', 'does-not-exist'].sort());
    expect((await get('/api/evidence/does-not-exist')).statusCode).toBe(404);
    expect((await get('/api/evidence/claims/does-not-exist')).statusCode).toBe(404);
  });
});

describe('G2 AC-06 — a page named only in the TEXT is never a citation', () => {
  it('a claim that writes its own page reference («(ص 99)», «p. 31», «[E5]») is rejected even when its alias is valid', async () => {
    ai.once('explain', (req) => {
      const good = aliasFor(req, 'Ultrasound is the first-line');
      return content([
        {
          kind: 'paragraph',
          sentences: [
            S.c(US, [good], 'directly_stated'),
            S.c('Ultrasound is the first-line imaging test in children (المحاضرة ص 99).', [good], 'derived'),
            S.c('Ultrasound is the first-line imaging test in children (Bailey & Love, p. 31).', [good], 'derived'),
            S.c('Ultrasound is the first-line imaging test in children [E5].', [good], 'derived'),
            S.c('الأمواج فوق الصوتية هي الفحص الأول عند الأطفال (انظر الصفحة ٩٩ من المرجع).', [good], 'derived'),
          ],
        },
      ]);
    });
    const r = await explain({ instruction: fresh() });
    expect(r.status).toBe(200);
    const text = visibleText(r.body.artifact);
    expect(text).toContain(US);
    expect(text).not.toMatch(/ص 99|p\. 31|\[E5\]|٩٩/);
    expect(r.body.artifact.removed.length).toBe(4);
  });

  it('claim-less blocks (heading, mnemonic, coverage note, self-check question, table header) cannot carry a page reference either', async () => {
    ai.once('explain', (req) => {
      const good = aliasFor(req, 'Ultrasound is the first-line');
      return content([
        { kind: 'heading', sentences: [S.n('التصوير الأولي (المحاضرة ص 99)')] },
        { kind: 'paragraph', sentences: [S.c(US, [good], 'directly_stated')] },
        { kind: 'memory_hook', sentences: [S.n('«الصغير بالصوت» — كما في المرجع ص 31.')] },
        { kind: 'mini_question', sentences: [S.n('ما الفحص الأول عند الأطفال؟ (راجع الصفحة 99)')] },
        { kind: 'coverage_note', sentences: [S.n('التفاصيل في Bailey & Love p. 1234 وفي [E9].')] },
        {
          kind: 'comparison_table',
          sentences: [],
          table: { header: ['الجانب', 'Ultrasound (ص 99)', 'CT'], rows: [[S.n('الاستخدام'), S.c('Ultrasound is the first-line imaging test in children.', [good]), S.n('غير مذكور في المصادر المسموحة')]] },
        },
      ]);
    });
    const r = await explain({ instruction: fresh() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const text = visibleText(r.body.artifact);
    expect(text).toContain(US);
    // no visible page / evidence reference that is not a server-made chip
    expect(text).not.toMatch(/ص\s*(99|31)|الصفحة 99|p\.\s*\d|\[E\d+\]/);
    // the table keeps its column, without the invented page; the removed sentences are reported with the reason
    expect(r.body.artifact.blocks.find((b) => b.table)!.table!.header.map((h) => h.paragraphs[0]!.runs.map((x) => x.t).join(''))).toEqual(['الجانب', 'Ultrasound', 'CT']);
    expect(r.body.artifact.removed.filter((x) => /صفحة أو دليلًا داخل النص/.test(x.reason_ar)).length).toBe(4);
  });

  it('free model notes (coverage note, abstention detail) are published without invented page references', async () => {
    ai.once('explain', (req) =>
      content([{ kind: 'paragraph', sentences: [S.c(US, [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }], { coverage_note: 'لا تغطي المحاضرة الجرعات (انظر المرجع ص 31) ولا Murphy (Bailey & Love p. 1234).' }),
    );
    const r = await explain({ instruction: fresh() });
    const missing = (r.body.artifact.coverage?.missing_ar ?? []).join(' ');
    expect(missing).toContain('لا تغطي المحاضرة الجرعات');
    expect(missing).not.toMatch(/ص 31|p\. 1234/);
    ai.once('explain', () => ({ blocks: [], abstain: { reason: 'not_found_in_scope', detail: 'The answer is in the textbook (p. 99, [E7]), not in the lecture.' } }));
    const ab = await explain({ instruction: fresh() });
    expect(ab.body.artifact.abstain!.detail).toBeTruthy();
    expect(ab.body.artifact.abstain!.detail).not.toMatch(/p\. 99|\[E7\]/);
  });

  it('generated questions: a stem or option that «cites» a page / alias is a blocking issue (repaired or sent to review, never published)', async () => {
    const { deterministicIssues } = await import('../../src/modules/exams/generation/validate');
    const ex = (t: string) => [{ text: t, claim: { support_type: 'directly_stated' as const, evidence: ['E1'] } }];
    const q = {
      item_type: 'vignette',
      learning_objective: 'Choose the first imaging test for suspected appendicitis in a child.',
      concepts: ['ultrasound'],
      difficulty_est: 'medium' as const,
      stem: 'A 9-year-old child presents with right lower quadrant pain and fever for one day. Which imaging test should be requested first?',
      options: [
        { key: 'A', text: 'Abdominal ultrasound' },
        { key: 'B', text: 'CT of the abdomen' },
        { key: 'C', text: 'Plain abdominal X-ray' },
        { key: 'D', text: 'MRI of the pelvis' },
      ],
      best_answer: 'A',
      explanation: ex('Ultrasound is the first-line imaging test in children and in pregnant women.'),
      distractors: ['B', 'C', 'D'].map((o) => ({ option: o, explanation: ex('CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.') })),
    };
    const cite = (x: typeof q) => deterministicIssues(x).filter((i) => /يذكر صفحة أو دليلًا/.test(i.reason_ar));
    expect(cite(q)).toHaveLength(0);
    expect(cite({ ...q, stem: q.stem.replace('first?', 'first (see lecture p. 12)?') })).toHaveLength(1);
    expect(cite({ ...q, options: q.options.map((o, i) => (i === 1 ? { ...o, text: 'CT of the abdomen (ص 99)' } : o)) })).toHaveLength(1);
    expect(cite({ ...q, stem: `${q.stem} [E3]` })).toHaveLength(1);
  });

  it('the detector does not flag ordinary medical text (no false «citations»)', async () => {
    const { hasPseudoCitation } = await import('../../src/modules/studybook/publish');
    for (const ok of [
      'Figure 1 shows the pathway.',
      'Table 2: Alvarado score',
      'pH 7.4 and p < 0.05',
      'Give 5 mg p.o. twice daily.',
      'A white cell count above 11 ×10⁹/L supports the diagnosis.',
      'يُعطى الدواء الساعة 8 ص ثم 8 م.',
      'فحص 3 مرات يوميًا',
      'Vitamin E deficiency',
      'Na+ 135 mmol/L',
    ])
      expect(hasPseudoCitation(ok), ok).toBe(false);
    for (const bad of ['(ص 12)', 'ص.99', 'انظر الصفحة ٩٩', 'الشريحة 4', 'p. 31', 'pp. 3-4', 'page 12', '[E5]', '(E1, E2)', '[R2]', 'صفحة رقم 7']) expect(hasPseudoCitation(bad), bad).toBe(true);
  });

  it('chat: the same rules; a saved answer note lists only the server-made evidence labels', async () => {
    const th = await post<ChatThreadResponse>('/api/studybook/threads', { scope: lectureOnly(lib), anchor: anchor(), style: 'detailed' });
    ai.once('chat', (req) => {
      const good = evidenceIn(req.prompt).find((e) => e.text.includes('Ultrasound is the first-line'))!.alias;
      return content([{ kind: 'paragraph', sentences: [S.c(US, [good], 'directly_stated'), S.c('CT is never used in children.', ['E77']), S.c('Ultrasound is first-line (ص 99).', [good])] }]);
    });
    const r = await post<ChatPostResponse>(`/api/studybook/threads/${th.body.thread.id}/messages`, { text: 'ما الفحص الأول عند الأطفال؟' });
    expect(r.body.answer.status).toBe('final');
    const a = r.body.answer.artifact!;
    expect(visibleText(a)).not.toMatch(/never used|ص 99/);
    const note = await post<{ note: { body: { paragraphs: Array<{ runs: Array<{ t: string }> }> }; ai_record: { evidence_ids: string[]; evidence_labels: string[] } } }>(
      `/api/studybook/messages/${r.body.answer.id}/save-note`,
      { note_id: `g2ac06note${Date.now().toString(36)}` },
    );
    expect(note.status, JSON.stringify(note.body)).toBe(200);
    const ev = lib.t.ctx.db.all<{ id: string }>(`SELECT id FROM evidence WHERE id IN (${note.body.note.ai_record.evidence_ids.map(() => '?').join(',')})`, note.body.note.ai_record.evidence_ids);
    expect(ev.length).toBe(note.body.note.ai_record.evidence_ids.length); // every id exists
    expect(note.body.note.ai_record.evidence_labels.join(' ')).not.toMatch(/E77|ص 99/);
  });
});
