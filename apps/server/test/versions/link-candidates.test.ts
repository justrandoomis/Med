// P1-T3 step 3 — link-candidate matching as a PURE service (ARCHITECTURE_DELTA §6.9 step 1; reused by P1-T5): a sha256
// match and a ≥ 60 % fingerprint match are found, an unrelated deck is not. Inputs are labelled TEST FIXTURES.
import { afterEach, describe, expect, it } from 'vitest';
import type { LinkCandidateInput, LinkCandidatesResponse } from '@medlevo/shared';
import { readFingerprints } from '../../src/modules/processing/fingerprint';
import { LINK_THRESHOLD, matchLinkCandidates } from '../../src/modules/versions/candidates';
import { scenario4V1, scenario4V2, unrelatedDeck } from '../fixtures/versions/build';
import type { TestApp } from '../helpers/app';
import { addSource, createProcessingApp, processVersion } from '../processing/helpers';

let t: TestApp;
afterEach(async () => t?.close());

async function processed(data: Buffer, name: string, contentHash?: string) {
  const s = await addSource(t, 'x.pdf', 'pdf', { data, fileName: name, title: `TEST FIXTURE ${name}` });
  if (contentHash) t.ctx.db.run('UPDATE source_version SET content_hash = ? WHERE id = ?', [contentHash, s.versionId]);
  await processVersion(t, s.versionId);
  return s;
}

const input = (s: { sourceId: string; versionId: string }, title: string, hash: string): LinkCandidateInput => ({
  source_id: s.sourceId,
  version_id: s.versionId,
  title,
  content_hash: hash,
  pages: readFingerprints(t.ctx, s.versionId),
});

describe('matchLinkCandidates (pure)', () => {
  it('finds the sha256 twin and the ≥ 60 % fingerprint twin; not the unrelated deck', async () => {
    t = await createProcessingApp();
    const official = await processed(scenario4V1(), 'official.pdf', 'sha-official');
    const privateV2 = await processed(scenario4V2(), 'my copy.pdf', 'sha-private');
    const unrelated = await processed(unrelatedDeck(), 'lecture 9.pdf', 'sha-unrelated');
    const target = input(privateV2, 'my copy', 'sha-private');
    const cands = [input(official, 'Lecture 5', 'sha-official'), input(unrelated, 'Lecture 9', 'sha-unrelated'), { ...input(official, 'Same bytes', 'sha-private'), version_id: 'same-bytes' }];
    const res = matchLinkCandidates(target, cands);
    expect(res.map((r) => [r.version_id, r.basis])).toEqual([
      ['same-bytes', 'sha256'],
      [official.versionId, 'fingerprints'],
    ]);
    const fpMatch = res[1]!;
    expect(fpMatch.matched_pages).toBe(39);
    expect(fpMatch.total_pages).toBe(40);
    expect(fpMatch.ratio).toBeGreaterThanOrEqual(LINK_THRESHOLD);
    expect(fpMatch.basis_ar[0]).toContain('39 من 40');
    // pure: same inputs → same output, no database involved
    expect(matchLinkCandidates(target, cands)).toEqual(res);
  });

  it('below the threshold is not a candidate', async () => {
    t = await createProcessingApp();
    const a = await processed(scenario4V1(), 'a.pdf', 'h-a');
    const fps = readFingerprints(t.ctx, a.versionId);
    // a target holding only the first 20 of the 40 pages: 50 % of the candidate's pages
    const half: LinkCandidateInput = { source_id: 't', version_id: 't', title: 'half', content_hash: 'h-t', pages: fps.slice(0, 20).map((p) => ({ ...p, page_id: `t${p.page_index}` })) };
    expect(matchLinkCandidates(half, [input(a, 'A', 'h-a')])).toEqual([]);
    const most: LinkCandidateInput = { ...half, pages: fps.slice(0, 25).map((p) => ({ ...p, page_id: `t${p.page_index}` })) };
    expect(matchLinkCandidates(most, [input(a, 'A', 'h-a')])[0]?.matched_pages).toBe(25);
  });

  it('the vault route lists candidates inside the caller’s own database only', async () => {
    t = await createProcessingApp();
    const a = await processed(scenario4V1(), 'a.pdf', 'h-a');
    const b = await processed(scenario4V2(), 'b.pdf', 'h-b');
    const h = await t.login();
    const res = await t.app.inject({ method: 'GET', url: `/api/versions/sources/${b.sourceId}/link-candidates`, headers: h });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as LinkCandidatesResponse;
    expect(body.threshold).toBe(0.6);
    expect(body.candidates.map((c) => c.source_id)).toEqual([a.sourceId]);
  });
});
