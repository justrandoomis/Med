// Study copies of official lectures (Academic OS P1-T5 step 2; BUILD_PLAN §3.7; ARCHITECTURE_DELTA §6.3, §6.5, §6.9,
// §7.5). Mounted at /api/copies — VAULT routes: the binding hook bound the signed-in user's own vault, and every route
// reads only that vault plus, through the copy services' second handle (`ctx.dbs`), the subject spaces the user is a
// member of (checked per request; a non-member gets the body of a missing item).
//
//   POST   /api/copies                       «ابدأ الدراسة» (StartStudyingRequest → StartStudyingResponse)
//   GET    /api/copies?source_id=&space_id=&lecture_id=     the user's copies
//   GET    /api/copies/link-candidates?source_id=           official twins of a private upload (19H.3)
//   POST   /api/copies/link                  «اربط بالمحاضرة الرسمية» (copy, never move)
//   GET    /api/copies/link-status?source_ids=   (C2) library rows: official copy / linked (+ pending review) / twin offered
//   GET    /api/copies/lecture-identity?space_id=&lecture_id=   (C2, 19H.1) versions, copies, linked lectures, explanations, objects
//   GET    /api/copies/:id · PATCH /api/copies/:id           one copy · its update / note-move policies
//   GET    /api/copies/:id/upstream          (P1-T5 step 3) what «طبّق التحديث» would change in a followed copy
//   POST   /api/copies/:id/upstream/apply    «طبّق التحديث» / «تخطَّ هذا الإصدار» (ApplyUpstreamRequest)
//
// Also registered here (own plugin, no core file edited): the fan-out jobs (fanout.ts), the purge step (purge refusal in
// a space, copy rows in a vault), the «holders of a copy» notification audience, and the reader of a stub page's regions
// used by P1-T2's note copy.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyUpstreamSchema, documentCopiesQuerySchema, lectureIdentityQuerySchema, linkCandidatesQuerySchema, linkStatusQuerySchema, linkToOfficialSchema, patchDocumentCopySchema, startStudyingSchema } from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import { setStubRegionSource } from '../annotations/reanchorCopy';
import { setPublicationTitleSource } from '../data/export';
import { setStubPageRegions } from '../sources/service';
import type { RegionRow } from '../sources/views';
import { CopiesService } from './copies';
import { registerFanoutJobs, registerHoldersAudience } from './fanout';
import { applyUpstream, upstream } from './following';
import { lectureIdentity } from './identity';
import { registerPublicationHooks } from './pubFanout';
import { linkCandidates, linkStatus, linkToOfficial } from './link';
import { stubSpace } from './pin';
import { publicationIndex } from './system';
import { registerForksPurgeExtension } from './purgeExtension';

const idParams = z.object({ id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) });

export default async function forksModule(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  const copies = new CopiesService(ctx);
  registerFanoutJobs(ctx);
  registerForksPurgeExtension(ctx);
  await registerHoldersAudience(ctx);
  // P1-T5 step 3: publication fan-out jobs, the followers audience, moderation targets, the account-deletion participant
  await registerPublicationHooks(ctx);
  // (C2, AOS-4.18) exports name the explanation a copied item came from (its title lives in the system index)
  setPublicationTitleSource((c, publicationId) => publicationIndex(c).get(publicationId)?.title ?? null);
  // P1-T2's note copy finds a highlight's quote on a stub page in the subject's space (regions are never copied)
  setStubRegionSource((c, pageId) => {
    const page = c.db.get<{ origin_space_id: string | null }>(
      'SELECT s.origin_space_id FROM source_page p JOIN source_version v ON v.id = p.version_id JOIN source s ON s.id = v.source_id WHERE p.id = ? AND s.is_stub = 1',
      [pageId],
    );
    if (!page?.origin_space_id) return null;
    const space = stubSpace(c, page.origin_space_id);
    if (!space) return null;
    return space.all<{ id: string; text: string | null; bbox_json: string | null }>(`SELECT id, text, bbox_json FROM source_region WHERE page_id = ? AND status <> 'rejected' ORDER BY reading_order`, [pageId]);
  });

  // the reader opens a stub page like any page: its regions are read from the subject's space for a member (never copied)
  setStubPageRegions((c, pageId) => {
    const page = c.db.get<{ origin_space_id: string | null }>(
      'SELECT s.origin_space_id FROM source_page p JOIN source_version v ON v.id = p.version_id JOIN source s ON s.id = v.source_id WHERE p.id = ? AND s.is_stub = 1',
      [pageId],
    );
    if (!page?.origin_space_id) return null;
    const space = stubSpace(c, page.origin_space_id);
    if (!space) return null;
    return space.all<RegionRow>('SELECT * FROM source_region WHERE page_id = ? ORDER BY reading_order, created_at', [pageId]);
  });

  const viewerOf = () => {
    const v = ctx.binding.viewer();
    if (!v) throw new AppError('UNAUTHENTICATED', 'سجّل الدخول أولًا.', 401);
    return v;
  };

  app.post('/', async (req) => {
    const viewer = viewerOf();
    return copies.start(viewer, parseBody(startStudyingSchema, req), viewer.deviceId);
  });

  app.get('/', async (req) => copies.list(viewerOf(), parseQuery(documentCopiesQuerySchema, req)));

  app.get('/link-candidates', async (req) => linkCandidates(ctx, viewerOf(), parseQuery(linkCandidatesQuerySchema, req).source_id));

  // (C2) the official state of library rows: «رسمي», «مرتبطة بالنسخة الرسمية», «موجودة رسميًا — اربطها؟»
  app.get('/link-status', async (req) => linkStatus(ctx, viewerOf(), parseQuery(linkStatusQuerySchema, req).source_ids));
  app.get('/lecture-identity', async (req) => lectureIdentity(ctx, viewerOf(), parseQuery(lectureIdentityQuerySchema, req)));

  app.post('/link', async (req) => {
    const viewer = viewerOf();
    return linkToOfficial(ctx, viewer, parseBody(linkToOfficialSchema, req), viewer.deviceId);
  });

  app.get('/:id', async (req) => copies.get(viewerOf(), parseParams(idParams, req).id));

  app.patch('/:id', async (req) => copies.patch(viewerOf(), parseParams(idParams, req).id, parseBody(patchDocumentCopySchema, req)));

  // P1-T5 step 3: a followed copy's update — preview first (nothing changes), then apply or skip (PRD Q25)
  app.get('/:id/upstream', async (req) => upstream(ctx, viewerOf(), parseParams(idParams, req).id));

  app.post('/:id/upstream/apply', async (req) => {
    const viewer = viewerOf();
    return applyUpstream(ctx, viewer, parseParams(idParams, req).id, parseBody(applyUpstreamSchema, req), (row) => copies.view(viewer, row));
  });
}
