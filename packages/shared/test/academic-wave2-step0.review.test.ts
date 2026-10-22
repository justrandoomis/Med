// Wave-2 step 0 — adversarial review of the P1-T4 / P1-T5 contracts (BUILD_PLAN §1.2). Each block reproduces a defect
// found in the step-0 contracts; every test here failed on the builder's version and passes after the fix.
import { describe, expect, it } from 'vitest';
import * as channels from '../src/academic/channels-api';
import * as notifications from '../src/academic/notifications-api';
import * as moderation from '../src/academic/moderation-api';
import * as lectures from '../src/academic/lectures-api';

const ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';
const SPACE = '01JSPACEABCDEFGHJKMNPQRSTV';
const keys = { p256dh: 'BOr_abc-123', auth: 'xyz_12-3' };

describe('R1 (major) Web Push endpoints cannot point the server at internal addresses (SSRF)', () => {
  // the server POSTs every push message to the stored endpoint: a signed-in user must not be able to aim it at the
  // host's own network, a cloud metadata address or a non-default port
  it.each([
    'https://169.254.169.254/latest/meta-data/iam',
    'https://127.0.0.1/api/data/backups',
    'https://10.0.0.5/admin',
    'https://2130706433/x', // 127.0.0.1 written as one number (WHATWG URL normalises it)
    'https://[::1]/x',
    'https://localhost/x',
    'https://push.localhost/x',
    'https://intranet/x',
    'https://render-internal.internal/x',
    'https://printer.local/x',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://fcm.googleapis.com@10.0.0.5/fcm/send/abc',
    'https://user:pass@fcm.googleapis.com/fcm/send/abc',
  ])('refuses %s', (endpoint) => {
    expect(notifications.pushSubscriptionSchema.safeParse({ endpoint, keys }).success).toBe(false);
  });

  it.each([
    'https://fcm.googleapis.com/fcm/send/dXJ5c2xhbmQ:APA91bH',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
    'https://web.push.apple.com/QGuQyavXutnMOKk',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
  ])('accepts the real push service %s', (endpoint) => {
    expect(notifications.pushSubscriptionSchema.safeParse({ endpoint, keys }).success).toBe(true);
  });

  it('unsubscribing stays possible for any https endpoint the user stored (it only ever matches their own rows)', () => {
    expect(notifications.deletePushSubscriptionSchema.safeParse({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }).success).toBe(true);
    expect(notifications.deletePushSubscriptionSchema.safeParse({ endpoint: 'javascript:alert(1)' }).success).toBe(false);
  });
});

describe('R2 (major) registering with a join proof accepts the device fields every sign-in sends', () => {
  // apps/web/src/lib/auth.ts `deviceFields()` adds `device_label` (always) and `device_id` to setup and login; the
  // session of a new account is per device (P1-T1), so registration must accept the same fields
  it('accepts device_label and device_id like /api/auth/setup', () => {
    const r = channels.registerWithJoinSchema.safeParse({
      username: 'zainab.k',
      display_name: 'زينب',
      password: 'correct horse battery',
      join: { code: 'ABCD-EFGH' },
      device_label: 'iPad · Safari',
      device_id: 'dev_01JABCDEF',
    });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('still refuses a malformed device id and unknown fields', () => {
    const base = { username: 'zainab', display_name: 'زينب', password: 'p', join: { code: 'ABCD-EFGH' } };
    expect(channels.registerWithJoinSchema.safeParse({ ...base, device_id: 'a b' }).success).toBe(false);
    expect(channels.registerWithJoinSchema.safeParse({ ...base, is_platform_admin: true }).success).toBe(false);
  });
});

describe('R3 (minor) an invitation id is not a credential for a new account', () => {
  // channel_invitation.invitee_user_id is an EXISTING account (ARCHITECTURE_DELTA §4.1 2050), and invitation ids are
  // shown in the invitee's inbox and the admin list: as a registration proof they could only ever be misused
  it('registration takes a class code or an invite-link token, never an invitation id', () => {
    expect(channels.joinProofSchema.safeParse({ invitation_id: ID }).success).toBe(false);
    expect(channels.joinProofSchema.safeParse({ code: 'ABCD-EFGH' }).success).toBe(true);
    expect(channels.joinProofSchema.safeParse({ invite_token: 'tok_abcdefghijklmnop1234' }).success).toBe(true);
  });
});

describe('R4 (minor) one open report per reporter per target cannot be dodged by naming the target twice', () => {
  // the unique index is (reporter, target_db, target_type, target_id): the same publication under two `db` spellings
  // would be two «targets»
  it('a publication is reported in the system index; a publication version in its space', () => {
    expect(moderation.moderationTargetSchema.safeParse({ db: 'system', type: 'publication', id: ID }).success).toBe(true);
    expect(moderation.moderationTargetSchema.safeParse({ db: SPACE, type: 'publication', id: ID }).success).toBe(false);
    expect(moderation.moderationTargetSchema.safeParse({ db: SPACE, type: 'publication_version', id: ID }).success).toBe(true);
    expect(moderation.moderationTargetSchema.safeParse({ db: 'system', type: 'publication_version', id: ID }).success).toBe(false);
  });

  it('the same rule holds inside a report and a moderator action', () => {
    expect(moderation.createReportSchema.safeParse({ target: { db: SPACE, type: 'publication', id: ID }, reason: 'spam' }).success).toBe(false);
    expect(
      moderation.moderationActionSchema.safeParse({ target: { db: 'system', type: 'publication_version', id: ID }, action: 'hide', reason_ar: 'سبب واضح' }).success,
    ).toBe(false);
  });
});

describe('R5 (minor) titles from a vault never make a notification unwritable', () => {
  // vault source titles allow 300 characters and bidi controls (file names: sources/index.ts); the payload schema
  // refuses both, so a `reanchor_ready` for such a lecture would fail to be written (zod counts code points)
  const RLO = '\u202e';
  const dirty = [`محاضرة${RLO}fdp.exe`, 'x'.repeat(300), `سطر\nسطر\tآخر`, '   ', '\u200f\u2066', `${'🫀'.repeat(250)}`];

  it('the raw titles are refused by the strict payload', () => {
    for (const t of dirty) {
      const r = notifications.notificationContentSchema.safeParse({ kind: 'reanchor_ready', payload: { lecture_title: t, copied: 1, needs_review: 0, kept: 0 } });
      expect(r.success, JSON.stringify(t)).toBe(false);
    }
  });

  it('notificationTitle() turns any title into one the payload accepts, keeping its readable text', () => {
    for (const t of dirty) {
      const title = notifications.notificationTitle(t);
      const r = notifications.notificationContentSchema.safeParse({ kind: 'reanchor_ready', payload: { lecture_title: title, copied: 1, needs_review: 0, kept: 0 } });
      expect(r.success, `${JSON.stringify(t)} → ${JSON.stringify(title)}`).toBe(true);
      expect([...title].length).toBeLessThanOrEqual(notifications.NOTIFICATION_TITLE_MAX);
    }
    expect(notifications.notificationTitle(`محاضرة${RLO}fdp.exe`)).toBe('محاضرةfdp.exe');
    expect(notifications.notificationTitle('x'.repeat(300)).endsWith('…')).toBe(true);
    expect(notifications.notificationTitle('   ')).toBe('بلا عنوان');
    expect(notifications.notificationTitle(null)).toBe('بلا عنوان');
    expect(notifications.notificationTitle('  المحاضرة 5  ')).toBe('المحاضرة 5');
    // never cuts a character in half
    expect(/[\ud800-\udbff]$/.test(notifications.notificationTitle('🫀'.repeat(250)).slice(0, -1))).toBe(false);
  });
});

describe('R6 (minor) a notification never names the person who reported something', () => {
  // ARCHITECTURE_DELTA §13: the author never learns who reported; push shows notifications on lock screens
  it('moderation outcomes and new reports carry no actor', () => {
    expect(notifications.NOTIFICATION_KINDS_WITHOUT_ACTOR).toEqual(expect.arrayContaining(['moderation', 'report_received']));
    for (const k of notifications.NOTIFICATION_KINDS_WITHOUT_ACTOR) expect(notifications.NOTIFICATION_KINDS).toContain(k);
  });
});

describe('R7 (minor) the preference label of subject updates names everything the kind carries', () => {
  // `subject_update` also tells copy holders that a lecture was withdrawn; the switch must not hide that
  it('mentions withdrawn lectures', () => {
    expect(notifications.NOTIFICATION_KIND_LABELS_AR.subject_update).toMatch(/سحب/);
  });
});

describe('R8 (minor) the «تابع المادة» toggle can show its state', () => {
  it('a node view carries the viewer’s own course follow', () => {
    const view: channels.ChannelNodeView['viewer'] = { membership: null, roles: [], inherited_from: null, course_follow: null };
    expect(view.course_follow).toBeNull();
    const f: channels.ChannelNodeView['viewer']['course_follow'] = {
      subject: { id: ID, kind: 'subject', title: 'التشريح' },
      add_new_lectures: true,
      library_folder_id: null,
      created_at: 1,
    };
    expect(f?.add_new_lectures).toBe(true);
  });
});

describe('R9 (minor) official lectures: approval is visible and the number can be corrected', () => {
  it('a lecture view says who approved a contributor’s draft (AOS-18.4 draft → approved → published)', () => {
    const approved: lectures.OfficialLectureView['approved'] = { by: { id: ID, display_name: 'د. سارة', avatar_url: null }, at: 1 };
    expect(approved?.by.display_name).toBe('د. سارة');
  });

  it('PATCH /lectures/:id corrects the title, the number or the date (a detected number becomes the moderator’s)', () => {
    expect(lectures.patchOfficialLectureSchema.safeParse({ lecture_no: 6 }).success).toBe(true);
    expect(lectures.patchOfficialLectureSchema.safeParse({ title: 'المحاضرة السادسة', held_on: null }).success).toBe(true);
    expect(lectures.patchOfficialLectureSchema.safeParse({}).success).toBe(false);
    expect(lectures.patchOfficialLectureSchema.safeParse({ status: 'published' }).success).toBe(false);
    expect(lectures.patchOfficialLectureSchema.safeParse({ lecture_no: 0 }).success).toBe(false);
  });
});
