// Search module (/api/search) — track C1. Universal Search (§46) over document chunks, questions, the owner's
// notes, generated content and transcripts (see ./service.ts). Owns no tables of its own beyond the FTS
// indexes listed in ARCHITECTURE §2 (filled by the owning modules).
import { SEARCH_MODES, SEARCH_RESULT_TYPES, SOURCE_TYPES, type SearchResponse, type SearchResultType } from '@medlevo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseQuery } from '../../lib/http';
import { decodeCursor, universalSearch } from './service';

export const SEMANTIC_REASON_AR =
  'البحث الدلالي يحتاج مزود embeddings مضبوطًا على الخادم وفهرسًا دلاليًا للمقاطع، وهما غير متوفرين في هذا الإصدار. البحث بالكلمات والمطابقة الحرفية يعملان.';

const ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

const searchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  mode: z.enum(SEARCH_MODES).default('keyword'),
  types: z
    .string()
    .max(200)
    .optional()
    .transform((v, c) => {
      if (!v) return [] as SearchResultType[];
      const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = parts.filter((p) => !(SEARCH_RESULT_TYPES as readonly string[]).includes(p));
      if (bad.length) {
        c.addIssue({ code: 'custom', message: `أنواع نتائج غير معروفة: ${bad.join('، ')}.` });
        return z.NEVER;
      }
      return [...new Set(parts)] as SearchResultType[];
    }),
  source_type: z.enum(SOURCE_TYPES).optional(),
  node_id: ID.optional(),
  source_id: ID.optional(),
  version_id: ID.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

export default async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  ctx.capabilities.set('search.keyword', 'available');
  ctx.capabilities.set('search.semantic', 'requires_configuration', SEMANTIC_REASON_AR);

  app.get('/', async (req): Promise<SearchResponse> => {
    const q = parseQuery(searchQuery, req);
    if (q.mode === 'semantic') throw new AppError('FEATURE_DISABLED', SEMANTIC_REASON_AR, 409, { feature: 'search.semantic' });
    return universalSearch(ctx, {
      q: q.q,
      mode: q.mode,
      types: q.types,
      source_type: q.source_type,
      node_id: q.node_id,
      source_id: q.source_id,
      version_id: q.version_id,
      limit: q.limit,
      offset: decodeCursor(q.cursor),
    });
  });
}
