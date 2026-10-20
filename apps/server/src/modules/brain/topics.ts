// Topics (§05) on top of the library's topic / topic_link tables (owned by the library module; links are written only
// through its services). The brain adds:
//  * deterministic SUGGESTIONS: a topic whose title (or Arabic title) names a concept → the sources where that
//    concept is a heading or a definition, those regions, the concept itself, and the questions whose text names the
//    topic. Suggestions go through `suggestTopicLink`, which never overrides a link the owner decided (accepted,
//    rejected or made by hand) — a rejected suggestion is never made again;
//  * the topic detail with every link resolved to something readable (title, page, stem) and a reason.
import { ARTIFACT_KIND_LABELS_AR, CASE_KIND_LABELS_AR, stemPreview, TOPIC_ENTITY_TYPES, type CaseKind, type RichText, type TopicAttemptView, type TopicDetailResponse, type TopicLinkDetail } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { suggestTopicLink } from '../library/tags';
import { pageLabelAr } from '../sources/pagelabel';
import { ConceptIndex, nameNorm, resolveConceptId } from './resolve';
import { inList } from './store';

interface TopicRow {
  id: string;
  title: string;
  title_ar: string | null;
  parent_topic_id: string | null;
  concept_id: string | null;
  created_at: number;
  updated_at: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Make the deterministic suggestions for one topic (or every topic). Owner decisions are kept as they are. */
export function suggestTopicLinks(ctx: AppContext, topicId?: string): { created: number; kept: number } {
  const topics = topicId
    ? ctx.db.all<TopicRow>('SELECT * FROM topic WHERE id = ?', [topicId])
    : ctx.db.all<TopicRow>('SELECT * FROM topic ORDER BY created_at LIMIT 500');
  if (topicId && topics.length === 0) throw new AppError('NOT_FOUND', 'الموضوع غير موجود.', 404);
  if (topics.length === 0) return { created: 0, kept: 0 };
  const index = new ConceptIndex(ctx);
  let created = 0;
  let kept = 0;
  const suggest = (tid: string, type: string, id: string) => {
    if (suggestTopicLink(ctx, tid, type, id)) created++;
    else kept++;
  };
  // live questions (current version text) — read once
  let questions: Array<{ id: string; norm: string }> | null = null;
  let cases: Array<{ id: string; norm: string }> | null = null;
  ctx.db.tx(() => {
    for (const t of topics) {
      const names = [t.title, t.title_ar].filter((n): n is string => !!n && nameNorm(n).length >= 3);
      const conceptIds = new Set<string>();
      // a topic's concept may have been merged since: suggest the concept it joined (never the pointer)
      if (t.concept_id) conceptIds.add(resolveConceptId(ctx, t.concept_id));
      for (const n of names) {
        const c = index.find(n);
        if (c) conceptIds.add(c);
      }
      for (const cid of conceptIds) {
        const c = ctx.db.get<{ status: string }>('SELECT status FROM concept WHERE id = ?', [cid]);
        if (!c || c.status === 'rejected') continue;
        suggest(t.id, 'concept', cid);
        const ms = ctx.db.all<{ region_id: string; source_id: string }>(
          `SELECT m.region_id, v.source_id FROM concept_mention m JOIN source_version v ON v.id = m.version_id JOIN source s ON s.id = v.source_id
            WHERE m.concept_id = ? AND m.support = 'stated' AND m.role IN ('heading','definition','classification') AND s.deleted_at IS NULL
              AND (v.id = COALESCE(s.frozen_version_id, s.current_version_id))
            LIMIT 50`,
          [cid],
        );
        for (const sid of new Set(ms.map((m) => m.source_id))) suggest(t.id, 'source', sid);
        for (const m of ms.slice(0, 10)) suggest(t.id, 'source_region', m.region_id);
      }
      if (names.length) {
        questions ??= ctx.db
          .all<{ id: string; stem_raw: string | null; stem_json: string }>(
            `SELECT q.id, v.stem_raw, v.stem_json FROM question q JOIN question_version v ON v.id = q.current_version_id
              WHERE q.deleted_at IS NULL AND q.status <> 'retired' LIMIT 20000`,
          )
          .map((q) => ({ id: q.id, norm: nameNorm(q.stem_raw ?? stemPreview(fromJson<RichText>(q.stem_json), 2000)) }));
        const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${names.map((n) => escapeRe(nameNorm(n))).join('|')})(?:$|[^\\p{L}\\p{N}])`, 'u');
        for (const q of questions) if (re.test(q.norm)) suggest(t.id, 'question', q.id);
        // Round 7 H4: a clinical case / OSCE station / viva whose TITLE names the topic (not trashed)
        cases ??= ctx.db
          .all<{ id: string; title: string }>('SELECT id, title FROM clinical_case WHERE deleted_at IS NULL ORDER BY created_at LIMIT 5000')
          .map((c) => ({ id: c.id, norm: nameNorm(c.title) }));
        for (const c of cases) if (re.test(c.norm)) suggest(t.id, 'clinical_case', c.id);
      }
    }
  });
  return { created, kept };
}

const REASON_AR: Record<string, string> = {
  concept: 'المفهوم يحمل اسم الموضوع.',
  source: 'اسم الموضوع عنوان أو تعريف في هذا المصدر.',
  source_region: 'هنا يظهر اسم الموضوع عنوانًا أو تعريفًا.',
  question: 'اسم الموضوع مذكور في نص السؤال.',
  clinical_case: 'اسم الموضوع في عنوان الحالة.',
};

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** «صحيحة 3 من 5 مُقيَّمة» from the attempt's own rows (unscored answers are not counted as wrong). */
function examAttemptScore(ctx: AppContext, attemptId: string): string | null {
  const r = ctx.db.get<{ scored: number; correct: number | null; answered: number }>(
    `SELECT COUNT(*) AS answered, COALESCE(SUM(scored), 0) AS scored, SUM(CASE WHEN scored = 1 AND is_correct = 1 THEN 1 ELSE 0 END) AS correct
       FROM question_attempt WHERE exam_attempt_id = ?`,
    [attemptId],
  );
  if (!r || r.answered === 0) return 'لا إجابات مسجّلة';
  return r.scored > 0 ? `صحيحة ${r.correct ?? 0} من ${r.scored} مُقيَّمة` : `${r.answered} إجابات بلا مفتاح مُقيِّم`;
}

const EXAM_STATUS_AR: Record<string, string> = { in_progress: 'جارية', paused: 'متوقفة مؤقتًا', completed: 'مكتملة', abandoned: 'متروكة' };
const CASE_ATTEMPT_STATUS_AR: Record<string, string> = { in_progress: 'جارية', completed: 'مكتملة', abandoned: 'متروكة' };

function resolveLink(ctx: AppContext, l: { entity_type: string; entity_id: string; origin: string }): Pick<TopicLinkDetail, 'label' | 'sublabel' | 'href' | 'reason_ar'> {
  const reason = l.origin === 'auto' ? (REASON_AR[l.entity_type] ?? 'اقتراح تلقائي.') : null;
  const e = encodeURIComponent;
  switch (l.entity_type) {
    case 'source': {
      const s = ctx.db.get<{ title: string; source_type: string; deleted_at: number | null }>('SELECT title, source_type, deleted_at FROM source WHERE id = ?', [l.entity_id]);
      if (!s) return { label: null, sublabel: null, href: null, reason_ar: reason };
      return { label: s.title, sublabel: s.deleted_at !== null ? 'في سلة المحذوفات' : null, href: `/sources/${e(l.entity_id)}`, reason_ar: reason };
    }
    case 'source_region': {
      const r = ctx.db.get<{ text: string | null; source_id: string; title: string; version_id: string; page_id: string | null; page_index: number | null; printed_label: string | null; kind: string | null }>(
        `SELECT r.text, v.source_id, s.title, r.version_id, p.id AS page_id, p.page_index, p.printed_label, p.kind
           FROM source_region r JOIN source_version v ON v.id = r.version_id JOIN source s ON s.id = v.source_id LEFT JOIN source_page p ON p.id = r.page_id WHERE r.id = ?`,
        [l.entity_id],
      );
      if (!r) return { label: null, sublabel: null, href: null, reason_ar: reason };
      const page = r.page_index !== null ? pageLabelAr(ctx.db, { version_id: r.version_id, page_index: r.page_index, printed_label: r.printed_label, kind: r.kind ?? 'page' }) : null;
      const q = new URLSearchParams({ v: r.version_id, ...(r.page_id ? { page_id: r.page_id } : {}), region: l.entity_id });
      return { label: (r.text ?? '').replace(/\s+/g, ' ').slice(0, 140) || '(موضع بلا نص)', sublabel: `${r.title}${page ? ` — ${page}` : ''}`, href: `/study/${e(r.source_id)}?${q.toString()}`, reason_ar: reason };
    }
    case 'question': {
      const q = ctx.db.get<{ stem_json: string; deleted_at: number | null; origin_type: string }>(
        'SELECT v.stem_json, q.deleted_at, q.origin_type FROM question q JOIN question_version v ON v.id = q.current_version_id WHERE q.id = ?',
        [l.entity_id],
      );
      if (!q) return { label: null, sublabel: null, href: null, reason_ar: reason };
      return {
        label: stemPreview(fromJson<RichText>(q.stem_json), 160),
        sublabel: q.origin_type === 'generated' ? 'سؤال مولَّد' : q.origin_type === 'owner' ? 'سؤال أضفته' : 'سؤال من المصادر',
        href: `/questions/${e(l.entity_id)}`,
        reason_ar: reason,
      };
    }
    case 'library_node': {
      const n = ctx.db.get<{ title: string }>('SELECT title FROM library_node WHERE id = ?', [l.entity_id]);
      return n ? { label: n.title, sublabel: null, href: `/library/${e(l.entity_id)}`, reason_ar: reason } : { label: null, sublabel: null, href: null, reason_ar: reason };
    }
    case 'concept': {
      const c = ctx.db.get<{ name_en: string | null; name_ar: string | null; status: string }>('SELECT name_en, name_ar, status FROM concept WHERE id = ?', [l.entity_id]);
      return c
        ? { label: [c.name_en, c.name_ar].filter(Boolean).join(' — '), sublabel: c.status === 'rejected' ? 'مفهوم مرفوض' : null, href: `/concepts/${e(l.entity_id)}`, reason_ar: reason }
        : { label: null, sublabel: null, href: null, reason_ar: reason };
    }
    case 'image_asset': {
      const i = ctx.db.get<{ caption: string | null }>('SELECT caption FROM image_asset WHERE id = ?', [l.entity_id]);
      return i ? { label: i.caption ?? 'صورة', sublabel: null, href: `/media/images/${e(l.entity_id)}`, reason_ar: reason } : { label: null, sublabel: null, href: null, reason_ar: reason };
    }
    case 'flashcard': {
      const f = ctx.db.get<{ front_json: string }>('SELECT front_json FROM flashcard WHERE id = ? AND deleted_at IS NULL', [l.entity_id]);
      return f ? { label: stemPreview(fromJson<RichText>(f.front_json), 120), sublabel: 'بطاقة', href: `/review/cards/${e(l.entity_id)}`, reason_ar: reason } : { label: null, sublabel: null, href: null, reason_ar: reason };
    }
    case 'note': {
      const n = ctx.db.get<{ body_json: string }>('SELECT body_json FROM note WHERE id = ?', [l.entity_id]);
      return n ? { label: stemPreview(fromJson<RichText>(n.body_json), 120) || 'ملاحظة', sublabel: 'ملاحظة', href: null, reason_ar: reason } : { label: null, sublabel: null, href: null, reason_ar: reason };
    }
    // ───── Round 7 H4 ─────
    case 'clinical_case': {
      const c = ctx.db.get<{ title: string; kind: CaseKind; origin: string | null; deleted_at: number | null }>('SELECT title, kind, origin, deleted_at FROM clinical_case WHERE id = ?', [l.entity_id]);
      if (!c) return { label: null, sublabel: null, href: null, reason_ar: reason };
      const parts = [CASE_KIND_LABELS_AR[c.kind] ?? 'حالة', c.origin === 'generated' ? 'مولّدة' : 'كتبتها بنفسك'];
      if (c.deleted_at !== null) parts.push('في سلة المحذوفات');
      return { label: c.title, sublabel: parts.join(' · '), href: `/cases/${e(l.entity_id)}`, reason_ar: reason };
    }
    case 'artifact': {
      const a = ctx.db.get<{ kind: string; title: string | null; status: string; lineage_id: string; version_no: number; created_at: number }>(
        'SELECT kind, title, status, lineage_id, version_no, created_at FROM artifact WHERE id = ?',
        [l.entity_id],
      );
      if (!a) return { label: null, sublabel: null, href: null, reason_ar: reason };
      const newer = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact WHERE lineage_id = ? AND version_no > ?', [a.lineage_id, a.version_no])?.n ?? 0;
      const parts = [ARTIFACT_KIND_LABELS_AR[a.kind] ?? 'محتوى مولّد', fmtDate(a.created_at)];
      if (a.status === 'stale') parts.push('قديم — تغيّر مصدره');
      if (newer > 0) parts.push('توجد نسخة أحدث');
      return { label: a.title ?? ARTIFACT_KIND_LABELS_AR[a.kind] ?? 'محتوى مولّد', sublabel: parts.join(' · '), href: `/explanations/${e(l.entity_id)}`, reason_ar: reason };
    }
    case 'exam_attempt': {
      const x = ctx.db.get<{ title: string; mode: string; status: string; started_at: number }>(
        'SELECT e.title, e.mode, a.status, a.started_at FROM exam_attempt a JOIN exam e ON e.id = a.exam_id WHERE a.id = ?',
        [l.entity_id],
      );
      if (!x) return { label: null, sublabel: null, href: null, reason_ar: reason };
      const done = x.status === 'completed';
      return {
        label: x.title,
        sublabel: [fmtDate(x.started_at), EXAM_STATUS_AR[x.status] ?? x.status, examAttemptScore(ctx, l.entity_id)].filter(Boolean).join(' · '),
        href: done ? `/exams/${e(l.entity_id)}/results` : `/exams/${e(l.entity_id)}`,
        reason_ar: reason,
      };
    }
    case 'case_attempt': {
      const x = ctx.db.get<{ title: string; kind: CaseKind; status: string; started_at: number; assessment_json: string | null }>(
        'SELECT c.title, c.kind, a.status, a.started_at, a.assessment_json FROM case_attempt a JOIN clinical_case c ON c.id = a.case_id WHERE a.id = ?',
        [l.entity_id],
      );
      if (!x) return { label: null, sublabel: null, href: null, reason_ar: reason };
      const score = fromJson<{ score?: { got: number; max: number } | null }>(x.assessment_json, {})?.score ?? null;
      return {
        label: x.title,
        sublabel: [CASE_KIND_LABELS_AR[x.kind], fmtDate(x.started_at), CASE_ATTEMPT_STATUS_AR[x.status] ?? x.status, score ? `تقدير ${score.got} من ${score.max}` : null].filter(Boolean).join(' · '),
        href: x.status === 'in_progress' ? `/cases/run/${e(l.entity_id)}` : `/cases/report/${e(l.entity_id)}`,
        reason_ar: reason,
      };
    }
    default:
      return { label: null, sublabel: null, href: null, reason_ar: reason };
  }
}

export function topicDetail(ctx: AppContext, topicId: string): TopicDetailResponse {
  const t = ctx.db.get<TopicRow>('SELECT * FROM topic WHERE id = ?', [topicId]);
  if (!t) throw new AppError('NOT_FOUND', 'الموضوع غير موجود.', 404);
  const rows = ctx.db.all<{ id: string; topic_id: string; entity_type: string; entity_id: string; origin: 'auto' | 'owner'; status: TopicLinkDetail['status']; created_at: number }>(
    `SELECT id, topic_id, entity_type, entity_id, origin, status, created_at FROM topic_link WHERE topic_id = ?
      ORDER BY CASE status WHEN 'accepted' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END, entity_type, created_at`,
    [topicId],
  );
  const links: TopicLinkDetail[] = rows.map((r) => ({ ...r, ...resolveLink(ctx, r) }));
  const children = ctx.db.all<{ id: string; title: string; title_ar: string | null }>('SELECT id, title, title_ar FROM topic WHERE parent_topic_id = ? ORDER BY title COLLATE NOCASE', [topicId]);
  return {
    attempts: topicAttempts(ctx, rows),
    topic: { id: t.id, title: t.title, title_ar: t.title_ar, parent_topic_id: t.parent_topic_id, created_at: t.created_at, updated_at: t.updated_at },
    links,
    children,
    counts: {
      accepted: rows.filter((r) => r.status === 'accepted').length,
      suggested: rows.filter((r) => r.status === 'suggested').length,
      rejected: rows.filter((r) => r.status === 'rejected').length,
    },
  };
}

const ATTEMPTS_CAP = 50;

/**
 * Past attempts of a topic (Round 7 H4, §05 «محاولاتي السابقة»): attempts the owner linked, plus — read from the
 * attempt history, never stored — attempts on the questions and cases the topic links to (accepted or suggested;
 * a rejected link contributes nothing). Newest first; `total` counts every one, the list is capped.
 */
function topicAttempts(ctx: AppContext, links: Array<{ entity_type: string; entity_id: string; status: string; origin: string }>): { items: TopicAttemptView[]; total: number } {
  const live = links.filter((l) => l.status !== 'rejected');
  const items: TopicAttemptView[] = [];
  const seen = new Set<string>();
  const push = (v: TopicAttemptView) => {
    const k = `${v.kind}:${v.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    items.push(v);
  };
  for (const l of live) {
    if (l.entity_type !== 'exam_attempt' && l.entity_type !== 'case_attempt') continue;
    const r = resolveLink(ctx, { entity_type: l.entity_type, entity_id: l.entity_id, origin: 'owner' });
    if (!r.label) continue;
    const at =
      l.entity_type === 'exam_attempt'
        ? (ctx.db.get<{ t: number }>('SELECT started_at AS t FROM exam_attempt WHERE id = ?', [l.entity_id])?.t ?? 0)
        : (ctx.db.get<{ t: number }>('SELECT started_at AS t FROM case_attempt WHERE id = ?', [l.entity_id])?.t ?? 0);
    push({ kind: l.entity_type, id: l.entity_id, label: r.label, sublabel: r.sublabel, href: r.href, at, via: 'linked', via_ar: 'ربطتها بالموضوع' });
  }
  const questionIds = live.filter((l) => l.entity_type === 'question').map((l) => l.entity_id);
  if (questionIds.length) {
    for (const qa of ctx.db.all<{ id: string; question_id: string; exam_attempt_id: string | null; is_correct: number | null; scored: number; answered_at: number; stem_json: string }>(
      `SELECT a.id, a.question_id, a.exam_attempt_id, a.is_correct, a.scored, a.answered_at, v.stem_json
         FROM question_attempt a JOIN question_version v ON v.id = a.question_version_id
        WHERE a.question_id IN (${inList(questionIds.length)}) ORDER BY a.answered_at DESC LIMIT 500`,
      questionIds,
    )) {
      push({
        kind: 'question_attempt',
        id: qa.id,
        label: stemPreview(fromJson<RichText>(qa.stem_json), 140),
        sublabel: [fmtDate(qa.answered_at), qa.scored ? (qa.is_correct ? 'صحيحة' : 'خاطئة') : 'غير مُقيَّمة (لا مفتاح مؤكد)'].join(' · '),
        href: qa.exam_attempt_id ? `/exams/${encodeURIComponent(qa.exam_attempt_id)}/results` : `/questions/${encodeURIComponent(qa.question_id)}`,
        at: qa.answered_at,
        via: 'question',
        via_ar: 'محاولة على سؤال مرتبط بالموضوع',
      });
    }
  }
  const caseIds = live.filter((l) => l.entity_type === 'clinical_case').map((l) => l.entity_id);
  if (caseIds.length) {
    for (const ca of ctx.db.all<{ id: string }>(`SELECT id FROM case_attempt WHERE case_id IN (${inList(caseIds.length)}) ORDER BY started_at DESC LIMIT 200`, caseIds)) {
      const r = resolveLink(ctx, { entity_type: 'case_attempt', entity_id: ca.id, origin: 'owner' });
      if (!r.label) continue;
      const at = ctx.db.get<{ t: number }>('SELECT started_at AS t FROM case_attempt WHERE id = ?', [ca.id])?.t ?? 0;
      push({ kind: 'case_attempt', id: ca.id, label: r.label, sublabel: r.sublabel, href: r.href, at, via: 'case', via_ar: 'محاولة على حالة مرتبطة بالموضوع' });
    }
  }
  items.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return { items: items.slice(0, ATTEMPTS_CAP), total: items.length };
}

export interface TopicListItem {
  id: string;
  title: string;
  title_ar: string | null;
  parent_topic_id: string | null;
  counts: { accepted: number; suggested: number; rejected: number; sources: number; questions: number };
  updated_at: number;
}

export function topicList(ctx: AppContext): { topics: TopicListItem[] } {
  const topics = ctx.db.all<TopicRow>('SELECT * FROM topic ORDER BY title COLLATE NOCASE');
  const counts = new Map<string, TopicListItem['counts']>();
  for (const r of ctx.db.all<{ topic_id: string; entity_type: string; status: string; n: number }>(
    'SELECT topic_id, entity_type, status, COUNT(*) AS n FROM topic_link GROUP BY topic_id, entity_type, status',
  )) {
    const c = counts.get(r.topic_id) ?? { accepted: 0, suggested: 0, rejected: 0, sources: 0, questions: 0 };
    if (r.status === 'accepted' || r.status === 'suggested' || r.status === 'rejected') c[r.status] += r.n;
    if (r.status !== 'rejected' && r.entity_type === 'source') c.sources += r.n;
    if (r.status !== 'rejected' && r.entity_type === 'question') c.questions += r.n;
    counts.set(r.topic_id, c);
  }
  return {
    topics: topics.map((t) => ({
      id: t.id,
      title: t.title,
      title_ar: t.title_ar,
      parent_topic_id: t.parent_topic_id,
      counts: counts.get(t.id) ?? { accepted: 0, suggested: 0, rejected: 0, sources: 0, questions: 0 },
      updated_at: t.updated_at,
    })),
  };
}

/** Does the entity a topic link points at exist? (validation for owner links; known types only) */
export function topicEntityExists(ctx: AppContext, type: string, id: string): boolean {
  const table: Record<string, string> = {
    source: 'source',
    source_region: 'source_region',
    question: 'question',
    library_node: 'library_node',
    concept: 'concept',
    image_asset: 'image_asset',
    flashcard: 'flashcard',
    note: 'note',
    clinical_case: 'clinical_case',
    artifact: 'artifact',
    exam_attempt: 'exam_attempt',
    case_attempt: 'case_attempt',
  };
  if (!(TOPIC_ENTITY_TYPES as readonly string[]).includes(type)) return false;
  return !!ctx.db.get(`SELECT 1 AS x FROM ${table[type]} WHERE id = ?`, [id]);
}

export { inList };
