# Academic OS — Phase 1 report (GATE-1, PRD AOS-23.1)

> **Date:** 2026-10-22 · **Gate:** BUILD_PLAN §3.9 «GATE-1 — Phase 1 exit gate», run in this container on the whole
> tree (base `514f356` = release R1-b, plus the R1-c work of wave 2 — the contracts, P1-T4 steps 1–3 and P1-T5 steps
> 1–3, each built and adversarially reviewed — kept in the snapshot commit `48bc41e` when a container restart
> interrupted this gate, plus this gate's own changes). **Nothing here was run on a device, on Render, on Cloudflare R2, with an AI key or
> with real course files** — every such item is listed «Not run (reason)» in §6.
> **Owner decisions needed** (PRD §5.2): the Not-run list (§6) and the blocked rows (§5.2) — §13 lists them. Signing
> them does **not** close Phase 1 (§1): the open buildable Musts (§5.3) must be built first. The next phase starts only
> after the phase is closed (AOS-23.1).

## ملخص للمالك

<div dir="rtl">

**النتيجة: المرحلة الأولى لم تُغلق بعد.** ما بُني في هذا الإصدار (R1-c) يعمل في الاختبارات هنا على متصفح Chromium
(لا على جهاز حقيقي): شجرة الجامعة والكليات والمواد، الانضمام برمز الصف أو رابط الدعوة فقط (لا تسجيل مفتوح)، المحاضرات
الرسمية وإصداراتها، «ابدأ الدراسة»، متابعة شرح زميل مع معاينة تحديثه، نقل ملاحظاتك إلى الإصدار الجديد بنسخها لا بنقلها،
الإبلاغ والإخفاء والاستعادة، والنسخة الاحتياطية الكاملة التي صارت تشمل كل مادة.

لماذا لم تُغلق:

* **50 متطلبًا إلزاميًا ما زالت ناقصة مع أنه يمكن بناؤها واختبارها هنا** (القسم 5.3). توقيعك لا يغلقها؛ يجب بناؤها.
* معيار الخروج X8 (ج) و(د) لم يتحقق كاملًا: عند ربط محاضرة خاصة قديمة بالمحاضرة الرسمية قد تبقى عناصر لا تظهر في أي
  قائمة مراجعة، ولا توجد نسخة احتياطية مستقلة لكل مادة.
* **13 متطلبًا تحتاج أجهزتك أو حساباتك** (iPad وقلم Apple، S Pen، BOOX، Render، Cloudflare R2، مفتاح الذكاء الاصطناعي):
  لم تُشغَّل هنا لأنها غير متوفرة، وتبقى مفتوحة حتى تُختبر على الأجهزة الحقيقية.

ما نحتاج قرارك فيه (القسم 13): أن توافق على قائمة «لم يُشغَّل» وأسبابها، وأن تجيب عن سؤال واحد مفتوح (هل يقبل مشرف
المادة طلبات الانضمام؟). السرعة: لم يتباطأ شيء أكثر من 10٪ مقارنةً بالإصدار R1-b عند إعادة القياس (القسم 7).

تحديث خادمك على Render: الخطوات بالعربية في `docs/DEPLOY_PHONE_AR.md` «التحديث إلى الإصدار R1-c» (خذ نسخة احتياطية
أولًا — هي طريق العودة الوحيد).

</div>

## 1. Verdict

**Phase 1 is not complete, and it is not «closed with blocked Musts» either: the Phase 1 gate does not pass.** PRD
§5.2 knows two outcomes — «complete» (every `M` row passes) and «closed with blocked Musts» (every `M` row passes except
those that can only run on a device or real data, which the owner signs off). Neither holds while `M` rows that **can**
be built and tested here are open, and while an exit criterion (X8 (c), (d)) fails; the owner's sign-off cannot close
those (GATE-1 review, 2026-10-22 — the gate's first draft called the phase «closed with blocked Musts»):

* **Every Phase 1 exit criterion that can be run here passes, except X8 (c) and (d)** (§2): Scenarios 2 and 4,
  AC-01a, AC-01b, X9, the minimal moderation flow end to end, the existing suites inside a bound vault, the X8
  owner-migration checklist parts (a), (b) and (e) — including the real R1-a release migrated through R1-b and then
  upgraded to this build — the performance gate against R1-b (§7: no PRD budget broken; the two medians the gate saw
  more than 10 % slower did not reproduce when its reviewer re-ran those tests alternately, 5–6 runs per release), and
  this report.
* **X8 (c) and (d) do not fully pass** (§2): items of a linked private lecture that could not be placed are in no
  review list and inserted note pages are not copied (AOS-19H.3, Partial); a per-space backup / restore-verify as its
  own artifact does not exist (the spaces are now inside every whole-instance archive — fixed by this gate, §4).
* **Of the 123 Must rows of Phase 1**: 60 pass here, 13 are blocked on devices or accounts (§5.2, PRD §10.1 — they pass
  only on the real thing and are «Not run»), and **50 are open although they could be built or tested here** (§5.3:
  39 Partial, 4 Not Started, 7 with no Phase-1 evidence yet). PRD §5.2 allows only `S` / `C` rows to move to a later
  phase; these `M` rows stay open and are listed again in every later phase report until they pass. (The gate's first
  draft counted 63 / 12 / 48; its reviewer moved 1.10 to the blocked rows and 1.16 and 23.3 to Partial — §9.)
* **What to do next:** build the 50 rows of §5.3 and X8 (c), (d) (a GATE-1 re-run then decides «complete» or «closed with
  blocked Musts»); the owner answers §13 now.

GATE-1 itself built no product feature (BUILD_PLAN §3.9). It found and fixed six defects at their root, each with a
test that failed first, and three defects of the test harnesses (§4); the most serious were data-safety defects of
the release itself: **official lectures were missing from every whole-instance backup**, and **an R1-a owner deploying
R1-c directly was told to «install R1-a and run it once»** — a loop with no way forward.

## 2. Phase 1 exit criteria (PRD §5, Phase 1 row)

| criterion | result here | evidence |
|---|---|---|
| Scenario 2 (follow a classmate's explanation, write offline, preview and apply his update, personal notes untouched) | **pass** | `e2e/aos-s2-followed-copy.spec.ts` phone + desktop (full run 1 and final run); server `test/forks/*` |
| Scenario 4 (new official version: notes copied with one tap or automatically, review list, followed explanation built on v1) | **pass** | `e2e/aos-s4-official-version.spec.ts` phone + desktop; `e2e/aos-p1-note-migration.spec.ts` |
| Phase 1 vertical slice (join → study → write offline → follow → his update → new official version → report, hide, restore) | **pass here** (iPad-sized viewport 834 × 1194 in desktop Chromium); its `[dev]` part — offline writing on a real iPad — **Not run (no device)** | `e2e/aos-p1-vertical-slice.spec.ts` (since the GATE-1 review it also presses «افتح نسختي» and checks that the same copy reopens, AOS-2.18) |
| AC-01a — the personal library for a user with no channel | **pass** | server `test/acceptance/ac01a.test.ts` (7 passed), `e2e/aos-ac01a.spec.ts` phone + desktop |
| AC-01b — two users, two subjects in two universities, no cross-user leakage | **pass** | `test/acceptance/ac01b.test.ts` (7), `ac01b-content.test.ts` (8) |
| X9 — permission matrix (resource × action × role × membership × scope, every channel / moderation / admin / notification route) | **pass** | `test/authz/matrix.test.ts` (10 tests, generated cases) |
| Minimal moderation flow (report → hide → author notified → restore → audit entry) | **pass** | `test/moderation/minimal.test.ts` (14), `review-step2.test.ts` (7), `audit-view.test.ts` (4); `e2e/aos-p1-admin.spec.ts` «with a fixture report»; the vertical slice |
| The existing suites pass inside a bound vault; tests edited beyond the binding helper listed | **pass** | `npm test` on the final tree (§3); the list of edited tests is in `docs/TEST_LOG.md` «P1-T1 step 1» |
| X8 (a) legacy-owner migration, journaled, crash after every step | **pass** in this container | `test/tenancy/owner-migration.test.ts` (38), `owner-migration.review.test.ts` (11), `owner-migration.gate1.test.ts` (4, new); end to end against the **real** R1-a release (§2.1) |
| X8 (b) a legacy outbox queued before the upgrade is replayed once after it | **pass** | the same suites (two devices' queued ops: applied once, re-send = duplicate); the R1-b final end-to-end run |
| X8 (c) the owner links existing private lectures to official ones (AOS-19H.3 / 19H.4) | **fails in part** | `test/forks/link-private*` pass for what is built; items that cannot be placed land in **no review list** and inserted note pages are **not copied** (19H.3 Partial, P1-T5 step-2 reviewer) |
| X8 (d) per-vault and per-space backup and restore-verify | **partial** | per-vault: `test/tenancy/vault-backup.test.ts` (9); spaces: now inside every whole-instance archive and verified (`test/data/gate1-space-backup.test.ts`, 4, GATE-1 fix); a **per-space** archive of its own is not built |
| X8 (e) operator whole-server restore | **pass** | `test/acceptance/g7-ac30.test.ts` (9), `e2e/g7-ac30-restore.spec.ts` phone + desktop (backup in the app → server restore check → encrypted download → CLI restore → second server) |
| Performance gate (AOS-23.2) | **pass here, not in CI** — no PRD NFR-P budget broken (P1 Not run, P4 not before Phase 4). The gate's medians of 3 showed two server numbers > 10 % slower than R1-b (a 5 000-stroke page read +11 %, boot +17 %) — AOS-23.2 would block the exit on them; its reviewer re-ran exactly those tests alternately (R1-b × 5 / R1-c × 6 and R1-b × 4 / R1-c × 5): **−4 %** and **−9 %** (first boot +6 %), so no regression > 10 % is established (§7). The rule «rerun in CI» is not met (23.2 stays Partial) | §7; `docs/PERFORMANCE.md` «GATE-1» and «GATE-1 review» |
| Phase report (AOS-23.1) | this document | the owner's decisions of §13; the phase closes only when §5.3 is empty |

### 2.1 The owner migration through this build, against the real releases

Run with `gate1/mig/e2e-migration-r1c.mjs` (scratch, outside the repository) on fresh copies of the realistic R1-a data
directory of the R1-b final verification (`legacy-fixture.ts`: two processed lectures, ink in two layers, notes, cards
with reviews, an exam in progress, a Study Book, a recording, two devices' sessions and queued outboxes), with the
real `git archive` builds of R1-a (`d0c8ab4`) and R1-b (`514f356`):

* **R1-a → R1-b → R1-c (the supported path): 43 / 43 checks.** R1-a writes more through its own sync; R1-b's upgrade
  page migrates it (byte for byte, every feed entity / read API / file / recording identical as user #1); R1-b makes a
  backup and its restore check passes; a note is written under R1-b; **this build boots straight into the app** on the
  same directory (no maintenance page), every entity, API answer and file still identical, base migrations 0163 / 0860
  applied to the vault at the first open; the owner (platform admin) creates university → college → subject with its
  own space; a whole-instance backup of R1-c holds that space and its restore check passes (19 checks); this build's
  `restore:verify` passes on the R1-b archive (the way back); and **R1-b refuses to start on the directory R1-c has
  migrated** («Database has migration 2050_directory.sql which is not present in this build») — so going back from R1-c
  means restoring the backup made before deploying it.
* **R1-a → R1-c directly: refused, nothing changed (8 / 8 checks after the fix).** R1-c adds base migrations, so by the
  release rule (ADR-0003 §5) it must not move an R1-a database itself. Before the fix the upgrade page refused with
  «قاعدة البيانات أقدم من الإصدار R1-a … ثبّت R1-a وشغّله مرة واحدة» — wrong and a loop (§4, defect 3). Now it names
  the way that works (deploy R1-b first, finish its upgrade, then this release), `medlevo.sqlite` stays byte-identical,
  no `system.sqlite` or `vaults/` appears, and R1-a still serves everything on the untouched directory.

## 3. Test results

All commands from the repository root with `NODE_OPTIONS='--disable-warning=ExperimentalWarning'`; per-command logs and
durations: `docs/TEST_LOG.md` «GATE-1 — Phase 1 exit gate».

**First pass on the whole tree (before any change of this gate, 03:30–04:19 UTC):** typecheck, lint, build (337
precache entries) and the evaluation gate (regression **80 / 80**, `no_regressions`) green; `npm test` green — shared
**229**, server **2 307** (+7 skipped), web **1 203** (+1 skipped); **full E2E on phone + desktop: 177 passed, 2
failed, 17 skipped** — the failures were both `e2e/g7-ac30-restore.spec.ts` (phone and desktop): the backup's restore
check failed on the subject spaces, and then the download was refused (defects 1 and 2, §4).

**Final pass on the final tree:** (05:41 → 07:16 UTC) `npm run typecheck` 0 (66 s); `npm run lint` 0 (77 s);
`npm test` 0 (542 s) — shared 14 files · **229 passed**, server 239 files + 7 skipped · **2 319 passed** + 7 skipped, web
181 files + 1 skipped · **1 211 passed** + 1 skipped (3 759 = the first pass's 3 739 + 20 new GATE-1 tests); `npm run
build` 0 (337 precache entries); evaluation **80 / 80**, `no_regressions` (`eval-20261022T055252-79bbf356`). **Full E2E,
phone + desktop (05:53 → 06:31): 196 tests — 174 passed, 5 failed, 17 skipped**: `f1-notebook-pages` × 4 and
`critic-screens` desktop × 1 — test defects 8 and 9 (§4), no product failure; both specs fixed and re-run on both
projects: **10 / 10 passed** (06:32 → 06:38). **Second full E2E on the final tree (06:38 → 07:16): 196 tests — 179
passed, 0 failed, 17 skipped (37.7 min, exit 0).** The 17 skipped are project-conditional or opt-in (`perf` 12,
`aos-p1-layers` 2, `aos-ac01a`, `h3-reader-notes` and `r1b-final-critic` 1 each). After the last spec edits `npm run
typecheck` and `npm run lint` were run once more on the whole tree: exit 0 / 0.

**Acceptance files, by name (final tree, `vitest --reporter=json`):** server — 26 files, **233 passed, 0 failed**:
`acceptance/` ac01a 7 · ac01b 7 · ac01b-content 8 · g7-ac30 9; `authz/matrix` 10 (X9); `data/` gate1-space-backup 4 ·
gate1-backup-download 3; `moderation/` minimal 14 · review-step2 7 · audit-view 4; `tenancy/` owner-migration 38 ·
owner-migration.review 11 · owner-migration.gate1 4 · vault-backup 9 · isolation 12 · template-dir.gate1 1; `forks/`
(Scenarios 2 and 4, server side) followed-copies 11 · publications 12 · publication-moderation 8 · publication-versions 3
· versions 8 · stubs 8 · link-private 6 · course-follow 3 · review-step2 14 · review-step3 12. Web — 17 files, **142
passed, 0 failed**: `test/channels/*` (9 files) 74, `test/copies/*` (5 files) 53, `GoToPage.gate1` 6,
`breadcrumbs-css.gate1.critic` 1, `features/offline/screens` 8. E2E (both final full runs, phone + desktop, all passed):
`aos-s2-followed-copy` 2, `aos-s4-official-version` 2, `aos-p1-vertical-slice` 2, `aos-ac01a` 5 (+1 skipped),
`aos-p1-admin` 4 (incl. the moderation flow with a fixture report), `aos-p1-join` 12, `aos-no-decorative` 10,
`g7-ac30-restore` 2, `g8-security` 8, `aos-p1-note-migration` 2.

**Re-checked by the gate's reviewer (2026-10-22, after the review's edits):** the server acceptance files by name again
(12 files, 78 passed — the gate's per-file numbers); `npm run typecheck` 0 and `npm run lint` 0 on the whole tree; the
E2E specs this gate and its review touched plus the smoke spec, phone + desktop
(`aos-p1-vertical-slice` with the new «افتح نسختي» step, `aos-no-decorative`, `critic-screens`, `f1-notebook-pages`,
`g7-ac30-restore`, `smoke`): **28 passed** (12.9 min); `npm test` and the build: `docs/TEST_LOG.md` «GATE-1 —
adversarial review».

## 4. Defects GATE-1 found and fixed (each reproduced by a test that failed first)

| # | severity | defect | root fix | regression test |
|---|---|---|---|---|
| 1 | **data loss on restore** | a whole-instance backup (app and `npm run backup`) held `system.sqlite` and the vaults but **no subject space**: every official lecture, version, attachment and published explanation was missing from the archive; the restored registry named space files that did not exist, so the restore check failed (`g7-ac30` failed whenever a subject existed — reported by the P1-T3, P1-T4 and P1-T5 builders since wave 2) | `modules/data/backup.ts` snapshots every registered space (`manifest.spaces[]`, their files included); `restore.ts` verifies each space with the base + space migrations and refuses an archive whose spaces differ from its registry; the CLI reads the registry | `apps/server/test/data/gate1-space-backup.test.ts` (4) |
| 2 | honesty / AOS-23.3 | on a server that has had several accounts the archive leaves only encrypted, and without `MEDLEVO_BACKUP_ENCRYPTION_KEY` the download route answers 409 — but «بياناتك» still offered a working-looking «نزّل النسخة» link that ended in nothing (E2E: «download canceled») | the backup view carries `download_blocked_ar` from the same rule as the route; the screen shows a disabled «نزّل النسخة» with the reason; the E2E servers now run with a key, as `render.yaml` generates one, and `g7-ac30` restores the `.mlenc` archive with it | `apps/server/test/data/gate1-backup-download.test.ts` (3), `apps/web/src/features/offline/screens.test.tsx` «GATE-1 …», `e2e/g7-ac30-restore.spec.ts` |
| 3 | **upgrade blocked, misleading** | R1-c run on an R1-a data directory refused «ابدأ الترقية» with «قاعدة البيانات أقدم من الإصدار R1-a … ثبّت R1-a وشغّله مرة واحدة أولًا» — the database **is** R1-a; following the advice loops forever. The precheck compared the legacy schema with *this* build's base migrations, which since R1-c include 0163 / 0860. The unit suites never saw it: their «R1-a» fixture is written by the current build | `system/ownerMigration.ts`: the frozen list of R1-a's 44 base migrations; a database that has all of them but not this release's later ones is refused with `MULTI_USER_RELEASE_FIRST` and the way that works (R1-b first); only a database missing one of R1-a's own is «older than R1-a» | `apps/server/test/tenancy/owner-migration.gate1.test.ts` (4); the scripted run of §2.1 |
| 4 | a11y (axe **serious**) | `label-content-name-mismatch` (WCAG 2.5.3) on the reader's page indicator, every look, both widths: it showed «ص 1 1/4» but was named «ص 1، 1 من 4 …»; with a printed page the file position was inside parentheses (dropped by speech tools), and the shown words had no space between them in the text | `GoToPage.tsx`: the name starts with the shown words in their order, the spoken extras follow; spaces between the shown parts | `apps/web/src/features/workspace/chrome/GoToPage.gate1.test.tsx` (6) |
| 5 | touch targets | on a phone the breadcrumb links of the new screens were 24 px tall and «أنا» 10 px wide (subject page, «أنا» sub-pages, every «إدارة القنوات» section) | `design/components.css`: on a coarse pointer a breadcrumb link is a 44 × 44 px target | `apps/web/test/breadcrumbs-css.gate1.critic.test.ts` |
| 6 | test hygiene (disk) | every server test worker created its own `/tmp/medlevo-vault-template-*` directory and never removed it (≈ 17 GB, `ENOSPC` in the P1-T5 step-3 review) | one template directory per `vitest run`, created by a global setup and removed at its end | `apps/server/test/tenancy/template-dir.gate1.test.ts` |
| 7 | test harness (performance) | the opt-in browser perf suite could not run: «dense page, 5 layers» clicked a layer row before the sync pull had delivered the seeded layers (timed out on R1-b and R1-c alike) and, the file being serial, the three tests after it never ran | `e2e/perf.spec.ts` waits for the row (≤ 5 min) before the timed click; the R1-b copy used for the comparison got the same line | the suite itself: 6 / 6 on R1-b and on R1-c (§7) |
| 8 | test (E2E) | the final full run failed `e2e/f1-notebook-pages.spec.ts` 4 times (phone + desktop): it still asserted the page indicator's old name («، 2 من 4.»), which the fix of defect 4 changed on purpose («ص 12، 2/4 (2 من 4)، …») | the spec matches the spoken position in either form (`at(n, N)`) | the spec: 4 failed in the full run → 6 / 6 after |
| 9 | test (E2E harness) | `e2e/critic-screens.spec.ts` probed 250 ms after switching to the dark scheme; under the load of the full run the top-bar link's 140 ms background transition was still running, so the probe read the light pill behind the already-dark text (1.29:1) — 1 failure (desktop), not reproduced alone | after a scheme switch the spec waits for the page's finite animations (capped at 2 s) | the spec: 4 / 4 after (phone + desktop) |

The stale template directories already on this machine (from earlier runs, ≈ 1 GB) were **not** deleted: removing
shared `/tmp` content was refused by the environment's permission policy, and this gate did not work around it.

## 5. Must rows of Phase 1 (PRD §7, `Ph` = 1, 1/2 or 1/3, `Pri` = M — 123 rows)

Statuses are the reviewers' (REQUIREMENTS_MATRIX «AOS»), re-read by this gate; where GATE-1 added evidence the row says
so. Full table with evidence: `docs/REQUIREMENTS_MATRIX.md` «GATE-1 — Phase 1 exit».

### 5.1 Pass here (60)

1.6, 1.9, 1.11, 1.31 *(GATE-1: Scenario 2 writes on a followed copy into the personal layer above the
read-only ones)*, 1.36, 2.1 + 18.2 *(GATE-1: the tree screens now run end to end in `aos-p1-admin`)*, 2.8, 2.11, 2.14,
2.15, 2.16, 2.17, 2.18 *(GATE-1: «ابدأ الدراسة» end to end in S2, S4 and the slice)*, 2.19, 3.4, 3.13, 4.1, 4.2, 4.3,
4.6, 4.10, 4.11, 4.14, 4.17, 4.20, 5.12, 5.18, 5.22, 5.24, 5.27, 14.15, 14.18, 14.19, 15.1, 18.1, 18.6, 18.7, 18.8,
18.10, 18.12 *(Phase 1 part: per-resource policy, X9)*, 18.13, 18.14, 19H.2, 19I.3, 20.2 *(the BOOX part is OC.5)*,
20.17, 20.18 *(«تحديث متاح» / followed-copy states, S2)*, 21.2, 21.6, 21.7, 21.11, 21.15, 21.16, 21.31, 21.32, 21.33,
21.37, 21.44, 23.4 *(§8; real usage numbers once deployed)*.

GATE-1 review (2026-10-22): each row above was re-read against its PRD criterion and the reviewer's evidence in
`REQUIREMENTS_MATRIX.md`; three rows the gate's draft listed here were moved — **1.10** (its native-shell part is blocked,
§5.2), **1.16** and **23.3** (Partial, §5.3). 2.18's «pressing again reopens the same copy» `[e2e]` part had no E2E: the
vertical slice now presses «افتح نسختي» and checks the same copy reopens.

### 5.2 Blocked on a device or an account — «Not run (reason)», pass only on the real thing (13; PRD §10.1 + 1.10)

| row | what passes here | what is not run, and what unblocks it |
|---|---|---|
| OC.2 native shell | skeleton and CI files, static checks | a signed iPad build (Apple Developer account, decision D-A by 2026-12-15) |
| 1.10 vector ink | AC-21 inside a vault (`g6-ac21`), the packed codec lossless (`shared:ink-codec`, 3 000-stroke fuzz) | AC-21 against **native-shell** strokes — no shell build exists (OC.2); listed by the P1-T2 reviewer as a blocked part, counted «pass» by the gate's draft |
| 1.1 pressure | strokes carry author / layer; pressure only from real variation | a real stylus (iPad + Pencil, S Pen, BOOX) |
| 1.2 palm rejection | the setting (G02) | physical palm on a tablet; native shells |
| 1.39 smooth writing | live layer, tile cache (headless Chromium) | per-device latency (NFR-P1) |
| 14.1 private tutor | per-user AI usage / allowance | a real AI key; quality evaluated with it |
| 20.4 tablet-first | layouts at iPad sizes in Chromium | iPad + Pencil, Samsung, BOOX |
| 20.20 accessibility | axe 0 serious on the new screens (after fix 4), in the E2E specs run here | VoiceOver / TalkBack on a device; «axe in CI» also waits for an automatic CI E2E run (today manual dispatch only, never run on a runner) |
| OC.1 phone-only operation | Render blueprint, R2 adapter against a signature-checking fake, Arabic runbook | a Render and a Cloudflare account and a phone (the dry run) |
| OC.5 e-ink mode | e-ink look on every new screen (this critic pass) | a BOOX device (refresh, ghosting) |
| OC.6 capabilities per device | nothing inferred from a device name | native bridges; the devices |
| OC.7 R2 hosting | encrypted blob adapter against the fake | a real R2 bucket |
| OC.8 latency first-class | NFR-P2 in headless desktop Chromium | NFR-P1 on the devices |

### 5.3 Open although buildable or testable here (50)

These are **not** device-blocked; they keep Phase 1 from «complete» until built (or, for the last group, until their
evidence exists). PRD §5.2 does not let an `M` row move to a later phase.

* **Partial (39)** — 1.16 (AC-20 on the new editors `[web][e2e]`: the shared schema and the server refuse bidi controls in channel and publication titles, change notes and reasons, but no web or E2E check covers those editors — the same gap as 20.3; GATE-1 review), 1.38 (two accounts in one browser, E2E), 2.2 (lecture order on the student screen), 2.3 and 18.3
  (only PDF exercised inside a space; bulk upload), 3.6 (space-scoped duplicates), 3.11 (followers told of a new
  version), 3.18 (role-scoped review queue), 4.5 («رسمي» on the student lecture page), 4.7 (the sign-out clearing
  option), 4.18 (attribution in exports), 11.27 (per-viewer visibility of space feeds), 14.11 (AC-24 per user across two
  devices, E2E), 18.4 (upload → approve → publish through «المحتوى الرسمي», E2E), 18.5 (invite named people from the
  screen), 19H.1 (identity links to later-phase objects), **19H.3 (X8 (c))**, 19I.2 (publisher shown on official
  content), 19L.4 (admin dialogs by keyboard, E2E), 20.5 (a real iPhone / iPad Safari run is also needed), 20.19 («جهاز
  آخر لك / مستخدم آخر» wording), **21.1 (X8 (c), (d))**, 21.5, 21.8, 21.9 and 21.45 (**no per-space storage quota on
  space uploads**), 21.12, 21.13, 21.14, 21.18, 21.27, 21.29, 21.34, 21.38, 21.43 (exports not counted in the quota),
  21.46 (visible remaining AI allowance), 21.47 (module boundary as an ESLint rule), 23.3 (the no-decorative-controls
  sweep passes here on every new screen at 390 and 1280, but «it runs in CI from Phase 1» is not met: the CI E2E job
  runs only on a manual dispatch and CI has not run on a GitHub runner — the same reason 23.2 is open; GATE-1 review),
  23.5 (baseline re-check of every covered row). The reviewers' «remains» column of `REQUIREMENTS_MATRIX.md` names the missing part of each.
* **Not Started (4)** — 1.24 (undo in multi-writer layers — none exist before Phase 4), 19J.1 (universal study session
  across devices), 21.35 (refuse a multi-user start with an https origin and a non-Secure cookie), 21.42 (per-user
  `ai_processing` consent and a written policy).
* **No Phase-1 evidence yet (7)** — 18.17 (AI cache keys carrying user / official dimensions: no test names it), 18.18
  (uploader and lineage on every file — the publisher is not shown), 19I.5 (machine-generated marking on new generators
  and published AI output: no test), 20.1 (a token-only lint rule does not exist; the visual check and the clean-room note
  are §10), 20.3 (`g6-ac20` does not cover the new screens), 23.1 (this report — needs the owner's sign-off), 23.2 (the
  gate ran here, not in CI).

## 6. Not run (reason) — and what unblocks each

| what | reason | unblocked by |
|---|---|---|
| Any device: iPad + Apple Pencil, Samsung S Pen, BOOX, a low-end Android phone, iPhone / iPad Safari | none in this container; headless Chromium 141 only (390 × 844 touch emulation, 1280 × 800, 834 × 1194) | the owner's devices; PL-1/PL-2 after D-A |
| Render deploy, the upgrade on Render, R2 off-site copies and blobs, the phone-only dry run (OC.1, OC.7) | no Render or Cloudflare account here; R2 paths tested against the signature-checking S3 fake | the owner's accounts (`docs/DEPLOY_PHONE_AR.md`) |
| An installed PWA updating itself on a device; offline outbox on a real device | no device | the owner's devices |
| Real AI provider (`npm run eval -- --mode=live`), AI quality, 14.1 | no `ANTHROPIC_API_KEY` | an API key (ADR-0002) |
| VoiceOver / TalkBack, a second browser engine (Safari, Firefox), Web Push | not available here | devices; VAPID keys and a push-capable device |
| NFR-OP2 load test (concurrent users, p95 latency, event-loop delay on the Render plan) | needs the target plan; a local number would say nothing about Render's 0.5–4 CPU | a Render plan; planned for Phase 2's gate |
| NFR-P1 pen-to-pixel latency | needs ≥ 240 fps video of a real pen | the devices |
| Real course files (T3 detection precision), real university data | fixtures only | the owner's files |
| Docker image rebuild | `dockerd` is installed but no daemon runs here | a CI runner or the owner's Render build |
| CI on a GitHub runner | not run from here | pushing the branch |

## 7. Performance gate (AOS-23.2) — this build against R1-b, same machine, same tests

Full tables, method and raw files: `docs/PERFORMANCE.md` «GATE-1 (2026-10-22) — release R1-c against release R1-b».
The R1-b release (`git archive 514f356`) and this tree ran the **same** perf suites one after the other on a quiet VM:
the server suite 3 times per release (alternating; medians), the browser suite once per release (desktop Chromium).

**Harness defect found first:** the opt-in `e2e/perf.spec.ts` «dense page, 5 layers» timed out on R1-b and on R1-c
alike (it clicked a layer row before the sync pull had delivered the seeded layers), and being serial it stopped the
three tests after it — the suite had not been able to run since R1-a. The spec now waits for the row before the timed
click (both trees); nothing measured changed.

**Against R1-b** — 34 server medians and 21 browser numbers compared:

* within ± 10 %: all but the two below; better: the longest task while scrolling 300 pages (328 → 164 ms) and while
  opening a 5 000-stroke page (278 → 149 ms) — single browser runs, so «not worse» is the claim, not «faster».
* **slower by more than 10 % (median of 3):** reading one page with 5 000 strokes 258 → 286 ms (+11 %; the route's code
  is unchanged and the gap lies inside R1-c's own spread of 278–346 ms) and the server boot 1.85 → 2.16 s (+17 %; six
  more modules register at boot — a crashed processing job still resumes 2.3 s after the restart, +1 %). The 300-page
  processing run peaks 6 % higher in RSS (777 → 827 MB). None of these has a budget; recorded, not changed.
* **Re-measured by the gate's reviewer** (AOS-23.2 blocks the exit on a regression > 10 % until it is fixed or the
  owner accepts it, so the two had to be confirmed or cleared): the same two tests alone, R1-b and R1-c alternating on
  the quiet VM (`test/perf/learning-ink.perf.test.ts` R1-b × 5 / R1-c × 6; `test/perf/crash-resume.perf.test.ts` R1-b ×
  4 / R1-c × 5). The 5 000-stroke page read: p50 per run R1-b 302–318 ms (median 311), R1-c 272–323 ms (median 300) —
  **−4 %**. Restart after SIGKILL: R1-b 2 056–2 578 ms (median 2 376), R1-c 2 058–2 357 ms (median 2 168) — **−9 %**;
  the first boot 2 004 → 2 121 ms (+6 %). Neither +11 % nor +17 % reproduces: both lie inside one release's run-to-run
  spread on this VM, so **no regression > 10 % is established** and no owner acceptance is asked. Raw JSON: scratch
  `gate1-review/perf/`.

**Budgets (PRD NFR-P, measured on this build):**

| budget | measured | status |
|---|---|---|
| NFR-P1 pen-to-pixel latency per device | — | **Not run** — no iPad, S Pen or BOOX; needs ≥ 240 fps video (PL-2 / Phase 2 report) |
| NFR-P2 warm repaint < 200 ms; no long task > 100 ms while writing | warm grids 0.1 ms (show a layer) and 6.1 ms (zoom, page settled); writing during a re-raster: longest task 87 ms (R1-b 84) | **met** in the CI harness. Finding (R1-b and R1-c alike): zooming back within ~1.5 s of opening a dense page re-rasters 2 of 6 tiles (2.4 s, in slices, longest task 67 ms) — tiles built while the page is still settling get invalidated |
| NFR-P3 5 000-stroke page ≤ 8 MB on the wire | 7.6 MB (40-sample strokes); 7.84 MB for the realistic page with packed points (`accept-ink: 2`) | met for packed points only; no HTTP compression (unchanged since R1-a) |
| NFR-P4 offline delta merge ≤ 50 ms | — | not applicable before Phase 4 (no multi-writer layers) |
| NFR-P5 scoped search p95 ≤ 50 ms, 250k chunks | raw p50 26.0 ms, raw p95 42.4 ms (48 runs, quiet VM) | **met** (new in R1-c) |
| NFR-P6 binding p95 ≤ 50 ms on a pool miss | p95 6.8 ms (R1-b 7.9) | **met** |

Not measured: any device, Safari / Firefox, a GPU, the Render plan (NFR-OP2 load test, §6).

## 8. Operational costs and capacity (PRD §6.2, AOS-23.4)

**No deployment exists yet**, so there are no real usage numbers; PRD §6.2's prices (read on 2026-10-20) and tiers
stand. What GATE-1 measured on this build changes these inputs:

| measured here | value | effect on §6.2 |
|---|---|---|
| an empty account vault (all base migrations, FTS tables, no content) | **2 035 712 B ≈ 1.94 MiB** (E2E data directory, 32 vaults) | 500 students ≈ 0.97 GiB of empty vaults on the Render disk before any content — ≈ $0.25 / month; negligible beside recordings, but every account costs ≈ 2 MB of disk from its first sign-in |
| an empty subject space | **2 203 648 B ≈ 2.1 MiB** (36 spaces) | 10 subjects per stage ≈ 21 MiB; negligible |
| `system.sqlite` after the full E2E run (32 accounts, 36 subjects, notifications, audit) | ≈ 1.0 MB + 4.2 MB WAL | negligible |
| a «ابدأ الدراسة» stub of a 40-page official lecture (P1-T5 step-2 reviewer) | ≈ 5.4 KB (no page bytes copied) | PRD's ≈ 1.5 MB of stubs per student is pessimistic: ≈ 0.3 MB for 50 lectures |
| shared blobs: the whole E2E run (≈ 30 uploads, many identical fixtures) | 2.4 MB in `files/` | content-addressed storage de-duplicates identical uploads across accounts and spaces |
| whole-instance backup | now also holds every space (§4, defect 1) | the archive grows by ≈ 2 MB per subject plus its official files; R2 at $0.015 / GB-month |
| peak process memory while processing a 300-page lecture (perf suite, median of 3) | **827 MB** RSS (R1-b 777 MB; much of it collectable garbage, `docs/PERFORMANCE.md`) | confirms the blueprint's Standard plan (2 GB, $25) for tier T0/T1; the Starter plan (512 MB, $7) is below that peak (a capped heap was not tried; not run on a 512 MB machine) |
| server boot (crash restart, median of 3) | 2.16 s (R1-b 1.85 s) | the few seconds of downtime per deploy that PRD §6.2 already counts (one instance with a disk) |

AI cost: unchanged (no AI path added in R1-c; no key here). ASR: unchanged (Phase 3). **The capacity statement stays
«not measured»** until the NFR-OP2 load test on the target plan (§6).

## 9. §7 rows whose status changed at this gate

The gate proposed these changes; **its reviewer (BUILD_PLAN §1.2 — the reviewer, not the builder, sets a status)
verified each against the PRD criterion, the named files and tests, and set the status** (`REQUIREMENTS_MATRIX.md`
«GATE-1 — Phase 1 exit», 2026-10-22):

* **2.1, 18.2** — `[e2e]` part now run: `aos-p1-admin` (add / edit / move a node, archive with its impact first —
  «ستُؤرشف معها 0 عقدة تحتها … لا يُحذف شيء» —, codes, members, roles, audit by scope) passed on phone and desktop →
  **Implemented & Tested** (reviewer: confirmed).
* **2.18** — S2, S4 and the vertical slice start studying through the screen; «pressing again reopens the same copy»
  had server and web tests only → the reviewer added that step to `e2e/aos-p1-vertical-slice.spec.ts` («افتح نسختي» on
  the lecture page reopens `/study/<the same source>`, still one personal copy) → **Implemented & Tested**.
* **1.31, 20.18** — met by S2 (offline ink over حسن's strokes lands in her own layer; «تحديث متاح» → preview → apply)
  → **Implemented & Tested (Phase 1 part)** (reviewer: confirmed).
* **18.12** — Phase 1 part (per-resource policy) met by X9 → **Implemented & Tested (Phase 1 part)** (reviewer: confirmed).
* **1.10** — the P1-T2 reviewer's status already named a blocked part (AC-21 against native-shell strokes, no shell
  build); the reviewer moved the row from «pass» to the blocked list (§5.2).
* **1.16** → **Partial** (reviewer): only the channel part was ever verified (`srv:channels/tree`); the `[web][e2e]` check
  of the new editors (publication titles, change notes, reasons) does not exist.
* **23.3** → **Partial** (reviewer): the sweep passes here, but it does not run in CI (manual-dispatch E2E job, never run
  on a runner) — the criterion's own words, and the reason 23.2 is open.
* **23.2** → stays **Partial**: run here, not in CI; the two medians > 10 % of the gate's run did not reproduce in the reviewer's alternating re-runs (§7).
* **23.4** → **Implemented (Phase 1 part)** (reviewer: §8 and §11 checked; real usage numbers wait for a deployment).
* **23.1** → stays **Partial**: this report exists; the phase is not closed (§1) and the owner's decisions (§13) are open.
* **21.1 / X8** — (a), (b), (e) pass, now also against the real R1-a → R1-b → R1-c path; (c), (d) still open → stays Partial.
* **AC-30 (whole-instance backup)** — spaces included and verified (defect 1).
* **20.20** — the critic pass's axe finding fixed (defect 4); 0 serious on every new screen in light, dark and e-ink.
* **20.5 (touch)** — breadcrumb targets fixed (defect 5).

## 10. Critic pass of the new screens (390 and 1280 px; light, dark, e-ink)

30 R1-c screens × 3 looks × 2 widths (180 screenshots, `gate1/shots/` in the scratch area, inspected): the shell
home, «القنوات», the join sheet, browse, the subject page (lectures / files / updates), the lecture page (official /
explanations), the publication page, the update preview, the report dialog, the reader with the study-copy bar,
«التنبيهات», «أنا» and its three sub-pages, «إدارة القنوات» and its eight sections, the two «ابدأ الدراسة» dialogs and
the invite landing (signed out). Probes: one `h1`, named controls, contrast ≥ 4.5:1, no sideways overflow, no icon
alone on a line, no red-flag text, 44 px targets and switch rings on the phone, axe-core serious / critical.

* Found: the axe serious violation (defect 4) and the breadcrumb targets (defect 5) — fixed. Re-run after the fixes
  (04:29 → 04:33 UTC): **2 / 2 passed, 0 findings on all 180 screenshots** (every probe and axe clean).
* Not counted as defects (checked): the skip link (off screen until focused), radio inputs whose whole row is the label
  (≥ 52 px), the QR picture input (1 × 1 px, driven by its visible button), switches (45 px ring).
* **Reported, not fixed (design change):** on a 390 × 844 phone the reader with a followed copy shows ≈ 460 px of chrome
  before the page (title line, writing bar, the copy bar with two switches, the update banner). Usable, but heavy; a
  collapsible copy bar on phones is proposed for Phase 2 (IA owner).
* **Clean-room note (AOS-20.1):** the new screens use the design-system tokens and components; no other app's code,
  text, layout or assets were used (the tracks' declarations). A grep for hard-coded colours in the new feature folders
  finds one: `channels.css` `.ch-qr__code { background: #fff }` — the QR code's quiet zone must stay white in dark and
  e-ink for scanners (deliberate).

## 11. Known limits (carried forward)

* X8 (c): unplaced linked items are in no review list; inserted note pages are not copied (19H.3).
* No per-space backup artifact; no per-space storage quota on space uploads (21.45); export archives not counted in the
  account quota (21.43).
* RATE_LIMITS.auth still 30 sign-ins / minute / address — a class behind one NAT (AOS-21.45).
* Push notifications are not built (no VAPID keys; preferences say so).
* The «ابدأ الدراسة» copy bar is heavy on phones (§10).
* Owner question N4 (may a Subject Moderator approve joins?) still open; the person picker lists the first 50 approved
  members only.
* The owner migration's page shows a blocking reason only after «ابدأ الترقية» is pressed (unchanged from R1-b).
* Performance (§7): tiles of a dense page built in the first seconds after opening get invalidated (a zoom back soon
  after opening re-rasters 2 of 6 tiles in slices); a first sync of a large deck on a new device still takes ≈ 2 min
  for 15 000 records; reading one page with 5 000 strokes is a 7.6 MB JSON answer without HTTP compression; the server
  boot is ≈ 0.3 s longer than R1-b's. A deploy upgrading straight from R1-a needs the R1-b commit deployed first (§12).
* The GitHub repository has no `main` branch (only `claude/sweet-pascal-uafn2f`, the default, at the work-in-progress
  snapshot) — check what Render deploys before updating (§12 step 0).
* Whole-instance snapshots are taken one database after another (system, vaults, spaces): consistent each, not one
  instant (`docs/BACKUP_RESTORE.md`).
* Every carried-forward item of the track reviews: `docs/modules/{channels,lectures,copies-publications,
  notifications-moderation,tenancy}.md` «remains», and the REQUIREMENTS_MATRIX «remains» column.

## 12. Updating the owner's Render deployment (owner-facing)

The Arabic, step-by-step version is `docs/DEPLOY_PHONE_AR.md` «التحديث إلى الإصدار R1-c»; the record is
BUILD_PLAN §1.3 «Release R1-c».

0. **First check which branch Render deploys** (Render → the service → Settings → Branch, and Events → the commit that
   is live). The guide says `main`, but on 2026-10-22 the GitHub repository had **no `main` branch**: its only (and
   default) branch was `claude/sweet-pascal-uafn2f`, whose head is the work-in-progress snapshot `48bc41e` of this
   release (`git ls-remote`, GATE-1 review). If Render deploys that branch, every snapshot pushed during the work
   deploys at once (`autoDeployTrigger: commit`) — R1-c may already be live, without the backup of step 3. If Events
   shows `48bc41e` or later on an R1-b server, make a backup now and check it; if it shows R1-a, the R1-c upgrade page
   refuses and nothing changed (step 1). (Not checked on Render: no account here.)

1. **Your server must already be on R1-b with «اكتملت الترقية».** If it still runs R1-a, deploy R1-b first and finish
   its upgrade (BUILD_PLAN §1.3 «Release R1-b» steps 1–7). R1-c refuses to move an R1-a database itself and its upgrade
   page says so (nothing is changed). If `main` already holds R1-c: Render → Manual Deploy → «Deploy a specific
   commit» → the R1-b release commit (`514f356`, «Academic OS Phase 1 release R1-b …»), finish its upgrade, then
   Manual Deploy → «Deploy latest commit». Merge the pull request with a merge commit (not squash) so that commit stays
   on `main`. (Not run on Render.)
2. **Check the backup key:** Render → Environment → `MEDLEVO_BACKUP_ENCRYPTION_KEY` exists (the blueprint generates it)
   and a copy is in your password manager. From the first classmate's account (or the first subject) on, a whole
   backup leaves the server **only encrypted** with this key; without it «نزّل النسخة» is disabled with the reason.
3. **Before merging:** «مركز التحكم» → «نسخ احتياطي الآن» → wait for «نجحت» (and the R2 copy). **This backup is the only
   way back**: R1-b refuses to start on data R1-c has opened.
4. **Merge** R1-c into the branch Render deploys; wait for **Live**. There is no maintenance page this time: the app
   opens, each vault gets the two new base migrations when it is first opened, the system database its channel tables.
5. On each device tap **«تحديث»** when it appears. You are the platform admin: «أنا» → «إدارة القنوات» → create the
   university, its levels and the subjects (each subject gets its own space); create a class code or an invite link
   for your classmates — **there is no open sign-up**: an account can only be created with a code or a link.
6. Make a fresh backup and check it: «نسخ احتياطي الآن» → «تحقّق من الاستعادة». It now holds every subject.
7. **Going back** (only if something is wrong): Render → Events → the R1-b deploy → Rollback **will fail to start** on
   the R1-c data (on purpose). Restore the backup of step 3 instead (`docs/DEPLOY_PHONE_AR.md` «الاستعادة»); writes made
   after it are lost.

Not run: none of these steps was run on Render, R2 or a phone (§6).

## 13. The owner's decisions (sign-off)

What the owner is asked to decide now — nothing else in this report needs a decision. Write the decision in the
conversation; it is copied here with the date. Signing does **not** close Phase 1: the 50 rows of §5.3 and X8 (c), (d)
must still be built (PRD §5.2 does not let an `M` row move to a later phase).

| # | decision | why it is asked | the owner's answer |
|---|---|---|---|
| 1 | Accept the Not-run list of §6 and the 13 blocked rows of §5.2 as «Not run (reason)» until the devices and accounts exist | PRD §5.2: blocked Musts are signed off by the owner and listed again in every later report | — |
| 2 | Owner question N4 (may a Subject Moderator approve joins?) | open since P1-T4 step 1 (§11) | — |
