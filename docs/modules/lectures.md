# Module: lectures — official lectures in subject spaces (Academic OS P1-T5)

> **Status:** step 1 built and adversarially reviewed (2026-10-21; twelve findings fixed with regression tests — see
> «Review» below). Server: official lectures, versions, approval,
> publish with P1-T3's page map, corrections, withdraw and rights takedown, attachments, exam dates, the `subject_event`
> feed, the offline package, duplicates, and the space reads re-mounted for official content. Web: the «إدارة القنوات»
> sections «المحتوى الرسمي» and «الملفات المكررة», registered through P1-T4's registry (the area that hosts
> `/admin/:section` is P1-T4's step 3, so the sections are not reachable from the app yet). Steps 2 (copies, stubs,
> fan-out, federated search, from-vault) and 3 (publications) are not built. Design: ARCHITECTURE_DELTA §4.4, §5.5,
> §6.7, §7.4; BUILD_PLAN §3.7; PRD AOS-2.2, 2.3, 2.5, 2.9, 4.5, 18.3, 18.4, 18.9, 18.10, 18.11, 21.7, 21.8; Q5.

## What it does

| piece | where | notes |
|---|---|---|
| Tables | `migrations-space/3000_official_lectures.sql`, `3010_subject_content.sql` | space set (3000–3999) on top of the base migrations: `official_lecture` (number 1–999, date, status, head version, uploader, approval, withdrawal, takedown time, idempotency hash of the create body), `official_version_publish` (who / when / note / kind `upload`·`correction` / page-map status), `official_version_upload` (who uploaded which version), `official_correction` (contributors' proposals and queued moderator corrections), `subject_attachment`, `subject_exam_date`, `subject_event` (`seq` AUTOINCREMENT, `visibility_key` NULL or `'mod'`). Pages, regions, chunks and files are the existing base tables in the space DB — one schema, no copies |
| Access | `modules/authz/rules/lectures.ts` | three self-registered rules (`lectures.official-lecture`, `lectures.subject-content`, `lectures.space-file`); see the table below. Powers come from the membership provider's `roles` (P1-T4's `ChannelAccess`): official moderator = Subject Moderator or Admin of the subject, or the platform admin; contributor = Contributor or an official moderator; an **Assistant has no power over official files** (Q5). Without roles the rules fail closed |
| Lectures | `service.ts` | create (idempotent by client id: same body → same row, different body → 409), patch (title / number / date; `lecture_no_origin: 'moderator'`), upload, approve, publish (with preview), compare, page-map decisions, withdraw. Ordered by number, then date, then title (AOS-2.2); keyset cursor |
| Upload | `ingest.ts` | multipart, one file per request, inside the bound space: `inspectFile` → refuse audio, unsupported types and a second identical file on the same lecture (409, names only this lecture) → stored parts → `source_version` + pages in one transaction → the existing processing job. A failed insert removes the stored file. A contributor's upload moves the lecture to `in_review` and clears an earlier approval. JSON `{upload_id}` (P1-T1 chunked uploads) answers 404 «جلسة الرفع غير موجودة في هذه المادة…»: T1's uploads refuse a space target |
| Publish | `service.ts` `publish` | moderator only; refused (409) while the version's processing is not `ready` / `partial` / `needs_review` and for a superseded version; a withdrawn lecture is never published again (403). `{preview:true}` changes nothing and answers the page changes against the previous version (when P1-T3's fingerprints are complete) and `holders` as a `GroupCount` (never a number under 5). Publishing a contributor's version is its approval. Re-publishing the head is a no-op. Writes `lecture_published` / `version_published` to `subject_event` in the same transaction and enqueues `official_page_map` (P1-T3's map from the previous version) |
| Corrections | `corrections.ts` | a moderator's correction of a **draft** changes it in place; of the **published head** it queues `official_correction`, a job that copies the version (deterministic ids from the correction id), applies the text, rebuilds the chunks (FTS by triggers), publishes it as `kind: 'correction'` and enqueues the page map — published regions are never written (§6.7). A contributor's correction is a proposal (`open`) that a moderator accepts (→ the same job) or rejects; `GET /subject/corrections` is the moderators' queue. Bidi and control characters are stripped from corrected text |
| Withdraw / takedown | `service.ts` `withdraw` | reason + Arabic note for students. `replaced` / `error` / `other`: status `withdrawn`, nothing deleted. `rights_takedown`: in one transaction the file references of every version, page render / thumbnail, rendition and image asset are nulled, chunks deleted (FTS follows), region text cleared; then each stored file is removed when nothing references it. Pages stay as placeholders, so students' ink and notes (vault side, step 2) keep their anchors; page reads still answer, region reads and file reads answer 404 |
| Attachments | `subject.ts` | summary / previous exam / reference, uploaded through the same ingest into a space `source`; a moderator's upload is published at once (+ `attachment_added` event), a contributor's waits as a draft; `PATCH` publishes or withdraws (moderators). Members see published ones; drafts are listed to moderators and their uploader |
| Exam dates | `subject.ts` | `PUT /subject/exam-dates/:id` creates or replaces (idempotent by id), `DELETE` marks it `cancelled` — both write `exam_date_changed`; lecture ids are checked against the subject (400). No web screen: exam dates are Phase 2 in IA §4.10 |
| Updates feed | `subject.ts` `events` | `subject_event` read by `seq` cursor; rows with `visibility_key = 'mod'` (drafts awaiting approval) only for moderators |
| Duplicates | `subject.ts` `duplicates` | moderators only; this subject's lectures and attachments: identical = same `content_hash`; near = shared page `text_norm_hash` ≥ 60 % of the larger version (P1-T3's fingerprints), grouped by union-find. `checked` says how many versions were compared and how many have fingerprints, so «no duplicates» is never silent |
| Offline package | `offline.ts` | `GET /lectures/:id/offline-package` for a published lecture: the version's pages, regions, TOC and file URLs (space paths, content hashes) collected by in-process requests with the viewer's cookie, so every read goes through the same checks; no annotations or notes (they live in the vault). The forwarded reads carry a per-process secret header (`x-medlevo-forward`) that exempts them from the per-address read limit (review R6) |
| Space reads | `reads.ts` | the id-keyed reads (`sources/:id`, pages, regions, processing, reprocess, TOC, files, thumbnail, `files/:id`, `files/:id/meta`) are re-mounted under `/api/spaces/:spaceId/…` and resolve the owning lecture or attachment first (review W2-step0 R12): drafts, withdrawn and taken-down content and moderator-only attachments answer exactly like a missing route. Reprocessing a published version is refused (409) |
| User names | `system/directory.ts` (`publicDirectory`) | display names and space titles for views without importing system repositories into a feature module (import-boundary test); a deleted account is «طالب سابق» |
| Web | `apps/web/src/features/lectures/{api.ts, admin/*}` | `lecturesApi` (every call names the space), `loadAdminSubjects` (subjects with an official role from P1-T4's tree), `useAdminSubjects` (choice kept in `?subject=`), `SubjectScope` («نطاقك: …» or a chooser), `OfficialContentSection`, `DuplicatesSection`, `lectures-admin.css` (tokens only, logical properties, 44 px), `register.ts` (imported by `features/lectures/routes.ts`; the route table stays empty) |

## The rules

| resource : action | allowed | otherwise |
|---|---|---|
| `official_lecture` view, list | published, or withdrawn after it was published: every member; draft / in review, and a lecture withdrawn before any version was published (a rejected draft): official moderators and its uploader | 404 |
| a DRAFT version of a lecture (detail, pages, files, compare, corrections) | official moderators; the contributor who uploaded THAT version; the uploader of a lecture that was never published (their own draft) | 404 |
| `official_lecture` create (`id = ''`) | contributor powers | 403 |
| `official_lecture` create (upload a version) | official moderator; a contributor on their own draft or on a published lecture (the new version waits for approval); never on a withdrawn lecture | 403 / 404 if hidden |
| `official_lecture` edit (patch, corrections, page-map decisions) | official moderator; a contributor on their own unpublished draft; never on a withdrawn lecture | 403 / 404 |
| `official_lecture` suggest (a contributor's correction proposal) | contributor powers on a lecture they can see, not withdrawn | 403 / 404 |
| `official_lecture` approve, publish, withdraw | official moderator | 403 / 404 if hidden |
| `space` list, view | members (gate 2) | 404 |
| `space` publish (attachments) | contributor powers (moderators publish, contributors file drafts) | 403 |
| `file` view (`db = 's:<space>'`) | members, after the owning lecture / attachment is resolved by the route | 404 |

Gate 2 (P1-T1 binding + P1-T4's `ChannelAccess`) runs first: a non-member, a pending member and a moderator of another
subject never reach these rules (404 / 403 `MEMBERSHIP_PENDING`). Every route is on the space allow-list
(`modules/authz/spaceRoutes.ts`) with its minimum access; three declarations were added in step 1
(`GET /subject/corrections`, `POST /lectures/:id/corrections/:cid/decide`, `GET /subject/duplicates`).

## Review (2026-10-21)

Adversarial review of step 1 (BUILD_PLAN §1.2). Every finding was reproduced by a test that failed first
(`apps/server/test/lectures/review-step1.test.ts`, `apps/web/test/copies/lectures-admin.test.tsx` «review …»):

| # | severity | defect | fix |
|---|---|---|---|
| R1 | major | a lecture withdrawn before it was ever published (a moderator rejecting a contributor's upload) became visible to every member — title, uploader, reason in the list and detail — and wrote a public «سُحبت: …» line in the updates feed | the rule treats a withdrawn lecture without a head version as a draft (`everPublished` on the resource, a `withdrawn_draft` state in the X9 specs); no feed line unless it was published; the withdraw dialog says students never saw it |
| R2 | major | draft versions followed the LECTURE's uploader: a contributor saw another contributor's unapproved upload of their lecture (detail, file), and the uploader of a new version could not see it | `seesDraftVersion`: moderators, the version's own uploader, or the uploader of a never-published draft |
| R3 | major | a correction job retried after it had published (crash before the bookkeeping) marked the correction `failed`, leaving its page map un-queued | the retry finds the published derived version and records `applied`, re-queueing the page map (idempotent key) |
| R4 | major | a newer upload waiting as a draft became unpublishable for ever once a correction (n+1 of the head) was published, and its identical bytes could not be uploaded again | «superseded» compares with the upload the head stands for (a correction stands for the version it corrected) |
| R5 | minor | a rights takedown left the lecture's text in the correction queue (proposed and applied items) | the takedown empties every correction's items and note, closes open proposals (rejected) and queued ones (failed) with the reason |
| R6 | major | the offline package's in-process reads all came from 127.0.0.1 and shared one rate-limit bucket: 50 12-page packages in a minute and every student's package failed with 500 | forwarded reads carry a per-process secret header that skips the read limit (the package route itself stays limited per client) |
| R7 | minor | space files were served `immutable` for a year, so after a takedown or a removal a device kept reading them without asking | `cache-control: private, no-cache` on `GET /files/:id` (ETag → 304; a removed member's revalidation is 404) |
| R8 | minor | exam dates listed ids of draft lectures and an attachment named its draft lecture (title) to every member | both show only lectures the viewer may see |
| R9 | major | a rights takedown left the lecture's sentences in the Course Brain's mention quotes, relation statements, relation reasons, algorithms and figure readings of the space | the takedown clears them (the purge's own treatment of a deleted version) and cancels the versions' queued / running jobs; concept names (short terms) stay |
| R10 | major | the upload routes stored every multipart file part on disk before asking whether the member may upload: any student could make the server write up to 50 × the upload limit per request | the authz check runs before the body is read; a second file part is refused before a byte of it is stored |
| R11 | minor | a contributor could change their draft after a moderator approved it and keep the approval | a contributor's change to an approved draft clears the approval (back to «in review») |
| R12 | minor | «أضف وارفع الملف» created a second lecture when the file was refused after the draft was created | the form keeps the created draft and the next send uploads into it («ارفع الملف إلى المسودة») |

Not fixed (reported): whole-instance backups without `spaces/*.sqlite` (P1-T1's files, see below); no control to upload a
NEW version of an existing lecture in the web section (server route exists; the screen only creates lectures); a replayed
upload of the same bytes answers 409 (`details.version_no`), not the first answer; thumbnails rendered by poppler keep
`max-age=3600`; `GET …/compare` may compute a page map on the request when the pair was never mapped (P1-T3's
`compareVersions`); a processing job already running when a takedown lands may write text back before it sees the
cancel (reads of a taken-down lecture refuse regions, TOC, files and thumbnails regardless).

## Phase 1 completion — track C2 (2026-10-22)

| row | what was missing | built | evidence |
|---|---|---|---|
| AOS-2.3 / 18.3 | only PDF exercised in a space; no bulk upload | PPTX, DOCX and image files go through the same space ingest (processed in the space, uploader recorded, the file answers 404 to a stranger and to another subject's moderator); «ارفع عدة محاضرات» in «المحتوى الرسمي»: one draft per file named from the file, uploaded one after the other with a result per file (a refused file says why; a draft whose file failed says so) | `srv:lectures/formats-duplicates.c2`, `web:copies/official-admin.c2`, `e2e:aos-c2-official-content` |
| AOS-2.2 | the student-facing list | the subject's «المحاضرات» tab keeps the server order (number → date → title) and marks every published lecture «رسمي» with «نشرها …» (`head_version.published_by`, additive); a number read from the file says «(مقروء من الملف)» | `web:copies/official-provenance.c2`, `e2e:aos-c2-official-content` (order 3, 5, 6, 7) |
| AOS-3.6 | a space-scoped duplicate answer | `POST …/lectures/:id/upload` answers `duplicate_of` / `duplicate_note_ar` only when the uploader may SEE the other lecture (`authz view` + `versionVisibleTo`): another contributor's hidden draft gives no title and no hint; the moderator is told. The single-file form and the bulk list show the note as given | `srv:lectures/formats-duplicates.c2` |
| AOS-3.11 | the followers were not told | the subject's review queue proposes «إصدار جديد من …» (P1-T3's analysis run in the space); accepting turns the stored file into a new DRAFT version of the existing lecture (same blob, `official_version_upload` keeps the original uploader), withdraws the duplicate draft (`replaced`) and writes a moderators-only feed line; publishing it fans out to the holders through P1-T4's notifications (`official_version`) | `srv:lectures/review-queue.c2` |
| AOS-3.18 | the role-scoped queue | `GET /api/spaces/:s/subject/review` + `POST …/subject/review/:itemId/decide` (official moderators only — an Assistant, a student, another subject: 403 / 404; declared on the space allow-list). Uncertain numbers / dates / titles / new-version proposals change nothing until accepted; a certain number read from the file fills an EMPTY number (`lecture_no_origin: 'detected'`) through the `onIdentityAnalyzed` seam of `versions/identity.ts`; a moderator's number is never overwritten; a rejected value does not come back on reprocessing. The web queue «مراجعة ما اقترحه التحليل» marks every proposal «اقتراح آلي — مؤكد / غير مؤكد» with its reasons and what accepting does (19I.5) | `srv:lectures/review-queue.c2`, `web:copies/official-admin.c2` |
| AOS-4.5 / 18.18 / 19I.2 | «رسمي» and the publisher on the student page | the lecture page says «رسمي · <المادة>», «نشر الإصدار n: <name>», and each published version «رفعه …», «نشره …», «يحلّ محل الإصدار n−1»; the admin list names each version's uploader and publisher and «رقم مقروء آليًا من الملف» | `web:copies/official-provenance.c2`, `e2e:aos-c2-official-content` |
| AOS-18.4 | the E2E through «المحتوى الرسمي» | a Contributor adds a lecture with its file there, the Subject Moderator approves and publishes it there (students never saw the draft) | `e2e:aos-c2-official-content` (phone + desktop) |
| AOS-11.27 (space part) | per-viewer feeds | `subject_event` rows carry a visibility key (none = members, `mod` = official moderators, `u:<id>` = one person); the read asks only the viewer's keys AND re-checks each row's target for that viewer (a withdrawn or moderators-only attachment's line leaves the members' feed); a withdrawn never-published draft tells only its uploader («لم تُعتمد مسودتك …»); paging never skips or repeats a visible line | `srv:lectures/feed-visibility.c2` |

Edits outside this module (smallest exact edits, reported): `modules/versions/identity.ts` (an observer seam,
`onIdentityAnalyzed`), `modules/authz/spaceRoutes.ts` (two declarations), `apps/web/src/features/channels/SubjectScreen.tsx`
(the row's «رسمي» / publisher). Still open: chunked (resumable) uploads into a space (P1-T1's uploads refuse a space
target; bulk upload is one multipart request per file); ZIP import (AOS-3.1).

Review of track C2 (2026-10-22): **R4 (major)** — when one file of «ارفع عدة محاضرات» failed after its draft was made,
the result told the moderator to upload it again from «أضف محاضرة رسمية» «بالعنوان نفسه», which makes a SECOND draft
(that form reuses only a draft it made itself) and leaves the empty one behind. The failed row now offers «أعد المحاولة:
<file>», which uploads the same file into the SAME draft (or makes the draft when none was made), and the count «رُفعت n
من m» follows (`web:test/copies/official-admin.review-c2`). Who reaches the review queue and the feed was tried as every
kind of person (`srv:lectures/review-feed.review-c2`, no defect).

## Tests

`apps/server/test/lectures/{lectures,corrections,subject-content,rules,channels-integration,space-routes.contract,review-step1}.test.ts`
(world: `world.ts`, two registered spaces, a test membership provider; `channels-integration` uses P1-T4's real channels),
the X9 matrix specs `test/lectures/matrix-specs.ts` (official lecture, «new» create target, space file) run by P1-T4's
`test/authz/matrix.test.ts`; `apps/web/test/copies/lectures-admin.test.tsx` (registration, moderator / contributor
controls, publish preview, takedown typed confirmation, corrections, chooser, duplicates, structure probe — axe-core is not
installed in this repo).

## Not done here (later steps or other owners)

* **Whole-instance backups do not include `spaces/*.sqlite`** (`modules/data/backup.ts` / `restore.ts`, P1-T1). Official
  content now lives in spaces, so a restore would lose it. Must be closed before release R1-c (BUILD_PLAN rule 9).
* ~~Notifications to copy holders, `holders` from `lecture_copy`, stub fan-out, the vault side of a takedown,
  `pinned_region`, `POST /lectures/from-vault`~~ — built in step 2 (2026-10-21, awaiting review): the publish preview
  counts `lecture_copy` holders (bucketed); the first publication and every later version are fanned out to holders and
  followers after the page-map job; withdraw / takedown reach the vaults; the published head carries the `hd` scope
  token (`retokenizeVersions` on publish / withdraw); `from-vault` promotes a moderator's private lecture as a draft. See
  `copies-publications.md`. Notifications go through P1-T4's `publish()` (official_lecture_new, official_version,
  subject_update, reanchor_ready).
* `POST /api/spaces/:s/files/:id/token` — not mounted: P1-T1's token redemption binds vaults only.
* Chunked (resumable) uploads into a space: P1-T1's `files/uploads.ts` refuses a space target, so uploads are one
  multipart request; bulk upload / ZIP import (AOS-3.1) not built.
* Previous exams feeding the space's question bank (AOS-2.5) — no space routes declared (W2-step0 note N2).
* «الملفات والمواعيد» admin section (attachment approval screen), the «الشروحات» tab of the lecture page (step 3), and
  any reachable admin screen — the area host route `/admin/:section` is P1-T4's step 3; no E2E for these screens yet.
  The lecture page itself (`/subjects/:spaceId/lectures/:lectureId`, tab «الرسمي» content with «ابدأ الدراسة») is built
  in step 2.
