// Track F4 — in-app recordings (§29): stored as a «ملاحظة صوتية» (my_audio_note) source, content-sniffed (audio only),
// idempotent by the client recording id, linked to the lecture; pen strokes written meanwhile carry time links that
// are labelled automatic and become manual when the owner edits them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type RecordingResponse } from '@medlevo/shared';
import { mp4AudioOnly, sniff, webmAudioOnly } from '../../src/modules/sources/sniff';
import { createNode, makeHarness, multipart, type Harness } from '../sources/helpers';
import { createSourceFixture, inkPayload, op, type SourceFixture } from '../annotations/helpers';

/** The start of a WebM file as MediaRecorder writes it (EBML header, Segment, Tracks with one codec) + filler. */
function webm(codec: 'A_OPUS' | 'V_VP8' = 'A_OPUS', bytes = 4096): Buffer {
  const ebml = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f,
    0x42, 0x86, 0x81, 0x01, // EBMLVersion 1
    0x42, 0xf7, 0x81, 0x01,
    0x42, 0xf2, 0x81, 0x04,
    0x42, 0xf3, 0x81, 0x08,
    0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, // DocType "webm"
    0x42, 0x87, 0x81, 0x04,
    0x42, 0x85, 0x81, 0x02,
  ]);
  const segment = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const name = Buffer.from(codec, 'latin1');
  const tracks = Buffer.concat([Buffer.from([0x16, 0x54, 0xae, 0x6b, 0x80 | (name.length + 4), 0xae, 0x80 | (name.length + 2), 0x86, 0x80 | name.length]), name]);
  const filler = Buffer.alloc(bytes, 0x5a);
  return Buffer.concat([ebml, segment, tracks, filler]);
}

describe('sniffing in-app recordings', () => {
  it('WebM / MP4 holding only audio are audio; with a video track they stay rejected', () => {
    expect(sniff(webm('A_OPUS'))).toEqual({ kind: 'audio', mime: 'audio/webm' });
    expect(sniff(webm('V_VP8'))).toEqual({ kind: 'unsupported', what: 'video' });
    expect(webmAudioOnly(webm('A_OPUS'))).toBe(true);
    const box = (type: string, payload: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(payload.length + 8);
      return Buffer.concat([len, Buffer.from(type, 'latin1'), payload]);
    };
    const hdlr = (h: string) => box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from(h, 'latin1'), Buffer.alloc(12)]));
    const ftyp = box('ftyp', Buffer.from('iso5\0\0\0\0iso5mp41', 'latin1'));
    const audioMp4 = Buffer.concat([ftyp, box('moov', Buffer.concat([hdlr('soun')]))]);
    const videoMp4 = Buffer.concat([ftyp, box('moov', Buffer.concat([hdlr('vide'), hdlr('soun')]))]);
    expect(mp4AudioOnly(audioMp4)).toBe(true);
    expect(sniff(audioMp4)).toEqual({ kind: 'audio', mime: 'audio/mp4' });
    expect(sniff(videoMp4)).toEqual({ kind: 'unsupported', what: 'video' });
  });
});

describe('POST /api/media/recordings', () => {
  let t: Harness;
  let f: SourceFixture;
  let folder: string;
  beforeEach(async () => {
    t = await makeHarness();
    f = createSourceFixture(t);
    folder = (await createNode(t, { title: 'محاضرات الجراحة' })).id;
    t.ctx.db.run('UPDATE source SET node_id = ? WHERE id = ?', [folder, f.sourceId]);
  });
  afterEach(async () => t.close());

  const upload = (fields: Record<string, string>, data: Buffer = webm()) => {
    const mp = multipart(fields, [{ name: 'recording.webm', data, contentType: 'audio/webm;codecs=opus', field: 'file' }]);
    return t.app.inject({ method: 'POST', url: '/api/media/recordings', headers: { ...t.h, 'content-type': mp.contentType }, payload: mp.payload });
  };

  it('stores the recording as a my_audio_note source linked to the lecture; a retried upload is idempotent', async () => {
    const recordingId = newId();
    const started = Date.UTC(2026, 9, 10, 9, 0, 0);
    const res = await upload({ recording_id: recordingId, started_at: String(started), duration_ms: '93000', linked_source_id: f.sourceId });
    expect(res.statusCode).toBe(201);
    const r = (res.json() as RecordingResponse).recording;
    expect(r).toMatchObject({ id: recordingId, mime: 'audio/webm', started_at: started, linked_source_id: f.sourceId, duration_ms: 93000 });
    expect(r.stream_url).toMatch(/^\/api\/media\/audio\/.+\/stream$/);
    expect(r.title).toMatch(/^ملاحظة صوتية — \d{1,2}\/\d{1,2} \d{2}:\d{2}$/); // no bidi marks: renders the same in any direction
    const src = t.ctx.db.get<{ source_type: string; source_type_origin: string; node_id: string }>('SELECT source_type, source_type_origin, node_id FROM source WHERE id = ?', [r.source_id])!;
    expect(src).toEqual({ source_type: 'my_audio_note', source_type_origin: 'owner', node_id: folder });
    expect(t.ctx.db.get('SELECT relation FROM source_link WHERE from_source_id = ? AND to_source_id = ?', [r.source_id, f.sourceId])).toEqual({ relation: 'audio_for' });
    // the bytes are served back as they were recorded
    const stream = await t.app.inject({ method: 'GET', url: r.stream_url!, headers: t.h });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toMatch(/audio\/webm/);
    // a lost response → the same recording, no second source
    const again = await upload({ recording_id: recordingId, started_at: String(started), linked_source_id: f.sourceId });
    expect(again.statusCode).toBe(200);
    expect((again.json() as RecordingResponse).created).toBe(false);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM source WHERE source_type = 'my_audio_note'`)!.n).toBe(1);
    // listed for the lecture
    const list = (await t.app.inject({ method: 'GET', url: `/api/media/recordings?source_id=${f.sourceId}`, headers: t.h })).json();
    expect(list.recordings.map((x: { id: string }) => x.id)).toEqual([recordingId]);
  });

  it('refuses what is not audio, empty uploads and an unknown folder — nothing is created', async () => {
    const video = await upload({ recording_id: newId(), started_at: '1', node_id: folder }, webm('V_VP8'));
    expect(video.statusCode).toBe(415);
    expect(video.json().error.message).toMatch(/[؀-ۿ]/);
    const pdf = await upload({ recording_id: newId(), started_at: '1', node_id: folder }, Buffer.from('%PDF-1.4 not audio'));
    expect(pdf.statusCode).toBe(415);
    expect((await upload({ recording_id: newId(), started_at: '1', node_id: folder }, Buffer.alloc(0))).statusCode).toBe(400);
    expect((await upload({ recording_id: newId(), started_at: '1' })).statusCode).toBe(400);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM source WHERE source_type = 'my_audio_note'`)!.n).toBe(0);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audio_recording')!.n).toBe(0);
  });

  it('(review) a lecture purged while the recording waited on the device: the recording is stored unlinked, never refused forever', async () => {
    const res = await upload({ recording_id: newId(), started_at: '1', node_id: folder, linked_source_id: newId() });
    expect(res.statusCode).toBe(201);
    expect((res.json() as RecordingResponse).recording.linked_source_id).toBeNull();
    // the folder sent no longer exists → the lecture's folder; neither exists → a final 400 with what to do
    const viaLecture = await upload({ recording_id: newId(), started_at: '1', node_id: newId(), linked_source_id: f.sourceId });
    expect(viaLecture.statusCode).toBe(201);
    const gone = await upload({ recording_id: newId(), started_at: '1', node_id: newId() });
    expect(gone.statusCode).toBe(400);
    expect(gone.json().error.message).toMatch(/نزّل نسخة/);
  });

  it('(review) two uploads of the same recording at once: one source, both answered (no 500, no orphan duplicate)', async () => {
    const id = newId();
    const body = webm('A_OPUS', 200_000);
    const [a, b] = await Promise.all([upload({ recording_id: id, started_at: '1', node_id: folder }, body), upload({ recording_id: id, started_at: '1', node_id: folder }, body)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect((a.json() as RecordingResponse).recording.source_id).toBe((b.json() as RecordingResponse).recording.source_id);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM source WHERE source_type = 'my_audio_note'`)!.n).toBe(1);
  });

  it('(review) a retried upload of a recording whose source was trashed since is answered as stored (the device stops retrying)', async () => {
    const id = newId();
    const first = (await upload({ recording_id: id, started_at: '1', node_id: folder })).json() as RecordingResponse;
    t.ctx.db.run('UPDATE source SET deleted_at = ? WHERE id = ?', [t.clock.now(), first.recording.source_id]);
    const again = await upload({ recording_id: id, started_at: '1', node_id: folder });
    expect(again.statusCode).toBe(200);
    expect((again.json() as RecordingResponse).created).toBe(false);
  });

  it('strokes written while recording carry time links: automatic first, manual after the owner edits them', async () => {
    const recordingId = newId();
    await upload({ recording_id: recordingId, started_at: '1000', linked_source_id: f.sourceId });
    const strokeId = newId();
    const payload = inkPayload(f);
    const linked = { ...payload, data: { ...(payload.data as object), audio_link: { recording_id: recordingId, offset_ms: 12_500, origin: 'auto' } } };
    const push = (ops: unknown[]) => t.app.inject({ method: 'POST', url: '/api/sync/push', headers: t.h, payload: { ops } });
    expect((await push([op({ entity_type: 'annotation', entity_id: strokeId, op: 'append', payload: linked })])).json().results[0].result).toBe('applied');
    let view = (await t.app.inject({ method: 'GET', url: `/api/media/recordings/${recordingId}`, headers: t.h })).json().recording;
    expect(view.linked_strokes).toEqual([
      { annotation_id: strokeId, source_id: f.sourceId, page_id: f.pageIds[0], page_index: 0, page_label_ar: 'ص 11 (الصفحة 1 في الملف)', offset_ms: 12_500, origin: 'auto' },
    ]);
    // the owner moves the link to another moment → manual
    const edited = { ...linked, data: { ...linked.data, audio_link: { recording_id: recordingId, offset_ms: 9_000, origin: 'manual' } } };
    expect((await push([op({ entity_type: 'annotation', entity_id: strokeId, base_rev: 1, payload: edited })])).json().results[0].result).toBe('applied');
    view = (await t.app.inject({ method: 'GET', url: `/api/media/recordings/${recordingId}`, headers: t.h })).json().recording;
    expect(view.linked_strokes[0]).toMatchObject({ offset_ms: 9_000, origin: 'manual' });
    // a malformed link is refused by the stroke schema (never stored half-valid)
    const bad = { ...linked, data: { ...linked.data, audio_link: { recording_id: recordingId, offset_ms: -5, origin: 'auto' } } };
    expect((await push([op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: bad })])).json().results[0].result).toBe('rejected');
    // an unknown recording id is a 404 with a reason (e.g. not uploaded yet)
    const missing = await t.app.inject({ method: 'GET', url: `/api/media/recordings/${newId()}`, headers: t.h });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toMatch(/لم يُرفع بعد/);
  });
});
