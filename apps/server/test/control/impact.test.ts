// Impact preview → explicit apply (§48): changing a rule, a source priority or a model shows which stored generated
// content would stop being reused, applies only with a fresh confirmation token, and NEVER regenerates or edits
// anything. The rules engine is the real one (studybook resolveRules); artifacts carry real rules_versions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImpactApplyResponse, ImpactPreviewResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { FakeAiProvider } from '../helpers/fake-ai';
import { addSource } from '../processing/helpers';
import { api, createControlApp, insertArtifactWithRules, type Api } from './helpers';

let t: TestApp;
let h: AuthHeaders;
let a: Api;
let lectureId: string;
let lectureVersion: string;
let refId: string;
let refVersion: string;
let nodeId: string;

function snapshot() {
  return {
    artifacts: t.ctx.db.all('SELECT id, status, updated_at, rules_version, cache_key FROM artifact ORDER BY id'),
    jobs: t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM processing_job')!.n,
  };
}

beforeAll(async () => {
  t = await createControlApp();
  h = await t.login();
  a = api(t, h);
  // a folder with its own rules; the lecture lives in it, the reference does not
  const now = t.ctx.clock.now();
  nodeId = newId(now);
  t.ctx.db.run(`INSERT INTO library_node (id, parent_id, kind, title, sort_order, created_at, updated_at) VALUES (?, NULL, 'course', 'Surgery (TEST)', 0, ?, ?)`, [nodeId, now, now]);
  const lec = await addSource(t, 'lecture_appendicitis.pdf', 'pdf', { sourceType: 'lecture', title: 'Lecture (TEST FIXTURE)' });
  const ref = await addSource(t, 'lecture_cholecystitis.pdf', 'pdf', { sourceType: 'course_reference', title: 'Reference (TEST FIXTURE)' });
  lectureId = lec.sourceId;
  lectureVersion = lec.versionId;
  refId = ref.sourceId;
  refVersion = ref.versionId;
  t.ctx.db.run('UPDATE source SET node_id = ? WHERE id = ?', [nodeId, lectureId]);
}, 60_000);
afterAll(async () => t?.close());

describe('rule-affecting settings', () => {
  it('lists exactly the stored content a new request would no longer reuse — and changes nothing', async () => {
    const plain = insertArtifactWithRules(t, { sourceId: lectureId, title: 'شرح عادي' });
    const simplified = insertArtifactWithRules(t, { sourceId: lectureId, overrides: { level: 'simple' }, params: { level: 'simple' }, title: 'تبسيط' });
    const older = insertArtifactWithRules(t, { sourceId: refId, title: 'قديم' });
    t.ctx.db.run(`UPDATE artifact SET rules_version = 'r-0000000000000000' WHERE id = ?`, [older]);
    const before = snapshot();
    const settingsBefore = t.ctx.settings.get();

    const r = await a.post<ImpactPreviewResponse>('/api/control/impact/preview', { change: { kind: 'settings', patch: { explanation_level: 'detailed' } } });
    expect(r.status).toBe(200);
    expect(r.body.regenerates_automatically).toBe(false);
    expect(r.body.change_ar[0]).toContain('مستوى الشرح الافتراضي');
    const ids = r.body.affected.map((x) => x.id);
    expect(ids).toContain(plain); // made with the default level → no longer matches
    expect(ids).not.toContain(simplified); // its level was the request's own (simple) → still reused
    expect(ids).not.toContain(older);
    expect(r.body.not_comparable_count).toBeGreaterThanOrEqual(1); // made under earlier rules: counted, not guessed
    expect(r.body.affected.find((x) => x.id === plain)!.reason_ar).toContain('مستوى الشرح');
    expect(r.body.effects_ar[0]).toContain('لن يُعاد توليد أي شيء تلقائيًا');
    expect(r.body.can_apply).toBe(true);
    expect(r.body.confirm_token).toBeTruthy();
    // the preview is a rolled-back dry run: nothing persisted
    expect(t.ctx.settings.get()).toEqual(settingsBefore);
    expect(snapshot()).toEqual(before);

    // a dialect change also touches the simplified explanation (the request only fixed the level)
    const d = await a.post<ImpactPreviewResponse>('/api/control/impact/preview', { change: { kind: 'settings', patch: { dialect: 'iraqi_teaching' } } });
    expect(d.body.affected.map((x) => x.id)).toEqual(expect.arrayContaining([plain, simplified]));

    // answer style is not part of the rules: nothing affected
    const s = await a.post<ImpactPreviewResponse>('/api/control/impact/preview', { change: { kind: 'settings', patch: { answer_style: 'short' } } });
    expect(s.body.affected_count).toBe(0);
    expect(s.body.effects_ar.join(' ')).toContain('الطلبات الجديدة فقط');
  });

  it('applies only with a fresh token, audits the impact, and still regenerates nothing', async () => {
    const change = { kind: 'settings', patch: { explanation_level: 'expert' } } as const;
    const p = await a.post<ImpactPreviewResponse>('/api/control/impact/preview', { change });
    expect((await a.post('/api/control/impact/apply', { change, confirm_token: 'not-the-token' })).status).toBe(409);
    // the state changes between preview and apply → the old token is refused
    t.ctx.settings.patch({ dialect: 'iraqi_teaching' });
    const stale = await a.post('/api/control/impact/apply', { change, confirm_token: p.body.confirm_token });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.reason).toBe('preview_stale');
    t.ctx.settings.patch({ dialect: 'fusha_simple' });
    const fresh = await a.post<ImpactPreviewResponse>('/api/control/impact/preview', { change });
    const before = snapshot();
    const applied = await a.post<ImpactApplyResponse>('/api/control/impact/apply', { change, confirm_token: fresh.body.confirm_token });
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(true);
    expect(t.ctx.settings.get().explanation_level).toBe('expert');
    expect(snapshot()).toEqual(before); // no artifact touched, no job enqueued
    expect(applied.body.effects_ar).toContain('لم يُعَد توليد أي شيء تلقائيًا.');
    const audit = t.ctx.db.get<{ summary: string; after_json: string }>(`SELECT summary, after_json FROM change_log WHERE action = 'apply_change' ORDER BY created_at DESC LIMIT 1`)!;
    expect(audit.summary).toContain('مستوى الشرح الافتراضي');
    expect(JSON.parse(audit.after_json)).toMatchObject({ affected: fresh.body.affected_count, regenerated: 0 });
    t.ctx.settings.patch({ explanation_level: 'medium' });
  });

  it('rejects settings that do not affect generated content and invalid values', async () => {
    expect((await a.post('/api/control/impact/preview', { change: { kind: 'settings', patch: { theme: 'dark' } } })).status).toBe(400);
    expect((await a.post('/api/control/impact/preview', { change: { kind: 'settings', patch: { explanation_level: 'genius' } } })).status).toBe(400);
    expect((await a.post('/api/control/impact/preview', { change: { kind: 'settings', patch: {} } })).status).toBe(400);
    expect((await a.post('/api/control/impact/preview', { change: { kind: 'nope' } })).status).toBe(400);
  });
});

describe('explanation rules layers', () => {
  it('owner layer: preview, then apply through the studybook rules route', async () => {
    const art = insertArtifactWithRules(t, { sourceId: refId, title: 'شرح المرجع' });
    const change = { kind: 'rules_owner', patch: { include: { examples: false } } } as const;
    const p = await a.post<ImpactPreviewResponse>('/api/control/impact/preview', { change });
    expect(p.status).toBe(200);
    expect(p.body.affected.map((x) => x.id)).toContain(art);
    expect(t.ctx.db.get(`SELECT 1 AS x FROM explanation_rule_override WHERE target_type = 'owner'`)).toBeUndefined(); // dry run
    const before = snapshot();
    const ok = await a.post<ImpactApplyResponse>('/api/control/impact/apply', { change, confirm_token: p.body.confirm_token });
    expect(ok.status).toBe(200);
    const rules = await a.get('/api/studybook/rules');
    expect(rules.body.rules.include.examples).toBe(false);
    expect(t.ctx.db.get(`SELECT 1 AS x FROM change_log WHERE entity_type = 'explanation_rules' AND entity_id = 'owner'`)).toBeDefined(); // the owning module audited its write
    expect(snapshot()).toEqual(before);
    expect((await a.post('/api/control/impact/preview', { change: { kind: 'rules_owner', patch: { level: 'genius' } } })).status).toBe(400);
  });

  it('folder layer: only content of sources inside that folder is affected; removing the override is previewed too', async () => {
    const inside = insertArtifactWithRules(t, { sourceId: lectureId, title: 'داخل المجلد' });
    const outside = insertArtifactWithRules(t, { sourceId: refId, title: 'خارج المجلد' });
    const change = { kind: 'rules_node', node_id: nodeId, patch: { template: 'surgery' } } as const;
    const p = await a.post<ImpactPreviewResponse>('/api/control/impact/preview', { change });
    expect(p.body.affected.map((x) => x.id)).toContain(inside);
    expect(p.body.affected.map((x) => x.id)).not.toContain(outside);
    const ok = await a.post('/api/control/impact/apply', { change, confirm_token: p.body.confirm_token });
    expect(ok.status).toBe(200);
    expect((await a.get(`/api/studybook/rules?node_id=${nodeId}`)).body.rules.template).toBe('surgery');
    const removal = await a.post<ImpactPreviewResponse>('/api/control/impact/preview', { change: { kind: 'rules_node', node_id: nodeId, patch: null } });
    expect(removal.status).toBe(200);
    expect(removal.body.change_ar[0]).toContain('إزالة');
    expect((await a.post('/api/control/impact/preview', { change: { kind: 'rules_node', node_id: 'MISSINGNODE000000000000000', patch: null } })).status).toBe(404);
  });
});

describe('source priority', () => {
  it('is not part of any cache key: nothing becomes stale; mixed-scope content is counted as «could differ»', async () => {
    const mixed = insertArtifactWithRules(t, { sourceId: lectureId, versionIds: [lectureVersion, refVersion], title: 'نطاق مختلط' });
    const current = t.ctx.settings.get().source_priority;
    const change = { kind: 'settings', patch: { source_priority: { ...current, lecture_explanation: ['course_reference', 'lecture', 'textbook'] } } } as const;
    const p = await a.post<ImpactPreviewResponse>('/api/control/impact/preview', { change });
    expect(p.status).toBe(200);
    expect(p.body.affected_count).toBe(0);
    expect(p.body.may_differ_count).toBeGreaterThanOrEqual(1);
    expect(p.body.effects_ar.join(' ')).toContain('لا تقرر من يفوز');
    const before = snapshot();
    const ok = await a.post('/api/control/impact/apply', { change, confirm_token: p.body.confirm_token });
    expect(ok.status).toBe(200);
    expect(t.ctx.settings.get().source_priority.lecture_explanation).toEqual(['course_reference', 'lecture', 'textbook']);
    expect(snapshot()).toEqual(before);
    expect(mixed).toBeTruthy();
    const sp = await a.get('/api/control/sources');
    expect(sp.body.purposes.find((x: { purpose: string }) => x.purpose === 'lecture_explanation').order).toEqual(['course_reference', 'lecture', 'textbook']);
  });
});

describe('models (server settings: preview only)', () => {
  it('without a provider: honest preview, cannot apply', async () => {
    const p = await a.post<ImpactPreviewResponse>('/api/control/impact/preview', { change: { kind: 'model', role: 'generation', model: 'claude-test-2' } });
    expect(p.status).toBe(200);
    expect(p.body.can_apply).toBe(false);
    expect(p.body.affected_count).toBe(0);
    expect(p.body.apply_note_ar).toContain('MEDLEVO_MODEL_GENERATION');
    const applied = await a.post('/api/control/impact/apply', { change: { kind: 'model', role: 'generation', model: 'claude-test-2' }, confirm_token: 'whatever-token' });
    expect(applied.status).toBe(409);
    expect((await a.post('/api/control/impact/preview', { change: { kind: 'model', role: 'generation', model: 'bad model; rm -rf' } })).status).toBe(400);
  });

  it('with a provider: generated content of the role is listed, deterministic content is not', async () => {
    const t2 = await createControlApp({ ai: new FakeAiProvider() });
    try {
      const h2 = await t2.login();
      const a2 = api(t2, h2);
      const s = await addSource(t2, 'lecture_appendicitis.pdf', 'pdf', { sourceType: 'lecture' });
      const gen = insertArtifactWithRules(t2, { sourceId: s.sourceId, kind: 'study_book', model: 'fake-model-1' });
      const fig = insertArtifactWithRules(t2, { sourceId: s.sourceId, kind: 'figure_explanation', model: 'fake-model-1' });
      const det = insertArtifactWithRules(t2, { sourceId: s.sourceId, kind: 'summary', model: null });
      const g = await a2.post<ImpactPreviewResponse>('/api/control/impact/preview', { change: { kind: 'model', role: 'generation', model: 'other-model' } });
      expect(g.body.change_ar[0]).toContain('fake-model-1');
      expect(g.body.affected.map((x) => x.id)).toEqual([gen]);
      const v = await a2.post<ImpactPreviewResponse>('/api/control/impact/preview', { change: { kind: 'model', role: 'vision', model: 'other-model' } });
      expect(v.body.affected.map((x) => x.id)).toEqual([fig]);
      const ver = await a2.post<ImpactPreviewResponse>('/api/control/impact/preview', { change: { kind: 'model', role: 'verification', model: 'other-model' } });
      expect(ver.body.affected.map((x) => x.id).sort()).toEqual([gen, fig].sort());
      expect(ver.body.affected.map((x) => x.id)).not.toContain(det);
      const same = await a2.post<ImpactPreviewResponse>('/api/control/impact/preview', { change: { kind: 'model', role: 'generation', model: 'fake-model-1' } });
      expect(same.body.affected_count).toBe(0);
    } finally {
      await t2.close();
    }
  }, 60_000);
});
