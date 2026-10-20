# Academic OS on MedLevo — Information Architecture and User Journeys

> **Status:** draft v2 for owner review · 2026-10-20 · revised after the adversarial design review (outcomes in the Review
> log at the end of `ARCHITECTURE_DELTA.md`). Phases follow [PRD §5](PRD.md#5-release-plan-spec-23-phases) only.
> **Companion of** [`PRD.md`](PRD.md) — requirement ids (`AOS-…`), phases, roles and owner questions (`Q…`) refer to it.
> **Design system:** extends [`docs/design-system.md`](../design-system.md) and `apps/web/src/design/`; MedLevo keeps its own
> identity (calm, Apple-inspired clarity but original: neutral canvas, warm paper, one indigo ink accent).
> **Clean-room:** layouts, flows and wording here are MedLevo's own, designed from the owner's spec. No other app's screens,
> layouts, icons, templates, text or assets are copied or used as reference material.

## Contents

1. [IA principles](#1-ia-principles)
2. [The object model as the student sees it](#2-the-object-model-as-the-student-sees-it)
3. [Navigation map](#3-navigation-map)
4. [Key screens](#4-key-screens)
5. [Integration with existing MedLevo screens](#5-integration-with-existing-medlevo-screens)
6. [User journeys](#6-user-journeys)
7. [State handling](#7-state-handling)
8. [Design-system additions](#8-design-system-additions)
9. [Responsive and device behaviour](#9-responsive-and-device-behaviour)
10. [Accessibility and RTL on the new surfaces](#10-accessibility-and-rtl-on-the-new-surfaces)
11. [IA decisions and open questions](#11-ia-decisions-and-open-questions)

---

## 1. IA principles

1. **One reader, one ink engine.** Every way of looking at a lecture opens in the existing workspace (`/study/:sourceId`):
   the student's own copy, a followed or forked copy, a read-only preview of a published explanation, a collaborative copy,
   a room and a replay. There is no second document viewer and no second ink engine.
2. **Two worlds, one bridge.** «مساحتي» (my space: library, notebooks, copies, review, plans) is private. «القنوات» (channels:
   official lectures, explanations, discussions, rooms) is shared. Content crosses between them only through named actions:
   «ابدأ الدراسة», «تابع المادة», «انشر», «احفظ», «انسخ إلى ملاحظاتي».
3. **Personal first, social second.** Home stays the student's own study dashboard. The community is one tap away, never the
   landing screen, and there are no vanity counters (spec §20 calm design; design-system §6).
4. **Origin is always visible.** Every item says what it is — رسمي, شرح طالب, راجعه مشرف, مولّد آليًا, ملاحظاتي,
   قال الدكتور في التسجيل — in text with an icon, never by colour alone.
5. **Writing never waits.** No navigation, sync, AI or room state blocks the pen. Background events arrive as quiet chips
   and inbox entries, never as modals over the page.
6. **Phone parity, tablet-first writing.** Every task can be done on a phone; writing and the richest layouts are designed
   for the tablet first.
7. **Honest states.** Every state has a name, a reason and a next action (§7). Nothing pretends to work.

## 2. The object model as the student sees it

```
Channel tree (shared, admin-owned)
University ▸ College ▸ Department ▸ Stage ▸ Academic Year ▸ Semester/Course ▸ Subject
                                                                              │
Subject «Anatomy» ─ members & roles · attachments · exam dates · rooms · updates
   └─ Lecture 5 «Anatomy of the Abdomen»          (stable lecture identity, AOS-19H)
        ├─ Official versions  v1 · v2 …           رسمي — immutable, published by a moderator
        ├─ Attachments        ملخصات · أسئلة سنوات سابقة · مراجع
        ├─ Recordings         shared only with consent and a scope
        ├─ Explanations       شرح حسن (الإصدار 3) · شرح علي (الإصدار 1) …   = publications (snapshots)
        ├─ Discussions        questions anchored to pages / regions / drawings
        └─ Rooms              silent · group · teaching · exam

My space (private vault)
   └─ Lecture 5 (stub of official v2 — no file duplicated), with one or more copies:
        ├─ «نسختي»                     official layer (read-only) + ملاحظاتي
        ├─ «متابَعة: شرح حسن»          official layer + «شرح حسن» (read-only, updates arrive) + ملاحظاتي
        └─ «مستقلة: شرح علي (الإصدار 1)» official layer + forked layer (mine, frozen origin) + ملاحظاتي
   each «ملاحظاتي» = personal layer(s): ink, highlights, text, stickies, audio clips
   group comments / suggestions are visible only inside the subject
```

The words the student sees for copies: **نسختي** (my copy), **نسخة متابَعة** (followed), **نسخة مستقلة** (independent
fork), **نسخة تعاونية** (collaborative). Each copy holds one personal layer and at most one copied explanation layer, as
in `ARCHITECTURE_DELTA.md` §6.5. A student may keep several copies of one lecture (for example her own and one following a
classmate). To stop notes from scattering, the IA always **groups the copies under the lecture** (library row, lecture page
header, copy chip), the Start Studying sheet offers to **open an existing copy first**, and «انسخ الطبقة» moves personal
notes between copies with attribution kept. A collaborative copy is a shared document that lives in the subject and is
listed on the lecture page (Phase 4); the student's private notes beside it stay in her own personal layer.

## 3. Navigation map

### 3.1 Primary destinations

Today's shell has four destinations (الرئيسية / المكتبة / المراجعة / الإعدادات). The Academic OS needs a home for the shared
world, so the shell gets **five**, the most a phone tab bar holds comfortably:

| # | destination | Arabic | holds | change |
|---|---|---|---|---|
| 1 | Home | **الرئيسية** | personal dashboard: continue, today's plan, cards due, next exam, weak points, «من موادك», active rooms, latest radar | extended |
| 2 | Library | **المكتبة** | my library tree, notebooks, «موادي من القنوات», smart collections, favourites/recent/archive/trash | extended |
| 3 | Channels | **القنوات** | my channels, browse tree, subject and lecture pages, explanations, feed, rooms, join | **new** |
| 4 | Review | **المراجعة** | cards, revision, questions, exams, planner and Exam Mode, weak points, Exam DNA, radar dashboards | extended (existing hub) |
| 5 | Me | **أنا** | profile, my publications, following, settings, Control Center, privacy and data, devices, usage, channel administration (with a role) | **new**; **الإعدادات moves here** |

* **Phones:** bottom tab bar with these five labelled items. **Tablet/desktop (≥ 48rem):** the existing slim translucent top
  bar with the same five. No permanent sidebar (design-system §5).
* **Top bar, always:** search entry (`/` or Ctrl/⌘K opens the command palette, which includes search), **التنبيهات** (bell
  with a text count, not a red blob), the offline indicator, the save status, and — while recording anywhere — a live pill
  «يُسجَّل · 12:04» that returns to the recording.
* `/study/…` stays full-bleed without the shell (design-system §5).
* Moving «الإعدادات» into «أنا» changes `PRIMARY_DESTINATIONS` in `app/AppShell.tsx`. This **partly supersedes** the
  old workspace/navigation requirement (ARCHITECTURE_DELTA §15.2 row 23), so these existing tests change in the same
  commit and are listed in the Phase 1 report: `e2e/smoke.spec.ts` (clicks `nav('الإعدادات')`, line 158) and
  `e2e/g1-ac01-personal-library.spec.ts` (asserts exactly الرئيسية / المكتبة / المراجعة / الإعدادات, line 103; that spec
  becomes AC-01a/01b anyway). Web unit tests that open Settings through the navigation are re-checked.

### 3.2 Map

Routes are proposals for the API/route design written in parallel; the existing ones are kept exactly.

```
الرئيسية  /
├─ تابع الدراسة · خطة اليوم · البطاقات المستحقة · الامتحان القادم · نقاط الضعف · أسئلة مهمة      (existing sections)
├─ من موادك            updates from followed subjects and explainers → «عرض الكل» /feed              (Phase 1 updates, Phase 2 people)
├─ غرف نشطة الآن        rooms in my subjects                                                          (Phase 4)
└─ رادار آخر محاضرة     → /lectures/:lectureId/radar                                                  (Phase 3)

المكتبة  /library
├─ مكتبتي              /library, /library/:nodeId                                (existing personal tree)
├─ موادي من القنوات     followed subjects → my copies and new-lecture stubs       (Phase 1)
├─ مجموعات ذكية         /library/collections/:key                                 (Phase 2)
├─ الموضوعات            /library/topics, /library/topics/:topicId                  (existing)
├─ دفتر                 /notebook/:nodeId                                         (existing)
└─ المفضلة · الأحدث · الأرشيف · المهملات                                          (existing views)

القنوات  /channels
├─ قنواتي               memberships, pending requests, «انضم برمز أو QR»
├─ تصفّح                /channels/:nodeId — University → … → Stage → Year → Course (breadcrumbs)
├─ صفحة المادة          /subjects/:subjectId
│    tabs: المحاضرات · الملفات (Phase 1) · النقاشات (Phase 2) · التسجيلات (Phase 3) · الغرف (Phase 4) · التحديثات (Phase 1)
├─ صفحة المحاضرة        /lectures/:lectureId
│    tabs: الرسمي · الشروحات · النقاشات · التسجيلات
│    └─ رادار الامتحان  /lectures/:lectureId/radar                               (Phase 3)
├─ صفحة الشرح           /p/:publicationId                                         (Phase 1 course-only)
├─ الجديد               /feed                                                     (Phase 2)
├─ الغرف                /rooms, /rooms/:roomId, «انضم إلى غرفة قريبة»            (Phase 4)
└─ رابط الانضمام         /join/:token  (landing: channel title only, via the public preview; then sign-in)

المراجعة  /review                                                               (existing hub)
├─ البطاقات /review/cards · جلسة /review/session · المراجعة السريعة /review/revision · DNA /review/dna · ملفي التعلمي /review/profile
├─ الأسئلة /questions · الامتحانات /exams · التدريب /practice · الحالات /cases
├─ التخطيط /planner · وضع الامتحان /planner/new?mode=exam                         (Phase 3)
├─ نقاط الضعف /weakness · المفاهيم /concepts · خريطة المعرفة /knowledge
└─ المصطلحات /terms · قواعد الشرح /explanation-rules

أنا  /me
├─ ملفي الشخصي          /u/:handle (as others see it) · تعديل                       (Phase 2)
├─ منشوراتي              my publications, drafts, versions, comments received
├─ أتابع / يتابعونني                                                              (Phase 2)
├─ الإعدادات             /settings                                                 (existing; adds e-ink + high contrast)
├─ مركز التحكم          /control/…                                                (existing, per user)
├─ الخصوصية والبيانات    /me/privacy — export, delete account, AI data choice, consent records
├─ أجهزتي               /me/devices — sessions, devices, «احذف بيانات هذا الجهاز»
├─ الاستهلاك             /me/usage — storage, AI and transcription allowances
├─ إدارة القنوات         /admin/…  (visible only with a role)
└─ المنصة               /platform/…  (platform admin only: AI provider, budgets, evaluation incl. ASR, health, client errors, processing queue, backups)

Outside the shell
├─ مساحة الدراسة          /study/:sourceId  (+ copy, layers, room, replay state)     (existing)
├─ إعادة العرض            /replay/:recordingId                                      (Phase 3)
├─ التسجيل والتفريغ        /media/audio/:audioId  (+ timeline)                       (existing, extended)
├─ البحث                 /search  (+ «ابحث بصورة»)                                  (existing, extended)
├─ التنبيهات              /notifications
└─ الدخول               /login · /setup (first run only) · /recover                (existing)
```

### 3.3 Route inventory

| route | status | notes |
|---|---|---|
| `/`, `/library…`, `/notebook/:nodeId`, `/study/:sourceId`, `/review…`, `/questions…`, `/exams…`, `/practice`, `/cases…`, `/planner…`, `/weakness…`, `/concepts…`, `/knowledge`, `/terms`, `/explanation-rules`, `/explanations/:artifactId`, `/media…`, `/search`, `/upload`, `/sources/:sourceId`, `/offline`, `/settings`, `/control/…`, `/login`, `/setup`, `/recover` | **kept** | Same URLs; now scoped to the signed-in user's vault (and permitted spaces where stated). |
| `/channels`, `/channels/:nodeId`, `/subjects/:subjectId`, `/lectures/:lectureId`, `/lectures/:lectureId/radar`, `/p/:publicationId`, `/feed`, `/rooms`, `/rooms/:roomId`, `/join/:token`, `/u/:handle`, `/me…`, `/notifications`, `/replay/:recordingId`, `/library/collections/:key`, `/admin/…`, `/platform/…` | **new** | `/join/:token` is the only new screen reachable before sign-in. It shows only the channel's title, read from the rate-limited public `GET /api/channels/join/preview?token=` (ARCHITECTURE_DELTA §7.3; one of the two routes ADR-0003 §3.10 adds to the g8 list); an invalid or expired token shows the same generic message (AOS-2.13). |

New screens live in the web feature folders named by `ARCHITECTURE_DELTA.md` §2: `features/channels` (channels home,
subject and lecture pages, marketplace list, join flows, QR), `features/copies` (Start Studying chooser, update preview,
compare copies), `features/admin`, `features/profile`, `features/feed`, `features/discussions`, `features/rooms`,
`features/timeline` (replay, time machine), `features/copilot` (calm side panel, radar dashboard) and
`features/notifications`; the workspace, search, media, review, planner, home, upload, settings and auth features are
extended in place.

## 4. Key screens

Descriptions are structural; visual design follows §8 and the existing design system.

### 4.1 Channels home «القنوات»

* **قنواتي** — grouped list of the user's subjects by university/stage, each row with the subject name, unread updates as
  text («إصداران جديدان»), and the user's role when it is not Student.
* **طلبات معلّقة** — joins waiting for approval («طلبك قيد المراجعة»).
* Primary action **«انضم برمز أو QR»** opens a sheet: code field (LTR input, base32 groups), «امسح رمز QR», paste link.
* **تصفّح** — the channel tree with breadcrumbs; nodes the user cannot enter show the name only and «يتطلب رمز انضمام».
* Empty state: «لم تنضم إلى أي مادة بعد» + the join action + a short line: «مكتبتك الشخصية تعمل كما هي دون قنوات».

### 4.2 Subject page «صفحة المادة» — `/subjects/:subjectId`

Header: subject name, breadcrumb (University › … › Course), «تابع المادة» toggle («تتابعها — تضاف محاضراتها الجديدة إلى
مكتبتك»), my progress line (separate measures with real counts), moderator names, and from Phase 2 the moderator-published
exam dates («الامتحان النهائي · 12 كانون الثاني»; `subject_exam_date`).

| tab | content |
|---|---|
| **المحاضرات** | Official lectures sorted by number then date: «المحاضرة 5 · 14 تشرين الأول · الإصدار 2». Row badges: «إصدار جديد», «لم تفتحها», «لديك نسخة». Row action «ابدأ الدراسة» / «تابع». |
| **الملفات** | Attachments by type (ملخصات, أسئلة سنوات سابقة, مراجع), each with origin and uploader (`subject_attachment`, Phase 1). Contributors' uploads show «بانتظار موافقة المشرف» until approved. |
| **النقاشات** | Subject-wide questions (Phase 2), filter by lecture, «غير مُجاب» / «مقبول». |
| **التسجيلات** | Recordings shared to the subject with their scope («استماع فقط» / «استماع وتنزيل») and consent note (Phase 3). |
| **الغرف** | Scheduled and active rooms (Phase 4). |
| **التحديثات** | Chronological changes read from `subject_event` (Phase 1): new lecture, new version, new attachment, and from Phase 2 exam dates — each linking to its place. |

Moderator-only controls (same page, role-gated): «ارفع محاضرة», «ارفع إصدارًا جديدًا», «أضف ملفًا», «أضف موعد امتحان»
(Phase 2), «سياسة تسجيل المحاضرات» (Phase 3, the lecturer recording policy of PRD Q8), «إدارة المادة» → admin area.

### 4.3 Lecture page «صفحة المحاضرة» — `/lectures/:lectureId`

Header: «المحاضرة 5 — Anatomy of the Abdomen», date, «رسمي» badge with publisher and version, page count; primary split
button **«ابدأ الدراسة»** (or **«افتح نسختي»** when a copy exists) with a secondary menu «ابدأ بشرح زميل…».

| tab | content |
|---|---|
| **الرسمي** | Versions list with change notes and «قارن الإصدارات»; original vs converted file (AOS-3.14); linked past-exam questions with key status («مفتاح من المصدر» / «غير محسوم»); the official Study Book if generated (labelled generated). |
| **الشروحات** | Published explanations visible to me (Phase 1 list; Phase 2 sorts: الأكثر استخدامًا · الأعلى تقييمًا · الأحدث · الأكثر اكتمالًا · للمراجعة السريعة · الأكثر توثيقًا). Each row: author, version, completeness «ص 34 من 40», rating «4.3 · 28 تقييمًا», «راجعه مشرف» if so, «لماذا هذا الترتيب؟». Banner at top: «شروحات الطلاب ليست مصدرًا رسميًا». |
| **النقاشات** | Anchored questions for this lecture, sorted by page; each opens at its page and region (Phase 2). |
| **التسجيلات** | Recordings of this lecture the user may hear; timeline and radar links (Phase 3). |

**Start Studying sheet** «كيف تريد أن تبدأ؟» (AOS-2.18/2.19):

| option | plain-language consequence shown |
|---|---|
| **نسختي فقط** | «صفحات المحاضرة الرسمية وطبقة لملاحظاتك. خاصة بك.» |
| **نسخة متابَعة لشرح…** | «ترى شرح الزميل فوق المحاضرة وتصلك تحديثاته. لا يستطيع أحد تعديل ملاحظاتك أو رؤيتها.» |
| **نسخة مستقلة من شرح…** | «تأخذ نسخة من الشرح كما هو الآن وتعدّل عليها بحرية. لن تصلك تحديثاته.» |

Choosing an explanation shows a read-only preview in the workspace first. If the user already has copies of this lecture,
the sheet lists them first («افتح نسختي» · «افتح: متابَعة شرح حسن») so a new copy is always a deliberate choice; when a new
copy is created, the sheet offers «انقل ملاحظاتي من نسختي إليها» (copy one layer with attribution, AOS-4.11 — **Phase 1**,
with a preview of the item count; the old copy keeps its notes). If the user has a **private upload** of the same file
(sha256 or page-fingerprint match), the sheet also offers «اربط ملفك الخاص بهذه المحاضرة» (§4.15).

### 4.4 The workspace — additions to `/study/:sourceId`

The reader, ink toolbar, Study Rail (الشرح والسؤال · الأسئلة · حالات · المصادر · ملاحظاتي), left panel (الصفحات · الفهرس ·
العلامات), study modes (تعلّم · افهم · تدرّب · راجع · امتحن نفسك), split view, Study Book pane, selection toolbar, recording
bar and focus mode all stay. Added:

| element | where | behaviour |
|---|---|---|
| **Copy chip** | top bar next to the title | «نسختي · الإصدار 2» / «متابَعة: شرح حسن · الإصدار 3» / «نسخة مستقلة من شرح حسن (الإصدار 1)» / «تعاونية · 4 يكتبون». Opens copy details (versions, origin, «انقل ملاحظاتي»). |
| **Version banner** | below the top bar, inline | «يوجد إصدار أحدث من المحاضرة» → «انقل ملاحظاتي» (J5); «تحديث متاح من حسن» → «اعرض التغييرات» (J3). Never modal; dismissible; remembered. |
| **Layers tab «الطبقات»** | fourth tab of the left panel; sheet on phones | Rows: official (lock icon), followed explanations (lock), my layers (writable; one is «الطبقة النشطة»), group comments, suggestions. Each row: visibility toggle, author, origin badge, menu: «انسخ الطبقة إلى نسخة أخرى» and «سجل الطبقة» (Phase 1), «انشر» (Phase 1, course-only), «ادمج طبقات» and «قارن» (Phase 2), «أخفِ من هذه الصفحة». A menu item of a later phase is not shown before its phase (no decorative controls, AOS-23.3). «طبقة جديدة» creates another personal layer (e.g. «إجابات» for self-testing). |
| **Discussion pins** | on the page, at anchors | Small numbered markers; toggled by the «تعليقات المجموعة» layer; each has a list twin in the rail. |
| **Rail section «النقاش»** | Study Rail (Phase 2) | Questions on this page first, then the lecture; composer «اسأل زملاءك» attaches the current selection as the anchor. |
| **Rail section «المباشر»** | Study Rail, only while recording or in a room (Phase 3/4) | Live transcript line, detected cues as quiet cards, «أضف لملاحظاتي», copilot answers with citations or abstention. |
| **Recording dock** | existing bottom dock | Adds «علّم لحظة», storage left, a one-line live transcript when configured, and a timeline toggle. |
| **Room bar** | top of the page area (Phase 4) | Presence avatars + count, «اتبع المضيف» / «تنقّل حر», raise hand, connection state, room menu. |
| **Replay transport** | bottom dock in replay mode | Play/pause, speed, «أخفِ الصوت» / «أخفِ الكتابة», timeline scrubber with markers (pages, cues, chapters). |
| **Publish** | Layers row menu → «انشر هذا الشرح» | Visibility picker (default «أعضاء المادة»), title, notes, tags («للمراجعة السريعة»), preview listing exactly what is published (only that layer — never «ملاحظاتي» unless it is the chosen layer). |
| **Document tabs** | above the page (AOS-1.27) | Up to 8+ open documents with restored places; Ctrl/⌘+1…9. |

Study modes keep arranging the same tools. In **«امتحن نفسك»** explanation layers, discussions and the copilot are hidden
together with the existing hidden explanation tools, with the existing reason line (`EXAM_MODE_HIDDEN_AR` extended).

### 4.5 Publication page «صفحة الشرح» — `/p/:publicationId`

Read-only preview (opens the workspace in preview mode), author, version history with change notes, completeness,
actions «ابدأ الدراسة بهذا الشرح» (follow or fork) and **«أبلغ»** (Phase 1: reason list incl. «معلومات مريض» and «حقوق نشر»;
the reporter later sees «تمت المراجعة»). From Phase 2: follow button, rating summary and rating input (members of the
subject only), comments, «احفظ», «شارك» (in-app link to authorised viewers only), «اقترح تصحيحًا», and «راجعه مشرف المادة ·
التاريخ» when a Subject Moderator reviewed it. Banner: «شرح طالب — ليس مصدرًا رسميًا». A signed-in non-member who opens a
public explanation sees its items over page placeholders that show the page labels, with «الملف الأصلي متاح لأعضاء المادة
فقط» and a join action; highlights show without the quoted page text and page snapshots show «صورة من الملف الأصلي —
لأعضاء المادة» — the official file stays members-only (PRD Q5).

### 4.6 Profile «الملف الشخصي» — `/u/:handle` (Phase 2)

Display name, optional academic fields (each with its own visibility), follower count (exact), «تابِع» / «تابِع في مادة
واحدة», published explanations visible to the viewer, series, subjects published in, contributions (accepted corrections and
answers). A profile is private by default: others see only the name until the owner opens fields.

### 4.7 Feed «الجديد» — `/feed` (Phase 2)

Chronological by default, filtered to followed subjects and people; each item says why it is there («لأنك تتابع
المادة» / «لأنك تتابع حسن»). Paginated with an end («وصلت إلى آخر الجديد»), no infinite scroll, no like counts in the list.

### 4.8 Rooms — `/rooms`, `/rooms/:roomId` (Phase 4)

* List: rooms in my subjects (active now, scheduled), «غرفة جديدة» (kind: هادئة / جماعية / شرح / امتحان, lecture, privacy;
  any member may create a teaching or exam room for invited people, course-wide rooms need a moderator), «انضم إلى غرفة
  قريبة». Online rooms through the server come first; offline rooms follow (ADR-0005 Part A).
* **Offline join** works on the same Wi-Fi or hotspot without internet: the host shows **a fresh QR for each joiner** and
  scans that joiner's answer QR («امسح رمز كل زميل بدوره»). A short room code works only when the internet or a classroom
  hub is reachable, and the screen says so («الرمز يحتاج اتصالًا بالإنترنت أو بجهاز القاعة»). Thirty devices per host is
  the default and is **untested** («لم يُختبر بعد على 30 جهازًا»). A device that has not fetched its room pass while online
  sees «جهّز الغرفة وأنت متصل بالإنترنت أولًا» and cannot join offline. While hosting, the app keeps the host's screen awake
  and says why («أبقِ الشاشة مفتوحة — أنت تنقل الغرفة للآخرين»).
* **Silent room:** timer, people present (count; names only if they allow), my goal, optional break alerts.
* **Group / teaching rooms:** open the workspace with the room bar (§4.4).
* **Exam room:** see §4.21.
* Every room states what it shares before joining: «ستستلم: … · لن يُرسل شيء من ملفاتك».

### 4.9 Notifications «التنبيهات» — `/notifications`

One inbox for: join decisions, new lectures and versions in followed subjects, followed-explanation updates, replies,
accepted answers, moderation outcomes, suggestions to my explanations, radar ready, ASR finished, quota warnings. Grouped
by day, each with its target link and «علّم كمقروء». Push is optional and honestly gated («الإشعارات خارج التطبيق غير
مدعومة على هذا الجهاز» on iOS PWA when unavailable).

### 4.10 Channel administration «إدارة القنوات» — `/admin/…`

Reached from «أنا» only with a role; every screen shows its scope («نطاقك: كلية الطب › المرحلة الثالثة»). Built from the
Personal Control Center's patterns (grouped lists, review-item screen, impact preview, history) without merging the two areas.

| section | content | phase |
|---|---|---|
| الشجرة | create/rename/move nodes, impact preview before delete | 1 |
| الأعضاء وطلبات الانضمام | pending, approved, removed; bulk approve | 1 |
| الرموز والدعوات | codes, QR, links: expiry, uses, revoke | 1 |
| الأدوار | assign per node, inheritance shown | 1 |
| المحتوى الرسمي | drafts awaiting approval, versions, corrections, original vs converted | 1 |
| الملفات المكررة | identical and near-duplicate files in scope | 1 |
| الإشراف | **Phase 1:** reports on publications → «أبقِ» (dismiss) / «أخفِ مع السبب» / «أعِد الإظهار», with the author and reporter notified and an audit entry. **Phase 2:** publications awaiting approval before «عام», «اطلب تعديلًا», «راجعه مشرف المادة» (Subject Moderators only — Assistants see it disabled with «يمنحها مشرف المادة فقط»), suggested corrections, appeals, reports on discussions and profiles | 1 / 2 |
| الملفات والمواعيد | subject attachments (approve contributors' drafts), exam dates (Phase 2) | 1 / 2 |
| سجل الإجراءات | audit log filtered by scope; no private content | 1 |
| الإحصاءات | usage and quality with privacy thresholds | 2 |

**المنصة — `/platform/…` (platform admin only).** A separate area for the operations that act on the whole deployment
(ARCHITECTURE_DELTA §5.8), moved out of the per-user Control Center: AI provider and models, deployment and per-space
budgets and quotas, the ASR engines and their evaluation (§4.22), system health, the client-error list, the global
processing queue, whole-instance backups, restore and export. Every screen carries «تؤثر على المنصة كلها».

### 4.11 Exam Radar «رادار الامتحان» — `/lectures/:lectureId/radar` (Phase 3)

List of exam cues for one lecture: quote (as said, bidi-isolated), time «23:10», page «ص 7», status
(«قال الدكتور في التسجيل» answer / «لم يذكر الدكتور الإجابة» / «إجابة مولدة بمصادر»), actions (استمع, افتح الصفحة, أنشئ بطاقة,
أضف إلى قائمة المراجعة المقترحة). Header line: «مؤشرات من كلام الدكتور — ليست توقعًا لأسئلة الامتحان». Counts with
denominators («3 إشارات في 52 دقيقة»).

### 4.12 Recording and timeline — `/media/audio/:audioId` (extended)

Player (speed, skip silence, next/previous part) + **TimelineTrack** lanes: pages shown, ink, highlights, notes, photos,
cues, chapters; transcript list beside it with the current segment highlighted; «افتح الصفحة في هذه اللحظة»; consent and
scope panel for sharing. «شارك مع المادة» is enabled only when the subject has a lecturer recording policy allowing that
scope (else «لا توجد موافقة من الدكتور على مشاركة التسجيلات في هذه المادة — اطلبها من مشرف المادة»), and then asks the
recorder's own confirmation for this share (PRD Q8). Features that send audio or its transcript outside the deployment
(cloud transcription, copilot answers, translation) show which provider and are off unless the policy allows external
processing and the user consented. For the owner, «استخدمه للتقييم» marks a time range as an ASR evaluation sample (§4.22).

### 4.13 Search «البحث» — `/search` (extended)

Same results UI with scope chips: **ملفاتي · موادي · الشروحات · النقاشات · التسجيلات**, origin labels on every hit, «ابحث
بصورة» (camera or file) producing ranked pages with a confidence label and its basis, and abstention text when nothing
matches. Student explanations and discussions are grouped under «من الطلاب — ليست مصادر».

### 4.14 Me › privacy and data «الخصوصية والبيانات» — `/me/privacy`

Export my data («نسخة من بياناتي»), delete my account (impact preview: what is deleted; that my publications leave
listings; that my name shows «طالب سابق» everywhere; and, plainly, that forks others already made are **not** erased),
**AI processing consent** naming each provider my notes, handwriting crops or transcripts may be sent to
(«لا يُرسل شيء من ملاحظاتك إلى مزوّد خارجي دون موافقتك»), cloud-transcription consent (names the provider), consent
records I gave or collected, visibility defaults, «امسح بيانات هذا الجهاز عند الخروج». A short operator note: «لا تعرض أي
شاشة في التطبيق بياناتك الخاصة لمستخدم آخر أو لمشرف. من يدير الخادم يستطيع تقنيًا الوصول إلى الملفات والنسخ الاحتياطية،
وتُشفَّر النسخ قبل خروجها من الخادم.»

### 4.15 Link my existing lecture to the official one «اربط بالمحاضرة الرسمية» (Phase 1, AOS-19H.3 / 19H.4)

* **Entry points:** a library row badge «موجودة رسميًا في Anatomy» on a private upload whose file or pages match an
  official lecture the user can see; the lecture page and the Start Studying sheet («اربط ملفك الخاص بهذه المحاضرة»).
* **Sheet:** «وجدنا هذه المحاضرة في مادة Anatomy (تطابق الملف كاملًا / تطابق 37 من 40 صفحة)». Plain consequence:
  «ستُنسخ كتاباتك وملاحظاتك إلى المحاضرة الرسمية في نسختك الخاصة. يبقى ملفك الأصلي كما هو حتى تحذفه أنت.» Buttons
  «اربط وانسخ ملاحظاتي» / «ليس الآن».
* **Progress and result** reuse the note-migration report of J5: «نُسخ 212 عنصرًا · يحتاج مراجعة 4 · ملفك الأصلي لم يتغير».
* **Moderators** (and the platform admin holding the role) see on their own private lecture «انشرها كمحاضرة رسمية في
  المادة…»: subject picker, title, number; the file is registered without copying bytes; afterwards the same link runs for
  their own notes, which stay private until they choose «انشر هذا الشرح».
* **States:** no match → nothing is shown; ambiguous match (two lectures) → both listed with their basis; offline →
  «يحتاج اتصالًا».

### 4.16 The AI pen menu «قلم الذكاء» (Phase 2, spec §10)

The 17 actions of spec §10 must not flood the page, so one menu, grouped, with honest disabled states:

* **Entry:** lasso or text selection → the existing selection toolbar shows at most **three** direct actions chosen by
  what is selected (printed text: «اشرح ببساطة», «ترجم», «عرّف»; handwriting: «حوّل إلى نص», «اشرح», «بطاقة»; figure:
  «اشرح الصورة», «اختبار إخفاء», «ابحث عن مشابه») and a «المزيد» button that opens the full menu as a popover (bottom sheet on
  phones).
* **Groups in the full menu:** افهم (اشرح ببساطة · خطوة بخطوة · لخّص · عرّف · اشرح الرسم · قارن الشروحات) · تدرّب (أسئلة
  اختيار · بطاقات · اختبار إخفاء · أضف إلى المراجعة) · لغة (ترجم مع الإبقاء على المصطلحات · صحّح الكتابة · حوّل إلى نص) ·
  ابحث (محاضرات مرتبطة · مصادر موثقة) · صوت (اقرأ بصوت · النطق · أرفق ملاحظة صوتية — Phase 3/5).
* **Disabled reasons**, never hidden silently: «غير مُعدّ: لا يوجد مفتاح ذكاء اصطناعي», «يحتاج قراءة الكتابة أولًا», «لا
  يوجد صوت عربي على هذا الجهاز», «بلغت حصتك الشهرية». Actions of a later phase are not listed (AOS-23.3).
* **Results** open in the Study Rail's «الشرح والسؤال» section with origin chips; nothing is inserted into a page without
  a tap («أضف إلى ملاحظاتي»), and inserted results carry «مولّد آليًا».
* Keyboard: the menu is a `menu` with groups; first letters jump; Esc closes and returns focus to the selection.

### 4.17 History, time machine and copy comparison (Phase 1 history list; Phase 2 the rest)

* **«سجل الطبقة»** (Phase 1) from the layers row menu: a day-grouped list (author, time, action «أضاف 12 خطًا ص 4»,
  «حذف ملاحظة», «طُبّق تحديث شرح حسن الإصدار 3»), filter by page. Read-only in Phase 1.
* **Time machine** (Phase 2, AOS-4.16 / 13.12): from the history list or the copy chip, «اعرض كما كانت في…» opens the
  workspace read-only at time T with a top bar «تعرض حالة 3 تشرين الثاني 14:20 — للقراءة فقط» and a time slider by day and
  by change. «استعد هذه الحالة» asks for confirmation and writes a **new** state («لن يُحذف شيء من السجل»).
* **Compare copies** (Phase 2, AOS-4.13): from the copy chip «قارن مع…» → pick another copy or a publication version; the
  split view shows the same page twice, paging synchronised, with `DiffLegend` («أُضيف» solid outline · «حُذف» dashed ·
  «نُقل» arrow) and a change list twin in the rail.

### 4.18 The course-wide tutor «مدرّسي» (Phase 5, spec §14)

* **Entry:** the Study Rail's «الشرح والسؤال» section gains a scope chip «هذه المحاضرة ▾» whose menu adds «كل محاضرات
  المادة التي لديّ» and «محاضرات أختارها…»; the subject page has «اسأل عن المادة» opening the same thread.
* **Thread** shows the scope permanently («النطاق: 8 محاضرات من Anatomy + مراجعي»), each answer's chips (رسمي · مرجع ·
  قال الدكتور في التسجيل · مولّد آليًا) and the abstention reasons of K5. Settings: level, dialect, «استخدم ملاحظاتي»
  (off by default; with `ai_processing` consent).
* **No hidden widening:** changing the scope is a visible action recorded in the thread («وسّعتَ النطاق إلى…»).

### 4.19 Cross-course knowledge graph (Phase 5, spec §16)

* **Entry:** المراجعة › «خريطة المعرفة» gains a level switch «هذه المادة · كل موادي»; a concept page gains «في مواد أخرى».
* **Screen:** the existing graph with paging beyond 60 concepts and its text twin; nodes from other subjects carry the
  subject name; relations show their origin (مؤكَّد · مقترح آليًا · مطابقة بالاسم) as text.
* **Concept page:** «شُرح سابقًا في…», related lectures, questions, figures, my notes («مطابقة بالاسم»), visible published
  explanations, my state with its basis.

### 4.20 Where the other next-generation features live (Phase 5 unless stated)

| feature | entry point | screen | key wording / state |
|---|---|---|---|
| 19A Lecture camera (Phase 3) | recording dock «التقط السبورة» | photo lands on a note page after the current page with a time link; the slide matcher suggests «يشبه ص 12» | «اقتراح — ليس مؤكدًا» |
| 19B Lecture Fusion | lecture page and replay «ملخص موحّد» | sectioned artifact; each block keeps origin chips (رسمي · قال الدكتور · ملاحظاتي · صورة) | coverage «يغطي 31 من 40 صفحة» |
| 19C Crowd Notes | subject › lecture › tab «الشروحات» › «الشرح الجماعي» | collaborative copy with per-item author and approval status; duplicate suggestions | «ليست مكررة» remembered |
| 19D Professor vs Reference | replay and Study Rail «قارن كلام الدكتور بالمرجع» | side-by-side statements with «تعارض محتمل — لم يُتحقق منه» unless verified | scope picker explicit |
| 19E Adaptive path | opening a lecture: a quiet line «راجع أولًا: …» in the rail; planner «رتّب حسب المتطلبات» | reasons per item | dismissals remembered |
| 19F Catch-up | J8 | — | — |
| 19G Study Companion | one quiet suggestion slot at the top of the rail (≤ 1 per 10 min) | «اقتراح» card with «لماذا؟» and dismiss | never a modal |
| 19K Chapters (Phase 3) | replay and recording screens | chapter list beside the transcript | «تلقائي» |
| 19L Read-aloud | AI pen «اقرأ بصوت», cards | play/pause/stop with origin announced | disabled with reason without voices |

### 4.21 Exam room «غرفة امتحان» (Phase 4)

1. **Create:** «غرفة جديدة» → «امتحان» → questions from the subject bank or a saved exam, timing (optional), «تظهر
   الإجابات بعد انتهاء الغرفة» (fixed), audience (invited, or course-wide by a moderator).
2. **Lobby:** participants listed (names per room policy), consent to share a result summary «شارك ملخص نتيجتي مع
   المجموعة» (off by default), the room clock synced to the server.
3. **During:** the existing exam runner with the room clock; no answers visible to anyone; offline answers queue as
   usual and count when they reach the server before the room ends.
4. **After:** each participant sees their own review and «خطة تقوية من هذا الامتحان». Group results appear only with
   ≥ 10 participants, exclude the viewer's own answers, use four coarse bands («أغلب المجموعة أجاب صحيحًا» …), and the
   per-concept table is visible to the host only. Below 10: «النتائج الجماعية تظهر عند مشاركة 10 أشخاص أو أكثر».

### 4.22 ASR evaluation for the owner «تقييم التفريغ الصوتي» (Phase 3a, AOS-OC.10)

Inside المنصة (platform admin only), designed for an iPad or a phone:

1. **Samples:** a list of the owner's recordings; «حدّد مقطعًا للتقييم» with a range picker on the waveform, a stratum
   (لهجة عراقية · فصحى · مختلط) and conditions; a per-stratum counter «8 من 10 دقائق مطلوبة».
2. **Candidates:** engines configured as «للتقييم فقط» (no user sees transcription); cloud candidates show the provider
   and need the owner's consent for these samples.
3. **Correct:** «صحّح المسودة» — one segment per screen, «شغّل من هنا», the draft in a large field, English terms marked,
   «مراجَع ✓»; the label «مرجع مصحَّح من مسودة آلية (whisper.cpp base)» stays with it.
4. **Run and report:** «شغّل التقييم» (a server job; progress with counts) → a report per stratum with the floors of
   PRD Q28 marked «بلغ / لم يبلغ», intervals, CPU-minutes per audio hour, and «فعّل لمستخدمي المادة» enabled only when every
   floor is met.

## 5. Integration with existing MedLevo screens

Rule: **extend, do not duplicate** (spec §23, PRD principle N10). Each existing screen keeps its route and behaviour for
the signed-in user's own data; the Academic OS adds what is listed.

| existing screen (feature dir) | role in the Academic OS | changes |
|---|---|---|
| Workspace reader + ink (`features/workspace`, `/study/:sourceId`) | The only reader and writer for personal, followed, forked and collaborative copies, publication previews, rooms and replay | Copy chip, version banner, layers tab, discussion pins, «النقاش» and «المباشر» rail sections, room bar, replay transport, document tabs (§4.4) |
| Notebook (`/notebook/:nodeId`) | Personal notebooks; note pages inside a lecture copy can be part of a published explanation layer | Publish flow includes chosen note pages |
| Study Book (`features/studybook`, workspace pane, `/explanations/:artifactId`) | Generated once per space for official lectures (shared cache under Source Lock) and per vault for personal sources | Always labelled generated; never mixed with student explanations; cache key includes user/visibility (AOS-14.1, 18.17) |
| Explain / chat (`ExplainTab`, `ChatPanel`) | The AI pen and copilot reuse them | Lasso-resolved selections; menu items of §10; copilot answers saved with «احفظ الإجابة كملاحظة» |
| Questions (`/questions`) | Personal question vault per user; a space keeps the official past-exam bank | Lecture page shows linked official questions; «أضف إلى بنكي» copies; discussion questions enter with a «إجابة مجتمع» key |
| Exams (`/exams`, `/practice`) | Personal practice and exams; exam rooms reuse the runner | Room clock, per-user attempts, group analysis with minimum size |
| Review / FSRS (`/review…`) | Per user | Cards from discussions labelled «مجتمع»; radar cards labelled generated |
| Planner (`/planner…`) | Exam Mode is the planner with subject + date gathering | In-place plan edits with history (AOS-S5.6) |
| Weakness (`/weakness…`), Exam DNA (`/review/dna`) | Per user | Feed catch-up and Exam Mode; Exam DNA never counts radar items |
| Course Brain (`/concepts`, `/knowledge`, `/library/topics`) | Per vault and per space | Topic pages list visible published explanations; cross-course graph (Phase 5) |
| Search (`/search`) | Universal, permission-scoped | Scope chips, image search, «من الطلاب — ليست مصادر» group |
| Media (`/media…`) | Recordings, transcripts, images, quizzes | Timeline lanes, consent and scope panel, radar link, skip silence, speed |
| Library (`/library…`) | Personal library | «موادي من القنوات», smart collections (Phase 2); channel stubs appear as normal lecture rows with a «من القناة» badge; a private upload that matches an official lecture shows «موجودة رسميًا» (§4.15) |
| Upload (`/upload`) | Personal uploads | Destination picker can target a subject when the user has a role; official upload options (draft / publish) by role |
| Sources (`/sources/:sourceId`) | Version panel | Original vs converted, compare versions, «إصدار جديد من …» confirmation |
| Settings (`/settings`) | Moves under «أنا» | Adds e-ink mode, high contrast, «خفيف» mode, battery and storage savers, ink presets synced |
| Control Center (`/control/…`) | Personal, per user, for the sections that act on the user's own data: review queue, alerts, sync conflicts, source priority, explanation rules, own storage (rescoped to the blobs the vault references) and own AI usage | Sections that act on the whole deployment — AI provider and models, deployment budget, evaluation, health, client errors, the global processing queue, whole-instance backups — move to «المنصة» for the platform admin (ARCHITECTURE_DELTA §5.8); channel administration is a separate area that reuses its patterns |
| Offline (`/offline`) | Per-user downloads | Room packages and «نزّل محاضرات موادي تلقائيًا» option |
| Home (`/`) | Personal dashboard | Subjects, study time, goals, «من موادك», rooms, latest radar |
| Auth (`/login`, `/setup`, `/recover`) | Per-user sign-in; `/setup` only for the first run (owner) | Accounts for others are created through `/join/:token` or by the platform admin (Q3) |

## 6. User journeys

Each journey lists the actor, the steps with the screen and the exact UI wording, what can go wrong, and when it is done.
The eight required journeys come first; four supporting journeys follow.

### J1 — Live lecture «محاضرة مباشرة» (Phase 3 · PRD Scenario 1)

**Actor:** زينب on an iPad with Apple Pencil (PWA now, native shell later). **Before:** she follows the subject Anatomy.

1. Home shows «محاضرة اليوم: Lecture 6 — Anatomy» (from subject updates). She taps it → lecture page → **«ابدأ الدراسة»**.
   Her copy opens; with «نزّل محاضرات موادي تلقائيًا» on, it is already available offline.
2. In the hall she taps **«سجّل المحاضرة»** in the ink toolbar. The first time, a sheet explains: «يُحفظ الصوت على جهازك أولًا
   ثم في حسابك. التسجيل خاص بك. التفريغ النصي: غير مُعدّ». When an engine is enabled the sheet shows a switch «فرّغ هذا
   التسجيل» — off by default; for a cloud engine it names the provider and says the audio leaves the deployment, and turning
   it on records her consent (Q8/Q9, ADR-0006 §2.12). A cloud engine and the AI parts of «المباشر» are offered only when
   the subject's lecturer policy allows processing outside the platform; otherwise the sheet says «سياسة المادة لا تسمح
   بإرسال التسجيل إلى مزوّد خارجي» and only on-platform features remain.
3. The recording dock shows «يُسجَّل · 00:12», «علّم لحظة» and storage left. The rail opens «المباشر», which stays quiet:
   one transcript line (if configured) and nothing else until a cue.
4. She writes, turns pages, highlights. She taps **«التقط السبورة»**; the photo lands on a note page after the current page
   with a time link.
5. The lecturer says «هذا سؤال مهم: What are the branches of the celiac trunk؟». A quiet card appears in «المباشر»:
   «إشارة امتحانية · 23:10 · ص 7» with «اعرض إجابة موثقة» (when AI is available) and «أضف لملاحظاتي».
6. Hall Wi-Fi drops. Only the connectivity pill changes: «غير متصل — كل شيء محفوظ على جهازك».
7. She taps **«أوقف»**. Summary: «سُجّلت 52 دقيقة · 140 كتابة مرتبطة بالصوت · 3 إشارات» → «ارفع عند الاتصال» (default) or
   «ارفع الآن».
8. Back online: the upload resumes in chunks; if transcription is enabled, «يُفرَّغ التسجيل · 12 من 52 دقيقة»; then the
   inbox says «رادار المحاضرة جاهز».
9. Later: tapping a stroke offers «استمع من 23:05»; the timeline shows the pages she had open; **«إعادة العرض»** replays
   her writing with the audio.

**Can go wrong:** microphone permission refused → «لا يمكن التسجيل دون إذن الميكروفون» + how to allow; storage low → warning
at «يكفي التخزين لنحو 10 دقائق»; AI provider down or quota reached → «المباشر» shows the reason, recording and writing
continue; the app is killed → on reopen «استُعيد تسجيل غير مكتمل (52:10)»; plain-http LAN hub → recording unavailable with
the reason (secure context).
**Done when:** audio, strokes, photo and page views are on one timeline; the cue exists with time and page; nothing was lost.

### J2 — Start studying from a published explanation (Phase 1 · Scenario 2)

**Actor:** زينب. **Before:** حسن published «شرح المحاضرة 5» to the subject.

1. القنوات › Anatomy › المحاضرة 5 › tab **«الشروحات»**: «شرح حسن · الإصدار 3 · ص 34 من 40 · حُدّث أمس».
2. She opens it → publication page → **«معاينة»** opens the workspace read-only with his layer over the official pages.
3. **«ابدأ الدراسة بهذا الشرح»** → sheet: «نسخة متابَعة (تصلك تحديثات حسن)» or «نسخة مستقلة (تبقى كما هي)», each with
   its plain consequence (§4.3).
4. She picks **نسخة متابَعة**. The workspace opens with the copy chip «متابَعة: شرح حسن · الإصدار 3»; the layers tab shows
   «رسمي» (locked), «شرح حسن» (locked, visible) and «ملاحظاتي» (active).
5. She writes in «ملاحظاتي»; she can hide حسن's layer, or lasso one of his drawings and «انسخ إلى ملاحظاتي» (attribution
   kept on the copied item).

**Can go wrong:** she already has «نسختي» → the sheet lists it first («افتح نسختي») and, if she still creates the followed
copy, offers «انقل ملاحظاتي من نسختي إليها» (Phase 1: one layer copied with attribution; her «نسختي» keeps its notes); the
explanation was hidden by a moderator → «أخفى المشرف هذا الشرح: السبب»; offline → the sheet explains that following needs
a connection once; writing in her existing copy still works.
**Done when:** her copy shows the official layer, حسن's layer and her own layer, and only her layer is writable.

### J3 — A followed copy receives an update (Phase 1 preview, Phase 2 per-change accept · Scenario 2)

**Actors:** حسن (publisher), زينب (follower).

1. حسن edits his explanation layer in his own copy; the layers row shows «تعديلات غير منشورة (7)».
2. He taps **«انشر إصدارًا جديدًا»**, writes a change note («أضفت فروع الجذع البطني ص 4»), confirms.
3. زينب's inbox: «حدّث حسن شرحه للمحاضرة 5 (الإصدار 4)». In her copy the banner «تحديث متاح من حسن» appears.
4. **«اعرض التغييرات»** shows «أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1» and highlights them on the pages (outline +
   text, not colour alone). Nothing has changed in her copy yet. She taps **«طبّق التحديث»**; she could instead «تخطَّ هذا
   الإصدار», or switch the copy to «طبّق التحديثات تلقائيًا» (ADR-0004 §2.4). Phase 2 adds accepting or skipping
   individual changes. *Preview-first is the design's default and is flagged to the owner as an inversion of the spec's
   literal wording (PRD Q25); with the literal default, step 4 becomes «طُبّق تحديث حسن — اعرض ما تغيّر · تراجع».*
5. Her «ملاحظاتي» is untouched; strokes she wrote over حسن's removed stroke stay where they are; notes attached to items
   حسن did not change still point to them (stable ids), and a note she had attached to a removed item stays on its page,
   marked «يحتاج مراجعة».

**Can go wrong:** حسن's new version is built on a newer official version than her copy → banner «شرح حسن مبني على الإصدار 2
من المحاضرة» → J5 «انقل ملاحظاتي»; حسن unpublishes → her followed layer freezes at the last version she received, labelled
«توقف التحديث — لم يعد الشرح منشورًا»; nothing is removed from her copy.
**Done when:** her followed layer equals version 4 and her personal layer is identical to before.

### J4 — Offline classroom room «غرفة بلا إنترنت» (Phase 4 · Scenario 3)

**Actors:** حسن (host, Samsung tablet), زينب and others (iPad, phones). No internet; one Wi-Fi network or a phone hotspot.

0. Earlier, while online, the room was scheduled and every invited device fetched its room pass («جُهّزت الغرفة للعمل
   دون إنترنت حتى 23:59»).
1. حسن: القنوات › الغرف › **«غرفة جديدة»** → «غرفة شرح» → Lecture 5 → privacy «من أدعوهم فقط». In the hall, with no
   internet, the room shows «امسح رمز كل زميل بدوره» and one QR for the next joiner. (A short code «K7Q4-M2XD» appears only
   when the internet or a classroom hub is reachable.)
2. زينب: **«انضم إلى غرفة قريبة»** → scans حسن's QR → shows her answer QR, which حسن scans → her room pass is checked → the
   invitation screen: «حسن يدعوك إلى غرفة شرح: المحاضرة 5 · ستستلم: المحاضرة الرسمية وطبقة الشرح المباشر · لن يُرسل شيء من
   ملفاتك الخاصة» → **«انضم»**. حسن then shows a fresh QR for the next classmate.
3. The lecture package arrives only if she lacks it («لديك المحاضرة — يُرسل التحديث فقط»); progress shows real bytes.
4. حسن writes; she sees his strokes live in a read-only layer «مباشر: حسن» and writes on «ملاحظاتي».
5. حسن taps her avatar → **«اسمح بالكتابة على لوح الغرفة»**; now both write on the shared layer.
6. She taps **«ارفع يدك»** or sends a question in «النقاش».
7. Her link drops: room bar «انقطع الاتصال بالغرفة — تكتب على جهازك»; back: «أُعيد الاتصال · دُمج 37 تعديلًا».
8. حسن ends the room. If he recorded, each participant had been asked «هل توافق على تسجيل هذه الجلسة؟» at the start.
9. When internet returns, everything syncs to the server with its real author.

**Can go wrong:** the device or network cannot connect peers (client isolation on campus Wi-Fi, unsupported transport) →
«تعذّر الاتصال المباشر على هذه الشبكة (السبب)» and the option to use a phone hotspot; a device without a room pass →
«جهّز الغرفة وأنت متصل بالإنترنت أولًا»; حسن's screen locks → peers keep writing locally and see «المضيف غير متاح —
تكتب على جهازك»; a transfer is interrupted → resumes from the last verified part; a received file stays «لم يُفحص بعد»
until it reaches the server; a viewer tries to write → «لا تملك صلاحية الكتابة في هذه الغرفة».
**Done when:** all participants see the same shared layer, no stroke is duplicated or lost, and no private file left any
device.

### J5 — A new official version «إصدار جديد من المحاضرة» (Phase 1 · Scenario 4)

**Actors:** سارة (Subject Moderator), every student with a copy.

1. سارة: subject › Lecture 5 › tab «الرسمي» › **«ارفع إصدارًا جديدًا»** (or a bulk upload says «يشبه المحاضرة 5 — هل هو
   إصدار جديد؟»).
2. Processing shows stages with counts; then the comparison screen: page map (2 pages inserted after p.10, p.30 changed),
   side-by-side diff, change-note field.
3. **«انشر الإصدار 2»** → confirmation with impact: «سيتلقى 143 طالبًا تنبيهًا. لن تُحذف أي ملاحظة شخصية. يبقى الإصدار 1
   متاحًا للعرض.» (The count comes from the system `lecture_copy` index, shown as a number only, never as names.)
4. Students: inbox «إصدار جديد من المحاضرة 5»; the lecture row badge «إصدار جديد»; in the copy, the banner
   «يوجد إصدار أحدث من المحاضرة» → a preview «سيُنقل 46 · يحتاج مراجعة 3 · يبقى على الإصدار 1: 0» → **«انقل ملاحظاتي إلى
   الإصدار 2»** (one tap; automatic only for a student who turned on «انقل ملاحظاتي تلقائيًا», PRD Q35).
5. The move runs and reports: «نُقلت بأمان 46 · يحتاج مراجعة 3 · بقي على الإصدار 1: 0».
6. «يحتاج مراجعة» opens a side-by-side list: the item on the old page and the candidate place on the new page →
   «انقل هنا» / «اتركه على الإصدار 1» / move it by hand.
7. «عرض الإصدار 1» stays available from the copy chip.

**Can go wrong:** the student is offline → the banner waits; nothing changes until both versions are available; the
moderator tries to delete version 1 → refused while students' layers exist on it, with the reason.
**Done when:** every personal item is either on version 2, under review, or still on version 1 — counted, none lost.

### J6 — Exam planning «وضع الامتحان» (Phase 3 · Scenario 5)

**Actor:** زينب, two weeks before the Anatomy exam.

1. Home «الامتحان القادم» or المراجعة › **«وضع الامتحان»**.
2. She picks the subject (followed channel subjects and personal courses are listed) and the date (the moderator's
   published date is suggested), weekdays and daily minutes.
3. The proposal lists, each with its reason: lectures (incl. yesterday's new one), documented questions («مفتاح من المصدر»)
   and unresolved ones apart, lecturer cues («إشارة من الدكتور — مؤشر وليس احتمال»), due cards, weak topics; then the
   capacity line «يتسع: 41 مهمة من 46 — لا تتسع: …» naming what does not fit.
4. She unticks lecture 2, changes Thursday to 30 minutes, drags one task → **«احفظ الخطة»**.
5. Each day Home shows today's tasks; after a missed day «أعد التوزيع» keeps her edits.

**Can go wrong:** no lectures in the subject yet → «لا توجد محاضرات في هذه المادة بعد»; offline → the plan is readable and
check-offs sync later; no cues because no recordings → the line says so («لا توجد إشارات من الدكتور لهذه المحاضرات»).
**Done when:** an editable plan exists whose every item explains why it is there.

### J7 — Image search «ابحث بصورة» (Phase 2 · Scenario 6)

**Actor:** زينب photographs a slide the lecturer is showing.

1. Search (top bar) → **«ابحث بصورة»** → camera or a photo from the gallery (native shell / share target later).
2. «يقرأ الصورة…» (stage), then results: «المحاضرة 5 · ص 17 — تطابق مرتفع (41 كلمة متطابقة + تشابه الصفحة)», other
   candidate pages below.
3. Tapping a result opens the page in her copy, or the official lecture with «ابدأ الدراسة» if she has no copy.
4. The photo is discarded after the search unless she taps **«احفظ الصورة في ملاحظاتي»**.

**Can go wrong:** no match → «لا تطابق ضمن مصادرك (بُحث في 9 محاضرات)» with tips; unreadable → «الصورة غير مقروءة — جرّب
صورة أوضح»; offline → «البحث بالصورة يحتاج اتصالًا» (unless on-device OCR exists later).
**Done when:** she lands on the right page, or is told honestly that nothing matched.

### J8 — Catch-up «عوّض المحاضرة» (Phase 5)

**Actor:** زينب missed Lecture 6.

1. Trigger: inbox «فاتتك المحاضرة 6 — جهّزنا لك ما تحتاجه» (definition Q16) or the lecture row action **«فاتتني»**.
2. The catch-up sheet lists, each optional:
   * the official lecture → «ابدأ الدراسة»;
   * explanations available to her (sorted, with «لماذا؟»);
   * recording summary — only if a recording was shared with consent, else «لا يوجد تسجيل مسموح بمشاركته»;
   * the most important questions (linked + radar);
   * «ما تغيّر منذ آخر مراجعة لك»;
   * **«خطة تعويض: 45 دقيقة»**.
3. «ابدأ» runs the plan as a revision session; progress is recorded like any other.

**Done when:** she has studied the missed lecture through one entry point, with every item's origin labelled.

### Supporting journeys

**J9 — Join a channel «انضم إلى مادة» (Phase 1).** القنوات › «انضم برمز أو QR» → code / QR / link (a link first shows only
the channel's title, «دعوة للانضمام إلى: Anatomy — المرحلة الثالثة») → sign in (or create an
account when the link allows it, Q3) → «طلبك قيد المراجعة» or immediate membership → inbox on approval → the subject
appears under «قنواتي», and with «تابع المادة» its lectures appear in المكتبة › «موادي من القنوات». Expired or revoked code →
«انتهت صلاحية الرمز — اطلب رمزًا جديدًا من مشرف المادة».

**J10 — Publish an explanation «انشر شرحك» (Phase 1 course-only, Phase 2 wider).** In the copy, layers tab → row menu of the
layer → «انشر هذا الشرح» → visibility (default «أعضاء المادة»; «عام» shows «يراه كل المستخدمين المسجلين»), title, notes,
tags → **preview of exactly what will be published** («ستُنشر: طبقة "شرحي" · 3 صفحات ملاحظات · لن تُنشر: ملاحظاتي») →
«انشر» → publication page with «الإصدار 1». Later edits show «تعديلات غير منشورة» until «انشر إصدارًا جديدًا».

**J11 — Ask about a drawing on page 12 «اسأل عن هذا الرسم» (Phase 2).** Lasso the drawing → «اسأل زملاءك» → composer with
the anchor preview → post to the subject → a pin appears on p.12 for members → a classmate taps the question in the subject's
«النقاشات» and lands on p.12 at that region in their own copy → answers, «اقبل الإجابة» (asker or moderator), helpful votes,
«أضف إلى بنك أسئلتي», «أنشئ بطاقة» (labelled «مجتمع»).

**J12 — A moderator handles a report «معالجة بلاغ» (Phase 1 minimal, Phase 2 full).** Inbox «بلاغ جديد في Anatomy» →
إدارة القنوات › الإشراف › the report with its context (anchored preview) → **Phase 1:** «أبقِ» / «أخفِ مع السبب» and later
«أعِد الإظهار»; **Phase 2** adds «اطلب تعديلًا» and appeals → the author is notified with the reason; the action is in the
audit log; the reporter sees «تمت المراجعة». A report from a second user on the same item joins the open report.

## 7. State handling

The existing vocabulary stays: `LoadingState` (stage + real counts), the offline pill and cached read-only views, and the
five save states of `SaveStatus` (محفوظ محليًا / ينتظر المزامنة / تمت المزامنة / تعارض / خطأ). The Academic OS adds the
states below. Every state shows **text + icon** (never colour alone), names its reason, and offers the next action.

### 7.1 State catalogue

| class | state | where | copy (Arabic UI) | behaviour |
|---|---|---|---|---|
| Loading | long job with stages | conversion, version matching, note migration, ASR, package transfer | «تحويل الملف إلى PDF · الصفحة 12 من 40» · «نقل الملاحظات · 46 من 49» · «يُفرَّغ التسجيل · 12 من 52 دقيقة» · «استلام المحاضرة · 8.2 من 20 م.ب» | real counts only; no percentage without a known total |
| Offline | no connection | global pill; channel, feed, profile screens | «غير متصل» · «تعرض نسخة محفوظة من 10:42 — النشر والانضمام يحتاجان اتصالًا» | writing, recording and reading downloaded content always work; network-only actions are disabled with the reason |
| Syncing | per entity | save status; publication rows | existing five states + «يُنشر…» · «نُشر الإصدار 3» · «بانتظار الاتصال للنشر» | publishing waits in the outbox like other writes |
| Conflict | personal, between own devices | notes, sessions | «تعارض بين جهازيك — حُفظت النسختان» | keep-both as today; the copy says «جهاز آخر لك» |
| Conflict | collaborative layer | collaborative copy, room board | *(no conflict state)* | CRDT merges silently; a quiet «دُمجت تعديلات 3 مشاركين» note only after reconnect |
| Update | followed explanation | copy chip, banner, inbox | «تحديث متاح من حسن» · «اعرض التغييرات» · «طبّق التحديث» · «طُبّق الإصدار 4» · «تخطّيت الإصدار 4» | default: preview, nothing changes until applied; per copy «طبّق التحديثات تلقائيًا»; Phase 2 per-change accept/skip |
| Update | newer official version | banner, lecture row | «يوجد إصدار أحدث من المحاضرة» · «انقل ملاحظاتي» | never automatic for personal layers without the student's tap |
| Re-anchor | items needing review | copy chip, layers tab | «3 ملاحظات تحتاج مراجعة مكانها» | opens the review list (J5 step 6) |
| Pending | join, upload, publication | channels home, upload rows, publication page | «طلبك قيد المراجعة» · «مسودة بانتظار موافقة المشرف» · «بانتظار مراجعة المشرف قبل أن يصبح عامًا» | resolves through the inbox |
| Permission | membership removed or role changed | subject and lecture pages, copy | «لم تعد عضوًا في هذه المادة — ملاحظاتك الشخصية باقية لديك» | personal layers stay; shared content stops updating; copies already on the device are a documented limit |
| Permission | not allowed | any action | «لا تملك صلاحية … (السبب)» | the control is disabled with the reason, never hidden silently when the user would expect it |
| Moderation | hidden or removed | publication, post | «أخفى المشرف هذا الشرح: السبب» | followers keep what they had; the author sees how to appeal (Phase 2) |
| Configuration | provider missing | AI pen, copilot, transcription, recognition | existing «غير مُعدّ» lines from the capability registry, e.g. «التفريغ النصي غير مُعدّ على هذا الخادم» | `FeatureGate` with the reason |
| Quota | allowance used | AI, transcription, storage | «بلغت حصتك الشهرية من الذكاء الاصطناعي — تتجدد في 1 تشرين الثاني» · «تبقّى 180 م.ب من مساحتك» | writing and recording never stop because of an AI quota; storage warnings come early |
| Consent | needed before an action | room recording, sharing a recording, progress sharing | «يحتاج موافقة المشاركين قبل التسجيل» · «أكّد موافقة الدكتور قبل مشاركة التسجيل» | the action waits until consent is recorded |
| Live | room connection | room bar | «متصل بالغرفة · 6 حاضرين» · «انقطع الاتصال — تكتب على جهازك» · «أُعيد الاتصال · دُمج 37 تعديلًا» | updates batched; announcements rate-limited |
| Recording | in progress / stored | dock, top bar pill | «يُسجَّل · 23:10» · «التسجيل محفوظ على الجهاز — يُرفع عند الاتصال» | survives navigation and reloads |
| Device | capability absent | any device-dependent control | «غير متاح على هذا الجهاز: …» (e.g. «لا يدعم المتصفح الاتصال المباشر بين الأجهزة») | from real detection, never from the device name |
| Quarantine | file received from a peer, not yet checked by the server | room files, attachments | «لم يُفحص بعد — يُفحص عند الاتصال» | stored, never opened or forwarded until it passes the server's checks |
| Offline room pass | no valid server-signed pass on this device | offline room join | «جهّز الغرفة وأنت متصل بالإنترنت أولًا» | the join is refused before any data is exchanged |
| Version | client older than the server allows | whole app | «يتوفر تحديث ضروري — حدّث التطبيق» | the app updates its service worker; nothing is pushed by the old client |
| Evaluation | speech engine measured below the floors | recording, copilot | «قيس ولم يبلغ الحد المطلوب: …» | transcription stays off for users |

### 7.2 Precedence

When several states apply, show them in this order and never stack more than two banners: (1) anything about the user's
own writing being safe (save status), (2) connectivity, (3) recording, (4) content updates (versions, followed updates),
(5) everything else as inbox entries. Background events never open a modal over the page.

## 8. Design-system additions

All additions live in `apps/web/src/design/` and follow [`docs/design-system.md`](../design-system.md): tokens only, no ad-hoc
colours or spacing; one primary action per view; status with icon and text; RTL-aware keyboard navigation; 44 px targets on
touch; reduced motion honoured. MedLevo's identity stays: neutral canvas, warm paper, a single indigo ink accent, motion
that answers actions only.

### 8.1 Tokens and theme attributes

| addition | purpose | rules |
|---|---|---|
| `--ml-layer-1 … --ml-layer-8` | author identity hues for layer rows, presence avatars and layer outlines | derived from the ink palette, each ≥ 3 : 1 against paper in both themes (WCAG 1.4.11); always paired with the author's initials or name; the user's own layer uses the accent; the official layer has no tint |
| `--ml-color-live` (+ `-soft`) | recording and live room indicators | built on the danger hue, always with an icon and «يُسجَّل» / «مباشر» text |
| `data-eink="on"` on `<html>` | e-ink mode (AOS-OC.5) | grey/black palette (ink `#000`, paper `#FFF`, hairlines 1 px solid black), all motion durations 0, no shadows, no paper texture, no translucency, focus ring 3 px solid, paging instead of smooth scroll, no live-stroke prediction overlay, live updates batched (presence every 5 s); suggested automatically when the device reports `(update: slow)` or the user picks BOOX (ADR-0005 B.4) |
| `data-contrast="high"` | in-app high contrast (AOS-19L.3) | same effect as the existing `prefers-contrast: more` block, settable in المظهر |
| `data-lite="on"` | «خفيف» mode for weak devices (AOS-19L.5) | no paper texture, reduced canvas resolution caps, fewer live effects |

### 8.2 New components

| component | use | accessibility / behaviour |
|---|---|---|
| `OriginBadge` (`official` · `reference` · `student` · `reviewed` · `generated` · `mine` · `lecturer`) | label every item's origin: رسمي · مرجع · شرح طالب · راجعه مشرف المادة · مولّد آليًا · ملاحظاتي · قال الدكتور في التسجيل | icon + text; `reference` = an uploaded reference source, never shown as رسمي; `reviewed` always names the role and date and is given only by a Subject Moderator; never the words «موثّق» or «مؤكد» |
| `VisibilityPicker` | خاص · أعضاء المادة · المتابعون · أشخاص محددون · عام | radio group with one-line consequences («يراه كل المستخدمين المسجلين»); default خاص (or أعضاء المادة in the publish flow); choosing عام asks for confirmation |
| `RoleBadge` | مدير القناة · مساعد · مشرف المادة · مساهم | text pill, shown only where the role matters |
| `Avatar` | people in lists, presence, comments | initials on a layer hue by default; uploaded photo optional; the accessible name is the person's name |
| `PresenceStrip` | room bar, collaborative copies | avatars + count + overflow «+4»; joins announced politely and rate-limited |
| `LayersPanel` / `LayerRow` | layers tab | visibility toggle (`IconButton pressed`), lock icon with «للقراءة فقط», active-for-writing radio (own layers only), author, `OriginBadge`, menu |
| `CopyChip` | workspace top bar | names the copy type and version; opens copy details |
| `InlineBanner` | version and update notices | non-modal, dismissible, one action, `role="status"` |
| `ChangeHighlight` + `DiffLegend` | «اعرض التغييرات», copy comparison | added = solid outline + «أُضيف»; removed = dashed outline + «حُذف»; moved = arrow + «نُقل» — never colour alone |
| `RatingInput` / `RatingSummary` | publications | 1–5 as a radio group; summary «4.3 من 5 · 28 تقييمًا» (the count is always shown) |
| `HelpfulVote` | discussion answers | toggle with `aria-pressed`, label «مفيدة» and the exact count |
| `FollowButton` | profiles, subjects | toggle: «تابِع» / «تتابعه»; subject-scoped variant «تابِع في Anatomy فقط» |
| `ConfidenceLabel` | image search, version matching, alignment | مرتفع / متوسط / منخفض + its basis in words; no percentages |
| `ConsentDialog` | recording, sharing, progress sharing | variant of `ConfirmDialog`: what, who, scope, how to withdraw; the answer is stored |
| `QrCard` / `QrScannerSheet` | join codes, rooms | the code is always printed as text beside the QR (base32 groups, LTR); scanner states camera permission and offers manual entry |
| `TimelineTrack` | recording, replay | scrubber + lanes (pages, ink, notes, photos, cues, chapters); arrows seek 5 s, Shift 30 s; a text list of events is the twin |
| `TranscriptList` | recording, replay, copilot | segment rows through `RichTextView` (bidi runs); the current segment has `aria-current`; tap seeks |
| `ExamCueCard` | copilot, radar | quote, time, page, status; fixed footer «مؤشر من كلام الدكتور — ليس توقعًا» |
| `NotificationRow` / inbox | notifications | grouped by day; unread as text («غير مقروء»), not only a dot |
| `CommandPalette` | Ctrl/⌘K | `Dialog` + listbox with groups (اذهب إلى · أنشئ · أدوات · بحث); RTL arrows; typeahead |
| `DocTabStrip` | workspace document tabs | WAI-ARIA tabs; middle-click / close button; overflow menu |
| `DiscussionPin` | page anchors | numbered marker with 44 px touch area, focusable through its list twin in the rail |
| `ModerationPill` | moderation states | «بانتظار المراجعة» · «مخفي» · «راجعه مشرف» |
| `QuotaMeter` | usage screen | determinate `ProgressBar` with known maximum + text |
| `RoomBar` | rooms | presence, follow/free navigation segmented control, hand, connection state |
| `StudentContentNotice` | explanations, discussions, search groups | «شرح طالب — ليس مصدرًا رسميًا» line with an info popover explaining evidence rules |
| `AiActionMenu` | AI pen (§4.16) | `menu` with groups (افهم · تدرّب · لغة · ابحث · صوت), at most three direct actions in the selection toolbar, every disabled item with its reason in the accessible description |
| `HistoryList` / `TimeMachineBar` | layer history, time machine (§4.17) | day-grouped list; read-only bar «تعرض حالة …» with a slider and «استعد هذه الحالة» (confirm, writes a new state) |
| `CompareView` | compare copies (§4.17) | split view + `DiffLegend` + change list twin |
| `LinkToOfficialSheet` | link a private lecture (§4.15) | match basis in words, plain consequence, report like J5 |
| `ReportDialog` | «أبلغ» (Phase 1) | reason radio group, optional note, one open report per item |
| `EvalSampleMarker` / `TranscriptCorrector` | ASR evaluation (§4.22) | range picker on the waveform with a text twin; one segment per screen, large field, play-from-here |
| `RoomPairingQr` | offline join (§4.8) | one QR per joiner, «التالي» after each pairing, the count of paired devices; the room key never appears |

### 8.3 Patterns

* **Publish preview** — before anything becomes visible to others, list exactly what will and will not be published.
* **«لماذا؟» popovers** — every ranked or suggested item can say why (ranking, feed, collections, cues, matches).
* **Two-world headers** — screens of the shared world show the channel breadcrumb; personal screens never do.
* **Empty states** with one next action: «لم تنضم إلى أي مادة بعد → انضم برمز», «لا توجد شروحات منشورة لهذه المحاضرة → انشر
  شرحك», «لا توجد إشارات من الدكتور → سجّل المحاضرة».

### 8.4 What to avoid (added to design-system §6)

Feed-first home · infinite scroll · like counters in lists · red numeric badges · streaks, flames, confetti or other
gamification · leaderboards of students · follower counts in navigation · auto-playing audio · modals for background events ·
«موثّق» / «AI Verified» / certainty wording for student, reviewed or generated content · colour-only layer or presence cues ·
copying any other app's layouts, icons, templates or wording.

## 9. Responsive and device behaviour

| context | layout |
|---|---|
| **Phone** (≥ 360 px) | Bottom tab bar (5). Subject and lecture tabs scroll horizontally. Workspace: rail and layers as bottom sheets; room bar collapses to avatars + count; recording dock above the tab area; the copilot never covers the page or the ink toolbar. |
| **Tablet** (writing-first) | Top bar. Rail docked beside the page; layers in the left panel; split view and document tabs; pen-only mode default when a pen is detected; native ink surface inside the shell (PL-2/PL-3). |
| **Desktop** | Same as tablet with document tabs, split view, command palette and keyboard shortcuts as first-class. |
| **E-ink (BOOX)** | `data-eink="on"`: paging, no motion, grey palette, batched live updates, larger targets; the recording dock is static text. |
| **Native shell** | Same IA and routes; native ink surface replaces the canvas inside the page view; native camera, QR scanner, share sheet and background recording; capabilities reported per device. |

## 10. Accessibility and RTL on the new surfaces

* Every graph-like or spatial view has a text twin: timeline (event list), discussion pins (list in the rail), presence
  (list), knowledge graph (existing twin), layer diff (change list).
* Mixed Arabic/English in discussions, comments, titles, transcripts and cues renders through `RichTextView` / `Bidi`; no
  bidi control characters are stored (AC-20 extended).
* Keyboard: layers (arrows move between rows, Space toggles visibility), timeline (arrows seek), rating (arrows), command
  palette, tabs; lasso move/resize by keyboard (AOS-20.20).
* Live regions: polite for presence, sync and updates (rate-limited); assertive only for errors and lost connection
  while recording.
* Reduced motion and e-ink: live remote strokes still appear, without animation; replay steps instead of animating
  when motion is reduced.
* Touch targets ≥ 44 px, including pins and layer toggles; hover is never required.
* Screen-reader passes on VoiceOver (iPad) and TalkBack (Android) are recorded per phase (PRD NFR-A1).

## 11. IA decisions and open questions

Decisions taken in this document (the owner may change them):

1. **Five primary destinations** with «القنوات» and «أنا»; Settings moves into «أنا».
2. **Copies are grouped under their lecture.** Several copies of one lecture are allowed (as in `ARCHITECTURE_DELTA.md`
   §6.5), but the Start Studying sheet opens an existing copy first and personal notes can be moved between copies.
3. **Lecture page tabs:** الرسمي · الشروحات · النقاشات · التسجيلات (questions and versions live under الرسمي).
4. **Layers in the left panel**, discussions and the live copilot in the Study Rail; no new panels around the page.
5. **Home stays personal**; social updates appear as one «من موادك» section and the separate «الجديد» feed.
6. **Channel administration is separate** from the Personal Control Center but reuses its patterns.
7. **No direct messages** in these phases (PRD Q17); conversation happens in contextual discussions and rooms.
8. **Platform operations are their own area («المنصة»)**, separate from the per-user Control Center and from channel
   administration.
9. **Every new spec section has an entry point** (§4.15–§4.22), and a control of a later phase is not shown before that
   phase (PRD AOS-23.3).

The owner questions that affect the IA are in [PRD §11](PRD.md#11-owner-questions-and-assumed-defaults): Q2 (meaning of
«عام»), Q3 (sign-up), Q6–Q8 (moderation, publishing, recording consent), Q15 (group sizes), Q16 (catch-up trigger), Q17
(direct messages), Q25 (followed-update preview — flagged as an inversion of the spec's wording), Q27 (offline room size),
Q30 (online room voice), Q35 (automatic note migration).
