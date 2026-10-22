# Module: notifications, minimal moderation and the scoped audit view (Academic OS P1-T4 step 2)

> **Status:** step 2 built and adversarially reviewed (2026-10-21); step 3 (2026-10-22, not yet reviewed) built the
> screens «التنبيهات», «الإشراف» and «سجل الإجراءات», the bell and the «تابع المادة» toggle — see «Web (step 3)». Review findings and fixes: «Review» below. Design: [ARCHITECTURE_DELTA](../academic-os/ARCHITECTURE_DELTA.md) §4.1
> `2200_notifications` / `2310_moderation` / `security_audit`, §5.3, §7.12, §12, §13; [BUILD_PLAN](../academic-os/BUILD_PLAN.md)
> §3.6 step 2; PRD AOS-18.7, 18.8 (Phase 1 parts), 18.13, 18.14, 21.31, 21.33, 2.16, 21.15 (Phase 1 part), 5.18 (Phase 1
> part), Q1, Q6. Contracts: `packages/shared/src/academic/{notifications-api,moderation-api,channels-api}.ts`.

## Notifications — the in-app inbox

| piece | where | notes |
|---|---|---|
| Tables | `migrations-system/2200_notifications.sql` | `notification` (+ `access`, `scope_node_id`, `link`, a per-user `seq`), `notification_pref`, `push_subscription` (§4.1, no route writes it), `notification_fanout` (the fan-out queue), an index on active course follows by subject |
| Publishing | `modules/notifications/service.ts` `notificationsOf(ctx).publish(input)` | every title passes `notificationTitle` (bidi controls out, one line, ≤ 200), then the STRICT per-kind schema: a payload with anything but titles and counts **throws before anything is written**; the actor is dropped for `moderation`, `report_received`, `reanchor_ready`, `quota_warning`; the link must be an in-app path; ONE `notification_fanout` row is written in the caller's transaction (`dedupe_key` unique: the same event twice is one fan-out) and the worker is poked |
| Fan-out | `modules/notifications/fanout.ts` | runs in the ROOT context, never on a request. One step = one batch of at most **500** recipients (`NOTIFICATION_BATCH_SIZE`) in one system transaction (`INSERT OR IGNORE` on `(user_id, dedupe_key)`, cursor moved in the same transaction), then `setImmediate` before the next step. A failing step is retried from the same cursor with back-off (1 min doubling, ≤ 6 h); after 6 failures the fan-out is `failed` with a short error code (logged, never a payload). Pending fan-outs resume at boot. Measured here: 1,203 followers in 3 steps, ≈ 40 ms a step |
| Audiences | `modules/notifications/audiences.ts` | `users` (≤ 10,000 explicit), `node_approvers` (Admin / Assistant here or above — the platform admins when the chain has none, **or when none of its role holders may be told**: the only moderator wrote the reported content, or holds the role on a suspended account — review R1), `scope_moderators` (Admin / Assistant / Subject Moderator here or above — same fallback), `course_followers` (active «تابع المادة»), `registered` (a pager another module registers: `registerAudience(name, pager)` — P1-T5's copy holders through `lecture_copy`, publication followers). Paged by user id (keyset) |
| Who is told | `fanout.ts` `recipients`, `access.ts` | an active account, not excluded, the kind not switched off in-app, and **still allowed to open what it is about**: `self` (always), `member` (may enter the scope node — never a pending request; a nearer removal wins), `manage_members`, `moderate` (the policy's actions on the node) |
| Inbox | `GET /api/notifications?cursor=&limit=&unread=` | the viewer's own rows, newest first (per-user `seq`, opaque cursor). The same access check runs again **at read time**: a membership or role lost since hides the earlier rows (list and `unread_count`) — the titles are the subject's, not the reader's; given back, they show again. Each row is re-validated against the strict schema before it is shown; `actor` is rendered now from the system account («طالب سابق» for a deleted one); `text_ar` is rendered from kind + payload (`render.ts`) |
| Read state | `POST /api/notifications/read` `{ids}` / `{all:true}` → `{updated, unread_count}` | per user; another user's id (or a missing one) changes nothing and the answer is the same |
| Preferences | `GET` / `PUT /api/notifications/prefs` | in-app per kind (default on; off = not written at all). Push: `available: false` with the Arabic reason — this server has no VAPID keys and nothing was run on a device; `PUT` with push on → `409 FEATURE_DISABLED`. The push-subscription routes of the contract are **not mounted** (no switch that does nothing, AOS-23.3) |
| Account deletion | participant `notifications` | the deleted account's inbox, preferences and push subscriptions are deleted; rows naming it as actor read «طالب سابق» |

### Who publishes what (Phase 1)

| kind | by | audience · access · dedupe |
|---|---|---|
| `join_requested` | channels: a join or a registration that waits for approval | `node_approvers` · `manage_members` on the node · one per transition to pending (actor = requester, excluded) |
| `join_decided` | channels: approve / reject / remove | the member · `self` · one per decision (actor = the approver) |
| `invitation` | channels: invite | the invitee · `self` · `invitation:<id>` (inviting again is the same invitation) |
| `report_received` | moderation: a new report | `scope_moderators` · `moderate` on the subject · `report_received:<report>` (reporter and author excluded; no actor) |
| `moderation` | moderation: hide / restore / dismiss | the author (hide, restore) · `self`; the reporters (hide, dismiss; restore with a report) · `member` of the subject (a reporter who left learns nothing more) · per action and role (no actor) |
| `official_lecture_new`, `official_version`, `subject_update`, `publication_updated`, `reanchor_ready` | **P1-T5** (`publish` + `course_followers` or a registered audience) | `member` on the subject by default |
| `quota_warning` | not wired yet (P1-T1's quota service) | — |

## Minimal moderation

| piece | where | notes |
|---|---|---|
| Tables | `migrations-system/2310_moderation.sql` | `moderation_report` (one OPEN report per reporter per target — unique index), `moderation_action` (+ `scope_node_id`) |
| Targets | `modules/moderation/targets.ts` `moderationTargetsOf(ctx).register(handler)` | the content stays with its owner track; a handler gives `resolve` (scope, title, author, state, link), `visibleTo(viewer)` and `setState(hidden / visible)`. **P1-T5 step 3 registers `publication` and `publication_version`**; until then no Phase 1 target exists and every report answers 404 (the tests use a fixture through the same seam) |
| Report | `POST /api/moderation/reports` | `{target:{db,type,id}, reason, note?}`; reasons include `patient_identifiers` and `copyright`; Phase 1 targets only; a publication is named by its system index row only (one spelling). Content that does not exist, that the reporter cannot see, or a type nobody registered: one and the same 404. Own content: 409. One open report per target: 409 with the open report's id. 20 reports an hour per account (429), 120 a minute per address. The subject's moderators are told (`report_received`) |
| Queue | `GET /api/moderation/queue?scope_node_id=&status=&cursor=` | the reports of the scope and everything below it, newest first; `moderate` on the node (Admin / Assistant / Subject Moderator here or above, platform admin); **anyone else gets exactly the body of a missing route**. The reporter and the note are shown to the moderators — except to a moderator who wrote the reported content (neither the reporter nor the note: the note is the reporter's own words, review R2) and, for content that no longer resolves (its author is unknown), to nobody (review R5); the reporter reads their own note back when filing |
| Actions | `POST /api/moderation/actions` | `{report_id? | target?, action: hide | restore | dismiss, reason_ar}`. `moderate` on the subject the content belongs to **now** (the report's own scope only once the content is gone — review R3); the author's notice carries the owner's link only when it is an in-app path (a notice never stops a decision — review R4); a member who can see the content → 403; a report id, or content the caller cannot see → the 404 of a missing id. Nobody decides about their own content (403). `hide` closes every open report on the target as `actioned`; `dismiss` closes the named report (or all open on the target) as `dismissed`; `restore` closes the named report if open. Hiding hidden / restoring visible content: 409. One transaction: the action row, the reports, the audit entry, the notices — and the owner's `setState` last (if it refuses, nothing happened). Followers keep what they had (the owner's handler only changes the content's state) |
| Audit | `security_audit` | `moderation_hide / _restore / _dismiss`, actor role `assistant@<node>` / `subject_moderator@<node>` / `platform_admin`, the scope, the target; the summary names the action and the subject — never the reason, the note or the reporter. Report creation is not written to `security_audit` (it would name the reporter to an Admin who may be the author) — the report row is its own trail |

## The scoped security-audit view

`GET /api/admin/audit?scope_node_id=&action=&cursor=&limit=` (`modules/moderation/service.ts` `scopedAudit`, mounted at
`/api/admin`): the `security_audit` rows whose scope is the node or anything below it, newest first, optionally one action.
`view_audit` on the node: Admin or Assistant here or above, or the platform admin (§5.3 «subtree»); a Subject Moderator, a
member or anyone else → 403 (the node is visible); a missing node → 404. Each entry: actor (UserRef), actor role, scope
(NodeRef), action, target, the Arabic summary, the time — **no IP address, no `details_json`**. Rows without a scope
(sign-ins, devices, exports) never appear. `view_stats` (Phase 2 statistics) is allowed to a Subject Moderator only on a
subject («own subject (aggregates)») — this settles review note N6 of step 1.

## Course follow «تابع المادة»

`PUT /api/channels/subjects/:id/follow` `{add_new_lectures, library_folder_id?}` → `CourseFollowView`;
`DELETE …/follow` → `{subject, course_follow: null}` (idempotent). Members of the subject only (the policy's `follow`:
403 `MEMBERSHIP_PENDING` / `MEMBERSHIP_REQUIRED` with the reason; 403 for a node that is no subject; 404 for a missing
one). The library folder must be a folder of the follower's OWN vault (the request is bound to it; a notebook is
refused). One row per user and subject; the node view's `viewer.course_follow` is the toggle's state. Not a payment (PRD
Q1). The stubs that new lectures add to the library are P1-T5's (step 2), which reads followers through
`channelsOf(ctx).repo.courseFollowersPage(subjectId, after, limit)` and must still check that each may enter the subject.

## Rules changed in `modules/authz/rules/channels.ts`

| resource : action | allowed | otherwise |
|---|---|---|
| `channel_node` moderate (new) | platform admin; Admin, Assistant, Subject Moderator here or above | 404 |
| `channel_node` view_audit | platform admin; Admin or Assistant here or above (was: also Subject Moderator) | 403 |
| `channel_node` view_stats | the same, plus a Subject Moderator on a subject | 403 |

The X9 matrix (`apps/server/test/authz/matrix.test.ts`) asks these for all 20 principals, runs the queue and the audit view
through HTTP for every principal on three scopes, and lists every moderation, admin and notifications route with the test
that checks who may call it.

## Review (P1-T4 step 2, adversarial, 2026-10-21)

Read every file of the step; probed as a guest, a pending member, a student, a contributor, an Assistant, a Subject
Moderator, a moderator who wrote the reported content, another subject's moderator, another university's Admin, a removed
member and a suspended role holder. Each defect was reproduced first by a failing test in
`apps/server/test/moderation/review-step2.test.ts` (7 tests: 6 failed before the fixes, the seventh — the fallback stays a
fallback — pins behaviour that held).

| # | severity | defect | fix |
|---|---|---|---|
| R1 | major | A report on content written by the only moderator of the chain, or a join request whose only approver holds the role on a suspended account, reached **nobody**: the platform-admin fallback asked only whether a role row existed, not whether anyone was left to tell once the author was excluded and inactive accounts skipped — the report sat in a queue nobody was told about (the author may not decide it) | `fanout.ts`: a role audience (`node_approvers`, `scope_moderators`) whose only page held nobody eligible (active, not excluded, may open the scope — preferences aside) continues with the platform admins (`PLATFORM_ADMINS_CURSOR`); `audiences.ts` marks a page that already is the fallback. Opting out of a kind is a choice and does not page the platform admin |
| R2 | minor | A moderator who wrote the reported content read the reporter's note in the queue (the reporter's own words, which may name them) | `service.ts` `view()`: the note follows the reporter's visibility for the queue; the reporter reads their own note back when filing |
| R3 | minor | A report kept the scope of the moment it was filed: once the owner track answered another subject for the content, the old subject's moderators still decided about it through the report id | `act()`: the subject the content belongs to now decides (`info.scopeNodeId`), the report's scope only once the content is gone |
| R4 | minor | An owner-track link outside the in-app pattern (`https://…`, a fragment) made every moderation decision on that content fail with a 500 (`publish()` refused the author's notice inside the decision's transaction) | `notifyOutcome()` passes the owner's link only when `isNotificationLink()` accepts it; the notice is sent without a link otherwise |
| R5 | minor | Once reported content no longer resolved (e.g. its author removed it), the queue showed the reporter and the note to every moderator — the author-moderator included, since the author was no longer known | reporter and note are shown only while the content resolves and its author is not the viewer |

Reported, not fixed (documented for later steps and owners):

* **Seam for P1-T5 step 3 — hidden publications in notices.** `publication_updated` (and any notice about a publication)
  shows its title to followers who may still enter the subject; nothing hides that notice when a moderator hides the
  publication (the read-time check is about the scope, not the target's state). P1-T5 step 3 must either not publish a
  title that can be hidden, or this module adds a read-time target check through `moderationTargetsOf(ctx)` (resolve +
  `visibleTo`) before publication notices exist. Not reproducible today (no publisher of publication kinds).
* **Seam for P1-T5 step 3 — `ModerationTargetInfo.state`.** `hidden` must mean «hidden by moderation» only: an item its
  author withdrew must not answer `hidden`, or a moderator's «أعِد الإظهار» would republish it (`setState` may throw a
  CONFLICT, which rolls the whole decision back).
* Report spam: every report notifies the scope's moderators (dedupe «per report», §12); 20 reports an hour per account and
  a re-report after a dismissal are allowed. Coalescing notices per target while a report is open is a candidate for
  Phase 2 digest batching.
* The fallback of R1 looks at the first page of role holders only (a chain with 500 or more role holders and none
  eligible is not covered), and a sole moderator who files a report in their own subject also pages the platform admin
  (they are excluded from their own report's notice).
* `join_decided` names the approver (actor) to the member — also on a rejection or a removal, while the membership view
  does not show who decided. Kept as built (the builder's test pins it); owner question.
* The reporter's note survives the reporter's account deletion (shown as «طالب سابق»); the inbox has no retention (rows
  are never pruned); per-user export holds no system rows.
* A report filed before its content changed subject stays in the old subject's queue, where only the new subject's
  moderators (acting by target) can close it.

## Web (step 3)

* **The bell** (`features/notifications/NotificationBell.tsx`, in the app shell's top bar): a link to `/notifications`
  named «التنبيهات، N غير مقروءة»; the count is text on a pill (never only a dot; an outline in e-ink); refreshed every
  two minutes, on focus, on reconnect and when the inbox changes it (`setUnreadCount`).
* **«التنبيهات»** (`features/notifications/NotificationsScreen.tsx`, `/notifications`): grouped by day in the viewer's
  time zone («اليوم» / «أمس» / a date); each row (NotificationRow) says what happened, who and when, «غير مقروء» in text,
  opens its target (marked read first; the target re-checks access) and has «علّم كمقروء»; «علّم الكل كمقروء» (disabled
  with «لا توجد تنبيهات غير مقروءة.» when there are none); the filter الكل / غير المقروءة; «اعرض الأقدم» (cursor);
  «تفضيلات التنبيهات» — one in-app switch per kind, and push is not offered, with the server's reason. Offline: the last
  inbox saved on this device, read-only, with when it was saved.
* **«الإشراف»** (`features/admin/ModerationSection.tsx`): the scope's queue by status (مفتوح / اتُّخذ إجراء / لا مخالفة);
  each report with its reason, the reporter's note and when; «أبقِ (لا مخالفة)», «أخفِ مع السبب», «أعِد الإظهار» — each
  after a reason the author and the reporter read; Phase 2 actions are not shown. An empty queue says so plainly.
* **«سجل الإجراءات»** (`features/admin/AuditSection.tsx`): the scope's entries (and below), newest first, filterable by
  action, with the actor, their role, the scope and the time; no IP addresses and no private content.
* **«تابع المادة»** — the switch on the subject page (`features/channels/SubjectScreen.tsx`), kept on the server.
* The report dialog «أبلغ» is P1-T5's (`features/lectures`, on the publication page).

Web tests: `apps/web/test/channels/{notifications,admin}.test.tsx`; E2E: `e2e/aos-p1-join.spec.ts` (an approval reaches
the inbox as an unread entry that opens the subject and is then read), `e2e/aos-p1-admin.spec.ts` (audit by scope and
action; «الإشراف» with a fixture report — added in the review of step 3 once P1-T5 step 3 registered publications: a
classmate's course-only explanation is reported, the Subject Moderator hides it with a reason through the screen, the
author and the reporter are told, and it is restored), `e2e/aos-no-decorative.spec.ts`. The paging buttons «المزيد» /
«الأقدم» of «الإشراف» and «سجل الإجراءات» are disabled with the reason offline and say an error (review R5).

## Tests

`apps/server/test/notifications/{inbox,fanout}.test.ts`, `apps/server/test/moderation/{minimal,audit-view}.test.ts`
(+ `fixture.ts`, the stand-in for P1-T5's publications), `apps/server/test/channels/follow.test.ts`,
`apps/server/test/acceptance/ac01b.test.ts` (system paths of AC-01b), `apps/server/test/authz/matrix.test.ts` (updated),
`apps/server/test/moderation/review-step2.test.ts` (review, 7).

## Not done here

* ~~Web screens («التنبيهات», «الإشراف», «سجل الإجراءات», the «تابع المادة» toggle)~~ — step 3.
* Web Push delivery (VAPID keys, a sender with the SSRF rules of `isPublicPushEndpoint`, a device run on an installed iOS
  PWA) and the capability key `notifications.push` — not built; the preferences say why. Adding the key needs edits in
  `apps/web/src/features/control/CapabilitiesScreen.tsx` and two P1-T1 step-0 tests that pin the key list.
* `quota_warning` is not published by anyone yet (the quota service is P1-T1's); `reanchor_ready` and the official /
  publication kinds are P1-T5's to publish through `publish()`.
* Real moderation targets: P1-T5 step 3 registers `publication` / `publication_version` handlers.
* Quiet hours and digest batching (§12 «no dark patterns») — not needed while only in-app delivery exists.
* The per-user export (P1-T1's `accounts/export.ts`) holds the vault only — not the inbox, follows or reports (system rows).
* `Idempotency-Key` is not honoured by `POST /api/moderation/reports` (a retried report answers 409 with the open
  report's id, which a client can treat as success).
