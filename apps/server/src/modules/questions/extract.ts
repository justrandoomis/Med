// extract_questions job: parse a processed source version and persist its questions idempotently.
//  * identity of an occurrence = (source version, section_key, item_key) — re-extraction never duplicates;
//  * an unchanged block is left alone; a changed block of an extraction-made question gets a new version
//    (never overwriting), while a question the owner corrected/reviewed is NOT touched (review item instead);
//  * the same question (normalized stem + option SET) already in the vault → one question, one more
//    occurrence (AC-17); similar-but-different questions only become duplicate SUGGESTIONS (duplicates.ts).
import { type ExtractionSummaryView, type QuestionType } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { JobError } from '../../lib/errors';
import { sha256 } from '../../lib/hash';
import { newId } from '../../lib/ids';
import { bindKeys, type OccurrenceRef } from './keys';
import { refreshQuestion } from './lifecycle';
import { parseQuestions, PARSER_VERSION, type ParsedQuestion, type ParseResult, type ParserLine } from './parser';
import { loadParserLines } from './regions';
import { syncReviewItems, type DesiredItem } from './review';
import { insertVersion, deriveVersion, getVersionRow, optionRows, setCurrentVersion, type NewOption, type OccurrenceParse, type OccurrenceRow } from './store';
import { fingerprint, normPhrase, refersToImage } from './text';
import { richTextToPlain, type RichText } from '@medlevo/shared';

interface VersionInfo {
  id: string;
  source_id: string;
  processing_status: string;
  title: string;
  source_type: string;
  course_node_id: string | null;
  deleted_at: number | null;
}

interface Block {
  stem: string;
  stemRaw: string;
  options: Array<{ label: string; text: string; raw: string; regionId: string | null }>;
  rawText: string;
  pageIds: string[];
  regionIds: string[];
  boxes: Array<{ page_id: string; page_index: number; region_id: string | null; bbox: unknown }>;
  qtype: QuestionType;
  contentHash: string;
  fingerprint: string;
  parse: OccurrenceParse;
}

const LOW_OCR_CONFIDENCE = 0.7;

function uncertainReason(l: ParserLine): string | null {
  if (l.textOrigin === 'ocr' && (l.regionStatus === 'needs_review' || (l.confidence !== null && l.confidence < LOW_OCR_CONFIDENCE))) {
    return 'قراءة آلية (OCR) ضعيفة الثقة';
  }
  if (l.regionStatus === 'needs_review' || l.regionStatus === 'uncertain') return 'نص المنطقة معلَّم للمراجعة أثناء المعالجة';
  return null;
}

function buildBlock(q: ParsedQuestion): Block {
  const seen = new Set<string>();
  const rawLines: string[] = [];
  const pushRaw = (t: string, rid: string | null) => {
    const k = `${rid ?? ''}|${t}`;
    if (seen.has(k)) return;
    seen.add(k);
    rawLines.push(t);
  };
  const stemLines = q.stemRaw.split('\n');
  const stemLineObjs = q.lines.filter((l) => stemLines.includes(l.text));
  for (const t of stemLines) pushRaw(t, stemLineObjs.find((l) => l.text === t)?.regionId ?? null);
  for (const o of q.options) for (const l of o.lines) pushRaw(l.text, l.regionId);

  const all = [...q.lines, ...q.figures];
  const pageIds: string[] = [];
  const regionIds: string[] = [];
  const boxes: Block['boxes'] = [];
  for (const l of all) {
    if (l.pageId && !pageIds.includes(l.pageId)) pageIds.push(l.pageId);
    if (l.regionId && !regionIds.includes(l.regionId)) {
      regionIds.push(l.regionId);
      if (l.pageId) boxes.push({ page_id: l.pageId, page_index: l.pageIndex, region_id: l.regionId, bbox: l.bbox });
    }
  }
  const uncertain: OccurrenceParse['uncertain'] = [];
  for (const l of q.lines) {
    const r = uncertainReason(l);
    if (!r) continue;
    const opt = q.options.find((o) => o.lines.includes(l));
    if (opt) uncertain.push({ where: 'option', label: opt.label, reason: r });
    else if (!uncertain.some((u) => u.where === 'stem')) uncertain.push({ where: 'stem', label: null, reason: r });
  }
  const isTf = q.options.length === 2 && q.options.every((o) => /^(true|false|صح|خطأ|صحيح|خاطئ)$/i.test(o.text.trim()));
  const qtype: QuestionType = q.options.length === 0 ? 'short_answer' : isTf ? 'true_false' : 'sba';
  const options = q.options.map((o) => ({
    label: o.label,
    text: o.text,
    raw: o.lines.map((l) => l.text).join('\n'),
    regionId: o.lines[0]?.regionId ?? null,
  }));
  const rawText = rawLines.join('\n');
  return {
    stem: q.stem,
    stemRaw: q.stemRaw,
    options,
    rawText,
    pageIds,
    regionIds,
    boxes,
    qtype,
    contentHash: sha256(JSON.stringify({ s: q.stem, o: options.map((o) => [o.label, o.text]), r: rawText, t: q.sectionTitle, f: q.figures.map((f) => f.regionId) })),
    fingerprint: fingerprint(q.stem, q.options.map((o) => o.text)),
    parse: { issues: q.issues, figure_region_ids: q.figures.map((f) => f.regionId).filter((x): x is string => !!x), uncertain },
  };
}

function toNewOptions(block: Block, previous: Array<{ option_key: string; text: string }> = []): NewOption[] {
  const used = new Set<string>();
  let next = Math.max(0, ...previous.map((p) => Number(p.option_key.replace(/^o/, '')) || 0)) + 1;
  return block.options.map((o, i) => {
    // keep the option's stable key when its text is unchanged; otherwise a fresh key (never reused)
    const same = previous.find((p) => !used.has(p.option_key) && normPhrase(p.text) === normPhrase(o.text));
    let key: string;
    if (same) key = same.option_key;
    else if (previous.length === 0) key = `o${i + 1}`;
    else key = `o${next++}`;
    used.add(key);
    return { option_key: key, source_label: o.label, text: o.text, raw_text: o.raw, region_id: o.regionId };
  });
}

/** Labels of THIS occurrence mapped to the option keys of the question version it attaches to. */
function labelsFor(block: Block, versionOptions: Array<{ option_key: string; text: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  block.options.forEach((o, i) => {
    const hit = versionOptions.find((v) => !used.has(v.option_key) && normPhrase(v.text) === normPhrase(o.text)) ?? versionOptions[i];
    if (hit && !used.has(hit.option_key)) {
      used.add(hit.option_key);
      out[hit.option_key] = o.label;
    }
  });
  return out;
}

function versionOptionTexts(ctx: AppContext, versionId: string): Array<{ option_key: string; text: string }> {
  return optionRows(ctx, versionId).map((o) => ({ option_key: o.option_key, text: richTextToPlain(fromJson<RichText | null>(o.text_json, null)) }));
}

const identOf = (sectionKey: string, itemKey: string) => `${sectionKey}\u0000${itemKey}`;

export interface ExtractionRun {
  summary: ExtractionSummaryView;
  createdQuestionIds: string[];
  touchedQuestionIds: string[];
}

export function loadVersionInfo(ctx: AppContext, versionId: string): VersionInfo {
  const v = ctx.db.get<VersionInfo>(
    `SELECT v.id, v.source_id, v.processing_status, s.title, s.source_type, s.course_node_id, s.deleted_at
       FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ?`,
    [versionId],
  );
  if (!v) throw new JobError('VERSION_NOT_FOUND', 'نسخة المصدر غير موجودة (ربما حُذفت نهائيًا).', { retryable: false });
  return v;
}

export function runExtraction(ctx: AppContext, versionId: string, jobId: string | null): ExtractionRun {
  const info = loadVersionInfo(ctx, versionId);
  if (info.deleted_at !== null) throw new JobError('SOURCE_TRASHED', 'المصدر في سلة المحذوفات؛ لا تُستخرج أسئلته حتى تستعيده.', { retryable: false });
  if (info.processing_status === 'pending' || info.processing_status === 'processing') {
    throw new JobError('NOT_PROCESSED', 'لم تنتهِ معالجة هذا المصدر بعد؛ تُستخرج الأسئلة تلقائيًا عند انتهائها.', { retryable: false });
  }
  const parsed = parseQuestions(loadParserLines(ctx, versionId));
  return persistExtraction(ctx, info, parsed, jobId);
}

export function persistExtraction(ctx: AppContext, info: VersionInfo, parsed: ParseResult, jobId: string | null): ExtractionRun {
  const now = ctx.clock.now();
  const created: string[] = [];
  const touched = new Set<string>();
  let attached = 0;
  const extractionItems = new Map<string, DesiredItem[]>();
  const addItem = (qid: string, item: DesiredItem) => {
    const list = extractionItems.get(qid) ?? [];
    list.push(item);
    extractionItems.set(qid, list);
  };

  const summary = ctx.db.tx(() => {
    const existing = ctx.db.all<OccurrenceRow>('SELECT * FROM question_occurrence WHERE source_version_id = ?', [info.id]);
    const byIdent = new Map(existing.map((o) => [identOf(o.section_key, o.item_key ?? o.printed_number ?? ''), o]));
    const occRefs = new Map<string, OccurrenceRef>();
    const seen = new Set<string>();

    for (const q of parsed.questions) {
      const ident = identOf(q.sectionKey, q.itemKey);
      if (seen.has(ident)) continue;
      seen.add(ident);
      const block = buildBlock(q);
      const occ = byIdent.get(ident);
      const location = [
        toJson(block.pageIds),
        toJson(block.regionIds),
        toJson(block.boxes),
        block.rawText,
        q.sectionTitle,
        q.ord,
        toJson(block.parse),
      ] as const;

      if (occ) {
        touched.add(occ.question_id);
        const qrow = ctx.db.get<{ current_version_id: string; deleted_at: number | null }>('SELECT current_version_id, deleted_at FROM question WHERE id = ?', [occ.question_id]);
        let versionForOcc = occ.question_version_id;
        let labels = fromJson<Record<string, string>>(occ.option_labels_json, {}) ?? {};
        if (occ.content_hash !== block.contentHash && qrow && qrow.deleted_at === null) {
          const cur = getVersionRow(ctx, qrow.current_version_id);
          const ownerTouched = cur.created_by === 'owner' || cur.extraction_status === 'owner_reviewed' || cur.answer_status === 'owner_key';
          if (ownerTouched) {
            addItem(occ.question_id, {
              kind: 'question_validation_failed',
              code: `extraction_changed:${occ.id}`,
              reason: `تغيّر النص المستخرج لهذا السؤال من «${info.title}» بعد إعادة المعالجة، ونسختك التي راجعتها أو صححتها بقيت كما هي. قارن النصين وقرر.`,
              details: { occurrence_id: occ.id, version_id: info.id },
            });
          } else if (cur.fingerprint !== block.fingerprint || cur.stem_raw !== block.stemRaw) {
            const prevOpts = versionOptionTexts(ctx, cur.id);
            const d = deriveVersion(ctx, cur, {
              kind: 'raw_extraction',
              createdBy: 'extraction',
              stemText: block.stem,
              stemRaw: block.stemRaw,
              qtype: block.qtype,
              options: toNewOptions(block, prevOpts),
              extractionStatus: 'extracted',
              validation: null,
              jobId,
              note: `أُعيد استخراج السؤال من «${info.title}» بعد تغيّر النص في المصدر؛ النسخة السابقة محفوظة.`,
            });
            setCurrentVersion(ctx, occ.question_id, d.versionId);
            versionForOcc = d.versionId;
            labels = labelsFor(block, versionOptionTexts(ctx, d.versionId));
          } else {
            labels = labelsFor(block, versionOptionTexts(ctx, cur.id));
          }
        }
        ctx.db.run(
          `UPDATE question_occurrence SET page_ids_json = ?, region_ids_json = ?, boxes_json = ?, raw_text = ?, section_title = ?, ord = ?, parse_json = ?,
             content_hash = ?, status = 'current', question_version_id = ?, option_labels_json = ?, printed_number = ? WHERE id = ?`,
          [...location, block.contentHash, versionForOcc, toJson(labels), q.printedNumber, occ.id],
        );
        occRefs.set(ident, { id: occ.id, questionId: occ.question_id, labels });
        continue;
      }

      // new occurrence: the same question already in the vault? (normalized stem + option set, any version)
      // A question that depends on a picture is never merged automatically: the same words with a different
      // image are a different question (§36) — it can only become a duplicate SUGGESTION.
      const dependsOnImage = block.parse.figure_region_ids.length > 0 || refersToImage(block.stem);
      const dup = dependsOnImage ? undefined : ctx.db.get<{ id: string; current_version_id: string }>(
        `SELECT q.id, q.current_version_id FROM question q
          WHERE q.deleted_at IS NULL AND q.status <> 'retired' AND q.origin_type = 'source'
            AND EXISTS (SELECT 1 FROM question_version v WHERE v.question_id = q.id AND v.fingerprint = ?)
          ORDER BY q.created_at LIMIT 1`,
        [block.fingerprint],
      );
      let questionId: string;
      let versionId: string;
      let labels: Record<string, string>;
      if (dup) {
        questionId = dup.id;
        versionId = dup.current_version_id;
        labels = labelsFor(block, versionOptionTexts(ctx, versionId));
        attached++;
      } else {
        questionId = newId(now);
        ctx.db.run(
          `INSERT INTO question (id, origin_type, current_version_id, status, course_node_id, created_at, updated_at) VALUES (?, 'source', NULL, 'needs_review', ?, ?, ?)`,
          [questionId, info.course_node_id, now, now],
        );
        const options = toNewOptions(block);
        const v = insertVersion(ctx, {
          questionId,
          kind: 'raw_extraction',
          derivedFrom: null,
          qtype: block.qtype,
          stemText: block.stem,
          stemRaw: block.stemRaw,
          options,
          answerStatus: block.qtype === 'short_answer' ? 'missing_key' : 'missing_key',
          correctOptionKeys: null,
          keyDetails: null,
          explanation: q.explanation,
          validation: null,
          extractionStatus: 'extracted',
          createdBy: 'extraction',
          jobId,
          note: `استُخرج من «${info.title}».`,
        });
        versionId = v.versionId;
        ctx.db.run('UPDATE question SET current_version_id = ? WHERE id = ?', [versionId, questionId]);
        labels = Object.fromEntries(options.map((o) => [o.option_key, o.source_label ?? '']));
        created.push(questionId);
      }
      const occId = newId(now);
      ctx.db.run(
        `INSERT INTO question_occurrence (id, question_id, question_version_id, source_id, source_version_id, section_key, printed_number, page_ids_json,
           region_ids_json, created_at, item_key, section_title, option_labels_json, raw_text, boxes_json, content_hash, ord, status, parse_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)`,
        [occId, questionId, versionId, info.source_id, info.id, q.sectionKey, q.printedNumber, toJson(block.pageIds), toJson(block.regionIds), now, q.itemKey, q.sectionTitle, toJson(labels), block.rawText, toJson(block.boxes), block.contentHash, q.ord, toJson(block.parse)],
      );
      occRefs.set(ident, { id: occId, questionId, labels });
      touched.add(questionId);
    }

    // occurrences of this version that the new extraction no longer finds: kept (attempts may use them)
    let notFound = 0;
    for (const [ident, o] of byIdent) {
      if (seen.has(ident)) continue;
      if (o.status !== 'not_found') ctx.db.run(`UPDATE question_occurrence SET status = 'not_found' WHERE id = ?`, [o.id]);
      notFound++;
      touched.add(o.question_id);
      addItem(o.question_id, {
        kind: 'question_validation_failed',
        code: `occurrence_missing:${o.id}`,
        reason: `لم يعد هذا السؤال (${o.printed_number ? `رقم ${o.printed_number}` : 'بلا رقم'}) يُستخرج من «${info.title}» بعد إعادة المعالجة؛ بقي في الخزنة مع محاولاتك. تحقق من الصفحة الأصلية.`,
        details: { occurrence_id: o.id, version_id: info.id },
      });
    }

    // keys bound by (version, section, number)
    const bind = bindKeys(ctx, info.id, parsed, occRefs);
    const keyItems: DesiredItem[] = bind.unbound.map((u) => ({
      kind: u.reason === 'ambiguous_section' ? 'conflicting_key' : 'question_validation_failed',
      code: `unbound:${u.entryId}`,
      reason:
        u.reason === 'ambiguous_section'
          ? u.sectionLabel
            ? `مفتاح «القسم ${u.sectionLabel} — السؤال ${u.printedNumber}» في «${info.title}» (كتلة المفتاح ${u.keyBlock}): في الملف أكثر من قسم بالتسمية «${u.sectionLabel}»؛ لم يُربط تلقائيًا كي لا يُطبَّق على سؤال من قسم آخر. إن كنت متأكدًا فحدد المفتاح بنفسك للسؤال المقصود.`
            : `مفتاح السؤال ${u.printedNumber} في «${info.title}» (كتلة المفتاح ${u.keyBlock}) بلا قسم محدد، والملف فيه عدة أقسام يبدأ ترقيمها من 1؛ لم يُربط تلقائيًا كي لا يُطبَّق على سؤال من قسم آخر. إن كنت متأكدًا فحدد المفتاح بنفسك للسؤال المقصود.`
          : `مفتاح «${u.sectionLabel ? `القسم ${u.sectionLabel} — ` : ''}السؤال ${u.printedNumber}» في «${info.title}» لا يقابله سؤال مستخرج بهذا الرقم في هذا القسم؛ قد يكون السؤال مفقودًا أو غير مقروء.`,
      details: { entry_id: u.entryId, binding: u.reason },
    }));
    syncReviewItems(ctx, 'source_version', info.id, 'keys', keyItems, info.source_id, null);

    // a replaced question source: once this version (in force) has questions, the questions of its earlier
    // versions are re-checked (their keys stop voting; questions it no longer contains are flagged, never deleted)
    if (parsed.questions.length > 0) {
      ctx.db.run(
        `INSERT INTO question_extraction (version_id, source_id, status, summary_json, job_id, parser_version, updated_at) VALUES (?, ?, 'completed', '{}', ?, ?, ?)
         ON CONFLICT(version_id) DO NOTHING`,
        [info.id, info.source_id, jobId, PARSER_VERSION, now],
      );
      for (const r of ctx.db.all<{ question_id: string }>(
        `SELECT DISTINCT o.question_id FROM question_occurrence o JOIN question q ON q.id = o.question_id
          WHERE o.source_id = ? AND o.source_version_id <> ? AND q.deleted_at IS NULL`,
        [info.source_id, info.id],
      ))
        touched.add(r.question_id);
    }

    for (const qid of touched) {
      syncReviewItems(ctx, 'question', qid, `extraction:${info.id}`, extractionItems.get(qid) ?? [], info.source_id, qid);
      refreshQuestion(ctx, qid, { jobId });
    }

    // summary
    const sections = parsed.sections.map((s) => ({ key: s.key, title: s.title, questions: parsed.questions.filter((q) => q.sectionKey === s.key).length }));
    const needsReview = ctx.db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT q.id) AS n FROM question q JOIN question_occurrence o ON o.question_id = q.id
        WHERE o.source_version_id = ? AND (q.status = 'needs_review' OR EXISTS (SELECT 1 FROM review_queue_item r WHERE r.status = 'open'
          AND r.entity_type = 'question' AND r.entity_id = q.id))`,
      [info.id],
    )!.n;
    const total = parsed.questions.length;
    const status: ExtractionSummaryView['status'] = total === 0 ? 'nothing_found' : needsReview > 0 || bind.unbound.length > 0 ? 'needs_review' : 'completed';
    const message =
      total === 0
        ? 'لم يُعثر على أسئلة مرقمة أو خيارات في هذا المصدر. إن كان فيه أسئلة، فقد تكون الصفحات غير مقروءة أو بصيغة غير معروفة؛ أضفها بالإضافة السريعة.'
        : `استُخرج ${total === 1 ? 'سؤال واحد' : `${total} أسئلة`}${sections.length > 1 ? ` في ${sections.length} أقسام` : ''}` +
          `${attached ? `، منها ${attached} موجودة مسبقًا في خزنتك (أضيف لها موضع ظهور جديد)` : ''}` +
          `؛ مفاتيح مربوطة: ${bind.bound}${bind.unbound.length ? `، غير مربوطة: ${bind.unbound.length}` : ''}${bind.marks ? `، علامات غير رسمية: ${bind.marks}` : ''}` +
          `${needsReview ? `؛ ${needsReview} تحتاج مراجعتك` : ''}.`;
    const view: ExtractionSummaryView = {
      version_id: info.id,
      source_id: info.source_id,
      status,
      questions: total,
      new_questions: created.length,
      exact_duplicates_attached: attached,
      sections,
      key_blocks: parsed.keyBlocks.length,
      keys_bound: bind.bound,
      keys_unbound: bind.unbound.length,
      unofficial_marks: bind.marks,
      needs_review: needsReview,
      not_found_again: notFound,
      message_ar: message,
      updated_at: now,
    };
    ctx.db.run(
      `INSERT INTO question_extraction (version_id, source_id, status, summary_json, job_id, parser_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(version_id) DO UPDATE SET status = excluded.status, summary_json = excluded.summary_json, job_id = excluded.job_id,
         parser_version = excluded.parser_version, updated_at = excluded.updated_at`,
      [info.id, info.source_id, status, toJson(view), jobId, PARSER_VERSION, now],
    );
    ctx.audit.record({
      entityType: 'source_version',
      entityId: info.id,
      action: 'extract_questions',
      summary: message,
      after: { questions: total, new_questions: created.length, attached, keys_bound: bind.bound, keys_unbound: bind.unbound.length },
      actor: jobId ? 'job' : 'owner',
      jobId: jobId ?? undefined,
    });
    return view;
  });
  return { summary, createdQuestionIds: created, touchedQuestionIds: [...touched] };
}

export function extractionSummary(ctx: AppContext, versionId: string): ExtractionSummaryView | null {
  const row = ctx.db.get<{ summary_json: string }>('SELECT summary_json FROM question_extraction WHERE version_id = ?', [versionId]);
  return row ? fromJson<ExtractionSummaryView>(row.summary_json, null) : null;
}
