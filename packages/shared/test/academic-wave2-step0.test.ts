// Wave-2 step 0 — the contracts of P1-T4 (channels, notifications, moderation) and P1-T5 (official lectures, copies,
// publications), reviewed together before either track builds (BUILD_PLAN §1.1 «Contract first», §3.6/§3.7 step 0;
// ARCHITECTURE_DELTA §7). Types and zod schemas only. This test:
//   * round-trips EVERY exported zod schema of the six files (a schema without a fixture fails the test), and
//     requires `parse(parse(x)) = parse(x)` so a parsed value is always a valid input again (no lossy transforms);
//   * checks the Phase 1 limits the PRD sets (course-only publications, reports on publications, hide / restore /
//     dismiss, no collaborative copy yet) so a later-phase value cannot slip through the contract;
//   * checks that free text refuses bidi control characters (AC-20) and that a notification payload cannot carry
//     anything but titles and counts (ARCHITECTURE_DELTA §12);
//   * checks that every Arabic label map covers its enum, and that the barrel re-exports every new name.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as shared from '../src';
import * as academic from '../src/academic';
import * as channels from '../src/academic/channels-api';
import * as notifications from '../src/academic/notifications-api';
import * as moderation from '../src/academic/moderation-api';
import * as lectures from '../src/academic/lectures-api';
import * as copies from '../src/academic/copies-api';
import * as publications from '../src/academic/publications-api';

const MODULES = { channels, notifications, moderation, lectures, copies, publications } as const;

const ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';
const ID2 = '01JABCDEFGHJKMNPQRSTVWXYZ1';
const RLO = '\u202e';
const LRI = '\u2066';

/** valid inputs (each must parse and round-trip) and invalid inputs (each must be refused), per exported schema */
const FIXTURES: Record<string, { valid: unknown[]; invalid: unknown[] }> = {
  // ───────── channels-api (P1-T4) ─────────
  cursorPageQuerySchema: {
    valid: [{}, { limit: 100 }, { limit: '5', cursor: 'eyJrIjoxfQ' }],
    invalid: [{ limit: 0 }, { limit: 101 }, { cursor: 'not base64url!' }],
  },
  entityIdSchema: { valid: [ID, 'a', 'node_1-x'], invalid: ['', 'a b', 'x'.repeat(65), '../etc'] },
  isoDateSchema: { valid: ['2026-10-21', '2024-02-29'], invalid: ['2026-13-01', '2025-02-29', '21-10-2026', '2026-1-1'] },
  joinPolicySchema: { valid: ['closed', 'approval', 'open_with_code'], invalid: ['open', ''] },
  channelTreeQuerySchema: { valid: [{}, { root: ID, depth: 3 }, { depth: '7' }], invalid: [{ depth: 0 }, { depth: 8 }, { root: 'a b' }] },
  createChannelNodeSchema: {
    valid: [
      { parent_id: null, kind: 'university', title: 'جامعة بغداد' },
      { parent_id: ID, kind: 'subject', title: 'التشريح', title_en: 'Anatomy', ordinal: 2, create_space: true, join_policy: 'approval' },
      { parent_id: ID, kind: 'academic_year', title: '2026–2027', starts_on: '2026-09-01', ends_on: '2027-06-30' },
    ],
    invalid: [
      { parent_id: null, kind: 'lecture', title: 'x' },
      { parent_id: null, kind: 'university', title: '' },
      { parent_id: null, kind: 'university', title: `جامعة ${RLO}بغداد` },
      { parent_id: ID, kind: 'course', title: 'مقرر', starts_on: '2027-01-01', ends_on: '2026-01-01' },
      { parent_id: null, kind: 'university', title: 'x', unknown_field: 1 },
    ],
  },
  patchChannelNodeSchema: {
    valid: [{ title: 'كلية الطب' }, { parent_id: ID, ordinal: null }, { join_policy: 'closed', title_en: null }],
    invalid: [{}, { title: '' }, { kind: 'college' }],
  },
  archiveChannelNodeSchema: { valid: [{ preview: true }, { preview: false }], invalid: [{}, { preview: 'yes' }] },
  joinWithCodeSchema: { valid: [{ code: 'ABCD-EFGH' }, { code: ' abcd efgh ' }], invalid: [{ code: '' }, { code: 'x'.repeat(65) }, {}] },
  joinWithLinkSchema: { valid: [{ token: 'tok_abcdefghijklmnop1234' }], invalid: [{ token: 'short' }, { token: 'has space in it 12345' }] },
  joinPreviewQuerySchema: { valid: [{ token: 'tok_abcdefghijklmnop1234' }], invalid: [{}, { token: '<script>' }] },
  joinProofSchema: {
    valid: [{ code: 'ABCD-EFGH' }, { invite_token: 'tok_abcdefghijklmnop1234' }],
    // an invitation is for an existing account and its id is no secret (review W2-step0 R3)
    invalid: [{}, { code: 'ABCD', invite_token: 'tok_abcdefghijklmnop1234' }, { password: 'x' }, { invitation_id: ID }],
  },
  registerWithJoinSchema: {
    valid: [{ username: 'zainab.k', display_name: 'زينب', password: 'correct horse battery', join: { code: 'ABCD-EFGH' } }],
    invalid: [
      { username: 'zainab k', display_name: 'زينب', password: 'p', join: { code: 'ABCD-EFGH' } },
      { username: 'zainab', display_name: 'زينب', password: 'p' },
      { username: 'zainab', display_name: `زينب${LRI}`, password: 'p', join: { code: 'ABCD-EFGH' } },
    ],
  },
  membersQuerySchema: { valid: [{}, { status: 'pending', limit: 50 }], invalid: [{ status: 'banned' }] },
  memberDecisionSchema: {
    valid: [{ decision: 'approve' }, { decision: 'reject', reason: 'الرمز لا يخص هذه المرحلة.' }, { decision: 'remove', reason: 'تخرّج' }],
    invalid: [{ decision: 'ban' }, { decision: 'reject', reason: `سبب${RLO}` }],
  },
  createInvitationsSchema: { valid: [{ user_ids: [ID] }, { user_ids: [ID, ID2] }], invalid: [{ user_ids: [] }, { user_ids: [ID, ID] }] },
  invitationDecisionSchema: { valid: [{ accept: true }, { accept: false }], invalid: [{}, { accept: 'yes' }] },
  // (C2, AOS-18.5) the invitations sent into a node, and the person picker
  nodeInvitationsQuerySchema: { valid: [{}, { status: 'pending' }, { status: 'revoked' }], invalid: [{ status: 'lost' }, { other: 1 }] },
  inviteeSearchQuerySchema: { valid: [{ q: 'زي' }, { q: 'zainab_ali' }, { q: '  noor  ' }], invalid: [{}, { q: 'z' }, { q: 'x'.repeat(65) }, { q: 'ab', extra: 1 }] },
  createJoinCodeSchema: {
    valid: [
      { kind: 'class_code', expires_in_hours: 72, requires_approval: true },
      { kind: 'invite_link', expires_in_hours: 1, max_uses: 40, requires_approval: false },
    ],
    invalid: [
      { kind: 'class_code', expires_in_hours: 0, requires_approval: true },
      { kind: 'class_code', expires_in_hours: 24 * 366, requires_approval: true },
      { kind: 'qr', expires_in_hours: 1, requires_approval: true },
      { kind: 'class_code', expires_in_hours: 1, max_uses: 0, requires_approval: true },
    ],
  },
  assignRoleSchema: { valid: [{ user_id: ID, role: 'subject_moderator' }], invalid: [{ user_id: ID, role: 'student' }, { user_id: ID, role: 'platform_admin' }] },
  courseFollowSchema: {
    valid: [{ add_new_lectures: true }, { add_new_lectures: false, library_folder_id: ID }, { add_new_lectures: true, library_folder_id: null }],
    invalid: [{}, { add_new_lectures: 'true' }],
  },

  // ───────── notifications-api (P1-T4) ─────────
  notificationKindSchema: { valid: ['join_decided', 'official_version', 'publication_updated', 'moderation'], invalid: ['mention', 'room_invite', 'reply'] },
  notificationContentSchema: {
    valid: [
      { kind: 'join_requested', payload: { node_title: 'التشريح', pending_count: 3 } },
      { kind: 'join_decided', payload: { node_title: 'التشريح', decision: 'approved' } },
      { kind: 'invitation', payload: { node_title: 'المرحلة الثالثة' } },
      { kind: 'official_lecture_new', payload: { subject_title: 'التشريح', lecture_title: 'المحاضرة 5', lecture_no: 5 } },
      { kind: 'official_version', payload: { subject_title: 'التشريح', lecture_title: 'المحاضرة 5', version_no: 2 } },
      { kind: 'subject_update', payload: { subject_title: 'التشريح', event_kind: 'exam_date_changed', title: 'الامتحان النهائي' } },
      { kind: 'publication_updated', payload: { publication_title: 'شرح حسن', version_no: 2, added: 6, removed: 1, changed: 1 } },
      { kind: 'moderation', payload: { target_title: 'شرح حسن', action: 'hide', reason_ar: 'محتوى غير دقيق', as: 'author' } },
      { kind: 'report_received', payload: { subject_title: 'التشريح', target_title: 'شرح حسن', reason: 'wrong_content', open_reports: 1 } },
      { kind: 'reanchor_ready', payload: { lecture_title: 'المحاضرة 5', copied: 2, needs_review: 1, kept: 0 } },
      { kind: 'quota_warning', payload: { quota: 'storage', percent: 80 } },
    ],
    invalid: [
      // private text never rides along: unknown payload keys are refused, not stripped silently
      { kind: 'official_version', payload: { subject_title: 'x', lecture_title: 'y', version_no: 2, note_text: 'ملاحظتي الخاصة' } },
      { kind: 'publication_updated', payload: { publication_title: 'x', version_no: 2, added: -1, removed: 0, changed: 0 } },
      { kind: 'quota_warning', payload: { quota: 'storage', percent: 50 } },
      { kind: 'reply', payload: {} },
      { kind: 'join_requested', payload: { node_title: 'x'.repeat(201) } },
    ],
  },
  notificationsQuerySchema: { valid: [{}, { unread: true }, { unread: 'false', limit: '20' }], invalid: [{ unread: 'maybe' }] },
  markNotificationsReadSchema: { valid: [{ ids: [ID] }, { all: true }], invalid: [{ ids: [] }, { all: false }, {}] },
  putNotificationPrefsSchema: {
    valid: [{ prefs: [{ kind: 'official_version', channel: 'in_app', enabled: true }, { kind: 'moderation', channel: 'push', enabled: false }] }],
    invalid: [{ prefs: [] }, { prefs: [{ kind: 'official_version', channel: 'email', enabled: true }] }],
  },
  pushSubscriptionSchema: {
    valid: [{ endpoint: 'https://push.example.org/send/abc', keys: { p256dh: 'BOr_abc-123', auth: 'xyz_12-3' } }],
    invalid: [{ endpoint: 'http://push.example.org/x', keys: { p256dh: 'a', auth: 'b' } }, { endpoint: 'https://p.example/x', keys: { p256dh: 'a b', auth: 'b' } }],
  },
  deletePushSubscriptionSchema: { valid: [{ endpoint: 'https://push.example.org/send/abc' }], invalid: [{ endpoint: 'javascript:alert(1)' }] },

  // ───────── moderation-api (P1-T4) ─────────
  reportReasonSchema: { valid: ['patient_identifiers', 'copyright', 'wrong_content'], invalid: ['dislike'] },
  moderationTargetSchema: {
    valid: [{ db: 'system', type: 'publication', id: ID }, { db: ID2, type: 'publication_version', id: ID }],
    invalid: [{ db: 'system', type: 'discussion_post', id: ID }, { db: 'system', type: 'profile', id: ID }, { db: 'a b', type: 'publication', id: ID }],
  },
  createReportSchema: {
    valid: [
      { target: { db: 'system', type: 'publication', id: ID }, reason: 'wrong_content' },
      { target: { db: 'system', type: 'publication', id: ID }, reason: 'patient_identifiers', note: 'في الصفحة 3 اسم مريض\nوصورة أشعة' },
    ],
    invalid: [{ target: { db: 'system', type: 'publication', id: ID }, reason: 'meh' }, { target: { db: 'system', type: 'publication', id: ID }, reason: 'other', note: `x${RLO}` }],
  },
  reportQueueQuerySchema: { valid: [{ scope_node_id: ID }, { scope_node_id: ID, status: 'open', limit: 10 }], invalid: [{}, { scope_node_id: ID, status: 'closed' }] },
  moderationActionSchema: {
    valid: [
      { report_id: ID, action: 'hide', reason_ar: 'يحتوي معرّفات مريض.' },
      { target: { db: 'system', type: 'publication', id: ID }, action: 'restore', reason_ar: 'أُزيلت المعرّفات.' },
      { report_id: ID, action: 'dismiss', reason_ar: 'لا مخالفة.' },
    ],
    invalid: [
      { report_id: ID, action: 'mark_reviewed', reason_ar: 'x' },
      { report_id: ID, action: 'suspend_user', reason_ar: 'سبب' },
      { action: 'hide', reason_ar: 'بلا هدف' },
      { report_id: ID, action: 'hide', reason_ar: '' },
    ],
  },
  auditQuerySchema: { valid: [{ scope_node_id: ID }, { scope_node_id: ID, action: 'membership_decide', cursor: 'abc' }], invalid: [{}, { scope_node_id: ID, action: 'DROP TABLE' }] },

  // ───────── lectures-api (P1-T5) ─────────
  officialLecturesQuerySchema: { valid: [{}, { status: 'draft' }, { status: 'published', limit: 30 }], invalid: [{ status: 'deleted' }] },
  createOfficialLectureSchema: {
    valid: [{ title: 'المحاضرة الخامسة — البطن' }, { id: ID, title: 'Lecture 5', lecture_no: 5, held_on: '2026-10-20' }, { title: 'x', lecture_no: null, held_on: null }],
    invalid: [{ title: '' }, { title: 'x', lecture_no: 0 }, { title: `x${RLO}` }, { title: 'x', held_on: '2026-02-30' }],
  },
  patchOfficialLectureSchema: {
    valid: [{ lecture_no: 6 }, { title: 'المحاضرة السادسة', held_on: null }, { lecture_no: null }],
    invalid: [{}, { status: 'published' }, { lecture_no: 0 }, { title: `x${RLO}` }],
  },
  uploadOfficialVersionSchema: { valid: [{ upload_id: ID }], invalid: [{}, { upload_id: '' }] },
  approveOfficialLectureSchema: { valid: [{}], invalid: [{ force: true }] },
  publishOfficialVersionSchema: {
    valid: [{}, { change_note: 'أُضيفت صفحتان بعد الصفحة 10.' }, { change_note: null, preview: true }],
    invalid: [{ change_note: 'x'.repeat(1001) }, { notify: false }],
  },
  officialPageMapDecisionsSchema: {
    valid: [{ from_version_id: ID, to_version_id: ID2, decisions: [{ from_page_id: ID, action: 'confirm', to_page_id: ID2 }, { from_page_id: ID2, action: 'reject' }] }],
    invalid: [{ from_version_id: ID, to_version_id: ID, decisions: [{ from_page_id: ID, action: 'confirm' }] }, { from_version_id: ID, to_version_id: ID2, decisions: [] }],
  },
  withdrawOfficialLectureSchema: {
    valid: [{ reason: 'rights_takedown', note_ar: 'طلب صاحب الحقوق سحب الملف.' }, { reason: 'replaced', note_ar: 'استُبدلت بالمحاضرة 6.' }],
    invalid: [{ reason: 'boring', note_ar: 'x' }, { reason: 'error', note_ar: '' }],
  },
  officialCorrectionSchema: {
    valid: [{ version_id: ID, items: [{ region_id: ID2, text: 'الشريان الكلوي الأيمن' }] }, { version_id: ID, items: [{ region_id: ID2, text: '' }], note: 'حذف سطر مكرر' }],
    invalid: [{ version_id: ID, items: [] }, { version_id: ID, items: [{ region_id: ID2, text: 'x'.repeat(25_001) }] }],
  },
  lectureFromVaultSchema: { valid: [{ source_id: ID, title: 'المحاضرة 5' }, { source_id: ID, title: 'x', lecture_no: 5 }], invalid: [{ source_id: ID }, { source_id: ID, title: 'x', lecture_no: -1 }] },
  subjectAttachmentKindSchema: { valid: ['summary', 'previous_exam', 'reference', 'other'], invalid: ['slides'] },
  createSubjectAttachmentSchema: {
    valid: [{ kind: 'previous_exam', title: 'أسئلة 2025', upload_id: ID }, { kind: 'summary', title: 'ملخص', upload_id: ID, lecture_id: ID2 }],
    invalid: [{ kind: 'summary', title: '', upload_id: ID }, { kind: 'summary', title: 'x' }],
  },
  patchSubjectAttachmentSchema: { valid: [{ status: 'published' }, { status: 'withdrawn' }], invalid: [{ status: 'draft' }, {}] },
  putSubjectExamDateSchema: {
    valid: [{ title: 'الامتحان النهائي — الدور الأول', exam_on: '2027-01-15' }, { title: 'نصف الفصل', exam_on: '2026-11-30', starts_at: '09:30', lecture_ids: [ID, ID2] }],
    invalid: [{ title: 'x', exam_on: '2027-01-15', starts_at: '25:00' }, { title: 'x', exam_on: 'tomorrow' }],
  },
  subjectEventsQuerySchema: { valid: [{}, { cursor: 'MTIz', limit: 10 }], invalid: [{ limit: 1000 }] },
  // (C2, AOS-3.18) the subject's review queue: a moderator's decision
  decideSubjectReviewSchema: { valid: [{ action: 'accept' }, { action: 'reject' }], invalid: [{}, { action: 'maybe' }, { action: 'accept', note: 'x' }] },
  // P1-T5 step 1 additions (additive): the corrections queue, its decision, the attachment multipart fields
  officialCorrectionsQuerySchema: { valid: [{}, { status: 'open' }, { status: 'applied', lecture_id: ID }], invalid: [{ status: 'pending' }, { lecture_id: '' }] },
  decideOfficialCorrectionSchema: {
    valid: [{ decision: 'accept' }, { decision: 'reject', note_ar: 'النص الأصلي صحيح.' }],
    invalid: [{}, { decision: 'maybe' }, { decision: 'reject', note_ar: `x${RLO}` }],
  },
  createSubjectAttachmentFieldsSchema: {
    valid: [{ kind: 'summary', title: 'ملخص المحاضرة 5' }, { kind: 'previous_exam', title: 'أسئلة 2025', lecture_id: ID }],
    invalid: [{ kind: 'summary', title: '' }, { kind: 'summary', title: 'x', upload_id: ID }],
  },

  // ───────── copies-api (P1-T5) ─────────
  copyModeSchema: { valid: ['personal', 'independent_fork', 'followed', 'collaborative'], invalid: ['fork'] },
  copyUpdatePolicySchema: { valid: ['preview', 'auto'], invalid: ['never'] },
  startStudyingSchema: {
    valid: [
      { id: ID, space_id: ID2, lecture_id: ID, mode: 'personal' },
      { id: ID, space_id: ID2, lecture_id: ID, mode: 'followed', publication_id: ID2, library_folder_id: ID },
      { id: ID, space_id: ID2, lecture_id: ID, mode: 'independent_fork', publication_id: ID2, version_no: 1, carry_personal_from_copy_id: ID2 },
    ],
    invalid: [
      { id: ID, space_id: ID2, lecture_id: ID, mode: 'collaborative' },
      { id: ID, space_id: ID2, lecture_id: ID, mode: 'followed' },
      { id: ID, space_id: ID2, lecture_id: ID, mode: 'personal', publication_id: ID2 },
      { id: ID, space_id: ID2, lecture_id: ID, mode: 'followed', publication_id: ID2, version_no: 1 },
    ],
  },
  documentCopiesQuerySchema: { valid: [{}, { source_id: ID }, { space_id: ID, lecture_id: ID2 }], invalid: [{ lecture_id: ID2 }] },
  patchDocumentCopySchema: { valid: [{ update_policy: 'auto' }, { reanchor_policy: 'preview' }], invalid: [{}, { mode: 'personal' }] },
  applyUpstreamSchema: { valid: [{ version_no: 2 }, { version_no: 3, skip: true }], invalid: [{ version_no: 0 }, {}] },
  linkCandidatesQuerySchema: { valid: [{ source_id: ID }], invalid: [{}] },
  // (C2, AOS-19H.3 / 19H.1) the library rows' link status; one lecture identity's links
  linkStatusQuerySchema: { valid: [{ source_ids: ID }, { source_ids: `${ID},${ID2}` }, { source_ids: `${ID}, ${ID}` }], invalid: [{}, { source_ids: '' }, { source_ids: 'a b' }, { source_ids: Array.from({ length: 31 }, (_, i) => `id${i}`).join(',') }] },
  lectureIdentityQuerySchema: { valid: [{ space_id: ID, lecture_id: ID2 }], invalid: [{}, { space_id: ID }, { space_id: "x'", lecture_id: ID }] },
  linkToOfficialSchema: {
    valid: [{ id: ID, source_id: ID2, space_id: ID, lecture_id: ID2, to_version_id: ID }],
    invalid: [{ id: ID, source_id: ID2, space_id: ID, lecture_id: ID2 }],
  },

  // ───────── publications-api (P1-T5) ─────────
  publicationStatusSchema: { valid: ['active', 'hidden_by_moderator', 'withdrawn', 'author_deleted'], invalid: ['draft'] },
  publishRequestSchema: {
    valid: [
      { lecture_id: ID, layer_ids: [ID2], title: 'شرحي للمحاضرة 5', kind: 'explanation', visibility: 'course' },
      { lecture_id: ID, layer_ids: [ID2], note_page_ids: [ID], title: 'شرح', summary: 'الصفحات 1–3', kind: 'explanation', visibility: 'course' },
    ],
    invalid: [
      { lecture_id: ID, layer_ids: [ID2], title: 'x', kind: 'explanation', visibility: 'public' },
      { lecture_id: ID, layer_ids: [ID2], title: 'x', kind: 'explanation', visibility: 'private' },
      { lecture_id: ID, layer_ids: [ID2], title: 'x', kind: 'voice_explanation', visibility: 'course' },
      { lecture_id: ID, layer_ids: [], title: 'x', kind: 'explanation', visibility: 'course' },
      { lecture_id: ID, layer_ids: [ID2], title: 'x', kind: 'explanation', visibility: 'course', grantees: [ID] },
    ],
  },
  republishSchema: { valid: [{ layer_ids: [ID], change_note: 'نقلت خطًا وأضفت 6 خطوط في الصفحة 4.' }, { layer_ids: [ID], change_note: null }], invalid: [{ layer_ids: [] }, { layer_ids: [ID], change_note: `x${RLO}` }] },
  patchPublicationSchema: { valid: [{ title: 'شرح جديد' }, { summary: null }], invalid: [{}, { visibility: 'public' }] },
  withdrawPublicationSchema: { valid: [{}], invalid: [{ reason: 'x' }] },
  lecturePublicationsQuerySchema: { valid: [{}, { limit: 10 }], invalid: [{ sort: 'top_rated' }] },
  publicationItemsQuerySchema: { valid: [{}, { page_id: ID }], invalid: [{ page_id: 'a b' }] },
  publicationDiffQuerySchema: { valid: [{ from: 1, to: 2 }, { from: '1', to: '3' }], invalid: [{ from: 2, to: 2 }, { from: 0, to: 1 }] },
};

function schemasOf(mod: Record<string, unknown>): Array<[string, z.ZodType]> {
  return Object.entries(mod).filter((e): e is [string, z.ZodType] => e[1] instanceof z.ZodType);
}

describe('every exported schema round-trips', () => {
  for (const [modName, mod] of Object.entries(MODULES)) {
    const schemas = schemasOf(mod as Record<string, unknown>);
    it(`${modName}: exports schemas, and each has a fixture`, () => {
      expect(schemas.length).toBeGreaterThan(0);
      expect(schemas.map(([n]) => n).filter((n) => !FIXTURES[n])).toEqual([]);
    });
    for (const [name, schema] of schemas) {
      it(`${modName}.${name}: valid inputs parse and round-trip; invalid inputs are refused`, () => {
        const f = FIXTURES[name]!;
        expect(f.valid.length).toBeGreaterThan(0);
        expect(f.invalid.length).toBeGreaterThan(0);
        for (const v of f.valid) {
          const r = schema.safeParse(v);
          expect(r.success, `${name} should accept ${JSON.stringify(v)}: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
          const out = r.data;
          // a parsed value is a valid input again (idempotent), also after the JSON wire
          expect(schema.parse(out), name).toEqual(out);
          expect(schema.parse(JSON.parse(JSON.stringify(out))), name).toEqual(out);
        }
        for (const v of f.invalid) expect(schema.safeParse(v).success, `${name} should refuse ${JSON.stringify(v)}`).toBe(false);
      });
    }
  }
  it('has no fixture for a schema that does not exist', () => {
    const all = new Set(Object.values(MODULES).flatMap((m) => schemasOf(m as Record<string, unknown>).map(([n]) => n)));
    expect(Object.keys(FIXTURES).filter((n) => !all.has(n))).toEqual([]);
  });
});

describe('barrel', () => {
  it('re-exports every name of the six wave-2 contracts from academic/ and the package root', () => {
    for (const mod of Object.values(MODULES)) {
      for (const [name, value] of Object.entries(mod)) {
        expect((academic as Record<string, unknown>)[name], name).toBe(value);
        expect((shared as Record<string, unknown>)[name], name).toBe(value);
      }
    }
  });
});

describe('§7.1 conventions', () => {
  it('cursor pages default to 30 and cap at 100', () => {
    expect(channels.cursorPageQuerySchema.parse({})).toEqual({ limit: channels.CURSOR_PAGE_DEFAULT_LIMIT });
    expect(channels.CURSOR_PAGE_DEFAULT_LIMIT).toBe(30);
    expect(channels.CURSOR_PAGE_MAX_LIMIT).toBe(100);
  });

  it('free text refuses every bidi control character and keeps Arabic with English runs (AC-20)', () => {
    const title = channels.plainTextSchema({ max: 120, field_ar: 'العنوان' });
    expect(title.parse('  شرح Anatomy للمحاضرة 5  ')).toBe('شرح Anatomy للمحاضرة 5');
    for (const c of ['\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069']) {
      expect(title.safeParse(`شرح${c}Anatomy`).success, c.codePointAt(0)!.toString(16)).toBe(false);
    }
    expect(title.safeParse('سطر\nسطر').success).toBe(false);
    expect(channels.plainTextSchema({ max: 500, field_ar: 'الملاحظة', multiline: true }).parse('سطر\nسطر')).toBe('سطر\nسطر');
    expect(title.safeParse('a\u0007b').success).toBe(false);
  });

  it('groups under 5 people are reported as «أقل من 5», never as a number', () => {
    expect(channels.MIN_GROUP_SIZE).toBe(5);
    expect(channels.groupCount(0)).toEqual({ value: 0, label_ar: '0' });
    expect(channels.groupCount(3)).toEqual({ value: null, label_ar: 'أقل من 5' });
    expect(channels.groupCount(5)).toEqual({ value: 5, label_ar: '5' });
  });
});

describe('channels (P1-T4)', () => {
  it('kinds strictly descend University → … → Subject; levels may be skipped', () => {
    expect(channels.isDescendingKind('university', 'college')).toBe(true);
    expect(channels.isDescendingKind('university', 'subject')).toBe(true);
    expect(channels.isDescendingKind('subject', 'course')).toBe(false);
    expect(channels.isDescendingKind('stage', 'stage')).toBe(false);
  });

  it('normalises a typed join code the way it is hashed (case, spaces, dashes, Arabic-Indic digits)', () => {
    expect(channels.normalizeJoinCode(' abcd-ef\u0662\u0663 ')).toBe('ABCDEF23');
    expect(channels.normalizeJoinCode('AB CD\u00a0EF\u06f45')).toBe('ABCDEF45');
  });

  it('has Arabic labels for every kind, role, join policy and membership status', () => {
    expectLabels(shared.CHANNEL_KINDS, channels.CHANNEL_KIND_LABELS_AR);
    expectLabels(shared.CHANNEL_ROLES, channels.CHANNEL_ROLE_LABELS_AR);
    expectLabels(channels.JOIN_POLICIES, channels.JOIN_POLICY_LABELS_AR);
    expectLabels(channels.MEMBERSHIP_STATUSES, channels.MEMBERSHIP_STATUS_LABELS_AR);
    expect(channels.CHANNEL_ROLE_LABELS_AR.subject_moderator).toBe('مشرف المادة');
  });
});

describe('notifications (P1-T4)', () => {
  it('lists the Phase 1 kinds of ARCHITECTURE_DELTA §12 only, each with an Arabic label and a payload schema', () => {
    expect([...notifications.NOTIFICATION_KINDS]).toEqual([
      'join_requested', 'join_decided', 'invitation', 'official_lecture_new', 'official_version', 'subject_update',
      'publication_updated', 'moderation', 'report_received', 'reanchor_ready', 'quota_warning',
    ]);
    expectLabels(notifications.NOTIFICATION_KINDS, notifications.NOTIFICATION_KIND_LABELS_AR);
    const kinds = notifications.NOTIFICATION_KINDS.map((k) => notifications.notificationContentSchema.safeParse({ kind: k, payload: {} }));
    // every kind has its own payload shape (an empty payload is never enough)
    expect(kinds.every((r) => !r.success)).toBe(true);
  });

  it('a subject_update names a real subject_event kind (lectures-api.ts), and a report_received a real report reason', () => {
    for (const k of lectures.SUBJECT_EVENT_KINDS) {
      const ok = notifications.notificationContentSchema.safeParse({ kind: 'subject_update', payload: { subject_title: 'م', event_kind: k, title: 'ع' } }).success;
      // new lectures and versions have their own kinds (official_lecture_new / official_version); the rest go through subject_update
      expect(ok, k).toBe(!['lecture_published', 'version_published'].includes(k));
    }
    for (const r of moderation.REPORT_REASONS) {
      const p = { subject_title: 'م', target_title: 'ش', reason: r, open_reports: 1 };
      expect(notifications.notificationContentSchema.safeParse({ kind: 'report_received', payload: p }).success, r).toBe(true);
    }
  });

  it('fans out in batches of 500 and bounds payload titles', () => {
    expect(notifications.NOTIFICATION_BATCH_SIZE).toBe(500);
    expect(notifications.NOTIFICATION_TITLE_MAX).toBe(200);
  });
});

describe('moderation (P1-T4)', () => {
  it('Phase 1: reports on publications only; actions hide / restore / dismiss; reasons include patient identifiers and copyright', () => {
    expect([...moderation.REPORT_TARGET_TYPES_PHASE1]).toEqual(['publication', 'publication_version']);
    expect([...moderation.MODERATION_ACTIONS_PHASE1]).toEqual(['hide', 'restore', 'dismiss']);
    expect(moderation.REPORT_REASONS).toContain('patient_identifiers');
    expect(moderation.REPORT_REASONS).toContain('copyright');
    for (const t of moderation.REPORT_TARGET_TYPES_PHASE1) expect(moderation.REPORT_TARGET_TYPES).toContain(t);
    for (const a of moderation.MODERATION_ACTIONS_PHASE1) expect(moderation.MODERATION_ACTIONS).toContain(a);
    expectLabels(moderation.REPORT_REASONS, moderation.REPORT_REASON_LABELS_AR);
    expectLabels(moderation.MODERATION_ACTIONS, moderation.MODERATION_ACTION_LABELS_AR);
    expectLabels(moderation.REPORT_STATUSES, moderation.REPORT_STATUS_LABELS_AR);
  });
});

describe('official lectures (P1-T5)', () => {
  it('has Arabic labels for statuses, withdrawal reasons, attachment kinds and subject events', () => {
    expectLabels(lectures.OFFICIAL_LECTURE_STATUSES, lectures.OFFICIAL_LECTURE_STATUS_LABELS_AR);
    expectLabels(lectures.LECTURE_WITHDRAW_REASONS, lectures.LECTURE_WITHDRAW_REASON_LABELS_AR);
    expectLabels(lectures.SUBJECT_ATTACHMENT_KINDS, lectures.SUBJECT_ATTACHMENT_KIND_LABELS_AR);
    expectLabels(lectures.SUBJECT_EVENT_KINDS, lectures.SUBJECT_EVENT_KIND_LABELS_AR);
    expect(lectures.OFFICIAL_BADGE_AR).toBe('رسمي');
  });
});

describe('copies (P1-T5)', () => {
  it('Phase 1 starts personal, independent-fork and followed copies; a collaborative copy is Phase 4', () => {
    expect([...copies.START_STUDYING_MODES]).toEqual(['personal', 'independent_fork', 'followed']);
    expectLabels(copies.COPY_MODES, copies.COPY_MODE_LABELS_AR);
    expectLabels(copies.COPY_UPDATE_POLICIES, copies.COPY_UPDATE_POLICY_LABELS_AR);
    expectLabels(copies.COPY_UPDATE_POLICIES, copies.REANCHOR_POLICY_LABELS_AR);
    expect(copies.COPY_MODE_LABELS_AR.followed).toBe('نسخة متابَعة');
  });
});

describe('publications (P1-T5)', () => {
  it('Phase 1 publishes course-only explanations, labelled as a student explanation that is not a source', () => {
    expect([...publications.PUBLISH_VISIBILITIES_PHASE1]).toEqual(['course']);
    expect([...publications.PUBLISH_KINDS_PHASE1]).toEqual(['explanation']);
    expect(publications.STUDENT_EXPLANATION_LABEL_AR).toBe('شرح طالب — ليس مصدرًا');
    expectLabels(publications.PUBLICATION_STATUSES, publications.PUBLICATION_STATUS_LABELS_AR);
    expect(publications.hiddenByModeratorAr('محتوى غير دقيق')).toBe('أخفى المشرف هذا الشرح: محتوى غير دقيق');
  });
});

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
function expectLabels(keys: readonly string[], labels: Record<string, string>): void {
  expect(Object.keys(labels).sort()).toEqual([...keys].sort());
  for (const [k, v] of Object.entries(labels)) {
    expect(v, k).toMatch(/[\u0600-\u06ff]|^\d+$/);
    expect(BIDI.test(v), k).toBe(false);
  }
}
