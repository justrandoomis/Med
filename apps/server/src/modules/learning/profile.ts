// Learning profile (§44): what the owner set (self level, subjects, preferences, pace) plus the signals the platform
// uses to personalise — listed, counted and resettable per part. A reset is a cut-off time: signals older than it are
// ignored by the profile, the weakness center and the mastery estimates; the attempts and reviews are NEVER deleted.
// Preferences change how things are explained, never medical facts or their sources.
import {
  EXPLANATION_LEVELS,
  PROFILE_SIGNAL_PARTS,
  type LearningProfilePatch,
  type LearningProfileView,
  type ProfileSignalPart,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';

export type SignalResets = Record<ProfileSignalPart, number | null>;

const PART_LABELS: Record<ProfileSignalPart, { label: string; used: string }> = {
  mcq_attempts: { label: 'إجاباتك في أسئلة الاختيار من متعدد', used: 'مركز الضعف، الإتقان التقديري، جلسة المراجعة السريعة' },
  card_reviews: { label: 'مراجعات البطاقات', used: 'مركز الضعف (البطاقات المنسية). جدولة البطاقات وتقدير النسيان يُبنيان دائمًا من سجل المراجعات كاملًا، ولا تغيّرهما إعادة الضبط' },
  written_attempts: { label: 'تقييم إجاباتك المقالية (تقديري)', used: 'مركز الضعف' },
  mistake_types: { label: 'تصنيفات أخطائك (Mistake Genome)', used: 'توزيع أنواع الأخطاء وأسباب الضعف' },
  confidence: { label: 'مستوى الثقة الذي تختاره بعد الإجابة', used: 'وزن الإجابة الصحيحة في الإتقان (التخمين لا يُعد إتقانًا)' },
  pace: { label: 'سرعتك (الوقت لكل سؤال وبطاقة)', used: 'تقدير أوقات جلسة المراجعة السريعة وخطة الدراسة' },
};

interface ProfileRow {
  id: string;
  subjects_json: string;
  pace_minutes_per_day: number | null;
  signal_resets_json: string;
  updated_at: number;
}

function row(db: Db): ProfileRow | null {
  return db.get<ProfileRow>(`SELECT * FROM learning_profile WHERE id = 'owner'`) ?? null;
}

export function signalResets(db: Db): SignalResets {
  const r = fromJson<Partial<Record<ProfileSignalPart, number>>>(row(db)?.signal_resets_json, {}) ?? {};
  const out = {} as SignalResets;
  for (const p of PROFILE_SIGNAL_PARTS) out[p] = typeof r[p] === 'number' ? r[p]! : null;
  return out;
}

function ensure(db: Db, now: number): ProfileRow {
  db.run(`INSERT INTO learning_profile (id, subjects_json, pace_minutes_per_day, signal_resets_json, updated_at) VALUES ('owner', '[]', NULL, '{}', ?) ON CONFLICT(id) DO NOTHING`, [now]);
  return row(db)!;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Owner pace measured from attempts / reviews after the 'pace' reset (seconds; null with fewer than 5 samples). */
export function measuredPace(db: Db, resets: SignalResets = signalResets(db)): LearningProfileView['measured_pace'] {
  const since = resets.pace ?? 0;
  const q = db.all<{ t: number }>('SELECT time_ms AS t FROM question_attempt WHERE time_ms IS NOT NULL AND time_ms > 0 AND answered_at >= ? ORDER BY answered_at DESC LIMIT 500', [since]).map((r) => r.t / 1000);
  const c = db.all<{ t: number }>('SELECT duration_ms AS t FROM review_event WHERE duration_ms IS NOT NULL AND duration_ms > 0 AND reviewed_at >= ? ORDER BY reviewed_at DESC LIMIT 500', [since]).map((r) => r.t / 1000);
  return {
    median_seconds_per_question: q.length >= 5 ? Math.round(median(q)!) : null,
    median_seconds_per_card: c.length >= 5 ? Math.round(median(c)!) : null,
    sample: q.length + c.length,
  };
}

function count(db: Db, sql: string, since: number | null): number {
  return db.get<{ n: number }>(sql, [since ?? 0])?.n ?? 0;
}

export function getProfile(ctx: AppContext): LearningProfileView {
  const s = ctx.settings.get();
  const r = row(ctx.db);
  const resets = signalResets(ctx.db);
  const counts: Record<ProfileSignalPart, number> = {
    mcq_attempts: count(ctx.db, 'SELECT COUNT(*) AS n FROM question_attempt WHERE answered_at >= ?', resets.mcq_attempts),
    card_reviews: count(ctx.db, 'SELECT COUNT(*) AS n FROM review_event WHERE reviewed_at >= ?', resets.card_reviews),
    written_attempts: count(ctx.db, 'SELECT COUNT(*) AS n FROM written_attempt WHERE answered_at >= ?', resets.written_attempts),
    mistake_types: count(ctx.db, 'SELECT COUNT(*) AS n FROM question_attempt WHERE mistake_type IS NOT NULL AND answered_at >= ?', resets.mistake_types),
    confidence: count(ctx.db, 'SELECT COUNT(*) AS n FROM question_attempt WHERE confidence IS NOT NULL AND answered_at >= ?', resets.confidence),
    pace:
      count(ctx.db, 'SELECT COUNT(*) AS n FROM question_attempt WHERE time_ms IS NOT NULL AND answered_at >= ?', resets.pace) +
      count(ctx.db, 'SELECT COUNT(*) AS n FROM review_event WHERE duration_ms IS NOT NULL AND reviewed_at >= ?', resets.pace),
  };
  const signals = PROFILE_SIGNAL_PARTS.map((part) => ({ part, label_ar: PART_LABELS[part].label, used_for_ar: PART_LABELS[part].used, count: counts[part], reset_at: resets[part] }));
  const used = signals
    .filter((x) => x.count > 0)
    .map((x) => `${x.label_ar} (${x.count}) — تُستخدم في: ${x.used_for_ar}${x.reset_at ? ' — بعد إعادة الضبط فقط' : ''}`);
  if (s.self_level.trim()) used.unshift(`المستوى الذي حددته بنفسك: «${s.self_level.trim()}» — يغيّر أسلوب الشرح فقط`);
  return {
    self_level: s.self_level,
    subjects_studied: fromJson<string[]>(r?.subjects_json, []) ?? [],
    preferences: { explanation_level: s.explanation_level, dialect: s.dialect, socratic: s.socratic_default },
    pace_minutes_per_day: r?.pace_minutes_per_day ?? null,
    used_signals_ar: used.length ? used : ['لا توجد بيانات تعلم مستخدمة بعد؛ ستظهر هنا عند حل الأسئلة ومراجعة البطاقات.'],
    signals,
    facts_note_ar: 'تفضيلاتك ومستواك يغيّران طريقة الشرح وترتيب المراجعة فقط، ولا يغيّران الحقائق الطبية ولا مصادرها.',
    measured_pace: measuredPace(ctx.db, resets),
    updated_at: r?.updated_at ?? null,
  };
}

export function patchProfile(ctx: AppContext, patch: LearningProfilePatch): LearningProfileView {
  const now = ctx.clock.now();
  const settingsPatch: Record<string, unknown> = {};
  if (patch.self_level !== undefined) settingsPatch.self_level = patch.self_level;
  if (patch.preferences?.explanation_level !== undefined) {
    if (!(EXPLANATION_LEVELS as readonly string[]).includes(patch.preferences.explanation_level)) {
      throw new AppError('VALIDATION_FAILED', 'مستوى الشرح غير معروف.', 400);
    }
    settingsPatch.explanation_level = patch.preferences.explanation_level;
  }
  if (patch.preferences?.dialect !== undefined) settingsPatch.dialect = patch.preferences.dialect;
  if (patch.preferences?.socratic !== undefined) settingsPatch.socratic_default = patch.preferences.socratic;
  ctx.db.tx(() => {
    if (Object.keys(settingsPatch).length) {
      const r = ctx.settings.patch(settingsPatch);
      if (r.changedKeys.length) ctx.audit.record({ entityType: 'owner_setting', entityId: 'owner', action: 'update', summary: `حدّثت ملف التعلم: ${r.changedKeys.join('، ')}.`, before: Object.fromEntries(r.changedKeys.map((k) => [k, (r.before as Record<string, unknown>)[k]])), after: Object.fromEntries(r.changedKeys.map((k) => [k, (r.after as Record<string, unknown>)[k]])) });
    }
    if (patch.subjects_studied !== undefined || patch.pace_minutes_per_day !== undefined) {
      const cur = ensure(ctx.db, now);
      const subjects = patch.subjects_studied !== undefined ? [...new Set(patch.subjects_studied.map((x) => x.trim()).filter(Boolean))].slice(0, 100) : fromJson<string[]>(cur.subjects_json, []);
      const pace = patch.pace_minutes_per_day !== undefined ? patch.pace_minutes_per_day : cur.pace_minutes_per_day;
      ctx.db.run(`UPDATE learning_profile SET subjects_json = ?, pace_minutes_per_day = ?, updated_at = ? WHERE id = 'owner'`, [toJson(subjects), pace, now]);
      ctx.audit.record({ entityType: 'learning_profile', entityId: 'owner', action: 'update', summary: 'حدّثت المواد المدروسة أو وقت الدراسة اليومي في ملف التعلم.' });
    }
  });
  return getProfile(ctx);
}

export function resetSignalPart(ctx: AppContext, part: ProfileSignalPart): LearningProfileView {
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    const cur = ensure(ctx.db, now);
    const resets = fromJson<Record<string, number>>(cur.signal_resets_json, {}) ?? {};
    resets[part] = now;
    ctx.db.run(`UPDATE learning_profile SET signal_resets_json = ?, updated_at = ? WHERE id = 'owner'`, [toJson(resets), now]);
    ctx.audit.record({
      entityType: 'learning_profile',
      entityId: 'owner',
      action: 'reset_signals',
      summary: `أعدت ضبط «${PART_LABELS[part].label}» في ملف التعلم: لن تُستخدم الإشارات الأقدم في التخصيص (البيانات نفسها محفوظة).`,
      after: { part, at: now },
    });
  });
  return getProfile(ctx);
}
