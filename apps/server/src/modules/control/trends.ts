// §56 daily trend metrics: citation / verification failures and sync rejections / conflicts, per day in the owner's
// time zone. Computed from the rows the evidence and sync modules already write (claim, verification_result,
// sync_operation) — no second copy of the data, no prompt text. Every failure series carries its denominator series
// (claims checked, sync operations received) so a number is never read without its base.
import type { HealthTrendsResponse, TrendSeries, TrendSeriesKey } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { localDate, tzOffsetMs } from '../../lib/time';

const HOUR = 3600 * 1000;

/** UTC epoch ms of local midnight of the day containing `ms` in `timeZone` (two passes handle DST). */
export function startOfDayInTz(ms: number, timeZone: string): number {
  const [y, m, d] = localDate(ms, timeZone).split('-').map(Number) as [number, number, number];
  const localMidnightAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = localMidnightAsUtc - tzOffsetMs(ms, timeZone);
  guess = localMidnightAsUtc - tzOffsetMs(guess, timeZone);
  return guess;
}

/** [start of day 0, …, start of day n-1, start of tomorrow] — n days ending today */
export function dayBoundaries(now: number, days: number, timeZone: string): number[] {
  const today = startOfDayInTz(now, timeZone);
  const out = [today];
  while (out.length < days) out.unshift(startOfDayInTz(out[0]! - HOUR, timeZone));
  out.push(startOfDayInTz(today + 36 * HOUR, timeZone));
  return out;
}

function bucket(times: number[], bounds: number[]): number[] {
  const counts = new Array<number>(bounds.length - 1).fill(0);
  for (const t of times) {
    // binary search: the last boundary <= t
    let lo = 0;
    let hi = bounds.length - 2;
    if (t < bounds[0]! || t >= bounds[bounds.length - 1]!) continue;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bounds[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    counts[lo]!++;
  }
  return counts;
}

const DEFS: Array<{ key: TrendSeriesKey; label_ar: string; description_ar: string; of: TrendSeriesKey | null; sql: string }> = [
  {
    key: 'claims_checked',
    label_ar: 'جمل طبية فُحصت',
    description_ar: 'كل جملة طبية في محتوى مولّد مرّت بالتحقق من أدلتها.',
    of: null,
    sql: `SELECT created_at AS t FROM claim WHERE created_at >= ? AND created_at < ?`,
  },
  {
    key: 'citation_invalid',
    label_ar: 'استشهادات مرفوضة',
    description_ar: 'جمل استشهدت بدليل غير موجود، أو لم يُسلَّم للمولّد، أو خارج النطاق المقفل؛ لم يتحول شيء منها إلى استشهاد.',
    of: 'claims_checked',
    sql: `SELECT MIN(created_at) AS t FROM verification_result
           WHERE subject_type = 'claim' AND check_name IN ('evidence_exists','in_scope') AND passed = 0 AND created_at >= ? AND created_at < ?
           GROUP BY subject_id`,
  },
  {
    key: 'claim_unsupported',
    label_ar: 'جمل لم يثبتها الدليل',
    description_ar: 'قيمة أو نفي أو وحدة غير موجودة في الدليل، أو اقتباس لا يطابق، أو حكم المحقق المستقل بأن الدليل لا يثبتها أو يناقضها. (غياب المحقق نفسه لا يُعدّ هنا.)',
    of: 'claims_checked',
    sql: `SELECT MIN(created_at) AS t FROM verification_result
           WHERE subject_type = 'claim' AND passed = 0 AND created_at >= ? AND created_at < ?
             AND (check_name IN ('critical_tokens','quote_containment')
                  OR (check_name = 'entailment' AND json_extract(details_json, '$.status') IS NULL))
           GROUP BY subject_id`,
  },
  {
    key: 'sync_ops',
    label_ar: 'تغييرات وصلت من أجهزتك',
    description_ar: 'كل عملية مزامنة استقبلها الخادم (كتابة، ملاحظة، مراجعة، محاولة…).',
    of: null,
    sql: `SELECT received_at AS t FROM sync_operation WHERE received_at >= ? AND received_at < ?`,
  },
  {
    key: 'sync_rejected',
    label_ar: 'تغييرات رفضها الخادم',
    description_ar: 'تغيير لم يُطبَّق لأن على الخادم نسخة أحدث أو لأنه غير صالح؛ لم يُحذف شيء، والقرار في «التعارضات والمزامنة».',
    of: 'sync_ops',
    sql: `SELECT received_at AS t FROM sync_operation WHERE result = 'rejected' AND received_at >= ? AND received_at < ?`,
  },
  {
    key: 'sync_conflict',
    label_ar: 'تعارضات حُفظت فيها النسختان',
    description_ar: 'تعديلان من جهازين على الشيء نفسه؛ احتُفظ بالنسختين دون كتابة إحداهما فوق الأخرى.',
    of: 'sync_ops',
    sql: `SELECT received_at AS t FROM sync_operation WHERE result = 'conflict_kept_both' AND received_at >= ? AND received_at < ?`,
  },
];

export function healthTrends(ctx: AppContext, days = 14): HealthTrendsResponse {
  const tz = ctx.settings.get().timezone;
  const now = ctx.clock.now();
  const bounds = dayBoundaries(now, days, tz);
  const from = bounds[0]!;
  const to = bounds[bounds.length - 1]!;
  const labels = bounds.slice(0, -1).map((b) => localDate(b + HOUR, tz));
  const series: TrendSeries[] = DEFS.map((d) => {
    const counts = bucket(
      ctx.db.all<{ t: number }>(d.sql, [from, to]).map((r) => r.t),
      bounds,
    );
    return { key: d.key, label_ar: d.label_ar, description_ar: d.description_ar, counts, total: counts.reduce((a, b) => a + b, 0), of: d.of };
  });
  return {
    timezone: tz,
    days: labels,
    series,
    generated_at: now,
    notes_ar: [
      'أعداد يومية حقيقية من سجلات التحقق والمزامنة؛ لا نسب مئوية ولا تقديرات.',
      'الجمل المحذوفة لعدم دعمها لا تُعرض عليك مدعومة أبدًا؛ هذا العدد يقيس كم مرة منع التحقق شيئًا، لا كم خطأ وصل إليك.',
    ],
  };
}
