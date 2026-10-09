// Pure Study Book / explanation helpers: Lecture Twin mapping, honest coverage wording, Source Lock defaults,
// selection → region anchors, the terminology form and the explanation-rules layering labels.
import { describe, expect, it } from 'vitest';
import type { SourceRegionView, TwinEntry } from '@medlevo/shared';
import {
  coverageSummary,
  defaultScopeFor,
  mergeRulesPatch,
  nearestBlock,
  pageOfBlock,
  pagesAr,
  parseSynonyms,
  referencesOf,
  regionsUnder,
  ruleSourceAr,
  sectionsProgressAr,
  termFormFrom,
  termInputFrom,
  termMatches,
  validateTermForm,
  EMPTY_TERM_FORM,
} from './model';

const twin: TwinEntry[] = [
  { block_key: 'b-intro', section_key: 's1', page_indexes: [0] },
  { block_key: 'b-signs', section_key: 's2', page_indexes: [2, 3] },
  { block_key: 'b-none', section_key: 's2', page_indexes: [] },
  { block_key: 'b-mgmt', section_key: 's3', page_indexes: [6] },
];

describe('Lecture Twin', () => {
  it('maps a lecture page to the block on it, else the nearest following, else the last before', () => {
    expect(nearestBlock(twin, 0)).toBe('b-intro');
    expect(nearestBlock(twin, 3)).toBe('b-signs');
    expect(nearestBlock(twin, 1)).toBe('b-signs'); // nothing on page 1 → the next block
    expect(nearestBlock(twin, 4)).toBe('b-mgmt');
    expect(nearestBlock(twin, 9)).toBe('b-mgmt'); // past the end → the last block before
    expect(nearestBlock([], 2)).toBeNull();
  });
  it('maps a block back to the first page it explains', () => {
    expect(pageOfBlock(twin, 'b-signs')).toBe(2);
    expect(pageOfBlock(twin, 'b-none')).toBeNull();
    expect(pageOfBlock(twin, 'unknown')).toBeNull();
  });
});

describe('honest counts and coverage (no percentages, never «complete» when something is missing)', () => {
  it('section progress and page counts in Arabic', () => {
    expect(sectionsProgressAr({ sections_total: 7, sections_complete: 2, sections_abstained: 1, sections_failed: 0 })).toBe('3 من 7 أقسام');
    expect(sectionsProgressAr({ sections_total: 12, sections_complete: 12, sections_abstained: 0, sections_failed: 0 })).toBe('12 من 12 قسمًا');
    expect([1, 2, 3, 11].map(pagesAr)).toEqual(['صفحة واحدة', 'صفحتان', '3 صفحات', '11 صفحة']);
  });
  it('coverage is complete only when every counted page/section is covered and nothing is missing', () => {
    expect(coverageSummary(null)).toEqual({ complete: false, text: null });
    expect(coverageSummary({ pages_total: 4, pages_covered: 4, sections_total: 3, sections_covered: 3 }).complete).toBe(true);
    expect(coverageSummary({ pages_total: 4, pages_covered: 3 }).complete).toBe(false);
    expect(coverageSummary({ pages_total: 4, pages_covered: 4, missing_ar: ['الصفحة 4 غير مقروءة'] }).complete).toBe(false);
    expect(coverageSummary({ pages_total: 4, pages_covered: 3 }).text).toBe('غطّى 3 صفحات من 4');
    // review: grammatical number / case of the counted nouns
    expect(coverageSummary({ pages_total: 4, pages_covered: 2 }).text).toBe('غطّى صفحتين من 4');
    expect(coverageSummary({ pages_total: 12, pages_covered: 11, sections_total: 12, sections_covered: 11 }).text).toBe('غطّى 11 صفحة من 12 و11 من 12 قسمًا');
    expect(coverageSummary({ pages_total: 4, pages_covered: 4, sections_total: 2, sections_covered: 1 }).text).toBe('غطّى 4 صفحات من 4 و1 من قسمين');
    expect(JSON.stringify(coverageSummary({ pages_total: 4, pages_covered: 3 }))).not.toMatch(/%/);
  });
});

describe('Source Lock defaults', () => {
  const detail = {
    id: 'L1',
    links: [
      { relation: 'reference_for', from_source_id: 'R1', to_source_id: 'L1', other_title: 'Bailey & Love', other_type: 'textbook' },
      { relation: 'reference_for', from_source_id: 'L1', to_source_id: 'L2', other_title: 'Another lecture', other_type: 'lecture' },
      { relation: 'related', from_source_id: 'X', to_source_id: 'L1', other_title: 'x', other_type: 'lecture' },
    ],
  } as unknown as Parameters<typeof referencesOf>[0];
  it('references are only the sources linked as references FOR this lecture', () => {
    expect(referencesOf(detail).map((r) => r.id)).toEqual(['R1']);
  });
  it('the default lock is never wider than the owner chose; references_only / external start from the lecture', () => {
    expect(defaultScopeFor(detail, 'lecture_only')).toMatchObject({ mode: 'lecture_only', lecture_source_id: 'L1', reference_source_ids: [] });
    expect(defaultScopeFor(detail, 'lecture_plus_references')).toMatchObject({ mode: 'lecture_plus_references', reference_source_ids: ['R1'] });
    expect(defaultScopeFor(detail, 'references_only').mode).toBe('lecture_only');
    expect(defaultScopeFor(detail, 'external').mode).toBe('lecture_only');
  });
});

describe('selection → anchor regions', () => {
  const region = (id: string, bbox: SourceRegionView['bbox'], over: Partial<SourceRegionView> = {}) => ({ id, bbox, kind: 'paragraph', parent_region_id: null, status: 'extracted', ...over }) as SourceRegionView;
  it('takes top-level content regions under the selection rectangles, never headers, children or rejected text', () => {
    const regions = [
      region('A', { x: 0.1, y: 0.1, w: 0.8, h: 0.1 }),
      region('B', { x: 0.1, y: 0.3, w: 0.8, h: 0.1 }),
      region('H', { x: 0, y: 0, w: 1, h: 0.05 }, { kind: 'header' }),
      region('C', { x: 0.1, y: 0.12, w: 0.2, h: 0.02 }, { parent_region_id: 'A' }),
      region('X', { x: 0.1, y: 0.12, w: 0.5, h: 0.05 }, { status: 'rejected' }),
      region('N', null),
    ];
    expect(regionsUnder(regions, [{ x: 0.2, y: 0.12, w: 0.3, h: 0.02 }])).toEqual(['A']);
    expect(regionsUnder(regions, [{ x: 0, y: 0, w: 1, h: 1 }])).toEqual(['A', 'B']);
    expect(regionsUnder(regions, [])).toEqual([]);
  });
});

describe('terminology form', () => {
  it('synonyms: commas (Latin and Arabic), semicolons and lines; trimmed and de-duplicated', () => {
    expect(parseSynonyms('sonography, US scan،  Sonography ;echo\n\n')).toEqual(['sonography', 'US scan', 'echo']);
    expect(parseSynonyms('')).toEqual([]);
  });
  it('form ↔ API body: empty optional fields become null (an edit can clear them)', () => {
    const body = termInputFrom({ ...EMPTY_TERM_FORM, term_en: "  McBurney's   point ", owner_preferred_ar: ' نقطة ماكبرني ' });
    expect(body).toEqual({ term_en: "McBurney's point", abbreviation: null, synonyms: [], explanation_ar: null, accepted_translation_ar: null, owner_preferred_ar: 'نقطة ماكبرني' });
    const form = termFormFrom({ term_en: 'Ultrasound', abbreviation: 'US', synonyms: ['sonography', 'echo'], explanation_ar: null, accepted_translation_ar: 'الأمواج فوق الصوتية', owner_preferred_ar: null });
    expect(form.synonyms).toBe('sonography، echo');
    expect(termInputFrom(form).synonyms).toEqual(['sonography', 'echo']);
  });
  it('validation: required term, length, duplicate (case-insensitive) except the term being edited', () => {
    const existing = [{ id: 't1', term_en: 'Ultrasound' }];
    expect(validateTermForm({ ...EMPTY_TERM_FORM }, existing).term_en).toMatch(/اكتب المصطلح/);
    expect(validateTermForm({ ...EMPTY_TERM_FORM, term_en: 'ultrasound' }, existing).term_en).toMatch(/موجود في قاموسك/);
    expect(validateTermForm({ ...EMPTY_TERM_FORM, term_en: 'ULTRASOUND' }, existing, 't1')).toEqual({});
    expect(validateTermForm({ ...EMPTY_TERM_FORM, term_en: 'CT', abbreviation: 'x'.repeat(41) }, existing).abbreviation).toBeTruthy();
  });
  it('local filter matches English, abbreviation, synonyms and Arabic (normalized)', () => {
    const t = { term_en: 'Ultrasound', abbreviation: 'US', synonyms: ['sonography'], explanation_ar: null, accepted_translation_ar: 'الأمواج فوق الصوتية', owner_preferred_ar: 'الإيكو' };
    expect(termMatches(t, '')).toBe(true);
    expect(termMatches(t, 'sono')).toBe(true);
    expect(termMatches(t, 'us')).toBe(true);
    expect(termMatches(t, 'الايكو')).toBe(true); // hamza-insensitive like search
    expect(termMatches(t, 'CT')).toBe(false);
  });
});

describe('explanation rules layers', () => {
  it('include toggles merge; other fields replace', () => {
    expect(mergeRulesPatch({ level: 'simple', include: { examples: false } }, { include: { memory_hooks: false } })).toEqual({ level: 'simple', include: { examples: false, memory_hooks: false } });
    expect(mergeRulesPatch(null, { template: 'surgery' })).toEqual({ template: 'surgery' });
  });
  it('says which layer decides a field', () => {
    const node = { node_id: 'n1', title: 'الجراحة', template_key: 'surgery', override: { level: 'expert' as const } };
    expect(ruleSourceAr('level', { owner: { level: 'simple' }, node })).toBe('خاص بـ «الجراحة»');
    expect(ruleSourceAr('template', { owner: null, node })).toBe('قالب المجلد «الجراحة»');
    expect(ruleSourceAr('keep_english_terms', { owner: { keep_english_terms: false }, node: null })).toBe('قواعدك العامة');
    expect(ruleSourceAr('dialect', { owner: null, node: null })).toBe('من الإعدادات');
    expect(ruleSourceAr('show_original_text', { owner: null, node: null })).toBe('الافتراضي');
  });
});
