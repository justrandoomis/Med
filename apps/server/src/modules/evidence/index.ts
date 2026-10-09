// Evidence module (/api/evidence) — track C1. Owns evidence, claim, citation, verification_result,
// artifact_dependency, content_alert (+ content_alert_item / content_alert_job, migration 0300), concept*,
// medical_term (ARCHITECTURE §2). Services for other modules: ./services.ts.
//
// Routes:
//   POST /scope/resolve            Source Lock preview (ScopeResolveResponse)
//   GET  /alerts                   content change alerts (reconciled lazily); POST /alerts/:id/ack | /resolve
//   GET  /claims/:id               ClaimView
//   GET  /ribbon?owner_type&owner_id   Evidence Ribbon (coverage counts per source, never correctness)
//   POST /batch {ids, pinned_version_ids?} → {evidence, missing}
//   POST /from-region {region_id, start?, end?} → EvidenceView (idempotent)
//   GET/POST/PATCH/DELETE /terms   the owner's medical term dictionary (synonyms/abbreviations used by search)
//   GET  /:id                      EvidenceView
import {
  type ClaimView,
  type ContentAlertsResponse,
  type ContentAlertView,
  type EvidenceBatchResponse,
  type EvidenceRibbonResponse,
  type EvidenceView,
  type MedicalTermView,
  type ScopeResolveResponse,
} from '@medlevo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModuleOptions } from '../../context';
import { toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import { newId } from '../../lib/ids';
import { getClaimView, ribbonFor } from './claims';
import { getAlert, listAlerts, reconcileAlerts, setAlertStatus } from './dependencies';
import { fromRegion, getView, getViewsWithMissing } from './evidence';
import { resolveScope, toResolvedScope } from './scope';
import { termView } from './terms';

const ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const idParams = z.object({ id: ID });

const batchBody = z.object({
  ids: z.array(ID).max(500),
  pinned_version_ids: z.array(ID).max(200).optional(),
});
const fromRegionBody = z
  .object({
    region_id: ID,
    start: z.number().int().min(0).max(10_000_000).optional(),
    end: z.number().int().min(1).max(10_000_000).optional(),
  })
  .strict();
const ribbonQuery = z.object({ owner_type: z.string().min(1).max(40).regex(/^[a-z_]+$/), owner_id: ID });
const alertsQuery = z.object({
  status: z.enum(['open', 'acknowledged', 'resolved', 'active', 'all']).default('active'),
  source_id: ID.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const viewQuery = z.object({ pinned_version_ids: z.string().max(4000).optional() });

const termBody = z
  .object({
    term_en: z.string().trim().min(1).max(200),
    abbreviation: z.string().trim().max(40).nullable().optional(),
    synonyms: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    explanation_ar: z.string().trim().max(2000).nullable().optional(),
    accepted_translation_ar: z.string().trim().max(200).nullable().optional(),
    owner_preferred_ar: z.string().trim().max(200).nullable().optional(),
  })
  .strict();
const termPatch = termBody.partial().strict();

interface TermRowFull {
  id: string;
  term_en: string;
  abbreviation: string | null;
  synonyms_json: string;
  explanation_ar: string | null;
  accepted_translation_ar: string | null;
  owner_preferred_ar: string | null;
  origin: MedicalTermView['origin'];
  updated_at: number;
}

export default async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  ctx.capabilities.set('evidence.citations', 'available');

  app.post('/scope/resolve', async (req): Promise<ScopeResolveResponse> => {
    const r = resolveScope(ctx, req.body ?? {});
    return { scope: toResolvedScope(r), sources: r.sources, excluded: r.excluded };
  });

  // ───────── alerts ─────────
  app.get('/alerts', async (req): Promise<ContentAlertsResponse> => {
    const q = parseQuery(alertsQuery, req);
    reconcileAlerts(ctx);
    return { alerts: listAlerts(ctx, { status: q.status, sourceId: q.source_id, limit: q.limit }) };
  });
  app.get('/alerts/:id', async (req): Promise<{ alert: ContentAlertView }> => {
    const { id } = parseParams(idParams, req);
    return { alert: getAlert(ctx, id) };
  });
  app.post('/alerts/:id/ack', async (req): Promise<{ alert: ContentAlertView }> => {
    const { id } = parseParams(idParams, req);
    return { alert: setAlertStatus(ctx, id, 'acknowledged') };
  });
  app.post('/alerts/:id/resolve', async (req): Promise<{ alert: ContentAlertView }> => {
    const { id } = parseParams(idParams, req);
    return { alert: setAlertStatus(ctx, id, 'resolved') };
  });

  // ───────── claims & ribbon ─────────
  app.get('/claims/:id', async (req): Promise<{ claim: ClaimView }> => {
    const { id } = parseParams(idParams, req);
    return { claim: getClaimView(ctx, id) };
  });
  app.get('/ribbon', async (req): Promise<EvidenceRibbonResponse> => {
    const q = parseQuery(ribbonQuery, req);
    return {
      items: ribbonFor(ctx, q.owner_type, q.owner_id),
      note_ar: 'عدد الجمل المرتبطة بدليل من كل مصدر — تغطية وليست مقياسًا للصحة الطبية.',
    };
  });

  // ───────── evidence ─────────
  app.post('/batch', async (req): Promise<EvidenceBatchResponse> => {
    const b = parseBody(batchBody, req);
    return getViewsWithMissing(ctx, b.ids, { pinnedVersionIds: b.pinned_version_ids });
  });
  app.post('/from-region', async (req): Promise<{ evidence: EvidenceView }> => {
    const b = parseBody(fromRegionBody, req);
    const row = ctx.db.tx(() => fromRegion(ctx, b.region_id, { start: b.start, end: b.end }));
    return { evidence: getView(ctx, row.id, { pinnedVersionIds: [row.version_id] }) };
  });

  // ───────── owner medical term dictionary ─────────
  app.get('/terms', async (): Promise<{ terms: MedicalTermView[] }> => {
    const rows = ctx.db.all<TermRowFull>(
      'SELECT id, term_en, abbreviation, synonyms_json, explanation_ar, accepted_translation_ar, owner_preferred_ar, origin, updated_at FROM medical_term ORDER BY term_en COLLATE NOCASE LIMIT 5000',
    );
    return { terms: rows.map(termView) };
  });
  app.post('/terms', async (req): Promise<{ term: MedicalTermView }> => {
    const b = parseBody(termBody, req);
    const now = ctx.clock.now();
    const id = newId(now);
    if (ctx.db.get('SELECT 1 AS x FROM medical_term WHERE term_en = ? COLLATE NOCASE', [b.term_en])) {
      throw new AppError('CONFLICT', 'هذا المصطلح موجود في قاموسك؛ عدّله بدل إضافته مرة ثانية.', 409);
    }
    ctx.db.run(
      `INSERT INTO medical_term (id, term_en, abbreviation, synonyms_json, explanation_ar, accepted_translation_ar, owner_preferred_ar, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', ?, ?)`,
      [id, b.term_en, b.abbreviation ?? null, toJson(b.synonyms), b.explanation_ar ?? null, b.accepted_translation_ar ?? null, b.owner_preferred_ar ?? null, now, now],
    );
    ctx.audit.record({ entityType: 'medical_term', entityId: id, action: 'create', summary: `مصطلح جديد في القاموس: ${b.term_en}` });
    return { term: termView(ctx.db.get<TermRowFull>('SELECT * FROM medical_term WHERE id = ?', [id])!) };
  });
  app.patch('/terms/:id', async (req): Promise<{ term: MedicalTermView }> => {
    const { id } = parseParams(idParams, req);
    const b = parseBody(termPatch, req);
    const before = ctx.db.get<TermRowFull>('SELECT * FROM medical_term WHERE id = ?', [id]);
    if (!before) throw new AppError('NOT_FOUND', 'المصطلح غير موجود.', 404);
    const sets: string[] = [];
    const params: unknown[] = [];
    const col = (name: string, v: unknown) => {
      sets.push(`${name} = ?`);
      params.push(v);
    };
    if (b.term_en !== undefined) col('term_en', b.term_en);
    if (b.abbreviation !== undefined) col('abbreviation', b.abbreviation);
    if (b.synonyms !== undefined) col('synonyms_json', toJson(b.synonyms));
    if (b.explanation_ar !== undefined) col('explanation_ar', b.explanation_ar);
    if (b.accepted_translation_ar !== undefined) col('accepted_translation_ar', b.accepted_translation_ar);
    if (b.owner_preferred_ar !== undefined) col('owner_preferred_ar', b.owner_preferred_ar);
    if (sets.length > 0) {
      col('updated_at', ctx.clock.now());
      try {
        ctx.db.run(`UPDATE medical_term SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      } catch (e) {
        if (e instanceof Error && /UNIQUE/i.test(e.message)) throw new AppError('CONFLICT', 'يوجد مصطلح آخر بالاسم نفسه.', 409);
        throw e;
      }
      ctx.audit.record({ entityType: 'medical_term', entityId: id, action: 'update', summary: `تعديل مصطلح: ${before.term_en}` });
    }
    return { term: termView(ctx.db.get<TermRowFull>('SELECT * FROM medical_term WHERE id = ?', [id])!) };
  });
  app.delete('/terms/:id', async (req): Promise<{ ok: true }> => {
    const { id } = parseParams(idParams, req);
    const before = ctx.db.get<{ term_en: string }>('SELECT term_en FROM medical_term WHERE id = ?', [id]);
    if (!before) throw new AppError('NOT_FOUND', 'المصطلح غير موجود.', 404);
    ctx.db.run('DELETE FROM medical_term WHERE id = ?', [id]);
    ctx.audit.record({ entityType: 'medical_term', entityId: id, action: 'delete', summary: `حذف مصطلح: ${before.term_en}` });
    return { ok: true };
  });

  app.get('/:id', async (req): Promise<{ evidence: EvidenceView }> => {
    const { id } = parseParams(idParams, req);
    const q = parseQuery(viewQuery, req);
    const pinned = q.pinned_version_ids ? q.pinned_version_ids.split(',').filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s)) : [];
    return { evidence: getView(ctx, id, { pinnedVersionIds: pinned }) };
  });
}
