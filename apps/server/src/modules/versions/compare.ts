// Compare two versions side by side (PRD AOS-3.12, Scenario 4): rows in the reading order of the NEW version, removed
// pages placed where they were, a bounded word-level difference for edited / changed / moved pages, and the open
// «إصدار جديد من …» proposal between exactly these two versions. The request only reads fingerprints and runs the
// cheap matcher; rendering (dHash) happens in the analysis job — a missing fingerprint answers «pending».
import type { CompareRow, ComparePageRef, CompareVersionRef, PageMapEntry, VersionCompareResponse } from '@medlevo/shared';
import { emptyChangeCounts } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { fingerprintsComplete, VERSION_ANALYSIS_JOB } from '../processing/fingerprint';
import { pageLabelKnown, versionIsNumbered } from '../sources/pagelabel';
import { listSuggestions } from './identity';
import { computeAndStorePageMap, pageMapIsCurrent, readPageMap } from './pagemap';

const EXCERPT = 220;
const DIFF_WORDS = 40;

function versionRef(ctx: AppContext, versionId: string): CompareVersionRef & { format: string } {
  const v = ctx.db.get<{ id: string; source_id: string; title: string; version_no: number; file_name: string | null; page_count: number | null; format: string }>(
    'SELECT v.id, v.source_id, s.title, v.version_no, v.file_name, v.page_count, v.format FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ?',
    [versionId],
  );
  if (!v) throw new AppError('NOT_FOUND', 'النسخة غير موجودة.', 404);
  return { source_id: v.source_id, source_title: v.title, version_id: v.id, version_no: v.version_no, file_name: v.file_name, page_count: v.page_count, format: v.format };
}

interface PageInfo {
  ref: ComparePageRef;
  text: string;
}

function pageInfos(ctx: AppContext, versionId: string, renderable: boolean): Map<string, PageInfo> {
  const numbered = versionIsNumbered(ctx.db, versionId);
  const pages = ctx.db.all<{ id: string; page_index: number; printed_label: string | null; kind: string; render_file_id: string | null }>(
    'SELECT id, page_index, printed_label, kind, render_file_id FROM source_page WHERE version_id = ? ORDER BY page_index',
    [versionId],
  );
  const texts = new Map<string, string[]>();
  for (const r of ctx.db.all<{ page_id: string; text: string }>(
    `SELECT page_id, text FROM source_region WHERE version_id = ? AND status <> 'rejected' AND text IS NOT NULL AND kind NOT IN ('header','footer','table_cell') ORDER BY page_id, reading_order`,
    [versionId],
  )) {
    texts.set(r.page_id, [...(texts.get(r.page_id) ?? []), r.text]);
  }
  const out = new Map<string, PageInfo>();
  for (const p of pages) {
    const text = (texts.get(p.id) ?? []).join('\n');
    const flat = text.replace(/\s+/g, ' ').trim();
    out.set(p.id, {
      text,
      ref: {
        page_id: p.id,
        page_index: p.page_index,
        label_ar: pageLabelKnown({ page_index: p.page_index, printed_label: p.printed_label, kind: p.kind, numbered_version: numbered }),
        excerpt: flat ? (flat.length > EXCERPT ? `${flat.slice(0, EXCERPT)}…` : flat) : null,
        thumbnail: !!p.render_file_id || (renderable && (p.kind === 'page' || p.kind === 'slide')),
      },
    });
  }
  return out;
}

/** Words removed from / added to a page (case-insensitive, first occurrence order, bounded). */
export function wordDiff(oldText: string, newText: string): { removed: string[]; added: string[] } {
  const words = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  const a = words(oldText);
  const b = words(newText);
  const setA = new Set(a.map((w) => w.toLowerCase()));
  const setB = new Set(b.map((w) => w.toLowerCase()));
  const uniq = (list: string[], other: Set<string>) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const w of list) {
      const k = w.toLowerCase();
      if (other.has(k) || seen.has(k)) continue;
      seen.add(k);
      out.push(w);
      if (out.length >= DIFF_WORDS) break;
    }
    return out;
  };
  return { removed: uniq(a, setB), added: uniq(b, setA) };
}

function latestAnalysisJob(ctx: AppContext, versionId: string): { id: string; status: string } | null {
  return (
    ctx.db.get<{ id: string; status: string }>(
      `SELECT id, status FROM processing_job WHERE kind = ? AND json_extract(input_json, '$.version_id') = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [VERSION_ANALYSIS_JOB, versionId],
    ) ?? null
  );
}

/** Queue the analysis of a version that has no fingerprints yet (idempotent per version). */
export function requestAnalysis(ctx: AppContext, versionId: string, reason = 'on_demand'): string | null {
  if (!ctx.jobs.isRegistered(VERSION_ANALYSIS_JOB)) return null;
  const st = ctx.db.get<{ processing_status: string }>('SELECT processing_status FROM source_version WHERE id = ?', [versionId])?.processing_status;
  if (!st || st === 'pending' || st === 'processing') return latestAnalysisJob(ctx, versionId)?.id ?? null;
  const running = latestAnalysisJob(ctx, versionId);
  if (running && (running.status === 'queued' || running.status === 'running')) return running.id;
  return ctx.jobs.enqueue(VERSION_ANALYSIS_JOB, { version_id: versionId }, { idempotencyKey: `${VERSION_ANALYSIS_JOB}:${versionId}:${reason}:${ctx.clock.now()}` }).id;
}

export function compareVersions(ctx: AppContext, fromVersionId: string, toVersionId: string): VersionCompareResponse {
  if (fromVersionId === toVersionId) throw new AppError('BAD_REQUEST', 'اختر نسختين مختلفتين للمقارنة.', 400);
  const from = versionRef(ctx, fromVersionId);
  const to = versionRef(ctx, toVersionId);
  const proposal =
    listSuggestions(ctx, { sourceId: to.source_id, status: 'open' }).find(
      (s) => s.field === 'new_version_of' && s.value.field === 'new_version_of' && s.value.version_id === fromVersionId && s.version_id === toVersionId,
    ) ?? null;
  const { format: fromFormat, ...fromRef } = from;
  const { format: toFormat, ...toRef } = to;
  const base = { from: fromRef, to: toRef, proposal };
  const ready = fingerprintsComplete(ctx, fromVersionId) && fingerprintsComplete(ctx, toVersionId);
  if (!ready) {
    const jobs = [fromVersionId, toVersionId].filter((v) => !fingerprintsComplete(ctx, v)).map((v) => requestAnalysis(ctx, v));
    const failed = [fromVersionId, toVersionId].some((v) => latestAnalysisJob(ctx, v)?.status === 'failed');
    return {
      ...base,
      state: failed ? 'failed' : 'pending',
      reason_ar: failed ? 'تعذّر تحليل صفحات إحدى النسختين. أعد معالجتها ثم حاول مجددًا.' : 'يجري تحليل صفحات النسختين (بصمة كل صفحة). تظهر المقارنة عند انتهائه.',
      algo: null,
      rows: [],
      counts: emptyChangeCounts(),
      job_id: jobs.find(Boolean) ?? null,
    };
  }
  const map = pageMapIsCurrent(ctx, fromVersionId, toVersionId) ? readPageMap(ctx, fromVersionId, toVersionId)! : computeAndStorePageMap(ctx, fromVersionId, toVersionId);
  const renderable = (fmt: string, versionId: string) =>
    fmt === 'pdf' || !!ctx.db.get('SELECT 1 AS x FROM source_version WHERE id = ? AND display_file_id IS NOT NULL', [versionId]);
  const oldPages = pageInfos(ctx, fromVersionId, renderable(fromFormat, fromVersionId));
  const newPages = pageInfos(ctx, toVersionId, renderable(toFormat, toVersionId));
  const byTo = new Map<string, PageMapEntry>();
  for (const e of map.entries) if (e.to_page_id) byTo.set(e.to_page_id, e);

  const rowOf = (e: PageMapEntry | null, toPageId: string | null): CompareRow => {
    const f = e ? oldPages.get(e.from_page_id) ?? null : null;
    const t = toPageId ? newPages.get(toPageId) ?? null : null;
    const change = e ? e.change : 'inserted';
    return {
      key: `${e?.from_page_id ?? '-'}:${toPageId ?? '-'}`,
      change,
      from: f?.ref ?? null,
      to: t?.ref ?? null,
      status: e?.status ?? null,
      method: e?.method ?? null,
      layout_safe: e?.layout_safe ?? false,
      text_score: e?.text_score ?? null,
      image_distance: e?.image_distance ?? null,
      decided_by: e?.decided_by ?? 'auto',
      diff: f && t && (change === 'edited' || change === 'changed' || change === 'moved') ? wordDiff(f.text, t.text) : null,
    };
  };
  const rows: CompareRow[] = [];
  const toOrder = [...newPages.values()].map((p) => p.ref.page_id);
  const rowAfterFrom = new Map<number, number>(); // from_page_index → row index of its counterpart
  for (const toId of toOrder) {
    const e = byTo.get(toId) ?? null;
    rows.push(rowOf(e, toId));
    if (e) rowAfterFrom.set(e.from_page_index, rows.length - 1);
  }
  // removed pages go after the row of the nearest preceding old page that still exists in the new version
  const removed = map.entries.filter((e) => !e.to_page_id).sort((a, b) => a.from_page_index - b.from_page_index);
  const inserts: Array<{ at: number; row: CompareRow }> = [];
  for (const e of removed) {
    let at = -1;
    for (const [fi, ri] of rowAfterFrom) if (fi < e.from_page_index && ri > at) at = ri;
    inserts.push({ at, row: rowOf(e, null) });
  }
  // insert from the end so earlier indexes stay valid; same anchor → keep old-page order
  inserts.sort((a, b) => b.at - a.at || (b.row.from?.page_index ?? 0) - (a.row.from?.page_index ?? 0));
  for (const ins of inserts) rows.splice(ins.at + 1, 0, ins.row);
  return { ...base, state: 'ready', reason_ar: null, algo: map.algo, rows, counts: map.counts, job_id: null };
}
