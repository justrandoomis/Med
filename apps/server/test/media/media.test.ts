// Media API (§29, §32, AC-08, AC-09): audio assets + authenticated Range streaming, manual transcript segments with
// correction history and concurrency, VTT import (Arabic) with replace that keeps corrected work, transcript search
// through the universal search, manual vs auto link labels, the image explorer (origin badges, kinds that exist,
// owner classification), non-destructive overlays, the Image Quiz (leak-free payload, neutral image delivery with
// burned masks for PNG, uncertain labels excluded, append-only answers), the AC-09 matcher, capabilities, auth.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImageListResponse, ImageQuizView, TranscriptResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { sha256 } from '../../src/lib/hash';
import { decodePng, encodePng } from '../../src/modules/processing/png';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';

let t: TestApp;
let h: AuthHeaders;

beforeEach(async () => {
  t = await createTestApp();
  h = await t.login();
});
afterEach(async () => {
  await t.close();
});

const now = () => t.ctx.clock.now();

async function audioSource(title = 'Lecture 3 recording'): Promise<{ sourceId: string; versionId: string; fileId: string }> {
  const bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4096, 7)]);
  const f = await t.ctx.files.put(bytes, { mime: 'audio/mpeg', originalName: 'lecture3.mp3' });
  const sourceId = newId();
  const versionId = newId();
  t.ctx.db.run(`INSERT INTO source (id, title, source_type, processing_status, created_at, updated_at) VALUES (?, ?, 'lecture_audio', 'partial', ?, ?)`, [sourceId, title, now(), now()]);
  t.ctx.db.run(
    `INSERT INTO source_version (id, source_id, version_no, kind, file_id, content_hash, mime, file_name, format, pagination, processing_status, created_at)
     VALUES (?, ?, 1, 'original', ?, ?, 'audio/mpeg', 'lecture3.mp3', 'audio', 'timestamps', 'partial', ?)`,
    [versionId, sourceId, f.id, newId(), now()],
  );
  t.ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [versionId, sourceId]);
  return { sourceId, versionId, fileId: f.id };
}

/** A lecture source with one page and one region (fixture rows; processing owns these tables). */
function lecturePage(): { sourceId: string; versionId: string; pageId: string; regionId: string } {
  const sourceId = newId();
  const versionId = newId();
  const pageId = newId();
  const regionId = newId();
  t.ctx.db.run(`INSERT INTO source (id, title, source_type, processing_status, created_at, updated_at) VALUES (?, 'Acute Appendicitis (TEST FIXTURE)', 'lecture', 'ready', ?, ?)`, [sourceId, now(), now()]);
  t.ctx.db.run(
    `INSERT INTO source_version (id, source_id, version_no, kind, file_id, content_hash, mime, file_name, format, pagination, processing_status, created_at)
     VALUES (?, ?, 1, 'original', NULL, ?, 'application/pdf', 'x.pdf', 'pdf', 'pages', 'ready', ?)`,
    [versionId, sourceId, newId(), now()],
  );
  t.ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [versionId, sourceId]);
  t.ctx.db.run(`INSERT INTO source_page (id, version_id, page_index, printed_label, kind, created_at, updated_at) VALUES (?, ?, 1, '12', 'page', ?, ?)`, [pageId, versionId, now(), now()]);
  t.ctx.db.run(`INSERT INTO source_region (id, version_id, page_id, kind, reading_order, text, created_at, updated_at) VALUES (?, ?, ?, 'paragraph', 0, 'Ultrasound is the first-line imaging test in children.', ?, ?)`, [
    regionId,
    versionId,
    pageId,
    now(),
    now(),
  ]);
  return { sourceId, versionId, pageId, regionId };
}

async function audioId(): Promise<string> {
  await audioSource();
  const list = (await t.app.inject({ method: 'GET', url: '/api/media/audio', headers: h })).json();
  return list.audio[0].id as string;
}

const tr = async (id: string): Promise<TranscriptResponse> => (await t.app.inject({ method: 'GET', url: `/api/media/audio/${id}/transcript`, headers: h })).json();

describe('audio', () => {
  it('creates one asset per audio version, streams it with Range for the owner only, records the player duration', async () => {
    const src = await audioSource();
    const a = await t.app.inject({ method: 'GET', url: '/api/media/audio', headers: h });
    const again = await t.app.inject({ method: 'GET', url: '/api/media/audio', headers: h });
    expect(a.json().audio).toHaveLength(1);
    expect(again.json().audio[0].id).toBe(a.json().audio[0].id);
    const view = a.json().audio[0];
    expect(view.source_id).toBe(src.sourceId);
    expect(view.stream_url).toBe(`/api/media/audio/${view.id}/stream`);
    expect(a.json().notes_ar.join(' ')).toContain('التفريغ الآلي غير متاح');

    const ranged = await t.app.inject({ method: 'GET', url: view.stream_url, headers: { ...h, range: 'bytes=0-99' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-range']).toBe('bytes 0-99/4099');
    expect(ranged.rawPayload.length).toBe(100);
    expect((await t.app.inject({ method: 'GET', url: view.stream_url })).statusCode).toBe(401);

    const d = await t.app.inject({ method: 'PATCH', url: `/api/media/audio/${view.id}`, headers: h, payload: { duration_ms: 3_600_000 } });
    expect(d.json()).toMatchObject({ duration_ms: 3_600_000, duration_origin: 'player' });
  });

  it('status and capabilities are honest: transcription needs configuration, auto-linking / external images are not built; in-app recording (track F4) is explicit-action only', async () => {
    const s = (await t.app.inject({ method: 'GET', url: '/api/media/status', headers: h })).json();
    expect(s.transcription.state).toBe('requires_configuration');
    expect(s.recording.state).toBe('available');
    expect(s.recording.reason_ar).toContain('الميكروفون');
    expect(s.recording.reason_ar).toContain('لا يبدأ إلا بضغطك');
    expect(s.auto_linking.state).toBe('not_implemented');
    expect(s.external_image_search.state).toBe('not_implemented');
    expect(s.external_image_search.reason_ar).toContain('MEDLEVO_ALLOW_EXTERNAL_FETCH');
    const caps = (await t.app.inject({ method: 'GET', url: '/api/capabilities', headers: h })).json();
    expect(caps.features['workspace.audio'].state).toBe('available');
    expect(caps.features['external.images'].state).toBe('not_implemented');
  });
});

describe('transcript', () => {
  it('manual segments: corrections keep the original and append history; stale edits are refused; delete is a tombstone', async () => {
    const id = await audioId();
    const seg = (await t.app.inject({ method: 'POST', url: `/api/media/audio/${id}/segments`, headers: h, payload: { start_ms: 1000, end_ms: 5000, text: 'pain begins around the umbilicus' } })).json();
    expect(seg).toMatchObject({ origin: 'manual', origin_label_ar: 'كتبته بنفسك', rev: 1, corrected_text: null });
    const bad = await t.app.inject({ method: 'POST', url: `/api/media/audio/${id}/segments`, headers: h, payload: { start_ms: 5000, end_ms: 1000, text: 'x' } });
    expect(bad.statusCode).toBe(400);

    const c1 = (await t.app.inject({ method: 'PATCH', url: `/api/media/segments/${seg.id}`, headers: h, payload: { base_rev: 1, corrected_text: 'Pain begins around the umbilicus (periumbilical).' } })).json();
    expect(c1.text).toBe('pain begins around the umbilicus');
    expect(c1.display_text).toBe('Pain begins around the umbilicus (periumbilical).');
    expect(c1.rev).toBe(2);
    const stale = await t.app.inject({ method: 'PATCH', url: `/api/media/segments/${seg.id}`, headers: h, payload: { base_rev: 1, corrected_text: 'other' } });
    expect(stale.statusCode).toBe(409);
    const re = (await t.app.inject({ method: 'PATCH', url: `/api/media/segments/${seg.id}`, headers: h, payload: { base_rev: 2, start_ms: 1500 } })).json();
    expect(re.start_ms).toBe(1500);

    const del = (await t.app.inject({ method: 'DELETE', url: `/api/media/segments/${seg.id}?base_rev=3`, headers: h })).json();
    expect(del.deleted).toBe(true);
    expect((await tr(id)).segments).toHaveLength(0);
    const withDeleted = (await t.app.inject({ method: 'GET', url: `/api/media/audio/${id}/transcript?include_deleted=1`, headers: h })).json();
    expect(withDeleted.segments).toHaveLength(1);
    await t.app.inject({ method: 'POST', url: `/api/media/segments/${seg.id}/restore`, headers: h });
    const hist = (await t.app.inject({ method: 'GET', url: `/api/media/segments/${seg.id}/revisions`, headers: h })).json().revisions;
    expect(hist.map((r: { action: string }) => r.action)).toEqual(['create', 'correct', 'retime', 'delete', 'restore']);
    expect(hist[0].text).toBe('pain begins around the umbilicus');
  });

  it('imports an Arabic VTT; replacing a previous import keeps corrected segments; skipped cues are reported', async () => {
    const id = await audioId();
    const vtt1 = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v المحاضر>يبدأ الألم حول السرة\n\n00:00:04.000 --> 00:00:06.000\nثم ينتقل إلى الحفرة الحرقفية اليمنى\n\n00:00:09.000 --> 00:00:08.000\nbad\n';
    const r1 = (await t.app.inject({ method: 'POST', url: `/api/media/audio/${id}/import`, headers: h, payload: { text: vtt1, file_name: 'lecture3.vtt' } })).json();
    expect(r1).toMatchObject({ format: 'vtt', created: 2, replaced: 0 });
    expect(r1.skipped).toHaveLength(1);
    const segs = r1.transcript.segments;
    expect(segs[0]).toMatchObject({ origin: 'imported_vtt', speaker: 'المحاضر', text: 'يبدأ الألم حول السرة' });
    // correct the second one, then re-import with replace
    await t.app.inject({ method: 'PATCH', url: `/api/media/segments/${segs[1].id}`, headers: h, payload: { base_rev: 1, corrected_text: 'ثم ينتقل الألم إلى الحفرة الحرقفية اليمنى (RIF)' } });
    const vtt2 = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nيبدأ الألم عادةً حول السرة\n';
    const r2 = (await t.app.inject({ method: 'POST', url: `/api/media/audio/${id}/import`, headers: h, payload: { text: vtt2, replace_previous_import: true } })).json();
    expect(r2).toMatchObject({ created: 1, replaced: 1, kept_corrected: 1 });
    const now2 = await tr(id);
    expect(now2.segments.map((s) => s.display_text)).toEqual(['يبدأ الألم عادةً حول السرة', 'ثم ينتقل الألم إلى الحفرة الحرقفية اليمنى (RIF)']);
    expect(now2.imports).toHaveLength(2);
    const unknown = await t.app.inject({ method: 'POST', url: `/api/media/audio/${id}/import`, headers: h, payload: { text: 'just text' } });
    expect(unknown.statusCode).toBe(415);
  });

  it('transcripts are searchable through the universal search (normalized Arabic, corrected text)', async () => {
    const id = await audioId();
    await t.app.inject({ method: 'POST', url: `/api/media/audio/${id}/import`, headers: h, payload: { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nيبدأ الألم حول السرة\n' } });
    const res = (await t.app.inject({ method: 'GET', url: `/api/search?q=${encodeURIComponent('الالم')}&types=transcripts`, headers: h })).json();
    expect(res.results).toHaveLength(1);
    expect(res.results[0].type).toBe('transcripts');
    expect(res.results[0].location.page_label_ar).toContain('0:01');
    const seg = (await tr(id)).segments[0]!;
    await t.app.inject({ method: 'PATCH', url: `/api/media/segments/${seg.id}`, headers: h, payload: { base_rev: 1, corrected_text: 'يبدأ الألم حول السرة periumbilical' } });
    const res2 = (await t.app.inject({ method: 'GET', url: '/api/search?q=periumbilical&types=transcripts', headers: h })).json();
    expect(res2.results).toHaveLength(1);
    await t.app.inject({ method: 'DELETE', url: `/api/media/segments/${seg.id}`, headers: h });
    expect((await t.app.inject({ method: 'GET', url: '/api/search?q=periumbilical&types=transcripts', headers: h })).json().results).toHaveLength(0);
  });

  it('transcript hits carry the segment’s REAL origin: imported / typed by the owner / machine-recognized (I1 #6)', async () => {
    // Regression: every transcript hit was labelled «مقروء آليًا» (recognized), even typed or imported text.
    const id = await audioId();
    const search = async (q: string) => (await t.app.inject({ method: 'GET', url: `/api/search?q=${encodeURIComponent(q)}&types=transcripts`, headers: h })).json().results as Array<{ origin: string }>;
    await t.app.inject({ method: 'POST', url: `/api/media/audio/${id}/import`, headers: h, payload: { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nrebound tenderness imported cue\n' } });
    expect((await search('imported cue')).map((r) => r.origin)).toEqual(['imported']);
    const typed = (await t.app.inject({ method: 'POST', url: `/api/media/audio/${id}/segments`, headers: h, payload: { start_ms: 4000, end_ms: 6000, text: 'guarding typed by the owner' } })).json();
    expect((await search('guarding typed')).map((r) => r.origin)).toEqual(['owner_typed']);
    // a machine transcription (no AI here: the row is written as the transcription job would write it)
    const auto = newId();
    t.ctx.db.run(`INSERT INTO transcript_segment (id, audio_id, start_ms, end_ms, text, origin, created_at) VALUES (?, ?, 7000, 9000, 'psoas sign machine heard', 'transcription', ?)`, [auto, id, now()]);
    const { indexSegment, getSegmentRow } = await import('../../src/modules/media/transcripts');
    indexSegment(t.ctx, getSegmentRow(t.ctx, auto));
    expect((await search('psoas sign machine')).map((r) => r.origin)).toEqual(['recognized']);
    // corrected by the owner → the shown (and searched) text is the owner's
    await t.app.inject({ method: 'PATCH', url: `/api/media/segments/${auto}`, headers: h, payload: { base_rev: 1, corrected_text: 'psoas sign corrected by me' } });
    expect((await search('psoas sign corrected')).map((r) => r.origin)).toEqual(['owner_typed']);
    expect(typed.origin).toBe('manual');
  });

  it('links: manual links are labelled manual; an AUTO link (no matcher exists — inserted as a fixture) is labelled auto, can be confirmed or removed', async () => {
    const id = await audioId();
    const page = lecturePage();
    const seg = (await t.app.inject({ method: 'POST', url: `/api/media/audio/${id}/segments`, headers: h, payload: { start_ms: 0, end_ms: 2000, text: 'ultrasound first in children' } })).json();
    const link = (await t.app.inject({ method: 'POST', url: `/api/media/segments/${seg.id}/links`, headers: h, payload: { region_id: page.regionId } })).json();
    expect(link).toMatchObject({ origin: 'manual', origin_label_ar: 'ربط يدوي (أنشأته أنت)', page_id: page.pageId, page_label_ar: 'ص 12 (الصفحة 2 في الملف)' });
    expect(link.region_preview).toContain('Ultrasound');
    const same = (await t.app.inject({ method: 'POST', url: `/api/media/segments/${seg.id}/links`, headers: h, payload: { region_id: page.regionId } })).json();
    expect(same.id).toBe(link.id);
    expect((await t.app.inject({ method: 'POST', url: `/api/media/links/${link.id}/confirm`, headers: h })).statusCode).toBe(400);

    const autoId = newId();
    t.ctx.db.run(
      `INSERT INTO media_region_link (id, from_type, from_id, to_region_id, to_page_id, origin, created_at, to_version_id, to_source_id) VALUES (?, 'transcript_segment', ?, NULL, ?, 'auto', ?, ?, ?)`,
      [autoId, seg.id, page.pageId, now(), page.versionId, page.sourceId],
    );
    let segView = (await tr(id)).segments[0]!;
    const auto = segView.links.find((l) => l.id === autoId)!;
    expect(auto.origin).toBe('auto');
    expect(auto.origin_label_ar).toContain('تلقائي');
    expect(auto.origin_label_ar).toContain('قابل للتعديل');
    const confirmed = (await t.app.inject({ method: 'POST', url: `/api/media/links/${autoId}/confirm`, headers: h })).json();
    expect(confirmed).toMatchObject({ origin: 'auto', confirmed: true, origin_label_ar: 'ربط تلقائي أكّدته' });
    await t.app.inject({ method: 'DELETE', url: `/api/media/links/${autoId}`, headers: h });
    segView = (await tr(id)).segments[0]!;
    expect(segView.links.map((l) => l.id)).toEqual([link.id]);
    const rev = (await t.app.inject({ method: 'GET', url: `/api/media/links?page_id=${page.pageId}`, headers: h })).json();
    expect(rev.links).toHaveLength(1);
    expect(rev.links[0]).toMatchObject({ audio_id: id, start_ms: 0 });
  });
});

// ───────── images ─────────
function png(w: number, h_: number, rgb: [number, number, number] = [250, 250, 250]): Buffer {
  const data = new Uint8Array(w * h_ * 4);
  for (let i = 0; i < w * h_; i++) data.set([...rgb, 255], i * 4);
  return encodePng({ width: w, height: h_, data });
}

async function imageAsset(opts: { origin?: string; kind?: string; caption?: string | null; bytes?: Buffer; mime?: string; name?: string; sourceTitle?: string } = {}) {
  const f = await t.ctx.files.put(opts.bytes ?? png(40, 20), { mime: opts.mime ?? 'image/png', originalName: opts.name ?? 'Figure_2_pneumothorax_answer.png' });
  const page = lecturePage();
  if (opts.sourceTitle) t.ctx.db.run('UPDATE source SET title = ? WHERE id = ?', [opts.sourceTitle, page.sourceId]);
  const id = newId();
  t.ctx.db.run(
    `INSERT INTO image_asset (id, file_id, source_id, version_id, page_id, region_id, origin, image_kind, caption, match_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?)`,
    [id, f.id, page.sourceId, page.versionId, page.pageId, page.regionId, opts.origin ?? 'source', opts.kind ?? 'radiology', opts.caption === undefined ? 'Figure 2: Chest X-ray showing a right pneumothorax' : opts.caption, now()],
  );
  return { id, fileId: f.id, sha: f.sha256, ...page };
}

async function overlay(imageId: string, body: Record<string, unknown>) {
  const res = await t.app.inject({ method: 'POST', url: `/api/media/images/${imageId}/overlays`, headers: h, payload: body });
  if (res.statusCode !== 200) throw new Error(res.body);
  return res.json();
}

describe('image explorer', () => {
  it('lists images with distinct origin badges and only the kinds that exist; the owner classification is labelled', async () => {
    const real = await imageAsset();
    const gen = await imageAsset({ origin: 'generated', kind: 'generated_illustration', caption: 'Illustration' });
    const unk = await imageAsset({ kind: 'unknown', caption: null });
    const list: ImageListResponse = (await t.app.inject({ method: 'GET', url: '/api/media/images', headers: h })).json();
    const by = new Map(list.images.map((i) => [i.id, i]));
    expect(by.get(real.id)!.origin_badge).toBe('source_photo');
    expect(by.get(gen.id)!.origin_badge).toBe('generated');
    expect(by.get(gen.id)!.origin_label_ar).toContain('ليست صورة حقيقية');
    expect(by.get(unk.id)!.origin_badge).toBe('source_unknown');
    expect(by.get(real.id)!.page!.label_ar).toBe('ص 12 (الصفحة 2 في الملف)');
    expect(list.kinds.map((k) => k.kind).sort()).toEqual(['generated_illustration', 'radiology', 'unknown']);
    expect(list.notes_ar.join(' ')).toContain('غير مصنّفة');
    const filtered: ImageListResponse = (await t.app.inject({ method: 'GET', url: '/api/media/images?kind=radiology', headers: h })).json();
    expect(filtered.images.map((i) => i.id)).toEqual([real.id]);

    const patched = (await t.app.inject({ method: 'PATCH', url: `/api/media/images/${unk.id}/meta`, headers: h, payload: { image_kind: 'histology', modality: 'H&E micrograph' } })).json();
    expect(patched).toMatchObject({ image_kind: 'histology', kind_origin: 'owner', modality: 'H&E micrograph' });
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE entity_type = 'image_asset'`)!.n).toBe(1);
    // the processing row itself is untouched
    expect(t.ctx.db.get<{ image_kind: string }>('SELECT image_kind FROM image_asset WHERE id = ?', [unk.id])!.image_kind).toBe('unknown');
  });

  // review regression: the LIKE pattern escaped % and _ without an ESCAPE clause, so «50%» found nothing
  it('the explorer text filter treats % and _ literally', async () => {
    await imageAsset({ caption: 'Chest X-ray: 50% right pneumothorax' });
    await imageAsset({ caption: 'Chest X-ray: right pneumothorax' });
    const q = async (text: string) => ((await t.app.inject({ method: 'GET', url: `/api/media/images?q=${encodeURIComponent(text)}`, headers: h })).json() as ImageListResponse).images.length;
    expect(await q('50%')).toBe(1);
    expect(await q('pneumothorax')).toBe(2);
    expect(await q('%')).toBe(1);
    expect(await q('_')).toBe(0);
  });

  it('overlays are non-destructive, validated and versioned', async () => {
    const img = await imageAsset();
    const bad = await t.app.inject({ method: 'POST', url: `/api/media/images/${img.id}/overlays`, headers: h, payload: { kind: 'arrow', shape: { type: 'rect', x: 0, y: 0, w: 0.2, h: 0.2 } } });
    expect(bad.statusCode).toBe(400);
    const out = await t.app.inject({ method: 'POST', url: `/api/media/images/${img.id}/overlays`, headers: h, payload: { kind: 'highlight', shape: { type: 'rect', x: 0.9, y: 0, w: 0.2, h: 0.2 } } });
    expect(out.statusCode).toBe(400);
    const o = await overlay(img.id, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.4 }, label: 'Pneumothorax', certainty: 'from_caption' });
    expect(o).toMatchObject({ quiz_eligible: true, certainty_label_ar: 'من تعليق المصدر', rev: 1 });
    const u = await overlay(img.id, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.6, y: 0.1, w: 0.3, h: 0.3 }, label: 'Rib', certainty: 'uncertain' });
    expect(u.quiz_eligible).toBe(false);
    expect(u.quiz_ineligible_reason_ar).toContain('AC-08');
    const p = (await t.app.inject({ method: 'PATCH', url: `/api/media/overlays/${o.id}`, headers: h, payload: { base_rev: 1, aliases: ['استرواح الصدر'] } })).json();
    expect(p.rev).toBe(2);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/media/overlays/${o.id}`, headers: h, payload: { base_rev: 1, label: 'x' } })).statusCode).toBe(409);
    await t.app.inject({ method: 'DELETE', url: `/api/media/overlays/${u.id}`, headers: h });
    const detail = (await t.app.inject({ method: 'GET', url: `/api/media/images/${img.id}`, headers: h })).json();
    expect(detail.overlays.map((x: { id: string }) => x.id)).toEqual([o.id]);
    expect(detail.notes_ar.join(' ')).toContain('غير مدمّرة');
    // the image file itself never changes
    expect(sha256(await t.ctx.files.read(img.fileId))).toBe(img.sha);
  });
});

describe('image quiz', () => {
  it('the quiz payload and image never reveal the answer; masks are burned into a derived PNG; uncertain labels are excluded', async () => {
    const img = await imageAsset({ sourceTitle: 'Chest radiology atlas (pneumothorax chapter)' });
    const mask = await overlay(img.id, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.5, y: 0.5, w: 0.25, h: 0.5 }, label: 'Pneumothorax', aliases: ['استرواح الصدر'], certainty: 'owner' });
    await overlay(img.id, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0, y: 0, w: 0.2, h: 0.2 }, label: 'Rib fracture', certainty: 'uncertain' });
    const res = await t.app.inject({ method: 'POST', url: '/api/media/quiz', headers: h, payload: { image_id: img.id } });
    expect(res.statusCode).toBe(200);
    const quiz: ImageQuizView = res.json();
    const raw = res.body;
    for (const leak of ['Pneumothorax', 'pneumothorax', 'استرواح', 'Rib', 'Figure', img.id, img.fileId, img.sourceId, img.pageId, 'Chest', '.png', mask.id]) expect(raw).not.toContain(leak);
    expect(quiz.masks).toEqual([{ key: 'm1', shape: { type: 'rect', x: 0.5, y: 0.5, w: 0.25, h: 0.5 }, answered: false }]);
    expect(quiz.masks_rendered).toBe('server');
    expect(quiz.excluded).toHaveLength(1);
    expect(quiz.excluded[0]!.reason_ar).toContain('غير مؤكدة');
    expect(quiz.image_url).toBe(`/api/media/quiz/${quiz.id}/image`);

    const imgRes = await t.app.inject({ method: 'GET', url: quiz.image_url, headers: h });
    expect(imgRes.statusCode).toBe(200);
    expect(imgRes.headers['content-type']).toBe('image/png');
    expect(imgRes.headers['content-disposition']).toBeUndefined();
    expect(imgRes.headers.etag).toBeUndefined();
    expect(imgRes.headers['cache-control']).toBe('no-store');
    const served = decodePng(imgRes.rawPayload);
    const px = (x: number, y: number) => Array.from(served.data.slice((y * served.width + x) * 4, (y * served.width + x) * 4 + 3));
    expect(px(25, 15)).toEqual([96, 104, 120]); // inside the mask: burned
    expect(px(2, 2)).toEqual([250, 250, 250]); // the uncertain mask is not part of the quiz
    expect(sha256(await t.ctx.files.read(img.fileId))).toBe(img.sha); // original untouched
    expect((await t.app.inject({ method: 'GET', url: quiz.image_url })).statusCode).toBe(401);

    const wrong = (await t.app.inject({ method: 'POST', url: `/api/media/quiz/${quiz.id}/answer`, headers: h, payload: { key: 'm1', answer: 'Haemothorax' } })).json();
    expect(wrong).toMatchObject({ result: 'incorrect', expected: 'Pneumothorax' });
    expect((await t.app.inject({ method: 'POST', url: `/api/media/quiz/${quiz.id}/answer`, headers: h, payload: { key: 'm1', answer: 'Pneumothorax' } })).statusCode).toBe(409);
    const self = (await t.app.inject({ method: 'POST', url: `/api/media/quiz/${quiz.id}/answer`, headers: h, payload: { key: 'm1', answer: 'x', self_mark_correct: true } })).json();
    expect(self.result).toBe('self_marked_correct');
    expect(self.quiz.answers[0]).toMatchObject({ answer: 'Haemothorax', result: 'self_marked_correct' });
    const fin = (await t.app.inject({ method: 'POST', url: `/api/media/quiz/${quiz.id}/finish`, headers: h })).json();
    expect(fin.reveal.labels).toEqual([{ key: 'm1', label: 'Pneumothorax', certainty_label_ar: 'حددتها بنفسك' }]);
    expect(fin.reveal.image.caption).toContain('pneumothorax');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM image_quiz_answer')!.n).toBe(2); // append-only
  });

  // review regression: the quiz kept grading a mask against its live label after the owner marked it uncertain
  it('a mask marked uncertain or removed after the quiz started is not graded as a fixed answer (AC-08)', async () => {
    const img = await imageAsset();
    const a = await overlay(img.id, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, label: 'Pneumothorax', certainty: 'owner' });
    const b = await overlay(img.id, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.6, y: 0.6, w: 0.2, h: 0.2 }, label: 'Rib', certainty: 'owner' });
    const quiz: ImageQuizView = (await t.app.inject({ method: 'POST', url: '/api/media/quiz', headers: h, payload: { image_id: img.id } })).json();
    expect(quiz.masks).toHaveLength(2);
    const patched = await t.app.inject({ method: 'PATCH', url: `/api/media/overlays/${a.id}`, headers: h, payload: { base_rev: a.rev, certainty: 'uncertain' } });
    expect(patched.statusCode).toBe(200);
    await t.app.inject({ method: 'DELETE', url: `/api/media/overlays/${b.id}`, headers: h });
    for (const key of ['m1', 'm2']) {
      const r = await t.app.inject({ method: 'POST', url: `/api/media/quiz/${quiz.id}/answer`, headers: h, payload: { key, answer: 'Pneumothorax' } });
      expect(r.statusCode).toBe(409);
      expect(r.body).not.toContain('Pneumothorax');
      expect(r.body).not.toContain('Rib');
    }
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM image_quiz_answer')!.n).toBe(0);
  });

  it('accepts an Arabic alias; a quiz with only uncertain labels is refused (AC-08); non-PNG images keep client masks', async () => {
    const img = await imageAsset();
    await overlay(img.id, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, label: 'Pneumothorax', aliases: ['استرواح الصدر'], certainty: 'visually_confirmed' });
    const quiz: ImageQuizView = (await t.app.inject({ method: 'POST', url: '/api/media/quiz', headers: h, payload: { image_id: img.id } })).json();
    const ok = (await t.app.inject({ method: 'POST', url: `/api/media/quiz/${quiz.id}/answer`, headers: h, payload: { key: 'm1', answer: 'الاسترواح الصدر' } })).json();
    expect(ok.result).toBe('correct');

    const unsure = await imageAsset();
    await overlay(unsure.id, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, label: 'Unreadable label', certainty: 'uncertain' });
    const refused = await t.app.inject({ method: 'POST', url: '/api/media/quiz', headers: h, payload: { image_id: unsure.id } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain('غير مؤكدة');
    expect(refused.body).not.toContain('Unreadable label');

    const jpgBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
    const jpg = await imageAsset({ bytes: jpgBytes, mime: 'image/jpeg', name: 'answer_is_pneumothorax.jpg' });
    await overlay(jpg.id, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, label: 'Pneumothorax', certainty: 'owner' });
    const q2: ImageQuizView = (await t.app.inject({ method: 'POST', url: '/api/media/quiz', headers: h, payload: { image_id: jpg.id } })).json();
    expect(q2.masks_rendered).toBe('client');
    const r = await t.app.inject({ method: 'GET', url: q2.image_url, headers: h });
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['content-disposition']).toBeUndefined();
    expect(Buffer.compare(r.rawPayload, jpgBytes)).toBe(0);
  });
});

describe('AC-09 matcher over the library', () => {
  it('accepts only images that pass every check; a mismatching or generated image is excluded with reasons', async () => {
    const xr = await imageAsset();
    const ct = await imageAsset({ caption: 'CT chest: right pneumothorax' });
    const gen = await imageAsset({ origin: 'generated', kind: 'generated_illustration', caption: 'Generated illustration of a pneumothorax on a chest X-ray' });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/media/images/match',
      headers: h,
      payload: { request: { modality: 'x-ray', anatomic_region: 'chest', finding_terms: ['pneumothorax'] } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted.map((a: { image: { id: string } }) => a.image.id)).toEqual([xr.id]);
    const ex = new Map(body.excluded.map((e: { image: { id: string }; validation: { reasons_ar: string[] } }) => [e.image.id, e.validation.reasons_ar.join(' ')]));
    expect(ex.get(ct.id)).toContain('لا يطابق');
    expect(ex.get(gen.id)).toContain('مولّدة');
    expect(body.external.state).toBe('not_implemented');
  });
});

describe('auth', () => {
  it('every media route needs the owner session and CSRF on mutations', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/media/images' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/media/status' })).statusCode).toBe(401);
    const img = await imageAsset();
    expect((await t.app.inject({ method: 'POST', url: `/api/media/images/${img.id}/overlays`, headers: { cookie: h.cookie }, payload: { kind: 'highlight', shape: { type: 'rect', x: 0, y: 0, w: 0.1, h: 0.1 } } })).statusCode).toBe(403);
  });
});

describe('permanent delete (sources purge)', () => {
  it('removes the media rows of a purged source (no foreign key blocks the purge)', async () => {
    const id = await audioId();
    const audioSrc = t.ctx.db.get<{ source_id: string }>('SELECT source_id FROM audio_asset WHERE id = ?', [id])!.source_id;
    await t.app.inject({ method: 'POST', url: `/api/media/audio/${id}/import`, headers: h, payload: { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nنص\n' } });
    const img = await imageAsset();
    await overlay(img.id, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, label: 'Pneumothorax', certainty: 'owner' });
    await t.app.inject({ method: 'PATCH', url: `/api/media/images/${img.id}/meta`, headers: h, payload: { modality: 'x-ray' } });
    const quiz = (await t.app.inject({ method: 'POST', url: '/api/media/quiz', headers: h, payload: { image_id: img.id } })).json();
    await t.app.inject({ method: 'POST', url: `/api/media/quiz/${quiz.id}/answer`, headers: h, payload: { key: 'm1', answer: 'x' } });
    for (const sourceId of [audioSrc, img.sourceId]) {
      expect((await t.app.inject({ method: 'POST', url: `/api/sources/${sourceId}/trash`, headers: h })).statusCode).toBe(200);
      const impact = (await t.app.inject({ method: 'GET', url: `/api/sources/${sourceId}/impact?mode=purge`, headers: h })).json();
      const del = await t.app.inject({ method: 'DELETE', url: `/api/sources/${sourceId}?confirm_token=${encodeURIComponent(impact.confirm_token)}`, headers: h });
      expect(del.statusCode).toBe(200);
    }
    for (const table of ['audio_asset', 'transcript_segment', 'transcript_revision', 'transcript_import', 'image_asset', 'image_meta', 'media_overlay', 'image_quiz', 'image_quiz_answer']) {
      expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n).toBe(0);
    }
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM owner_content_fts WHERE entity_type = 'transcript_segment'`)!.n).toBe(0);
  });
});
