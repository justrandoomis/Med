// Answer keys (§34; AC-12, AC-13, AC-14, AC-15). Keys are bound by (source version, section_key, printed
// number) — never by the number alone. Several official keys for the same question that disagree make the
// question `conflicting_key` (both kept verbatim). Circled / handwritten marks are stored as UNOFFICIAL marks
// (origin_known = 0) and never become the answer.
import type { AnswerStatus, KeyBinding } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { newId } from '../../lib/ids';
import type { ParseResult, ParsedKey, ParsedQuestion } from './parser';
import { occurrenceVersionState, optionRows, pageLabel, stemText, type VersionRow } from './store';
import { labelInfo } from './text';
import { richTextToPlain, type RichText } from '@medlevo/shared';

export interface OccurrenceRef {
  id: string;
  questionId: string;
  /** option_key → label as printed in this occurrence */
  labels: Record<string, string>;
}

const ident = (sectionKey: string, itemKey: string) => `${sectionKey}\u0000${itemKey}`;

interface EntryInput {
  sectionKey: string;
  printedNumber: string;
  keyLabel: string;
  markKind: 'printed_key' | 'key_table' | 'circled_option' | 'handwritten';
  originKnown: boolean;
  keyBlock: number;
  binding: KeyBinding;
  sectionTitle: string | null;
  rawText: string;
  pageId: string | null;
  regionId: string | null;
  occurrenceId: string | null;
}

export interface BindResult {
  bound: number;
  unbound: Array<{ entryId: string; reason: 'ambiguous_section' | 'no_matching_question'; printedNumber: string; sectionLabel: string | null; keyBlock: number }>;
  marks: number;
}

/** Decide the section of a parsed key, never guessing between sections (AC-12). */
export function keySection(k: ParsedKey, parsed: ParseResult): { sectionKey: string | null; binding: KeyBinding } {
  if (k.inlineFor) return { sectionKey: k.inlineFor.sectionKey, binding: 'bound' };
  const withQuestions = parsed.sections.map((s) => s.key);
  if (k.sectionLabel !== null) {
    // sections printed with the same label («Part A» of two papers → keys 'A' and 'A-3'): the label alone does
    // not say which one the key belongs to → never guessed
    const byBase = withQuestions.filter((s) => s.replace(/-\d+$/, '') === k.sectionLabel);
    if (byBase.length > 1) return { sectionKey: null, binding: 'ambiguous_section' };
    if (byBase.length === 1) return { sectionKey: byBase[0]!, binding: 'bound' };
    if (withQuestions.includes(k.sectionLabel)) return { sectionKey: k.sectionLabel, binding: 'bound' };
    return { sectionKey: k.sectionLabel, binding: 'no_matching_question' };
  }
  if (withQuestions.length === 1) return { sectionKey: withQuestions[0]!, binding: 'bound' };
  const block = parsed.keyBlocks.find((b) => b.ordinal === k.keyBlock);
  // a key printed between two sections (after section S's questions, before the next section) belongs to S
  if (block && block.followedBySection && k.afterSectionKey !== null && withQuestions.includes(k.afterSectionKey)) {
    return { sectionKey: k.afterSectionKey, binding: 'bound' };
  }
  return { sectionKey: null, binding: 'ambiguous_section' };
}

/**
 * Replace the key entries of a version with the parsed ones (stable ids per (section, number, kind, block)),
 * binding each to the occurrence of the same version + section + number.
 */
export function bindKeys(ctx: AppContext, versionId: string, parsed: ParseResult, occurrences: Map<string, OccurrenceRef>): BindResult {
  const now = ctx.clock.now();
  const inputs: EntryInput[] = [];
  const result: BindResult = { bound: 0, unbound: [], marks: 0 };
  for (const k of parsed.keys) {
    const { sectionKey, binding: b0 } = keySection(k, parsed);
    let binding = b0;
    let occ: OccurrenceRef | null = null;
    if (sectionKey !== null && binding === 'bound') {
      occ = occurrences.get(ident(sectionKey, k.inlineFor?.itemKey ?? k.printedNumber)) ?? null;
      if (!occ) binding = 'no_matching_question';
    }
    inputs.push({
      // an unbound key keeps its printed section label in its identity (two ambiguous labels never collide)
      sectionKey: sectionKey ?? `?${k.keyBlock}${k.sectionLabel !== null ? `:${k.sectionLabel}` : ''}`,
      printedNumber: k.printedNumber,
      keyLabel: k.keyLabel,
      markKind: k.markKind,
      originKnown: k.originKnown,
      keyBlock: k.keyBlock,
      binding,
      sectionTitle: k.sectionTitle,
      rawText: k.rawText,
      pageId: k.line.pageId,
      regionId: k.line.regionId,
      occurrenceId: occ?.id ?? null,
    });
  }
  // unofficial marks on options (circle / tick) — recorded, never official (AC-13)
  for (const q of parsed.questions) {
    for (const o of q.options) {
      if (!o.mark) continue;
      const occ = occurrences.get(ident(q.sectionKey, q.itemKey)) ?? null;
      const line = o.lines[0]!;
      inputs.push({
        sectionKey: q.sectionKey,
        printedNumber: q.printedNumber ?? q.itemKey,
        keyLabel: o.label,
        markKind: o.mark,
        originKnown: false,
        keyBlock: 0,
        binding: 'unofficial',
        sectionTitle: q.sectionTitle,
        rawText: line.text,
        pageId: line.pageId,
        regionId: line.regionId,
        occurrenceId: occ?.id ?? null,
      });
    }
  }

  const existing = ctx.db.all<{ id: string; section_key: string; printed_number: string; mark_kind: string; key_block: number }>(
    'SELECT id, section_key, printed_number, mark_kind, key_block FROM answer_key_entry WHERE source_version_id = ?',
    [versionId],
  );
  const keyOf = (e: { section_key: string; printed_number: string; mark_kind: string; key_block: number }) =>
    `${e.section_key}\u0000${e.printed_number}\u0000${e.mark_kind}\u0000${e.key_block}`;
  const byKey = new Map(existing.map((e) => [keyOf(e), e.id]));
  const keep = new Set<string>();
  for (const e of inputs) {
    const k = keyOf({ section_key: e.sectionKey, printed_number: e.printedNumber, mark_kind: e.markKind, key_block: e.keyBlock });
    if (keep.has(k)) continue; // the same block printing the same number twice: first one wins (kept verbatim in raw_text)
    keep.add(k);
    const id = byKey.get(k);
    if (id) {
      ctx.db.run(
        `UPDATE answer_key_entry SET key_label = ?, origin_known = ?, page_id = ?, region_id = ?, matched_occurrence_id = ?, binding = ?, section_title = ?, raw_text = ?
          WHERE id = ?`,
        [e.keyLabel, e.originKnown ? 1 : 0, e.pageId, e.regionId, e.occurrenceId, e.binding, e.sectionTitle, e.rawText, id],
      );
    } else {
      const nid = newId(now);
      byKey.set(k, nid);
      ctx.db.run(
        `INSERT INTO answer_key_entry (id, source_version_id, section_key, printed_number, key_label, mark_kind, origin_known, page_id, region_id,
           matched_occurrence_id, created_at, key_block, binding, section_title, raw_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [nid, versionId, e.sectionKey, e.printedNumber, e.keyLabel, e.markKind, e.originKnown ? 1 : 0, e.pageId, e.regionId, e.occurrenceId, now, e.keyBlock, e.binding, e.sectionTitle, e.rawText],
      );
    }
    if (e.binding === 'bound') result.bound++;
    else if (e.binding === 'unofficial') result.marks++;
    else {
      const printedLabel = e.sectionKey.startsWith('?') ? (/^\?\d+:(.+)$/.exec(e.sectionKey)?.[1] ?? null) : e.sectionKey;
      result.unbound.push({ entryId: byKey.get(k)!, reason: e.binding, printedNumber: e.printedNumber, sectionLabel: printedLabel, keyBlock: e.keyBlock });
    }
  }
  for (const e of existing) if (!keep.has(keyOf(e))) ctx.db.run('DELETE FROM answer_key_entry WHERE id = ?', [e.id]);
  return result;
}

/** Map a printed key label to the option key of an occurrence (same script; Latin ↔ Arabic by abjad order). */
export function optionKeyForLabel(labels: Record<string, string>, keyLabel: string): { optionKey: string | null; crossScript: boolean } {
  const k = labelInfo(keyLabel);
  if (!k) return { optionKey: null, crossScript: false };
  const entries = Object.entries(labels).map(([optionKey, label]) => ({ optionKey, info: labelInfo(label) }));
  const same = entries.find((e) => e.info && e.info.script === k.script && e.info.index === k.index);
  if (same) return { optionKey: same.optionKey, crossScript: false };
  const scripts = new Set(entries.map((e) => e.info?.script));
  if (k.script !== 'digit' && scripts.size === 1 && !scripts.has('digit') && !scripts.has(k.script)) {
    const cross = entries.find((e) => e.info && e.info.index === k.index);
    if (cross) return { optionKey: cross.optionKey, crossScript: true };
  }
  return { optionKey: null, crossScript: false };
}

export interface AnswerResolution {
  status: AnswerStatus;
  /** stable option keys */
  correctOptionKeys: string[] | null;
  keyEntryIds: string[];
  conflictAr: string | null;
  notesAr: string | null;
  unofficialMarks: Array<{ label: string; kind: string; entryId: string }>;
  /** the official key was read by OCR with low confidence — the owner must confirm it against the page */
  uncertainKeyAr?: string | null;
}

interface BoundEntry {
  id: string;
  key_label: string;
  mark_kind: string;
  origin_known: number;
  binding: string;
  key_block: number;
  page_id: string | null;
  option_labels_json: string | null;
  source_title: string;
  page_index: number | null;
  printed_label: string | null;
  page_kind: string | null;
  source_version_id: string;
  occurrence_id: string;
  key_text_origin: string | null;
  key_confidence: number | null;
  key_region_status: string | null;
}

/** A printed key read by OCR with low confidence (or marked uncertain by processing) is not trusted silently. */
const LOW_KEY_CONFIDENCE = 0.7;
function keyReadUncertain(e: Pick<BoundEntry, 'key_text_origin' | 'key_confidence' | 'key_region_status'>): boolean {
  if (e.key_region_status === 'needs_review' || e.key_region_status === 'uncertain') return true;
  return e.key_text_origin === 'ocr' && e.key_confidence !== null && e.key_confidence < LOW_KEY_CONFIDENCE;
}

/**
 * Combine every bound key of every occurrence of the question (AC-15: disagreement → conflicting_key). When a
 * question source was replaced by a new version, only the occurrences of the version in force vote: a key
 * corrected in the new version is a correction, not a conflict with the old printing.
 */
export function resolveAnswer(ctx: AppContext, questionId: string, current: VersionRow): AnswerResolution {
  const all = ctx.db.all<BoundEntry>(
    `SELECT e.id, e.key_label, e.mark_kind, e.origin_known, e.binding, e.key_block, e.page_id, e.source_version_id, o.id AS occurrence_id, o.option_labels_json,
            s.title AS source_title, p.page_index, p.printed_label, p.kind AS page_kind,
            rg.text_origin AS key_text_origin, rg.confidence AS key_confidence, rg.status AS key_region_status
       FROM answer_key_entry e
       JOIN question_occurrence o ON o.id = e.matched_occurrence_id
       JOIN source s ON s.id = o.source_id
       LEFT JOIN source_page p ON p.id = e.page_id
       LEFT JOIN source_region rg ON rg.id = e.region_id
      WHERE o.question_id = ? AND s.deleted_at IS NULL
      ORDER BY e.created_at, e.key_block`,
    [questionId],
  );
  const state = occurrenceVersionState(ctx, questionId);
  const rows = state.inForce.size > 0 ? all.filter((e) => state.inForce.has(e.occurrence_id)) : all;
  const options = optionRows(ctx, current.id);
  const optText = new Map(options.map((o) => [o.option_key, richTextToPlain(fromJson<RichText | null>(o.text_json, null))]));
  const votes = new Map<string, BoundEntry[]>();
  const notes: string[] = [];
  const unmapped: string[] = [];
  const marks: AnswerResolution['unofficialMarks'] = [];
  const where = (e: BoundEntry) => {
    const page = e.page_index !== null ? pageLabel({ id: e.page_id ?? '', page_index: e.page_index, printed_label: e.printed_label, kind: e.page_kind ?? 'page' }) : '';
    const what = e.mark_kind === 'key_table' ? `جدول المفتاح ${e.key_block}` : `المفتاح ${e.key_block}`;
    return `${what} في «${e.source_title}»${page ? ` (${page})` : ''}`;
  };
  for (const e of rows) {
    if (e.binding === 'unofficial' || e.origin_known !== 1) {
      if (e.binding === 'unofficial') marks.push({ label: e.key_label, kind: e.mark_kind, entryId: e.id });
      continue;
    }
    if (e.binding !== 'bound') continue;
    const labels = fromJson<Record<string, string>>(e.option_labels_json, {}) ?? {};
    const { optionKey, crossScript } = optionKeyForLabel(labels, e.key_label);
    if (!optionKey) {
      unmapped.push(`${where(e)} يذكر «${e.key_label}» ولا يوجد خيار بهذه التسمية في السؤال`);
      continue;
    }
    if (crossScript) notes.push(`${where(e)} كُتب بالحرف «${e.key_label}» وطُبّق على الخيار «${labels[optionKey]}» (الترتيب نفسه).`);
    const list = votes.get(optionKey) ?? [];
    list.push(e);
    votes.set(optionKey, list);
  }
  // keys of a replaced version of the source that differ from the version in force: reported, never voting
  const inForceLabels = new Set(rows.filter((e) => e.binding === 'bound' && e.origin_known === 1).map((e) => e.key_label));
  const ignored = all.filter((e) => !rows.includes(e) && e.binding === 'bound' && e.origin_known === 1 && !inForceLabels.has(e.key_label));
  if (ignored.length > 0) {
    notes.push(`النسخة السابقة من المصدر كانت تختار «${[...new Set(ignored.map((e) => e.key_label))].join('، ')}»؛ يُعتمد مفتاح النسخة الحالية.`);
  }
  const keyEntryIds = rows.filter((r) => r.binding === 'bound' && r.origin_known === 1).map((r) => r.id);
  if (votes.size === 0) {
    return {
      status: unmapped.length ? 'unresolved' : 'missing_key',
      correctOptionKeys: null,
      keyEntryIds,
      conflictAr: unmapped.length ? `${unmapped.join('؛ ')}.` : null,
      notesAr: notes.length ? notes.join(' ') : null,
      unofficialMarks: marks,
    };
  }
  if (votes.size === 1 && unmapped.length === 0) {
    const uncertain = [...votes.values()][0]!.filter(keyReadUncertain);
    const uncertainKeyAr = uncertain.length
      ? `مفتاح المصدر («${uncertain[0]!.key_label}» في ${where(uncertain[0]!)}) مقروء آليًا (OCR) بثقة منخفضة — قارنه بالصفحة الأصلية قبل اعتماده في التقييم.`
      : null;
    return { status: 'source_key', correctOptionKeys: [...votes.keys()], keyEntryIds, conflictAr: null, notesAr: notes.length ? notes.join(' ') : null, unofficialMarks: marks, uncertainKeyAr };
  }
  const parts = [...votes.entries()].map(([k, list]) => `${list.map(where).join(' و')} يختار «${list[0]!.key_label}» (${optText.get(k) ?? k})`);
  return {
    status: 'conflicting_key',
    correctOptionKeys: null,
    keyEntryIds,
    conflictAr: `مفاتيح المصدر متعارضة: ${[...parts, ...unmapped].join('، بينما ')}. لم يُصحَّح شيء تلقائيًا؛ الأصل محفوظ كما طُبع.`,
    notesAr: notes.length ? notes.join(' ') : null,
    unofficialMarks: marks,
  };
}

/** Questions in a version whose occurrence has options marked by hand (for the review reason). */
export function questionHasMarks(q: ParsedQuestion): boolean {
  return q.options.some((o) => o.mark !== null);
}

export { stemText };
