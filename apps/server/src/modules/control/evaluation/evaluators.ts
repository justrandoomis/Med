// One evaluator per check type (§57). Each reads what the REAL system produced in the evaluation harness (through
// the HTTP API where a view exists, the services otherwise) and compares it with the catalogue's expected value.
// Outcomes: pass / fail (the system's answer differs) / error (the evaluation itself could not decide — never counted
// as a pass) / not_run (blocked here, with the reason).
import {
  detectDir,
  richTextToPlain,
  segmentRuns,
  type ChatPostResponse,
  type ChatThreadResponse,
  type EvalCaseResult,
  type GeneratedSentence,
  type ImageMatchResponse,
  type LectureQuestionsResponse,
  type QuestionDetailResponse,
} from '@medlevo/shared';
import { textToHtml } from '../../data/render';
import { validateClaims } from '../../evidence/claims';
import { fromRegion } from '../../evidence/evidence';
import { resolveScope } from '../../evidence/scope';
import { validateImageCandidate } from '../../media/validate-image';
import type { ChatExpectation, EvalCaseDef, KeyExpectation, SourceKey } from './catalogue';
import type { EvalHarness } from './harness';
import { aliasFor, answerOf } from './scripted';

export type Verdict = Pick<EvalCaseResult, 'outcome' | 'expected' | 'observed' | 'reason_ar'>;

const BIDI_CONTROL = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();
const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

class EvalBlocked extends Error {}

function pass(expected: unknown, observed: unknown): Verdict {
  return { outcome: 'pass', expected: show(expected), observed: show(observed), reason_ar: null };
}
function fail(expected: unknown, observed: unknown, reason_ar: string): Verdict {
  return { outcome: 'fail', expected: show(expected), observed: show(observed), reason_ar };
}
const judge = (ok: boolean, expected: unknown, observed: unknown, reason_ar: string): Verdict => (ok ? pass(expected, observed) : fail(expected, observed, reason_ar));

function source(h: EvalHarness, key: SourceKey) {
  const s = h.sources.get(key);
  if (!s) throw new EvalBlocked(`المصدر ${key} لم يُحمَّل في هذا التشغيل.`);
  if (s.error) throw new Error(`تعذّر تجهيز المصدر ${key}: ${s.error}`);
  return s;
}

function versionText(h: EvalHarness, key: SourceKey, page?: number): string {
  const s = source(h, key);
  const rows = h.ctx.db.all<{ text: string }>(
    `SELECT r.text FROM source_region r JOIN source_page p ON p.id = r.page_id
      WHERE r.version_id = ? AND r.text IS NOT NULL AND r.status <> 'rejected' ${page === undefined ? '' : 'AND p.page_index = ?'}
      ORDER BY p.page_index, r.reading_order`,
    page === undefined ? [s.versionId] : [s.versionId, page],
  );
  return norm(rows.map((r) => r.text).join(' '));
}

function questionId(h: EvalHarness, key: SourceKey, section: string, n: string): string {
  const s = source(h, key);
  const row = h.ctx.db.get<{ question_id: string }>('SELECT question_id FROM question_occurrence WHERE source_id = ? AND section_key = ? AND printed_number = ?', [s.sourceId, section, n]);
  if (!row) throw new NotFound(`لم يُستخرج سؤال ${section ? `${section}/` : ''}${n} من ${key}.`);
  return row.question_id;
}

/** «the system did not produce the thing at all» is a FAIL of the system (not an evaluation error) */
class NotFound extends Error {}

async function detail(h: EvalHarness, id: string): Promise<QuestionDetailResponse> {
  const r = await h.inject('GET', `/api/questions/${encodeURIComponent(id)}`);
  if (r.status !== 200) throw new Error(`GET /api/questions/:id → ${r.status}`);
  return r.json as QuestionDetailResponse;
}

const plain = (rt: Parameters<typeof richTextToPlain>[0]) => norm(richTextToPlain(rt));

function regionWith(h: EvalHarness, key: SourceKey, needle: string): { id: string; page_id: string } {
  const s = source(h, key);
  const row = h.ctx.db.get<{ id: string; page_id: string }>(
    `SELECT r.id, r.page_id FROM source_region r JOIN source_page p ON p.id = r.page_id
      WHERE r.version_id = ? AND r.text LIKE ? AND r.status <> 'rejected' ORDER BY p.page_index, r.reading_order LIMIT 1`,
    [s.versionId, `%${needle}%`],
  );
  if (!row) throw new NotFound(`لا توجد منطقة نص تحتوي «${needle}» في ${key}.`);
  return row;
}

export async function evaluateCase(h: EvalHarness, def: EvalCaseDef): Promise<Verdict> {
  try {
    return await run(h, def);
  } catch (e) {
    if (e instanceof EvalBlocked) return { outcome: 'not_run', expected: show(def.expected), observed: '—', reason_ar: e.message };
    if (e instanceof NotFound) return { outcome: 'fail', expected: show(def.expected), observed: 'غير موجود', reason_ar: e.message };
    return { outcome: 'error', expected: show(def.expected), observed: '—', reason_ar: `خطأ أثناء التقييم: ${(e as Error).message}`.slice(0, 400) };
  }
}

async function run(h: EvalHarness, def: EvalCaseDef): Promise<Verdict> {
  const c = def.check;
  const exp = def.expected;
  switch (c.type) {
    case 'page_contains': {
      const text = versionText(h, c.source, c.page);
      const ok = text.includes(norm(c.text));
      return judge(ok, c.text, ok ? c.text : text.slice(0, 160), `النص المستخرج من الصفحة ${c.page + 1} في الملف لا يحتوي «${c.text}».`);
    }
    case 'version_contains': {
      const text = versionText(h, c.source);
      const ok = text.includes(norm(c.text));
      return judge(ok, c.text, ok ? c.text : text.slice(0, 160), `النص المستخرج لا يحتوي «${c.text}».`);
    }
    case 'version_absent': {
      const text = versionText(h, c.source);
      const ok = !text.includes(c.text);
      return judge(ok, `لا يحتوي «${c.text}»`, ok ? 'غير موجود' : `موجود: «${c.text}»`, `الصيغة المعيبة «${c.text}» مخزنة كما هي.`);
    }
    case 'page_labels': {
      const s = source(h, c.source);
      const labels = h.ctx.db.all<{ printed_label: string | null }>('SELECT printed_label FROM source_page WHERE version_id = ? ORDER BY page_index', [s.versionId]).map((r) => r.printed_label ?? '∅');
      return judge(JSON.stringify(labels) === JSON.stringify(exp), exp, labels, 'أرقام الصفحات المطبوعة تختلف عن الملف.');
    }
    case 'question_count': {
      const s = source(h, c.source);
      const n = h.ctx.db.get<{ n: number }>('SELECT COUNT(DISTINCT question_id) AS n FROM question_occurrence WHERE source_id = ?', [s.sourceId])!.n;
      return judge(n === exp, exp, n, `عدد الأسئلة المستخرجة ${n} وليس ${String(exp)}.`);
    }
    case 'q_stem': {
      const v = (await detail(h, questionId(h, c.source, c.section, c.n))).question.current;
      const stem = plain(v.stem);
      const ok = c.mode === 'equals' ? stem === norm(c.text) : c.mode === 'contains' ? stem.includes(norm(c.text)) : !stem.includes(c.text);
      return judge(ok, `${c.mode}: ${c.text}`, stem.slice(0, 200), c.mode === 'not_contains' ? `نص السؤال يحتوي «${c.text}».` : `نص السؤال لا يطابق المتوقع.`);
    }
    case 'q_negation': {
      const v = (await detail(h, questionId(h, c.source, c.section, c.n))).question.current;
      const want = ((exp as { terms: string[] }).terms ?? []).map((t) => t.toLowerCase());
      const terms = (v.negation_terms ?? []).map((t) => t.toLowerCase());
      const em = v.stem.paragraphs.flatMap((p) => p.runs).filter((r) => r.marks?.includes('em')).map((r) => r.t.toLowerCase());
      const ok = v.has_negation && JSON.stringify(terms) === JSON.stringify(want) && want.every((t) => em.includes(t));
      return judge(ok, { has_negation: true, terms: want, emphasized: want }, { has_negation: v.has_negation, terms, emphasized: em }, 'النفي لم يُحفظ أو لم يُعلَّم كما في الأصل.');
    }
    case 'q_option_text': {
      const v = (await detail(h, questionId(h, c.source, c.section, c.n))).question.current;
      const texts = v.options.map((o) => plain(o.text));
      const ok = texts.includes(norm(c.text));
      return judge(ok, c.text, texts, `لا يوجد خيار نصه «${c.text}» كما طُبع.`);
    }
    case 'q_options': {
      const v = (await detail(h, questionId(h, c.source, c.section, c.n))).question.current;
      const e = exp as { count: number; labels?: string[]; texts?: string[] };
      const opts = [...v.options].sort((a, b) => a.ord - b.ord);
      const labels = opts.map((o) => o.source_label ?? '?');
      const texts = opts.map((o) => plain(o.text));
      const ok = opts.length === e.count && (!e.labels || JSON.stringify(labels) === JSON.stringify(e.labels)) && (!e.texts || JSON.stringify(texts) === JSON.stringify(e.texts.map(norm)));
      return judge(ok, e, { count: opts.length, labels, texts }, 'الخيارات المستخرجة ناقصة أو مختلفة عن الأصل.');
    }
    case 'q_key': {
      const d = await detail(h, questionId(h, c.source, c.section, c.n));
      const v = d.question.current;
      const e = exp as KeyExpectation;
      const keyed = v.options.filter((o) => v.correct_option_ids?.includes(o.id));
      const labels = keyed.map((o) => o.source_label ?? '?');
      const texts = keyed.map((o) => plain(o.text));
      const mark = d.key_entries.find((k) => k.mark_kind === 'circled_option');
      const observed = { answer_status: v.answer_status, key_labels: labels, key_texts: texts, unofficial_mark: mark ? `${mark.key_label}:${mark.binding}` : null };
      let ok = v.answer_status === e.answer_status;
      if (e.key_labels) ok &&= JSON.stringify(labels) === JSON.stringify(e.key_labels);
      if (e.key_texts) ok &&= JSON.stringify(texts) === JSON.stringify(e.key_texts.map(norm));
      if (e.answer_status === 'missing_key') ok &&= (v.correct_option_ids ?? []).length === 0;
      if (e.unofficial_mark) ok &&= !!mark && mark.key_label === e.unofficial_mark && mark.binding === 'unofficial' && mark.origin_known === false;
      return judge(ok, e, observed, 'ربط مفتاح الإجابة يختلف عن الأصل.');
    }
    case 'lecture_link': {
      const lecture = source(h, c.lecture);
      const qid = questionId(h, c.source, c.section, c.n);
      const r = await h.inject('GET', `/api/questions/for-lecture/${encodeURIComponent(lecture.sourceId)}`);
      if (r.status !== 200) throw new Error(`GET /api/questions/for-lecture → ${r.status}`);
      const res = r.json as LectureQuestionsResponse;
      const item = res.items.find((i) => i.question_id === qid);
      const direct = !!item && item.link.relation === 'directly_covered' && item.link.answerable_from_lecture;
      const e = exp as { directly_covered: boolean; page_label?: string };
      const pages = item?.link.lecture_pages.map((p) => p.label_ar) ?? [];
      const ok = direct === e.directly_covered && (!e.page_label || pages.includes(e.page_label));
      return judge(ok, e, { relation: item?.link.relation ?? 'none', answerable: item?.link.answerable_from_lecture ?? false, pages, matching: res.matching.state }, e.directly_covered ? 'السؤال لم يُربط بالمحاضرة كما يجب.' : 'السؤال عُرض مغطى مباشرة وهو ليس كذلك.');
    }
    case 'image_match': {
      const atlas = source(h, c.source);
      const fig = new Map<string, number>();
      for (const r of h.ctx.db.all<{ id: string; caption: string | null }>('SELECT id, caption FROM image_asset WHERE version_id = ?', [atlas.versionId])) {
        const n = /(?:Figure|الشكل)\s*(\d+)/.exec(r.caption ?? '')?.[1];
        if (n) fig.set(r.id, Number(n));
      }
      const r = await h.inject('POST', '/api/media/images/match', { request: c.request });
      if (r.status !== 200) throw new Error(`POST /api/media/images/match → ${r.status}`);
      const res = r.json as ImageMatchResponse;
      // only figures of this atlas count (another source's images never match this request)
      const accepted = res.accepted.map((a) => fig.get(a.image.id)).filter((n): n is number => n !== undefined).sort((a, b) => a - b);
      const want = (exp as { accepted_figures: number[] }).accepted_figures;
      return judge(JSON.stringify(accepted) === JSON.stringify(want), want, accepted, 'الصور المقبولة تختلف عن الأمثلة الصحيحة.');
    }
    case 'image_caption': {
      const v = validateImageCandidate({ caption: c.caption, origin: 'source', image_kind: 'unknown' }, c.request);
      const want = (exp as { accepted: boolean }).accepted;
      return judge(v.accepted === want, { accepted: want }, { accepted: v.accepted, reasons: v.reasons_ar }, want ? 'صورة مطابقة استُبعدت.' : 'صورة غير مطابقة قُبلت.');
    }
    case 'claim_citation':
      return claimCitation(h, def);
    case 'claim_support':
      return claimSupport(h, def);
    case 'chat':
      return chat(h, def);
    case 'no_bidi_controls': {
      const s = source(h, c.source);
      const n = h.ctx.db
        .all<{ text: string }>('SELECT text FROM source_region WHERE version_id = ? AND text IS NOT NULL', [s.versionId])
        .filter((r) => BIDI_CONTROL.test(r.text)).length;
      return judge(n === 0, 0, n, `${n} منطقة نص تحتوي محارف تحكم ثنائية الاتجاه مخفية.`);
    }
    case 'detect_dir': {
      const d = detectDir(c.text);
      return judge(d === exp, exp, d, 'اتجاه الفقرة المكتشف خاطئ.');
    }
    case 'bidi_isolation': {
      const runs = segmentRuns(c.text, 'rtl');
      const joined = runs.map((r) => r.t).join('');
      const iso = runs.some((r) => r.dir === 'ltr' && r.t.trim() === c.term);
      const html = textToHtml(c.text);
      const htmlOk = html.includes(`<bdi dir="ltr" lang="en">${c.term.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</bdi>`) && !BIDI_CONTROL.test(html);
      const ok = joined === c.text && iso && htmlOk;
      return judge(ok, `«${c.term}» معزول (ltr) والترتيب المنطقي محفوظ`, { runs: runs.map((r) => `${r.dir ?? '-'}:${r.t}`), html: html.slice(0, 200) }, 'المصطلح أو القيمة غير معزول باتجاهه، أو تغيّر الترتيب المنطقي.');
    }
  }
}

// ───────────── evidence checks (deterministic validator; independent verifier through the provider) ─────────────
function lectureScope(h: EvalHarness) {
  return resolveScope(h.ctx, { mode: 'lecture_only', lecture_source_id: source(h, 'appendicitis').sourceId });
}

async function claimCitation(h: EvalHarness, def: EvalCaseDef): Promise<Verdict> {
  const c = def.check as Extract<EvalCaseDef['check'], { type: 'claim_citation' }>;
  const scope = lectureScope(h);
  const own = fromRegion(h.ctx, regionWith(h, 'appendicitis', 'Ultrasound is the first-line').id);
  let aliasMap: Record<string, string> = { E1: own.id };
  let cite: string[] = ['E1'];
  if (c.variant === 'unknown_alias') cite = ['E77'];
  if (c.variant === 'fabricated_id') cite = [own.id];
  if (c.variant === 'valid_plus_unknown') cite = ['E1', 'E77'];
  if (c.variant === 'out_of_scope') {
    // a buggy pack that handed out an alias for another lecture's evidence: the validator must still refuse it
    const foreign = fromRegion(h.ctx, regionWith(h, 'cholecystitis', c.needle).id);
    aliasMap = { E1: foreign.id };
    cite = ['E1'];
  }
  const sentence: GeneratedSentence = { text: c.text, claim: { support_type: 'directly_stated', evidence: cite } };
  const r = await validateClaims(h.ctx, { ownerType: 'content_block', ownerId: `eval-${def.id}`, sentences: [sentence], aliasMap, scope, entailment: 'off', persist: false });
  const s = r.sentences[0]!;
  const observed = { status: s.status, keep: s.keep, evidence_ids: s.evidence_ids.length, rejected_aliases: s.rejected_aliases, failed: s.checks.filter((x) => !x.passed).map((x) => x.check) };
  if (c.variant === 'valid_plus_unknown') {
    const unknownCited = s.evidence_ids.some((id) => id !== own.id) || !s.rejected_aliases.includes('E77');
    return judge(!unknownCited, def.expected, observed, 'الاسم المستعار المختلق تحول إلى استشهاد أو لم يُرفض.');
  }
  const kept = s.keep && s.status !== 'rejected' && s.evidence_ids.length > 0 && s.rejected_aliases.length === 0;
  const want = (def.expected as { kept: boolean }).kept;
  return judge(kept === want, def.expected, observed, want ? 'دليل صالح داخل النطاق رُفض (امتناع زائد).' : 'دليل غير صالح أو خارج النطاق قُبل استشهادًا.');
}

async function claimSupport(h: EvalHarness, def: EvalCaseDef): Promise<Verdict> {
  const c = def.check as Extract<EvalCaseDef['check'], { type: 'claim_support' }>;
  if (h.aiBlockedReasonAr) throw new EvalBlocked(h.aiBlockedReasonAr);
  const scope = lectureScope(h);
  const ev = fromRegion(h.ctx, regionWith(h, 'appendicitis', c.needle).id);
  if (h.provider) {
    h.provider.reset();
    h.provider.verdict = () => c.verdict;
  }
  const r = await validateClaims(h.ctx, {
    ownerType: 'content_block',
    ownerId: `eval-${def.id}`,
    sentences: [{ text: c.text, claim: { support_type: c.support, evidence: ['E1'] } }],
    aliasMap: { E1: ev.id },
    scope,
    entailment: 'ai',
    persist: false,
  });
  const s = r.sentences[0]!;
  const linked = s.status === 'linked';
  const want = (def.expected as { linked: boolean }).linked;
  return judge(
    linked === want,
    def.expected,
    { status: s.status, failed: s.checks.filter((x) => !x.passed).map((x) => x.check), verifier: r.entailment.used ? (h.provider ? `scripted:${c.verdict}` : r.entailment.model) : 'unavailable' },
    want ? 'ادعاء يدعمه الدليل لم يُربط به (رفض زائد).' : 'ادعاء لا يدعمه الدليل رُبط به.',
  );
}

async function chat(h: EvalHarness, def: EvalCaseDef): Promise<Verdict> {
  const c = def.check as Extract<EvalCaseDef['check'], { type: 'chat' }>;
  const e = def.expected as ChatExpectation;
  if (h.aiBlockedReasonAr) throw new EvalBlocked(h.aiBlockedReasonAr);
  const lecture = source(h, 'appendicitis');
  let anchor: Record<string, unknown> | null = null;
  if (c.anchorNeedle) {
    const reg = regionWith(h, 'appendicitis', c.anchorNeedle);
    anchor = { source_id: lecture.sourceId, version_id: lecture.versionId, page_id: reg.page_id, region_ids: [reg.id] };
  }
  const th = await h.inject('POST', '/api/studybook/threads', { scope: { mode: 'lecture_only', lecture_source_id: lecture.sourceId }, anchor, style: 'detailed' });
  if (th.status !== 200) throw new Error(`POST /api/studybook/threads → ${th.status}`);
  const threadId = (th.json as ChatThreadResponse).thread.id;
  const p = h.provider;
  const before = p ? p.callsFor('chat') : 0;
  if (p) {
    p.reset();
    if (c.verdict) p.verdict = () => c.verdict!;
    const s = c.script;
    if (s.kind === 'cite') p.once('chat', (req) => answerOf([{ text: s.text, evidence: [aliasFor(req, s.needle)], support: s.support }]));
    if (s.kind === 'fabricated') p.once('chat', () => answerOf([{ text: s.text, evidence: ['E77'] }]));
  }
  const r = await h.inject('POST', `/api/studybook/threads/${encodeURIComponent(threadId)}/messages`, { text: c.question });
  if (r.status !== 200 && p && p.errors.length) {
    // scripted mode: the server called the generator and the script could not answer (no script — the server did not
    // abstain where expected — or the expected evidence was not handed over). Nothing was shown; judged, not an error.
    const scriptErrors = p.errors.map((x) => (x as Error).message);
    const observed = { status: `http_${r.status}`, generator_calls: p.callsFor('chat') - before, script_errors: scriptErrors };
    if (e.supported_shown) return fail(e, observed, /no evidence containing/.test(scriptErrors[0] ?? '') ? `الاسترجاع لم يسلّم للمولّد الدليل المطلوب (${scriptErrors[0]}).` : 'استُدعي المولّد ولم تُعرض إجابة مرتبطة بدليل.');
    if (e.abstain_reason) return fail(e, observed, `المتوقع امتناع «${e.abstain_reason}» دون استدعاء المولّد، لكن الخادم استدعاه.`);
    return pass(e, observed);
  }
  if (r.status !== 200) throw new Error(`POST /api/studybook/threads/:id/messages → ${r.status}`);
  const answer = (r.json as ChatPostResponse).answer;
  const claims = Object.values(answer.artifact?.claims ?? {});
  const linked = claims.filter((x) => x.verification_status === 'linked').length;
  const supportedShown = answer.status === 'final' && linked > 0;
  const modelCalls = p ? p.callsFor('chat') - before : null;
  const scriptErrors = p ? p.errors.map((x) => (x as Error).message) : [];
  const observed = { status: answer.status, abstain: answer.abstain?.reason ?? null, linked_claims: linked, generator_calls: modelCalls, script_errors: scriptErrors };
  let ok = supportedShown === e.supported_shown;
  if (e.abstain_reason) ok &&= answer.status === 'abstained' && answer.abstain?.reason === e.abstain_reason;
  if (e.supported_shown && !ok) {
    const why = scriptErrors.length
      ? `الاسترجاع لم يسلّم للمولّد الدليل المطلوب (${scriptErrors[0]}).`
      : answer.status === 'abstained'
        ? `امتنع النظام (${answer.abstain?.reason ?? '—'}) مع وجود دليل واضح في المحاضرة.`
        : 'الإجابة المستشهدة الصحيحة لم تُعرض مرتبطة بدليل.';
    return fail(e, observed, why);
  }
  return judge(ok, e, observed, e.abstain_reason ? `المتوقع امتناع بسبب «${e.abstain_reason}».` : 'عُرض محتوى على أنه مدعوم دون دليل صالح.');
}
