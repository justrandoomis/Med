# Academic OS — Build plan

> **Status:** v1 · 2026-10-20 · written after the adversarial design review. Release R1-a (P1-T1 step 0, P1-T2,
> P1-T3, with PL-0 beside them) is built, reviewed and verified as of 2026-10-21 (§1.3, «Release R1-a»); release R1-b
> (P1-T1 steps 1–3, with parity N1 waves 1–2 beside it) is built, reviewed and verified in this container as of
> 2026-10-21 (§1.3, «Release R1-b»); release R1-c (wave-2 contracts, P1-T4, P1-T5) is built, reviewed and verified
> by GATE-1 as of 2026-10-22 (§1.3, «Release R1-c»). **Phase 1 is not complete and not closed**: the gate does not pass
> while buildable Musts are open; the owner signs off only the Not-run list
> ([PHASE1_REPORT.md](PHASE1_REPORT.md) §1, §13).
> **What it is:** the delivery plan for the Academic OS in the spec's phase order (spec §23 «Implementation Priority»).
> Each phase is split into **build tracks**; each track is built by **one builder agent** and checked by **one adversarial
> reviewer agent**. Phase 1 is planned in full detail; Phases 2–5 at track level.
> **Sources of truth:** what and when — [PRD.md](PRD.md) §5 (the only phase table) and §7 (every requirement row);
> how — [ARCHITECTURE_DELTA.md](ARCHITECTURE_DELTA.md) and ADR-0003…0006; screens — [IA_AND_JOURNEYS.md](IA_AND_JOURNEYS.md).
> Where this plan and the PRD disagree on scope or phase, the PRD wins and this plan is corrected.
> **Coverage is checked by a script** (Appendix A): every PRD §7 row is built by a track of the phase its `Ph` column
> names (both phases for a `1/2` row), and no track builds a row outside its phase.
> **Clean-room:** every track builds from the owner's spec, these documents and public information only — no other app's
> binaries, code, text, UI layouts, templates or assets, and no reverse-engineering tools on third-party apps.

## Contents

1. [How this plan works](#1-how-this-plan-works)
2. [Definition of done (every track)](#2-definition-of-done-every-track)
3. [Phase 1 — Foundation and vertical slice (full detail)](#3-phase-1--foundation-and-vertical-slice-full-detail)
4. [Phase 2 — Community and search](#4-phase-2--community-and-search)
5. [Phase 3 — Live lecture (3a without ASR, 3b with ASR)](#5-phase-3--live-lecture-3a-without-asr-3b-with-asr)
6. [Phase 4 — Nearby, rooms, collaboration](#6-phase-4--nearby-rooms-collaboration)
7. [Phase 5 — Tutor and innovations](#7-phase-5--tutor-and-innovations)
8. [Platform track (native apps) across phases](#8-platform-track-native-apps-across-phases)
9. [What stays blocked in this container](#9-what-stays-blocked-in-this-container)
- [Appendix A — Coverage checker](#appendix-a--coverage-checker)
- [Appendix B — Ownership index: shared contracts and migrations](#appendix-b--ownership-index-shared-contracts-and-migrations)

---

## 1. How this plan works

### 1.1 Tracks, waves, steps

* **Track** = a coherent slice that one builder can finish and one reviewer can review: it owns a set of directories and
  files, a list of PRD rows («Covers»), its acceptance tests and its docs.
* **Wave** = tracks that run in parallel. **Tracks in the same wave never edit the same file.** Shared files have one
  owner per wave; other tracks reach them only through seams the owner lands first (§3.2) or through self-registration
  from their own files (a module registers its rules, purge steps, routes or admin sections in its own plugin code).
* **Step** = a reviewed slice inside a track. Large tracks ship in steps; every step ends with a review, so value lands
  in slices and the reviewer never faces a month of code at once.
* **Contract first.** Where two tracks of one wave depend on each other's API, both land their `packages/shared` contract
  files (types + zod schemas only) in a **step 0** that both reviewers check together; afterwards each builds against
  the other's contract and never edits it.

### 1.2 Review protocol (as for tracks F1–F5 and H1–H4)

build → independent adversarial review (permissions and leaks, data loss, offline and two devices, RTL and
accessibility, honesty of capabilities and wording, performance, clean-room) → fixes with regression tests → final runs
(`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run e2e`) → docs. The reviewer, not the builder,
changes a PRD row's status in `docs/REQUIREMENTS_MATRIX.md` (new «AOS» part) after verifying it.

### 1.3 Releases and the owner-migration rule (ADR-0003 §5)

The release that migrates the single owner into user #1 contains **no new base migration**, so its first boot opens the
vault byte for byte and moving the file back stays a valid rollback. Phase 1 therefore ships in three releases:

| release | contents | base migrations | system / space migrations |
|---|---|---|---|
| **R1-a** «single-owner preview» | P1-T1 step 0 (seams), P1-T2, P1-T3 — layers, history, version matching and safe note migration, all inside today's single-owner database | `0041`, `0050` (T1 step 0), `0160`, `0161` (T3), `0271`, `0272`, `0861` (T2) | none |
| **R1-b** «multi-user foundation» | the rest of P1-T1: system DB, vaults, binding, owner migration, per-user web storage | **none** | `2000`, `2010`, `2040`, `2250`, `2300` |
| **R1-c** «channels and the vertical slice» | P1-T4, P1-T5 (after a fresh verified backup) | `0163`, `0860` | `2050`, `2060`, `2100`, `2150`, `2200`, `2310`; space `3000`, `3010`, `3050`, `3300` |

A Wave 1 track that merges after T1 waits for R1-c rather than joining R1-b. The owner gets layers, history and safe
note migration on their own library already in R1-a.

#### Release R1-a «single-owner preview» — final verification (2026-10-21)

**Status: verified for the single owner in this container** — every gate green on the whole tree (below; details,
commands and durations in `docs/TEST_LOG.md`, «Release R1-a — final verification»). Everything runs inside today's
single-owner database: no system or space database, no second user, no channel. Nothing was run on a device or a real
hosting account (see «Not run»).

**What shipped** (each part built by its track and reviewed adversarially, BUILD_PLAN §1.2):

| part | what the owner gets | reviewed in |
|---|---|---|
| P1-T1 step 0 — seams | nothing visible: Phase 1 error codes and capability keys, the `academic/` contracts, the purge-extension registry, `SyncEngine.onRejected` (at-least-once), the Dexie v3 schema (the per-user database name is prepared, not used yet), unwritten actor / visibility columns | `TEST_LOG` «P1-T1 step 0 — adversarial review» |
| PL-0 — phone-only hosting | Docker image + Render Blueprint (`render.yaml`), encrypted nightly off-site backups to Cloudflare R2 (S3 API), each verified by a full restore before upload, a one-command restore beside the live data, the Control Center row and «النسخ الاحتياطي خارج الخادم» screen, client-address trust for Render, the Arabic guide `docs/DEPLOY_PHONE_AR.md` | «PL-0 — adversarial review» |
| P1-T3 — lecture identity and versions | lecture number, name and date read from the file and only **proposed** (uncertain values have no effect), ordering screen, subject placement suggestions, DOCX display PDF, printed contents → page links, page fingerprints and the order-preserving page map, the side-by-side compare screen, «إصدار جديد من …» before anything is applied, the link-candidate service for P1-T5 | «P1-T3 — adversarial review» |
| P1-T2 steps 1–2 — layers and ink data | the «الطبقات» panel (show / hide per session, «اكتب هنا», read-only layers never changed, refused writing re-homed to «ملاحظاتي»), per-layer history, copy one layer, packed ink v2, the dense-page tile cache, e-ink / high-contrast / lite display modes per device, the native-shell skeleton (static checks only) | «P1-T2 steps 1–2 — adversarial review» |
| P1-T2 step 3 — safe note migration | «انقل ملاحظاتي إلى الإصدار الجديد»: copy, never move — preview, one tap, report, one-step undo, a review list for what changed (Scenario 4 inside one vault) | «P1-T2 step 3 — adversarial review» |

**Base migrations actually shipped** (all additive; no system or space migration): `0041`, `0050` (T1 step 0), `0160`,
`0161`, `0164` (T3), `0271`, `0272`, `0274`, `0861` (T2), `0751` (PL-0). Against the table above: `0164`
(DOCX display rendition, P1-T3), `0274` (note-migration bookkeeping, P1-T2 step 3 — `0273` stays reserved for P3-T2)
and `0751` (off-site backup runs, PL-0) were added by their tracks. Upgrade path: make and verify a backup first; the
ten migrations run at the first boot; going back to the Round 7 code means restoring that backup, because the runner
refuses a database newer than the code.

**Final verification** (2026-10-21, this container): see the gates table in `docs/TEST_LOG.md` «Release R1-a — final
verification». The first full pass was green before any change; the critic pass of the new screens (390 and 1280 px,
light, dark and e-ink) then found three layout defects and the final re-run found one real race — all four fixed with
regression tests:

* the lecture's «النسخ» and «المحاضرة» tabs and the compare screen were unstyled when opened directly (their rows use
  `upload.css`, which only the upload screens loaded) — `test/route-chunk-css.critic.test.ts`;
* «وضع العرض على هذا الجهاز» had its icon on a line of its own (two classes had no rule) — `test/settings-css.critic.test.ts`;
* in the ≈ 260 px desktop page panel a layer's name was cut to «ملا…» and its meta line broke inside words —
  `e2e/aos-p1-layers.spec.ts` (desktop);
* Settings: text typed into «تعليمات خاصة للشرح» before the screen's effects had run was overwritten by a stale draft
  and never saved (a flaky test, failing ≈ 1 in 4 under load, exposed it) — `test/settings-screen.test.tsx` «(R1-a final)».

**Not run (reason)** — R1-a ships with these open:

| what | why |
|---|---|
| Any device: iPad + Apple Pencil, Samsung S Pen, BOOX e-ink, a low-end Android phone (NFR-P1 pen latency, OC.5 / OC.8 `[dev]`, palm rejection, e-ink refresh and ghosting) | no device in this container; headless Chromium (390 × 844 touch emulation, 1280 × 800) with mouse input only |
| Render and Cloudflare R2 accounts; the phone-only dry run (OC.1 `[dev]`) | no account and no phone here; every R2 claim is against the signature-checking S3 fake |
| Native iOS / Android builds, signing, store submission (OC.2 build part, OC.3, OC.4) | no macOS runner, Xcode, Android SDK or store accounts |
| A live AI provider | no `ANTHROPIC_API_KEY`; AI paths are unchanged by R1-a and tested with the fake providers |
| `MEDLEVO_PERF=1` suites and a Docker image rebuild | not re-run in the final verification (no change to the measured paths or to `Dockerfile` / `deploy/` since their track reviews); last numbers in `docs/PERFORMANCE.md` and `docs/DEPLOYMENT.md` §8 |
| Real course files (T3 detection precision), Safari / Firefox, screen readers, axe-core, CI on a GitHub runner | none available here; precision stays fixture-only; axe-core is not in the repository (structural probes instead) |

**Carried forward** (reported by the reviews, not blocking R1-a; each listed in its track's TEST_LOG entry, module
note or the matrix «remains» column): P1-T1's baseline re-check (DoD item 1) and the Phase report draft; P1-T2's
history growth (3.58 KB per stroke edit), layer copy inside the request, per-layer highlight blending, two layer sets in
the split pane, the lock not checked on undo / redo, bookmarks of hidden layers still listed; P1-T3's eight and PL-0's
five minors; `ARCHITECTURE_DELTA.md` §3.2 has no rows yet for `0164`, `0274`, `0751` (its owner adds them).

#### Release R1-b «multi-user foundation» + parity N1 — final verification (2026-10-21)

**Status: verified in this container for the owner as user #1** — every gate green on the whole tree after the fixes
below (commands, counts and durations: `docs/TEST_LOG.md`, «Release R1-b + N1 — final verification»). There is still
**one account in practice**: no registration route exists until P1-T4 (R1-c), and no channel or space. Nothing was run on
a device, on Render or on Cloudflare R2 (see «Not run»).

**What shipped** (each part built by its track and reviewed adversarially, §1.2):

| part | what the owner gets | reviewed in |
|---|---|---|
| P1-T1 step 1 — system DB, binding, vaults, accounts, authz | `system.sqlite` beside one SQLite «vault» per account; every request and job bound to the caller's vault (AsyncLocalStorage); accounts and devices; the space-route allow-list (an unlisted route stops the boot), platform-only whole-instance routes, a progressive sign-in delay | `TEST_LOG` «P1-T1 step 1 — adversarial review» |
| P1-T1 step 2 — files, quotas, backups | chunked resumable uploads, a blob registry with mark-and-sweep GC (quarantine before delete), per-account storage quota and AI allowance (atomic reservation), the R2 blob adapter (encrypted, verified on read), encrypted whole-instance and per-vault backups (`backup --encrypt`), «نسخة من بياناتي» and account deletion (server APIs) | «P1-T1 step 2 — adversarial review» |
| P1-T1 step 3 — owner migration | the journaled, resumable move of the R1-a database **byte for byte** into user #1's vault behind an Arabic maintenance page (`/api/maintenance`; or `MEDLEVO_OWNER_MIGRATION=apply`), a verified backup first, the tombstone that stops a mistaken R1-a deploy, rollback; the client-version gate (an R1-a app is served for user #1 only, others get 426); per-account IndexedDB / `localStorage` / drafts on each device with the R1-a database claimed in place for user #1; AC-01a server part | «P1-T1 step 3 — adversarial review» |
| Parity N1 waves 1–2 — writing comfort | G01–G04, G06–G11, G14, G15, G17, G19–G22, G66, G67 (`docs/modules/ink.md`): colour slots with meanings, gestures, selective erase, lasso chips, free resize / rotate, an arrangeable toolbar, palm levels, pen feel, dashes, pencil, eyedropper, zoom writing window, insert space / straighten, page menu, new shapes and pathway heads, connectors, snapping, ruler and educational measurement, neat copy | «Parity N1 wave 1 / wave 2 — adversarial review» |

**Migrations actually shipped:** base **none** — the 44 base migration files are byte-identical to the R1-a release
commit `d0c8ab4` (`git diff --stat d0c8ab4 -- apps/server/src/db/migrations` is empty), as the owner-migration rule
requires; system `2000_identity`, `2010_devices`, `2040_registry`, `2250_ops`, `2300_security` (applied to the new
`system.sqlite` only); space: none. N1 changed no schema (its new fields are inside the annotation JSON, validated by
the server).

**Final verification** (2026-10-21, this container): the first full pass (typecheck, lint, unit, build, evaluation,
full E2E on phone + desktop) was green. Then the owner migration was run **end to end against the real R1-a release**
(`git archive d0c8ab4`, booted on a fresh copy of the realistic R1-a data directory of `test/tenancy/legacy-fixture.ts`,
more data written through R1-a's own sync, this build's page, every entity / file / session reachable as user #1,
rollback to the real R1-a with nothing lost — 38 / 38 checks), and the new and changed screens were driven at 390 and
1280 px in light, dark and e-ink (the upgrade page in light and dark). That found seven defects; they and the open
N1 review finding R10 were fixed, each with a test that failed first:

* **release-blocking — the upgrade page's form never worked in a real browser:** it was served with
  `Referrer-Policy: no-referrer`, under which a browser posts with `Origin: null`, and the origin check refused «ابدأ
  الترقية» (403) — the owner's main upgrade path; now `same-origin` — `apps/server/test/tenancy/maintenance-form.r1b.test.ts`;
* **data safety — review finding R10 closed:** an un-updated R1-a app (still served for user #1) that moved a polygon,
  curved or double arrow would flip the arrow or leave the corners behind; the server now refuses that edit from a
  client without a supported `x-medlevo-client` and sends its copy back (the old app files a conflict and puts the shape
  back) — `apps/server/test/annotations/r1b-old-client-shapes.test.ts`;
* desktop / iPad landscape: the writing bar covered the reader's zoom group and «المزيد» — `e2e/r1b-final-critic.spec.ts`;
* the eyedropper's icon alone on a line; in the dark theme a shape's label invisible on the white page (1.2:1); 40 px
  meaning fields and sliders on a phone — `apps/web/test/ink/ink-css.critic.test.ts`;
* the upgrade page at 390 px: a long variable name ran off the «blocked» page, the confirmation checkbox squeezed to
  14 px — `maintenance-form.r1b.test.ts`.

Final gates on the final tree (all exit 0): typecheck; lint (0 problems); unit tests shared **109**, server **2 007**
(+7 skipped), web **1 076** (+1 skipped); build (283 precache entries); evaluation regression **80 / 80**,
`no_regressions`; full E2E on phone + desktop **146 passed, 0 failed, 16 skipped** (opt-in / project-conditional).

**Updating the owner's Render deployment safely (owner-facing steps).** The Arabic, step-by-step version is
`docs/DEPLOY_PHONE_AR.md` «التحديث الأول إلى نظام الحسابات المتعددة»; the technical record is `docs/DEPLOYMENT.md` §6.1.
`render.yaml` deploys every commit to the tracked branch (`autoDeployTrigger: commit`), so **R1-b reaches that branch
in one merge, as a whole** — never step 1 or 2 alone (step-1 review), and no other change may be merged until the
upgrade page says «اكتملت الترقية».

1. **Before merging:** «مركز التحكم» → «نسخ احتياطي الآن» and wait for «نجحت» (with R2 configured, check the copy
   arrived: «النسخ الاحتياطي خارج الخادم»). Write down the upgrade page address: the service address +
   `/api/maintenance`. Make sure you know the **current password** or have an unused **recovery code**. Check the disk:
   the migration needs about 2.2 × (database + files) + 64 MB free (Render → Disks; enlarge first if in doubt).
2. **Merge** the R1-b pull request into the branch Render deploys. Wait until the deploy is **Live** (the health check
   passes while the server waits on the maintenance page).
3. The installed app on your devices shows its sign-in screen and a message naming the upgrade page — expected. **Do
   not delete the app or clear its site data**: what it wrote offline is kept and sent after the upgrade.
4. Open `https://<your-service>.onrender.com/api/maintenance` in Safari or Chrome → «الترقية لم تكتمل بعد». Enter the
   username and current password (or a recovery code — checked, not used up), tick «نعم، ابدأ…», press **«ابدأ
   الترقية»**. The page refreshes itself through seven steps (the backup and its restore check take longest).
5. **«اكتملت الترقية»** → «افتح التطبيق». On each device tap **«تحديث»** when it appears; the device keeps its data and
   sign-in for your account (user #1). Then make a fresh backup («نسخ احتياطي الآن»).
6. **If it stops** («توقفت الترقية», with the reason in Arabic; nothing deleted): fix the reason (disk, R2) and press
   «أعد المحاولة», or «تراجع عن الترقية». A restart or redeploy in the middle resumes by itself from the last step.
   Alternative start without the page: Render → Environment → `MEDLEVO_OWNER_MIGRATION=apply` → Save; remove it after
   «اكتملت الترقية».
7. **Rolling back after it completed** (only while no other account exists) — **in this order**: Render → Environment →
   `MEDLEVO_OWNER_MIGRATION=rollback` → Save → the page shows «تم التراجع عن الترقية» → only then Render → Events → the
   deploy before R1-b → **Rollback** → remove `MEDLEVO_OWNER_MIGRATION`. **Never start with Render's Rollback:** R1-a
   on the migrated disk refuses to start («file is not a database» — the tombstone, on purpose; nothing is lost);
   redeploy the latest commit and follow the order above. If the rollback is refused (another account exists, or a later
   release changed the schema), restore the backup kept in `DATA_DIR/migration/` or the latest R2 copy
   (`docs/BACKUP_RESTORE.md` §8, `DEPLOY_PHONE_AR.md` «الاستعادة»).

**Not run (reason)** — R1-b ships with these open:

| what | why |
|---|---|
| The upgrade on Render, an R2 copy of the pre-migration backup, the phone-only dry run | no Render / Cloudflare account and no phone here; R2 paths tested against the signature-checking S3 fake |
| An **installed** R1-a PWA (iPad / phone) updating itself after the migration, offline outbox on a real device | no device; covered by replaying two devices' queued outbox operations against R1-b in the end-to-end script and by jsdom + fake IndexedDB tests of the in-place claim |
| Any device: iPad + Apple Pencil, S Pen, BOOX (N1 pen feel, palm levels, latency, long press, two-finger ruler, pencil grain on e-ink) | no device; headless Chromium (390 × 844 touch emulation, 1280 × 800), mouse / CDP touch only |
| The Docker image rebuild (`Dockerfile` gains `medlevo-migrate-multi-user`) | `dockerd` is installed but no daemon runs in this container: the image is not rebuilt, and the wrapper script `deploy/docker/medlevo-migrate-multi-user` was not run inside it (the CLI it calls, `src/cli/migrate-multi-user.ts`, is run as a real process by `test/tenancy/owner-migration.test.ts`) |
| Two accounts in one browser (`e2e/aos-p1-two-users-one-browser.spec.ts`) | there is no registration route until P1-T4; covered by server isolation tests and web jsdom tests |
| A live AI provider (`npm run eval -- --mode=live`), recognition reflow (G10 phase 2) with a real reader | no `ANTHROPIC_API_KEY`; fake providers only |
| `MEDLEVO_PERF=1` suites, Safari / Firefox, screen readers, axe-core, CI on a GitHub runner | not available or not re-run here (no change to the measured paths) |

**Carried forward** (reported by the reviews, not blocking R1-b; each in its module note and the matrix «remains»
column): RATE_LIMITS.auth still 30 sign-ins / minute / address (a class behind one NAT, AOS-21.45); platform records
(client errors, evaluation runs, backups list) live in user #1's vault until T4 moves them; the platform admin can
download a whole-instance archive (plain while only one account has ever existed — ADR-0003 owner to decide);
export archives not counted in the quota; `pre-restore-*.sqlite` copies never pruned; R2 remote copies kept after
switching back to local blobs; the CLI cannot see a running R1-a server (stop it first); while the maintenance page is
up an R1-a app is signed out until the migration ends; the pre-migration R2 copy follows normal retention; two CLIs at
once not mutually excluded; N1: the `ink` settings object is one last-writer-wins unit between devices, sticky notes
are not resizable, per-tool current presets stay on the device, Shift-constrained shapes (AOS-1.7) not built, the ruler's
keys differ from AOS-1.8, «عرّف» / «أضف إلى المراجعة» in the page menu wait for N3 / N4.

#### Release R1-c «channels and the vertical slice» — GATE-1 verification (2026-10-22)

**Status: verified in this container by GATE-1** (BUILD_PLAN §3.9; commands, counts and durations: `docs/TEST_LOG.md`
«GATE-1 — Phase 1 exit gate»; the phase verdict, every open Must and the Not-run list: [PHASE1_REPORT.md](PHASE1_REPORT.md)).
Nothing was run on a device, on Render, on Cloudflare R2 or with an AI key.

**What shipped** (each part built by its track and reviewed adversarially, §1.2):

| part | what the owner and the students get | reviewed in |
|---|---|---|
| Wave-2 step 0 — contracts | the shared contracts of P1-T4 / P1-T5 (`packages/shared/src/academic/*`), the space-route declarations, the web seams | `TEST_LOG` «Wave-2 step 0 — adversarial review» |
| P1-T4 step 1 — tree, joining, roles | University → … → Subject tree (one **space per subject**), class codes / invite links / QR (hashed, rate-limited), registration **only** with a code or link, approvals, invitations, roles inherited down the tree, the generated X9 matrix | «AOS P1-T4 step 1 — adversarial review» |
| P1-T4 step 2 — notifications, moderation | in-app inbox (batched fan-out, per-kind preferences, read state, access re-checked at read time), minimal moderation (report → hide / restore / dismiss with a reason, author and reporter told, audit), scoped audit view, course follow | «AOS P1-T4 step 2 — adversarial review» |
| P1-T4 step 3 — the web | five destinations (الرئيسية، المكتبة، القنوات، المراجعة، أنا) and the bell, «القنوات», the subject page, the join sheet with an in-app QR scanner, the invite landing, «أنا» (devices, privacy, usage), «التنبيهات», «إدارة القنوات» with its sections | «AOS P1-T4 step 3 — adversarial review» |
| P1-T5 step 1 — official lectures | official lectures and versions in the subject space, approval, publish with the page map, corrections, withdraw / rights takedown, attachments, exam dates, the updates feed, duplicates, «المحتوى الرسمي» / «الملفات المكررة» | «AOS P1-T5 step 1 — adversarial review» |
| P1-T5 step 2 — study copies | «ابدأ الدراسة» (a stub in the student's vault, no page bytes copied), course-follow and new-version fan-out with safe note copying, link a private lecture to its official twin (Partial), promote a moderator's lecture, federated search with scope tokens, stub retrieval | «AOS P1-T5 step 2 — adversarial review» |
| P1-T5 step 3 — course-only explanations | publish chosen layers course-only, independent fork and followed copy, update preview / apply / skip / auto, moderation hide / restore, withdrawal, account deletion | «AOS P1-T5 step 3 — adversarial review» |
| GATE-1 fixes | spaces in every whole-instance backup; the backup download says why it is unavailable; R1-c tells an R1-a owner to deploy R1-b first; the page indicator's accessible name; breadcrumb touch targets; one test template directory per run; the opt-in browser perf suite runs again | PHASE1_REPORT §4 |

**Migrations actually shipped:** base `0163_pinned_region`, `0860_document_copy` (applied to each vault when it is first
opened); system `2050_directory`, `2060_lecture_copy`, `2100_permissions`, `2150_publications`, `2200_notifications`,
`2310_moderation`; space `3000_official_lectures`, `3010_subject_content`, `3050_publications`, `3300_scoped_fts` — as the
table above planned. Because R1-c adds base migrations, **R1-b refuses to start on R1-c data** (checked against the real
R1-b release) and **R1-c refuses to migrate an R1-a owner itself** (it says to deploy R1-b first; nothing changes).

**GATE-1 verification:** first pass on the whole tree — typecheck, lint, build, evaluation (80 / 80) and `npm test`
green, full E2E 177 passed / 2 failed / 17 skipped (`g7-ac30-restore` phone + desktop); the owner migration end to end
against the real R1-a and R1-b releases (R1-a → R1-b → R1-c 43 / 43 checks; R1-a → R1-c refused, nothing changed,
8 / 8); the critic pass of the 30 new screens at 390 / 1280 px in light, dark and e-ink (180 screenshots, 0 findings
after the fixes); the performance gate against R1-b (same VM, same suites: no PRD NFR-P budget broken — P2, P5, P6 met,
P1 Not run; two server medians > 10 % slower in the gate's run, not reproduced by its reviewer — PHASE1_REPORT §7). Six defects found and fixed with tests that
failed first, plus three defects of the test harnesses (PHASE1_REPORT §4). Final gates on the final tree:
typecheck, lint, `npm test` (shared 229, server 2 319 + 7 skipped, web 1 211 + 1 skipped), build (337 precache
entries) and the evaluation (80 / 80, `no_regressions`) green; full E2E 174 passed / 5 failed / 17 skipped, the 5 being
test defects (an E2E assertion of the page indicator's old name, a probe reading a colour transition) — fixed, the two
specs re-run 10 / 10, then a **second full E2E: 179 passed, 0 failed, 17 skipped**. **Phase 1 verdict (after the gate's adversarial
review): not complete and not closed** — the gate does not pass while 50 buildable Must rows and X8 (c), (d) are open
(«closed with blocked Musts» needs every runnable Must to pass, PRD §5.2); 13 rows are device- or account-blocked; the
owner signs off the Not-run list (PHASE1_REPORT §1, §5, §13). The two medians > 10 % slower than R1-b did not
reproduce in the review's alternating re-runs (−4 %, −9 %; PHASE1_REPORT §7). The review's findings and runs:
`docs/TEST_LOG.md` «GATE-1 — adversarial review».

**Updating the owner's Render deployment (owner-facing steps).** The Arabic version is `docs/DEPLOY_PHONE_AR.md`
«التحديث إلى الإصدار R1-c»; PHASE1_REPORT §12 has the same steps in English. In short: (0) check which branch
and commit Render deploys — on 2026-10-22 the repository had no `main`, only `claude/sweet-pascal-uafn2f` at the
work-in-progress snapshot (GATE-1 review); (1) be on R1-b with «اكتملت
الترقية» first (if `main` already holds R1-c: Render → Manual Deploy → «Deploy a specific commit» → `514f356`, finish the
upgrade, then «Deploy latest commit»); (2) check `MEDLEVO_BACKUP_ENCRYPTION_KEY` is set and saved; (3) «نسخ احتياطي الآن» → «نجحت» — the only
way back; (4) merge, wait for Live (no maintenance page); (5) tap «تحديث» on each device; create the tree, subjects and
a class code or invite link in «إدارة القنوات» (no open sign-up); (6) back up again and «تحقّق من الاستعادة»; (7) to go
back, restore the step-3 backup — a Render rollback to R1-b fails to start on R1-c data, on purpose.

**Not run (reason)** — R1-c ships with these open (details and what unblocks each: PHASE1_REPORT §6):

| what | why |
|---|---|
| Render, R2, the phone-only dry run, an installed PWA updating itself | no Render / Cloudflare account, no phone here |
| iPad + Pencil, S Pen, BOOX, iPhone / iPad Safari, the in-app QR scanner with a real camera | no device (Chromium's fake camera stream only) |
| VoiceOver / TalkBack, Safari / Firefox, Web Push | not available here |
| A live AI provider | no `ANTHROPIC_API_KEY` |
| NFR-OP2 load test, NFR-P1 pen latency | need the target Render plan / the devices |
| Docker image rebuild, CI on a GitHub runner | no Docker daemon here; not pushed |

**Carried forward:** X8 (c) (19H.3: unplaced linked items in no review list; inserted note pages not copied); no
per-space backup artifact and no per-space storage quota; the 50 open buildable Musts of PHASE1_REPORT §5.3; the heavy
study-copy bar on phones; owner question N4; every «remains» item of the track reviews.

### 1.4 Coordination with other work

* **Round 7 hardening** is still running on 2026-10-20 (it added migrations `0280`, `0290`, `0670`, `0810` and a manual
  re-anchoring UI, `POST /api/annotations/reanchor`). No track starts before Round 7 has merged and its final runs are
  green; every track then re-reads the files it owns. Round 7's task «Cloud deploy from phone» (Dockerfile, Render
  blueprint, R2 off-site backups, Arabic guide) is **PL-0** and a prerequisite of P1-T1's OC.1 and OC.7 work.
* **Parity tracks N1–N5** (`docs/research/NOTE_APP_FEATURE_PARITY.md`, «Build plan») deliver the depth of the personal
  notes engine. The §1 rows they cover are listed under companion work C-PAR (§3.8) and are not rebuilt here. If N1 runs
  at the same time as P1-T2, N1's Wave 0 seams land first and P1-T2 uses them (§3.2); if N1 has not started, P1-T2 lands
  the visibility-predicate seam itself and N1 later consumes it.
* **Migration numbers** are re-checked by `ls apps/server/src/db/migrations` in each track's first commit; a track takes
  the next free number in its own range (ARCHITECTURE_DELTA §3.2).

## 2. Definition of done (every track)

1. **Baseline first (PRD AOS-23.5).** Before building, the builder re-verifies the `Now` status of every row in the
   track's «Covers» list and records the file and test evidence in the new «AOS» part of `docs/REQUIREMENTS_MATRIX.md`
   (PRD §1, Appendix D). A wrong `Now` value is corrected in the PRD in the same change.
2. **Every acceptance criterion of every covered row** passes with the test tag it names, or is listed «Not run
   (reason)» with what unblocks it. A `M` row that is not run keeps the phase from being *complete* (PRD §5.2).
3. **Existing behaviour preserved.** The full existing suites pass inside a bound vault; any test edited beyond the
   binding harness is listed with its ARCHITECTURE_DELTA §15 row (PRD §3.2).
4. **Private by default and permission-checked.** New routes go through `authz`; new space routes are on the allow-list
   (ARCHITECTURE_DELTA §5.5) with their minimum access; the X9 matrix gains the track's resources.
5. **No decorative controls (AOS-23.3).** Every new control acts or is disabled with its capability or permission
   reason; controls of a later phase are not shown. The sweep `e2e/aos-no-decorative.spec.ts` (owned by P1-T4) passes.
6. **Honest capabilities.** New capability keys in `packages/shared/src/features.ts`, rows in `docs/CAPABILITY_MATRIX.md`,
   device numbers only when measured on the device.
7. **Arabic RTL and accessibility.** Arabic UI text, logical start/end, English runs isolated, no bidi control characters
   stored (AC-20); keyboard paths; 44 px targets; axe with 0 serious violations on new screens; light, dark and e-ink.
8. **Performance (AOS-23.2).** `docs/PERFORMANCE.md` budgets and the PRD NFR-P budgets the track touches are rerun and
   compared with the previous phase; heavy work never runs on the request event loop (NFR-OP2).
9. **Offline and no loss.** Writes go to IndexedDB and the outbox before the network; replaying an op twice changes
   nothing; deletes are tombstones; new tables are in backup, export and purge and pass `npm run restore:verify`.
10. **Docs.** The module note (`docs/modules/*.md`), `docs/TEST_LOG.md`, `docs/REQUIREMENTS_MATRIX.md` (AOS part),
    `docs/CAPABILITY_MATRIX.md` and the Phase report draft (PRD §5.2) are updated by the track.

---

## 3. Phase 1 — Foundation and vertical slice (full detail)

**Exit (PRD §5.1):** Scenarios 2 and 4; AC-01a, AC-01b, X8, X9; the minimal moderation flow; existing suites inside a
bound vault; performance gate; phase report. **Vertical slice:** official lecture → «ابدأ الدراسة» (personal copy with
layers) → ink and notes offline → sync → a classmate's followed explanation updates → a new official version keeps every
note.

### 3.1 Shape

```
Wave 1 ─┬─ P1-T1  Tenancy core, identity and owner migration ── step 0 seams (merged first, ~2 days) ── steps 1–3
        ├─ P1-T2  Layers, history, ink data, writing surface, safe note migration   (vault-local; needs T1 step 0)
        └─ P1-T3  Lecture identity, version matching, import intelligence           (vault-local; needs T1 step 0)
              │   T2 step 3 (re-anchor copy) needs T3 step 2 (page map)
              ▼   releases R1-a (T1 step 0 + T2 + T3) and R1-b (rest of T1)
Wave 2 ─┬─ step 0: contracts of T4 and T5 reviewed together (~1–2 days)
        ├─ P1-T4  Channels, permissions, notifications, administration, minimal moderation, app shell
        └─ P1-T5  Official lectures in subject spaces, copies and course-only publications (the vertical slice)
              ▼   release R1-c
GATE-1  Phase 1 exit gate: all suites, performance gate, X8/X9/AC-01a/AC-01b, Scenarios 2 and 4, phase report
Companion: C-PAR (parity N1–N5 rows of §1) and PL-0 (Round 7 deploy task) run beside the waves.
```

| track | wave | depends on | unblocks |
|---|---|---|---|
| P1-T1 | 1 | Round 7 merged; PL-0 for the OC.1/OC.7 dry runs | T2, T3 (step 0 seams); T4, T5 (binding, system DB, authz core) |
| P1-T2 | 1 | T1 step 0; T3 step 2 for its step 3; N1 Wave 0 if N1 runs | T5 (layers, layer copy, re-anchor copy, attribution) |
| P1-T3 | 1 | T1 step 0 | T2 step 3 (page map); T5 (fingerprints, new-version detection, link candidates) |
| P1-T4 | 2 | T1 complete (R1-b); wave-2 step 0 | T5 (authz rules, notifications, moderation, admin section registry, routes) |
| P1-T5 | 2 | T1, T2, T3 merged; T4's contracts (step 0) | GATE-1 (Scenarios 2 and 4) |

### 3.2 Hot files and seams

| file or area | owner in Wave 1 | owner in Wave 2 | how others reach it |
|---|---|---|---|
| `apps/server/src/context.ts`, `app.ts`, `config.ts`, `index.ts`, `db/db.ts`, `db/migrate.ts` | T1 | T1's code, frozen (changes only by T4 with T5's reviewer agreeing) | binding API, `ctx.system`, `ctx.authz`, `ctx.quota` |
| `modules/sources/purge.ts` | T1 (step 0: purge-extension registry; blob deletion delegated to `files/blobs.ts`) | T5 | `registerPurgeExtension()` called from each module's own plugin (T2: layers, revisions; T3: fingerprints, page maps) |
| `packages/shared/src/errors.ts`, `features.ts` | T1 (step 0 adds **every** Phase 1 error code and capability key from ARCHITECTURE_DELTA §7.1 and ADR-0005 §6) | T4 (append-only; T5 asks in wave-2 step 0) | read-only imports |
| `packages/shared/src/index.ts` (barrel) | T1 (step 0 exports `./academic`) | — | each track adds its files to `packages/shared/src/academic/index.ts`, which **each track appends to only in its own step 0** |
| `packages/shared/src/annotations.ts` | T2 (`layer_id`, `InkData v2`) | — | T3 and T5 put their types in `academic/*.ts` |
| `apps/web/src/lib/localdb.ts` | T1 (step 0: the whole Phase 1 `LOCAL_SCHEMA` bump: per-user name, `layers`, `spaceCursors`, `copies`, draft tags) | — | repositories in each feature folder |
| `apps/web/src/lib/sync.ts`, `lib/auth.ts`, `lib/deviceId.ts`, `lib/settings.ts`, `lib/capabilities.tsx` | T1 (step 0: `onRejected(entityType, handler)` hook; targets) | — | T2 re-homes rejected ink through the hook |
| `apps/web/src/features/workspace/ink/*` | T2 (through N1 Wave 0 seams if N1 runs) | — | — |
| `apps/web/src/features/workspace/*` outside `ink/` (WorkspaceScreen, panels) | T2 (layers panel in `panels/LeftPanel.tsx`) | T5 (copy chip, version banner; new `workspace/copies/*`) | — |
| `apps/web/src/app/*` (AppShell, routes, router, layouts) | T1 (layouts: draft recovery per user, client-version gate) | T4 (5 destinations; in wave-2 step 0 it adds the route imports of `features/lectures` and `features/copies`) | feature route arrays |
| `modules/authz/*` | T1 (policy core, binding hook, `spaceRoutes.ts`) | T4 (`rules/channels.ts`, matrix test), T5 (`rules/{lectures,publications,layers}.ts`, entries in `spaceRoutes.ts`) | rule modules self-register; only T5 edits `spaceRoutes.ts` in wave 2 |
| `apps/web/src/features/admin/sections.ts` | — | T4 | T5 registers «المحتوى الرسمي», «الملفات المكررة» and «الملفات والمواعيد» (IA §4.10; planned in the wave-2 step-0 review) from `features/lectures/admin/*` |
| `e2e/smoke.spec.ts`, `e2e/g1-ac01-personal-library.spec.ts` | — | T4 (navigation change; AC-01a replaces the second) | — |

---

### 3.3 P1-T1 — Tenancy core, identity and owner migration

**Gives:** one vault per user, the system database, per-subject space binding, the owner migrated as user #1 with zero
loss, per-user data on shared browsers, platform-only operations, quotas — everything else stands on it.

**Steps.** 0 — seams for Wave 1 (purge-extension registry, all Phase 1 error codes and capability keys, `academic/`
barrel and `visibility.ts`, the Phase 1 Dexie schema bump, the sync `onRejected` hook, `withTestBinding` harness as a
no-op, base migrations `0041`/`0050`); 1 — system DB, binding (ALS, root context for background work), vault pool, job
index, accounts and devices, authz core with the space-route allow-list mechanism, platform routes (§5.8);
2 — files: chunked uploads, blob registry with mark-and-sweep GC, R2 object-store adapter, encrypted backups, per-vault
export and account deletion; quotas and atomic AI reservation; 3 — web: per-user IndexedDB, `localStorage` and drafts,
client-version gate, legacy claim; the journaled owner migration with its boot guard; AC-01a server part.

**Owns**
* Server core: `apps/server/src/{context.ts, app.ts, config.ts, index.ts}`, `db/db.ts`, `db/migrate.ts` (sets
  base / system / space); new `apps/server/src/system/*` (system DB handle and viewer-taking repositories),
  `apps/server/src/cli/migrate-multi-user.ts`.
* New modules: `modules/accounts/*`, `modules/authz/*` (policy core, binding hook, `spaceRoutes.ts`, rule registry),
  `modules/platform/*`.
* Existing modules it changes: `auth/*` (multi-user sessions, register behind a `JoinTokenVerifier` interface that T4
  implements, progressive per-account delay), `files/*` (+ `files/blobs.ts`, `files/uploads.ts`, `files/r2.ts`),
  `jobs/*` (job index, root context, worker threads for heavy jobs), `sync/*` (actor, device check, transient
  rejections not recorded, per-DB feeds, `visibility_key`, `granted_keys`), `audit/*` (`actor_user_id`), `data/{backup,
  backups,export,restore,index}.ts` (platform-only whole-instance routes, per-vault export, encryption, mark after
  restore), `control/{storage,index}.ts` (rescoped storage, platform sections moved), `ai/orchestrator.ts` (per-user and
  per-space allowance, atomic reservation), `evidence/{cache,scope}.ts` (viewer dimension), `settings/*` (per-user
  capability view), `sources/upload.ts` (duplicate answer scoped to what the uploader can see), `sources/purge.ts`
  (step 0 seam only).
* Migrations: base `0041_sync_actor_visibility.sql`, `0050_change_log_actor.sql`; system `2000_identity.sql`,
  `2010_devices.sql`, `2040_registry.sql` (`space`, `vault`), `2250_ops.sql`, `2300_security.sql` (`security_audit`,
  `consent_record`).
* Shared: `packages/shared/src/academic/{index.ts, visibility.ts, accounts-api.ts, platform-api.ts}`; step-0 appends to
  `errors.ts`, `features.ts`, `index.ts`, `api.ts` (client-version header constant).
* Web: `apps/web/src/lib/{localdb.ts, sync.ts, auth.ts, deviceId.ts, settings.ts, capabilities.tsx, api.ts}`, new
  `lib/userStorage.ts`, `app/layouts.tsx`, `app/guards.ts`, `features/auth/*` (register, devices list), the
  `localStorage` call sites listed in ARCHITECTURE_DELTA §4.5 (only to switch them to `userStorage`),
  `features/workspace/data/noteDrafts.ts` (per-user drafts).
* Tests: `apps/server/test/helpers/*`, `apps/server/test/tenancy/*`, `test/accounts/*`, `test/platform/*`,
  `test/acceptance/ac01a.test.ts`, `test/acceptance/g8-security.test.ts` (public-route list); `apps/web/test/tenancy/*`;
  `e2e/aos-p1-two-users-one-browser.spec.ts`.
* Docs: `docs/modules/tenancy.md` (new), `docs/ARCHITECTURE.md` edits listed in ADR-0003 §3.9, `docs/BACKUP_RESTORE.md`,
  `docs/DEPLOYMENT.md` (multi-user env, migration runbook in Arabic).

**Covers:** 1.29, 1.38, 3.6, 4.7, 5.22, 11.27, 14.1, 14.11, 15.8, 19J.1, 21.1, 21.9, 21.10, 21.27, 21.28, 21.29, 21.30, 21.33, 21.34, 21.35, 21.36, 21.38, 21.42, 21.43, 21.44, 21.45, 21.46, 21.47, 21.49, 23.5, OC.1, OC.7

**Acceptance tests**
* `test/tenancy/binding.test.ts` — 0 cross-tenant reads over 200 interleaved requests of two users; unbound access throws
  `NO_TENANT_BOUND` (also from a timer); a job enqueued from user A's request and run for user B never touches A's
  vault (`poke()` case, ARCHITECTURE_DELTA §1.1).
* `test/tenancy/owner-migration.test.ts` (X8 a–b) — on a Golden-Set fixture database: vault sha256 equal before the first
  boot; row counts equal; checksums recorded after boot; old password and an unused recovery code work; pull continues
  with the same cursor and epoch; a crash injected after each journal step resumes to the same end state; the boot guard
  never enters setup mode while `medlevo.sqlite` or `vaults/*` exist without the registry; a legacy outbox (ops queued
  before the upgrade from two devices) replays with every op applied exactly once.
* `test/tenancy/blob-gc.test.ts` — crash between `stored_file` insert and the `blob_ref` hint; a vault restored from an
  older backup; the sweep keeps every referenced blob, quarantines before deleting, and restore-verify rebuilds hints.
* `test/sync/transient-rejections.test.ts` — `device_unknown`, `not_a_member`, `quota_exceeded`, `op_id_taken` are not
  recorded and succeed after the cause is fixed (the last under a new `op_id`); final rejections stay recorded.
* `test/platform/routes.test.ts` — every route of ARCHITECTURE_DELTA §5.8 answers 404 to a non-admin, including today's
  `/api/data/backups*` and `/api/data/export/all`; user A's Control Center never shows user B's storage, jobs or history.
* `test/accounts/*` — devices get a server-issued `device_uid`; progressive sign-in delay with no hard lockout; recovery
  code bypass; per-IP ceiling high enough for 200 sign-ins from one IP; account deletion removes the vault and blob
  hints and calls the deletion participants (T5 adds publications); export contains only the user's vault.
* `test/ai/allowance.test.ts` — concurrent reservations never exceed the allowance; a private-notes artifact is never
  served to another user (cache key with the viewer scope hash).
* `test/acceptance/ac01a.test.ts` — every step of today's AC-01 for a user with no channel.
* Web: `test/tenancy/localdb-per-user.test.ts`, `userStorage.test.ts` (lint rule: no raw `localStorage`),
  `noteDrafts-per-user.test.ts`; `e2e/aos-p1-two-users-one-browser.spec.ts` — two users on one browser profile: neither
  outbox nor crash-recovered draft is saved or pushed under the other's session; a pre-upgrade client gets
  `426 CLIENT_TOO_OLD` and updates; AC-23 per user.
* NFR-P6: vault-binding p95 overhead on a cache miss ≤ 50 ms (CI).

**Blocked here:** the iPad-only deploy, backup and restore-verify dry run (OC.1) needs Render and R2 accounts and an iPad
— recorded «Not run (no accounts / device)»; R2 is tested against a local S3-compatible fake, not the real service.

**Reviewer focus:** any path that reads another vault (routes, jobs, timers, file tokens, duplicate answers, export,
cache); any rejection that is recorded although transient; migration steps that are not idempotent; setup mode
reachable on an upgraded disk.

---

### 3.4 P1-T2 — Layers, history, ink data, writing surface and safe note migration

**Gives:** authorship layers on every document (show / hide, read-only layers that never lose a stroke), copy one layer
between copies, a per-layer history, packed ink, the dense-page tile cache, e-ink mode — and the copy-never-move
migration of personal notes to a new version (the note side of Scenario 4).

**Steps.** 1 — `annotation_layer`, `layer_id`, layer rules R1–R6 on the server, Dexie `layers` use, layers panel,
visibility predicate in render / hit-test / eraser / lasso, re-homing of rejected items; 2 — `annotation_revision` and
the history list, copy one layer with attribution (`0861_attribution`), ink v2 codec and `accept-ink: 2`, tile cache,
e-ink / high-contrast / lite modes, native-shell skeleton and CI workflow files; 3 — `reanchor_copy` between versions
(needs P1-T3 step 2): deterministic copies, review list reusing Round 7's re-anchoring UI as a copy, report and undo.

**Owns**
* Server: `modules/annotations/*` except `reanchor.ts` (Round 7's single-version re-anchoring stays as is; T2 adds
  `annotations/reanchorCopy.ts`, `layers.ts`, `history.ts`, `layerCopy.ts`, `purgeExtension.ts`).
* Migrations: base `0271_annotation_layers.sql`, `0272_annotation_revision.sql`, `0861_attribution.sql`.
* Shared: `packages/shared/src/annotations.ts` (`layer_id`, `InkData v2`), `packages/shared/src/academic/{layers.ts,
  ink-codec.ts}`.
* Web: `apps/web/src/features/workspace/ink/*` (own new files `ink/layers/*`, `ink/tiles/*`, `ink/codec.ts`; existing ink
  files through N1 Wave 0 seams when N1 runs), `features/workspace/panels/{LeftPanel.tsx, LayersTab.tsx}`,
  `features/workspace/panels/ReanchorSection.tsx` (extended for cross-version review), `design/tokens*` and
  `design/theme*` for `data-eink`, `data-contrast`, `data-lite`, `features/settings/*` (appearance rows), new
  `apps/native/*` (Capacitor skeleton) and `.github/workflows/native-*.yml` (static checks only).
* Tests: `apps/server/test/annotations/{layers,layer-copy,history,ink-v2,reanchor-copy}.test.ts`,
  `packages/shared/test/ink-codec.test.ts`, `apps/web/test/ink/{layers-visibility,rehome,tiles}.test.ts`,
  `e2e/aos-p1-layers.spec.ts`, `e2e/aos-p1-note-migration.spec.ts`, `e2e/aos-eink.spec.ts`, additions to
  `e2e/perf.spec.ts`.
* Docs: `docs/modules/ink.md`, `docs/modules/workspace.md`, `docs/CAPABILITY_MATRIX.md` (pen, e-ink, native rows),
  `docs/PERFORMANCE.md`.

**Covers:** 1.1, 1.4, 1.6, 1.9, 1.10, 1.13, 1.14, 1.15, 1.22, 1.24, 1.28, 1.30, 1.39, 3.13, 4.6, 4.10, 4.11, 4.15, 4.17, 19L.3, 19L.5, 20.2, 20.4, 20.19, 21.11, 21.12, 21.48, OC.2, OC.5, OC.6, OC.8

**Acceptance tests**
* `test/annotations/layers.test.ts` — an op on a followed or snapshot layer is `rejected/layer_read_only` and recorded;
  a `conflict_kept_both` copy lands in the actor's own layer; the eraser cannot tombstone another author's item; legacy
  rows (`layer_id` NULL) behave exactly as today (the 28 existing annotation tests unchanged).
* Web `test/ink/rehome.test.ts` + `e2e/aos-p1-layers.spec.ts` — Scenario 2 step 4 on a fixture followed layer: the UI
  refuses the erase, a raw delete op is refused, and a stroke drawn on a read-only layer is re-created in «ملاحظاتي»
  with the reason shown; hide / show per session; lasso can copy but not move read-only items; highlights blend inside
  their own layer.
* `test/annotations/layer-copy.test.ts` — copy one layer: preview counts per kind and page, new derived ids, attribution
  per item, image references counted, source unchanged (hash); re-run is a no-op.
* `test/annotations/history.test.ts` — every update, delete and restore writes a before-image in the same transaction;
  the history list shows author, time and action; purge removes the revisions (purge extension).
* `packages/shared/test/ink-codec.test.ts` — lossless round trip of v2 packed points against `roundPoint`; old clients
  without `accept-ink: 2` receive v1.
* `test/annotations/reanchor-copy.test.ts` + `e2e/aos-p1-note-migration.spec.ts` — Scenario 4 inside one vault: ink on
  p.5 copied to v2 p.5, a highlight on p.12 to v2 p.14, the p.30 note listed for review with a side-by-side view; v1 rows
  byte-identical (hash); preview before the tap, nothing changes until it; a second run is a no-op; undo tombstones the
  copies only; counts before = moved + needs review + kept.
* Performance: NFR-P2 warm repaint of the realistic 5,000-stroke page < 200 ms in the CI harness with tiles, no long task
  > 100 ms while writing; the 5,000-stroke page with 5 layers passes docs/PERFORMANCE.md budgets.
* `e2e/aos-eink.spec.ts` — `data-eink` removes motion and transitions, uses the grey palette, pages instead of smooth
  scrolling; visual check at 390 / 1280.
* Native skeleton: the Capacitor project and the CI workflow files pass static checks (lint, config schema) here.

**Blocked here:** pen-to-pixel latency on iPad + Pencil, S Pen and BOOX (NFR-P1, OC.8 `[dev]`), stray-touch rates, a BOOX
e-ink check (OC.5 `[dev]`), and any signed native build — all «Not run (no device / no macOS runner)».

**Reviewer focus:** any path that deletes or rewrites a personal item (re-anchor must copy); layer checks that only the
client enforces; performance regressions on the pen path; e-ink mode leaving motion behind.

---

### 3.5 P1-T3 — Lecture identity, version matching and import intelligence

**Gives:** lecture numbers, names and dates detected from files; page fingerprints; «this looks like a new version of
Lecture 5»; the old ↔ new page map with inserted, removed and changed pages; DOCX display PDF; and the match engine that
later links a private lecture to its official twin.

**Steps.** 1 — numbering, name and date detection with review (Arabic-Indic digits, ordinal words, noisy file names),
ordering, subject suggestions; DOCX → display PDF; printed TOC → page links; 2 — `page_fingerprint` (text hash, MinHash,
dHash) and the order-preserving page map with statuses, compare API and screen, «إصدار جديد من …» proposal;
3 — link-candidate matching (sha256 or ≥ 60 % fingerprints) as a pure service reused by T5.

**Owns**
* Server: new `modules/versions/*` (fingerprints job, page-map job, compare and link-candidate services,
  `purgeExtension.ts`), `modules/sources/{classify.ts, views.ts, pagelabel.ts}`, `modules/processing/{office.ts,
  structure.ts}` + new `processing/fingerprint.ts`.
* Migrations: base `0160_lecture_identity.sql` (lecture number, date, stub columns used later by T5),
  `0161_page_map.sql`.
* Shared: `packages/shared/src/academic/versions.ts` (page map, compare, link candidates).
* Web: `features/sources/*` (versions panel: original vs converted, compare versions, new-version confirmation),
  `features/upload/*` (number, name and subject suggestions held for confirmation).
* Tests: `apps/server/test/versions/*`, `apps/server/test/processing/docx-display-pdf.test.ts`, fixtures under
  `apps/server/test/fixtures/versions/*` (labelled TEST FIXTURE), `e2e/aos-p1-versions.spec.ts`.
* Docs: `docs/modules/library-sources.md`, `docs/modules/processing.md`.

**Covers:** 2.4, 3.2, 3.3, 3.4, 3.5, 3.7, 3.9, 3.11, 3.12, 3.14, 3.18, 19H.2, 21.13

**Acceptance tests**
* `test/versions/numbering.test.ts` — «Lecture 5», «Lec 05», «محاضرة ٥», «المحاضرة الخامسة» in names and first pages;
  uncertain values go to the review queue and have no downstream effect until confirmed (3.18).
* `test/versions/page-map.test.ts` — the Scenario 4 fixture (2 pages inserted after p.10, p.30 rewritten): p.1–10 → p.1–10,
  two inserted pages, p.11–40 → p.13–42, p.30 → p.32 flagged changed; a re-exported identical PDF maps all pages `safe`
  with `layout_safe`; thresholds versioned in `algo`.
* `test/versions/new-version-detect.test.ts` — «Abdomen lec5 final (1).pdf» is proposed as a new version of Lecture 5;
  nothing is applied without confirmation (19H.2).
* `test/versions/link-candidates.test.ts` — sha256 match and ≥ 60 % fingerprint match found; an unrelated deck not.
* `test/processing/docx-display-pdf.test.ts` — Arabic / English DOCX fixture: fonts embedded, stable page count across
  runs, paragraph locators kept for evidence.
* `e2e/aos-p1-versions.spec.ts` — the single owner uploads a renamed v2 of their own lecture → «إصدار جديد من …» →
  side-by-side compare with inserted pages marked → confirm (Scenario 4 steps 2–3 without channels).

**Blocked here:** precision of subject suggestions on real course files (reported on the labelled fixture set only).

**Reviewer focus:** silent automatic application of an uncertain match; page maps that reorder pages; detection that
leaks titles of other users' files (it must run inside the caller's own database).

---

### 3.6 P1-T4 — Channels, permissions, notifications, administration and minimal moderation

**Gives:** the university tree, joining by code, QR or link, approvals, roles, the central permission matrix, the inbox,
the channel administration area, the minimal report → hide / restore flow, and the five-destination app shell.

**Steps.** 0 (with T5) — contracts: `channels-api.ts`, `notifications-api.ts`, `moderation-api.ts`; route imports for
T5's features in `app/routes.tsx`; `features/admin/sections.ts`; 1 — tree, closure, spaces created per subject (through
T1's registry), memberships, codes, invite links with the public preview, approvals, roles with inheritance, authz rules
for channel resources, generated matrix test; 2 — notifications (in-app inbox, dedupe, batched fan-out), security audit
view, minimal moderation (reports, hide / restore / dismiss, author and reporter notified), course follow;
3 — web: «القنوات» (channels home, browse, join sheet with QR scanner), subject page (tabs «المحاضرات», «الملفات»,
«التحديثات» reading T5's API), «أنا» (settings moved, devices, privacy and data, usage), «التنبيهات», «إدارة القنوات»
(tree, members and joins, codes, roles, audit, «الإشراف» Phase 1 part), the no-decorative-controls sweep, AC-01a e2e.

**Owns**
* Server: new `modules/channels/*` (also implements T1's `JoinTokenVerifier`), `modules/notifications/*`,
  `modules/moderation/*`, `modules/authz/rules/channels.ts`, `modules/authz/test-support/*` (matrix generator).
* Migrations: system `2050_directory.sql` (channel tree, closure, codes, memberships, invitations, course follow),
  `2100_permissions.sql`, `2200_notifications.sql`, `2310_moderation.sql`.
* Shared: `packages/shared/src/academic/{channels-api.ts, notifications-api.ts, moderation-api.ts}`; `errors.ts` and
  `features.ts` (append-only owner in Wave 2).
* Web: `apps/web/src/app/{AppShell.tsx, routes.tsx, router.tsx, shell.css}`, new `features/channels/*`,
  `features/admin/*`, `features/notifications/*`, `features/me/*`; a QR encoder/decoder dependency (web) added here.
* Tests: `apps/server/test/{channels,notifications,moderation,authz}/*`, `test/acceptance/ac01b.test.ts` (system paths),
  `apps/web/test/channels/*`, `e2e/aos-p1-join.spec.ts`, `e2e/aos-p1-admin.spec.ts`, `e2e/aos-ac01a.spec.ts` (replaces
  `e2e/g1-ac01-personal-library.spec.ts`), `e2e/aos-no-decorative.spec.ts`, `e2e/smoke.spec.ts` (navigation update).
* Docs: `docs/modules/channels.md`, `docs/modules/notifications-moderation.md`, `docs/design-system.md` additions
  (RoleBadge, QrCard, ReportDialog, NotificationRow, InlineBanner).

**Covers:** 1.16, 2.1, 2.11, 2.12, 2.13, 2.14, 2.15, 2.16, 5.24, 18.1, 18.2, 18.5, 18.6, 18.7, 18.8, 18.12, 18.13, 18.14, 19L.2, 19L.4, 20.1, 20.3, 20.5, 20.6, 20.10, 20.14, 20.15, 20.16, 20.17, 20.20, 20.21, 21.2, 21.3, 21.4, 21.5, 21.6, 21.15, 21.18, 21.31, 21.37, 23.3

**Acceptance tests**
* `test/channels/tree.test.ts` — kinds strictly descend (levels may be skipped); closure answers «inside» in one lookup;
  creating a subject creates its own space file; archive with an impact preview.
* `test/channels/join.test.ts` — codes hashed, expiring, revocable, usage-counted, rate-limited per account (10/hour) with a
  high per-IP ceiling; approval policies; the public preview route reveals only the title for a valid token and the same
  404 otherwise; `g8-security` asserts exactly two new public routes.
* `test/authz/matrix.test.ts` — generated: each resource type × action × role × visibility × membership state; 404 vs
  403; a Subject Moderator of A has no power in B; an Assistant cannot mark «راجعه مشرف المادة».
* `test/moderation/minimal.test.ts` — report (reasons incl. `patient_identifiers`, `copyright`) → queue of that subject →
  hide with reason → author and reporter notified → restore → two audit entries; one open report per reporter per target.
* `test/notifications/*` — dedupe keys, batches of 500, payloads hold titles and counts only.
* `test/acceptance/ac01b.test.ts` — two users in two subjects of two universities: no channel, membership, role, audit or
  notification data crosses (T5 adds the content paths).
* `e2e/aos-p1-join.spec.ts` (J9) — code entry, QR decoded from a generated image, invite link landing showing only the
  title, pending → approved with an inbox entry, «تابع المادة».
* `e2e/aos-p1-admin.spec.ts` — tree CRUD, codes, roles with inheritance shown, audit filtered by scope, «الإشراف» with a
  fixture report.
* `e2e/aos-ac01a.spec.ts` — today's AC-01 journey for a user with no channel, with no channel UI on those screens;
  `e2e/smoke.spec.ts` updated for «أنا».
* `e2e/aos-no-decorative.spec.ts` — every visible control on every screen at 390 and 1280 acts or is disabled with a reason.
* axe on every new screen: 0 serious violations (20.20); AC-20 on the new editors (channel titles, report notes).

**Blocked here:** web push delivery to iOS (inbox only, push probed and labelled); VoiceOver / TalkBack passes and the
5-student usability session (20.20, 20.21 `[dev]`).

**Reviewer focus:** existence leaks through 403 vs 404, counts or notification text; role inheritance across siblings;
codes guessable or rate limits that lock out a whole NAT; decorative controls.

---

### 3.7 P1-T5 — Official lectures in subject spaces, copies and course-only publications (the vertical slice)

**Gives:** official lectures and their versions in each subject's space, attachments and the updates feed, «ابدأ
الدراسة» copies as stubs, course follow, new official versions delivered with safe note migration, linking a private
lecture to the official one, course-only explanations with independent forks and followed copies, and the federated
search — the vertical slice end to end.

**Steps.** 0 (with T4) — contracts: `lectures-api.ts`, `copies-api.ts`, `publications-api.ts`; entries in
`authz/spaceRoutes.ts`; 1 — `lectures`: drafts, approval, upload through the existing pipeline inside the space, publish
version (T3's page map), corrections that create a new version, withdraw and rights takedown, attachments, the
exam-date table, `subject_event` feed, offline package of an official lecture, admin sections; 2 — copies: stubs with the
space's ids, «ابدأ الدراسة», `document_copy`, `lecture_copy`, course-follow stub fan-out, official-version fan-out through
`lecture_copy` → T2's `reanchor_copy`, purge refusal, linking and promoting private lectures (19H.3/19H.4), federated
search with scope tokens, stub retrieval with lazy pinning (`pinned_region`); 3 — publications: publish course-only with
delta storage and stable ids, independent fork, followed copy with preview / apply / skip / auto, marketplace list
(Phase 1: list only), «أبلغ» on the publication page (T4's moderation), account-deletion participant, Scenarios 2 and 4
end to end.

**Owns**
* Server: new `modules/lectures/*`, `modules/forks/*`; `modules/search/*` (federation); `modules/evidence/{retrieval.ts,
  evidence.ts, pack.ts}` (stub retrieval and lazy pinning); `modules/studybook/artifacts.ts` (official-only shared
  artifacts stored in the space); `modules/authz/rules/{lectures,publications,layers}.ts`, `modules/authz/spaceRoutes.ts`
  (entries); `modules/sources/purge.ts` (Wave 2 owner: refusal via `lecture_copy`, takedown file-reference nulling).
* Migrations: base `0163_pinned_region.sql`, `0860_document_copy.sql`; system `2060_lecture_copy.sql`,
  `2150_publications.sql` (`publication_series`, `publication`, `publication_copy`); space `migrations-space/3000_official_lectures.sql`,
  `3010_subject_content.sql`, `3050_publications.sql`, `3300_scoped_fts.sql`.
* Shared: `packages/shared/src/academic/{lectures-api.ts, copies-api.ts, publications-api.ts}`.
* Web: new `features/lectures/*` (lecture page with tabs «الرسمي» and «الشروحات», publication page, report dialog,
  `features/lectures/admin/*` sections «المحتوى الرسمي» and «الملفات المكررة»), new `features/copies/*` (Start Studying
  sheet, update preview, link-to-official sheet), new `features/workspace/copies/*` (copy chip, version banner) with its
  mount in `features/workspace/WorkspaceScreen.tsx`, `features/search/*` (scope chips, origin and database labels),
  `features/library/*` («موادي من القنوات», «موجودة رسميًا» badge).
* Tests: `apps/server/test/{lectures,forks,search}/*`, `test/evidence/stub-retrieval.test.ts`,
  `test/acceptance/ac01b-content.test.ts`, `apps/web/test/copies/*`, `e2e/aos-s2-followed-copy.spec.ts`,
  `e2e/aos-s4-official-version.spec.ts`, `e2e/aos-p1-vertical-slice.spec.ts`, the shared fixture world script
  `e2e/support/aos-world.ts` (PRD §8).
* Docs: `docs/modules/lectures.md`, `docs/modules/copies-publications.md`, `docs/modules/evidence-search.md`.

**Covers:** 1.17, 1.26, 1.31, 1.36, 2.2, 2.3, 2.5, 2.8, 2.9, 2.10, 2.17, 2.18, 2.19, 3.1, 3.8, 3.10, 4.1, 4.2, 4.3, 4.5, 4.14, 4.18, 4.20, 5.12, 5.18, 5.27, 14.15, 14.18, 14.19, 15.1, 15.15, 18.3, 18.4, 18.9, 18.10, 18.11, 18.17, 18.18, 19H.1, 19H.3, 19H.4, 19I.2, 19I.3, 19I.5, 20.18, 21.7, 21.8, 21.14, 21.16, 21.32, 21.44

**Acceptance tests**
* `test/lectures/*` — draft → approve → publish; a contributor's upload needs approval; a correction of a published
  version creates version n+1 through the page map and alerts stub holders, while vault pins keep their text and hash
  (ARCHITECTURE_DELTA §6.7); withdraw keeps ink; a rights takedown nulls the stub's file references and then deletes the
  vault's `stored_file` rows with `foreign_keys = ON`; attachments, exam-date rows and `subject_event` entries.
* `test/forks/stubs.test.ts` — a 40-page stub ≈ 10 KB; no blob, chunk or FTS row duplicated; «ابدأ الدراسة» twice
  reopens the same copy; course follow adds stubs idempotently by user + lecture version; `lecture_copy` rows match the
  vaults; a purge of v1 is refused while any vault holds personal items on it.
* `test/forks/link-private.test.ts` (X8 c) — linking a private upload copies every item to the official version or the
  review list; the private source is byte-identical before and after; promoting a private lecture registers the blob by
  sha256 without copying bytes.
* `test/forks/publications.test.ts` — publish course-only; republish with one changed stroke out of 5,000 writes one
  `publication_item` row; followers' unchanged item ids and every reference to them stay; the follower pulls about one
  stroke's bytes; fork pinned to its version; preview counts right; apply / skip / auto; personal rows byte-identical.
* `test/search/federation.test.ts` — scope tokens inside `MATCH`; a non-member never gets a space hit; a member of
  subject A never gets subject B; NFR-P5 p95 ≤ 50 ms on a 250k-chunk space (CI).
* `test/evidence/stub-retrieval.test.ts` — AC-05, AC-06, AC-07 and AC-29 rerun with a stub lecture whose chunks live in
  the space; citations stay rows in the vault through lazy pinning with content hashes.
* `test/acceptance/ac01b-content.test.ts` — no private layer, note or file of user A reaches user B through routes, sync
  pull, search, export, files, tokens, AI scope or notifications; a moderator of A gets nothing of B.
* `e2e/aos-s2-followed-copy.spec.ts` — **PRD Scenario 2, steps 1–7 with variants (a)–(e)**: publish, follow, personal ink
  offline, refused erase, republish, preview and apply, fork / auto / skip, «انقل ملاحظاتي من نسختي إليها», report → hide →
  restore by an Assistant, who cannot mark it reviewed.
* `e2e/aos-s4-official-version.spec.ts` — **PRD Scenario 4, steps 1–6**: page map, the one-tap move with preview, the
  automatic variant, review list, Study Book citation unchanged with a content alert, purge refused with a count.
* `e2e/aos-p1-vertical-slice.spec.ts` — the PRD §5.3 slice on a tablet viewport, with the device offline while writing.

**Blocked here:** the iPad offline-writing run on a real device (`[dev]` part of the slice) — recorded «Not run (no
device)»; everything else runs here.

**Reviewer focus:** official text changed under a pinned citation; a follower's personal item touched by any update;
stale ids after republish; space routes outside the allow-list; anything in a non-member's or other subject's response.

---

### 3.8 Companion work beside Phase 1

**C-PAR — parity tracks N1–N5.** The depth of the personal notes engine is planned in
`docs/research/NOTE_APP_FEATURE_PARITY.md` («Build plan», tracks N1–N5, gaps G01–G71) and mapped in PRD Appendix C. These
Phase 1 rows are delivered there, under that plan's own reviews; P1 tracks do not rebuild them. Their multi-user parts
(author, layer, access checks) come from P1-T2 and P1-T5.

**Covers:** 1.2, 1.3, 1.5, 1.7, 1.8, 1.11, 1.12, 1.18, 1.19, 1.20, 1.23, 1.27, 1.32, 1.33, 1.34, 1.35, 20.8, 20.9, 20.12

Notes: AOS-1.17's crop and rotate are N4 G16 (its access part is P1-T5); AOS-1.33 (infinite canvas) may move to Phase 5
as a `C` row with a recorded move.

**PL-0 — phone-only operation.** Round 7's «Cloud deploy from phone» task (Dockerfile, Render blueprint, R2 off-site
backups, Arabic guide). P1-T1 adds the multi-user parts (migration runbook, encrypted archives, the iPad dry run).

### 3.9 GATE-1 — Phase 1 exit gate

One agent runs the gate and one reviewer checks it; no product code. It runs every suite and e2e spec, the performance
gate against the previous release (AOS-23.2), X8, X9, AC-01a, AC-01b, Scenarios 2 and 4 and the minimal moderation flow;
updates PRD §6.2 costs with real numbers once deployed (AOS-23.4); collects every «Not run (reason)»; and writes the
Phase 1 report (AOS-23.1) for the owner's sign-off. Phase 1 is «complete» or «closed with blocked Musts» (PRD §5.2).

**Covers:** 23.1, 23.2, 23.4

---

## 4. Phase 2 — Community and search

**Exit:** Scenario 6; ranking and anti-manipulation tests; full moderation flow; X9 extended to publications and
discussions; performance gate including the NFR-OP2 load test; phase report. **Waves:** A = P2-T1, P2-T2, P2-T4, P2-T5;
B = P2-T3 (needs follows, ratings and discussion reports). The platform track P2-PL runs beside both waves (§8).

### P2-T1 — Profiles, follows and visibility

Profiles private by default, person follows (with subject scope and approval), public / followers / specific-user
visibility with the non-member redaction of ARCHITECTURE_DELTA §5.2, likes, saves, shares, series, the feed.
**Owns:** `modules/social/*`, system `2160_social.sql` (`follow`, `reaction`, `rating`; series reuse
`publication_series` from `2150`), `academic/social-api.ts`,
web `features/profile/*`, `features/feed/*`. **Tests:** visibility matrix incl. redaction (no `anchor.quote`, no
`source_crop` images for non-members), revocation on unfollow, `granted_keys` backfill, feed explains «لماذا»;
`e2e/aos-p2-profile-feed.spec.ts`.
**Covers:** 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 5.14, 5.15, 5.18, 5.19, 5.21, 5.23, 5.25, 5.26, 21.15

### P2-T2 — Contextual discussions, comments and suggestions

Anchored threads on pages, regions and drawings, cross-version jumps, threaded replies, accepted answers, votes, community
cards and bank questions, comments on publications, suggested corrections to explanations.
**Owns:** `modules/discussions/*`, space `3100_discussions.sql`, `academic/discussions-api.ts`, web
`features/discussions/*`, the rail section «النقاش». **Tests:** J11 e2e, cross-version anchor mapping, community answers
never become source keys (AC-13), discussion search filtered in SQL.
**Covers:** 2.7, 4.8, 4.9, 4.19, 5.16, 5.17, 5.20, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.10, 19I.1, 21.17, 21.25, 21.26

### P2-T3 — Marketplace ranking, anti-manipulation and full moderation (Wave B)

Sorts with «لماذا هذا الترتيب؟», the versioned ranking job (latest rating per user, author's tag excluded, evidence links
capped), ring detection to the moderation queue, approval before «عام», request changes, «راجعه مشرف المادة» (Subject
Moderators only), appeals, rights metadata at publish time, usage and quality statistics with minimum group sizes.
**Owns:** `modules/social/ranking/*`, `modules/moderation/*` (Phase 2 part), web `features/lectures/marketplace/*`,
`features/admin/moderation/*`. **Tests:** synthetic vote rings do not move ranks; re-rating replaces; statistics
suppressed below 5; full moderation e2e (J12).
**Covers:** 2.8, 5.27, 5.28, 5.29, 5.30, 5.31, 5.32, 5.33, 5.34, 5.35, 18.7, 18.8, 18.12, 18.15, 18.16, 19I.4, 21.28, 21.40

### P2-T4 — Search, slide-photo search, smart collections and dashboard

Permission-scoped universal search across handwriting readings, images, drawings, discussions and publications; image
and **slide-photo search** (the matcher reused in Phase 3); semantic search when a provider exists; smart collections;
the dashboard; moderator-published exam dates in use.
**Owns:** `modules/search/*` (Phase 2), `modules/learning/{collections,goals,studytime}*`, base `0361`, `0620`, `0621`,
web `features/search/*`, `features/home/*`, `features/planner/*` (exam dates). **Tests:** Scenario 6 (a)–(d) on generated
photos; `[eval]` top-1 precision on ≥ 30 owner hall photos when available.
**Covers:** 1.37, 3.15, 3.16, 3.17, 15.2, 15.3, 15.4, 15.6, 15.7, 15.9, 15.10, 15.11, 15.13, 15.14, 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 17.12, 17.13, 17.14, 17.15, 17.16, 17.17, S6.1, S6.2, S6.3

### P2-T5 — Copies in depth, history views, the AI pen and editor objects

Merge layers and kind filters, compare copies, the time machine and restore-as-new-state, per-change accept of followed
updates, the AI pen menu of IA §4.16, the command palette, drag and drop, equations (the newer spec overrides the parity
study's math exclusion).
**Owns:** `modules/annotations/{merge,timemachine}*`, `modules/studybook/*` (pen actions), web
`features/workspace/history/*`, `features/workspace/compare/*`, `features/workspace/aipen/*`, `features/palette/*`,
`ink/kinds/equation*` (through the kinds seam). **Tests:** time machine rebuild equals a recorded snapshot; restore writes
a new state; every pen action disabled with its reason without a key; equations round-trip through export and search.
**Covers:** 1.21, 1.25, 4.11, 4.12, 4.13, 4.14, 4.15, 4.16, 10.1, 10.2, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.14, 10.15, 10.16, 10.17, 10.18, 10.19, 10.21, 10.22, 10.23, 20.7, 20.11

### P2-PL — iPad shell, native ink and the App Store (platform track, §8)

**Covers:** OC.1, OC.2, OC.3, OC.9

---

## 5. Phase 3 — Live lecture (3a without ASR, 3b with ASR)

**Exit 3a:** Scenario 5; Scenario 1 variant A; X11 scripted part. **Exit 3b:** X10 meets the owner-confirmed floors per
stratum; Scenario 1 variant B. 3b can run beside Phase 4. **Waves:** A = P3-T1, P3-T4 (3a part); B = P3-T2, P3-T3;
P3-T4's 3b part starts when the owner's evaluation set exists.

### P3-T1 — Recording sessions, resumable upload, consent and shared recordings

Recording tied to lecture version and pages, chunked resumable upload, lecturer recording policy per subject and the
recorder's attestation per share, shared official recordings copied into the space, listen-only scope, VAD and silence
intervals, skip silence, speed, battery and storage savers, voice notes on selections.
**Owns:** `modules/media/{recordings,consent,intervals}*`, base `0681_recording_share.sql`, web
`features/workspace/audio/*`, `features/media/*`. **Tests:** Scenario 1 steps 1–6 with the fake microphone; a 200 MB
upload cut at 50 % resumes (X6); share refused without the policy (`CONSENT_REQUIRED`).
**Covers:** 1.22, 2.6, 6.9, 7.1, 7.13, 7.14, 7.15, 7.16, 7.18, 7.19, 9.16, 9.19, 10.20, 10.24, 10.25, 11.22, 19L.6, 19L.7, 20.13, 21.21, 21.22, 21.39, 21.41, S1.1, S1.6

### P3-T2 — Timeline, replay and audio–page linking

One clock in original time, the page-view log, time links for every item kind, the timeline read model, replay with
speed and hide toggles, snapshots with `source_crop`, transcripts as low-confidence evidence, transcript search.
**Owns:** `modules/timeline/*`, base `0870_timeline_event.sql`, `0273_annotation_audio_index.sql`, `0162_region_text_origin_ext.sql`,
web `features/timeline/*`. **Tests:** X11 (offsets ±250 ms; page-at-time ≥ 95 % on the scripted session); replay draws
progressively driven by the audio clock.
**Covers:** 7.20, 7.21, 7.22, 7.23, 7.24, 7.25, 7.27, 7.28, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10, 13.11, 13.12, 14.16, 15.5, 19A.1, 19A.3, 21.23, S1.5

### P3-T3 — Exam Radar, calm copilot, chapters and Exam Mode

The deterministic phrase detector (MSA, Iraqi, English), exam highlights with honest wording, the radar dashboard, the
copilot side panel with budget, translation and card suggestions under the external-processing policy, chapters, the
slide matcher of Phase 2 on lecture photos, Exam Mode (Scenario 5).
**Owns:** `modules/copilot/*`, base `0880_exam_highlight.sql`, `0881_copilot_session.sql`, web `features/copilot/*`,
`features/planner/exam-mode/*`. **Tests:** radar precision / recall on labelled VTT fixtures; wording test (no certainty or
probability phrases); fault injection never stops recording or writing; Scenario 5 end to end.
**Covers:** 7.17, 7.26, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13, 8.14, 8.15, 8.16, 8.17, 8.18, 8.19, 9.1, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 9.14, 9.15, 14.17, 17.4, 17.11, 19A.2, 19K.1, 19K.2, 19K.3, 21.24, S1.3, S5.1, S5.2, S5.3, S5.4, S5.5, S5.6

### P3-T4 — Speech orchestrator, evaluation flow and the ASR worker (3a then 3b)

3a: the `SpeechProvider` interface with a fake engine, transcription runs that never overwrite corrections, the
in-app evaluation flow (samples, evaluation-only runs, the correction screen, the harness as a server job — ADR-0006
§2.10), CPU-minute quotas. 3b: whisper.cpp / sherpa-onnx adapters on a separate worker reading audio from R2, streaming,
vocabulary biasing, code-switch tags, diarization where supported, shared transcripts, the load test of the worker.
**Owns:** `modules/media/speech/*`, `apps/asr-worker/*` (new service), base `0680_asr.sql`, web
`features/platform/evaluation/*`, `features/media/transcribe/*`. **Tests:** harness self-test values pinned; re-runs keep
corrections; an engine below a floor is never enabled; OC.10 e2e with the fake engine.
**Covers:** 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 9.2, 9.18, 15.12, 21.49, 21.50, S1.2, S1.4, OC.10

### P3-PL — Android app, recorder plugin, Google Play (platform track, §8)

**Covers:** OC.4, OC.9

---

## 6. Phase 4 — Nearby, rooms, collaboration

**Exit:** Scenario 3 (Chromium contexts here; device matrix recorded); X3–X7. **Waves:** A = P4-T1; B = P4-T2, P4-T3
(both use the realtime gateway and validated CRDT layers).

### P4-T1 — Realtime gateway and validated collaborative layers

WebSocket `/live` with per-role frame limits, Yjs collaborative layers with server-side validation, clientID binding,
quarantine, projection, compaction, per-user undo, restore-to-T, version vectors, content hashing.
**Owns:** `modules/collab/*`, space `3150_collab.sql`, web `lib/collab/*`. **Tests:** 3-peer property test with a fixed
seed; forged `created_by` and foreign clientIDs quarantined; merge ≤ 50 ms on the 5,000-stroke page (NFR-P4).
**Covers:** 4.4, 11.18, 11.19, 11.20

### P4-T2 — Study rooms (online first)

Silent, group, teaching and exam rooms over the server: presence, Pomodoro, follow-the-host, writing rights, raise hand,
consented room recordings, replay of sessions, exam rooms with aggregates only at ≥ 10 participants and the viewer
excluded; online voice not designed until Q30.
**Owns:** `modules/rooms/*`, space `3200_rooms.sql`, web `features/rooms/*`. **Tests:** exam room solutions hidden until
the end (AC-19); aggregates suppressed below 10; consent before recording.
**Covers:** 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13, 12.14, 12.15, 12.16, 12.17, 12.18, 12.19, 12.20, 12.21, 21.19, 21.20

### P4-T3 — Offline nearby rooms and peer transfer

Per-joiner QR pairing with server-signed offline credentials, the room key over DTLS, signed relay bundles keyed by
(user, server-issued device id, sequence), credential-based authorization, chunked resumable peer transfer, quarantine of
peer files until the server checks them, store-and-forward simulation, the LAN hub only if trials need it.
**Owns:** `modules/nearby/*`, web `lib/nearby/*`, `features/rooms/nearby/*`. **Tests:** Scenario 3 in three Chromium
contexts with the server blocked; a backdated bundle from a removed member rejected; a photographed QR gives no access.
**Covers:** 11.1, 11.4, 11.6, 11.7, 11.9, 11.10, 11.11, 11.12, 11.13, 11.14, 11.15, 11.16, 11.17, 11.21, 11.23, 11.24, 11.25, 11.26, 11.27, 11.28

### P4-PL — Native nearby transports (platform track, §8)

**Covers:** 11.2, 11.3, 11.5, 11.8

---

## 7. Phase 5 — Tutor and innovations

**Exit:** per-item acceptance; AI items evaluated with a real key before any quality statement. Tracks run in one wave.

### P5-T1 — Private tutor and adaptive learning

**Covers:** 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.12, 14.13, 14.14, 19E.1, 19E.2, 19G.1, 19G.2

### P5-T2 — Cross-course knowledge graph

**Covers:** 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11

### P5-T3 — Lecture Fusion, crowd notes, professor vs reference, catch-up

**Covers:** 19A.4, 19B.1, 19B.2, 19C.1, 19C.2, 19C.3, 19D.1, 19D.2, 19F.1, 19F.2, 19F.3, 19F.4, 19F.5, 19F.6, 19F.7

### P5-T4 — Voice and on-device models

**Covers:** 9.17, 10.3, 10.12, 10.13, 19L.1

---

## 8. Platform track (native apps) across phases

Timing is PRD §5.3 (one statement): skeleton in Phase 1 (P1-T2), the signed iPad shell and native ink right after
Phase 1 in parallel with Phase 2 (P2-PL), Android with Phase 3 (P3-PL), native nearby with Phase 4 (P4-PL). Every
platform step runs in cloud CI (macOS runner for iOS) and on devices, never in this container; each step's results go
into the phase report. Decision points: D-A Apple account by 2026-12-15, D-G Google account by 2027-02-15.

| step | content | acceptance | blocked here |
|---|---|---|---|
| PL-1 | Capacitor shell for iPadOS loading the same web build; sync, outbox and capabilities unchanged; TestFlight install from the GitHub web UI (OC.1 Phase 2 part, OC.2) | install recorded from an iPad; the web suites still pass | macOS runner, Apple account, iPad |
| PL-2 | PencilKit / Metal ink surface writing `InkPoint` strokes into the same outbox (OC.3) | geometry test: native and web strokes at the same normalised coordinates; NFR-P1 latency with ≥ 240 fps video | iPad + Pencil |
| PL-3 | One Android app: S Pen front-buffered rendering with prediction, BOOX pen SDK (OC.4) | same geometry test; latency per device; e-ink check | Samsung + S Pen, BOOX, Google account |
| PL-4 | Background recording plugin; native nearby transports (11.2, 11.3, 11.5, 11.8) | interop matrix from device runs | devices |
| PL-5 | App Store (end of the Phase 2 window), Google Play (Phase 3) (OC.9) | store review passed; privacy labels; accessibility statement | accounts, store review |

## 9. What stays blocked in this container

| needs | rows (examples) | until then |
|---|---|---|
| real devices (iPad + Pencil, Samsung + S Pen, BOOX, phones) | NFR-P1 latency, 1.2, OC.3–OC.6 `[dev]`, 11.8, X2, X4 | «Not run (no device)»; Chromium runs and CI harness numbers only |
| macOS runner, Apple / Google accounts, store review | OC.1 (build part), OC.2, OC.3, OC.4, OC.9 | decision points D-A and D-G (PRD §5.3) |
| Render and R2 accounts | OC.1 (deploy part), OC.7 dry run | local S3-compatible fake; PL-0 runbook |
| a speech engine and the owner's recordings with references | 7.2–7.12, 9.2, S1.2, S1.4, 21.50, X10 | Phase 3a with a fake engine; 3b blocked until the floors are met |
| an AI key | AI parts of §10, §14, §19, copilot answers | fake providers; capability «غير مُعدّ» |
| owner hall photos | 15.10, S6 `[eval]` precision | generated photos only |
| real classroom Wi-Fi | 11.1, 11.4, Scenario 3 on devices | Chromium contexts on one host |

---

## Appendix A — Coverage checker

Stdlib Python, no dependencies. It reads PRD §7 and this plan's «Covers» lines, expands ranges in PRD row order, and
checks: (1) every PRD row is covered in every phase its `Ph` names; (2) every covered id exists; (3) no track covers a row
outside its phase; (4) no id is listed twice in one phase except for rows deliberately shared (their criterion has two
owners: AOS-21.44 — P1-T1 and P1-T5). It also regenerates PRD §10 (`--write`).

```python
#!/usr/bin/env python3
"""Check that BUILD_PLAN.md covers every PRD §7 row in the phase(s) its Ph column names."""
import re, sys, collections
PRD, PLAN = 'docs/academic-os/PRD.md', 'docs/academic-os/BUILD_PLAN.md'
ROW = re.compile(r'^\| (AOS-[0-9A-Za-z.]+) \|')
rows = []                                     # (id, phases)
for line in open(PRD, encoding='utf-8'):
    if ROW.match(line):
        cells = re.split(r'(?<!\\) \| ', line.rstrip('\n')[2:-2])
        rows.append((cells[0][4:], cells[2].split('/')))
order = [r[0] for r in rows]
phase_of = dict(rows)
def expand(token):
    token = token.strip()
    if not token: return []
    if '–' in token:                          # range a–b in PRD order (en dash)
        a, b = [t.strip() for t in token.split('–')]
        return order[order.index(a): order.index(b) + 1]
    return [token]
cover = collections.defaultdict(list)         # id -> [(track, phase)]
track = None
for line in open(PLAN, encoding='utf-8'):
    m = re.match(r'^#{3} (?:[\d.]+ )?(P(\d)-[A-Z0-9]+|GATE-(\d))', line) or re.match(r'^\*\*(C-PAR)\b', line)
    if m:
        name = m.group(1)
        track = (name, '1' if name in ('C-PAR',) else (m.group(2) or m.group(3) or '1'))
    if line.startswith('**Covers:**') and track:
        ids = [i for t in line[len('**Covers:**'):].split(',') for i in expand(t)]
        for i in ids: cover[i].append(track)
problems = []
for rid, phases in rows:
    got = {p for _, p in cover.get(rid, [])}
    for p in phases:
        if p not in got: problems.append(f'AOS-{rid}: phase {p} not covered')
for rid, owners in cover.items():
    if rid not in phase_of: problems.append(f'AOS-{rid}: listed but not a PRD row'); continue
    for t, p in owners:
        if p not in phase_of[rid]: problems.append(f'AOS-{rid}: {t} is phase {p}, PRD says {"/".join(phase_of[rid])}')
    dup = [p for p, n in collections.Counter(p for _, p in owners).items() if n > 1]
    if dup and rid not in ('21.44',): problems.append(f'AOS-{rid}: listed twice in phase {dup}')
print(f'{len(rows)} PRD rows, {len(cover)} covered ids')
print('\n'.join(problems) if problems else 'OK — every row is built in the phase(s) the PRD names')
sys.exit(1 if problems else 0)
```

**Result on 2026-10-20** (run from the repository root against PRD v2 and this plan): `516 PRD rows, 516 covered ids` —
`OK — every row is built in the phase(s) the PRD names`. ARCHITECTURE_DELTA §16 no longer carries its own phase list;
it points to PRD §5 and summarises this plan, so the old disagreements (Scenario 2, notifications, history, the slide
matcher, «Phase 0») cannot recur.

## Appendix B — Ownership index: shared contracts and migrations

| file | phase · track |
|---|---|
| `packages/shared/src/academic/index.ts`, `visibility.ts`, `accounts-api.ts`, `platform-api.ts`; step-0 appends to `errors.ts`, `features.ts`, `index.ts`, `api.ts` | P1-T1 |
| `packages/shared/src/annotations.ts` (layer, ink v2), `academic/layers.ts`, `academic/ink-codec.ts` | P1-T2 |
| `academic/versions.ts` | P1-T3 |
| `academic/channels-api.ts`, `notifications-api.ts`, `moderation-api.ts`; Wave 2 appends to `errors.ts`, `features.ts` | P1-T4 |
| `academic/lectures-api.ts`, `copies-api.ts`, `publications-api.ts` | P1-T5 |
| `academic/social-api.ts` · `discussions-api.ts` · `search` additions · AI pen types | P2-T1 · P2-T2 · P2-T4 · P2-T5 |
| `academic/timeline-api.ts` · `copilot-api.ts` · `media-api.ts` additions | P3-T2 · P3-T3 · P3-T1 / P3-T4 |
| `academic/collab.ts` · `rooms-api.ts` · `nearby.ts` | P4-T1 · P4-T2 · P4-T3 |
| base `0041`, `0050` · system `2000`, `2010`, `2040`, `2250`, `2300` | P1-T1 |
| base `0271`, `0272`, `0274` (note-migration bookkeeping, step 3), `0861` | P1-T2 |
| base `0160`, `0161`, `0164` (DOCX display rendition) | P1-T3 |
| base `0751` (off-site backup runs) | PL-0 (companion work, §3.8) |
| system `2050`, `2100`, `2200`, `2310` | P1-T4 |
| base `0163`, `0860` · system `2060`, `2150` · space `3000`, `3010`, `3050`, `3300` | P1-T5 |
| system `2160` · space `3100` · base `0361`, `0620`, `0621` | P2-T1 · P2-T2 · P2-T4 |
| base `0681` · `0162`, `0273`, `0870` · `0880`, `0881` · `0680` | P3-T1 · P3-T2 · P3-T3 · P3-T4 |
| space `3150` · `3200` | P4-T1 · P4-T2 |
