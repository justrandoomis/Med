// Persisting one extraction (job `extract_knowledge`, one source version). Idempotent: the version's previous stated
// mentions are replaced; concepts are shared across lectures (found by name / alias, merges followed) and an existing
// concept is NEVER changed in a way that undoes an owner decision — its status, owner name, kind and merges stay.
// After the version: the course's inferred relations and the topic suggestions are refreshed (owner decisions kept).
import type { ConceptRole } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { joinBilingualSuggestions } from './concepts';
import { recomputeCourseRelations } from './course';
import { EXTRACTOR_VERSION, extractKnowledge, type RegionIn } from './extract';
import { ConceptIndex, nameNorm } from './resolve';
import { courseKey, PROCESSED, studySource } from './store';
import { suggestTopicLinks } from './topics';

/** Stated mentions kept per source version (a very long textbook is cut here — the course page says so). */
export const MAX_MENTIONS = 1500;

const KIND_OF_ROLE: Partial<Record<ConceptRole, string>> = { investigation: 'investigation', sign: 'sign', drug: 'drug', mechanism: 'mechanism' };

export interface ExtractionSummary {
  status: 'completed' | 'nothing_found';
  counts: { concepts: number; mentions: number; definitions: number; sections: number; table_entries: number; mentions_found: number };
  roles: Record<string, number>;
  objectives: Array<{ text: string; region_id: string; page_id: string | null }>;
  sections: Array<{ title: string; role: string | null; region_id: string }>;
  created_concepts: number;
  relations: { created: number; updated: number; removed: number; kept_owner: number } | null;
}

export function runKnowledgeExtraction(ctx: AppContext, versionId: string, jobId: string | null = null): ExtractionSummary {
  const v = ctx.db.get<{ id: string; source_id: string; processing_status: string }>('SELECT id, source_id, processing_status FROM source_version WHERE id = ?', [versionId]);
  if (!v) throw new AppError('NOT_FOUND', 'نسخة المصدر غير موجودة.', 404);
  if (!PROCESSED.includes(v.processing_status)) {
    throw new AppError('CONFLICT', 'لم تكتمل معالجة هذه النسخة بعد؛ يُستخرج هيكل المعرفة بعد المعالجة.', 409);
  }
  const regions = ctx.db.all<RegionIn>(
    `SELECT r.id, r.page_id, p.page_index, r.kind, r.text, r.structure_json, r.parent_region_id
       FROM source_region r JOIN source_page p ON p.id = r.page_id
      WHERE r.version_id = ? AND r.status <> 'rejected' ORDER BY p.page_index, r.reading_order`,
    [versionId],
  );
  const x = extractKnowledge(regions);
  const now = ctx.clock.now();
  const roles: Record<string, number> = {};
  for (const m of x.mentions) roles[m.role] = (roles[m.role] ?? 0) + 1;

  const result = ctx.db.tx(() => {
    ctx.db.run(`DELETE FROM concept_mention WHERE version_id = ? AND role NOT LIKE 'candidate%'`, [versionId]);
    const index = new ConceptIndex(ctx);
    const concepts = new Set<string>();
    let created = 0;
    for (const m of x.mentions.slice(0, MAX_MENTIONS)) {
      let id = index.find(m.name) ?? (m.nameAlt ? index.find(m.nameAlt) : null);
      if (!id) {
        id = newId(now);
        const en = m.lang === 'en' ? m.name : m.nameAlt && !/[؀-ۿ]/.test(m.nameAlt) ? m.nameAlt : null;
        const ar = m.lang === 'ar' ? m.name : m.nameAlt && /[؀-ۿ]/.test(m.nameAlt) ? m.nameAlt : null;
        ctx.db.run(
          `INSERT INTO concept (id, name_en, name_ar, kind, origin, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'auto', 'suggested', ?, ?)`,
          [id, en, ar, KIND_OF_ROLE[m.role] ?? null, now, now],
        );
        index.add(m.name, id);
        if (m.nameAlt) index.add(m.nameAlt, id);
        created++;
      } else if (m.nameAlt) {
        // a bilingual heading names the other language: fill it on an automatic name only (never over the owner's)
        const c = ctx.db.get<{ name_en: string | null; name_ar: string | null; name_origin: string }>('SELECT name_en, name_ar, name_origin FROM concept WHERE id = ?', [id]);
        const altIsAr = /[؀-ۿ]/.test(m.nameAlt);
        let owner = index.find(m.nameAlt);
        // the heading pairs the two names: two undecided suggestions of them become one concept
        if (owner !== null && owner !== id && joinBilingualSuggestions(ctx, id, owner, m.nameAlt)) {
          index.add(m.nameAlt, id);
          owner = id;
        }
        if (c && c.name_origin === 'auto' && (owner === null || owner === id)) {
          if (altIsAr && !c.name_ar) ctx.db.run('UPDATE concept SET name_ar = ?, updated_at = ? WHERE id = ?', [m.nameAlt, now, id]);
          if (!altIsAr && !c.name_en) ctx.db.run('UPDATE concept SET name_en = ?, updated_at = ? WHERE id = ?', [m.nameAlt, now, id]);
          index.add(m.nameAlt, id);
        }
      }
      concepts.add(id);
      ctx.db.run(
        `INSERT INTO concept_mention (id, concept_id, region_id, version_id, role, support, quote, section, extractor_version, created_at)
         VALUES (?, ?, ?, ?, ?, 'stated', ?, ?, ?, ?)`,
        [newId(now), id, m.regionId, versionId, m.role, m.quote, m.section, EXTRACTOR_VERSION, now],
      );
    }
    const summary: ExtractionSummary = {
      status: x.mentions.length > 0 || x.objectives.length > 0 ? 'completed' : 'nothing_found',
      counts: {
        concepts: concepts.size,
        mentions: Math.min(x.mentions.length, MAX_MENTIONS),
        mentions_found: x.mentions.length,
        definitions: (roles.definition ?? 0) + (roles.classification ?? 0),
        sections: x.sections.filter((s) => s.role !== null).length,
        table_entries: (roles.table_entry ?? 0) + (roles.value ?? 0),
      },
      roles,
      objectives: x.objectives.slice(0, 50).map((o) => ({ text: o.text, region_id: o.regionId, page_id: o.pageId })),
      sections: x.sections.slice(0, 100).map((s) => ({ title: s.title, role: s.role, region_id: s.regionId })),
      created_concepts: created,
      relations: null,
    };
    ctx.db.run(
      `INSERT INTO concept_extraction (version_id, source_id, status, summary_json, extractor_version, job_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(version_id) DO UPDATE SET status = excluded.status, summary_json = excluded.summary_json, extractor_version = excluded.extractor_version,
         job_id = excluded.job_id, updated_at = excluded.updated_at`,
      [versionId, v.source_id, summary.status, toJson(summary), EXTRACTOR_VERSION, jobId, now],
    );
    return summary;
  });

  // course-level follow-ups (separate transactions; owner decisions are never touched). A source moved to the trash
  // meanwhile has no course to update (its relations are recomputed when it is restored and its course page opens).
  const live = ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM source WHERE id = ?', [v.source_id]);
  if (!live || live.deleted_at !== null) return result;
  const src = studySource(ctx, v.source_id);
  result.relations = recomputeCourseRelations(ctx, courseKey(src));
  suggestTopicLinks(ctx);
  return result;
}

/** Was this version extracted with the current extractor? */
export function extractionOf(ctx: AppContext, versionId: string): { status: string; extractor_version: string; summary_json: string; updated_at: number; job_id: string | null } | null {
  return ctx.db.get('SELECT status, extractor_version, summary_json, updated_at, job_id FROM concept_extraction WHERE version_id = ?', [versionId]) ?? null;
}

export { nameNorm };
