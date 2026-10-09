// Dependencies & Content Change Alerts (§18, AC-26).
//
//  * record(): what a derived thing (artifact, content block, question version, flashcard, exam, message)
//    depends on — source versions and, when known, the exact regions.
//  * onSourceVersionChanged(): a replacement / corrected version (or re-processed pages of the same version)
//    produces ONE content_alert listing every dependent with its impact:
//      still_valid        — the cited text is unchanged in the new version (or only the layout changed)
//      needs_regeneration — generated content whose cited text changed / disappeared
//      needs_review       — owner/extracted material (questions, cards) or not comparable yet
//    Non-frozen artifacts become 'stale' (never silently rewritten). Frozen ones (artifact.is_frozen or Source
//    Freeze on the version they use) keep their version and get a visible warning (§18).
//  * The comparison is deterministic (normalized region texts + critical tokens). While the new version is
//    not processed yet the alert says so; reconcileAlerts() completes it once processing is done, and turns
//    finished page re-processing jobs into alerts (content_alert_job keeps that idempotent).
import {
  ALERT_IMPACT_LABELS_AR,
  ALERT_SEVERITY_LABELS_AR,
  CONTENT_ALERT_KIND_LABELS_AR,
  PROCESS_JOB_KIND,
  type AlertImpact,
  type ContentAlertItemView,
  type ContentAlertKind,
  type ContentAlertView,
  type VersionChangeSummary,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { extractCriticalTokens, matchNormalize } from './critical';
import { pagesAr } from './retrieval';

export const DEPENDENT_TYPES = ['artifact', 'content_block', 'question_version', 'flashcard', 'exam', 'message', 'case'] as const;

// ───────── record ─────────
/**
 * Record dependencies (idempotent). Region ids are resolved to their version; versions without regions are
 * recorded at version level. Unknown versions/regions are ignored (returns the number of new rows).
 */
export function recordDependencies(ctx: AppContext, dependentType: string, dependentId: string, versionIds: string[], regionIds: string[] = []): number {
  const now = ctx.clock.now();
  return ctx.db.tx(() => {
    const existing = new Set(
      ctx.db
        .all<{ v: string; r: string | null }>('SELECT source_version_id AS v, region_id AS r FROM artifact_dependency WHERE dependent_type = ? AND dependent_id = ?', [dependentType, dependentId])
        .map((x) => `${x.v}\u0000${x.r ?? ''}`),
    );
    let n = 0;
    const insert = (versionId: string, regionId: string | null) => {
      const key = `${versionId}\u0000${regionId ?? ''}`;
      if (existing.has(key)) return;
      existing.add(key);
      ctx.db.run('INSERT INTO artifact_dependency (id, dependent_type, dependent_id, source_version_id, region_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        newId(now),
        dependentType,
        dependentId,
        versionId,
        regionId,
        now,
      ]);
      n++;
    };
    const withRegions = new Set<string>();
    for (const rid of [...new Set(regionIds)]) {
      const r = ctx.db.get<{ version_id: string }>('SELECT version_id FROM source_region WHERE id = ?', [rid]);
      if (!r) continue;
      withRegions.add(r.version_id);
      insert(r.version_id, rid);
    }
    for (const vid of [...new Set(versionIds)]) {
      if (withRegions.has(vid)) continue;
      if (!ctx.db.get('SELECT 1 AS x FROM source_version WHERE id = ?', [vid])) continue;
      insert(vid, null);
    }
    return n;
  });
}

// ───────── version comparison ─────────
interface RegionText {
  id: string;
  page_index: number;
  text: string;
  kind: string;
}

function versionTexts(ctx: AppContext, versionId: string): RegionText[] {
  return ctx.db.all<RegionText>(
    `SELECT r.id, p.page_index, r.text, r.kind FROM source_region r JOIN source_page p ON p.id = r.page_id
      WHERE r.version_id = ? AND r.kind NOT IN ('header','footer','table_cell') AND r.text IS NOT NULL AND trim(r.text) <> ''
      ORDER BY p.page_index, r.reading_order`,
    [versionId],
  );
}

const norm = (t: string) => matchNormalize(t).replace(/\s+/g, ' ').trim();

function isProcessed(ctx: AppContext, versionId: string): boolean {
  const v = ctx.db.get<{ processing_status: string }>('SELECT processing_status FROM source_version WHERE id = ?', [versionId]);
  return !!v && ['ready', 'partial', 'needs_review', 'failed'].includes(v.processing_status);
}

const UNIT_DISPLAY: Record<string, string> = {
  'x10^9/l': '×10⁹/L',
  'x10^12/l': '×10¹²/L',
  'x10^3/ul': '×10³/µL',
  'mmol/l': 'mmol/L',
  'umol/l': 'µmol/L',
  'meq/l': 'mEq/L',
  'mg/dl': 'mg/dL',
  'g/dl': 'g/dL',
  'mg/l': 'mg/L',
  'g/l': 'g/L',
  'ng/ml': 'ng/mL',
  'pg/ml': 'pg/mL',
  'iu/l': 'IU/L',
  'iu/ml': 'IU/mL',
  'u/l': 'U/L',
  'ml/kg/h': 'mL/kg/h',
  'ml/kg': 'mL/kg',
  'ml/h': 'mL/h',
  'ml/min': 'mL/min',
  'l/min': 'L/min',
  'kg/m2': 'kg/m²',
  mmhg: 'mmHg',
  cmh2o: 'cmH₂O',
  kpa: 'kPa',
  '°c': '°C',
  '°f': '°F',
  iu: 'IU',
  ml: 'mL',
  dl: 'dL',
  l: 'L',
};

/** Values that change meaning: number + unit quantities (displayed as written in medicine), lone numbers
 *  that are not part of a quantity, and negation words. */
function criticalSet(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    const c = extractCriticalTokens(t);
    const inQuantity = new Set(c.quantities.map((q) => q.split(' ')[0]!));
    for (const q of c.quantities) {
      const [n, u] = q.split(' ') as [string, string];
      out.add(`${n}${u === '%' ? '' : ' '}${UNIT_DISPLAY[u] ?? u}`);
    }
    for (const n of c.numbers) if (!inQuantity.has(n)) out.add(n);
    if (c.negation) for (const f of c.negation_forms) out.add(/^[a-z']+$/.test(f) ? f.toUpperCase() : f);
  }
  return out;
}

/** Deterministic comparison of two versions (or of a version with itself after re-processing). */
export function compareVersions(ctx: AppContext, fromVersionId: string | null, toVersionId: string): VersionChangeSummary {
  if (!fromVersionId || !isProcessed(ctx, toVersionId) || !isProcessed(ctx, fromVersionId)) {
    return {
      state: 'pending_processing',
      pages_compared: 0,
      pages_changed: [],
      critical_added: [],
      critical_removed: [],
      text_identical: false,
      note_ar: 'لم تكتمل معالجة النسخة الجديدة بعد؛ ستُقارَن النسختان عند اكتمالها.',
    };
  }
  const a = versionTexts(ctx, fromVersionId);
  const b = versionTexts(ctx, toVersionId);
  const multiset = (rows: RegionText[]) => rows.map((r) => norm(r.text)).sort().join('\n');
  const identical = multiset(a) === multiset(b);
  const byPage = (rows: RegionText[]) => {
    const m = new Map<number, string>();
    for (const r of rows) m.set(r.page_index, `${m.get(r.page_index) ?? ''}\n${norm(r.text)}`);
    return m;
  };
  const pa = byPage(a);
  const pb = byPage(b);
  const pages = new Set([...pa.keys(), ...pb.keys()]);
  const changed = [...pages].filter((p) => (pa.get(p) ?? '') !== (pb.get(p) ?? '')).sort((x, y) => x - y);
  const ca = criticalSet(a.map((r) => r.text));
  const cb = criticalSet(b.map((r) => r.text));
  const added = [...cb].filter((x) => !ca.has(x)).slice(0, 40);
  const removed = [...ca].filter((x) => !cb.has(x)).slice(0, 40);
  return {
    state: 'compared',
    pages_compared: pages.size,
    pages_changed: identical ? [] : changed,
    critical_added: identical ? [] : added,
    critical_removed: identical ? [] : removed,
    text_identical: identical,
    note_ar: identical
      ? 'النص نفسه في النسختين؛ التغيير في الترتيب أو الشكل فقط.'
      : added.length || removed.length
        ? `تغيّرت قيم أو أرقام أو صيغ نفي في ${pagesAr(changed.length)}.`
        : `تغيّر النص في ${pagesAr(changed.length)} دون تغيّر في القيم العددية أو النفي.`,
  };
}

// ───────── alerts ─────────
export interface VersionChangeInput {
  sourceId: string;
  /** the version dependents were built on (null → every earlier version of the source) */
  fromVersionId: string | null;
  /** the new / corrected version (equal to fromVersionId for re-processed pages) */
  toVersionId: string;
  kind: ContentAlertKind;
  /** re-processed pages (same version) */
  pageIndexes?: number[];
  jobId?: string | null;
  /** extra Arabic sentence appended to the summary */
  noteAr?: string;
}

interface DepRow {
  dependent_type: string;
  dependent_id: string;
  source_version_id: string;
  region_id: string | null;
}

interface Classified {
  type: string;
  id: string;
  impact: AlertImpact;
  frozen: boolean;
  reason_ar: string | null;
  version_ids: string[];
}

/** «مقطع مستشهد به» / «مقطعان مستشهد بهما» / «3 مقاطع مستشهد بها» / «12 مقطعًا مستشهدًا به». */
function citedPassagesAr(n: number): string {
  if (n === 1) return 'مقطع مستشهد به';
  if (n === 2) return 'مقطعان مستشهد بهما';
  if (n <= 10) return `${n} مقاطع مستشهد بها`;
  return `${n} مقطعًا مستشهدًا به`;
}

function regionText(ctx: AppContext, regionId: string): string | null {
  return ctx.db.get<{ text: string | null }>('SELECT text FROM source_region WHERE id = ?', [regionId])?.text ?? null;
}

function classify(
  ctx: AppContext,
  deps: DepRow[],
  change: VersionChangeSummary,
  newTexts: string[] | null,
  frozenVersionId: string | null,
  sameVersionPages: Set<number> | null,
): Classified[] {
  const groups = new Map<string, DepRow[]>();
  for (const d of deps) {
    const k = `${d.dependent_type}\u0000${d.dependent_id}`;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const newJoined = newTexts ? newTexts.map(norm).join('\n') : null;
  const out: Classified[] = [];
  for (const rows of groups.values()) {
    const { dependent_type: type, dependent_id: id } = rows[0]!;
    const versionIds = [...new Set(rows.map((r) => r.source_version_id))];
    // a content block is frozen when its artifact is (the block keeps its version with the artifact)
    const art =
      type === 'artifact'
        ? ctx.db.get<{ is_frozen: number }>('SELECT is_frozen FROM artifact WHERE id = ?', [id])
        : type === 'content_block'
          ? ctx.db.get<{ is_frozen: number }>('SELECT a.is_frozen FROM content_block b JOIN artifact a ON a.id = b.artifact_id WHERE b.id = ?', [id])
          : undefined;
    const frozen = (art?.is_frozen ?? 0) === 1 || (frozenVersionId !== null && versionIds.includes(frozenVersionId));
    const generated = type === 'artifact' || type === 'content_block' || type === 'message';
    let impact: AlertImpact;
    let reason: string;
    const regionRows = rows.filter((r) => r.region_id);
    if (sameVersionPages) {
      // re-processed pages of the same version: regions on those pages were replaced
      const affected = regionRows.filter((r) => {
        const page = ctx.db.get<{ page_index: number }>(
          'SELECT p.page_index FROM source_region r JOIN source_page p ON p.id = r.page_id WHERE r.id = ?',
          [r.region_id!],
        );
        return !page || sameVersionPages.has(page.page_index);
      });
      if (regionRows.length > 0 && affected.length === 0) {
        impact = 'still_valid';
        reason = 'المناطق المستشهد بها ليست في الصفحات المعاد معالجتها.';
      } else {
        impact = generated ? 'needs_regeneration' : 'needs_review';
        reason = 'أُعيدت معالجة صفحات يعتمد عليها هذا العنصر؛ قد يتغير النص المقروء منها.';
      }
    } else if (change.state === 'pending_processing') {
      impact = 'needs_review';
      reason = 'النسخة الجديدة لم تُعالَج بعد؛ ستُحدَّث المقارنة عند اكتمال المعالجة.';
    } else if (change.text_identical) {
      impact = 'still_valid';
      reason = 'نص النسخة الجديدة مطابق؛ التغيير في الترتيب أو الشكل فقط.';
    } else if (regionRows.length > 0 && newJoined !== null) {
      const missing = regionRows.filter((r) => {
        const t = regionText(ctx, r.region_id!);
        return !t || !newJoined.includes(norm(t));
      });
      if (missing.length === 0) {
        impact = 'still_valid';
        reason = 'النص المستشهد به موجود كما هو في النسخة الجديدة.';
      } else {
        impact = generated ? 'needs_regeneration' : 'needs_review';
        reason = `تغيّر أو اختفى ${citedPassagesAr(missing.length)} في النسخة الجديدة.`;
      }
    } else {
      impact = generated ? 'needs_regeneration' : 'needs_review';
      reason = 'تغيّر نص المصدر ولا تُعرف المقاطع التي اعتمد عليها هذا العنصر بدقة.';
    }
    if (frozen) reason = `${reason} مثبّت على نسخته (تجميد)، فلم يُغيَّر؛ راجع التحذير قبل الاعتماد عليه.`;
    out.push({ type, id, impact, frozen, reason_ar: reason, version_ids: versionIds });
  }
  return out;
}

function severityFor(ctx: AppContext, sourceId: string, change: VersionChangeSummary, items: Classified[]): 'info' | 'fact_change' | 'answer_change' {
  if (items.length === 0) return 'info';
  if (change.state === 'compared' && change.text_identical) return 'info';
  const type = ctx.db.get<{ source_type: string }>('SELECT source_type FROM source WHERE id = ?', [sourceId])?.source_type;
  if ((type === 'question_source' || type === 'previous_exam') && items.some((i) => i.type === 'question_version')) return 'answer_change';
  if (items.every((i) => i.impact === 'still_valid')) return 'info';
  return 'fact_change';
}

function summaryAr(kind: ContentAlertKind, title: string, versionNo: number | null, items: Classified[], change: VersionChangeSummary, frozenNote: boolean, extra?: string): string {
  const head =
    kind === 'source_replaced'
      ? `رُفعت نسخة جديدة${versionNo ? ` (${versionNo})` : ''} من «${title}».`
      : kind === 'ocr_corrected'
        ? `صُحّح النص المقروء آليًا (OCR) في «${title}».`
        : kind === 'layout_changed'
          ? `تغيّر ترتيب «${title}» أو شكله فقط.`
          : `تحدّث المصدر «${title}».`;
  const n = items.length;
  const counts = n === 0 ? 'لا يوجد محتوى مشتق يعتمد على النسخ السابقة.' : `عناصر مشتقة تعتمد عليه: ${n}${change.state === 'pending_processing' ? '، تحتاج مراجعة حتى تكتمل المقارنة.' : '.'}`;
  const freeze = frozenNote ? ' النسخة المثبّتة (Source Freeze) لم تتغير؛ أدوات الدراسة تستمر عليها حتى تختار غير ذلك.' : '';
  return [head, counts, change.state === 'compared' ? change.note_ar : '', freeze, extra ?? ''].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

interface StaleMark {
  id: string;
  prev_status: string;
  reason: string;
}

function markStale(ctx: AppContext, items: Classified[], reasonAr: string): StaleMark[] {
  const marks: StaleMark[] = [];
  const now = ctx.clock.now();
  const artifactIds = new Set<string>();
  for (const i of items) {
    if (i.frozen || i.impact === 'still_valid') continue;
    if (i.type === 'artifact') artifactIds.add(i.id);
    else if (i.type === 'content_block') {
      const a = ctx.db.get<{ artifact_id: string }>('SELECT artifact_id FROM content_block WHERE id = ?', [i.id]);
      if (a) {
        const fz = ctx.db.get<{ is_frozen: number }>('SELECT is_frozen FROM artifact WHERE id = ?', [a.artifact_id]);
        if (fz && fz.is_frozen === 0) artifactIds.add(a.artifact_id);
      }
    }
  }
  for (const id of artifactIds) {
    const a = ctx.db.get<{ status: string }>('SELECT status FROM artifact WHERE id = ?', [id]);
    if (!a || ['stale', 'superseded', 'failed'].includes(a.status)) continue;
    ctx.db.run(`UPDATE artifact SET status = 'stale', stale_reason = ?, updated_at = ? WHERE id = ? AND is_frozen = 0`, [reasonAr, now, id]);
    marks.push({ id, prev_status: a.status, reason: reasonAr });
  }
  return marks;
}

interface AlertDetails {
  state: VersionChangeSummary['state'] | 'reprocessed';
  change?: VersionChangeSummary;
  page_indexes?: number[];
  job_id?: string | null;
  stale_marked?: StaleMark[];
}

/**
 * A source version changed (replacement, corrected version, re-processed pages). Creates one alert with
 * per-dependent impact and marks non-frozen artifacts stale. Synchronous (callable inside a transaction).
 * Returns null when there is nothing to report for a same-version re-processing without dependents.
 */
export function onSourceVersionChanged(ctx: AppContext, input: VersionChangeInput): { alertId: string | null; items: Classified[] } {
  return ctx.db.tx(() => {
    const src = ctx.db.get<{ title: string; frozen_version_id: string | null }>('SELECT title, frozen_version_id FROM source WHERE id = ?', [input.sourceId]);
    if (!src) throw new AppError('NOT_FOUND', 'المصدر غير موجود.', 404);
    const sameVersion = input.fromVersionId !== null && input.fromVersionId === input.toVersionId;
    const deps = sameVersion
      ? ctx.db.all<DepRow>('SELECT dependent_type, dependent_id, source_version_id, region_id FROM artifact_dependency WHERE source_version_id = ?', [input.toVersionId])
      : input.fromVersionId
        ? ctx.db.all<DepRow>('SELECT dependent_type, dependent_id, source_version_id, region_id FROM artifact_dependency WHERE source_version_id = ?', [input.fromVersionId])
        : ctx.db.all<DepRow>(
            `SELECT dependent_type, dependent_id, source_version_id, region_id FROM artifact_dependency
              WHERE source_version_id IN (SELECT id FROM source_version WHERE source_id = ? AND id <> ?)`,
            [input.sourceId, input.toVersionId],
          );
    const fromForCompare = sameVersion ? null : (input.fromVersionId ?? previousVersionId(ctx, input.sourceId, input.toVersionId));
    const change: VersionChangeSummary = sameVersion
      ? {
          state: 'compared',
          pages_compared: input.pageIndexes?.length ?? 0,
          pages_changed: [...(input.pageIndexes ?? [])].sort((a, b) => a - b),
          critical_added: [],
          critical_removed: [],
          text_identical: false,
          note_ar: `أُعيدت معالجة ${pagesAr(input.pageIndexes?.length ?? 0)} من النسخة نفسها.`,
        }
      : compareVersions(ctx, fromForCompare, input.toVersionId);
    const newTexts = !sameVersion && change.state === 'compared' ? versionTexts(ctx, input.toVersionId).map((r) => r.text) : null;
    const items = classify(ctx, deps, change, newTexts, src.frozen_version_id, sameVersion ? new Set(input.pageIndexes ?? []) : null);
    if (sameVersion && items.length === 0) return { alertId: null, items };

    const kind: ContentAlertKind = !sameVersion && change.state === 'compared' && change.text_identical && input.kind !== 'key_corrected' ? 'layout_changed' : input.kind;
    const versionNo = ctx.db.get<{ version_no: number }>('SELECT version_no FROM source_version WHERE id = ?', [input.toVersionId])?.version_no ?? null;
    const frozenNote = src.frozen_version_id !== null && src.frozen_version_id !== input.toVersionId;
    const summary = summaryAr(kind, src.title.replace(/[\r\n\t]+/g, ' ').trim(), sameVersion ? null : versionNo, items, change, frozenNote, input.noteAr);
    const now = ctx.clock.now();
    const alertId = newId(now);
    const staleReason = `${CONTENT_ALERT_KIND_LABELS_AR[kind]}: ${src.title.replace(/[\r\n\t]+/g, ' ').trim()} — راجع تنبيه التغيير قبل الاعتماد على هذا المحتوى.`;
    const marks = markStale(ctx, items, staleReason);
    const details: AlertDetails = {
      state: sameVersion ? 'reprocessed' : change.state,
      change,
      page_indexes: input.pageIndexes,
      job_id: input.jobId ?? null,
      stale_marked: marks,
    };
    ctx.db.run(
      `INSERT INTO content_alert (id, kind, severity, source_id, source_version_id, from_version_id, summary, affected_json, status, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      [
        alertId,
        kind,
        severityFor(ctx, input.sourceId, change, items),
        input.sourceId,
        input.toVersionId,
        sameVersion ? input.toVersionId : (input.fromVersionId ?? fromForCompare),
        summary,
        JSON.stringify(items.map((i) => ({ type: i.type, id: i.id, impact: i.impact }))),
        toJson(details),
        now,
      ],
    );
    for (const i of items) {
      ctx.db.run(
        `INSERT INTO content_alert_item (alert_id, dependent_type, dependent_id, impact, frozen, reason_ar, version_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [alertId, i.type, i.id, i.impact, i.frozen ? 1 : 0, i.reason_ar, toJson(i.version_ids)],
      );
    }
    return { alertId, items };
  });
}

function previousVersionId(ctx: AppContext, sourceId: string, toVersionId: string): string | null {
  const to = ctx.db.get<{ derived_from_version_id: string | null; version_no: number }>('SELECT derived_from_version_id, version_no FROM source_version WHERE id = ?', [toVersionId]);
  if (to?.derived_from_version_id) return to.derived_from_version_id;
  return (
    ctx.db.get<{ id: string }>('SELECT id FROM source_version WHERE source_id = ? AND version_no < ? ORDER BY version_no DESC LIMIT 1', [sourceId, to?.version_no ?? 1e9])?.id ?? null
  );
}

// ───────── reconcile (lazy, idempotent) ─────────
/**
 * Complete pending comparisons whose new version is now processed, and turn finished page re-processing jobs
 * into alerts. Safe to call often (GET /api/evidence/alerts calls it).
 */
export function reconcileAlerts(ctx: AppContext): { updated: number; created: number } {
  let updated = 0;
  let created = 0;
  const pending = ctx.db.all<{ id: string; source_id: string; source_version_id: string; from_version_id: string | null; kind: ContentAlertKind; details_json: string | null }>(
    `SELECT id, source_id, source_version_id, from_version_id, kind, details_json FROM content_alert
      WHERE status <> 'resolved' AND json_extract(details_json, '$.state') = 'pending_processing'`,
  );
  for (const a of pending) {
    if (!a.source_version_id || !isProcessed(ctx, a.source_version_id)) continue;
    ctx.db.tx(() => {
      const src = ctx.db.get<{ title: string; frozen_version_id: string | null }>('SELECT title, frozen_version_id FROM source WHERE id = ?', [a.source_id]);
      if (!src) return;
      const change = compareVersions(ctx, a.from_version_id, a.source_version_id);
      if (change.state !== 'compared') return;
      const prev = ctx.db.all<{ dependent_type: string; dependent_id: string }>('SELECT dependent_type, dependent_id FROM content_alert_item WHERE alert_id = ?', [a.id]);
      const deps: DepRow[] = prev.flatMap((p) =>
        ctx.db.all<DepRow>(
          `SELECT dependent_type, dependent_id, source_version_id, region_id FROM artifact_dependency
            WHERE dependent_type = ? AND dependent_id = ? AND source_version_id IN (SELECT id FROM source_version WHERE source_id = ? AND id <> ?)`,
          [p.dependent_type, p.dependent_id, a.source_id, a.source_version_id],
        ),
      );
      const items = classify(ctx, deps, change, versionTexts(ctx, a.source_version_id).map((r) => r.text), src.frozen_version_id, null);
      const details = (fromJson<AlertDetails>(a.details_json) ?? { state: 'compared' }) as AlertDetails;
      // artifacts marked stale only because the comparison was pending are restored when still valid — an
      // artifact counts as still valid only if it AND every one of its content blocks listed here are still valid
      const okByArtifact = new Map<string, boolean>();
      for (const i of items) {
        const artifactId =
          i.type === 'artifact' ? i.id : i.type === 'content_block' ? (ctx.db.get<{ artifact_id: string }>('SELECT artifact_id FROM content_block WHERE id = ?', [i.id])?.artifact_id ?? null) : null;
        if (!artifactId) continue;
        okByArtifact.set(artifactId, (okByArtifact.get(artifactId) ?? true) && i.impact === 'still_valid');
      }
      const restoreIds = new Set([...okByArtifact].filter(([, ok]) => ok).map(([id]) => id));
      for (const m of details.stale_marked ?? []) {
        if (!restoreIds.has(m.id)) continue;
        ctx.db.run(`UPDATE artifact SET status = ?, stale_reason = NULL, updated_at = ? WHERE id = ? AND status = 'stale' AND stale_reason = ?`, [m.prev_status, ctx.clock.now(), m.id, m.reason]);
      }
      const kind: ContentAlertKind = change.text_identical && a.kind !== 'key_corrected' ? 'layout_changed' : a.kind;
      const versionNo = ctx.db.get<{ version_no: number }>('SELECT version_no FROM source_version WHERE id = ?', [a.source_version_id])?.version_no ?? null;
      const frozenNote = src.frozen_version_id !== null && src.frozen_version_id !== a.source_version_id;
      ctx.db.run(`UPDATE content_alert SET kind = ?, severity = ?, summary = ?, affected_json = ?, details_json = ? WHERE id = ?`, [
        kind,
        severityFor(ctx, a.source_id, change, items),
        summaryAr(kind, src.title.replace(/[\r\n\t]+/g, ' ').trim(), versionNo, items, change, frozenNote),
        JSON.stringify(items.map((i) => ({ type: i.type, id: i.id, impact: i.impact }))),
        toJson({ ...details, state: 'compared', change, stale_marked: (details.stale_marked ?? []).filter((m) => !restoreIds.has(m.id)) }),
        a.id,
      ]);
      for (const i of items) {
        ctx.db.run(
          `INSERT INTO content_alert_item (alert_id, dependent_type, dependent_id, impact, frozen, reason_ar, version_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(alert_id, dependent_type, dependent_id) DO UPDATE SET impact = excluded.impact, frozen = excluded.frozen, reason_ar = excluded.reason_ar, version_ids_json = excluded.version_ids_json`,
          [a.id, i.type, i.id, i.impact, i.frozen ? 1 : 0, i.reason_ar, toJson(i.version_ids)],
        );
      }
      updated++;
    });
  }

  // finished re-processing jobs (same version, explicit pages) → alerts for their dependents
  const jobs = ctx.db.all<{ id: string; input_json: string; status: string }>(
    `SELECT j.id, j.input_json, j.status FROM processing_job j
      WHERE j.kind = ? AND j.status IN ('completed','partial') AND json_extract(j.input_json, '$.reason') = 'reprocess'
        AND NOT EXISTS (SELECT 1 FROM content_alert_job c WHERE c.job_id = j.id)
      ORDER BY j.created_at LIMIT 50`,
    [PROCESS_JOB_KIND],
  );
  for (const j of jobs) {
    const input = fromJson<{ version_id?: string; page_indexes?: number[] }>(j.input_json) ?? {};
    ctx.db.tx(() => {
      let alertId: string | null = null;
      const v = input.version_id ? ctx.db.get<{ source_id: string }>('SELECT source_id FROM source_version WHERE id = ?', [input.version_id]) : undefined;
      if (v && input.version_id) {
        const pageIdx = input.page_indexes && input.page_indexes.length > 0 ? input.page_indexes : allPageIndexes(ctx, input.version_id);
        const ocr = ctx.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM source_page WHERE version_id = ? AND text_status IN ('ocr','mixed') AND page_index IN (${pageIdx.map(() => '?').join(',') || 'NULL'})`,
          [input.version_id, ...pageIdx],
        );
        const res = onSourceVersionChanged(ctx, {
          sourceId: v.source_id,
          fromVersionId: input.version_id,
          toVersionId: input.version_id,
          kind: (ocr?.n ?? 0) > 0 ? 'ocr_corrected' : 'source_updated',
          pageIndexes: pageIdx,
          jobId: j.id,
        });
        alertId = res.alertId;
        if (alertId) created++;
      }
      ctx.db.run('INSERT INTO content_alert_job (job_id, alert_id, created_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO NOTHING', [j.id, alertId, ctx.clock.now()]);
    });
  }
  return { updated, created };
}

function allPageIndexes(ctx: AppContext, versionId: string): number[] {
  return ctx.db.all<{ page_index: number }>('SELECT page_index FROM source_page WHERE version_id = ? ORDER BY page_index', [versionId]).map((r) => r.page_index);
}

// ───────── views ─────────
interface AlertRow {
  id: string;
  kind: ContentAlertKind;
  severity: 'info' | 'fact_change' | 'answer_change';
  source_id: string | null;
  source_version_id: string | null;
  from_version_id: string | null;
  summary: string;
  affected_json: string;
  status: 'open' | 'acknowledged' | 'resolved';
  details_json: string | null;
  created_at: number;
  acknowledged_at: number | null;
  resolved_at: number | null;
  source_title: string | null;
}

function itemTitle(ctx: AppContext, type: string, id: string): string | null {
  if (type === 'artifact') {
    const a = ctx.db.get<{ title: string | null; kind: string }>('SELECT title, kind FROM artifact WHERE id = ?', [id]);
    return a ? (a.title ?? null) : null;
  }
  if (type === 'content_block') {
    const b = ctx.db.get<{ title: string | null }>('SELECT a.title FROM content_block b JOIN artifact a ON a.id = b.artifact_id WHERE b.id = ?', [id]);
    return b?.title ?? null;
  }
  return null;
}

function toAlertView(ctx: AppContext, r: AlertRow): ContentAlertView {
  const rows = ctx.db.all<{ dependent_type: string; dependent_id: string; impact: AlertImpact; frozen: number; reason_ar: string | null }>(
    'SELECT dependent_type, dependent_id, impact, frozen, reason_ar FROM content_alert_item WHERE alert_id = ? ORDER BY dependent_type, dependent_id',
    [r.id],
  );
  let items: ContentAlertItemView[] = rows.map((i) => ({
    type: i.dependent_type,
    id: i.dependent_id,
    impact: i.impact,
    impact_label_ar: ALERT_IMPACT_LABELS_AR[i.impact],
    frozen: i.frozen === 1,
    reason_ar: i.reason_ar,
    title: itemTitle(ctx, i.dependent_type, i.dependent_id),
  }));
  if (rows.length === 0) {
    // alerts written by other modules (e.g. permanent delete) carry only affected_json
    const legacy = fromJson<Array<{ type: string; id: string; impact?: AlertImpact }>>(r.affected_json, []) ?? [];
    items = legacy.map((i) => {
      const impact: AlertImpact = i.impact && i.impact in ALERT_IMPACT_LABELS_AR ? i.impact : 'needs_review';
      return { type: i.type, id: i.id, impact, impact_label_ar: ALERT_IMPACT_LABELS_AR[impact], frozen: false, reason_ar: null, title: itemTitle(ctx, i.type, i.id) };
    });
  }
  const counts: Record<AlertImpact, number> = { still_valid: 0, needs_regeneration: 0, needs_review: 0 };
  for (const i of items) counts[i.impact]++;
  const details = fromJson<AlertDetails>(r.details_json);
  return {
    id: r.id,
    kind: r.kind,
    kind_label_ar: CONTENT_ALERT_KIND_LABELS_AR[r.kind],
    severity: r.severity,
    severity_label_ar: ALERT_SEVERITY_LABELS_AR[r.severity],
    source_id: r.source_id,
    source_title: r.source_title ? r.source_title.replace(/[\r\n\t]+/g, ' ').trim() : null,
    source_version_id: r.source_version_id,
    from_version_id: r.from_version_id,
    summary: r.summary,
    status: r.status,
    created_at: r.created_at,
    acknowledged_at: r.acknowledged_at,
    resolved_at: r.resolved_at,
    items,
    counts,
    change: details?.change ?? null,
  };
}

const ALERT_SQL = `SELECT a.id, a.kind, a.severity, a.source_id, a.source_version_id, a.from_version_id, a.summary, a.affected_json, a.status,
    a.details_json, a.created_at, a.acknowledged_at, a.resolved_at, s.title AS source_title
  FROM content_alert a LEFT JOIN source s ON s.id = a.source_id`;

export function listAlerts(ctx: AppContext, opts: { status?: 'open' | 'acknowledged' | 'resolved' | 'active' | 'all'; sourceId?: string; limit?: number } = {}): ContentAlertView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  const status = opts.status ?? 'active';
  if (status === 'active') where.push(`a.status <> 'resolved'`);
  else if (status !== 'all') {
    where.push('a.status = ?');
    params.push(status);
  }
  if (opts.sourceId) {
    where.push('a.source_id = ?');
    params.push(opts.sourceId);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = ctx.db.all<AlertRow>(`${ALERT_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`, [...params, limit]);
  return rows.map((r) => toAlertView(ctx, r));
}

export function getAlert(ctx: AppContext, id: string): ContentAlertView {
  const r = ctx.db.get<AlertRow>(`${ALERT_SQL} WHERE a.id = ?`, [id]);
  if (!r) throw new AppError('NOT_FOUND', 'التنبيه غير موجود.', 404);
  return toAlertView(ctx, r);
}

export function setAlertStatus(ctx: AppContext, id: string, to: 'acknowledged' | 'resolved'): ContentAlertView {
  const r = ctx.db.get<{ status: string }>('SELECT status FROM content_alert WHERE id = ?', [id]);
  if (!r) throw new AppError('NOT_FOUND', 'التنبيه غير موجود.', 404);
  const now = ctx.clock.now();
  if (to === 'acknowledged') {
    ctx.db.run(`UPDATE content_alert SET status = CASE WHEN status = 'resolved' THEN status ELSE 'acknowledged' END, acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?`, [now, id]);
  } else {
    ctx.db.run(`UPDATE content_alert SET status = 'resolved', acknowledged_at = COALESCE(acknowledged_at, ?), resolved_at = COALESCE(resolved_at, ?) WHERE id = ?`, [now, now, id]);
  }
  ctx.audit.record({ entityType: 'content_alert', entityId: id, action: to === 'acknowledged' ? 'acknowledge' : 'resolve', summary: to === 'acknowledged' ? 'اطّلعت على تنبيه تغيير المحتوى' : 'أُغلق تنبيه تغيير المحتوى' });
  return getAlert(ctx, id);
}
