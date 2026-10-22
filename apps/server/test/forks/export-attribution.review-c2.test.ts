// Review of Phase 1 completion track C2 — AOS-4.18 «attribution survives export», the export path the builder's test did
// not cover: «الأصل مع كتابتي» (the original PDF with the writing drawn on it, Round 7 H4). A student who follows a
// classmate's published explanation and exports her copy of the lecture as that PDF got his strokes drawn as «كتابتك»,
// with no line anywhere saying whose they are (review R3; failed before the fix). Now the summary shown before the
// download names the lineage («مشتق من منشور «X» (الإصدار n) لـ Y»), and the PDF carries it in its document properties.
// The author's own export names nobody. Real channels (pubWorld). Every file and stroke is a TEST FIXTURE.
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnnotatedPdfSummary, PublicationView, StartStudyingResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { call, ok } from '../channels/helpers';
import { createLayer, createPubWorld, inVault, publish, settle, startPersonal, strokes, type PubWorld, type Who } from './pubWorld';

let w: PubWorld;
let pub: PublicationView;
let authorShown: string;
const TITLE = 'شرح حسن بالقلم';

beforeAll(async () => {
  w = await createPubWorld(4);
  await startPersonal(w, 'hasan');
  const layer = await createLayer(w, 'hasan', 'شرحي بالقلم');
  await strokes(w, 'hasan', layer, 0, 3);
  pub = await publish(w, 'hasan', [layer], TITLE);
  await settle(w);
  ok<StartStudyingResponse>(await call(w.t, w.p.zainab.h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode: 'followed', publication_id: pub.id }));
  // and her own two strokes on «ملاحظاتي»
  await strokes(w, 'zainab', null, 1, 2);
  authorShown = inVault(w, 'zainab', () => w.t.ctx.db.get<{ d: string }>(`SELECT author_display AS d FROM attribution WHERE entity_type = 'annotation' LIMIT 1`)!.d);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

const summaryOf = async (who: Who) => ok<AnnotatedPdfSummary>(await call(w.t, w.p[who].h, 'GET', `/api/data/export/source/${w.lecture.sourceId}/annotated-pdf/summary`));

describe('AOS-4.18 — the annotated PDF names what is not the student\'s own writing', () => {
  it('the summary before the download says whose copied strokes are drawn', async () => {
    const s = await summaryOf('zainab');
    expect(s.available).toBe(true);
    expect(s.drawn.strokes).toBe(5);
    const line = s.notes_ar.find((n) => n.includes('مشتق من منشور'));
    expect(line, JSON.stringify(s.notes_ar)).toBeDefined();
    expect(line).toContain(`«${TITLE}»`);
    expect(line).toContain(authorShown);
    expect(line).toContain('3');
  });

  it('the PDF itself carries the lineage in its document properties', async () => {
    const res = await w.t.app.inject({ method: 'GET', url: `/api/data/export/source/${w.lecture.sourceId}/annotated-pdf`, headers: w.p.zainab.h });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const doc = await PDFDocument.load(res.rawPayload, { updateMetadata: false });
    const subject = doc.getSubject() ?? '';
    expect(subject).toContain('مشتق من منشور');
    expect(subject).toContain(authorShown);
  });

  it('the author\'s own export names nobody', async () => {
    const s = await summaryOf('hasan');
    expect(s.notes_ar.some((n) => n.includes('مشتق من منشور'))).toBe(false);
  });
});
