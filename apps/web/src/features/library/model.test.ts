import { describe, expect, it } from 'vitest';
import type { LibraryNodeView, SourceSummary } from '@medlevo/shared';
import { countAr, extentLabel, NOUN, processingLabel, sourceSubtitle } from './labels';
import {
  buildIndex,
  canMoveInto,
  childrenOf,
  descendantIds,
  filterByTags,
  groupForCourse,
  pathOf,
  searchLibrary,
  sourcesInSubtree,
  subtreeCounts,
  trashEntries,
} from './model';

let seq = 0;
function node(id: string, parent: string | null, over: Partial<LibraryNodeView> = {}): LibraryNodeView {
  seq++;
  return {
    id,
    parent_id: parent,
    kind: 'folder',
    title: id,
    description: null,
    color: null,
    icon: null,
    cover: null,
    template: null,
    sort_order: seq * 1024,
    sort_mode: 'manual',
    is_favorite: false,
    archived_at: null,
    deleted_at: null,
    created_at: seq,
    updated_at: seq,
    tags: [],
    ...over,
  };
}
function source(id: string, nodeId: string, over: Partial<SourceSummary> = {}): SourceSummary {
  seq++;
  return {
    id,
    title: id,
    source_type: 'lecture',
    node_id: nodeId,
    subject_node_id: null,
    course_node_id: null,
    lecture_kind: null,
    lecture_kind_origin: null,
    processing_status: 'pending',
    current_version_id: `v-${id}`,
    frozen_version_id: null,
    active_version_id: `v-${id}`,
    format: 'pdf',
    page_count: 4,
    is_favorite: false,
    last_opened_at: null,
    archived_at: null,
    deleted_at: null,
    created_at: seq,
    updated_at: seq,
    tags: [],
    ...over,
  };
}

describe('library tree model', () => {
  const nodes = [
    node('surgery', null, { kind: 'notebook', title: 'الجراحة' }),
    node('course1', 'surgery', { kind: 'course', title: 'Course 1' }),
    node('acute', 'course1', { title: 'Acute abdomen' }),
    node('anatomy', null, { kind: 'subject', title: 'التشريح' }),
  ];
  const sources = [
    source('appendicitis', 'acute', { title: 'محاضرة الزائدة الدودية' }),
    source('ref', 'course1', { source_type: 'textbook', title: 'Bailey & Love' }),
    source('qs', 'course1', { source_type: 'question_source', title: 'أسئلة الكورس' }),
  ];
  const index = buildIndex(nodes, sources);

  it('builds children, paths and subtree counts', () => {
    expect(childrenOf(index, null).map((n) => n.id)).toEqual(['surgery', 'anatomy']);
    expect(pathOf(index, 'acute').map((n) => n.id)).toEqual(['surgery', 'course1', 'acute']);
    expect([...descendantIds(index, 'surgery')].sort()).toEqual(['acute', 'course1']);
    expect(subtreeCounts(index, 'surgery')).toEqual({ folders: 2, sources: 3 });
    expect(sourcesInSubtree(index, 'course1').map((s) => s.id).sort()).toEqual(['appendicitis', 'qs', 'ref']);
  });

  it('a node whose parent is missing from the listing (archived/trashed) is shown at the root', () => {
    const idx = buildIndex([node('orphan', 'gone')], []);
    expect(childrenOf(idx, null).map((n) => n.id)).toEqual(['orphan']);
  });

  it('sort modes: manual (sort_order), title (Arabic + numeric aware), updated/created newest first', () => {
    const list = [node('b', null, { title: 'Lecture 10', sort_order: 1 }), node('a', null, { title: 'Lecture 2', sort_order: 2 }), node('c', null, { title: 'أ محاضرة', sort_order: 3 })];
    const idx = buildIndex(list, []);
    expect(childrenOf(idx, null, 'manual').map((n) => n.id)).toEqual(['b', 'a', 'c']);
    const titleOrder = childrenOf(idx, null, 'title').map((n) => n.title);
    expect(titleOrder.indexOf('Lecture 2')).toBeLessThan(titleOrder.indexOf('Lecture 10'));
    expect(childrenOf(idx, null, 'created').map((n) => n.id)).toEqual(['c', 'a', 'b']);
  });

  it('cycle prevention: never into itself or a descendant', () => {
    expect(canMoveInto(index, 'surgery', 'surgery')).toBe(false);
    expect(canMoveInto(index, 'surgery', 'acute')).toBe(false);
    expect(canMoveInto(index, 'acute', 'anatomy')).toBe(true);
    expect(canMoveInto(index, 'acute', null)).toBe(true);
  });

  it('title search is Arabic-normalized and matches nodes and sources with their path', () => {
    const hits = searchLibrary(index, 'محاضره الزائده');
    expect(hits.map((h) => h.id)).toEqual(['appendicitis']);
    expect(hits[0]!.path.map((p) => p.id)).toEqual(['surgery', 'course1', 'acute']);
    expect(searchLibrary(index, 'course').map((h) => h.id)).toEqual(['course1']);
    expect(searchLibrary(index, '   ')).toEqual([]);
  });

  it('tag filter requires all selected tags', () => {
    const items = [
      { id: '1', tags: [{ id: 't1' }, { id: 't2' }] },
      { id: '2', tags: [{ id: 't1' }] },
    ];
    expect(filterByTags(items, ['t1']).map((i) => i.id)).toEqual(['1', '2']);
    expect(filterByTags(items, ['t1', 't2']).map((i) => i.id)).toEqual(['1']);
    expect(filterByTags(items, [])).toHaveLength(2);
  });

  it('course grouping: lectures / references / question sources', () => {
    const groups = groupForCourse(sources);
    expect(groups.map((g) => [g.title, g.sources.map((s) => s.id)])).toEqual([
      ['المحاضرات', ['appendicitis']],
      ['المراجع', ['ref']],
      ['مصادر الأسئلة', ['qs']],
    ]);
  });
});

describe('trash entries', () => {
  it('lists trash roots; items trashed together with a folder are not listed separately; earlier-trashed children are', () => {
    const t1 = 1000;
    const t0 = 500;
    const nodes = [
      node('root', null, { deleted_at: t1 }),
      node('child', 'root', { deleted_at: t1 }),
      node('early', 'root', { deleted_at: t0 }),
      node('live', null),
    ];
    const sources = [
      source('inside', 'child', { deleted_at: t1 }),
      source('own', 'live', { deleted_at: 2000 }),
      source('alive', 'live'),
    ];
    const entries = trashEntries(nodes, sources);
    expect(entries.map((e) => `${e.kind}:${e.id}`)).toEqual(['source:own', 'node:root', 'node:early']);
    expect(entries.find((e) => e.id === 'root')!.contains).toEqual({ folders: 1, sources: 1 });
  });
});

describe('labels', () => {
  it('Arabic number agreement', () => {
    expect(countAr(1, NOUN.page)).toBe('صفحة واحدة');
    expect(countAr(2, NOUN.page)).toBe('صفحتان');
    expect(countAr(3, NOUN.page)).toBe('3 صفحات');
    expect(countAr(10, NOUN.source)).toBe('10 مصادر');
    expect(countAr(11, NOUN.source)).toBe('11 مصدرًا');
    expect(countAr(103, NOUN.source)).toBe('103 مصادر');
    expect(countAr(0, NOUN.source)).toBe('لا مصادر');
  });

  it('extent never invents pages for DOCX/audio', () => {
    expect(extentLabel('pdf', 4)).toBe('4 صفحات');
    expect(extentLabel('pptx', 3)).toBe('3 شرائح');
    expect(extentLabel('image_set', 12)).toBe('12 صورة');
    expect(extentLabel('docx', 30)).toBeNull();
    expect(extentLabel('audio', 1)).toBeNull();
    expect(extentLabel('pdf', null)).toBeNull();
    expect(sourceSubtitle({ source_type: 'lecture', format: 'pdf', page_count: 4 })).toBe('محاضرة، PDF، 4 صفحات');
    expect(processingLabel('partial', 'audio')).toBe('محفوظ دون تفريغ نصي');
    expect(processingLabel('failed')).toBe('فشلت المعالجة');
  });
});
