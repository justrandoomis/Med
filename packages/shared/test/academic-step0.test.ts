// P1-T1 step 0 — shared contract seams for Wave 1 (BUILD_PLAN §3.2, ARCHITECTURE_DELTA §7.1, ADR-0005 §6):
// every Phase 1 error code and capability key (append-only), the `academic/` barrel with `visibility.ts`, the sync
// `detail_code` values and the client-version header name.
import { describe, expect, it } from 'vitest';
import * as shared from '../src';
import {
  ACADEMIC_ERROR_HTTP_STATUS,
  CHANNEL_KINDS,
  CHANNEL_ROLES,
  CLIENT_VERSION_HEADER_NAME,
  CONTENT_ORIGINS,
  ERROR_CODES,
  FEATURE_KEYS,
  LAYER_KINDS,
  PUBLICATION_VISIBILITIES,
  SYNC_DETAIL_CODES,
  VISIBILITIES,
  VISIBILITY_LABELS_AR,
  LAYER_KIND_LABELS_AR,
  CONTENT_ORIGIN_LABELS_AR,
  layerKindSchema,
  publicationVisibilitySchema,
  userRefSchema,
  visibilitySchema,
  type ErrorCode,
  type FeatureKey,
  type SyncOpResult,
} from '../src';
import * as academic from '../src/academic';

/** The lists as they stood at Round 7 — the new entries are appended after them, never inserted or renamed. */
const ROUND7_ERROR_CODES = [
  'BAD_REQUEST', 'VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'CONFLICT',
  'RATE_LIMITED', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_FORMAT', 'SETUP_REQUIRED', 'ALREADY_SET_UP',
  'AI_NOT_CONFIGURED', 'AI_BUDGET_EXCEEDED', 'AI_PROVIDER_ERROR', 'OUT_OF_SCOPE', 'INSUFFICIENT_EVIDENCE',
  'SCHEMA_REJECTED', 'INVALID_EVIDENCE', 'FEATURE_DISABLED', 'OFFLINE_REQUIRES_CONNECTION', 'INTERNAL',
];
const ROUND7_FEATURE_KEYS = [
  'library', 'upload', 'processing.pdf', 'processing.docx', 'processing.pptx', 'processing.images',
  'processing.zip', 'processing.legacy_office', 'processing.ocr', 'processing.vision',
  'workspace.reader', 'workspace.ink', 'workspace.handwriting_recognition', 'workspace.audio',
  'search.keyword', 'search.semantic', 'evidence.citations', 'ai.explain', 'ai.chat', 'ai.study_book',
  'ai.summaries', 'ai.figure_explain', 'ai.generate_questions', 'ai.grade_written', 'ai.cases', 'ai.answer_check',
  'external.evidence', 'external.images',
  'questions.vault', 'questions.extraction', 'questions.matching', 'exams',
  'flashcards', 'weakness', 'planner', 'exam_dna',
  'course_brain', 'knowledge_map', 'coverage_map',
  'sync', 'offline', 'backup', 'export.markdown', 'export.anki_tsv', 'export.pdf', 'export.docx',
];

/** ARCHITECTURE_DELTA §7.1, with the HTTP status of each code. */
const PHASE1_ERRORS: Record<string, number> = {
  MEMBERSHIP_REQUIRED: 403,
  MEMBERSHIP_PENDING: 403,
  LAYER_READ_ONLY: 409,
  PUBLICATION_FROZEN: 409,
  CONSENT_REQUIRED: 409,
  QUOTA_EXCEEDED: 409,
  JOIN_CODE_INVALID: 400,
  SPACE_UNAVAILABLE: 503,
  CLIENT_TOO_OLD: 426,
  LOGIN_SLOWED: 429,
  NO_TENANT_BOUND: 500,
};
/** ADR-0005 §6. */
const PHASE1_FEATURE_KEYS = ['rooms.online', 'nearby.webrtc', 'nearby.lan_hub', 'nearby.native', 'nearby.relay', 'ink.native_surface', 'recording.background', 'ui.eink_mode'];

/** apps/server/test/acceptance/g1-ac01.test.ts: no capability key may name an institution / users / roles concept. */
const G1_FORBIDDEN = /user|member|role|tenant|organi[sz]ation|universit|faculty|college|subscri|billing|pricing|payment|cohort|invit|admin|team|seat|account/i;

describe('error codes (append-only)', () => {
  it('keeps every Round 7 code in place and appends each Phase 1 code once', () => {
    expect(ERROR_CODES.slice(0, ROUND7_ERROR_CODES.length)).toEqual(ROUND7_ERROR_CODES);
    expect(ERROR_CODES.slice(ROUND7_ERROR_CODES.length)).toEqual(Object.keys(PHASE1_ERRORS));
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('states the HTTP status of every new code (ARCHITECTURE_DELTA §7.1)', () => {
    expect(ACADEMIC_ERROR_HTTP_STATUS).toEqual(PHASE1_ERRORS);
    const typed: Record<string, number> = ACADEMIC_ERROR_HTTP_STATUS satisfies Partial<Record<ErrorCode, number>>;
    expect(Object.keys(typed)).toHaveLength(11);
  });
});

describe('capability keys (append-only)', () => {
  it('keeps every Round 7 key in place and appends the ADR-0005 §6 keys once', () => {
    expect(FEATURE_KEYS.slice(0, ROUND7_FEATURE_KEYS.length)).toEqual(ROUND7_FEATURE_KEYS);
    expect(FEATURE_KEYS.slice(ROUND7_FEATURE_KEYS.length)).toEqual(PHASE1_FEATURE_KEYS);
    expect(new Set(FEATURE_KEYS).size).toBe(FEATURE_KEYS.length);
  });

  it('no key trips the single-owner vocabulary check of AC-01 (g1-ac01)', () => {
    expect(FEATURE_KEYS.filter((k) => G1_FORBIDDEN.test(k))).toEqual([]);
    const k: FeatureKey = 'ui.eink_mode';
    expect(k).toBe('ui.eink_mode');
  });
});

describe('academic/ barrel and visibility.ts (ARCHITECTURE_DELTA §7.1)', () => {
  it('is re-exported from the package root', () => {
    for (const name of Object.keys(academic)) expect((shared as Record<string, unknown>)[name], name).toBe((academic as Record<string, unknown>)[name]);
    expect(Object.keys(academic).length).toBeGreaterThan(0);
  });

  it('defines the visibility scopes, channel kinds and roles, layer kinds and content origins of §7.1', () => {
    expect(VISIBILITIES).toEqual(['private', 'specific_users', 'followers', 'course', 'public']);
    expect(PUBLICATION_VISIBILITIES).toEqual(['specific_users', 'followers', 'course', 'public']);
    expect(CHANNEL_KINDS).toEqual(['university', 'college', 'department', 'stage', 'academic_year', 'course', 'subject']);
    expect(CHANNEL_ROLES).toEqual(['admin', 'assistant', 'subject_moderator', 'contributor']);
    expect(LAYER_KINDS).toEqual(['personal', 'explanation', 'answers', 'published_snapshot', 'followed', 'forked', 'group_comments', 'suggestion', 'collaborative']);
    expect(CONTENT_ORIGINS).toEqual(['source', 'lecturer_said', 'generated', 'external_reference', 'student_contribution', 'moderator_reviewed', 'my_notes']);
  });

  it('has an Arabic label for every visibility, layer kind and content origin (no bidi control characters stored)', () => {
    const BIDI = /[‎‏‪-‮⁦-⁩]/;
    for (const map of [VISIBILITY_LABELS_AR, LAYER_KIND_LABELS_AR, CONTENT_ORIGIN_LABELS_AR]) {
      for (const [k, v] of Object.entries(map)) {
        expect(v, k).toMatch(/[؀-ۿ]/);
        expect(BIDI.test(v), k).toBe(false);
      }
    }
    expect(Object.keys(VISIBILITY_LABELS_AR)).toEqual([...VISIBILITIES]);
    expect(Object.keys(LAYER_KIND_LABELS_AR)).toEqual([...LAYER_KINDS]);
    expect(Object.keys(CONTENT_ORIGIN_LABELS_AR)).toEqual([...CONTENT_ORIGINS]);
  });

  it('validates with zod: a publication is never private; a user ref carries no e-mail or other private field', () => {
    expect(visibilitySchema.parse('private')).toBe('private');
    expect(publicationVisibilitySchema.safeParse('private').success).toBe(false);
    expect(publicationVisibilitySchema.parse('course')).toBe('course');
    expect(layerKindSchema.safeParse('official').success).toBe(false);
    const ref = userRefSchema.parse({ id: 'u1', display_name: 'سارة', avatar_url: null, email: 'x@example.com' });
    expect(ref).toEqual({ id: 'u1', display_name: 'سارة', avatar_url: null });
    expect(userRefSchema.parse({ id: 'u2', display_name: 'طالب', avatar_url: null, former: true }).former).toBe(true);
  });
});

describe('sync and client-version seams (ARCHITECTURE_DELTA §8.2, §4.5)', () => {
  it('lists the optional detail codes a push result may carry; old clients ignore them', () => {
    expect(SYNC_DETAIL_CODES).toEqual(['layer_read_only', 'layer_forbidden', 'use_crdt', 'device_unknown', 'op_id_taken', 'not_a_member', 'quota_exceeded']);
    const r: SyncOpResult = { op_id: 'o', result: 'rejected', detail_code: 'layer_read_only' };
    expect(r.detail_code).toBe('layer_read_only');
  });

  it('names the client-version request header', () => {
    expect(CLIENT_VERSION_HEADER_NAME).toBe('x-medlevo-client');
  });
});
