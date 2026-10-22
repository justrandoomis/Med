# Module: forks — study copies of official lectures and course-only explanations (Academic OS P1-T5 steps 2–3)

Step 2 builder notes 2026-10-21 (reviewed 2026-10-21, «Review» below). Step 3 — publications: publish course-only,
follow, fork, updates, moderation, withdrawal, account deletion — builder notes 2026-10-22 in «Step 3» below; status of
every step-3 row: **built, awaiting review** (the reviewer sets the matrix statuses).

Server: `apps/server/src/modules/forks/*` (mounted at `/api/copies`), migrations `0163_pinned_region`,
`0860_document_copy` (base, vault), `2060_lecture_copy` (system), `3300_scoped_fts` (space).
Web: `features/copies/*`, `features/workspace/copies/StudyCopyBar.tsx`, `features/lectures/LectureScreen.tsx`,
search scope chips in `features/search/SearchScreen.tsx`.

## What it does

| Piece | Where | Behaviour |
|---|---|---|
| Stub | `forks/stubs.ts` `ensureStub` | One vault transaction: `source` (`is_stub = 1`, `origin_space_id`, `origin_lecture_id`), each held `source_version`, every `source_page` and its `page_fingerprint` under the SPACE's ids; the official page map between consecutive held versions; a vault `stored_file` row for the same sha256 blob (no new bytes). No chunk, FTS row or region is copied. Lands in «موادي من القنوات» › the subject. Measured: a 40-page stub skeleton ≈ 5.4 KB of values (+ ≈ 16 KB fingerprints) |
| «ابدأ الدراسة» | `POST /api/copies` (`copies.ts`) | member of the subject + published (not taken-down) lecture, else the body of a missing item (404). Idempotent by client id (same id + same body → the copy; another body → 409); a second start reopens the copy that exists; a withdrawn lecture reopens an existing copy only. Personal mode only (fork / follow → 409 `FEATURE_DISABLED` until step 3). Materialises the personal layer `defaultPersonalLayerId('source:<id>')` |
| `document_copy` | vault | the copy (mode, policies — `reanchor_policy` `preview`/`auto`, client body hash); `GET/PATCH /api/copies[/:id]`, list by `source_id` or `space_id + lecture_id`; the view carries `lecture`, `newer_official_version` and `official` (published / withdrawn with the reason / unavailable after leaving; `file_removed` after a takedown) |
| `lecture_copy` | system (`forks/system.ts`) | user × space × lecture × version × `personal_items` — counts only; refreshed when a copy is started, read or linked and by every fan-out job (not on each sync push: the count can lag until then, so the purge refusal recounts live in the vaults). Used for the publish preview (`holders`, bucketed, never under 5), the version fan-out and the purge refusal |
| Course-follow fan-out | `fanout.ts` `official_copy_fanout` → `official_stub_sync` | the FIRST publication of a lecture reaches every follower of the subject with «add new lectures» on (P1-T4's `course_follow`) as a stub — idempotent per user + lecture version; unfollowed / switched off / non-members get nothing |
| Official-version fan-out | same jobs, after the page-map job | every holder's vault gets the new version as a stub version + the moderator-confirmed page map + a `content_alert` (`source_replaced`); notes are COPIED by P1-T2's `reanchor_copy` only on the user's tap (preview first), or at once with `reanchor_policy: 'auto'` (report in the inbox, `reanchor_ready`). Nothing is moved or overwritten; former members get no new version |
| Withdraw / takedown (vault side) | `runStubSync` | withdraw: the copy keeps everything and says why; rights takedown: the stub's file references are nulled, pinned region text cleared, then the vault `stored_file` rows deleted when unreferenced (FK check clean) |
| Purge refusal | `purgeExtension.ts` | a purge of an official lecture is refused (409, Arabic, a bucketed count, no names) while any vault holds personal items on one of its versions (live recount through the vaults); otherwise only the space rows go. Vault purge of a stub removes `document_copy`, pins and holdings |
| Link private → official (19H.3) | `GET /api/copies/link-candidates`, `POST /api/copies/link` (`link.ts`) | candidates: published heads of the viewer's member subjects whose sha256 or page fingerprints match (P1-T3's `matchLinkCandidates`, ≥ 60 %); link creates the stub + personal copy and COPIES the private source's items onto the official version (`runReanchorCopyAcross`, deterministic ids, review list); the private source stays byte-identical |
| Promote private → official (19H.4) | `POST /api/spaces/:s/lectures/from-vault` (`promote.ts`) | a Subject Moderator's own private lecture becomes a DRAFT official lecture: the blob is registered by sha256 (no bytes copied), the space pipeline processes it; a twin by content hash → 409 with its id; others 403 (members) / 404 (strangers) |
| Federated search | `search/federation.ts`, `scopeTokens.ts` | see `evidence-search.md` «P1-T5 step 2» |
| Stub retrieval + lazy pinning | `pin.ts`, `evidence/{retrieval,evidence}.ts` | see `evidence-search.md` «P1-T5 step 2» |
| Reader on a stub | `sources/service.ts` seam `setStubPageRegions` | page regions of a stub page are read from the space for a member (nothing copied); after leaving, only the vault's own pinned rows |

## Web

* `/subjects/:spaceId/lectures/:lectureId` — the official lecture page: subject, title, number, current version, published
  versions, withdrawal reason; «ابدأ الدراسة» (dialog: where the copy lands, «انقل ملاحظاتي تلقائيًا…» which sets the
  copy's real `reanchor_policy`, one client id per dialog so a retry reopens the same copy) or «افتح نسختي». Reached
  from search hits, the reader's copy bar and notifications. Step 3 adds the «الشروحات» tab (see «Step 3»).
* Reader copy bar (`StudyCopyBar`): «نسختي · المادة · الإصدار n», the official state in words, the auto-copy switch, the
  lecture page link; for a private lecture with an official twin: «موجودة رسميًا في …» → «اربط بالنسخة الرسمية…»
  (`LinkToOfficialDialog`: candidates with their basis, copy report, «افتح النسخة الرسمية»). A newer official version is
  announced by P1-T2's `NoteMigrationBanner` (one tap copies the notes). Offline or nothing to say: no bar.
* Search: scope chips «الكل / مكتبتي / موادي الرسمية» (online only), «رسمي · المادة» on official hits; a hit opens the
  reader when the viewer studies the lecture (`in_library`), else the lecture page at that page; an honest note when a
  subject was searched by the capped post-filter.

## Tests

Server: `test/forks/{stubs,versions,course-follow,link-private}.test.ts`, `test/search/federation.test.ts` (incl. NFR-P5),
`test/evidence/stub-retrieval.test.ts` (AC-05/06/07/29 on a stub, pins survive a new version),
`test/acceptance/ac01b-content.test.ts` (content paths), `test/lectures/*` (updated for federation and the mounted
`from-vault`). Web: `apps/web/test/copies/{copies,wave2-step0-routes,lectures-admin}.test.tsx`.

## Not done (step 2) — honest

* Publications (fork, follow, publish), the «الشروحات» tab — built in step 3 (below); the marketplace is Phase 2.
* Library «موجودة رسميًا» badge in the library list (shown in the reader's copy bar instead); a student-facing subject
  page listing official lectures (P1-T4's channel screens are step 3) — the lecture page is reached from search,
  notifications and the copy bar.
* Fan-out jobs run in-process (the existing job runner), not a worker thread; notifications go through P1-T4's
  `notificationsOf(ctx).publish` (their step 2, built at the same time).
* No HTTP route purges an official lecture (the purge path runs through the purge job / test path only).
* `POST /api/copies/link` runs the copy synchronously (`job_id: null`).
* Official Study Book artifacts in the space, the space file token, drafts in federated search for moderators, subject
  attachments in federated search — not built.
* `axe-core` is not installed in this repo: «axe 0 serious» on the new screens is **Not run**; no device test, no E2E
  for these screens yet (`e2e/aos-s2-followed-copy.spec.ts`, `aos-s4-official-version.spec.ts` are step 3).
* ~~(review) Items a link could not place safely stay on the private lecture: no review list …; inserted note pages of a
  private lecture are not copied by the link.~~ — closed by track C2 (below).

## Phase 1 completion — track C2 (2026-10-22)

| row | built | evidence |
|---|---|---|
| AOS-19H.3 / X8 (c) | «اربط بالمحاضرة الرسمية» loses nothing: every item of the private lecture lands on the official copy (copied) or in its review list «ربطت محاضرتك الخاصة …» (the link is recorded in `private_link`, migration `0862_private_link.sql`; `previewReanchorCopy` lists `linked` sources, `reanchorCopyAction` copies across sources with deterministic ids and the attribution chain); inserted note pages are copied with what is written on them (`runReanchorCopyAcross` → `note_pages` counts); a repeated link copies nothing; the private source stays byte-identical; the proof counts every item (total = copied + listed + kept, then copied + kept). The library shows «رسمي · المادة» / «مرتبطة بالنسخة الرسمية · n تنتظر المراجعة» / «موجودة رسميًا في …» (`GET /api/copies/link-status`, batched) and the row menu offers the link; the result dialog opens the review list (`?panel=review`) | `srv:forks/link-review`, `web:copies/linkStatus.c2`, `web:workspace/panels/linkedReview.c2`, `e2e:aos-c2-official-content` (phone + desktop) |
| AOS-19H.1 | `GET /api/copies/lecture-identity?space_id=&lecture_id=` — one lecture identity links its published versions (which ones the member's copy holds), the member's copies, the private lectures they linked to it, the explanations on it they may see (active ones, their own, the ones they hold), and their own objects mapped to it by KIND (annotations, notes, questions, cards, recordings — later phases add kinds without a contract change). Members only; a draft, an unknown id or another subject is «not found» | `srv:forks/lecture-identity.c2` |
| AOS-4.18 (export) | exports keep the author and the lineage: a copied note or highlight says «مشتق من منشور «X» (الإصدار n) لـ Y» in Markdown, HTML, Word and JSON (`attributions` with the `derived_from` chain); a copied highlight is «تمييز منقول», never «تمييزي»; the author's own export names nobody. The publication's title comes through a seam (`setPublicationTitleSource`, registered here) so `data/export.ts` never opens the system database | `srv:forks/export-attribution.c2` |
| AOS-19I.5 | published content containing machine output keeps its origin (`ai_answer`, `handwriting_recognition`) in the publication's items, in a follower's copy and in their export; the publication page says «فيه محتوى مولَّد آليًا: …» with the counts (`machineContentAr`) | `srv:forks/ai-marking.c2`, `web:copies/official-provenance.c2` |

Found by the C2 E2E run and fixed with a regression test: after «اربط وانسخ ملاحظاتي» the result dialog vanished,
because the row's status turned «linked» and the menu hook returned no dialog (`linkStatus.tsx` now keeps the dialog
while it is open).

### Review of track C2 (adversarial, 2026-10-22)

Each defect below was reproduced by a test that failed first, then fixed at its root:

* **R1 (blocker for X8 (c))** — what a run copied into ONE document counted as «carried» for every other document:
  `carriedOf` was keyed by the source only. Linking the same private lecture to a second official lecture (the same
  lecture in another subject) copied nothing, said «نُسخ N عنصرًا» anyway and copied the inserted note page EMPTY
  («بما عليها»); and the private lecture's own «انقل ملاحظاتي إلى الإصدار الجديد» counted what a link had copied
  elsewhere as «نُقل سابقًا», so nothing moved to its new version. `carriedOf(ctx, sourceId, toSourceId)` now counts only
  the runs INTO the target document (every caller passes it: the plan, the preview, the review list's copy, the linked
  review counts, the note pages) — `srv:forks/link-review.review-c2` «R1».
* **R2 (major)** — items on ANOTHER version of the private lecture (never moved to the version the link matched) were in
  no count and no sentence. The link now counts them as kept on the private lecture (`total` and `kept` include them,
  `unlinkedVersionItems`) and names their version and what to do («انقلها إليه … ثم اربطها مجددًا»); they are not copied
  (the page map is from the linked version) — `srv:forks/link-review.review-c2` «R2».
* **R5 (minor, AOS-19I.5)** — «اعرض التغييرات» of a followed explanation did not say that the new version holds
  machine-generated notes (it was marked only after «طبّق التحديث»); the preview now says «الإصدار n: فيه محتوى مولَّد
  آليًا: …» before anything is applied — `web:test/copies/update-preview-ai.review-c2`.
* Tried and found sound (tests kept as evidence): the review queue and the updates feed as a guest (401), a pending
  member (403), a removed member who still holds a copy (404, and no `official_version` notice), a student and an
  Assistant (403), another subject's moderator (404); the notice of a version accepted through the queue reaches the
  member holders only — `srv:lectures/review-feed.review-c2`.
* Not changed (minor, recorded): the full JSON export (`exportAll`) does not list `private_link` (nor P1-T5's
  `document_copy` / `pinned_region`) — bookkeeping only; every row is in the vault backup. The library badge shows the
  newest link of a private lecture only.

## Step 3 — course-only explanations (publications)

Server: `forks/{publications,pubItems,following,pubFanout,system}.ts`, `authz/rules/publications.ts`; routes in the
subject's space (`lectures/index.ts` mounts `registerPublicationRoutes`; all eight step-3 declarations of
`authz/spaceRoutes.ts` are MOUNTED, minimum access `member`) and in the vault (`/api/copies`). Migrations
`2150_publications` (system: `publication_series` — unused, Phase 2 —, `publication`, `publication_copy`) and
`3050_publications` (space: `publication_version`, `publication_item`, `suggestion` — unused, Phase 2).
Web: `features/lectures/{PublicationsTab,PublicationScreen,PublishDialog,ReportDialog,PagePreviewFrame,publicationPreview}`,
`features/copies/{StartFromExplanationDialog,UpdatePreviewDialog}`, `features/workspace/copies/StudyCopyBar.tsx`,
`features/lectures/publications.css`.

| Piece | Where | Behaviour |
|---|---|---|
| Publish | `POST /api/spaces/:s/publications` (`Idempotency-Key`) | the author's OWN layers (personal / explanation / answers) on their copy of the lecture, read in THEIR vault through `binding.run`; kinds `PUBLISHABLE_ANNOTATION_KINDS` (ink, highlights, shapes, text boxes, sticky notes) + page-anchored notes; pictures, bookmarks, links, items on inserted note pages and items written on another official version are left out and COUNTED with an Arabic reason (`snapshot.skipped`, author only). Built on ONE official version (the newest the chosen layers write on). Course-only, kind `explanation` only (the schemas refuse the rest). A retry with the same key answers the same publication |
| Delta storage, live head | `publication_item` `[valid_from, valid_to)` | stable item ids `pi_` = hash(publication, author's item id); a republish writes rows only for added / changed items and closes changed / removed ones; the same content (hash) on the same official version is a no-op (no version 2). Measured on this container (one test process): publish of 5 000 strokes 315 ms (an earlier run 325 ms), a republish with ONE changed stroke out of 5 000 352 ms (earlier 291 ms) writing ONE new `publication_item` row (`srv:forks/publications` «scale») |
| Reads | `GET …/lectures/:id/publications`, `GET …/publications/:id`, `…/versions/:n/items[?page_id=]`, `…/diff?from=&to=` | members only (anybody else: the missing-route body); a hidden / withdrawn / author-deleted explanation: its author (and, while hidden, the subject's moderators) read every version, a holder of a copy only the versions up to the one their copy took (review R3-B — `readableHead`; the page lists only those); only publications the viewer may see, filtered before paginating; completeness as numbers («ص 3 من 40»); «شرح طالب — ليس مصدرًا»; the author's display name rendered now («طالب سابق» after deletion); ink v2 only for `accept-ink: 2` |
| Follow | `POST /api/copies` `mode: 'followed'` | a read-only `followed` layer (owner = the author) under the publication's stable ids, attribution «من شرح حسن — الإصدار N»; one copy per publication per vault (a replay reopens it); the follower's own notes go to a personal layer of the copy (the document's «ملاحظاتي» if it is free, else «ملاحظاتي (متابَعة شرح …)»); «انسخ ملاحظاتي من نسختي إليها» = P1-T2's layer copy from the personal copy (the old copy unchanged) |
| Fork | `mode: 'independent_fork'` (+ `version_no`) | a writable `forked` layer frozen at version k (own `fk_` ids, attribution); nothing arrives after |
| Updates | `publication_update_fanout` (space) → `publication_follow_sync` (vault, per follower); `GET /api/copies/:id/upstream`, `POST …/upstream/apply` | each follower's copy gets the new version PENDING (preview: counts, pages, change note, `personal_items_affected: 0`) or applied at once (`update_policy: 'auto'`); apply upserts changed / added items under their ids and tombstones removed ones IN THE FOLLOWED LAYER ONLY (history `followed_update`); a replay changes nothing; a stale version → 409; «تخطَّ هذا الإصدار» keeps the copy and says so. Inbox `publication_updated` to followers (never the author) |
| A new official version | `publication_version.lecture_version_id` | the follower's one-tap copy (P1-T2) moves HER notes and keeps the followed items (read-only layer: they follow the author); the author copies his layer with the same flow and republishes → the copy says «مبني على الإصدار 1» until then and «مبني على الإصدار 2» after applying (`built_on_version_no`, `pending_built_on_version_no`) |
| Moderation | P1-T4's registry: targets `publication` (system) and `publication_version` (space) | «أبلغ» (one open report per person; the author cannot report his own); a subject's Assistant / Subject Moderator hides with an Arabic reason → out of the list, no new copies, holders and the author read «أخفى المشرف هذا الشرح: …», updates stop; restore brings it back; «راجعه مشرف المادة» does not exist in Phase 1 (400); another subject's moderator gets the missing-item 404 |
| Withdraw | `POST …/publications/:id/withdraw` (author) | forks keep their copy; followed copies stop at the last version and say why; no new copies; the page is gone for everyone else |
| Account deletion (Q14) | deletion participant (`pubFanout.ts`) + P1-T1's `deletionPreview` | the author's publications become `author_deleted` (attribution «طالب سابق»), forks keep the attributed content, followed copies stop at the last version; the deletion preview counts publications and copies held by others. Since the step-3 review (R3-F) a job per publication (`publication_author_erased`, in its space) renames what the holders' vaults STORED of his name — the server-made layer titles and origin, the copy's personal-layer title while it is the server's, every `attribution` row naming him — to «طالب سابق»; the content is not touched |
| Purge | `purgeExtension.ts` | a space purge of an official version deletes its publication versions and items and withdraws the index rows; `lecture_copy.personal_items` never counts followed / forked items (written by someone else) |

Web:

* Lecture page tabs «الرسمي» / «الشروحات» (`?tab=explanations` opens the second): the banner «شروحات الطلاب ليست مصدرًا
  رسميًا…», cards (title, «شرح طالب — ليس مصدرًا», author, «الإصدار N», «ص 3 من 40», updated), «عرض المزيد», and
  «انشر شرحك» for a viewer who studies the lecture (otherwise a line saying how — no dead button).
* `PublishDialog`: the viewer's own writable layers with writing on them (a followed or forked layer is never offered),
  «شرح» layers preselected, title / summary, what is and is not published, the patient-identifier reminder, one
  idempotency key per dialog; in republish mode the head's layers preselected and «ما الذي تغيّر؟».
* `/subjects/:spaceId/publications/:publicationId`: label, author, version, completeness, built-on version, the lecture
  link, hidden / withdrawn / author-deleted notices, summary, the author's «ما نُشر في الإصدار الحالي» with what was left
  out and why, versions with change notes and item counts, «ما الذي تغيّر في الإصدار N», page previews (the official
  thumbnail + the explanation's ink and frames in SVG); actions: «ابدأ الدراسة بهذا الشرح» / «افتح نسختي» (+ «تحديث
  متاح» → «اعرض التغييرات»), «أبلغ», and for the author «انشر إصدارًا جديدًا», «عدّل العنوان والملخص», «اسحب الشرح»
  (confirmation stating what happens to the copies).
* `StartFromExplanationDialog`: «تابِع الشرح» / «نسخة مستقلة», «طبّق التحديثات تلقائيًا» (the copy's real
  `update_policy`), «انسخ ملاحظاتي من نسختي إليها» when a personal copy exists; then the reader with `?copy=<id>`.
* `UpdatePreviewDialog`: the summary («حسن: أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1»), the author's note, the changed
  pages in words AND drawn (solid = added, dashed = changed, dotted = removed, named in the caption — never colour
  alone), «ملاحظاتك الشخصية: لا يتغيّر منها أي عنصر», «طبّق التحديث» / «تخطَّ هذا الإصدار»; a 409 reloads the newer change.
* Reader copy bar: one row per explanation copy — «متابَعة: شرح حسن · حسن · الإصدار N» / «نسخة مستقلة: …», «الشرح مبني على
  الإصدار N من المحاضرة», why updates stopped, «تحديث متاح من حسن: الإصدار N» + «اعرض التغييرات», «طبّق تحديثات الشرح
  تلقائيًا», «صفحة الشرح». `?copy=<id>` makes that copy's own layer the one new writing goes to (once its layer synced).
* «أبلغ» (`ReportDialog`): the reasons of P1-T4's contract, optional details, «لا يعرف صاحب الشرح من أبلغ».

Tests (step 3): server `test/forks/{publications,followed-copies,publication-moderation,publication-versions}.test.ts`
(+ `test/forks/pubWorld.ts`, real channels), `test/lectures/matrix-specs.ts` (X9: `publication` × every action × 20
principals), `test/lectures/space-routes.contract.test.ts` (eight routes mounted), `test/forks/stubs.test.ts` (an unknown
publication is «not found»); web `test/copies/publications.test.tsx` (tab, publish with one key across a retry, the page
for a classmate / a holder / the author, hidden, not found, report, follow / fork, preview → apply / skip, auto switch,
`?copy=`, marks, CSS tokens / logical properties / 44 px); E2E (phone 390 × 844 and desktop 1280 × 800, real server,
built app) `e2e/aos-s2-followed-copy.spec.ts` (Scenario 2 steps 1–7 with variants (a)–(e)),
`e2e/aos-s4-official-version.spec.ts` (Scenario 4 in a subject), `e2e/aos-p1-vertical-slice.spec.ts` (the §5.3 slice;
the desktop project at a tablet viewport 834 × 1194), world builder `e2e/support/aos-world.ts`; axe-core (P1-T4's
`axeInLooks`, light / dark / e-ink) on the explanations tab, the publication page (classmate and author), the start,
publish, update-preview, report and official-version move dialogs: 0 serious / critical.

### Not done (step 3) — honest

* **Suggestions / corrections on an explanation and series are not built.** The frozen step-0 contract
  (`publications-api.ts`: «series … and suggestions are Phase 2+ and are refused by these schemas»), the space-route
  allow-list (no suggestion or series route is declared) and PRD §5 put them in Phase 2; their tables
  (`suggestion`, `publication_series`) exist unused. No notification kinds for suggestions.
* Inserted note pages are refused in a publication (`note_page_ids` → 409 `FEATURE_DISABLED` with the reason); pictures, bookmarks and links
  stay in the author's vault (counted in `snapshot.skipped`).
* Publishing runs in the request (synchronous, 315 ms for 5 000 strokes here), not in a worker job.
* The reader has no «copy switcher»: all copies of a lecture share one stub, so their layers show together; `?copy=`
  chooses where new writing goes and P1-T2's layers panel hides or shows each layer. With «انسخ ملاحظاتي من نسختي إليها»
  both personal layers are visible until the student hides one.
* Scenario 4 step 5 (purge of version 1) has no HTTP route in a subject space (allow-list) — asserted by the server test
  only; the Study Book citation needs an AI provider (none in the E2E server) — server test only.
* Devices (iPad + Pencil, S Pen, BOOX): Not run (no device); Render, R2: Not run.
* **Whole-instance backups still leave out `spaces/*.sqlite`** (P1-T1's `modules/data/backup.ts`; already reported by
  P1-T3 and P1-T4, not changed here). Publications live in those spaces too (`publication_version`, `publication_item`),
  so a restore would lose every published explanation's content while `system.sqlite` still lists the publications.
  Seen in this step's full E2E run: `g7-ac30-restore.spec.ts` fails (phone and desktop) when it runs AFTER specs that
  create subjects — the restore check never reaches «اختُبرت الاستعادة»; a scratch probe of such an archive showed the
  restored directory's boot blob mark ending `incomplete` (the spaces listed in `system.sqlite` have no database file
  there — `files/gc.ts` «database file missing»). Run alone on a fresh server (no space) it passes 2 / 2; run right after
  `aos-s4-official-version.spec.ts` on the same server it fails again (probe, desktop). Must be closed before release R1-c
  (BUILD_PLAN rule 9).

## Review (P1-T5 step 2, adversarial review 2026-10-21)

Probed as a student, a second and third holder (one with «انقل ملاحظاتي تلقائيًا»), a former member, a pending member,
another subject's moderator, the platform owner linking a private upload, and two devices of one student; Scenario 4
was rerun end to end on an OFFICIAL lecture with P1-T3's 40 → 42-page fixture (`srv:forks/review-step2` «Scenario 4»:
page map shape, holders «أقل من 5», preview «سيُنقل 2 · يحتاج مراجعة 1 · يبقى على الإصدار 1: 0», the tap, v1 rows
byte-identical, count before = originals + copies, the Study Book citation still on v1 with a `source_replaced` alert
naming the artifact, the automatic variant with the same counts, purge refused with a count). Every finding below was
reproduced by a failing test first; regression tests in `apps/server/test/forks/review-step2.test.ts`,
`apps/server/test/search/review-step2-drafts.test.ts` and `apps/web/test/copies/copies.test.tsx` «review P1-T5 s2».

| id | severity | finding | fix |
|---|---|---|---|
| R-A | major | P1-T2's note copy read a stub page's regions from the VAULT whenever any region of that page was pinned there (a citation pins one region), so a highlight on a page where the student had asked the AI about another paragraph went to «تحتاج مراجعة» instead of being copied | `regionsOf` asks the stub seam first (the space's full page), the vault's pinned rows only when the space cannot be read (former member) |
| R-B | major | «انقل يدويًا» to a paragraph of a stub page (Round 7 re-anchoring and the review list's copy) answered 400 «الفقرة المختارة ليست على الصفحة المختارة»: the region exists only in the space | `placementRegion` (reanchorCopy.ts) finds the paragraph on that page through the same member-checked seam; used by both routes; a region of another page is still refused |
| R-C | major (honesty) | after «اربط بالمحاضرة الرسمية», items that could not be placed safely are listed in NO review list (P1-T2's list is per source; a cross-source copy is refused), yet the dialog said «تجد ما يحتاج المراجعة في النسخة الرسمية: «ما كتبتُه» › «إعادة ربط»» and the summary «يحتاج مراجعتك» | the server summary (`linkSummaryAr`) and the dialog now say they were not copied and stay on the private lecture unchanged. **The review list itself is NOT built** (X8 (c) and AOS-19H.3 stay Partial — see «Not done») |
| R-D | minor | the purge refusal skipped a holder whose vault was locked (restore) or whose account was suspended (`vaultOf` filters active) — the purge went ahead under them, contrary to the code's own comment | `vaultStateOf`: any vault that still exists counts; one that cannot be read counts as holding items |
| R-E | minor (side channel) | DRAFT official versions (and moderators-only attachments) were indexed in `chunk_scope_fts`; bm25 statistics cover the whole index, so a moderator's unpublished draft full of a term flipped the ORDER of a student's official hits (reproduced) | only published versions are indexed (triggers + `retokenizeVersions` + the initial fill, migration-space 3300); a version enters the index in its publish transaction |
| R-F | major | a vault stub could be re-processed (`POST /api/sources/versions/:id/reprocess`) or given a replacement file (`POST /api/sources/:id/versions`) in the vault: the official text was copied into the vault's regions / chunks / FTS (where a rights takedown never reaches it) and a private file mixed into the official copy; the boot re-queue of `pending` versions could do the same | both routes refuse a stub (409, Arabic reason) before reading the upload; `enqueuePendingVersions` skips stubs |
| R-G | minor | the stub sync job decided «new version» only from what THIS attempt added: a retry after a crash between adding the version and raising the alert (or a version added by «ابدأ الدراسة») never alerted nor ran the automatic copy | the alert / automatic copy also run when the stub holds an earlier version and no alert exists for the new one (both idempotent) |
| R-H | minor (AOS-23.3) | offline, the lecture page's «ابدأ الدراسة» was disabled without a reason | an Arabic status line, tied with `aria-describedby` |
| R-I | minor (honesty) | a former member's copy said `file_removed: false` after a rights takedown that had removed the file from their vault | `file_removed` is read from the vault's own stub; the former-member wording mentions the removal |
| — | minor (perf) | the stub page readers checked membership in every stub space of the vault per page | one check, for the page's own space (`stubSpace`) |
| — | minor | a «ابدأ الدراسة» replay (same client id after a lost response) never refreshed `lecture_copy` | the replay refreshes it |

Seen and NOT fixed (reported): the cross-source review list for linked items (X8 (c)) and the copy of inserted note
pages on link (AOS-19H.3) — need P1-T2's review list to accept a linked private source (major, open); a lecture withdrawn
for an error is still retrieved / cited by the AI for holders (owner decision: refuse, or keep with a notice); a rights
takedown leaves verbatim quotes in the vault's `evidence.quote` and in «directly stated» claims of the user's AI answers
(the file and the pinned region text are removed); a stub renamed by its owner gets the official title back on the next
version; `lecture_copy.personal_items` and the purge recount see items on source pages only (an inserted note page is
not counted — a space purge never touches vaults, so nothing is lost); promote-from-vault leaves an empty draft when the
upload is refused; bm25 statistics still include WITHDRAWN (once published) versions (no draft content).

## Review (P1-T5 step 3, adversarial review 2026-10-22)

Read every changed file of step 3 (server `forks/{publications,pubItems,following,pubFanout,system,copies,index}.ts`,
`authz/rules/publications.ts`, migrations `2150` / `3050`, the two contracts, the web screens and dialogs, the three E2E
specs and `e2e/support/aos-world.ts`) and probed as a follower, an automatic follower, a fork holder, the author, an
Assistant, a Subject Moderator, another subject's student and moderator, a member removed from the subject and a
member with nothing. Every finding was reproduced by a failing test first; regression tests in
`apps/server/test/forks/review-step3.test.ts` (12) and `apps/web/test/copies/publications.test.tsx` «review R3-B».

| id | severity | finding | fix |
|---|---|---|---|
| R3-A | major (attribution, AOS-4.18) | a classmate's explanation copied into one's own layer with P1-T2's «انسخ الطبقة» — from a followed layer or from a fork — was republished under the copier's name: the snapshot checked `author_user_id` only, and the layer copy (like a fork) writes `NULL` there and keeps the author in `attribution`. Reproduced: زينب published 4 of حسن's strokes + 1 of hers as «شرحي أنا»; علي published حسن's whole fork as «شرح علي» | the snapshot reads each item's attribution row (one `LEFT JOIN`); an item another author wrote — by row or by attribution — is left out and counted «عناصر كتبها غيرك لا تُنشر باسمك»; nothing of one's own → the 409 with the counts |
| R3-B | major (moderation / withdrawal bypass) | a holder of a copy could read EVERY version of a hidden or withdrawn explanation through `…/versions/:n/items` and `…/diff`, including a version published after their copy or while hidden (the content a moderator hid, e.g. a patient's name); the publication page drew the head's previews for them | `readableHead`: author → head; hidden → head for the subject's moderators; anyone else who still sees it (a holder) → the version their copy took. `view.versions` lists only those; the page previews and «الإصدار N» use the last of them |
| R3-C | major (lost update, honesty) | a version published while the explanation was hidden never reached its followers: the fan-out ran while hidden and stopped, the restore did nothing — the preview follower read «بقيت نسختك على الإصدار 1 … وتخطّيت الإصدار 2» with no way to apply it, the automatic follower stayed behind silently | the moderation target's restore queues the head's fan-out again (after P1-T4's transaction commits; a new fan-out key); each follower's sync job keeps its key per publication + version, so a follower who was already offered that version (applied or skipped) is not asked again (test) |
| R3-F | major (privacy, Q14 / AOS-21.44) | after the author deleted the account, the copies others keep still showed his name: the followed / forked layer titles («شرح حسن»), their origin («من شرح حسن — الإصدار N»), the copy's personal layer «ملاحظاتي (متابَعة شرح حسن)» and every `attribution` row (also of P1-T2 layer copies of his items) were stored at copy time | deletion participant → `publication_author_erased` job per publication (its space) → for each holder's readable vault `eraseAuthorNameInVault`: those titles / origin / attribution rows become «طالب سابق» (layers re-synced); content untouched; a locked vault makes the job retry |
| R3-D | minor (privacy hygiene) | a stroke written while recording carried the author's private `audio_link.recording_id` into the publication and every follower's vault (a follower's tap reaches nothing) | the snapshot drops `audio_link` (also inside a shape's `recognized_from`) |
| R3-G | minor (honesty) | «اسحب الشرح» said followers stay «عند الإصدار الأخير ويصله أنك سحبته» — no notice is sent and a follower stays at the version they APPLIED | wording: «تبقى نسخته عند آخر إصدار طبّقه ويرى فيها أنك سحبته»; the withdrawn / author-deleted notices likewise |

Probes that held (kept as tests): a follower cannot move حسن's stroke into her own layer through the sync (rejected; the
followed row unchanged — an update can therefore never overwrite her writing); a member removed from the subject gets
no update, no inbox entry, the missing-route 404 on every publication route and a 409 on «اعرض التغييرات», and keeps
the copy; a moderator's restore cannot resurrect an explanation its author withdrew.

Seen and NOT fixed (reported):

* **minor** — a member who LEAVES or is removed from the subject can no longer withdraw or edit an explanation they
  published there (every publication route needs membership; account deletion still withdraws it). Needs an
  account-level «شروحاتي» route (Phase 2 profile) or an allow-list exception decided with P1-T4.
* **minor (NFR-OP2)** — publishing reads the author's layers and writes the version inside the request (315 ms for 5 000
  strokes here), not in a worker job as ARCHITECTURE_DELTA §6.4 describes.
* **minor** — a rights takedown of the lecture leaves the verbatim `quote` of text highlights in `publication_item` rows
  (served to members) and in followers' vaults — the same owner decision as step 2's R-M.
* **minor** — notes of a followed copy or a fork are not indexed in the reader's `owner_content_fts` (P1-T2's
  `indexNote` is not called by `following.ts`): a forked note becomes searchable only after the reader edits it.
* **minor** — the per-lecture list pages by `(updated_at, id)`; a republish or restore while a reader pages moves an
  explanation to the top, so «عرض المزيد» can skip it once.
* **minor** — the restore re-fan-out (R3-C) runs right after the moderation transaction (a microtask); a crash in
  between leaves that version undelivered until the next republish.
* **environment, other track (P1-T1's `apps/server/test/helpers/template.ts`)** — every server test worker leaves its
  `/tmp/medlevo-vault-template-*` directory behind (the `process.once('exit')` cleanup does not run when vitest ends its
  workers): 8 437 of them (≈ 17 GB) had filled this container's disk, and the first E2E run of this review failed with
  `ENOSPC` on every spec. The review removed the stale ones (older than 20 minutes, no test process running) and re-ran;
  the helper itself was not changed.
