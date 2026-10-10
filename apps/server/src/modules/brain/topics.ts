// Topics (§05) on top of the library's topic / topic_link tables (owned by the library module; links are written only
// through its services). The brain adds:
//  * deterministic SUGGESTIONS: a topic whose title (or Arabic title) names a concept → the sources where that
//    concept is a heading or a definition, those regions, the concept itself, and the questions whose text names the
//    topic. Suggestions go through `suggestTopicLink`, which never overrides a link the owner decided (accepted,
//    rejected or made by hand) — a rejected suggestion is never made again;
//  * the topic detail with every link resolved to something readable (title, page, stem) and a reason.
import { pageDisplayLabel, stemPreview, TOPIC_ENTITY_TYPES, type RichText, type TopicDetailResponse, type TopicLinkDetail } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { suggestTopicLink } from '../library/tags';
import { ConceptIndex, nameNorm } from './resolve';
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
  ctx.db.tx(() => {
    for (const t of topics) {
      const names = [t.title, t.title_ar].filter((n): n is string => !!n && nameNorm(n).length >= 3);
      const conceptIds = new Set<string>();
      if (t.concept_id) conceptIds.add(t.concept_id);
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
};

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
      const page = r.page_index !== null ? pageDisplayLabel({ page_index: r.page_index, printed_label: r.printed_label, kind: (r.kind ?? 'page') as never }) : null;
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
  };
  if (!(TOPIC_ENTITY_TYPES as readonly string[]).includes(type)) return false;
  return !!ctx.db.get(`SELECT 1 AS x FROM ${table[type]} WHERE id = ?`, [id]);
}

export { inList };
