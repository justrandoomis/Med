# Module: channels — the university tree, joining, memberships and roles (Academic OS P1-T4)

> **Status:** step 1 built and adversarially reviewed (2026-10-21; seven defects fixed, see «Review» below) — server only.
> Step 2 built and reviewed (2026-10-21): course follow routes, join / decision / invitation notices, the `moderate`
> action and the narrowed `view_audit` — see [notifications-moderation.md](notifications-moderation.md). Step 3 built
> (2026-10-22, not yet reviewed): the web — the five-destination app shell, «القنوات», the subject page, the join sheet
> with the QR scanner, the invite landing, «أنا», «التنبيهات», «إدارة القنوات» — see «Web (step 3)». Design: [ARCHITECTURE_DELTA](../academic-os/ARCHITECTURE_DELTA.md)
> §4.1 `2050_directory` / `2100_permissions`, §5, §7.3; [BUILD_PLAN](../academic-os/BUILD_PLAN.md) §3.6; PRD AOS-2.1,
> 2.11–2.15, 18.2, 18.5, 18.6, 21.2–21.6, 21.18, 21.37, Q2/Q3/Q4/Q36.

## What it does

| piece | where | notes |
|---|---|---|
| Tree + closure | `migrations-system/2050_directory.sql` (`channel_node`, `channel_closure`), `modules/channels/repo.ts` | University → College → Department → Stage → Academic Year → Course → Subject. Kinds strictly descend; levels may be skipped; a subject is the last level; a root is always a university (created by the platform admin only, PRD Q4). Every node has a self closure row; «is X inside Y» is one indexed lookup; a move rewrites the subtree's closure rows in one transaction and refuses cycles and wrong kinds. A move needs Admin power over the node's CURRENT parent (or above) and over the target: an Admin of one subject cannot carry it out from under the Admins above it (review R6). Dates only on academic years and courses |
| One space per subject | `service.ts` `createNode` | a subject's space file is created from the migrated template (`pool.createFile('space', id)`) and registered through P1-T1's registry (`registerSpaceInternal`) in the same system transaction as the node; a failure removes the new file. No space for other kinds (PRD Q36); `create_space: false` on a subject is refused. Renaming a subject renames its space |
| Archive | `POST /nodes/:id/archive` | `{preview:true}` returns the impact (descendants, live memberships, spaces, open codes) and changes nothing; `{preview:false}` archives the subtree, revokes its open codes and its pending invitations (review R7) and makes its spaces `read_only`. Memberships under an archived node stop granting access; roles (and the platform admin) still do. An archived node takes no edits, children, codes, joins or invitations (409) |
| Memberships | `channel_membership` | apply to the node and everything below it. `pending` → 403 `MEMBERSHIP_PENDING` at gate 2; `approved` → member; `rejected`, `left`, `removed` → nothing. **A removal decides like an approval and the nearer one wins** (review R2): a student removed from a subject stays out of it even with an approved membership of the stage above, and does not get it back by joining the stage again; an approval on the subject itself still wins over a removal higher up. Someone turned away (removed here or above, or a request rejected here) who joins again with a code — even an auto-approving one — waits for an approver (review R2/R3); an invitation re-admits |
| Class codes, invite links, QR | `join_code`, `codes.ts` | class code = 8 symbols of Crockford's base32 (40 bits) shown once as «ABCD-EFGH»; invite link = `https://<origin>/join/<43-char token>`, the QR payload is the same link. Only an HMAC of the normalised secret is stored, keyed by a sub-key of the server secret (`deriveKey(secret, 'join-code')`), domain-separated per kind — a copy of `system.sqlite` alone cannot be brute-forced offline. Typed codes are normalised (`normalizeJoinCode`: case, spaces, dashes, Arabic-Indic digits, O→0, I/L→1). Codes expire (≤ 180 days), can be revoked, count uses atomically and stop at `max_uses`. Pending = `code.requires_approval` or node policy `approval`; a `closed` node takes no codes at all (invitations only); an `approval` node refuses an auto-approving code (409) |
| Join limits | `limiter.ts`, `join_attempt` | wrong codes / links: 10 per account per hour → 429 `RATE_LIMITED` for that account only; per IP a high ceiling = `MEDLEVO_LOGIN_IP_FAILURES_PER_HOUR` (default 300 — a campus NAT), **counted per kind of attempt** (review R1): signed-in joins (codes and links together), the public preview, registrations with a class code and registrations with an invite link each have their own address budget, so one person behind the hall's address cannot spend the class's budget on the cheap public preview or on wrong registrations and lock everyone out of joining for an hour (a flood of one kind stops only that kind; the QR / invite-link registration keeps working while class-code registrations are limited). Only failures are written (a valid preview or join writes no row — no write per public request); survives restarts. The public preview also has a coarse per-address ceiling of 600 requests a minute |
| Public preview | `GET /join/preview?token=` | PUBLIC (ADR-0003 §3.10). A valid invite token → `{title_ar, kind, requires_approval}` only; a wrong, expired, revoked, exhausted, closed, archived or malformed token → exactly the body of a missing route (`{"error":{"code":"NOT_FOUND","message":"المسار المطلوب غير موجود."}}`) |
| Registration | `modules/auth/index.ts` `POST /api/auth/register` (P1-T1's file, mounted only with a verifier) + `verifier.ts` | PUBLIC. No open sign-up (PRD Q2/Q3): `registerWithJoinSchema` with a class code or invite token; the verifier checks the proof and **reserves one use before the account exists**; the account (never a platform admin, own vault) is created; on failure (a taken name) the use is given back; the new account's membership is filed (pending / approved per policy); signed in on this device (device fields as setup / login). An invitation id is no proof. The platform admin's own path to give someone an account is a single-use invite link or code (`max_uses: 1`) |
| Approvals and members | `GET /nodes/:id/members`, `POST /nodes/:id/members/:userId/decision` | Admin / Assistant here or above, or the platform admin (PRD §4.3; AOS-2.15's Subject Moderator wording is the open note N4). Keyset-paged (opaque cursor), oldest first. approve (pending/rejected), reject (pending), remove (approved/pending) with an optional Arabic reason; nobody decides about their own membership |
| Invitations | `channel_invitation` | to existing accounts only (14 days); inviting again returns the same pending invitation; members already in are skipped; only the invitee sees (`GET /invitations`) and decides; accept → approved membership (`invitation`), decline → no membership. An invitation is good only while its sender may still manage the node's members: revoking the sender's role (or deleting the account) takes it back — it is no longer listed and accepting answers 409 (review R4). Nobody invites themselves (403, review R5) |
| Roles | `migrations-system/2100_permissions.sql` (`role_assignment`, `acl_grant`) | Admin, Assistant, Subject Moderator, Contributor; Student = an approved membership. Inherit down the tree, never sideways. The platform admin assigns any role; an Admin assigns and revokes roles **below Admin** in the subtree; nobody else. `GET /nodes/:id/roles` lists the node's roles and the inherited ones (root first) |
| Authz rules | `modules/authz/rules/channels.ts` | self-registered by the plugin (`channels.node`, `channels.space`); see the table below |
| Gate 2 | `access.ts` `ChannelAccess` = the policy's `MembershipProvider` | per subject: platform admin or Admin / Assistant / Subject Moderator here or above → `moderator`; Contributor or approved member → `member`; pending only → 403 `MEMBERSHIP_PENDING`; anything else → 404 (the body of a missing route) |
| Audit | `security_audit` | `channel_node_create / _edit / _move / _archive`, `channel_code_create / _revoke`, `channel_join`, `channel_membership_decide`, `channel_invite`, `channel_invitation_decline`, `channel_role_grant / _revoke`, `register`; actor role (`platform_admin`, `admin@<node>` …), scope node; titles, ids and counts only — never a code or link |
| Account deletion | participant `channels` | memberships → `left`, roles and pending invitations revoked, course follows ended; the person shows as «طالب سابق» in lists |

## The rules (ARCHITECTURE_DELTA §5.3, PRD §4.3)

| resource : action | allowed | otherwise |
|---|---|---|
| `channel_node` view, list | every signed-in user (titles only) | — |
| `channel_node` create, edit, delete (archive), assign_role | platform admin; Admin here or above | 403 |
| `channel_node` manage_members, manage_codes | platform admin; Admin or Assistant here or above | 403 |
| `channel_node` view_audit | platform admin; Admin or Assistant here or above (step 2; was also Subject Moderator) | 403 |
| `channel_node` view_stats | the same, plus a Subject Moderator on a subject («own subject», step 2) | 403 |
| `channel_node` moderate | platform admin; Admin, Assistant, Subject Moderator here or above (step 2: report queue, actions) | 404 |
| `channel_node` follow | a subject the viewer may enter | 403 `MEMBERSHIP_PENDING` / `MEMBERSHIP_REQUIRED` |
| root (`id = ''`) create | the platform admin (a university) | 403 |
| `space` view, list | whoever gate 2 lets in | 403 pending / 404 |
| `space` moderate | moderating roles, platform admin | 403 member / 404 |
| any other action | — (abstains: deny by default, 404) | P1-T5 adds its own `space` actions |

Id-addressed routes (`DELETE /codes/:id`, `DELETE /roles/:id`, `POST /invitations/:id/decision`) answer the 404 of a
missing id to anyone who may not act on them, so ids never confirm existence.

## For P1-T5 (seams)

* `subjectAccessOf(deps | provider, viewer, spaceId)` (`modules/channels/access.ts`) returns the gate-2 access plus the
  viewer's roles on the subject (`roles`, `isPlatformAdmin`) — for contributor drafts and moderator-only actions in
  `rules/lectures.ts` without reading channel tables.
* `channelsOf(ctx).repo.nodeOfSpace(spaceId)` / `.access.effective(viewer, nodeId)` for anything finer.
* Step 2: `channelsOf(ctx).repo.courseFollowersPage(subjectNodeId, afterUserId, limit)` — active follows with
  `add_new_lectures` and `library_folder_id` (the course-follow stub fan-out); `notificationsOf(ctx).publish(…)` with the
  `course_followers` audience (or a registered one) for new lectures, versions and subject events;
  `moderationTargetsOf(ctx).register(handler)` for publications (see notifications-moderation.md).
* The X9 matrix (`modules/authz/test-support/matrix.ts`, `apps/server/test/authz/{world,matrix}.test.ts`) refuses to pass
  while a resource type has a registered rule and no spec: P1-T5 adds specs for `official_lecture`, `publication`,
  `layer`, `file` on the same world.

## Web (step 3)

IA_AND_JOURNEYS §3.1, §4.1–§4.3, §4.9–§4.10, §8.2, J9; PRD AOS-2.11–2.16, 18.1, 18.5–18.8, 18.13, 20.17, 20.20, 23.3.

| piece | where | notes |
|---|---|---|
| app shell | `apps/web/src/app/{AppShell.tsx, navigation.ts, shell.css}` | five destinations «الرئيسية · المكتبة · القنوات · المراجعة · أنا» in the top bar (desktop) and the tab bar (phone); `activeDestination()` keeps a destination current on its sub-pages (`/subjects/*` → «القنوات»; `/settings`, `/control`, `/offline`, `/admin` → «أنا»); the bell «التنبيهات» with the unread count as text; every earlier screen stays reachable (`/settings`, `/control` and `/offline` from «أنا») |
| «القنوات» | `features/channels/ChannelsHome.tsx` | invitations (accept / decline), «قنواتي» grouped by place with «تتابعها» and unread updates as text, pending requests, «تصفّح» from the universities; a user with no channel sees «لم تنضم إلى أي مادة بعد» and that the personal library works without channels |
| browse | `features/channels/BrowseScreen.tsx` (`/channels/:nodeId`) | a node's place and children; subjects the viewer may not enter say «يتطلب رمز انضمام» (or «الانضمام بدعوة فقط» for a closed one) |
| join sheet | `features/channels/{JoinSheet, QrScanner, qr}.tsx` | one field for a class code or a pasted link (base32 normalised, Arabic-Indic digits read), «امسح رمز QR» (camera, decoded on the device with jsQR — nothing uploaded) and «اختر صورة رمز QR»; a link read from a QR shows the channel's title first; without a camera (no API, refused, none, busy) an Arabic reason and the focus goes back to the field |
| invite landing | `features/channels/JoinLinkScreen.tsx` (public `/join/:token`) | the public preview's title only; sign in (with the way back) or «أنشئ حسابًا بهذه الدعوة» (POST /api/auth/register with the invite token) → recovery codes → «متابعة إلى القنوات» by a full page load (the new account's own local data opens cleanly) |
| subject page | `features/channels/{SubjectScreen, subjectApi}.tsx` (`/subjects/:subjectId`) | breadcrumb, «تابع المادة», «إدارة المادة» for a role holder; tabs «المحاضرات» (badges «لديك نسخة» / «إصدار جديد» / «لم تبدأ دراستها», T5's lecture page), «الملفات» (by kind, uploader, drafts awaiting approval), «التحديثات» — honest empty and loading states; a non-member sees the title and how to join, a pending request «طلبك قيد المراجعة», a removed member that the notes stay theirs; a missing or hidden subject one not-found state |
| offline | `features/channels/cache.ts` | the last answer per account (`aos.cache.*` in per-user storage); shown read-only with «غير متصل · تعرض نسخة محفوظة على هذا الجهاز من …», every network action disabled with its reason |
| «إدارة القنوات» | `features/admin/*` | see [notifications-moderation.md](notifications-moderation.md) «Web» and below |
| shared pieces | `features/channels/{ui.tsx, QrCard.tsx, qrEncode.ts, useFetched.ts}` | RoleBadge, InlineBanner, CachedBanner, ReasonedButton (a control that cannot act is disabled and says why), QrCard (SVG, the link as text, copy) — [design-system.md](../design-system.md) |

**«إدارة القنوات»** (`/admin`, `/admin/:section`; reached from «أنا» only with a role; for anyone else the same page as a
missing route): the index lists the registered sections the viewer's roles open (`features/admin/sections.ts`; P1-T4's
six in `features/admin/register.ts`, P1-T5's from `features/lectures/admin/register.ts`), each loaded lazily, each with
«نطاقك: …» and a scope chooser (`?node=`).
* «الشجرة» — the scope's subtree; add under a node (kinds strictly below), add a university (platform admin; the section
  then moves to it), edit (name, English name, join policy), move (with everything below; Admin of both places), archive
  after its impact (descendants, memberships, spaces, open codes).
* «الأعضاء وطلبات الانضمام» — by status; approve one or several, reject or remove with a reason the member reads.
* «الرموز والدعوات» — a class code or an invite link with its QR, expiry, uses and approval (forced by an approval
  policy, refused with the reason for a closed one); the code or link is shown ONCE; the list shows the last characters,
  uses, expiry and state; revoke after a confirmation.
* «الأدوار» — roles given on the node and inherited from above («موروث من …», managed there); grant to a member of the
  node (only the platform admin offers «مدير القناة»); revoke after a confirmation.
* «الإشراف» and «سجل الإجراءات» — [notifications-moderation.md](notifications-moderation.md).

**Defects the builder's own E2E runs found and fixed (each reproduced by a failing test first):** the invite landing
lost the recovery-codes screen when the new account's first navigation made the route gate reload `/join/<token>` (now a
full page load to «القنوات»); four controls disabled without a reason («انقل», «ارفض» / «أزِل» before a reason, «احذف
حسابي نهائيًا», «متابعة إلى القنوات»); a new university hidden in another scope of «الشجرة»; the focus lost to `<body>`
when the join result or a QR's preview replaced the form (Escape no longer closed the sheet); the phone top bar wider than
the screen at 150 % text with the new bell (the brand name yields on narrow phones above 100 %).

**Tests (web):** `apps/web/test/channels/{model,qr,join,channels-screens,notifications,me,admin,admin-sections}.test.*`
(62 tests: QR round trip on pixels, code / link parsing, the join sheet and the landing, the subject tabs, offline
copies, the inbox, «أنا», every admin section, and «every disabled control says why» — `sayWhy.ts`). E2E (phone 390 × 844
and desktop 1280 × 800, the real server): `e2e/aos-p1-join.spec.ts` (J9: the landing shows only the title, an account
created with the link, a typed code → pending → approved → an unread inbox entry that opens the subject → «تابع المادة»
kept on the server; a QR read from a generated picture; no camera → back to the field; the scanner decoding a REAL camera
stream from Chromium's fake capture device; a revoked link answers like an unknown one), `e2e/aos-p1-admin.spec.ts`
(tree CRUD through the dialogs, codes and the QR shown once, revoke, the student who used the link approved, a role
granted here and one inherited from above, audit filtered by scope and action, «الإشراف»; no area for a student),
`e2e/aos-ac01a.spec.ts` (AC-01a, replaces `g1-ac01-personal-library.spec.ts`), `e2e/aos-no-decorative.spec.ts` (every
visible control of every screen above acts or says why it cannot; links open real screens; axe light / dark / e-ink;
44 px on the phone), `e2e/smoke.spec.ts` (Settings and the Control Center through «أنا»).

## Tests

`apps/server/test/channels/{tree,join,register,roles,deletion,owner-university,review-step1}.test.ts`,
`apps/server/test/authz/matrix.test.ts` (X9: 20 principals × every action × every resource type of the policy — the
unruled ones must be hidden from everyone — plus the route matrix and an inventory that fails when a channels route has
no matrix entry or named test), `packages/shared/test/channels-step1.test.ts`; P1-T1 tests updated for the new lists:
`test/acceptance/g8-security.test.ts` (exactly two new public routes), `test/tenancy/migrations-system.test.ts`,
`test/tenancy/import-boundary.test.ts`.

## Review (2026-10-21)

Adversarial review of step 1 (BUILD_PLAN §1.2), probing as a guest, a pending member, a student, a contributor, an
Assistant, a moderator, another subject's and another university's Admin, a removed member and an anonymous caller.
Each defect was reproduced first by a failing test in `apps/server/test/channels/review-step1.test.ts`:

| # | defect | fix |
|---|---|---|
| R1 (major) | one per-IP budget for every wrong proof: one person behind a campus NAT could spend it on the public preview (600 a minute allowed) or on wrong registrations and lock the whole class out of joining and registering for an hour — the NAT lockout the plan warns about | per-kind address budgets (`limiter.ts`); registrations with an invite token count apart from class-code ones |
| R2 (major) | a removal did not hold: a student removed from a subject kept it through an approved membership of the stage above, and got it back by joining the stage with its open code (or by joining the subject with an open code after being removed from the stage) | the nearer of approval and removal decides (`ChannelAccess.nearest`), joins after a removal wait for an approver; the node view shows the removal, not the stage membership |
| R3 (minor) | a rejected request became an approved membership through an auto-approving code | it waits for an approver again |
| R4 (major) | an invitation sent by an Assistant (or Admin) whose role was then revoked still let the invitee in, approved — and no route can revoke an invitation | an invitation is good only while its sender may still manage the node's members; otherwise it is revoked when listed or decided |
| R5 (minor) | an Assistant could invite themselves and so hold a membership that outlives their role | 403 |
| R6 (major) | an Admin of one subject who also administers a node elsewhere could move the subject out from under the Admins above it (into another university), taking it from its superiors and opening its space to another tree's members | a move needs Admin power over the current parent as well as the target |
| R7 (minor) | archiving left pending invitations listed that could only fail (409) | archive revokes them |

The X9 matrix was widened: five more principals (an Admin below the root, an Assistant of one subject, a Contributor above
the subjects, a member of the other university, a pending request on the stage), every resource type of the policy is
asked (types without a rule must be hidden from everyone), the route matrix gained the member decision and code creation
routes and a check that every channels route is covered, and the role / invitation ids join the «missing id» test. Race
guards (parallel joins on a 2-use code, parallel registrations on a single-use code, two approvers at once) passed before
and after.

## Review of step 3 — the web (2026-10-22)

Adversarial review (BUILD_PLAN §1.2) of the app shell, «القنوات», the subject page, the join sheet and QR scanner, the
invite landing, «أنا», «التنبيهات» and «إدارة القنوات», as a guest, a pending member, a student, a contributor, a Subject
Moderator, another subject's Admin and a removed member, on a 390 px phone, iPad mini / Air (portrait and landscape) and
desktop, at 100 % and 150 % text, light / dark / e-ink, online and offline. Each defect was reproduced first by a
failing test (`apps/web/test/channels/review-step3.test.tsx`, `e2e/aos-ac01a.spec.ts`, `e2e/aos-no-decorative.spec.ts`):

| # | defect | fix |
|---|---|---|
| R1 (major, honesty) | the subject page said «لم تبدأ دراستها» on every lecture and «بدأت دراسة 0 من N» whenever the viewer's own copies could not be read — on EVERY offline view (the copies were not kept with the page) and on a failed request — although the student had copies | the copies are kept with the page (`subject.<space>.copies`); while unknown the page claims nothing and says «تعذّر التحقق من نسخك…» |
| R2 (major, honesty) | the invite landing answered «الرابط غير صالح أو انتهت صلاحيته أو أُلغي — اطلب رابطًا جديدًا» when the preview could not be ASKED (no connection, rate limit, server error) | only a 404 is «invalid»; anything else says what happened, that the link was not refused, and offers «إعادة المحاولة» |
| R3 (major) | «الرموز والدعوات»: a new class code / invite link stayed on screen after the scope was changed — under the other node's «نطاقك» — and could be handed out for the wrong subject | the card shows only under the node it was made for and names it |
| R4 (major) | «الأعضاء وطلبات الانضمام»: ticked requests followed the admin into another scope or filter; «وافق على المحدد (1)» there approved someone never ticked there (same person pending in both) | the ticks belong to one list (node + status) |
| R5 (minor, AOS-23.3) | «المزيد من المحاضرات», «الأقدم» (subject page) and «المزيد» / «الأقدم» (members, «الإشراف», «سجل الإجراءات») did nothing offline or on an error (unhandled rejection) | disabled with the reason offline; an error is said in a toast |
| R6 (major, iPad first) | the five destinations, the bell and the save status made the top bar wider than an iPad in portrait (768 px → the page 832 px wide; 820 px → 832) and than EVERY iPad at 150 % text (up to 1109 px on a 768 px screen); the destination links and the search entry were 36 px tall on touch; on a phone at > 100 % text the brand link was 28 px wide | tablets (48–80rem) get a two-row top bar (`app/shell.css`; [design-system.md](../design-system.md) §5); every top-bar control ≥ 44 px on touch |
| R7 (minor) | a QR whose invite link was revoked showed the server's «المسار المطلوب غير موجود.» in the join sheet | «رابط الدعوة في هذا الرمز غير صالح أو انتهت صلاحيته…» |
| R8 (minor, honesty) | a subject (or a browsed child) whose policy is «بدعوة فقط» said «يتطلب رمز انضمام» and offered «انضم برمز أو QR», although the server accepts no code there | «الانضمام بدعوة فقط», no code entry |
| R9 (minor) | screens IA §3.2 places under «المراجعة» (`/questions`, `/exams`, `/practice`, `/cases`, `/planner`, `/weakness`, `/concepts`, `/knowledge`, `/terms`, `/explanation-rules`) marked no destination as current | `app/navigation.ts` |
| R10 (minor) | «الاستهلاك» called storage without a limit «بلا حد شهري» | «بلا حد للمساحة مضبوط على هذا الخادم.» |
| R11 (minor, test) | the no-decorative sweep stopped checking names and disabled reasons after 40 clicked controls (`break`); its self-test ran only on the public landing, where nothing runs in the background | the 40-click cap no longer skips the checks; a second self-test injects a dead and a reason-less control on `/channels`, `/me` and `/notifications` (the bell, sync and save status running) — caught every time (also probed 5 × per screen on 5 shell screens, phone and desktop) |

Also verified: every earlier screen is reachable (Settings, the Control Center and downloads through «أنا»; deep links
like `/settings#security` unchanged); the QR scanner asks for the camera only on «امسح رمز QR», stops the stream on a read,
on «أوقف الكاميرا», on closing the sheet and on leaving the page, and falls back to the field with an Arabic reason (no
API, refused, none, busy); keyboard path of the join sheet; e-ink screenshots of «القنوات», the subject page,
«الرموز والدعوات», «الشجرة», «أنا» and «التنبيهات» on a phone and an iPad mini (current tab by a bar and weight, switches
and QR readable). «الإشراف» now has its journey with a fixture report (`e2e/aos-p1-admin.spec.ts`: a published
explanation reported, hidden with a reason through the screen, author and reporter told, restored).

Reported, not fixed (minor): «الأدوار» offers only the first 50 approved members of the node itself (no search; members
of a node above cannot be picked); «قنواتي» is derived from the tree (≤ 500 nodes) and silently misses subjects beyond a
truncated tree (the note is shown only under «تصفّح» — `/api/accounts/me` returns no memberships, a contract matter);
row buttons in «الأعضاء» are disabled without a reason while another decision is running, and «أرشف» acts on nothing
while its impact is still being computed (both a second at most); on tablets the keyboard order is brand → destinations
(second row) → search / bell / save status (first row).

## Not done here (later steps or other owners)

* **Whole-instance backups still leave out `spaces/*.sqlite` (P1-T1's `modules/data/backups.ts` /
  `backup.ts`; confirmed in review with a probe of `instanceBackupSources`).** P1-T5 step 1 now stores official lectures
  in those spaces, so this is a data-loss gap for GATE-1 (DoD item 9), not only a step-1 note.
* An Admin or Assistant of a subject cannot remove a student whose membership is inherited from the stage (the decision
  route acts on memberships ON the node, 404 otherwise); only the stage's approvers can. Whether a subject's approvers
  may exclude an inherited member (a `removed` row on the subject) is a question for the owner.
* `Idempotency-Key` (ARCHITECTURE_DELTA §7.1 «server-generated creations») is not honoured by `POST /nodes` or
  `POST /nodes/:id/codes`: a retried request on a flaky phone network makes a second node (and space file) or code.
* Codes of a node whose policy became `closed` stay listed as live although they no longer work.
* Registration with an open, unlimited code creates an account and a vault file per request (120 a minute per
  address); a per-code creation rate is not enforced (admins see `use_count`).
* ~~Notifications to the requester and the approvers~~ — step 2: `join_requested` to the node's approvers (the platform
  admins when the chain has none) for every join or registration that waits for approval, `join_decided` to the member
  for every approve / reject / remove, `invitation` to the invitee once per invitation.
* ~~Course follow routes~~ — step 2: `PUT / DELETE /api/channels/subjects/:id/follow` (members only; the folder must be
  the follower's own; idempotent unfollow). Following does not end when a membership is removed: the fan-out and the
  inbox check access, so a removed follower hears nothing until re-admitted.
* ~~Security-audit view, moderation~~ — step 2 (`modules/moderation`). ~~Web screens~~ — step 3.
* Step 3 web, not built: sending invitations to named people (the route exists; the admin screens offer codes and links
  only — a person picker needs a directory search the plan does not give); the moderator names on the subject header
  (the roles list needs `manage_members`); «امسح بيانات هذا الجهاز» and the AI-consent rows of «الخصوصية والبيانات»
  (no route yet); web push (the inbox says why it is not offered); the platform area «المنصة»; «قنواتي» comes from the
  tree (depth 7, at most 500 nodes — `truncated` is said) because `/api/accounts/me` lists no memberships.
* Device runs: Not run (no device) — the camera scanner on a real phone, iPad / Pencil, BOOX, VoiceOver and TalkBack, iOS
  push; headless Chromium's fake camera and refused camera are what was run.
* `GET /api/accounts/me` still returns `memberships: []` / `roles: []` (P1-T1's file; the tree's `viewer` fields carry
  the same information).
* A server secret change (restore onto a new host, which regenerates `secret.key`) invalidates every outstanding class
  code and invite link (their HMAC key derives from it); admins issue new ones.
