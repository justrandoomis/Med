// P1-T2 — layer contract (ARCHITECTURE_DELTA §4.3, §5.4, §7.5; ADR-0004 §2.1 R1–R6).
import { describe, expect, it } from 'vitest';
import {
  CLIENT_LAYER_KINDS,
  copyLayersRequestSchema,
  defaultPersonalLayerId,
  documentKeySchema,
  LAYER_KINDS,
  layerAccess,
  layerCreateSchema,
  layerPatchSchema,
  notebookDocumentKey,
  parseDocumentKey,
  sourceDocumentKey,
  type LayerKind,
} from '../src';

describe('layer contract', () => {
  it('document keys name a source (all versions) or a notebook', () => {
    expect(sourceDocumentKey('S1')).toBe('source:S1');
    expect(notebookDocumentKey('N1')).toBe('notebook:N1');
    expect(parseDocumentKey('source:S1')).toEqual({ type: 'source', id: 'S1' });
    expect(parseDocumentKey('notebook:N_1-a')).toEqual({ type: 'notebook', id: 'N_1-a' });
    expect(parseDocumentKey('page:S1')).toBeNull();
    expect(parseDocumentKey('source:')).toBeNull();
    expect(documentKeySchema.safeParse('source:a b').success).toBe(false);
  });

  it('the default personal layer id is derived, stable, a valid sync id and different per document', () => {
    const a = defaultPersonalLayerId('source:01HZ0000000000000000000001');
    expect(a).toBe(defaultPersonalLayerId('source:01HZ0000000000000000000001'));
    expect(a).toMatch(/^pl_[0-9a-f]{16}$/);
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) ids.add(defaultPersonalLayerId(`source:S${i}`));
    for (let i = 0; i < 5000; i++) ids.add(defaultPersonalLayerId(`notebook:S${i}`));
    expect(ids.size).toBe(10_000);
  });

  it('access table (§5.4): own kinds write, followed / snapshot are read-only, collaborative is CRDT-only, space kinds are refused in a vault', () => {
    const access = (kind: LayerKind, writable = true, frozen = false) => layerAccess({ kind, writable, frozen });
    expect(access('personal')).toBe('write');
    expect(access('explanation')).toBe('write');
    expect(access('answers')).toBe('write');
    expect(access('forked')).toBe('write');
    expect(access('followed')).toBe('read_only');
    expect(access('followed', true)).toBe('read_only'); // even if a row claims writable
    expect(access('published_snapshot')).toBe('read_only');
    expect(access('personal', false)).toBe('read_only');
    expect(access('personal', true, true)).toBe('read_only');
    expect(access('collaborative')).toBe('use_crdt');
    expect(access('group_comments')).toBe('forbidden');
    expect(access('suggestion')).toBe('forbidden');
    for (const k of LAYER_KINDS) expect(['write', 'read_only', 'use_crdt', 'forbidden']).toContain(access(k));
  });

  it('a client may only create personal / answers / explanation layers; titles are trimmed and bidi controls refused', () => {
    expect(CLIENT_LAYER_KINDS).toEqual(['personal', 'answers', 'explanation']);
    expect(layerCreateSchema.safeParse({ id: 'L1', document_key: 'source:S1', title: ' إجابات ', kind: 'answers' }).data?.title).toBe('إجابات');
    expect(layerCreateSchema.safeParse({ id: 'L1', document_key: 'source:S1', title: 'x', kind: 'followed' }).success).toBe(false);
    expect(layerCreateSchema.safeParse({ id: 'L1', document_key: 'source:S1', title: 'a‮b', kind: 'personal' }).success).toBe(false);
    expect(layerPatchSchema.safeParse({}).success).toBe(false);
    expect(layerPatchSchema.safeParse({ visible: false }).success).toBe(true);
  });

  it('Phase 1 copies exactly one layer', () => {
    expect(copyLayersRequestSchema.safeParse({ from_layer_ids: ['A'], into: { new_title: 'نسخة' } }).success).toBe(true);
    expect(copyLayersRequestSchema.safeParse({ from_layer_ids: ['A', 'B'], into: { layer_id: 'C' } }).success).toBe(false);
    expect(copyLayersRequestSchema.safeParse({ from_layer_ids: ['A'], kinds: ['ink', 'note'], into: { layer_id: 'C' }, preview: true }).success).toBe(true);
    expect(copyLayersRequestSchema.safeParse({ from_layer_ids: ['A'], kinds: ['nope'], into: { layer_id: 'C' } }).success).toBe(false);
  });
});
