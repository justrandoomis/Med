// PERF (MEDLEVO_PERF=1): thousands of the owner's own records through the REAL sync API — 3 000 flashcards with
// 12 000 review events (FSRS replay on the server), 5 000 ink strokes on ONE page — then the read paths that fold or
// return them (review queue, home, forecast, weakness, by-targets, full initial pull of a fresh device).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type SyncOp, type SyncOpResult } from '@medlevo/shared';
import { createSourceFixture, pageAnchor, type SourceFixture } from '../annotations/helpers';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';
import { PERF_ENABLED } from './fixtures';
import { latency, mb, report, withMemory } from './measure';

const CARDS = Number(process.env.MEDLEVO_PERF_CARDS || 3000);
const EVENTS_PER_CARD = Number(process.env.MEDLEVO_PERF_EVENTS_PER_CARD || 4);
const STROKES = Number(process.env.MEDLEVO_PERF_STROKES || 5000);
const POINTS = 40;
const DAY = 86_400_000;
const BATCH = 500; // MAX_PUSH_OPS

describe.skipIf(!PERF_ENABLED)('perf: learning records and ink at scale', () => {
  let t: TestApp;
  let h: AuthHeaders;
  let f: SourceFixture;
  beforeAll(async () => {
    t = await createTestApp();
    t.clock.now = () => Date.now();
    h = await t.login();
    f = createSourceFixture(t, 'Perf ink source (TEST FIXTURE)');
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });

  async function pushAll(ops: SyncOp[]): Promise<{ ms: number; results: Record<string, number>; requests: number; maxRequestMs: number }> {
    const results: Record<string, number> = {};
    let maxRequestMs = 0;
    const t0 = performance.now();
    let requests = 0;
    for (let i = 0; i < ops.length; i += BATCH) {
      const r0 = performance.now();
      const res = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { ops: ops.slice(i, i + BATCH) } });
      maxRequestMs = Math.max(maxRequestMs, performance.now() - r0);
      requests++;
      if (res.statusCode !== 200) throw new Error(`push ${res.statusCode}: ${res.body.slice(0, 300)}`);
      for (const r of (res.json() as { results: SyncOpResult[] }).results) results[r.result] = (results[r.result] ?? 0) + 1;
    }
    return { ms: performance.now() - t0, results, requests, maxRequestMs };
  }

  const get = (url: string) =>
    t.app.inject({ method: 'GET', url, headers: h }).then((r) => {
      if (r.statusCode !== 200) throw new Error(`${url} → ${r.statusCode}: ${r.body.slice(0, 300)}`);
      return r;
    });

  it('pushes, folds and serves them', async () => {
    const now = Date.now();
    const rt = (s: string) => ({ v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t: s }] }] });
    // ── 3 000 cards created 120 days ago, then 4 reviews each over the following months ──
    const cardIds = Array.from({ length: CARDS }, () => newId());
    const cardOps: SyncOp[] = cardIds.map((id, i) => ({
      op_id: newId(),
      device_id: 'perf-device',
      entity_type: 'flashcard',
      entity_id: id,
      op: 'upsert',
      payload: { id, kind: 'basic', front: rt(`Fixture card ${i + 1} front (TEST FIXTURE)`), back: rt(`Fixture answer ${i + 1}: ${i % 9}.${i % 7} mmol/L`), origin: 'owner', created_at: now - 120 * DAY + i * 1000 },
      client_ts: now,
    }));
    const cardsPush = await withMemory(() => pushAll(cardOps));
    expect(cardsPush.value.results.applied).toBe(CARDS);

    const offsets = [1, 4, 12, 40, 75, 100];
    const eventOps: SyncOp[] = [];
    cardIds.forEach((cardId, i) => {
      for (let k = 0; k < EVENTS_PER_CARD; k++) {
        const id = newId();
        const rating = (i + k) % 11 === 0 ? 1 : (i + k) % 5 === 0 ? 2 : (i + k) % 7 === 0 ? 4 : 3;
        eventOps.push({
          op_id: newId(),
          device_id: 'perf-device',
          entity_type: 'review_event',
          entity_id: id,
          op: 'append',
          payload: { id, card_id: cardId, rating, reviewed_at: now - 120 * DAY + i * 1000 + offsets[k % offsets.length]! * DAY, duration_ms: 4000 + (i % 30) * 100 },
          client_ts: now,
        });
      }
    });
    const eventsPush = await withMemory(() => pushAll(eventOps));
    expect(eventsPush.value.results.applied).toBe(CARDS * EVENTS_PER_CARD);

    const queue = await latency(10, () => get('/api/learning/review/queue'), 1);
    const queueBody = (await get('/api/learning/review/queue')).json() as { counts?: Record<string, number> };
    const home = await latency(10, () => get('/api/learning/home'), 1);
    const forecast = await latency(10, () => get('/api/learning/forecast'), 1);
    const weakness = await latency(10, () => get('/api/learning/weakness'), 1);
    const cardsList = await latency(10, () => get('/api/learning/cards?limit=50'), 1);
    const rebuild = await withMemory(() => t.app.inject({ method: 'POST', url: '/api/learning/srs/rebuild', headers: h }));
    expect(rebuild.value.statusCode).toBe(200);

    // ── 5 000 ink strokes (40 samples each) on ONE page ──
    const anchor = pageAnchor(f, 0);
    const strokeOps: SyncOp[] = Array.from({ length: STROKES }, (_, s) => {
      const id = newId();
      const x0 = 0.05 + ((s * 37) % 85) / 100;
      const y0 = 0.05 + ((s * 53) % 88) / 100;
      const points = Array.from({ length: POINTS }, (_, k) => [Math.round((x0 + k * 0.002) * 1e5) / 1e5, Math.round((y0 + Math.sin(k / 4) * 0.004) * 1e5) / 1e5, k * 8, Math.round((0.4 + (k % 5) / 20) * 100) / 100]);
      return {
        op_id: newId(),
        device_id: 'perf-device',
        entity_type: 'annotation',
        entity_id: id,
        op: 'append',
        payload: {
          kind: 'ink',
          tool: 'pen',
          anchor,
          layer: 'ink',
          z: s,
          locked: false,
          data: { v: 1, points, style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x: x0, y: y0 - 0.004, w: POINTS * 0.002, h: 0.008 }, pressure_available: true, tilt_available: false },
        },
        client_ts: now,
      };
    });
    const inkPush = await withMemory(() => pushAll(strokeOps));
    expect(inkPush.value.results.applied).toBe(STROKES);

    const key = `source_page:${f.pageIds[0]}`;
    let byTargetsBytes = 0;
    const byTargets = await latency(10, async () => {
      const r = await get(`/api/annotations/by-targets?keys=${encodeURIComponent(key)}`);
      byTargetsBytes = r.body.length;
    }, 1);
    const sourceDownload = await latency(5, () => get(`/api/annotations/source/${f.sourceId}`), 1);

    // ── a fresh device: full initial pull of the change feed ──
    const pull = await withMemory(async () => {
      let since = 0;
      let changes = 0;
      let bytes = 0;
      let pages = 0;
      for (;;) {
        const r = await get(`/api/sync/pull?since=${since}&limit=1000`);
        bytes += r.body.length;
        const body = r.json() as { changes: unknown[]; next_since: number; has_more: boolean };
        changes += body.changes.length;
        pages++;
        since = body.next_since;
        if (!body.has_more) break;
      }
      return { changes, bytes, pages };
    });

    const rate = (n: number, ms: number) => Math.round((n / (ms / 1000)) * 10) / 10;
    report('learning-ink', {
      scenario: `${CARDS} flashcards + ${CARDS * EVENTS_PER_CARD} review events (FSRS, server replay) and ${STROKES} ink strokes × ${POINTS} samples on one page, all through POST /api/sync/push (${BATCH} ops/request)`,
      push: {
        cards: { ms: Math.round(cardsPush.ms), ops_per_s: rate(CARDS, cardsPush.ms), requests: cardsPush.value.requests, max_request_ms: Math.round(cardsPush.value.maxRequestMs), memory: cardsPush.mem },
        review_events: { ms: Math.round(eventsPush.ms), ops_per_s: rate(CARDS * EVENTS_PER_CARD, eventsPush.ms), requests: eventsPush.value.requests, max_request_ms: Math.round(eventsPush.value.maxRequestMs), memory: eventsPush.mem },
        ink_strokes: { ms: Math.round(inkPush.ms), ops_per_s: rate(STROKES, inkPush.ms), requests: inkPush.value.requests, max_request_ms: Math.round(inkPush.value.maxRequestMs), memory: inkPush.mem },
      },
      read_ms: { review_queue: queue, home, forecast, weakness, cards_list_50: cardsList, by_targets_one_page: byTargets, source_annotations_download: sourceDownload },
      review_queue_counts: queueBody.counts ?? null,
      srs_rebuild_all: { ms: Math.round(rebuild.ms), memory: rebuild.mem },
      by_targets_payload_mb: mb(byTargetsBytes),
      initial_pull: { ms: Math.round(pull.ms), ...pull.value, mb: mb(pull.value.bytes), memory: pull.mem },
    });
  }, 30 * 60_000);
});
