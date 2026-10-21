# Academic OS on MedLevo — Product Requirements Document

| document | what it decides | authority |
|---|---|---|
| **[BUILD_PLAN.md](BUILD_PLAN.md)** | how each phase of §5 is built: tracks for one builder and one reviewer, owned files and migrations, acceptance tests, what stays blocked, dependencies; Appendix A holds the script that checks every §7 row is built in its phase | *who builds what, in which order* |
| this PRD | requirements, phases (§5 is the **only** phase table), exit gating, acceptance scenarios, owner questions (§11 is the **only** numbered list) | *what, and when* |
| [ARCHITECTURE_DELTA.md](ARCHITECTURE_DELTA.md) | data model, permissions, API, sync v2, operational split per user / platform admin (§5.8); **Review log** of the design review at its end | *how* |
| [IA_AND_JOURNEYS.md](IA_AND_JOURNEYS.md) | navigation, screens, journeys, states, design-system additions | *how it looks and reads* |
| [ADR-0003](../adr/0003-multi-user-academic-platform.md) | multi-user platform: system DB + one vault per user + **one space per subject**; journaled owner migration | decision record |
| [ADR-0004](../adr/0004-collaboration-and-sync.md) | layers, op-log + validated Yjs, stable followed-copy ids, version vectors, resumable transfer | decision record |
| [ADR-0005](../adr/0005-nearby-and-platform.md) | online and nearby rooms, signed offline credentials, native shell timing (iPad right after Phase 1) | decision record |
| [ADR-0006](../adr/0006-speech-recognition.md) | speech orchestrator, evaluation operable from an iPad, absolute quality floors, shared transcripts, ASR capacity | decision record |

> **Status:** draft v2 for owner review · 2026-10-20 · revised after the adversarial design review (every finding and its
> outcome is in the Review log at the end of `ARCHITECTURE_DELTA.md`).
> **Specification:** [`docs/spec/Academic_OS_Master_Prompt_AR.md`](../spec/Academic_OS_Master_Prompt_AR.md) (§1–§23 and the owner
> clarifications at its top). Where it conflicts with the original spec
> [`docs/spec/MedLevo_AI_Master_Prompt_AR.txt`](../spec/MedLevo_AI_Master_Prompt_AR.txt) or with
> [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md), the newer spec wins (§3.2 below lists every superseded rule).
> **Baseline:** the MedLevo repository at the Round 7 snapshot (commit `d7c9efa`, ~2,030 passing tests).
> **Companion documents:** [`IA_AND_JOURNEYS.md`](IA_AND_JOURNEYS.md) (navigation, screens, journeys, states, design-system
> additions) and [`ARCHITECTURE_DELTA.md`](ARCHITECTURE_DELTA.md) (system architecture, data model, permissions, API
> contracts), with the decisions recorded in
> [ADR-0003](../adr/0003-multi-user-academic-platform.md) (multi-user platform, «Vault + Spaces + System»),
> [ADR-0004](../adr/0004-collaboration-and-sync.md) (collaboration and sync),
> [ADR-0005](../adr/0005-nearby-and-platform.md) (nearby rooms and client platform) and
> [ADR-0006](../adr/0006-speech-recognition.md) (speech recognition). This PRD says *what* must be true and how it is
> accepted; where it names a mechanism, it follows those records and the measurements in Appendix B. Personal-notes depth
> is planned in
> [`docs/research/NOTE_APP_FEATURE_PARITY.md`](../research/NOTE_APP_FEATURE_PARITY.md) (gaps G01–G71); Appendix C maps them.
> **Clean-room:** every feature here is designed from the owner's spec and public information only. No other app's binary,
> code, text, UI layout, template or asset is used, and no reverse-engineering tool is run on a third-party app.

## Contents

1. [Purpose, scope and how to read](#1-purpose-scope-and-how-to-read)
2. [Vision](#2-vision)
3. [Principles](#3-principles) — kept · superseded · new
4. [Personas and roles](#4-personas-and-roles)
5. [Release plan (spec §23 phases)](#5-release-plan-spec-23-phases)
6. [Non-functional requirements](#6-non-functional-requirements)
7. [Requirements table](#7-requirements-table) — every gap-analysis item, the owner clarifications and the review additions (§7.24)
8. [End-to-end acceptance scenarios (spec §22)](#8-end-to-end-acceptance-scenarios-spec-22)
9. [Additional acceptance tests (§22 «اختبر أيضاً»)](#9-additional-acceptance-tests-22-اختبر-أيضاً)
10. [Coverage check](#10-coverage-check)
11. [Owner questions and assumed defaults](#11-owner-questions-and-assumed-defaults)
- [Appendix A — Glossary and Arabic UI terms](#appendix-a--glossary-and-arabic-ui-terms)
- [Appendix B — Measured basis for the decisions this PRD relies on](#appendix-b--measured-basis-for-the-decisions-this-prd-relies-on)
- [Appendix C — Cross-reference to the note-app parity gaps](#appendix-c--cross-reference-to-the-note-app-parity-gaps)
- [Appendix D — Baseline evidence and how to re-check it](#appendix-d--baseline-evidence-and-how-to-re-check-it)

---

## 1. Purpose, scope and how to read

The owner's second specification turns MedLevo — a single-owner, Arabic-first, book-first, source-grounded medical study
platform — into a multi-user **Academic Operating System**: university channels, official lectures, personal copies with
layers, published student explanations, discussions, live lecture recording with mixed Iraqi-Arabic/English speech
recognition, an Exam Radar, a live copilot, replay, offline classroom rooms, study rooms, an AI tutor, multimodal search,
a knowledge graph, a dashboard and channel administration.

Spec §23 sets the method: inspect the repository first, **preserve existing features and data**, and do not rebuild
randomly. This PRD therefore starts from what MedLevo already does and states, item by item, what remains.

**Where the items come from.** A gap analysis split spec §1–§22 into **495 requirement items** (`AOS-<section>.<n>`;
§19 sub-features as `AOS-19A.1` …; scenario items as `AOS-S1.1` …) and checked each one against the code. At the baseline:

| status | items | meaning |
|---|---|---|
| **have** | 77 | works today **for MedLevo's one owner** (it still needs the multi-user constraint in its acceptance criterion) |
| **partial** | 210 | part exists; the gap is named |
| **missing** | 175 | nothing usable exists |
| **conflict** | 33 | contradicts an old rule (mostly ARCHITECTURE rule 8 «single owner») and needs the ADR in §3.2 |

This PRD adds **10 items** from the owner clarifications that the gap analysis did not itemise (`AOS-OC.1`–`OC.10`:
phone-only operation, native shell, native iPad and Android ink surfaces, e-ink mode, device-honest capabilities, hosting,
latency as a first-class requirement, store publication, and an ASR evaluation the owner can run from an iPad), and
**11 items** from the design review (§7.24: spec §23's own instructions `AOS-23.1`–`23.5`, the §21 technology-evaluation
demands `AOS-21.47`–`21.50`, and linking existing private lectures to official ones `AOS-19H.3`–`19H.4`). Every item
appears in §7 exactly once; §10 proves it. Nothing is dropped: anything deferred names its phase and why, and anything
blocked names what unblocks it.

**About the baseline statuses.** The gap analysis was a working file of the design workflow and is not committed. Its
per-item status is reproduced in the `Now` column, which is therefore a **claim to be re-checked**, not evidence. Two rules
make it checkable: Appendix D maps every §7 section to the `docs/REQUIREMENTS_MATRIX.md` part-A rows that already cite
files and tests, and every build track starts by re-verifying the `Now` status of each row it owns and recording the file
and test evidence in the matrix's new AOS part (BUILD_PLAN §2, definition of done item 1). A row whose re-check disagrees
is corrected in the same change. The ID/status/phase check script is in BUILD_PLAN Appendix A.

**What a requirement row contains:** the requirement, its phase (§5), priority, the baseline status, an **acceptance
criterion** that can be checked by a test or a recorded device run, and whether it can be tested in this Linux + headless
Chromium container (if not, the blocker).

**Out of this document:** schema DDL, API shapes, the sync wire protocol and component code.

## 2. Vision

> «بيئة دراسية موحدة»: a student attends a lecture, records the lecturer, writes with the pen, understands the explanation,
> extracts the questions, shares notes, follows classmates and prepares for the exam — in one connected place, private by
> default, working as well as possible without internet.

The **official lecture file stays the primary source.** Everything else is a clearly labelled layer on top of it: the
student's own ink and notes, classmates' published explanations, discussions, recordings and transcripts, and AI output.
MedLevo's strengths carry over unchanged in meaning: evidence-checked AI under Source Lock, honest capabilities, local-first
writing that never loses a stroke, and Arabic-first RTL with correct English terms.

**Product pillars** (spec sections in brackets):

| # | pillar | what the student gets | builds on in MedLevo |
|---|---|---|---|
| 1 | Writing engine [§1, §20, owner clarifications 2 and 4] | fast, smooth pen writing on lectures and notebooks; native ink on iPad, Samsung S Pen and BOOX | ink engine (`features/workspace/ink`), note pages, split view |
| 2 | Channels and official content [§2, §3, §18] | the university's subjects and lectures, kept up to date, joined with a code | library, sources, versions, processing pipeline |
| 3 | Copies and layers [§4] | «ابدأ الدراسة» on any lecture; follow or fork a classmate's explanation without ever losing own notes | immutable source versions + overlay annotations + content-addressed files |
| 4 | Community [§5, §6, §19C, §19I] | explanations, profiles, follows, ratings, contextual Q&A, corrections — honestly ranked | evidence/provenance chain, review queue, corrections pattern |
| 5 | Live lecture [§7, §8, §9, §13, §19A, §19K] | record with writing, transcript, timeline, Exam Radar, calm copilot, replay | in-app recorder with stroke time links, transcripts, media links |
| 6 | Offline classroom and rooms [§11, §12] | share a lecture and a layer in the hall without internet; silent, group, teaching and exam rooms | outbox sync, offline packages with hashes, exams engine |
| 7 | Learning intelligence [§10, §14–§17, §19B/D/E/F/G] | AI pen, private tutor, multimodal search, knowledge graph, dashboard, exam mode, catch-up | Study Book, explain/chat, questions, FSRS, weakness, planner, Course Brain, search |
| 8 | Trust and platform [§18, §21] | permissions, moderation, audit, privacy, quotas, export and deletion | auth, audit, capability registry, backup/restore |

## 3. Principles

### 3.1 Kept from MedLevo — still binding, restated for many users

| # | rule (ARCHITECTURE §0 and §4) | what it means in the Academic OS |
|---|---|---|
| K1 | **No evidence → no unsupported medical claim.** | Applies to every new generator: copilot, Exam Radar answers, Lecture Fusion, catch-up, tutor, AI pen. Student explanations, discussion answers and lecturer speech are **not evidence** by default. A transcript can become evidence only as a versioned, low-confidence source (`needs_review`, like OCR-only evidence under the H1-3 rule). |
| K2 | **Citations are rows**, never free text. | Human attribution (author, publication version, fork lineage) is added as rows too; attribution is never confused with evidence. |
| K3 | **Original stays original; generated stays visibly generated.** | The origin set grows: رسمي (official lecture) · مرجع (an uploaded reference source — a book or article the user or the subject chose; spec §14's «مرجع خارجي», never shown as رسمي) · شرح طالب (student contribution) · راجعه مشرف المادة (reviewed by the subject's moderator — names the role and date, never "verified") · مولّد آليًا (machine-generated) · ملاحظاتي (my notes) · قال الدكتور في التسجيل (lecturer said, from a recording). |
| K4 | **Source Lock is server-side**, including cache keys. | Scope resolution and the AI artifact cache key gain a **user and visibility dimension**: an artifact built with someone's private notes is never served to anyone else. |
| K5 | **Abstain with a specific reason.** | New cases: «لم يذكر الدكتور الإجابة», «لا تطابق ضمن مصادرك», «الصورة غير مقروءة». |
| K6 | **Never lose a user's writing or attempts.** | Now per user and across users: no shared update, moderation action, purge or collaborative merge may modify or delete another user's personal layer; at most it marks it «يحتاج إعادة تثبيت». |
| K7 | **Honesty** (no fake %, no "AI Verified", capability registry, no demo data). | Also: P2P transports are never assumed; ASR accuracy is never claimed from a vendor's locale list; ranking counts are real; device capabilities are what the device reported. |
| K8 | **Arabic-first RTL** with isolated English runs, no invisible bidi characters stored (ARCHITECTURE §4, design-system §3). | Every new editor (discussions, profile, publication titles, comments, room chat) follows it; AC-20 extends to them. |
| K9 | **Local-first**: writing never waits for the network; idempotent outbox. | Per user: one local database per signed-in user; a device never pushes one user's outbox under another user's session. |
| K10 | **AI is optional**; deterministic features work without a key. | Unchanged; plus spec §23 «لا تسمح لفشل AI بتعطيل الكتابة أو التسجيل». |
| K11 | **Clean-room** (spec header). | Unchanged. |

### 3.2 Superseded rules — and why

The newer spec wins where it conflicts (its header and §23). Each change below is recorded by an ADR (ADR-0003…0006) before
code changes, and the tests that guarded the old rule are **replaced, not deleted**.

| old rule | source | replaced by | why | guard tests |
|---|---|---|---|---|
| **Rule 8 «Single owner. No organizations, roles, cohorts, subscriptions, multi-tenancy, public sharing.»** | ARCHITECTURE §0 | **«Private by default; shared only by an explicit publish into a scoped space; roles are scoped to channel nodes.»** | §2, §4, §5, §6, §11, §12, §18 and §21 require users, channels, roles and sharing. | `g1-ac01.test.ts` and `e2e/g1-ac01-personal-library.spec.ts` (forbidden vocabulary, exactly four navigation labels) split into **AC-01a «the personal library works for a user with no channel»** (their personal-library assertions stay) and **AC-01b «private by default / no cross-user leakage»**; the vocabulary bans and the four-label assertion are retired with the five-destination navigation (IA §3.1). |
| Old spec §02 bans: universities/colleges/classes, Student/Instructor/Admin roles, invitations, «Subscribe», content market («سوق للمحتوى»), admin panel (replaced by the Personal Control Center), rights-management system | MedLevo spec §02 | Channel tree (§2), roles (§18), class codes / QR / invite links (§2), course follow (§2), Lecture Marketplace = a per-lecture listing (§5), channel administration area (§18), access policy + rights metadata (§18) | Same. | Same AC-01b; `/admin` probes change from "404 for everyone" to "403/404 without a role". |
| — kept from §02 | | **No payments, no paid tiers, no selling content** (assumed default — owner question Q1). "Subscribe to Course" means following a subject, not billing. The **Personal Control Center stays**, per user; channel administration is a separate area. | The newer spec asks for neither payments nor removal of the Control Center. | — |
| Files «never public» | ARCHITECTURE §1, §3.2; old spec §49 | **No permanent public file URLs.** Every file read passes an access check bound to the viewer; download tokens bind user + resource + scope + expiry. | Sharing needs controlled reads; the intent (no leakable URLs) is kept. | `g8-security` file tests extended with cross-user cases. |
| «Every `/api` route requires the owner session» | ARCHITECTURE §3.1 | Per-user sessions and **one central authorization policy** used by routes, sync pull, search, export, offline packages, files and AI scope resolution. The public-route list changes only through an ADR with the exact list asserted by `g8-security.test.ts`. | Multi-user. | `g8-security.test.ts` public-route assertion updated in the same change. |
| «SQLite because single owner → embedded DB» | ARCHITECTURE §1 | **Vault + Spaces + System on SQLite** (Appendix B): one personal vault per user with today's schema, **one space per subject** for official and shared content (so subjects and universities are isolated by file, ADR-0003 §3.1), one small system database for identities, roles, the publication index and quotas. | Measured: private data isolated by construction, existing modules and tests reused. | Existing suites run inside one bound vault through a test-binding helper; every test that needs more than the helper is listed with its reason in the Phase 1 report (ADR-0003 §3.10). |
| Merge rules assume one author on several devices | ARCHITECTURE §3.4 | Single-writer layers keep the op-log rules; **multi-writer layers use a CRDT** (Yjs). | Keep-both conflict copies would flood shared documents. | New 3-peer convergence tests. |
| Whole-server backup/restore as the only restore path | ARCHITECTURE §1; `data/restore.ts` | Per-vault and per-space backup/export/restore; the whole-server restore stays an operator action. | A whole-server restore revokes every user's session and resets every device's epoch. | AC-30 extended per vault. |

### 3.3 New principles

| # | principle | consequence |
|---|---|---|
| N1 | **Private by default.** | Every new file, source, layer, note, recording and publication starts private. |
| N2 | **Publish = immutable snapshot copy**, with attribution and a version number. | Followers and forks read published snapshots, never live private data. |
| N3 | **Personal layers are sacred.** | See K6. Purging an official lecture that still has personal layers on it is refused, or the layers are detached and kept. |
| N4 | **Student content is never evidence by default.** | Low assurance, labelled, included in AI scope only when the user explicitly picks it. |
| N5 | **AI is additive, never a single point of failure.** | A missing key, provider error or exhausted quota never blocks writing, recording, sync or reading (fault-injection tests). |
| N6 | **Device honesty.** | Capabilities are detected per device and shown; nearby transports are never assumed; native-only features are labelled. |
| N7 | **Consent before distribution.** | Recordings, room presence, progress sharing and peer transfers need explicit, recorded consent. |
| N8 | **Phone-only operability for the owner.** | Deploy, backup, restore-verify, app builds and test installs work from a phone/tablet browser and cloud services (owner clarification 1). |
| N9 | **Performance is a requirement.** | Ink latency and smoothness have budgets measured on real devices before any claim (owner clarification 2). |
| N10 | **Preserve, don't rebuild.** | A vault is today's database; a space uses the same schema; existing screens are extended, not duplicated. |
| N11 | **Fair cost.** | Per-user and per-space quotas for storage, AI and ASR; nothing is presented as free or unlimited. |

## 4. Personas and roles

### 4.1 Personas

| persona | who | devices and context | needs most | spec |
|---|---|---|---|---|
| **زينب — the student** | 3rd-stage medical student in Baghdad | iPad + Apple Pencil in lectures, phone on the bus; patchy hall Wi-Fi; limited data | record + write in lectures, never lose notes, study offline, follow a good explanation, exam plans | §1, §4, §7, §11, §17 |
| **حسن — the explainer / publisher** | top student who explains lectures well | Samsung tablet + S Pen | publish explanations per lecture, keep them updated, get credit and followers, receive corrections | §4, §5, §10.25 |
| **د. سارة — subject moderator** | lecturer or teaching assistant responsible for a subject | phone and laptop | upload official lectures and new versions, approve contributors' files, moderate explanations and discussions, publish exam dates | §2, §18 |
| **مصطفى — channel assistant** | college office staff or student representative | phone | create join codes, approve join requests, handle reports (hide, restore, request changes — never «راجعه مشرف المادة», which only a Subject Moderator gives) | §2, §18 |
| **Channel admin** | college/university channel administrator | browser | manage the tree, assign roles, read the audit log and usage within scope | §18 |
| **The owner (platform operator)** | the person who owns MedLevo today — becomes **user #1** with the platform-admin role | phone/tablet only, no computer | deploy, back up, set quotas and AI keys, create universities; keep every existing note and attempt | owner clarifications 1, 5 |
| **The lecturer as speaker** | may not be a user | — | consent before recordings are shared; their words are labelled «قال الدكتور في التسجيل», never mixed with AI | §7, §21 |
| **E-ink reader** | any student on a BOOX tablet | e-ink, slow refresh | e-ink mode: no motion, high contrast, paging | owner clarification 4 |

### 4.2 Roles and scopes

Roles are **assigned on a channel node and inherited down the tree** (University → … → Subject). A user can hold different
roles in different subjects. "Explainer" is not a role: any member allowed to publish in a subject can publish.

| role | Arabic UI | scope | main powers |
|---|---|---|---|
| Platform admin | مدير المنصة | whole deployment | create universities, appoint channel Admins, set quotas; the **platform operations** that act on the whole deployment (AI provider, models and deployment budget, ASR engines and evaluation runs, health, client errors, global processing queue, whole-instance backup, restore, download and export — ARCHITECTURE_DELTA §5.8); **no product route reads any vault**. The person who runs the server can still reach files on the host and the backups (stated on the privacy page, NFR-S3) |
| Admin | مدير القناة | a node and its subtree | the tree, codes and invitations, join approvals, roles below Admin, scoped audit and statistics, plus every moderator power of the subjects below it except «راجعه مشرف المادة» (only with a Subject Moderator role there) |
| Assistant | مساعد | a node and its subtree | join approvals, codes and invitations, moderation of publications, discussions and reports (hide, restore, request changes); no «راجعه مشرف المادة» mark, no node edits, no role assignment, no official uploads |
| Subject Moderator | مشرف المادة | a subject | upload, approve and publish official lectures and versions, correct and withdraw them (a correction of a published version creates a new version), review page maps, moderate explanations/discussions/reports, accept answers, «راجعه مشرف المادة» marks, exam dates, attachments, course-wide rooms and collaborative copies, duplicate review, the subject's lecturer recording policy (AOS-21.39) |
| Contributor | مساهم | a subject | upload official-lecture **drafts** and attachments and propose corrections (a moderator approves them); publish explanations |
| Student | طالب | a subject | study, Start Studying, publish explanations, discuss, vote, rate, report; create silent and group rooms, and **teaching and exam rooms for an invited audience** (spec §12 «طالب أو مدرس يشرح»); course-wide rooms need a moderator |
| Signed-in non-member | زائر | — | sees only publications marked «عام» and public profile fields; the official file under them stays members-only, and quotes copied from it are withheld (Q2, ARCHITECTURE_DELTA §5.2); may not rate |

These roles and the matrix below match the permission model of `ARCHITECTURE_DELTA.md` §5, which is the authority for
enforcement.

### 4.3 Permission matrix (default policy; the central policy function implements it)

✓ = allowed · d = draft needing a moderator's approval · A = own items only · — = not allowed

| action | Platform admin | Admin | Assistant | Subject Moderator | Contributor | Student | Non-member |
|---|---|---|---|---|---|---|---|
| Create / edit / archive channel nodes | ✓ | ✓ (subtree) | — | — | — | — | — |
| Assign / revoke roles | ✓ | ✓ below Admin | — | — | — | — | — |
| Create / revoke join codes and invite links; approve joins | ✓ | ✓ | ✓ | — | — | — | — |
| Upload an official lecture | ✓ | ✓ | — | ✓ | d | — | — |
| Approve, publish a version, withdraw, correct official lectures | ✓ | ✓ | — | ✓ | propose | — | — |
| Read published official lectures; Start Studying; write own layers | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Publish an explanation in the subject | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (Q7) | — |
| Edit, republish, withdraw a publication | A | A | A | A | A | A | — |
| Fork / follow / save a visible publication | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | «عام» only |
| Rate a publication | members of its subject (≥ 7 days) who opened its items | ← | ← | ← | ← | ← | — |
| Report a publication, post, profile or room (Phase 1) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | «عام» items only |
| Hide, restore, request changes on a publication | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Mark a publication «راجعه مشرف المادة» | — (only with a moderator role) | — (only with a moderator role) | — | ✓ | — | — | — |
| Accept an answer | ✓ | ✓ | ✓ | ✓ | A (own question) | A (own question) | — |
| Hide / lock discussion posts; decide reports | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Create a teaching or exam room | ✓ | ✓ | ✓ | ✓ (course-wide) | ✓ (invited) | ✓ (invited) | — |
| Create a course-wide collaborative copy or room | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Scoped audit log and usage statistics | all | subtree | subtree | own subject (aggregates) | — | — | — |
| Platform operations (AI provider and models, deployment budget, ASR engines and evaluation, health, client errors, global processing queue, whole-instance backup / restore / download / export) | ✓ | — | — | — | — | — | — |
| Personal Control Center sections that act on one's own data (review queue, alerts, sync conflicts, source priority, explanation rules, own storage and usage) | own | own | own | own | own | own | — |
| Edit someone else's layer | — | — | — | — | — | — | — |
| Read another user's **private** data (any vault) | — | — | — | — | — | — | — |
| Share a recording beyond oneself | the recorder only, and only with the consent records of AOS-21.39 (the subject's lecturer policy **and** the recorder's attestation per share) | | | | | | |

**Moderators cannot read private data.** Moderation acts only on content that was published or posted into the space,
and a moderator's powers stop at the subject (one space per subject). No product screen shows another user's private
vault. The operator who runs the server can restore backups and reach the host; the privacy page says so (NFR-S3).

## 5. Release plan (spec §23 phases)

Spec §23 fixes the order: «هذه المراحل تحدد ترتيب التنفيذ، وليست مبرراً لإهمال تصميم الترابط بين الأنظمة منذ البداية». The
data model and permissions therefore cover all phases from Phase 1, even where the feature ships later.

**This section is the only phase table.** ARCHITECTURE_DELTA §16, ADR-0005 §8 and IA_AND_JOURNEYS point here.
[BUILD_PLAN.md](BUILD_PLAN.md) splits each phase into build tracks, and its Appendix A script checks that every §7 row is
built in the phase its `Ph` column names. The design's former «Phase 0» (tenancy foundation) is **Phase 1, Wave 1** of
the build plan; there is no separate phase.

### 5.1 Phases

| phase | spec §23 scope | delivers (main items) | exit criteria (§5.2 says how a blocked Must is handled) |
|---|---|---|---|
| **1 — Foundation and vertical slice** | محرر المحاضرات، القنوات، التحويل، الكتابة، المكتبة الشخصية، النسخ والطبقات | users, one vault per user, **one space per subject**, system DB; legacy owner migrated as user #1 with zero loss (journaled, X8); per-user web database, keys and drafts; central permissions and roles; channel tree, codes/QR/links, join approval; in-app notifications; **minimal moderation** (report → hide / restore with a reason, author notified, audit); official lectures and versions in subject spaces, conversion, smart import (numbering, names, new-version detection); stable lecture identity, including linking an existing private lecture to its official lecture (AOS-19H.3); subject attachments and updates feed; Start Studying; layers with show/hide, **copy one layer** between copies, **per-layer history**; independent fork and followed copy of **course-only** publications with update preview; official version update with safe note migration; private-by-default checks everywhere; e-ink mode; web ink tile cache and packed ink; account export and deletion; phone-only deploy and backup (PL-0); native-shell skeleton and CI files (static checks); the operational-cost and capacity section (§6.2, AOS-23.4) | **Scenarios 2 and 4 pass**; AC-01a, AC-01b (two users, two subjects in two universities) and X9 pass; the minimal moderation flow passes end to end (report → hide → author notified → restore → audit entry); the existing suites pass inside a bound vault, and every test edited beyond the binding helper is listed with its reason; the X8 owner-migration checklist passes, including a legacy outbox replayed after the upgrade; performance gate (AOS-23.2); phase report (AOS-23.1) |
| **2 — Community and search** | الشروحات العامة، الحسابات الاجتماعية، التحديثات، التعليقات، المقارنة والبحث | profiles, follows, public / followers / specific-user visibility (quotes from the official file withheld from non-members), marketplace ranking with anti-manipulation, comments and contextual discussions, suggestions and corrections, the **full** moderation queue (approval before «عام», request changes, «راجعه مشرف المادة», appeals), layer merge and kind filters, version history views, time machine and compare copies, permission-scoped universal search, image and **slide-photo search (the slide matcher)**, AI pen menu, smart collections, dashboard, moderator-published exam dates, equations; **in parallel:** signed iPad build and the iPad native ink surface (PL-1, PL-2, §5.3) | **Scenario 6 passes**; ranking and anti-manipulation tests; full moderation flow e2e; X9 extended to publications and discussions; performance gate; phase report; the platform-track result (TestFlight install, iPad latency per NFR-P1) recorded in the same report |
| **3a — Live lecture without speech recognition** | تسجيل المحاضرات، مزامنة الصوت والكتابة، Exam Radar (without «التفريغ المختلط») | recording session with chunked upload, consent and scope; the speech orchestrator with a fake engine; the evaluation flow the owner runs from an iPad (AOS-OC.10); unified timeline; replay; Exam Radar on typed or imported transcripts; calm live copilot (non-ASR parts); lecture camera reusing the Phase 2 slide matcher; chapters from headings; Exam Mode; **in parallel:** the Android app (PL-3) and the native recorder plugin (PL-4) | **Scenario 5 passes**; **Scenario 1 variant A (no ASR)** passes; X11 scripted part; performance gate; phase report. **3a alone does not complete spec §23 Phase 3**, whose scope includes «التفريغ المختلط» |
| **3b — Mixed-language speech recognition** | التفريغ المختلط | an engine evaluated on the owner's recordings and enabled; streaming and live transcription; code-switching tags; vocabulary biasing; diarization where supported; one shared transcript per shared official recording; the ASR worker and its CPU-minute quotas (ADR-0006 §2.13) | the X10 report meets the owner-confirmed absolute floors **per stratum** (AOS-S1.4, ADR-0006 §2.10); **Scenario 1 variant B** passes; capability labels carry the measured summary. Only 3b completes spec §23 Phase 3. It depends on owner recordings and an engine, not on Phase 4, so it may run in parallel with Phase 4 |
| **4 — Nearby, rooms, collaboration** | المشاركة القريبة دون إنترنت، الغرف، التعاون، وحل التعارضات | collaborative copies (validated CRDT updates), realtime transport, presence; online rooms first, then offline rooms on the same Wi-Fi or hotspot (QR exchange per joiner, server-signed offline credentials, optional LAN hub), with consent and roles; chunked resumable peer transfer; silent, group, teaching and exam rooms | **Scenario 3 passes** (multi-context here; device matrix recorded); X3–X7 pass; performance gate; phase report |
| **5 — Tutor and innovations** | AI Tutor، التعلم التكيفي، Knowledge Graph، الشروحات الجماعية والابتكارات المتقدمة | private tutor features, adaptive path, cross-course knowledge graph, crowd notes, Lecture Fusion, professor-vs-reference, catch-up, companion, read-aloud, on-device models | per-item acceptance; AI items evaluated with a real key before any quality statement; phase report |

### 5.2 Exit gating, blocked Musts and the phase report

* A phase is **complete** only when every `M` row that starts in it (and the phase-specific part of every `a/b` row)
  passes its acceptance criterion, and the phase's exit criteria above hold.
* A `M` row, or a `[dev]` / `[eval]` part of one, that cannot be run here passes only on the real device or the real
  data. Until then it is recorded **«Not run (reason)»** in the phase report, the owner signs that list off, and the
  phase is reported as **«closed with blocked Musts»** — never as complete. The rows stay open and are listed again in
  every later phase report until they pass. §10.1 lists the `M` rows that cannot be tested in this container.
* `S` and `C` rows may move to a later phase only with a recorded move in the phase report.
* **Phase report (AOS-23.1).** Written at every phase exit: what was implemented and what was not; test results (counts
  per suite, failures named); the Not-run list with reasons; the performance gate results (AOS-23.2); the
  operational-cost update (AOS-23.4); every §7 row whose status changed; the platform-track results.

### 5.3 Platform milestones — one timing statement (owner clarifications 1–4)

Pen latency is first-class and the iPad comes first (owner clarifications 2 and 4), so the native work starts **right
after Phase 1** by default, beside the web phases. ADR-0005 §8 and ARCHITECTURE_DELTA §16 use this table.

| milestone | content | timing (default) | needs |
|---|---|---|---|
| PL-0 | Phone-only operation: Render deploy from GitHub, R2 off-site backups, restore-verify, Arabic runbook (a Round 7 task prepares the Dockerfile and Render blueprint) | Phase 1 | Render and R2 accounts |
| PL-1 | Native shell (Capacitor) around the existing web app: skeleton and CI workflow files (static checks here); then a signed iPad build by cloud CI (macOS runner) installed through TestFlight | skeleton in Phase 1; signed iPad build **immediately after Phase 1, in parallel with Phase 2** | Apple Developer Program (decision D-A) |
| PL-2 | iPad native ink surface (PencilKit or Metal, prediction, pressure/tilt/hover, double-tap/squeeze, system palm rejection) writing the same `InkPoint` model through the same outbox (AOS-OC.3) | in parallel with Phase 2 | PL-1; iPad + Apple Pencil |
| PL-3 | One Android app: S Pen front-buffered rendering with motion prediction; BOOX pen SDK when present (AOS-OC.4) | in parallel with Phase 3 | Google Play Console (decision D-G); Samsung and BOOX devices |
| PL-4 | Background recording plugin; native nearby transports (Nearby Connections, Multipeer, BLE) as optional accelerators | recording with Phase 3; nearby with Phase 4 | PL-1 / PL-3 |
| PL-5 | Store publication (AOS-OC.9) | App Store at the end of the Phase 2 window; Google Play with Phase 3 | store review |

**Dated decision points** (proposed dates; the owner may move them, and each phase report states any slip):

* **D-A — Apple Developer Program account: decide by 2026-12-15.** Without it PL-1/PL-2 cannot start, and AOS-OC.1
  (TestFlight part), OC.2, OC.3 and OC.9 are reported «Not run (no Apple account)».
* **D-G — Google Play Console account: decide by 2027-02-15**, before Phase 3 starts. Without it PL-3 and the Google Play
  part of OC.9 are reported the same way.

**The Phase 1 vertical slice** (spec §23 item 8): a new user joins a subject with a class code → opens an official lecture →
«ابدأ الدراسة» creates a personal copy → writes offline on the iPad → syncs → picks a classmate's course-only explanation as a
followed copy → the classmate updates it → the follower previews and applies the update with personal ink intact → the
moderator uploads version 2 with inserted pages → each student's notes move safely after one tap, or are listed for review
→ a student reports an explanation and a moderator hides and restores it. This is Scenarios 2 and 4 plus the minimal
moderation flow.

## 6. Non-functional requirements

Targets marked *goal* must be **measured** on the named reference before anything is claimed (rule K7). The spikes that
produced the "today" numbers ran in headless Chromium or Node on a loaded 4-vCPU VM, not on devices.

| id | area | requirement | today (measured) | acceptance |
|---|---|---|---|---|
| NFR-P1 | Pen latency | Live stroke work per frame stays inside one frame on every target. | Web live layer 2.5–4.4 ms median per frame with software raster (spike 4a). Expected pen-to-pixel ranges from public documentation are in §6.1 (not measured). | Per-device report (iPad + Pencil, Samsung + S Pen, BOOX) of pen-to-pixel latency measured with ≥ 240 fps video; *goal* native ≤ 20 ms on iPad; the web number is published as measured, whatever it is, next to the §6.1 expectation. |
| NFR-P2 | Dense pages | Zoom or reload of a 5,000-stroke page must not freeze writing. | Full repaint 3–4 s for 5,000 realistic strokes (software raster); one zoom step = 397 ms long task in e2e. | Bitmap tiles per zoom level (ADR-0005 B.3): *goal* warm repaint of a realistic 5,000-stroke page < 200 ms in the CI harness, and no long task > 100 ms while writing; device numbers recorded only when measured on the device. |
| NFR-P3 | Sync payload | Points travel packed, not as JSON. | JSON 29.1 B/point vs packed 5.28 B/point (spike 1b). Packed points are binary; inside JSON they travel as base64 (+33 %): the spike page's 5,899,202 B of packed points become ≈ 7.9 MB of base64 alone. The server has no HTTP compression today. | Packed point codec, lossless round-trip test; a 5,000-stroke page transfer ≤ 8 MB **measured on the wire** — met only with HTTP compression (gzip/br) for JSON responses or a binary endpoint for packed points (ADR-0004 §2.5); quoted sizes always say whether they are binary or base64. |
| NFR-P4 | Collaborative merge | Multi-writer layers merge fast. | Yjs flat-packed: 0.03 ms per stroke commit, 9–21 ms merge of two offline deltas, 3/3 peers converged (spike 1a). | 3-peer convergence test with identical state hash; merge of two offline deltas on the 5,000-stroke page ≤ 50 ms in the CI container (the one budget used by ADR-0004 §4 and BUILD_PLAN); device numbers recorded when measured. |
| NFR-P5 | Search | Permission-scoped search stays fast on a large space. | Scope tokens inside MATCH: 8–14 ms p50 on 246k chunks; post-filter 86–242 ms (tenancy S1b). | p95 ≤ 50 ms server-side for scoped search on a 250k-chunk space. |
| NFR-P6 | Tenancy cost | Per-request binding does not slow the server. | Vault open 5.8 ms; LRU hit 0.24 ms p50; miss 28 ms p50; proxy +0.25 µs/statement (tenancy S2, S6). | p95 request overhead from vault binding ≤ 50 ms on a cache miss. |
| NFR-R1 | No data loss | No accepted user write is ever lost or duplicated. | AC-23/24/30 for one owner. | AC-23/24/30 per user; X5–X8 pass; zero loss in fault-injection runs. |
| NFR-R2 | Recovery | Off-site backups and verified restores. | Whole-server verified backup (AC-30). | Nightly R2 backup; RPO ≤ 24 h (*goal*); per-vault restore-verify passes in CI. |
| NFR-S1 | Isolation | No cross-user read of private data through any path. | Single owner — not applicable yet. | AC-01b + X9 matrix (resource × role × visibility × path: routes, files, sync pull, search, export, offline packages, AI scope, cache) all pass. |
| NFR-S2 | Transport | TLS everywhere in multi-user deployments. | TLS via proxy; Secure cookie opt-in. | The server refuses to start in multi-user mode with an https origin and a non-Secure cookie. Peer links: DTLS with identity checked against the QR fingerprint. |
| NFR-S3 | At rest | Documented encryption at rest. | Not encrypted (0600 file mode only); backup archives are not encrypted (docs/BACKUP_RESTORE.md). | Written decision: host disk + R2 server-side encryption + **application-level encryption of every archive before it leaves the host** (key in the host's secret store, never in R2); an encrypted restore is tested; no "zero-knowledge" claim; the privacy page states in Arabic that the person operating the server can technically reach stored data and backups even though no product screen shows another user's vault. |
| NFR-PR1 | Privacy | Consent for recording distribution, presence, progress sharing, and for any processing of a person's data or voice by an external provider; no model training on user data without consent. | Recorder starts only on explicit action. | Consent records stored and checked before any share or external processing (ARCHITECTURE_DELTA §5.6): per-user `ai_processing` consent naming the providers before private notes, handwriting crops or transcripts go to an AI provider; the subject's lecturer policy (with a hall notice) before lecture audio or its transcript goes to a cloud ASR or an LLM; policy page lists both. |
| NFR-A1 | Accessibility | WCAG 2.1 AA. | Keyboard + roles contract; no axe run. | axe in CI with 0 serious violations on all screens; VoiceOver (iPad) and TalkBack (Android) passes logged on devices. |
| NFR-L1 | Language | Arabic-first, English terms isolated, Latin digits. | Implemented (AC-20). | AC-20 on every new editor; no bidi control characters stored. |
| NFR-O1 | Offline | Each capability states its offline behaviour in the registry. | Implemented for current features. | New capabilities register an offline state; e2e offline checks per phase. |
| NFR-C1 | Cost | Per-user and per-space quotas for storage, AI and ASR (ASR also in **CPU-minutes** for server-local engines, which are not free); atomic budget reservation. | One global monthly AI budget; pre-check not atomic. | Quota tests incl. concurrent calls; remaining allowance visible to the user; §6.2 cost tables updated in every phase report. |
| NFR-OP1 | Operability | Everything operable from a phone. | Not yet (PL-0 in progress). | OC.1 dry run recorded; the ASR evaluation flow runs from an iPad (OC.10). |
| NFR-OP2 | Capacity | No capacity statement without a load test; heavy CPU work never runs on the request event loop. | Not measured: every `node:sqlite` call is synchronous on one event loop; only database micro-spikes exist. | A load test (N concurrent users, live rooms and background jobs on the target Render plan) before any capacity claim; publish copies, follower fan-out, Yjs projection, page maps, FTS rebuilds, ASR and other heavy jobs run in worker threads or a separate process with their own connections; p95 HTTP latency and event-loop delay reported under that load in the phase report (AOS-23.2). |
| NFR-CM1 | Compatibility | Never assume a transport or capability. | Capability matrix for pen (web). | Interop matrix per device filled from real runs; untested cells say «لم يُختبر (السبب)». |

### 6.1 What a web canvas can reach — expected, from public documentation, not measured

Owner clarification 2 asks the design to state honestly what a web canvas can reach. Nothing below was measured on a
device; the per-device measurement of NFR-P1 replaces it as soon as it exists.

* **The chain.** Digitizer sampling (Apple states 240 Hz Pencil sampling on iPad Pro) → OS input → the browser delivers
  pointer events, coalesced per display frame (`getCoalescedEvents`) → the main-thread handler → the canvas draw in the
  next animation frame → the compositor → display scan-out.
* **Frame model.** On a normal composited canvas a new stroke segment typically appears **2–3 display frames** after its
  pointer event: about **33–50 ms at 60 Hz** and **17–25 ms at 120 Hz**, plus digitizer and OS input time.
* **What the web platform offers.** The `desynchronized: true` canvas hint (Chromium) lets the canvas bypass much of the
  compositor and in some cases reach the display controller directly, which can save about a frame. Predicted pointer
  events (`getPredictedEvents`, «Baseline 2024» per MDN) let the engine draw ahead and hide roughly another frame of
  *perceived* latency, at the cost of small corrections. Whether Safari on a 120 Hz iPad and the shell's `WKWebView`
  deliver animation frames at 120 Hz is **not verified here**.
* **Native.** Apple stated 9 ms Apple Pencil latency on iPad Pro with iPadOS 13 and PencilKit (WWDC 2019, a public
  statement). Android's front-buffered rendering and motion prediction libraries are designed to cut stroke latency;
  no figure is claimed.
* **Consequence.** The web path is expected to land around 17–50 ms depending on refresh rate and browser; the native
  goal is ≤ 20 ms (NFR-P1). That gap, not the per-frame compute time (2.5–4.4 ms, already small), is why the native
  iPad surface starts right after Phase 1 (§5.3).

### 6.2 Operational costs and capacity (spec §23 #12; AOS-23.4)

Updated in every phase report. Prices are public list prices read on 2026-10-20 and are **not** a quote; every number
below is arithmetic on them or on the measured spikes.

**Price inputs**

| item | price (public page, 2026-10-20) | note |
|---|---|---|
| Render web service / background worker | Starter $7/month (512 MB, 0.5 CPU) · Standard $25 (2 GB, 1 CPU) · Pro $85 (4 GB, 2 CPU) · Pro Plus $175 (8 GB, 4 CPU) · Pro Max $225 (16 GB, 4 CPU) · Pro Ultra $450 (32 GB, 8 CPU) | Render docs: a service with a persistent disk runs as **one instance**, adding a disk **prevents zero-downtime deploys** (a few seconds down per deploy), and the disk is reachable by that one instance only, so a separate worker cannot read it; daily disk snapshots kept ≥ 7 days (DOC, untested) |
| Render persistent disk | $0.25 per GB-month | databases, temp files and caches only once blobs move to R2 |
| Cloudflare R2 Standard | storage $0.015 per GB-month; Class A $4.50 and Class B $0.36 per million operations; egress free; free tier 10 GB-month, 1 M Class A, 10 M Class B | blobs (AOS-OC.7) and off-site backups |
| AI | estimates from the repository's cached price table (ADR-0002: e.g. Opus 5.5 $4 / $20 per 1M input / output tokens, cached 2026-10-06) | always labelled «تقدير» |

**Storage per student.** The recorder records at 64 kbps (`recorder.ts`), ≈ 28.8 MB per hour. A student who records 4 h a
day, 5 days a week for 30 weeks stores ≈ 17.3 GB a year, so the 2 GB default vault quota (Q22) holds ≈ 69 hours. Official
content costs little by comparison (≈ 1.1 GB for 1,800 processed lectures once, ≈ 1.5 MB of stubs per student; ADR-0003 §4).
Recordings therefore decide the bill, and where blobs live matters 16×: 500 students × 17.3 GB = 8.65 TB costs ≈ $2,160 a
month on the Render disk and ≈ $130 a month in R2 (+ operations). Levers, in order: blobs in R2 (OC.7, Phase 1); **one
shared official recording per lecture** with a lecturer policy instead of N personal copies (ADR-0006 §2.13); a speech
bitrate of 32 kbps only if the X10 harness shows no loss; storage tiers set by the platform admin.

**Deployment tiers (proposal; T3 is not estimated before the NFR-OP2 load test)**

| tier | users | services | disk | R2 | AI ceiling | ASR | ≈ monthly (excl. AI) |
|---|---|---|---|---|---|---|---|
| T0 owner only (today) | 1 | Standard web $25 | 10 GB $2.50 | backups within the free tier | the owner's budget | none, or server-local on request | ≈ $28 |
| T1 pilot class | ≤ 50 | Pro web $85 | 20 GB $5 | ≤ 1 TB ≈ $15 | 50 × $2 = $100 | shared official recordings only, ≤ 4 h of audio a day, on a Pro Plus worker when enabled | ≈ $105, + $175 with the ASR worker |
| T2 one college stage | ≤ 500 | Pro Plus web $175 + Pro Plus ASR worker $175 | 50 GB $12.50 | ≈ 9 TB ≈ $135 | 500 × $2 = $1,000 | shared recordings for ≈ 10 subjects; personal transcription within CPU-minute quotas | ≈ $500 |
| T3 several colleges | ≤ 5,000 | decided only after the load test (NFR-OP2): larger plans, more workers, heavy jobs split out | — | — | — | — | not estimated |

**AI per user.** An explanation request of ≈ 6,000 input and 800 output tokens costs ≈ $0.024 + $0.016 = $0.04 at the cached
Opus 5.5 rates, so a $2 monthly allowance is ≈ 50 such requests; a live copilot session is capped at $0.50 (ARCHITECTURE_DELTA
§14). New users start at 0 (Q10). Per-space allowances (shared Study Books generated once per subject) are capped separately.

**Speech recognition capacity** (details in ADR-0006 §2.13). Measured on English only, 4 loaded vCPU: real-time factor 0.21
(tiny) – 0.68 (small-q5_1), so one lecture-hour occupies a 4-CPU host for 12.6–40.5 minutes; Arabic decoding speed is not
measured and is likely slower. Transcribing every student's personal recording is impossible on one host: 30 students ×
4 h a day = 120 h of audio, i.e. 25–82 h of 4-CPU time per day. Hence: one transcript per shared official recording, reused
by every member; personal recordings transcribed only on request within a **CPU-minute** quota (default 120 CPU-minutes
per student per month ≈ 2.4 h of audio with the smallest measured model, ≈ 0.7 h with small-q5_1); ASR in a separate
worker that reads audio from R2 (a Render worker cannot read the web service's disk); a per-minute cloud engine only by
owner decision (Q9).

## 7. Requirements table

**Legend**

* **Ph** — phase (§5). `1/2` = the first part lands in Phase 1 and the rest in Phase 2 (the criterion says which part is which).
* **Pri** — `M` must (the phase is *complete* only when it passes; if it can only be run on a device or real data that is
  not available it is recorded «Not run (reason)», the owner signs off, and the phase is «closed with blocked Musts» —
  §5.2) · `S` should · `C` could (`S` and `C` may move to a later phase; the move is recorded in the phase report).
* **Now** — baseline status from the gap analysis: `have` · `partial` · `missing` · `conflict`.
* **Acceptance criterion** — test tags: `[srv]` server test, `[web]` web unit/component test, `[e2e]` Playwright against the
  real server, `[dev]` recorded run on a real device, `[eval]` quality evaluation on owner-supplied data, `[doc]` checked
  by the reviewer against the named document. Every criterion
  also requires the capability registry to show the honest state (rule K7).
* **Here** — can it be tested in this Linux + headless-Chromium container: `yes` · `partial` · `no`, followed by the blocker.
* **Regression rule for `have` items:** from Phase 1, every existing test runs inside a bound user vault (through the
  test-binding helper) and must keep passing; a test that needs more than the helper is listed with its reason in the
  phase report. The criterion of a `have` item lists only what it adds for many users.
* **3b** in a Phase 3 criterion marks the speech-recognition part that only Phase 3b can close (§5.1).
* Requirement texts are short paraphrases of the gap-analysis items; the spec section is the authority.

### 7.1 §1 Advanced Notes & Document Engine

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-1.1 | Pen writing with pressure sensitivity | 1 | M | have | Strokes gain `author_id` and `layer_id`; pressure is stored only after a real device event reports variation `[web]`; the native surfaces (OC.3/OC.4) write the same `InkPoint` model `[dev]`. | partial — real stylus (iPad + Pencil, S Pen, BOOX) for curves and latency |
| AOS-1.2 | Palm rejection while writing | 1 | M | partial | Web heuristic keeps its unit tests and gains a setting (parity G02); native shells use system palm rejection; a 10-minute writing script records the stray-touch rate per device `[dev]` (reported, never assumed). | partial — physical tablets; native toolchains via cloud CI |
| AOS-1.3 | Multiple pen types | 1 | S | have | Per-tool presets move from localStorage into synced per-user settings, so they follow the user to every device `[web]` (parity G03). | yes |
| AOS-1.4 | Highlighter tool | 1 | S | have | With several visible layers each layer's highlights blend inside that layer only `[web]`. | yes |
| AOS-1.5 | Pencil tool | 1 | S | missing | `pencil` added to shared `INK_TOOLS`, the server annotation schema, palette/prefs and renderer (grain, pressure→opacity) `[web][srv]`; an older client receiving a `pencil` stroke draws it as a plain pen `[web]`; undo and sync covered (parity G06). | yes |
| AOS-1.6 | Eraser | 1 | M | have | The eraser only touches items in layers the user may edit; the server refuses a tombstone for another author's item with a permission error `[srv][web]`. | yes |
| AOS-1.7 | Shapes | 1 | C | have | Triangle/polygon and Shift-constrained shapes added (parity G20) `[web]`. | yes |
| AOS-1.8 | Ruler | 1 | S | missing | Movable, rotatable ruler; strokes near its edge snap to the edge line `[web]` (geometry unit test); two-finger rotate on touch and arrow keys (1°, Shift 15°) `[e2e]`; ruler state is per device (parity G08). | yes |
| AOS-1.9 | Lasso selection | 1 | M | have | Lasso selects only items in editable layers; items of read-only layers (official, followed) can be copied but not moved or deleted `[web]`. | yes |
| AOS-1.10 | Vector ink | 1 | M | have | AC-21 (`g6-ac21`) passes inside a vault and against native-shell strokes (same normalized coordinates) `[e2e]`; the packed point codec round-trips losslessly `[web]`. | yes |
| AOS-1.11 | Move elements | 1 | M | have | Keyboard nudge (arrow 1 pt, Shift 10 pt) `[web]`; in collaborative copies (Phase 4) two users moving the same stroke converge to one stroke, never a duplicate `[web]`. | yes |
| AOS-1.12 | Resize elements | 1 | C | have | Non-uniform stretch and rotation of text boxes and images (parity G19) `[web]`. | yes |
| AOS-1.13 | Change element colours | 1 | S | have | Recolouring an item of another author's layer is refused `[srv]`. | yes |
| AOS-1.14 | Change element opacity | 1 | S | partial | Opacity (10–100 %) in tool options and the lasso bar, undoable and synced `[web]`; renderer test proves the alpha is applied; highlighter alpha stays fixed. | yes |
| AOS-1.15 | Convert handwriting to text | 1 | S | partial | The reading can be inserted as a text box labelled «نص مُتعرَّف — قابل للتصحيح» and re-run when strokes change `[web]`; disabled with the registry reason when no recognizer `[e2e]`; in shared documents the crop holds only the user's own strokes unless the other author allows it `[srv]`; quality measured on owner samples before any claim `[eval]`. | partial — vision provider key or on-device recognizer; real Arabic/English handwriting samples |
| AOS-1.16 | Arabic + English, mixed RTL/LTR | 1 | M | have | AC-20 extended to every new editor (discussions, comments, profile, publication titles, room chat); no bidi control character stored `[web][e2e]`. | yes |
| AOS-1.17 | Insert images | 1 | S | have | Images in a published or shared layer are read only through access-checked routes (non-member gets 403/404) `[srv]`; crop and rotate (parity G16) `[web]`. | yes |
| AOS-1.18 | Tables in notes | 1 | S | missing | Table block in RichText (cells hold bidi runs), zod-validated on the server, rendered in text boxes and notes, exported to Markdown/DOCX/HTML with a round-trip test `[web][srv]`; arrow keys and Tab move between cells. | yes |
| AOS-1.19 | Drawings / diagrams | 1 | C | have | Connectors between shapes (parity G21) `[web]`. | yes |
| AOS-1.20 | Links | 1 | S | partial | Link targets extended to channel lecture pages, publications and web URLs (with the existing external-link confirm) `[web]`; a link to something the viewer cannot open shows «لا تملك صلاحية» without revealing its title `[srv]`. | yes |
| AOS-1.21 | Equations | 2 | C | missing | Equation object stored as a LaTeX subset, rendered as MathML, LTR-isolated inside Arabic lines, carried into exports and search text `[web]`; editor with live preview. No math OCR needed. The newer spec (§1 «معادلات», §10) overrides the parity study's «out of scope (spec §01)» for math; built by BUILD_PLAN track P2-T5 (moved from Phase 1, C priority, recorded here). | yes |
| AOS-1.22 | Audio recordings inside notes | 1/3 | S | partial | Phase 1: an audio-clip object placed on a page links to a segment of an existing recording `[web]`; Phase 3: record directly into the object `[e2e]` (fake mic); clips stay private until shared under AOS-21.39. | partial — real microphone |
| AOS-1.23 | Side notes | 1 | S | have | Notes inside a publication carry the «شرح طالب» label and stay low assurance `[srv]`; rich formatting (parity G25). | yes |
| AOS-1.24 | Undo / Redo | 1 | M | have | In multi-writer layers undo reverts only the user's own operations; a peer's later stroke survives a local undo `[web]`. | yes |
| AOS-1.25 | Edit history log | 2 | S | partial | Ink and note edits append to a per-document operation history (actor id, time, action, item) shown per document `[srv][web]`; it feeds AOS-4.15 and 13.12; purge and account erasure remove it `[srv]`. | yes |
| AOS-1.26 | Bookmarks | 1 | S | have | Bookmarks always live in the personal layer and are never published `[srv]`. | yes |
| AOS-1.27 | Tabs (multiple open documents) | 1 | S | missing | Tab strip for ≥ 8 open documents, each restoring its place from `study_session`; Ctrl/⌘+1…9; `[e2e]` opens three lectures and returns to each page. | yes |
| AOS-1.28 | Split View | 1 | S | have | The split pane can show the same lecture with two different layer sets (used by AOS-4.13) `[web]`. | yes |
| AOS-1.29 | Two lectures, independent scrolling | 1 | S | have | Regression only `[e2e]`. | yes |
| AOS-1.30 | Two lectures, synchronized scrolling | 1 | S | partial | Link toggle for two lectures or copies: by page index, by proportion or by matched headings; copies of one lecture link page to page `[web]` (mapping unit tests) `[e2e]`. | yes |
| AOS-1.31 | Write on PDF pages | 1 | M | have | Writing on a followed or forked copy goes to the personal layer above read-only layers `[e2e]`. | yes |
| AOS-1.32 | Paper templates | 1 | C | have | Custom and clinical templates (parity G31/G32). | yes |
| AOS-1.33 | Optional infinite canvas | 1 | C | missing | Optional «لوحة» note-page kind with tiled rendering, unbounded coordinates and its own spatial index; clamps for paginated pages unchanged `[web][srv]`; meets the NFR-P2 budget. May move to Phase 5 (L effort, not on the vertical-slice path). | yes |
| AOS-1.34 | Export a flattened PDF | 1 | S | missing | PDF with ink, highlights, text boxes and images burned in, following current layer visibility; other authors' layers carry an attribution line; page count and geometry checked by raster diff `[srv]`. Reuse the server PDF exporter being added in Round 7 (task H4-8). | yes |
| AOS-1.35 | Export an editable copy | 1 | S | partial | Per-document package (lecture version reference + own layers + notes) re-imports into the same or another vault without loss `[srv]`; it contains only data the user may export. | yes |
| AOS-1.36 | Search printed text incl. OCR | 1 | M | have | Results are filtered by permission inside SQL before ranking (vault index + each permitted space with scope tokens in MATCH); a non-member never gets a hit from a space `[srv]`. | yes |
| AOS-1.37 | Search handwriting | 2 | S | partial | Opt-in background recognition of the user's own ink, indexed only in that user's vault; «كتابة يدوية» hits jump to the page `[srv][e2e]`; disabled with a reason without a recognizer. | partial — vision key or on-device recognizer |
| AOS-1.38 | Full offline work on local files | 1 | M | have | One IndexedDB per user (`medlevo:<userId>`); every `localStorage` key is per user (13 files by grep today), crash-recovery note drafts are restored only for the user who wrote them, and pre-multi-user clients are refused by version (`x-medlevo-client`) with the service worker updated at the first multi-user sign-in; with two users on one browser neither outbox nor draft is ever saved or pushed under the other's session `[web][e2e]`; AC-23 passes per user. | yes |
| AOS-1.39 | Smooth writing without full redraw | 1 | M | have | Remote strokes use the same dirty-rectangle path `[web]`; tile cache meets NFR-P2; per-device latency recorded under NFR-P1 `[dev]`. | partial — real tablets for latency |

### 7.2 §2 Academic Channels & University System

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-2.1 | Channel hierarchy University → … → Lecture | 1 | M | conflict | Admin-owned channel tree with typed levels University → College → Department → Stage → Academic Year → Semester/Course → Subject → Lecture (a university may skip levels), kept separate from each user's private library `[srv][e2e]`; ADR supersedes rule 8; AC-01 replaced by AC-01b. | yes |
| AOS-2.2 | Official lectures ordered by number and date | 1 | M | partial | Channel lectures carry `lecture_no`, `held_on`, official flag and publisher; the subject list sorts by number, then date `[srv][e2e]`. | yes |
| AOS-2.3 | PDF, PPTX, DOCX and image files in a subject | 1 | M | partial | Moderators upload all four formats into a subject; access follows the space; uploader identity recorded; duplicate messages scoped to what the uploader can see (AOS-3.6) `[srv]`. | yes |
| AOS-2.4 | Office → PDF keeping layout and fonts | 1 | S | partial | DOCX also gets a display PDF (paragraph locators kept for evidence) `[srv]`; Arabic/English fixture fidelity report (fonts embedded, page count stable across runs). | yes |
| AOS-2.5 | Additional files, summaries, past-year questions | 1 | S | partial | Subject attachments (`subject_attachment`: kind summary / previous exam / reference, uploader, visibility, rights, versions; ARCHITECTURE_DELTA §4.4) uploaded by moderators, or by contributors with approval; each upload writes a `subject_event` and notifies members; previous exams feed the space's question bank with source keys; summaries keep the evidence rules `[srv][e2e]`. | yes |
| AOS-2.6 | Lecture recordings in the subject | 3 | S | partial | A recording attaches to a subject/lecture only with consent and scope metadata (AOS-21.39/21.41); streaming is access-checked; listen-only scope has no download `[srv]`. | partial — real microphone and real lecture audio |
| AOS-2.7 | Student discussions and questions in the subject | 2 | M | missing | Subject discussion list built on AOS-6.x, members only `[srv][e2e]`. | yes |
| AOS-2.8 | Published student explanations in the subject | 1/2 | M | missing | Phase 1: per-lecture list of course-only explanations (title, author, updated, completeness) labelled «شرح طالب» `[e2e]`; Phase 2: marketplace sorting (AOS-5.27–5.35). | yes |
| AOS-2.9 | Latest updates and lecture versions | 1 | S | partial | Subject updates feed read from `subject_event` rows (new lecture, new version, new attachment, exam date) filtered by the viewer's access, plus a per-user «تغيّر منذ آخر دراسة» badge `[srv][web]`. | yes |
| AOS-2.10 | Study-progress view | 1 | S | partial | Per-user progress per channel subject from the user's vault (reading, explanation coverage, practice, mastery estimate kept separate, real counts) `[srv]`. | yes |
| AOS-2.11 | Join with a Class Code | 1 | M | conflict | Codes stored hashed, expiring, revocable, rate-limited and usage-counted; joining creates a pending or approved membership per channel policy; audit entry `[srv][e2e]`. ADR. | yes |
| AOS-2.12 | Join with a QR Code | 1 | S | conflict | The QR encodes the same expiring join link; in-app scanner with a JS decoder and manual-code fallback `[web][e2e]` (generate + decode in Chromium). | yes |
| AOS-2.13 | Join through an invite link | 1 | S | conflict | Signed, expiring link; the landing route `/join/:token` shows only the channel's title through the rate-limited public `GET /api/channels/join/preview?token=` and then needs sign-in (or sign-up where allowed); the public-route list changes by ADR-0003 §3.10 with `g8-security` updated in the same change `[srv]`. | yes |
| AOS-2.14 | Supervisor defines channel permissions | 1 | M | conflict | One central policy function used by every route, sync pull, search, export, file read and AI scope resolution; roles per node with inheritance; test matrix resource × role × visibility `[srv]`. | yes |
| AOS-2.15 | Supervisor approves join requests | 1 | M | conflict | Pending → approved / rejected by Admin, Assistant or Subject Moderator; the requester is notified; audit entry `[srv][e2e]`. | yes |
| AOS-2.16 | Subscribe to a whole course | 1 | M | missing | «تابع المادة» (named `course_follow` — not a payment) adds the subject to the student's library; unfollow works `[srv][e2e]`; the AC-01 «subscri» regex is retired by AC-01b. | yes |
| AOS-2.17 | New lectures of a followed course land in the library | 1 | M | missing | Publishing an official lecture adds a stub link to followers' libraries by an idempotent job keyed by user + lecture version; no blob is duplicated and the student's folders are untouched `[srv]`. | yes |
| AOS-2.18 | «Start Studying» creates a personal editable copy | 1 | M | partial | Creates a personal copy (vault stub: source + version + page skeleton, ≈10 KB per 40 pages) and opens the workspace; pressing again reopens the same copy `[srv][e2e]`. | yes |
| AOS-2.19 | Choose another student's explanation before starting | 1 | M | missing | The start flow offers: blank personal copy, independent fork of explanation X, followed copy of X — each with a preview `[e2e]`. | yes |

### 7.3 §3 Smart Import & Academic Organization

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-3.1 | Upload dozens of lectures at once | 1 | S | have | Moderators bulk-upload into a subject with per-file status and resumable chunked upload (AOS-11.22); a ZIP of PDFs can be imported as a batch of lectures `[srv][e2e]`. | yes |
| AOS-3.2 | Recognize subject names during import | 1 | S | missing | Subject suggestion from file-name tokens, cover/header text and existing course nodes, held for confirmation by the uploader or the moderator, never applied when uncertain (AOS-3.18) `[srv]`; top-1 precision reported on a labelled fixture set. | yes |
| AOS-3.3 | Recognize lecture names | 1 | S | partial | Title proposed from the title page or first heading and cleaned of noise («final (1)», «copy»); the original file name is kept; the user confirms `[srv]` (fixtures). | yes |
| AOS-3.4 | Detect lecture numbering | 1 | M | missing | Detects «Lecture 5», «Lec 05», «محاضرة ٥», «المحاضرة الخامسة» in the name or first pages and stores `lecture_no` (+ `held_on` date when found); uncertain values go to review `[srv]` (fixtures incl. Arabic-Indic digits and ordinal words). | yes |
| AOS-3.5 | Order lectures automatically | 1 | S | partial | Sort «حسب الرقم» and «حسب التاريخ» with natural-title fallback; stable ties; a manual order still wins when chosen `[web][srv]`. | yes |
| AOS-3.6 | Duplicate detection by content hash | 1 | M | have | The duplicate answer names only sources the uploader can see; blob de-duplication across vaults stays internal: uploading the bytes of another user's private file returns no title and no hint `[srv]`. | yes |
| AOS-3.7 | Suggest the right subject per file | 1 | S | missing | Placement suggestions with reasons (matched tokens/keywords) through the review queue; accept/reject remembered; nothing moves without confirmation `[srv][web]`. | yes |
| AOS-3.8 | Extract headings | 1 | S | have | Official lectures are processed once per space; followers' copies reference the result `[srv]`. | yes |
| AOS-3.9 | Extract table of contents | 1 | C | partial | Printed «فهرس» pages parsed into page links `[srv]`. | yes |
| AOS-3.10 | Extract contents (text, tables, figures) | 1 | S | have | Chunks and FTS rows of official lectures live only in the space and are never copied into vaults `[srv]` (storage assertion). | yes |
| AOS-3.11 | Detect a new version of an existing lecture | 1 | M | partial | An upload whose page text/image fingerprints match an existing lecture above a threshold is proposed as «إصدار جديد من …»; confirmed → new `source_version` and follower notification (AOS-18.10) `[srv]` (fixtures: re-exported PDF, inserted pages). | yes |
| AOS-3.12 | Compare new and old pages | 1 | S | missing | Page matcher (text similarity + page-image hash) yields an old↔new map with inserted and removed pages; side-by-side text and visual diff `[srv][e2e]` (Scenario 4 fixture). | yes |
| AOS-3.13 | Move notes to the new version when safe | 1 | M | missing | Safely matched personal annotations are **copied** to new anchors (`reanchored`, `previous_anchor` kept); old-version rows stay untouched; uncertain ones are listed for manual review with a move UI; citations and evidence never move `[srv][e2e]` (Scenario 4). | yes |
| AOS-3.14 | Manage original and converted files | 1 | S | partial | The versions panel shows the original and the converted copy, downloads each (access-checked), re-runs conversion and lets a moderator choose the displayed file `[e2e]`. | yes |
| AOS-3.15 | Smart collection: important lectures | 2 | S | partial | Rule-based «مهمة» collection (favourite, priority, tags, exam relevance); every entry shows the rule that put it there `[srv]`. | yes |
| AOS-3.16 | Smart collection: difficult lectures | 2 | S | partial | «صعبة» collection rolled up per lecture from weaknesses and FSRS lapses, with denominators `[srv]`. | yes |
| AOS-3.17 | Smart collection: exam lectures | 2 | S | partial | «محاضرات الامتحان» from question↔lecture links and archive frequency, worded «مؤشر وليس احتمال» `[srv]`. | yes |
| AOS-3.18 | Uncertain auto-classification needs review | 1 | M | conflict | Uncertain values (unmatched or ambiguous) stay pending with no downstream effect — no question extraction or matching until confirmed, or effects labelled provisional and reversible `[srv]`; the review queue is role-scoped (the student for their vault, the subject moderator for the space); a human decision is never overridden by automation `[srv]`. Rule 8 conflict resolved by the ADR. | yes |

### 7.4 §4 Smart Fork, Followed Copy & Collaborative Documents

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-4.1 | One primary source; copies without duplicating the original | 1 | M | partial | A fork graph links every copy to its official lecture version; N copies add only stubs and overlay rows — no blob, chunk or FTS duplication (storage assertion) `[srv]`. | yes |
| AOS-4.2 | Independent Fork | 1 | M | missing | Copies the chosen explanation layer as of a publication version into a user-owned layer (new ids, attribution kept); later versions of the source publication never change it `[srv][e2e]`. | yes |
| AOS-4.3 | Followed Copy | 1 | M | missing | The followed layer is read-only to the follower and updated from the publication feed; item ids are stable across publication versions (`hash(publication_id, item_id)`), so an update upserts changed items, tombstones removed ones and leaves references to unchanged items intact; the follower's personal layer is separate and never modified by an update `[srv][e2e]` (Scenario 2). | yes |
| AOS-4.4 | Collaborative Copy | 4 | M | missing | Authorized writers edit one document; multi-writer layers use Yjs with each stroke one immutable value with packed points; every update is decoded and validated on the server (schema, size, `created_by` = the uploading actor for inserted items, client ids bound to user and device) and invalid updates are quarantined, never applied; 3 peers editing offline converge to the same state hash; per-user undo; no conflict copies for normal concurrency; a moderator can restore the layer to a time T as a new state `[web][srv][e2e]`. | yes |
| AOS-4.5 | Layer: official content | 1 | M | partial | The official layer is the immutable source version published by a moderator, shown with «رسمي» and the publisher; nobody can write on it `[srv][e2e]`. | yes |
| AOS-4.6 | Layer: each student's explanation | 1 | M | missing | Layer entity (kind official / explanation / personal / group / suggestion, owner, visibility) and `annotation.layer_id`; existing rows migrate to the personal layer, server and Dexie (append-only `LOCAL_SCHEMA` bump) with no data change `[srv][web]`. | yes |
| AOS-4.7 | Layer: personal notes | 1 | M | partial | The personal layer lives in the user's vault; the local database is per user and is never pushed under another user's session; sign-out keeps local data by default with the option «امسح بيانات هذا الجهاز عند الخروج», and devices registered as shared always clear (ADR-0003 Q7) `[web][e2e]`. | yes |
| AOS-4.8 | Layer: group comments | 2 | S | missing | Comments anchored with `anchor_json`, visible to the group, separate from ink layers `[srv][web]`. | yes |
| AOS-4.9 | Layer: suggested edits | 2 | S | missing | Suggestion items addressed to an author; accept copies them into the author's layer as a new version, reject keeps the history `[srv]`. | yes |
| AOS-4.10 | Show and hide any layer | 1 | M | missing | Layers panel with visibility toggles saved in the study session; render, hit-test, eraser and lasso respect visibility `[web]`; NFR-P2 holds with three visible layers. | yes |
| AOS-4.11 | Copy one layer or merge several | 1/2 | M | missing | Phase 1: copy **one** personal layer between copies of the same lecture («انقل ملاحظاتي من نسختي إليها», «انسخ الطبقة»): a preview counts items per kind and page, the job copies with new derived ids and per-item attribution, image references are counted, and the source layer never changes `[srv][e2e]`. Phase 2: merge several layers into a new layer `[srv]`. | yes |
| AOS-4.12 | Drawings from one explanation, notes from another | 2 | S | missing | Layer copy with a kind filter (ink/shapes vs text/sticky/notes), attribution per item `[srv][e2e]`. | yes |
| AOS-4.13 | Compare two copies side by side | 2 | S | partial | Same lecture, two layer sets, page-synchronized; a diff marks added and removed items `[e2e]`. | yes |
| AOS-4.14 | Explanation updates with a change preview | 1/2 | M | partial | Phase 1: the author's «انشر إصدارًا جديدًا» with change notes; followers see «تحديث متاح» with a preview («أضاف 12 عنصرًا في 3 صفحات، حذف 2، عدّل 5») and changed pages highlighted; nothing changes until «طبّق التحديث» (default `preview`), or at once with «طبّق التحديثات تلقائيًا» (`auto`); a version can be skipped (ADR-0004 §2.4) `[e2e]`. Phase 2: accept or skip individual changes `[e2e]`. | yes |
| AOS-4.15 | Version History | 1/2 | S | partial | Phase 1: per-layer history from `annotation_revision` (author, time, action, item) listed in the layers panel; nothing is restored from it yet `[srv][web]`. Phase 2: per-document history and the publication version timeline; publication versions are immutable `[srv][web]`. | yes |
| AOS-4.16 | Time Machine restores earlier versions | 2 | S | partial | Restoring a document or layer creates a new version from a past one — never a destructive overwrite, never a whole-server restore `[srv][e2e]`. | yes |
| AOS-4.17 | Stable anchors | 1 | M | partial | Cross-version page/region matching (text + region hashes) for safe migration; manual review list with the move UI `[srv][e2e]`; AC-21 and AC-22 pass. | yes |
| AOS-4.18 | Attribution | 1 | M | partial | `author_id` and the lineage «مشتق من منشور X (الإصدار n) لـ Y» survive fork, copy, merge and export and are shown in the UI `[srv][e2e]`. | yes |
| AOS-4.19 | Suggest corrections without editing the author's work | 2 | S | missing | Suggestion items to the author (AOS-4.9) with notification and audit; the author accepts or rejects `[srv][e2e]`. | yes |
| AOS-4.20 | Personal notes never lost on updates | 1 | M | partial | Official updates, explanation updates, moderation hides and purges never delete a personal layer; purging an official lecture with personal layers is refused or detaches them `[srv]`; notes migrate or stay listed for review (Scenario 4). | yes |

### 7.5 §5 Social Academic Network & Lecture Marketplace

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-5.1 | Every student has a Profile | 2 | M | missing | Profile page (display name, handle), private by default: `profile_visibility` defaults to `only_me` and others see only the display name, which a test asserts; each other field is shown per its own visibility setting `[srv][e2e]`. | yes |
| AOS-5.2 | Optional academic information | 2 | S | missing | Optional university and stage linked to channel nodes, each with its own visibility `[srv]`. | yes |
| AOS-5.3 | Published explanations on the profile | 2 | M | missing | Lists publications filtered by the viewer's permission (followers-only items hidden from non-followers) `[srv]`. | yes |
| AOS-5.4 | Follower count | 2 | S | missing | Exact count from follow rows; no rounding up or seeding `[srv]`. | yes |
| AOS-5.5 | Lecture series on the profile | 2 | C | missing | Lists the author's series (AOS-5.19) `[web]`. | yes |
| AOS-5.6 | Most-used files | 2 | C | missing | Ranked by privacy-preserving counters (forks, follows, distinct active users) that never reveal who opened what `[srv]`. | yes |
| AOS-5.7 | Ratings and contributions | 2 | S | missing | Average rating with its count and the number of accepted corrections and answers `[srv]`. | yes |
| AOS-5.8 | Explanation updates | 2 | S | missing | Timeline of publication versions with change notes `[web]`. | yes |
| AOS-5.9 | Subjects the student publishes in | 2 | C | missing | Derived from publications × channel subjects, filtered by viewer `[srv]`. | yes |
| AOS-5.10 | Follow / Unfollow | 2 | M | missing | Follow rows with optional approval for private profiles, notifications and rate limits `[srv][e2e]`. | yes |
| AOS-5.11 | Follow a student in one subject only | 2 | S | missing | Follow with a subject scope; feed and notifications respect it `[srv]`. | yes |
| AOS-5.12 | Publish publicly or inside a channel | 1/2 | M | conflict | Publish = immutable snapshot of a layer (+ attachments) with a visibility; Phase 1 course-only, Phase 2 public / followers / specific users; labelled «شرح طالب» and never evidence by default `[srv][e2e]`. ADR. | yes |
| AOS-5.13 | Like | 2 | S | missing | One like per user per publication, rate-limited `[srv]`. | yes |
| AOS-5.14 | Save | 2 | S | partial | Saving a publication adds a link (not a copy) to the library `[srv][e2e]`. | yes |
| AOS-5.15 | Share | 2 | S | conflict | Sharing grants visibility or sends an in-app link that opens only for authorized viewers; there are no permanent public file URLs `[srv]`. ADR. | yes |
| AOS-5.16 | Comment | 2 | M | missing | Comments on publications (AOS-21.17) with moderation and reports `[srv][e2e]`. | yes |
| AOS-5.17 | Reuse | 2 | M | missing | Reuse means fork or follow (AOS-4.2/4.3) with attribution kept `[e2e]`. | yes |
| AOS-5.18 | Notifications on explanation updates | 1/2 | M | missing | Phase 1: inbox entry when a followed publication updates `[srv]`; Phase 2: follows, comments and replies; push is optional and honestly gated (iOS PWA limits) `[web]`. | yes |
| AOS-5.19 | Linked explanation series | 2 | C | missing | Ordered publications across lectures of a subject `[srv][web]`. | yes |
| AOS-5.20 | Suggest a correction or addition | 2 | S | missing | Same mechanism as AOS-4.19 `[srv]`. | yes |
| AOS-5.21 | Feed of the subjects the student studies | 2 | M | missing | Visibility-filtered, paginated feed of followed subjects and people; each item says why it is shown; leak test `[srv][e2e]`. | yes |
| AOS-5.22 | Every file private by default | 1 | M | partial | Every new file, source, layer, note and publication defaults to private; access checks in files, sync pull, search, export, offline packages and AI scope; the leak suite passes (X9) `[srv]`. | yes |
| AOS-5.23 | Visibility: Public | 2 | S | conflict | Default meaning: all signed-in users of the deployment (anonymous web pages are an owner decision, Q2); public reads never include private layers; the official file stays members-only, so a non-member sees the explanation over page placeholders with «الملف الأصلي متاح لأعضاء المادة فقط», and items are serialized for them **without** text quotes copied from the page (`anchor.quote`, highlight quotes) and without image annotations cropped from the page (`data.source_crop`) `[srv][e2e]` (AC-01b case). ADR. | yes |
| AOS-5.24 | Visibility: Course Only | 1 | M | conflict | Membership checked before every read `[srv]`. ADR. | yes |
| AOS-5.25 | Visibility: Followers Only | 2 | S | conflict | Follow checked server-side; unfollowing revokes access; copies already on a device are a documented limit `[srv]`. ADR. | yes |
| AOS-5.26 | Visibility: Shared with specific users | 2 | S | conflict | ACL (grantee, read / comment / edit) checked server-side; download tokens bound to the user `[srv]`. ADR. | yes |
| AOS-5.27 | Lecture Marketplace lists students' explanations | 1/2 | M | conflict | Per-lecture listing of the publications the viewer may see, separate from official content (Phase 1 list, Phase 2 sorts) `[e2e]`. ADR. | yes |
| AOS-5.28 | Sort: most used | 2 | S | missing | Privacy-preserving usage counters (AOS-5.6) `[srv]`. | yes |
| AOS-5.29 | Sort: highest rated | 2 | S | missing | Bayesian average over each user's **latest** rating of the publication (re-rating a new version replaces the user's earlier rating, so a ring cannot rate again per version), shown with the real count; raters are approved members of the subject for ≥ 7 days who opened the items `[srv]`. | yes |
| AOS-5.30 | Sort: newest | 2 | S | missing | By `published_at` / `updated_at` `[srv]`. | yes |
| AOS-5.31 | Sort: most complete | 2 | S | missing | Pages with explanation content ÷ total pages, shown as counts («ص 34 من 40») `[srv]`. | yes |
| AOS-5.32 | Sort: best for quick review | 2 | C | missing | Raters' «للمراجعة السريعة» votes plus an explained derived signal (length, summary pages); the author's own tag is shown as a label and never counted `[srv]`. | yes |
| AOS-5.33 | Sort: most documented and corrected | 2 | S | missing | Counts of accepted corrections plus evidence links to lecture regions, the latter capped at one per page so an author cannot inflate it `[srv]`. | yes |
| AOS-5.34 | Ranking uses real quality signals | 2 | M | missing | A documented, versioned ranking function (ratings, forks and follows retained over time, accepted corrections, evidence links, recency) with «لماذا هذا الترتيب؟» `[srv]` (fixture tests). | yes |
| AOS-5.35 | Anti-manipulation | 2 | M | missing | One vote per account, membership/account-age gates, self-votes blocked, ring heuristics, rate limits, audit `[srv]` (synthetic vote rings must not move ranks). | yes |

### 7.6 §6 Lecture Questions & Contextual Discussions

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-6.1 | Discussions linked to lecture content | 2 | M | partial | Human discussion threads in their own tables, anchored with `anchor_json`, visible per subject; the AI chat stays separate and keeps its evidence rules `[srv]`. | yes |
| AOS-6.2 | Question on a drawing (p.12) opens the same place for others | 2 | M | partial | Opening the question shows the lecture at the anchored page and region in the viewer's own copy; on another version it maps across versions or says it cannot `[e2e]`. | yes |
| AOS-6.3 | Q&A linked to pages or elements | 2 | M | partial | Questions and answers carry anchors; pages show discussion pins `[web][e2e]`. | yes |
| AOS-6.4 | Threaded replies | 2 | M | missing | Replies with `parent_id`, edit and delete tombstones, offline drafts through the outbox `[srv][web]`. | yes |
| AOS-6.5 | Accepted answers | 2 | S | missing | Chosen by the question author or a moderator; audit entry `[srv]`. | yes |
| AOS-6.6 | Voting on helpful answers | 2 | S | missing | One vote per user with anti-manipulation (AOS-5.35) `[srv]`. | yes |
| AOS-6.7 | Add a discussion question to the question bank | 2 | S | partial | One tap adds it to the user's bank with a link back; its key is labelled «إجابة مجتمع», never a source key `[srv]`. | yes |
| AOS-6.8 | Flashcard from an answer | 2 | S | partial | The card's origin is «community», low assurance, unless its author links a lecture region `[srv]`. | yes |
| AOS-6.9 | Link a discussion to the related recording | 3 | S | partial | A post can reference a recording moment; the reference opens only for viewers allowed to hear the recording `[srv]`. | yes |
| AOS-6.10 | Search all students' questions in a subject | 2 | M | missing | Discussion index per space, visibility filtered in SQL before ranking; leak test `[srv]`. | yes |

### 7.7 §7 AI Live Lecture Recording

No speech-to-text exists today (`transcribe` maps to no provider; `/api/media/status` reports `requires_configuration`).
Phase 3 adds a **speech orchestrator with pluggable speech providers** (ADR-0006: server-local whisper.cpp / sherpa-onnx,
cloud engines behind explicit consent) and the evaluation harness. No engine is enabled until the harness has run on at
least 30 minutes of the owner's own lectures; until then the capability says «غير مُعدّ», and afterwards it carries the
measured result. Vendor locale lists (Azure, Google and Deepgram list `ar-IQ`; AWS does not) are never treated as
evidence of accuracy. Cloud transcription needs a consent record naming the provider (ADR-0006 §2.12).

**Absolute floors (the pass condition of AOS-7.2–7.7, 21.50 and S1.4).** A report alone never passes these rows: the X10
report must meet owner-confirmed floors **in every stratum** (Iraqi dialect, MSA, code-switched; each ≥ 10 minutes, with
95 % bootstrap intervals reported). Proposed defaults for the owner to confirm or change (Q28) — placeholders chosen so a
transcript is usable for search and the radar, **not** predictions of any engine:

| metric (per stratum) | proposed floor |
|---|---|
| Arabic-token CER | ≤ 0.20 (Iraqi dialect) · ≤ 0.15 (MSA) |
| English-term preservation | ≥ 0.90 |
| medical glossary recall | ≥ 0.80 |
| longest deletion run | < 10 words |

Until the floors are met the rows stay «Blocked / Not met» and the capability label says «قيس ولم يبلغ الحد المطلوب: …»
with the numbers. A subject keeps the label «لم يُقيَّم على محاضرات هذه المادة» until its own lectures are in the set
(ADR-0006 §2.10).

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-7.1 | Smart lecture recording alongside pen writing and the PDF | 3 | M | partial | A lecture-recording session ties audio, lecture version, pages and timeline; chunked resumable upload beyond the 200 MB single-request cap; a purge never deletes a recording shared to a subject; seeking works on the produced format (cue index or remux) `[e2e]` (fake mic) `[dev]`. | partial — real microphones; iPad Safari / native recorder |
| AOS-7.2 | Understand Iraqi-dialect Arabic | 3 | M | missing | An engine is enabled only after the harness ran on the owner's set (≥ 10 minutes in **each** stratum, at least the Iraqi-dialect, MSA and code-switched strata; cloud engines also need the owner's approval of a named provider and each user's opt-in); pass = the X10 report on the owner's evaluation set meets the owner-confirmed absolute floors **in every stratum** (§7.7 intro, ADR-0006 §2.10); until then the row stays «Blocked / Not met» even when a report exists, and the capability label says «قيس ولم يبلغ الحد المطلوب»; no dialect claim before that `[eval]` (3b). | no — Iraqi-capable STT + real lecture audio |
| AOS-7.3 | Understand Modern Standard Arabic | 3 | M | missing | Speech provider behind the speech orchestrator (ADR-0006) with per-user minutes and CPU-minute quotas and cost estimates `[srv]` (fake provider); Arabic WER/CER on the MSA stratum: pass = the X10 report on the owner's evaluation set meets the owner-confirmed absolute floors **in every stratum** (§7.7 intro, ADR-0006 §2.10); until then the row stays «Blocked / Not met» even when a report exists, and the capability label says «قيس ولم يبلغ الحد المطلوب» `[eval]` (3b). | no — STT + Arabic speech samples |
| AOS-7.4 | Understand English | 3 | M | missing | Same adapter; English WER on lecture audio: pass = the X10 report on the owner's evaluation set meets the owner-confirmed absolute floors **in every stratum** (§7.7 intro, ADR-0006 §2.10); until then the row stays «Blocked / Not met» even when a report exists, and the capability label says «قيس ولم يبلغ الحد المطلوب» `[eval]` (3b) (spike: local whisper.cpp RTF 0.21–0.68 on 4 vCPU, read speech only). | no — STT + lecture audio |
| AOS-7.5 | Recognise medical and scientific terms in speech | 3 | S | missing | Vocabulary biasing from the subject vocabulary plus post-correction against lecture text; glossary recall reported by the harness and compared with the owner-confirmed floor `[eval]` (3b). | no — STT with biasing + medical audio |
| AOS-7.6 | Sentences mixing Arabic and English | 3 | M | missing | Code-switched sentences keep Latin terms; the harness reports Arabic WER/CER, English WER, preservation and transliteration counts on the code-switched stratum: pass = the X10 report on the owner's evaluation set meets the owner-confirmed absolute floors **in every stratum** (§7.7 intro, ADR-0006 §2.10); until then the row stays «Blocked / Not met» even when a report exists, and the capability label says «قيس ولم يبلغ الحد المطلوب» `[eval]` (3b). | no — code-switching STT + mixed lecture audio |
| AOS-7.7 | Accurate text that keeps English terms as spoken | 3 | M | missing | Output normalization keeps Latin-script terms verbatim (unit test on synthetic hypotheses) `[srv]`; real quality: English-term preservation pass = the X10 report on the owner's evaluation set meets the owner-confirmed absolute floors **in every stratum** (§7.7 intro, ADR-0006 §2.10); until then the row stays «Blocked / Not met» even when a report exists, and the capability label says «قيس ولم يبلغ الحد المطلوب» `[eval]` (3b). | no — STT + bilingual samples |
| AOS-7.8 | Streaming ASR | 3 | M | missing | Streaming channel with partial and final hypotheses and reconnection, off the ink thread, with per-session caps `[srv][web]` (fake streaming engine); enabled for users only with an engine that passed the AOS-7.2 floors (3b). Raised to M: spec §7 calls live recording «ميزة أساسية جداً». | no — streaming STT |
| AOS-7.9 | Code-switching detection | 3 | S | missing | Language tag per segment/word stored with the transcript `[srv]`. | no — STT with language identification |
| AOS-7.10 | Medical terminology recognition | 3 | S | missing | A recognised-term layer links transcript terms to Course Brain concepts and the terms dictionary `[srv]`. | no — STT |
| AOS-7.11 | Custom vocabulary per subject | 3 | S | partial | Per-subject vocabulary (concepts + moderator list) scoped to the space; user term edits never change other users' retrieval or cache keys `[srv]`; fed to ASR when the engine supports it. | partial — STT supporting vocabulary biasing |
| AOS-7.12 | Speaker diarization when possible | 3 | C | missing | Automatic speaker labels marked «تلقائي»; never guessed without a diarizer `[srv]`. | no — diarization-capable engine + multi-speaker samples |
| AOS-7.13 | Noise reduction | 3 | C | partial | Optional derived denoised copy (original untouched, labelled derived) and a setting `[srv]`. | partial — real classroom audio |
| AOS-7.14 | Voice Activity Detection | 3 | S | missing | VAD pass (sherpa-onnx / whisper.cpp VAD on the server or a WebAudio energy pass) produces speech intervals; tested on synthetic audio `[srv]`. | partial — real lecture audio for tuning |
| AOS-7.15 | Silence detection | 3 | S | missing | Silence intervals stored in a derived table keyed to the audio asset, removed by purge `[srv]`. | partial — real lecture audio for tuning |
| AOS-7.16 | Optional silence skipping, original kept | 3 | S | missing | The player skips silences; every time link (strokes, segments, highlights) stays in original-time coordinates `[web]`. | partial — real lecture audio |
| AOS-7.17 | Split the recording into topics and chapters | 3 | S | missing | As AOS-19K.1–19K.2 `[srv]`. | partial — ASR for real recordings |
| AOS-7.18 | Playback speed and jumping between parts | 3 | S | partial | App-level 0.5×–2× and next/previous part, independent of the browser's native controls `[web]`. | yes |
| AOS-7.19 | Manual transcript correction without breaking time links | 3 | M | have | The corrector's identity is stored; shared transcripts take moderated suggestions instead of a stale-edit 409 `[srv]`. | yes |
| AOS-7.20 | One timeline: the lecturer's speech | 3 | M | partial | A unified timeline entity and view keyed on the recording clock; the device clock offset is recorded `[srv][web]`. | partial — devices for clock behaviour |
| AOS-7.21 | Timeline: the transcript | 3 | M | partial | Transcript segments shown on the same timeline as strokes `[e2e]`. | partial — ASR for automatic transcripts |
| AOS-7.22 | Timeline: the page that was open | 3 | M | partial | The page-view log (AOS-13.3) answers «أي صفحة كانت معروضة في الدقيقة 12؟» `[srv]`. | partial — devices |
| AOS-7.23 | Timeline: pen, drawings and highlighting | 3 | M | partial | Text highlights, text boxes and sticky notes get time links like strokes; the timeline respects tombstones and sync merge rules `[web]`. | yes |
| AOS-7.24 | Timeline: photos the student took | 3 | S | missing | Images inserted or captured during a recording get a time link `[web]`. | yes |
| AOS-7.25 | Timeline: the student's questions and notes | 3 | S | partial | Typed notes, sticky notes, quick-add questions and chat questions get time links `[web][srv]`. | yes |
| AOS-7.26 | Timeline: AI-detected important markers | 3 | S | missing | Exam Radar markers appear on the timeline labelled «إشارة» (cue) or «مولّد آليًا» (AI), never as certain `[web]`. | partial — ASR; AI provider for non-phrase detection |
| AOS-7.27 | Tap a transcript sentence → recording time and page | 3 | M | partial | Automatic segment→page alignment (page-view log, strokes, text similarity) labelled «تلقائي» with confirm/remove; the reader lists a page's segments `[e2e]`. | yes |
| AOS-7.28 | Tap the student's writing → hear what played then | 3 | M | have | Seek reliability checked on each device's recording format `[dev]`; works in copies and followed layers `[e2e]`. | partial — real devices for MediaRecorder seek |

### 7.8 §8 AI Exam Radar & Automatic Question–Answer Detection

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-8.1 | Detect exam-importance cues in the lecturer's speech | 3 | M | missing | Deterministic phrase detector (MSA, Iraqi and English patterns, normalized like search keys) over transcript segments; precision/recall on labelled VTT fixtures reported `[srv]`. Owner-editable phrase list (Q11). | partial — ASR for live speech |
| AOS-8.2 | Cue «هذا سؤال امتحاني» | 3 | M | missing | Detected with the exact quote and time kept as the marker's evidence `[srv]`. | partial — ASR for speech input |
| AOS-8.3 | Cue «ركزوا على هذا الموضوع» | 3 | M | missing | Detected, including variants («ركّزوا على», «انتبهوا لهذا») `[srv]`. | partial — ASR for speech input |
| AOS-8.4 | Cue «هذا مهم جداً» | 3 | M | missing | Detected, including «مهم كلش» and similar Iraqi intensifiers `[srv]`. | partial — ASR for speech input |
| AOS-8.5 | Iraqi cue «دائماً يجي بالامتحان» | 3 | M | missing | Iraqi forms («يجي»، «راح»، «دايمًا») detected on fixtures `[srv]`; live use needs dialect ASR. | partial — Iraqi-capable ASR |
| AOS-8.6 | Cue «ممكن أسألكم عن...» | 3 | M | missing | Detected with the following phrase captured as the topic `[srv]`. | partial — ASR for speech input |
| AOS-8.7 | English question forms («What is the most common cause of…») | 3 | S | missing | Interrogative detector over English spans `[srv]`. | partial — ASR for speech input |
| AOS-8.8 | Create an Exam Highlight on detection | 3 | M | missing | Exam highlight (recording, segment, page, origin cue/AI, status) labelled «إشارة من الدكتور — ليست توقعًا»; covered by purge, backup and export `[srv]`. | yes |
| AOS-8.9 | Save the time and page of each highlight | 3 | M | missing | Time from the segment, page from the page-view log `[srv]`. | yes |
| AOS-8.10 | Identify the actual question when stated | 3 | S | missing | Deterministic window around the cue; optional AI extraction with the transcript as untrusted input; stored with origin «المحاضرة», separate from source questions `[srv]`. | partial — ASR; AI for robust extraction |
| AOS-8.11 | Capture the lecturer's answer | 3 | S | missing | Stored as «قال الدكتور في التسجيل»; never becomes an official answer key (AC-13 rule); Exam DNA ignores radar items `[srv]`. | partial — ASR |
| AOS-8.12 | Distinguish lecturer's answer from AI answer | 3 | M | partial | New origin `lecturer_said` beside source key / owner key / AI-derived, carried into cards and exports `[srv][web]`. | yes |
| AOS-8.13 | Generate an extra answer with explanation and source | 3 | S | partial | A detected question goes through the evidence pipeline (Source Lock lecture-only by default; widening is an explicit user action); abstains when evidence is insufficient `[srv]` (fake provider). | partial — AI key for real output |
| AOS-8.14 | Turn the question into an MCQ or flashcard | 3 | S | partial | Server-side creation from a radar question, labelled generated `[srv]`. | partial — AI key for MCQ generation |
| AOS-8.15 | Add the question to a suggested review list | 3 | S | missing | «مقترح من إشارات المحاضرة» list; the user accepts items into plans; plans never change automatically `[srv][web]`. | yes |
| AOS-8.16 | Exam Radar dashboard after the lecture | 3 | M | missing | Per-lecture view: markers with quote, time, page and status; counts with denominators; «مؤشر وليس احتمال» `[e2e]`. | yes |
| AOS-8.17 | Importance from repetition, context and explicit statements | 3 | S | missing | Repetition counts across segments and lectures plus explicit cues; context scoring only when AI is configured `[srv]`. | partial — ASR; AI for context scoring |
| AOS-8.18 | Never present predictions as certain | 3 | M | partial | A wording test scans radar UI strings and generated card texts for certainty or probability phrases `[web][srv]`. | yes |
| AOS-8.19 | Say so when the answer is unclear or absent | 3 | M | partial | Explicit status «لم يذكر الدكتور الإجابة» / «غير واضحة»; never filled with AI text `[srv]`. | yes |

### 7.9 §9 Unified Live AI Copilot

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-9.1 | Several AI functions running with the recording | 3 | S | missing | A session orchestrator (server job) runs ASR and downstream tasks with per-session budget and rate limits; any task failing never stops the recording (fault injection) `[srv][e2e]`. | no — streaming STT + AI provider |
| AOS-9.2 | Live transcription | 3 | M | missing | Opt-in per recording; partial and final text in the copilot section `[e2e]` (fake engine); available to users only once an engine passed the AOS-7.2 floors (3b). | no — streaming STT |
| AOS-9.3 | Live translation | 3 | C | missing | Task `live_translate` (ARCHITECTURE_DELTA §10.1, §10.3): final segments → a generated translation labelled «ترجمة مولّدة» that keeps English terms verbatim, within the session budget and only under the subject's external-processing policy `[srv]` (fake). | no — STT + AI provider |
| AOS-9.4 | Live summarization | 3 | C | missing | Incremental summary visibly «مسودة» until verified `[srv]` (fake). | no — STT + AI provider |
| AOS-9.5 | Live question detection | 3 | S | missing | The AOS-8.1 detector runs on streaming final segments `[srv]`. | no — streaming STT |
| AOS-9.6 | Live answer assistance | 3 | C | missing | Draft answers marked «مسودة» until claims are validated `[srv]` (fake). | no — STT + AI provider |
| AOS-9.7 | Live topic recognition | 3 | C | missing | Transcript windows matched to Course Brain concepts `[srv]`. | no — streaming STT |
| AOS-9.8 | Live slide synchronization | 3 | C | missing | Suggests «الدكتور على الصفحة 7؟» from transcript↔page similarity or a camera photo (AOS-19A.2); a suggestion only, never an automatic page turn `[web]`. | partial — STT or camera input |
| AOS-9.9 | Live flashcard suggestions | 3 | C | missing | Task `suggest_cards` (ARCHITECTURE_DELTA §10.1, §10.3): from detected questions and their lecture regions, server-side, evidence-validated, each accepted by the user; budgeted per session `[srv]`. | no — STT + AI provider |
| AOS-9.10 | Calm side panel that does not distract | 3 | M | partial | Copilot section «المباشر» in the rail (bottom sheet on phones) that never covers the page or the ink toolbar; no counters; reduce-motion respected `[e2e]`. | yes |
| AOS-9.11 | Example «هذا سؤال مهم: What are the branches of the celiac trunk؟» | 3 | M | missing | A VTT fixture with this sentence yields a detected question linked to the lecture and time `[srv][e2e]`; live speech needs ASR. | partial — ASR for live speech |
| AOS-9.12 | Show the answer when a trusted source exists | 3 | S | partial | Triggered from a detected question; evidence-validated; abstains otherwise `[srv]` (fake). | partial — AI key |
| AOS-9.13 | Add the answer to my notes in one tap | 3 | M | partial | Reuses «احفظ الإجابة كملاحظة» (labelled generated, idempotent) from the copilot `[e2e]`. | yes |
| AOS-9.14 | AI never disrupts recording or pen writing | 3 | M | partial | Fault injection during a recording (provider timeout, 500, quota) leaves recording and strokes intact `[e2e]`; pen latency re-measured with copilot on `[dev]`. | partial — stylus devices for latency |
| AOS-9.15 | Audio, transcription and explanation independent of the drawing UI | 3 | M | partial | Client audio processing runs in a Worker/AudioWorklet; heavy work on the server; no long task on the ink thread during a recording `[e2e]`. | partial — devices |
| AOS-9.16 | Offline recording always | 3 | M | have | Device storage is per user; iPadOS storage eviction checked on device `[dev]`. | partial — real devices (eviction, microphone) |
| AOS-9.17 | Local AI models on capable devices | 5 | C | missing | On-device ASR (whisper / sherpa-onnx through the native shell) behind a per-device capability probe; RTF measured per device `[dev]`. | no — target devices; model size and licence decisions |
| AOS-9.18 | Save content, finish processing when connected | 3 | M | partial | After upload, one processing job per recording version (idempotency key) runs ASR and radar once an engine is configured `[srv]`. | partial — STT provider |
| AOS-9.19 | Never claim every feature works offline | 3 | M | have | Each new capability registers its offline state (e.g. «يعمل دون اتصال: التسجيل والكتابة · يحتاج اتصالًا: التفريغ والتحليل») `[web]`. | yes |

### 7.10 §10 Smart Selection & AI Pen

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-10.1 | Pen-selecting printed text opens the AI menu | 2 | M | partial | A lasso over printed text resolves the regions under the path (text + region ids) and opens the same contextual menu as text selection `[e2e]`; AI entries show the registry reason when unconfigured. | partial — AI key for real output |
| AOS-10.2 | Pen-selecting handwriting/drawing opens the AI menu | 2 | S | partial | Lasso menu over ink offers explain, translate, summarize and cards on the recognized reading, and «اشرح الرسم» via vision; each disabled with a reason when its provider is missing `[web]`. | partial — vision key |
| AOS-10.3 | Pen-selecting an equation opens the AI menu | 5 | C | missing | Equation objects (AOS-1.21) offer explain and step-by-step; printed equations are detected only when a math-OCR provider exists, otherwise the entry is hidden with a reason `[web]`. | partial — math OCR / vision model |
| AOS-10.4 | Pen-selecting an image/figure opens the AI menu | 2 | S | partial | Lassoing a printed figure resolves its figure region → «اشرح الصورة», figure reading, occlusion quiz `[e2e]`. | partial — vision key |
| AOS-10.5 | AI action: Translate | 2 | S | partial | Works on printed text and recognized handwriting; keeps English terms (AOS-10.22); labelled generated; Source Lock lecture-only by default `[srv]` (fake provider). | partial — AI key |
| AOS-10.6 | AI action: Explain Simply | 2 | S | partial | Menu item maps to the existing `simplify` explain path for any resolved selection `[srv][web]`. | partial — AI key |
| AOS-10.7 | AI action: Explain Step by Step | 2 | S | partial | Direct menu item using the `smaller_steps` strategy without a prior explanation `[srv]`. | partial — AI key |
| AOS-10.8 | AI action: Summarize | 2 | S | partial | Summarizes the selected regions; claims validated against those regions; coverage stated `[srv]`. | partial — AI key |
| AOS-10.9 | AI action: Generate MCQs | 2 | S | partial | 1–5 questions per request from a selection (incl. lasso or handwriting reading), each SBA-validated and labelled generated `[srv]`. | partial — AI key |
| AOS-10.10 | AI action: Create Flashcards | 2 | S | partial | Card suggestions generated server-side with evidence; the user accepts each one; the manual card editor path stays (parity G18/G62) `[srv][web]`. | partial — AI key for generated cards |
| AOS-10.11 | AI action: Define Term | 2 | S | partial | «عرّف» looks up the terms dictionary first (deterministic), then offers an evidence-checked AI definition labelled generated `[srv][web]`. | partial — AI key for generated definitions |
| AOS-10.12 | AI action: Pronunciation | 5 | C | missing | Plays an English term's pronunciation (speechSynthesis or TTS provider), labelled «صوت مولّد»; hidden with a reason when the device has no voice `[web]`. | partial — TTS voices on the device or a TTS provider |
| AOS-10.13 | AI action: Read Aloud | 5 | C | missing | Reads a mixed Arabic/English selection in logical run order with pause/stop; origin labels are announced; disabled with a reason without an Arabic voice (AOS-19L.1) `[web][dev]`. | partial — Arabic + English TTS voices |
| AOS-10.14 | AI action: Find Related Lectures | 2 | S | partial | From a selection, searches the user's vault and permitted spaces (Course Brain concepts + FTS) with jump buttons; never returns non-permitted spaces `[srv]`. | yes |
| AOS-10.15 | AI action: Find Verified Sources | 2 | S | partial | Returns real citations (evidence regions) from the lecture and linked references within an explicit scope; never lists student explanations as sources; abstains with a reason `[srv]`. | partial — AI key for entailment |
| AOS-10.16 | AI action: Compare Explanations | 2 | S | partial | Compares 2–3 explanations visible to the viewer for the selected region, side by side with origin labels; the AI comparison table is optional; student explanations never become evidence `[srv][e2e]`. | partial — AI key; publications (Phase 2) |
| AOS-10.17 | AI action: Explain Diagram | 2 | S | partial | Printed figures and the user's own ink diagrams (rasterized crop) are explained through vision, abstaining on uncertain labels `[srv]`. | partial — vision key |
| AOS-10.18 | AI action: Correct Handwriting | 2 | C | partial | Spelling suggestions on the recognized reading shown as a diff the user accepts; stroke beautification follows parity G10/G11 `[web]`. | partial — vision key |
| AOS-10.19 | AI action: Convert Handwriting to Text | 2 | S | partial | Same as AOS-1.15, including insertion as a text box `[web]`. | partial — vision key |
| AOS-10.20 | Attach a voice note to a selection | 3 | S | partial | «أرفق ملاحظة صوتية» records a clip anchored to the selection (text, region or image); it plays from the anchor; private by default `[e2e]` (fake mic). | partial — real microphone |
| AOS-10.21 | Add to Revision from a selection | 2 | S | partial | Revision marks from lasso, handwriting and figure selections store the exact region and appear in revision lists `[web][srv]`. | yes |
| AOS-10.22 | Scientific-context translation that keeps English terms | 2 | S | partial | Rules + terms dictionary applied `[srv]`; term preservation scored on ≥ 50 bilingual medical passages before any quality statement `[eval]`. | partial — AI key + bilingual evaluation set |
| AOS-10.23 | Labelled diagrams → Image Occlusion quizzes | 2 | S | partial | Mask suggestions from OCR word boxes / diagram labels (uncertain labels excluded) that the user edits before saving; reachable from a figure selection `[web][srv]`. | yes |
| AOS-10.24 | Voice explanation linked to part of a page | 3 | S | partial | «سجّل شرحًا لهذه المنطقة» creates a region-anchored clip; strokes written meanwhile carry time links `[e2e]` (fake mic). | partial — real microphone |
| AOS-10.25 | Publish the voice explanation with the student's explanation | 3 | S | conflict | A publication may include region clips; audio is served through access-checked, user-bound tokens; the published version is immutable, attributed and moderated `[srv]`. Rule 8 conflict resolved by the ADR. | yes |

### 7.11 §11 Offline-First & Nearby Classroom Sync

Order of transports (ADR-0005 Part A): **online rooms through the server** ship first; then **offline rooms on the same
Wi-Fi or phone hotspot**, paired by QR or session code and carried by WebRTC DataChannels (measured: 5 MB intact in
0.4–1.4 s between two Chromium processes with no STUN/TURN; star topology; a default of up to 30 devices per host that is
**untested** — only two peers were measured — and each joiner pairs by its own QR exchange); an optional
LAN hub on a laptop; native radios (Nearby Connections, Multipeer, BLE) last, as optional accelerators inside the native
shell. Appendix B has the evidence.

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-11.1 | Nearby devices discover each other and form a local room | 4 | M | missing | A host creates a room; others join by a per-joiner QR exchange on the same Wi-Fi/hotspot over WebRTC (or a LAN hub); the default of 30 devices per host is **untested** (2 peers measured) and labelled so until a device run; the capability registry states per device which transports work `[e2e]` (multi-context) `[dev]`. | partial — two or more physical Android/iOS devices and the native shell |
| AOS-11.2 | Nearby Connections where devices support it | 4 | C | missing | Android native plugin behind the same transport interface, reported per device; never assumed `[dev]`. | no — Android devices + native app with Play services |
| AOS-11.3 | Bluetooth LE for discovery and suitable messages | 4 | C | missing | Native BLE plugin used only for discovery/handshake; web shows «غير متاح في المتصفح» `[dev]`. | no — physical BLE devices + native shell |
| AOS-11.4 | Wi-Fi / local network transfer of files and updates | 4 | M | partial | Lecture packages and deltas move over the LAN; the hub mode documents its limits on plain http (no service worker, no microphone) `[e2e]` `[dev]`. | partial — real classroom Wi-Fi and devices |
| AOS-11.5 | Native networking APIs or supported alternatives per OS | 4 | S | missing | Written comparison and per-OS choice recorded in an ADR, then verified on devices `[dev]`. | no — native toolchains (cloud CI) and devices |
| AOS-11.6 | QR pairing | 4 | M | missing | Per joiner: the host shows a **fresh offer QR for each joiner** and scans that joiner's answer QR (two scans per joiner, said in the UI); the QR carries the room id, the host key fingerprint and the SDP offer — never the room key; the room key travels over DTLS only after the joiner's server-signed offline credential is verified; pairing never waits for ICE «complete»; manual-code fallback only when a server or hub is reachable `[e2e]`. | yes |
| AOS-11.7 | Session codes | 4 | S | missing | Human-friendly base32 room codes, hashed, expiring, rate-limited; usable only when the server or a LAN hub is reachable (a browser cannot listen for connections), which the UI says `[srv][web]`. | yes |
| AOS-11.8 | Real Android ↔ iPhone ↔ iPad compatibility testing | 4 | M | missing | Interop matrix filled from device runs; cells never run read «لم يُختبر (السبب)» `[dev]`. | no — physical Android, iPhone and iPad |
| AOS-11.9 | After joining and consenting, receive the original lecture | 4 | M | missing | Nothing is received before an explicit accept; the offline package format (manifest + per-file sha256) is the transfer unit `[e2e]`. | partial — real nearby transport (simulated between Chromium contexts) |
| AOS-11.10 | Follow the explainer's edits in the room | 4 | M | missing | The explainer's layer streams read-only to followers in the room `[e2e]`. | partial — nearby transport on devices |
| AOS-11.11 | See shared writing and highlighting | 4 | M | missing | Shared layer synced as CRDT updates; all peers converge `[e2e]`. | partial — nearby transport on devices |
| AOS-11.12 | Exchange files and images in the room | 4 | S | missing | Opt-in per item, integrity-checked (AOS-11.26), size-limited `[e2e]`. | partial — nearby transport on devices |
| AOS-11.13 | Send questions inside the room | 4 | S | missing | Room-scoped messages stored locally and synced to the server later `[e2e]`. | partial — nearby transport on devices |
| AOS-11.14 | Receive deltas instead of the whole PDF | 4 | M | partial | A peer that already holds the blob (by sha256) receives only updates and annotation deltas; bytes sent are asserted `[e2e]`. | partial — nearby transport on devices |
| AOS-11.15 | Continue studying when the connection drops | 4 | M | partial | Writing continues locally per user when the room link drops; nothing waits on the network `[e2e]`. | yes |
| AOS-11.16 | Complete transfer and sync when the connection returns | 4 | M | partial | Transfers resume from the last verified chunk (cut at 50 % → ≤ 1 chunk re-sent) `[e2e]`; op sync resumes without duplicates. | yes |
| AOS-11.17 | Sync with the server later | 4 | M | partial | Ops received from a peer reach the server with their original `op_id` and author; the server binds authorship from the bundle signature checked against the origin's server-issued device key, deduplicates by (origin user, server-issued device id, sequence), and authorizes against server-side revocation time through the server-signed room credential the bundle carries, never the bundle's own timestamp; spoofed authors and backdated bundles are rejected `[srv]`. | yes |
| AOS-11.18 | CRDT / operation log for collaborative conflicts | 4 | M | partial | Single-writer layers keep the op-log; multi-writer layers use Yjs; deterministic convergence without the server (3-peer test) `[web]`. | yes |
| AOS-11.19 | Version vectors | 4 | M | missing | Per-replica clocks (Yjs state vectors) drive peer sync; the server sequence stays for the server feed `[web]`. | yes |
| AOS-11.20 | Content hashing | 4 | S | partial | sha256 per chunk and per update batch; mismatches are rejected `[web]`. | yes |
| AOS-11.21 | Retry | 4 | S | partial | Peer transfers use the outbox backoff policy (1 s × 2ⁿ ± 20 %, capped) `[web]`. | yes |
| AOS-11.22 | Chunked transfer | 3 | M | missing | Chunked, resumable upload and download with a per-chunk hash for the server (needed by long recordings in Phase 3) and later for peers `[srv][web]`. Moved before §11's phase for that reason. | yes |
| AOS-11.23 | Encrypted connections | 4 | M | partial | Peer links use DTLS with the identity checked against the QR fingerprint `[e2e]`; multi-user server deployments require TLS and a Secure cookie (NFR-S2) `[srv]`. | partial — real-device peer links |
| AOS-11.24 | Accept invitations to a local room | 4 | M | conflict | An explicit accept step precedes any data exchange `[e2e]`. ADR. | yes |
| AOS-11.25 | Clear permissions in the local room | 4 | M | conflict | Host / writer / viewer enforced on every peer and re-checked by the server on later sync `[web][srv]`. ADR. | yes |
| AOS-11.26 | Verify file integrity | 4 | M | partial | Files received from a peer are checked by sha256 on the device and kept in **quarantine** there (not opened, previewed or indexed) until they are uploaded and pass the server's content sniffing and safe-zip rules like uploads; until then the UI says «لم يُفحص بعد» `[web][srv]`. | yes |
| AOS-11.27 | Never send private files to other devices automatically | 1/4 | M | partial | Phase 1: sync pull is filtered per user (no other user's rows ever arrive) `[srv]`; Phase 4: room exchange is opt-in per item, and a capture of room traffic contains no private item `[e2e]`. | yes |
| AOS-11.28 | Study store-and-forward / peer relay with consent | 4 | C | missing | Design study + ADR; relayed payloads end-to-end encrypted to the room key; consent per relay `[e2e]` (simulation). | partial — several real devices |

### 7.12 §12 Study Rooms & Live Collaboration

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-12.1 | Silent room: Pomodoro timer | 4 | S | missing | Server-authoritative start and duration, clock-skew safe; a solo timer works offline `[web][srv]`. | yes |
| AOS-12.2 | Silent room: number of students present | 4 | S | missing | Presence count over WebSocket/SSE; no identity shown beyond the room's policy `[e2e]`. | yes |
| AOS-12.3 | Silent room: study goals | 4 | C | partial | Session goals declared on entering the room, private unless shared `[web]`. | yes |
| AOS-12.4 | Silent room: each student's progress, with consent | 4 | S | missing | Explicit opt-in to share a summary (no raw data), revocable per room `[srv]`. | yes |
| AOS-12.5 | Silent room: optional break alerts | 4 | C | missing | Optional alerts announced through `aria-live`, silent by default `[web]`. | yes |
| AOS-12.6 | Group room: same lecture for everyone | 4 | M | missing | Room bound to one lecture version; each participant works in their own copy `[e2e]`. | yes |
| AOS-12.7 | Group room: participant indicators and pages | 4 | S | missing | Live presence with each participant's page `[e2e]`. | yes |
| AOS-12.8 | Group room: instant questions | 4 | S | missing | Room Q&A delivered in real time on the §6 model `[e2e]`. | yes |
| AOS-12.9 | Group room: collaborative editing by permission | 4 | M | missing | Uses AOS-4.4 with room roles `[e2e]`. | yes |
| AOS-12.10 | Group room: group or independent navigation | 4 | S | missing | «اتبع المضيف» broadcasts page events; «تنقّل حر» keeps own page; switchable per participant `[e2e]`. | yes |
| AOS-12.11 | Teaching room: explain with pen and voice | 4 | M | partial | Live stroke streaming; voice over the peer link on the same network; online voice needs a TURN/SFU decision with its cost (Q30) and until then the capability says «الصوت المباشر عبر الإنترنت غير مصمم بعد»; latency measured `[e2e]` (fake mic) `[dev]`. | partial — real microphone and pen |
| AOS-12.12 | Teaching room: watch pen and highlights live | 4 | M | missing | In-progress strokes stream as point batches in normalized page coordinates, at most 10 batches per second per writer and within the per-role frame limits of ARCHITECTURE_DELTA §8.5 `[e2e]`. | yes |
| AOS-12.13 | Teaching room: control writing rights | 4 | S | missing | The host grants and revokes write; enforced on peers and the server `[e2e]`. | yes |
| AOS-12.14 | Teaching room: raise hand and questions | 4 | C | missing | Room events for hand up/down and a question queue `[web]`. | yes |
| AOS-12.15 | Teaching room: record with participants' consent | 4 | M | partial | Each participant gets a consent prompt and the answer is stored; recording waits for consent or excludes non-consenting audio `[e2e]`. | partial — real microphone |
| AOS-12.16 | Teaching room: save and replay the session | 4 | S | partial | A session = recording + room events, replayed by the §13 player `[e2e]`. | yes |
| AOS-12.17 | Exam room: group quizzes | 4 | S | missing | Shared exam definition, per-user attempts, solutions hidden until the room ends `[srv][e2e]`. | yes |
| AOS-12.18 | Exam room: optional timing | 4 | S | partial | Room-synchronized start and clock `[srv]`. | yes |
| AOS-12.19 | Exam room: answer analysis | 4 | S | partial | Group aggregates exclude the viewer's own answers, appear only with ≥ 10 participants (Q15), in coarse buckets; the per-concept table is shown to the host only `[srv]`. | yes |
| AOS-12.20 | Exam room: review mistakes | 4 | S | partial | Each participant reviews their own mistakes with the existing tools `[e2e]`. | yes |
| AOS-12.21 | Exam room: strengthening plan afterwards | 4 | S | partial | «خطة تقوية من هذا الامتحان» per participant in one step `[e2e]`. | yes |

### 7.13 §13 Lecture Replay & Learning Timeline

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-13.1 | Time-stamped writing events with the recording | 3 | M | partial | Every create, edit and erase during a recording appends a timeline event (actor, action, item, recording offset) to an append-only log synced idempotently; replay reconstructs the edits `[web][srv]`. | yes |
| AOS-13.2 | Time-stamped highlighting events | 3 | S | partial | Text highlights carry recording offsets like strokes `[web]`. | yes |
| AOS-13.3 | Time-stamped page navigation events | 3 | M | missing | Page-view and zoom events (debounced) are logged during recordings, private by default, synced like `review_event`, including offline `[web][srv]`. | yes |
| AOS-13.4 | Replay: notes rewritten in sequence | 3 | M | missing | A timeline player draws strokes progressively on the page canvases, driven by the audio clock, with seek and scrub; works offline on downloaded data `[e2e]` (fake-mic recording). | yes |
| AOS-13.5 | Replay: hear the publisher's explanation in sync | 3 | S | partial | Replay of a published explanation plays its (access-checked) audio in sync with its strokes `[e2e]`. Needs AOS-10.25. | yes |
| AOS-13.6 | Replay: jump to a topic | 3 | S | missing | Topic markers from the headings of pages shown and transcript chapters (AOS-19K.2); jump list `[web]`. | yes |
| AOS-13.7 | Replay: change speed | 3 | S | missing | 0.5×–2× changes the audio `playbackRate` and the ink clock together `[web]`. | yes |
| AOS-13.8 | Replay: hide audio or writing | 3 | S | missing | Independent toggles mute audio and hide the ink animation `[web]`. | yes |
| AOS-13.9 | Replay: synchronized transcript | 3 | S | partial | Transcript pane beside the replay highlights the current segment; tapping seeks; works with imported VTT now and ASR later `[e2e]`. | partial — STT for automatic transcripts |
| AOS-13.10 | Replay: copy a snapshot or drawing into own files | 3 | S | partial | «لقطة» copies a page region (printed content as an image) and/or strokes into a note page, with attribution when not own `[web][srv]`. | yes |
| AOS-13.11 | Replay: jump to an important exam question | 3 | S | missing | Exam highlights (AOS-8.8) and exam-linked pages appear as timeline markers; a jump seeks time and page `[e2e]`. | yes |
| AOS-13.12 | Study Time Machine: lecture state at a given moment | 3 | S | missing | Rebuilds a document's layer state at time T from the operation history (read-only view) and can restore it as a new version; purge and erasure remove the history `[srv][web]`. | yes |

### 7.14 §14 AI Tutor & Intelligent Learning

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-14.1 | A private AI tutor per student | 1/5 | M | partial | Phase 1: per-user Source Lock, settings, usage and cache keys with user + visibility (an artifact built with private notes is never served to another user) `[srv]`; Phase 5: tutor features over the user's lectures, files and notes. | partial — AI key |
| AOS-14.2 | Answer questions about the subject | 5 | S | partial | Course-wide or multi-lecture conversation within an explicit scope `[srv]` (fake). | partial — AI key |
| AOS-14.3 | Simplify complex concepts | 5 | S | have | Real-model evaluation recorded once a key exists `[eval]`. | partial — AI key |
| AOS-14.4 | Explain in Arabic keeping English terms | 5 | S | have | Per-user dialect/level settings; evaluation set scored once a key exists `[eval]`. | partial — AI key |
| AOS-14.5 | Examples and applied cases | 5 | S | have | Generated labels and evidence checks kept per user `[srv]`. | partial — AI key |
| AOS-14.6 | MCQs in several styles incl. USMLE where suitable | 5 | S | partial | Named style profiles: clinical vignette (USMLE-like) for subjects marked medical, generic styles for others `[srv]`. | partial — AI key |
| AOS-14.7 | Create flashcards | 5 | S | partial | Server-side, evidence-validated card generator; the user accepts each card `[srv]`. | partial — AI key |
| AOS-14.8 | Analyse wrong answers | 5 | S | have | Works per user from the vault `[srv]`. | yes |
| AOS-14.9 | Identify weak points | 5 | S | have | Per-user timezone and profile resets `[srv]`. | yes |
| AOS-14.10 | Build review plans | 5 | S | have | Plans may include channel lectures the user follows `[srv]`. | yes |
| AOS-14.11 | Spaced repetition and active recall | 1 | M | have | AC-24 passes per user vault, offline and across two devices `[e2e]`. | yes |
| AOS-14.12 | Summaries from several files | 5 | S | partial | Multi-source selection with per-source coverage (AC-03 style) under Source Lock `[srv]`. | partial — AI key |
| AOS-14.13 | Review the lecture point by point | 5 | S | have | Study Books of official lectures are generated once per space and cached for members `[srv]`. | partial — AI key |
| AOS-14.14 | Explain relations between lectures | 5 | S | partial | The tutor explains relation edges using their recorded reasons, deterministic first `[srv]`. | yes |
| AOS-14.15 | Source-first AI | 1 | M | have | Community content enters retrieval only through the SQL scope filter; AC-05 and AC-29 pass `[srv]`. | yes |
| AOS-14.16 | Show the reference page or recording time | 3 | S | partial | Transcript segments become versioned, low-confidence evidence regions (`needs_review`) citable as «الدقيقة m:ss» `[srv]`. | partial — ASR for real transcripts |
| AOS-14.17 | Separate lecturer's words, generated text and external facts | 3 | S | partial | Origins «قال الدكتور في التسجيل», «مولّد آليًا» and «مرجع» (an uploaded reference source — the spec's external reference — never labelled «رسمي») are shown apart in tutor, radar and copilot answers `[web][srv]`; evidence from the open web stays `not_implemented` and is not required. | partial — ASR |
| AOS-14.18 | AI never invents sources or quotations | 1 | M | have | AC-06 is mandatory for every new generator (copilot, radar, fusion, catch-up, tutor) `[srv]`. | yes |
| AOS-14.19 | State conflicts and weak evidence explicitly | 1 | M | have | Same statuses and «لماذا؟» reasons for every new generator `[srv]`. | yes |

### 7.15 §15 Universal Multimodal Search

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-15.1 | Search text inside PDF files | 1 | M | have | Permission filter in SQL before ranking (as AOS-1.36) `[srv]`. | yes |
| AOS-15.2 | Search handwriting | 2 | S | partial | As AOS-1.37 `[srv]`. | partial — vision key or on-device recognizer |
| AOS-15.3 | Search files and images | 2 | S | partial | Images (captions, OCR text, figure readings) appear in universal search with origin labels `[srv]`. | yes |
| AOS-15.4 | Search drawings and diagrams | 2 | S | partial | Indexes recognized ink drawings, generated diagrams (labelled generated, never evidence) and figure readings `[srv]`. | yes |
| AOS-15.5 | Search audio recordings and transcripts | 3 | S | partial | In-app recordings become searchable once transcribed; hits offer «شغّل من m:ss» `[srv][e2e]`. | partial — ASR |
| AOS-15.6 | Search students' questions and answers | 2 | M | partial | Discussions searchable within permitted spaces, labelled «نقاش — ليس مصدرًا» `[srv]`. | yes |
| AOS-15.7 | Search public student explanations the user may see | 2 | M | conflict | Publications indexed per space with visibility tokens inside MATCH; grouped as «شرح طالب — ليس مصدرًا»; never AI evidence unless explicitly scoped `[srv]`. ADR. | yes |
| AOS-15.8 | Search by typing text | 1 | S | have | Offline local search works per user database `[web]`. | yes |
| AOS-15.9 | Search with an image or screenshot | 2 | M | missing | Query image → local OCR (Arabic + English) → scoped FTS, plus page-image similarity; the query image is never stored as a library source `[srv]`. | partial — real photos for quality |
| AOS-15.10 | Search by photographing a slide in the hall | 2 | S | missing | Perspective/rotation correction and in-app camera capture; precision measured on owner hall photos `[eval]`. | partial — real hall photos |
| AOS-15.11 | Natural-language question in Arabic or English | 2 | S | partial | Question parsing with partial-coverage keyword search now; semantic retrieval when available (AOS-15.13) `[srv]`. | partial — embeddings provider |
| AOS-15.12 | Search by a recorded voice question | 3 | C | missing | The microphone starts only on press; STT turns the question into a text query `[web]` (fake engine). | no — STT provider |
| AOS-15.13 | Semantic search | 2 | S | missing | Embeddings provider or local model; version and scope filtered before ranking; similarity never counts as support; re-indexing reversible; quality measured on Arabic medical text `[srv][eval]`. | partial — embeddings provider or local model |
| AOS-15.14 | Slide picture → lecture and matching page | 2 | M | missing | As Scenario 6 `[srv][e2e]`. | partial — real photos for quality |
| AOS-15.15 | Results with context and jump-to-place buttons | 1 | S | have | Transcript hits add «شغّل من m:ss»; publication and discussion hits jump to their anchor `[e2e]`. | yes |

### 7.16 §16 Knowledge Graph & Connected Learning

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-16.1 | Link similar topics across subjects and lectures | 5 | S | partial | Concept ownership per vault and per space (one user's rename/merge never changes another user's map); cross-course relations; synonyms from the terms dictionary `[srv]`. | yes |
| AOS-16.2 | Example: Hypertension ↔ Cardiology, Renal, Pharmacology | 5 | S | partial | Three-course fixture: the concept page lists all three lectures, including a free-prose synonym once an alias exists `[srv]`. | yes |
| AOS-16.3 | From a topic: where it was explained before | 5 | S | have | Includes channel lectures the user follows `[srv]`. | yes |
| AOS-16.4 | From a topic: related lectures | 5 | S | have | Includes followed channel lectures `[srv]`. | yes |
| AOS-16.5 | From a topic: related questions | 5 | S | partial | The concept page lists linked questions `[web]`. | yes |
| AOS-16.6 | From a topic: illustrations | 5 | S | partial | The concept page lists figures `[web]`. | yes |
| AOS-16.7 | From a topic: the student's older notes | 5 | S | partial | Notes matched by concept name automatically, labelled «مطابقة بالاسم» `[srv]`. | yes |
| AOS-16.8 | From a topic: published explanations | 5 | S | conflict | Lists only explanations the viewer may see, labelled by origin and review status `[srv]`. ADR. | yes |
| AOS-16.9 | From a topic: mastery level | 5 | S | partial | The concept page shows state and estimate with their basis `[web]`. | yes |
| AOS-16.10 | Interactive knowledge graph | 5 | S | partial | Cross-course and whole-library graph with paging beyond the 60-concept cap; keyboard and text twin kept `[e2e]`. | yes |
| AOS-16.11 | Confirmed links separate from AI suggestions | 5 | M | have | AI-proposed relations become a third labelled origin `[srv]`. | yes |

### 7.17 §17 Smart Study Dashboard & Exam Planning

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-17.1 | Current subjects | 2 | S | partial | Home lists followed channel subjects and personal courses `[e2e]`. | yes |
| AOS-17.2 | Progress per subject | 2 | S | partial | Per-subject measures on Home (separate measures, real counts) `[web]`. | yes |
| AOS-17.3 | Unfinished lectures | 2 | S | partial | Lectures with viewed pages below the total, across subjects; opening a file is not completion `[srv]`. | yes |
| AOS-17.4 | Important exam questions | 2/3 | S | partial | Archive importance in Phase 2; lecturer cues from the radar added in Phase 3 `[srv]`. | yes |
| AOS-17.5 | Number of reviews | 2 | S | partial | Completed reviews per day, week and subject from `review_event` `[srv]`. | yes |
| AOS-17.6 | Cards due | 2 | S | have | Per-user timezone `[srv]`. | yes |
| AOS-17.7 | Weak points | 2 | S | have | Shown for the signed-in user only `[srv]`. | yes |
| AOS-17.8 | Study time | 2 | S | missing | Active time (page visible and focused, idle cut-off) recorded as idempotent events and shown as an estimate `[web][srv]`. | yes |
| AOS-17.9 | Exam dates | 2 | S | partial | Exam calendar with several exams; moderator-published dates per subject plus personal ones `[srv][e2e]`. | yes |
| AOS-17.10 | Weekly and monthly goals | 2 | C | missing | Goals (minutes, cards, lectures) with progress from real events, no fake % `[srv]`. | yes |
| AOS-17.11 | Exam Mode gathers lectures and builds a plan | 3 | M | partial | From a subject + exam date: lectures gathered automatically, time allocated by mastery, plan editable (Scenario 5) `[e2e]`. | yes |
| AOS-17.12 | Smart Collections created automatically | 2 | S | missing | Computed views, each stating its rule and denominator `[srv]`. | yes |
| AOS-17.13 | Smart Collection: Important for Exam | 2 | S | partial | Uses archive relevance (+ radar in Phase 3), worded «مؤشر وليس احتمال» `[srv]`. | yes |
| AOS-17.14 | Smart Collection: Need Revision | 2 | S | partial | Active weaknesses, due cards and cards whose source changed `[srv]`. | yes |
| AOS-17.15 | Smart Collection: Most Difficult | 2 | S | partial | FSRS difficulty and lapses, personal accuracy `[srv]`. | yes |
| AOS-17.16 | Smart Collection: Unanswered Questions | 2 | S | partial | Two filters by default: questions never attempted, and discussion questions without an accepted answer (Q13) `[srv]`. | yes |
| AOS-17.17 | Smart Collection: Saved Explanations | 2 | S | partial | Saved publications, saved AI answers and bookmarked explanations in one list `[srv]`. | yes |

### 7.18 §18 Academic Administration & Permissions

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-18.1 | Full administration panel for channels | 1 | M | conflict | Role-gated «إدارة القنوات» area separate from the Personal Control Center; `/admin` is 403/404 without a role (replaces the old "404 for all" probe) `[e2e]`. ADR. | yes |
| AOS-18.2 | Manage universities, stages and courses | 1 | M | conflict | Tree CRUD with audit and an impact preview before deletes `[srv][e2e]`. ADR. | yes |
| AOS-18.3 | Create subjects and lectures | 1 | M | partial | Moderators create subjects and lectures in the space (with templates) `[e2e]`. | yes |
| AOS-18.4 | Upload official files and approve them | 1 | M | partial | States draft → approved → published; Contributor uploads need approval; the official flag is distinct from student uploads `[srv][e2e]`. | yes |
| AOS-18.5 | Manage join codes and invitations | 1 | M | conflict | List, revoke, expire and count uses, all audited `[srv]`. ADR. | yes |
| AOS-18.6 | Roles Admin, Assistant, Subject Moderator, Contributor, Student | 1 | M | conflict | Role assignments per node with inheritance; central authorization; permission-matrix tests (§4.3) `[srv]`. ADR. | yes |
| AOS-18.7 | Review published explanations | 1/2 | M | missing | Phase 1: a moderator of the subject hides or restores a publication with an Arabic reason; the author is notified; an audit entry is written; followers keep what they had `[srv][e2e]`. Phase 2: the queue of publications awaiting approval before «عام», approve, request changes, and «راجعه مشرف المادة» (Subject Moderator only) `[srv][e2e]`. | yes |
| AOS-18.8 | Review reports | 1/2 | M | missing | Phase 1: report (reporter, target, reason incl. `patient_identifiers` and `copyright`) → the subject's moderators' queue → hide or dismiss with a reason; one open report per reporter per target; rate-limited; reporter and author notified; audit `[srv][e2e]`. Phase 2: appeals, reports on discussions and profiles, report statistics `[srv]`. | yes |
| AOS-18.9 | Correct official lectures | 1 | S | partial | Role-gated corrections: a draft version may be corrected in place; a correction of a **published** official version creates a new official version that goes through the page map and note migration of Scenario 4 (published regions are immutable); students with copies are notified; personal layers stay attached `[srv]`. | yes |
| AOS-18.10 | Manage official lecture versions | 1 | M | partial | Publishing a new version delivers version stubs to holders found through the system `lecture_copy` index with a note-migration report (Scenario 4) `[srv][e2e]`. | yes |
| AOS-18.11 | Review duplicate files | 1 | S | partial | Admin screen of byte-identical and near-duplicate files within the space only `[e2e]`. | yes |
| AOS-18.12 | Manage content rights and access | 1/2 | M | conflict | Phase 1: per-resource access policy `[srv]`; Phase 2: rights metadata (licence, «لأعضاء القناة فقط») enforced at publish time and takedown through reports `[srv]`. ADR. | yes |
| AOS-18.13 | Notifications and updates | 1 | M | missing | In-app inbox (AOS-21.31) for joins, approvals and new versions `[srv][e2e]`. | yes |
| AOS-18.14 | Audit log | 1 | M | partial | Entries carry actor user id, role and scope; the admin view filters by scope; no private content appears in before/after snapshots `[srv]`. | yes |
| AOS-18.15 | Usage statistics | 2 | S | partial | Channel usage (active members, lecture opens) with privacy thresholds (minimum group size) `[srv]`. | yes |
| AOS-18.16 | Content quality statistics | 2 | S | partial | Reports, accepted corrections and ratings per publication and subject `[srv]`. | yes |
| AOS-18.17 | Never mix official lectures with personal explanations | 1 | M | partial | Origin labels everywhere; the AI cache key carries user and official dimensions; an artifact built from a student explanation is never served for an official-lecture request `[srv]`. | yes |
| AOS-18.18 | Show where each file comes from | 1 | M | partial | Uploader, official status and publication/fork lineage shown with the existing provenance (file, version, page, region) `[e2e]`. | yes |

### 7.19 §19 Next-Generation Features (A–L)

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-19A.1 | Smart Lecture Camera: photograph the screen or board | 3 | S | partial | In-lecture camera capture (getUserMedia on web, native camera in the shell) keeps the original photo and links it to the recording time `[e2e]` (fake camera) `[dev]`. | partial — real camera for capture UX |
| AOS-19A.2 | Recognise the photographed slide and match it to the lecture | 3 | S | missing | Same matcher as Scenario 6 (built in Phase 2), with a labelled confidence and abstention `[srv]`. | partial — real slide photos |
| AOS-19A.3 | Link the photo to the recording time | 3 | S | missing | Image annotations get an audio link (as AOS-7.24) `[web]`. | yes |
| AOS-19A.4 | Extract the board drawing as a note | 5 | C | missing | Board segmentation, deskew and cleanup into a note page labelled derived; original kept `[srv]`. | partial — real board photos |
| AOS-19B.1 | AI Lecture Fusion: one study summary from recording, file, writing, questions, photos | 5 | S | partial | Fused summary under Source Lock: lecture file (evidence), transcript (low-confidence source), own notes (low assurance, opt-in), radar questions, photos; claims validated `[srv]` (fake). | partial — ASR; AI key |
| AOS-19B.2 | Every fused element keeps its original reference | 5 | S | partial | New evidence kinds for recording time, annotation anchors and photos; the user's writing is never moved or edited (AC-22) `[srv]`. | partial — ASR; AI key |
| AOS-19C.1 | Smart Crowd Notes: one organised group explanation | 5 | S | conflict | A collective document in a space (CRDT), every contribution with author and provenance and an approval role `[srv][e2e]`. ADR. | yes |
| AOS-19C.2 | Suggest duplicate removal in crowd notes | 5 | S | partial | Lexical duplicate suggestions for contributions; the author or moderator decides; «ليست مكررة» is remembered `[srv]`. | yes |
| AOS-19C.3 | Source and approval of every item stay visible | 5 | S | partial | Each item shows its source and who may approve it `[web]`. | yes |
| AOS-19D.1 | Professor vs Reference Check | 5 | C | missing | Transcript as a versioned source compared with chosen references; widening scope is an explicit user action `[srv]` (fake). | partial — ASR; AI key |
| AOS-19D.2 | Flag possible contradictions without declaring either wrong | 5 | C | partial | Shown as «تعارض محتمل — لم يُتحقق منه» unless the independent verifier confirms `[srv]`. | partial — AI key for the verifier |
| AOS-19E.1 | Adaptive path: topics to review before a new one | 5 | S | partial | Opening a lecture surfaces weak prerequisites with their reasons `[web][srv]`. | yes |
| AOS-19E.2 | Personal study order from prerequisites and weaknesses | 5 | S | partial | The planner can order lectures by prerequisites, explained per item `[srv]`. | yes |
| AOS-19F.1 | One-Tap Catch-Up for a missed lecture | 5 | S | missing | «عوّض المحاضرة» builds a package for a channel lecture the user has not opened by the next lecture (definition Q16) `[e2e]`. | yes |
| AOS-19F.2 | Catch-up: the official lecture | 5 | S | missing | Package links the official lecture and its latest version `[srv]`. | yes |
| AOS-19F.3 | Catch-up: available explanations | 5 | S | conflict | Lists only publications visible to the user `[srv]`. ADR. | yes |
| AOS-19F.4 | Catch-up: recording summary where sharing is allowed | 5 | S | conflict | Included only with the recorder's share permission and recorded lecturer consent; summary from the transcript, labelled generated `[srv]`. ADR. | partial — ASR |
| AOS-19F.5 | Catch-up: most important questions | 5 | S | partial | Linked questions plus radar markers `[srv]`. | yes |
| AOS-19F.6 | Catch-up: what changed since the last review | 5 | S | partial | Per-user diff since the last viewed version/time `[srv]`. | yes |
| AOS-19F.7 | Catch-up: quick make-up plan | 5 | S | partial | Time-bounded revision session targeting the missed lecture `[srv]`. | yes |
| AOS-19G.1 | AI Study Companion aware of page, topic, recording and permitted files | 5 | S | partial | The rail assistant receives page, topic and recording context, and files only with the user's permission (explicit scope picker) `[srv][web]` (fake). | partial — AI key |
| AOS-19G.2 | Suggest actions without flooding the screen | 5 | S | partial | One quiet suggestion slot, rate-limited (≤ 1 per 10 min by default), dismissals remembered `[web]`. | yes |
| AOS-19H.1 | Smart Lecture Identity linking copies, explanations, questions, recordings | 1 | M | partial | A stable lecture identity in the space links versions, copies, publications, questions and recordings; personal copies map to it; official updates arrive as version stubs `[srv]`. | yes |
| AOS-19H.2 | Identity survives renamed or re-uploaded files | 1 | M | partial | Fingerprint matching proposes the same identity (AOS-3.11) `[srv]`. | yes |
| AOS-19I.1 | Corrections and scientific review system | 2 | S | partial | Proposal → reviewer → accept/reject with history per space `[srv][e2e]`. | yes |
| AOS-19I.2 | Official content marked distinctly | 1 | M | partial | «رسمي» badge with publisher and version `[web]`. | yes |
| AOS-19I.3 | Student contributions marked distinctly | 1 | M | conflict | «شرح طالب» badge with author `[web]`. ADR. | yes |
| AOS-19I.4 | Supervisor-reviewed explanations marked distinctly | 2 | S | conflict | «راجعه مشرف المادة · التاريخ» names the role and date and is given only by a Subject Moderator of that subject (not by an Assistant); no "verified" or certainty wording `[web][srv]`. ADR. | yes |
| AOS-19I.5 | Machine-generated content marked distinctly | 1 | M | have | Applies to every new generator and to published content containing AI output `[web]`. | yes |
| AOS-19J.1 | Universal Study Session across phone, tablet, computer | 1 | M | have | Per user; a newer server copy is never overwritten silently `[e2e]` (AC-24 style, two contexts). | yes |
| AOS-19K.1 | Smart Lecture Chapters: detect topic transitions | 3 | S | missing | Transcript windows aligned to PDF headings and the page-view log, labelled «تلقائي» `[srv]`. | partial — ASR |
| AOS-19K.2 | Turn the recording into interactive chapters | 3 | S | missing | Chapter entity and chapter list in the player and replay `[web]`. | partial — ASR |
| AOS-19K.3 | Summary and questions per chapter | 3 | C | missing | Per-chapter generation with transcript evidence (low confidence) `[srv]` (fake). | partial — ASR; AI key |
| AOS-19L.1 | Read-aloud (text-to-speech) | 5 | S | missing | As AOS-10.13; available for cards and selected text (parity G63) `[web][dev]`. | partial — devices with Arabic TTS voices |
| AOS-19L.2 | Enlarge elements | 1 | S | have | New screens scale with the text-size setting `[e2e]`. | yes |
| AOS-19L.3 | High contrast | 1 | S | partial | In-app high-contrast toggle beside the OS setting (and e-ink mode) `[web]`. | yes |
| AOS-19L.4 | Keyboard control | 1 | M | have | Every new feature passes keyboard-only e2e checks `[e2e]`. | yes |
| AOS-19L.5 | Work well on low-performance devices | 1 | S | partial | A «خفيف» mode (render caps, no paper texture, fewer live effects) tested on a low-end Android phone `[dev]`. | partial — real low-end devices |
| AOS-19L.6 | Settings to reduce battery use | 3 | S | missing | Battery saver: no live AI, lower recording bitrate, fewer sync passes; drain measured per device (X2) `[dev]`. | no — real devices to measure battery |
| AOS-19L.7 | Settings to reduce storage use | 3 | S | partial | Storage saver: drop device copies of uploaded recordings, lower raster resolution; shows bytes freed `[web]`. | yes |

### 7.20 §20 UI/UX Design Requirements

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-20.1 | Apple-like minimal design with an original identity | 1 | M | have | New screens use only design-system tokens and components (lint + visual check at 390 / 1280, light and dark); a clean-room review is recorded per phase. | yes |
| AOS-20.2 | Dark and Light mode | 1 | M | have | E-ink mode added (AOS-OC.5); new screens pass the light/dark visual check. | yes |
| AOS-20.3 | Excellent Arabic RTL without breaking English order | 1 | M | have | `g6-ac20` covers the new screens `[e2e]`. | yes |
| AOS-20.4 | Tablet-first for pen writing | 1 | M | partial | Workspace layouts verified at iPad portrait/landscape widths in CI `[e2e]`; pen-only mode on by default when a pen is detected `[web]`; the native shell and ink surfaces (AOS-OC.2/OC.3/OC.4) tested on devices when they land `[dev]`. | partial — iPad + Pencil, Samsung + S Pen, BOOX via TestFlight / Play internal testing |
| AOS-20.5 | Phone and desktop interfaces | 1 | M | have | A real iPhone Safari run is logged once per phase `[dev]`. | yes |
| AOS-20.6 | Smooth, calm animations | 1 | S | have | Reduce-motion and e-ink mode remove motion on new screens `[web]`. | yes |
| AOS-20.7 | Command Palette | 2 | S | partial | Ctrl/⌘K opens an action palette (open lecture, new page, switch tool, start recording, join a channel …) with search; usable by keyboard only `[e2e]`. | yes |
| AOS-20.8 | Quick keyboard shortcuts | 1 | S | have | Shortcut help sheet («?») lists every shortcut `[web]`. | yes |
| AOS-20.9 | Contextual toolbars only when needed | 1 | S | have | New contextual bars (layers, discussion pin, recording) follow the same pattern `[web]`. | yes |
| AOS-20.10 | Distraction-free fullscreen | 1 | S | have | Regression only `[e2e]`. | yes |
| AOS-20.11 | Drag and drop between files | 2 | S | partial | Drag a selection between open tabs/split panes and into a notebook; drop a file on a page to insert an image or create a source; copy/paste stays as the keyboard alternative `[e2e]`. | yes |
| AOS-20.12 | Open multiple files | 1 | S | partial | Tabs (AOS-1.27) plus split view; ≥ 8 open documents with restored places `[e2e]`. | yes |
| AOS-20.13 | Dedicated recording interface | 3 | M | partial | Live-lecture mode: recording bar + live transcript (when configured) + markers + calm copilot section; on phones it never covers the page or the ink toolbar `[e2e]`. | partial — real microphone; STT for live transcript |
| AOS-20.14 | Dedicated writing interface | 1 | S | have | Regression only `[e2e]`. | yes |
| AOS-20.15 | Dedicated review interface | 1 | S | have | Regression only `[e2e]`. | yes |
| AOS-20.16 | Clear Loading state | 1 | S | have | New long jobs (conversion, matching, migration, ASR) show stage + real counts `[web]`. | yes |
| AOS-20.17 | Clear Offline state | 1 | M | have | Channel screens show cached content read-only with the reason `[e2e]`. | yes |
| AOS-20.18 | Clear Syncing state | 1 | M | have | Publication and followed-copy states («تحديث متاح», «يُنزَّل التحديث») added `[web]`. | yes |
| AOS-20.19 | Clear Conflict state | 1 | M | have | Conflicts say whether they come from «جهاز آخر لك» or «مستخدم آخر»; multi-writer layers never show «تعارض» for normal concurrent edits `[web]`. | yes |
| AOS-20.20 | Accessibility support | 1 | M | partial | axe in CI with 0 serious violations `[e2e]`; lasso move/resize by keyboard `[web]`; VoiceOver and TalkBack passes logged `[dev]`. | partial — real screen readers on devices |
| AOS-20.21 | Fast, organized, comfortable for long sessions | 1 | S | partial | NFR-P budgets measured on reference devices `[dev]`; a 5-student task-based usability session per phase with success rates recorded. | partial — real devices and users |

### 7.21 §21 Technical Architecture: data model, security & privacy

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-21.1 | Data model: Users | 1 | M | conflict | System database of users; the legacy owner migrated as user #1 with the vault file moved byte-for-byte (same password, same unused recovery codes); sessions carry `user_id`; per-user vault and local DB; the migration checklist (§9 X8) passes `[srv][e2e]`. ADR. | yes |
| AOS-21.2 | Data model: Universities | 1 | M | conflict | Channel node level «جامعة» `[srv]`. ADR. | yes |
| AOS-21.3 | Data model: AcademicYears | 1 | S | missing | Channel level «سنة دراسية», distinct from stage `[srv]`. | yes |
| AOS-21.4 | Data model: Stages | 1 | S | missing | Channel level «مرحلة» `[srv]`. | yes |
| AOS-21.5 | Data model: Courses | 1 | M | partial | Shared channel course plus a mapping from a user's personal course node `[srv]`. | yes |
| AOS-21.6 | Data model: Subjects | 1 | M | partial | Shared channel subject with **one space per subject** from Phase 1; a moderator's powers and the Course Brain namespace stop at the subject `[srv]`. | yes |
| AOS-21.7 | Data model: Lectures | 1 | M | partial | Lecture identity with number, date, official status and channel placement `[srv]`. | yes |
| AOS-21.8 | Data model: LectureVersions | 1 | M | have | Publisher and «published official» flag added; versions shared by all copies `[srv]`. | yes |
| AOS-21.9 | Data model: Files | 1 | M | partial | Uploader, visibility and per-user quota accounting; `GET /files/:id` and token minting check access (cross-user test) `[srv]`. | yes |
| AOS-21.10 | Data model: Assets | 1 | S | have | Image and audio assets inherit access from their parent resource `[srv]`. | yes |
| AOS-21.11 | Data model: AnnotationLayers | 1 | M | partial | As AOS-4.6 `[srv]`. | yes |
| AOS-21.12 | Data model: InkStrokes | 1 | M | partial | Strokes carry author, layer and document/fork; points packed (NFR-P3) `[srv][web]`. | yes |
| AOS-21.13 | Data model: PageAnchors | 1 | M | have | Cross-version mapping added (AOS-4.17); AC-21/AC-22 pass `[e2e]`. | yes |
| AOS-21.14 | Data model: DocumentForks | 1 | M | missing | Fork graph as AOS-4.1–4.3 `[srv]`. | yes |
| AOS-21.15 | Data model: Follows | 1/2 | M | missing | Phase 1: course follows (AOS-2.16) `[srv]`; Phase 2: person follows with optional subject scope `[srv]`. | yes |
| AOS-21.16 | Data model: Publications | 1 | M | missing | Publication + immutable publication versions (layer snapshot, visibility, lecture version, author) `[srv]`. | yes |
| AOS-21.17 | Data model: Comments | 2 | M | missing | Comment/discussion rows with anchors, parent ids, moderation state and tombstones `[srv]`. | yes |
| AOS-21.18 | Data model: Permissions | 1 | M | conflict | Role assignments, ACL grants and one central policy check `[srv]`. ADR. | yes |
| AOS-21.19 | Data model: StudyRooms | 4 | M | missing | Room (kind, channel scope, lecture version, host, settings) `[srv]`. | yes |
| AOS-21.20 | Data model: RoomSessions | 4 | M | missing | Session (start, end, participants, consent records, recording, events) `[srv]`. | yes |
| AOS-21.21 | Data model: AudioRecordings | 3 | M | partial | Recorder identity, consent records and distribution scope added `[srv]`. | yes |
| AOS-21.22 | Data model: TranscriptSegments | 3 | S | have | Language tag per segment (code-switching) and corrector identity added `[srv]`. | yes |
| AOS-21.23 | Data model: TimelineEvents | 3 | M | partial | Unified append-only timeline events (page turns, strokes, highlights, notes, photos, questions, exam highlights) keyed to a recording `[srv]`. | yes |
| AOS-21.24 | Data model: ExamHighlights | 3 | M | missing | As AOS-8.8; included in purge, backup and export `[srv]`. | yes |
| AOS-21.25 | Data model: Questions | 2 | S | partial | Discussion questions as their own entity; question banks scoped per user vault and per space `[srv]`. | yes |
| AOS-21.26 | Data model: Answers | 2 | S | partial | Discussion answers with author, accepted flag and votes `[srv]`. | yes |
| AOS-21.27 | Data model: Flashcards | 1 | M | partial | Per user by vault; a deck shared from a publication is copied on use so every user's FSRS state stays separate (Phase 2) `[srv]`. | yes |
| AOS-21.28 | Data model: Reviews | 1/2 | S | partial | Phase 1: FSRS `review_event` per user vault `[srv]`; Phase 2: ratings of explanations as their own entity (meaning confirmed by owner, Q12). | yes |
| AOS-21.29 | Data model: SyncOperations | 1 | M | partial | Author bound from the session, never from the payload; feed and `op_id` scoped per vault; a replayed `op_id` never returns another user's result; `device_unknown`, `not_a_member`, `quota_exceeded` and `op_id_taken` are answered retryable and never recorded, so a queued op succeeds once the cause is fixed `[srv]`. | yes |
| AOS-21.30 | Data model: Devices | 1 | S | partial | Device table (user, server-issued globally unique device id, label, last seen, revocation; P2P keys from Phase 4); the legacy owner's devices are seeded during the migration `[srv]`. | yes |
| AOS-21.31 | Data model: Notifications | 1 | M | missing | Notification (user, kind, ref, read_at) with an in-app inbox and opt-in preferences `[srv][e2e]`. | yes |
| AOS-21.32 | Data model: Provenance | 1 | M | have | Human authorship and fork lineage added without weakening the evidence rule; AC-05/06/07 pass `[srv]`. | yes |
| AOS-21.33 | Data model: AuditLogs | 1 | M | partial | Actor user id, role and scope (AOS-18.14) `[srv]`. | yes |
| AOS-21.34 | Keep large files apart from metadata and sync | 1 | M | have | The R2 object-store adapter keeps content-addressed keys; sync ops still carry metadata only `[srv]`. | yes |
| AOS-21.35 | Encryption in transit | 1 | M | partial | NFR-S2: refuse to start multi-user with an https origin and a non-Secure cookie `[srv]`; Render serves TLS; peer DTLS in Phase 4. | yes |
| AOS-21.36 | Appropriate encryption at rest | 1 | S | missing | NFR-S3 written decision and a tested restore of an encrypted backup `[srv]`; no zero-knowledge claim. | yes |
| AOS-21.37 | Permissions at file, layer, room and channel level | 1 | M | conflict | One policy function; the test matrix covers each resource type × role × visibility × access path `[srv]`. ADR. | yes |
| AOS-21.38 | Files private by default | 1 | M | partial | As AOS-5.22, including the cross-user file, pull, duplicate, search and export checks `[srv]`. | yes |
| AOS-21.39 | Clear consent for recording and sharing audio | 3 | M | partial | Consent records (who, when, scope) are stored and checked: sharing a recording or its transcript beyond the recorder needs **both** the subject's `lecturer_recording_policy` (attested by a Subject Moderator from the lecturer's agreement; it names the allowed scopes, whether external processing is allowed, and that a notice is shown in the hall) **and** the recorder's `recording_share` attestation for that share; a recording outside any subject needs the recorder's attestation per recording; room recordings need every participant's consent `[srv][e2e]`. | partial — real microphone |
| AOS-21.40 | Respect publication rights of university material | 2 | S | partial | Rights metadata per file; publish-time checks (official university files stay members-only); takedown through reports `[srv]`. | yes |
| AOS-21.41 | No distribution of recordings beyond the authorised scope | 3 | M | partial | Scope checked per recording; tokens bound to user and scope; listen-only scope has no download `[srv]`. | yes |
| AOS-21.42 | No model training on user data without consent | 1 | M | partial | Written policy; per-user `ai_processing` consent naming the providers before private notes, handwriting crops or transcripts are sent to an AI provider; lecture audio and transcripts go to an external provider only under the subject's lecturer policy; AI scope never includes another user's private data; cache keys carry user and visibility `[srv]`. | yes |
| AOS-21.43 | Export data according to policy | 1 | M | partial | Per-user export of own data (+ what was shared with them where policy allows); whole-database export, backups and restore are platform operations (ARCHITECTURE_DELTA §5.8) and are never mounted in a space or offered to other users `[srv]`. | yes |
| AOS-21.44 | Delete data according to policy | 1 | M | partial | Account deletion removes the vault, sessions and blob references and never cascades into other users' layers; the user's publications are withdrawn from listings; author names are rendered at read time from the system account, so they show «طالب سابق» everywhere at once; forks others already made are **not** erased and the deletion preview says so; followed copies freeze at their last version `[srv]` (test); backups expire by retention. | yes |
| AOS-21.45 | Limits on files, storage and expensive operations | 1 | M | partial | Per-user and per-space storage quotas; rate limits per user as well as per IP with IP ceilings high enough for a class behind one campus NAT; failed sign-ins slow the account down progressively (no hard lockout that a classmate could trigger) and a recovery code always works `[srv]`. | yes |
| AOS-21.46 | Do not assume AI is free or unlimited | 1 | M | partial | Per-user and per-space AI/ASR quotas (ASR also in CPU-minutes for server-local engines) with an atomic reservation and a visible remaining allowance `[srv][web]`. | yes |

### 7.22 §22 Scenario items in the gap analysis (S1, S5, S6)

Scenarios 2, 3 and 4 have no separate gap items; they are tested end to end in §8.

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-S1.1 | Scenario 1: open PDF, record, write; audio, writing and timing saved | 3 | M | have | §8 Scenario 1 steps 1–6 pass with the fake microphone `[e2e]` and on iPad and Android devices `[dev]`. | partial — real microphone devices |
| AOS-S1.2 | Scenario 1: mixed speech with an important question is detected | 3 | M | missing | §8 Scenario 1 step 7 (ASR variant) passes `[eval]`. | no — STT + real mixed Iraqi/English lecture audio |
| AOS-S1.3 | Scenario 1: documented answer shown when available | 3 | S | partial | §8 Scenario 1 step 8: cited answer or abstention `[srv]` (fake). | partial — AI key |
| AOS-S1.4 | §22: ASR quality on real mixed Arabic–English samples | 3 | M | missing | Harness run on the owner's set with ≥ 10 minutes per stratum (Iraqi dialect, MSA, code-switched; recording conditions noted) before an engine is enabled, and ≥ 2 h in total for the Phase 3b quality report (§9 X10); pass = the X10 report on the owner's evaluation set meets the owner-confirmed absolute floors **in every stratum** (§7.7 intro, ADR-0006 §2.10); until then the row stays «Blocked / Not met» even when a report exists, and the capability label says «قيس ولم يبلغ الحد المطلوب» `[eval]` (3b). | no — real Iraqi/MSA/English lecture recordings with reference transcripts |
| AOS-S1.5 | §22: accuracy of linking audio to pages and writing | 3 | S | partial | §9 X11: stroke offsets within ±250 ms; transcript→page alignment precision reported `[e2e][eval]`. | partial — real devices for clocks |
| AOS-S1.6 | §22: battery use while recording and writing | 3 | S | missing | §9 X2 measured per device class `[dev]`. | no — real devices with battery instrumentation |
| AOS-S5.1 | Scenario 5: pick a subject and the exam date | 3 | M | partial | Subject (channel or personal course) + date picker in Exam Mode `[e2e]`. | yes |
| AOS-S5.2 | Scenario 5: lectures gathered | 3 | M | partial | Lectures of the subject gathered automatically; the user can untick any `[srv][e2e]`. | yes |
| AOS-S5.3 | Scenario 5: documented questions gathered | 3 | M | partial | Questions with a resolved key are separated from unresolved ones `[srv]`. | yes |
| AOS-S5.4 | Scenario 5: lecturer's markers gathered | 3 | M | missing | Radar markers of those lectures included and labelled «مؤشر وليس احتمال» `[srv]`. | partial — ASR for real markers (VTT fixtures here) |
| AOS-S5.5 | Scenario 5: review flashcards gathered | 3 | M | have | Due and new cards of the subject included `[srv]`. | yes |
| AOS-S5.6 | Scenario 5: editable study plan proposed | 3 | M | partial | Plan editable in place (move or remove tasks, change minutes) with history; rebalance respects edits `[srv][e2e]`. | yes |
| AOS-S6.1 | Scenario 6: slide photo → probable lecture | 2 | M | missing | §8 Scenario 6 step 2 passes `[srv][e2e]`. | partial — real hall photos for quality |
| AOS-S6.2 | Scenario 6: matching pages with a confidence level | 2 | M | missing | Pages listed with a labelled confidence and its basis (OCR word overlap, image similarity), no fake percentage `[web][srv]`. | partial — real photos |
| AOS-S6.3 | Scenario 6: no invented result when matching fails | 2 | M | partial | Abstains with «لا تطابق ضمن مصادرك (بُحث في N محاضرة)» or the OCR_FAILED reason `[srv]`. | partial — real photos |

### 7.23 Owner clarifications (added by this PRD — not in the gap analysis)

Status here is this PRD's own reading of the repository at the baseline.

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-OC.1 | Phone-only operation: run, deploy, build and install without a computer | 1/2 | M | missing | Phase 1: from an iPad browser only — deploy from GitHub to Render, run a backup to R2, run restore-verify; Arabic runbook; dry run recorded `[dev]` (a Round 7 task is preparing the Dockerfile, Render blueprint and R2 backups). Phase 2 (PL-1, after decision D-A): trigger a cloud-CI app build and install it through TestFlight; Play internal testing follows with PL-3 `[dev]`. | partial — Render, R2, Apple and Google accounts |
| AOS-OC.2 | Native shell reusing the existing web app, same data model and sync | 1/2 | M | missing | Phase 1: Capacitor project skeleton and CI workflow files pass static checks here. Phase 2 window (PL-1): the iPadOS shell loads the same web build with sync, outbox and capability registry unchanged, built by cloud CI (macOS runner) and installed through TestFlight `[dev]`; the Android shell follows with PL-3. | no — macOS CI runner, Apple Developer and Play Console accounts, devices |
| AOS-OC.3 | iPad native low-latency ink surface | 2 | M | missing | PencilKit or Metal surface with Pencil prediction, pressure, tilt, hover, double-tap/squeeze and system palm rejection where the hardware has them, emitting `InkPoint` strokes into the same outbox; a geometry test proves web and native strokes land at the same normalized coordinates; latency measured (NFR-P1) `[dev]`. Timing: PL-2, in parallel with Phase 2 (§5.3). | no — iPad + Apple Pencil; Xcode via cloud CI |
| AOS-OC.4 | One Android app for Samsung S Pen and BOOX | 3 | M | missing | Front-buffered rendering with motion prediction for S Pen (pressure, tilt, side button); BOOX pen SDK for fast e-ink strokes when present, otherwise the generic path; same stroke model and sync `[dev]`. Timing: PL-3, in parallel with Phase 3 (§5.3). | no — Samsung S Pen tablet, BOOX device, Android SDK in CI |
| AOS-OC.5 | E-ink mode | 1 | M | partial | `data-eink` mode: no animations or transitions, high contrast, black/grey ink palette, paging instead of smooth scrolling, minimal repaint (no live prediction overlay); suggested automatically when the device reports `(update: slow)` or the user picks BOOX (ADR-0005 B.4); visual and unit tests on the web now `[web][e2e]`; checked on a BOOX device `[dev]`. Today only reduce-motion and prefers-contrast exist. | partial — BOOX device |
| AOS-OC.6 | Capabilities detected per device and shown honestly | 1 | M | partial | The pen capability panel extends to native bridges (Pencil, S Pen, BOOX SDK, nearby radios, background audio); nothing is inferred from the device name `[web][dev]`. | partial — devices |
| AOS-OC.7 | Hosting on a persistent-disk host with R2 off-site backups and R2 as the file store | 1 | M | missing | Render deploy with a persistent disk; nightly R2 backups with restore-verify; an R2 object-store adapter for blobs keeping content-addressed keys and refcounts `[srv][dev]`. | partial — Render and R2 accounts |
| AOS-OC.8 | Writing latency and smoothness are first-class requirements | 1 | M | partial | NFR-P1 and NFR-P2 measured and published per platform; dense-page tile cache shipped; the web number is stated honestly next to the native target `[dev][e2e]`. | partial — devices |
| AOS-OC.9 | Published on the App Store and Google Play | 2/3 | M | missing | Phase 2 window: the iPad app is listed on the App Store with privacy labels and an accessibility statement and passes review `[dev]`. Phase 3: the Android app is listed on Google Play the same way `[dev]`. | no — developer accounts and store review |
| AOS-OC.10 | The owner runs the speech-recognition evaluation from an iPad | 3 | M | missing | In-app flow, no terminal: the owner marks segments of their own lecture recordings as evaluation samples; starts an **evaluation-only** engine run that produces drafts without enabling transcription for anyone; corrects the drafts on a phone-friendly screen and marks them reviewed (labelled «مرجع مصحَّح من مسودة آلية»); starts the harness as a server job from the platform section of the Control Center and reads the report there (ADR-0006 §2.10) `[e2e]` (fake engine); a dry run on an iPad is recorded `[dev]`. | partial — iPad dry run; a real engine and the owner's recordings for real numbers |


### 7.24 Items added by the design review (not in the gap analysis)

Spec §23's own instructions, the §21 technology-evaluation demands, and the path that keeps the owner's existing library
connected to official lectures (spec §23 «حافظ على الميزات والبيانات الحالية», §3, §19H). Tag `[doc]` = checked by the
reviewer against the named document.

| ID | Requirement | Ph | Pri | Now | Acceptance criterion (passes when …) | Here · blocker |
|---|---|---|---|---|---|---|
| AOS-19H.3 | Link an existing private lecture to its official lecture («اربط بالمحاضرة الرسمية») | 1 | M | missing | When a private source's sha256 or page fingerprints match an official lecture the user can see, the library and the lecture page offer the link; confirming creates (or reuses) the stub and **copies** the private source's annotations, notes and inserted note pages onto the official version through the `reanchor_copy` job (deterministic ids, previous anchors kept, uncertain items listed for review); the private source and its rows stay untouched until the user deletes them `[srv][e2e]`; part of the X8 owner-migration checklist. | yes |
| AOS-19H.4 | Publish an existing lecture as the official lecture, keeping the uploader's notes | 1 | S | missing | A Subject Moderator (or the platform admin holding that role) promotes a private source they uploaded to an official lecture of the subject: the blob is registered in the space by sha256 (no byte copy), the version is processed in the space, and the uploader's own ink stays private in their vault, linked as in AOS-19H.3; the uploader may then publish chosen layers as an explanation (AOS-5.12) `[srv][e2e]`; part of X8. | yes |
| AOS-21.47 | Modular architecture with the 17 modules of §21 | 1 | M | partial | Each §21 module maps to named server modules and web features (ARCHITECTURE_DELTA §2); a lint rule keeps cross-database access inside the allow-listed modules and space routes inside the allow-list of ARCHITECTURE_DELTA §5.5 `[srv][doc]`. | yes |
| AOS-21.48 | Client technology chosen by measured comparison (Flutter, KMP or native vs a shell) | 1 | S | partial | ADR-0005 spike 4b and Part B record the comparison; the shell decision is re-checked against the first iPad latency measurement (NFR-P1) in the Phase 2 report `[doc][dev]`. | partial — devices |
| AOS-21.49 | Storage, search, CRDT and independent processing services chosen by tests | 1/3 | S | partial | Phase 1: ADR-0003 §2 (SQLite vs PostgreSQL), ADR-0004 §1.4 (Yjs vs Automerge) and §6.2 (R2 vs the host disk) record the measurements `[doc]`. Phase 3: a separate processing worker for ASR and heavy jobs is evaluated by the NFR-OP2 load test before it ships `[srv]`. | yes |
| AOS-21.50 | Local speech models evaluated by real Iraqi-dialect and mixed-term tests | 3 | M | missing | whisper.cpp, sherpa-onnx and any cloud candidate go through the X10 harness on the owner's set; no accuracy is assumed from a model name; pass as AOS-S1.4 (absolute floors per stratum) `[eval]` (3b). | no — real lecture recordings with reference transcripts |
| AOS-23.1 | Final report per phase: what was implemented, what was not, test results | 1 | M | missing | At every phase exit the phase report of §5.2 exists in `docs/`, with the Not-run list and the owner's sign-off of blocked Musts; the next phase starts only after it `[doc]`. | yes |
| AOS-23.2 | Measure performance and improve it before expanding | 1 | M | partial | Before each phase exit: the docs/PERFORMANCE.md budgets and NFR-P2/P3/P5/P6 rerun in CI and are compared with the previous phase; a regression of more than 10 % blocks the exit until it is fixed or the owner accepts it in the report; from Phase 2 the NFR-OP2 load test is part of the gate `[srv][e2e]`. | yes |
| AOS-23.3 | No mock-ups or decorative controls | 1 | M | missing | A Playwright sweep over every screen at 390 and 1280 asserts that each visible control either acts (a network call, a navigation or a state change) or is disabled with a capability or permission reason in its accessible description; it runs in CI from Phase 1 `[e2e]`. | yes |
| AOS-23.4 | Document known problems, limits and operational costs | 1 | M | partial | §6.2 (costs and capacity) and the known-limits list are updated in every phase report, with real usage numbers once deployed `[doc]`. | yes |
| AOS-23.5 | Inspect the repository first; preserve existing features and data | 1 | M | partial | Every track re-verifies the baseline of the rows it owns (§1, BUILD_PLAN §2) and the preservation checklist of ARCHITECTURE_DELTA §15; AC-01a and X8 pass `[srv][e2e]`. | yes |


## 8. End-to-end acceptance scenarios (spec §22)

Spec §22: «لا تعتبر الميزة مكتملة إلا بعد اختبار سيناريوهات حقيقية». Each scenario is an automated end-to-end test against the
real server serving the built app (Playwright), plus a recorded device run where hardware matters. Fixtures are synthetic
and labelled TEST FIXTURE (ARCHITECTURE §5). A scenario that needs something unavailable is reported as **Not run (reason)**,
never as passed.

**Shared fixture world** (built by a fixture script, reused by all scenarios): a university «جامعة تجريبية» → college of
medicine → stage 3 → subject «Anatomy» with official «Lecture 5 — Anatomy of the Abdomen» (40-page bilingual PDF with
printed page labels, figures and a page about the celiac trunk) and lectures 1–8; users **زينب** (student), **حسن** (student
who publishes), **سارة** (Subject Moderator), **مصطفى** (Assistant), **أحمد** (non-member).

### Scenario 1 — Live lecture «المحاضرة المباشرة» (Phase 3)

| | |
|---|---|
| **Covers** | AOS-S1.1–S1.3, 7.1, 7.20–7.28, 8.1–8.9, 8.12–8.13, 8.19, 9.10–9.14, 13.1–13.4, 19A.3 |
| **Variants** | **A — no ASR** (runs here): a VTT transcript of the fixture audio is attached after the recording; **B — ASR** (blocked until an engine is configured and evaluated): the same audio is transcribed by the engine. |
| **Inputs** | fixture audio (≈90 s, mixed Arabic/English, contains «اليوم راح نشرح Anatomy of the Abdomen …» and «هذا سؤال مهم: What are the branches of the celiac trunk؟» at t≈50 s), fed through Chromium's fake audio capture; on devices it is played from a speaker. |

Steps:

1. زينب opens Lecture 5 from the subject page and taps «ابدأ الدراسة» → her personal copy opens in the workspace.
2. She taps «سجّل المحاضرة»; the recording indicator «يُسجَّل الآن» is visible; the copilot section «المباشر» shows
   «التفريغ غير مُعدّ» in variant A.
3. While recording: 3 strokes on p.2 (t≈10 s), turn to p.3 (t≈20 s), highlight a sentence on p.3 (t≈30 s), type a note
   (t≈40 s), insert a photo (t≈45 s).
4. The test injects a provider failure (AI returns 500, then times out) at t≈55 s.
5. The device goes offline at t≈60 s for 30 s; she keeps writing (5 strokes on p.3).
6. She stops the recording and comes back online.
7. Transcript: variant A imports the VTT; variant B waits for the ASR job.
8. The radar runs; she opens the Exam Radar dashboard and the timeline.

Pass when:

* The audio is complete on the device (4 s chunks) during the offline period and uploads after reconnect with the same
  sha256 (`[e2e]`).
* Every stroke, the highlight, the note and the photo carry a recording offset within ±250 ms of the injected time; page
  views for p.2 and p.3 are logged (`[e2e]`).
* The provider failure at step 4 did not stop the recording or lose any stroke (counts before/after).
* Exactly one Exam Highlight exists with the quote, time within ±2 s of 50 s, page 3, and the label «إشارة من الدكتور —
  ليست توقعًا»; the English term «celiac trunk» appears verbatim in the transcript (variant A by construction; variant B
  is the real check).
* The answer card either cites a region of the lecture page about the celiac trunk or abstains with a reason; no medical
  sentence appears without a validated citation (fake provider, AC-06 rules).
* Tapping a stroke plays from its moment; tapping the transcript sentence seeks the audio and opens p.3.
* Variant B (Phase 3b only) additionally reports the harness metrics for the clip, and passes only when the engine in use
  met the owner-confirmed floors on the X10 set (§7.7); a clip-level miss is reported, never hidden.

### Scenario 2 — Copying a classmate's explanation «نسخ شرح طالب» (Phase 1)

| | |
|---|---|
| **Covers** | AOS-2.18–2.19, 4.1–4.3, 4.5–4.7, 4.10, 4.11 (Phase 1 part), 4.14 (Phase 1 part), 4.15 (Phase 1 part), 4.18, 4.20, 5.12 (course-only), 5.18 (Phase 1 part), 5.22, 5.24, 5.27, 18.7 and 18.8 (Phase 1 parts) |

Steps:

1. حسن opens Lecture 5, writes his explanation on p.1–3 (12 strokes, 2 text boxes) in layer «شرحي» and publishes it
   course-only as version 1.
2. زينب opens Lecture 5 → tab «الشروحات» → sees «شرح حسن · الإصدار 1 · ص 3 من 40» → preview → «ابدأ الدراسة» → «نسخة
   متابَعة».
3. She writes personal ink on p.2 (some strokes over حسن's strokes), adds a sticky note and a typed note. Part of this is
   offline.
4. She tries to erase one of حسن's strokes (UI refuses) and the test pushes a raw delete op for it (server refuses).
5. حسن moves one stroke, deletes another, adds 6 strokes on p.4 and publishes version 2 with a change note.
6. زينب comes online, sees «تحديث متاح من حسن», opens «اعرض التغييرات», then taps «طبّق التحديث».
7. Variants: (a) a second student forks version 1 as «نسخة مستقلة» before step 5; (b) a third student follows with
   «طبّق التحديثات تلقائيًا»; (c) a fourth student skips version 2; (d) before step 2 زينب already had «نسختي» with 8
   strokes, and when she creates the followed copy she accepts «انقل ملاحظاتي من نسختي إليها»; (e) after step 6 a member
   reports حسن's explanation (`wrong_content`), مصطفى (Assistant) hides it with a reason, then restores it.

Pass when:

* زينب's personal items are identical before and after the update (hash over her layer's items) and none was deleted.
* Her followed layer equals حسن's version 2 item for item; no conflict copies and no «تعارض» status appear; items حسن did
  not change kept their ids from version 1, so her sticky note attached to one of them still points to it; only the 8
  changed or added items were written and the 1 removed item tombstoned (row counts asserted).
* Step 4: the UI shows the layer as read-only and the server answers with a permission error; nothing changes.
* Before step 6 nothing in her copy changed; the preview names the changes («أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1»)
  and highlights them on the pages; an inbox entry exists.
* Attribution reads «شرح حسن · الإصدار 2»; she can hide and show his layer.
* حسن (and أحمد, the non-member) get nothing of زينب's personal layer through any API: routes, sync pull, search, export,
  files (leak assertions).
* Variant (a): the independent fork still equals version 1. Variant (b): the update applied without a tap. Variant (c):
  the copy stays on version 1 and says so. Variant (d): the 8 strokes exist in both copies, the copies carry attribution
  to her own earlier layer, and her «نسختي» is unchanged. Variant (e): while hidden the explanation leaves the listing and
  followers see «أخفى المشرف هذا الشرح: السبب» but keep what they had; حسن and the reporter are notified; two audit
  entries exist; after the restore the listing shows it again; مصطفى cannot mark it «راجعه مشرف المادة» (403).
* Storage: her copy added a stub and overlay rows only; no blob, chunk or FTS row was duplicated.

### Scenario 3 — No internet «بدون إنترنت» (Phase 4)

| | |
|---|---|
| **Covers** | AOS-11.1, 11.6, 11.9–11.11, 11.14–11.21, 11.23–11.27, 4.4, 12.9 |
| **Here** | three Chromium contexts on one host with WebRTC (no STUN/TURN) and the network to the server blocked. **Devices:** iPad (host) + Samsung tablet + iPhone on a phone hotspot — recorded in the interop matrix, or «Not run (no devices)». |

Steps:

0. While online, each participant's device fetched a short-lived server-signed room credential (user, device key,
   subject membership, expiry 24 h; ADR-0005 A.2).
1. The server is unreachable. زينب (host) creates a room on Lecture 5; for each joiner she shows a fresh offer QR and scans
   that joiner's answer QR; each joiner's credential is verified before the room key is sent over the DTLS link; حسن and a
   third student accept the invitation; roles: زينب host, حسن writer, third student viewer.
2. The host offers the lecture package; حسن already holds the PDF blob, the third student does not.
3. All writers edit a shared layer: 200 strokes in total, including two users moving the same stroke at the same moment
   and one user erasing a stroke another user is recolouring.
4. The link between حسن and the host is cut in the middle of a 20 MB attachment transfer and while حسن writes 50 strokes;
   after 60 s it comes back.
5. The viewer tries to write (UI refuses; the test injects a raw op).
6. Internet returns; every device syncs with the server.

Pass when:

* After step 4 all three replicas have the same state hash; there are no duplicate strokes; the move/move race resolves to
  one stroke in one place; the edit/delete race follows the documented rule (edit wins, as in the server's merge policy).
* حسن received only deltas for the PDF he already had (bytes asserted); the interrupted transfer resumed from the last
  verified chunk (≤ 1 chunk re-sent) and the file was accepted only after its sha256 matched.
* The viewer's write was rejected by peers and, after step 6, by the server.
* After step 6 the server holds every op exactly once (idempotent `op_id`) with the correct author on each.
* A capture of room traffic contains no item from anyone's personal layer and no private file; no QR image contains the
  room key; a fourth device without a valid credential is refused before receiving anything.
* The 20 MB attachment stays quarantined on the receiving devices until it is uploaded and passes the server's checks.

### Scenario 4 — Official lecture update «تحديث المحاضرة الرسمية» (Phase 1)

| | |
|---|---|
| **Covers** | AOS-3.11–3.13, 4.17, 4.20, 18.10, 19H.1–19H.2, 21.13, K6 |

Steps:

1. Version 1 of Lecture 5 (40 pages) is official. زينب writes ink on p.5, highlights text on p.12 and anchors a note to a
   region on p.30. حسن's published explanation covers p.10–14. A Study Book artifact cites a region on p.12.
2. سارة uploads a file named differently («Abdomen lec5 final (1).pdf») where 2 pages were inserted after p.10 and the
   text of p.30 was changed.
3. The system proposes «إصدار جديد من Lecture 5»; سارة previews the page comparison and publishes version 2; the
   confirmation states how many students hold a copy (from the `lecture_copy` index, shown only as a count).
4. Followers receive version 2; زينب opens her copy, sees «يوجد إصدار أحدث من المحاضرة», opens the preview («سيُنقل 2 ·
   يحتاج مراجعة 1 · يبقى على الإصدار 1: 0») and taps **«انقل ملاحظاتي إلى الإصدار 2»**.
5. سارة attempts to purge version 1.
6. Variant (auto): a second student who enabled «انقل ملاحظاتي تلقائيًا» gets the same move without a tap, with the same
   report in the inbox.

Pass when:

* The page map shows p.1–10 → p.1–10, two inserted pages, p.11–40 → p.13–42, and p.30 (now p.32) flagged as changed.
* Before the tap nothing in her copy changed. After it, زينب's p.5 ink appears on v2 p.5 and her p.12 highlight on v2
  p.14 (status «نُقلت بأمان»); the p.30 note is listed under «تحتاج مراجعة» with a side-by-side view and a move control;
  her v1 rows still exist unchanged (counts equal). The automatic variant produces the same result and the same report.
* The migration report gives counts (moved, needs review, unchanged) and no personal item is missing (count before =
  moved + needs review + kept on v1).
* The Study Book citation still points to v1 and a content alert explains the new version; no citation moved silently.
* حسن gets the same migration flow for his explanation layer; زينب's followed layer stays on v1 until حسن republishes, and
  she sees «الشرح مبني على الإصدار 1».
* Step 5 is refused while any vault holds personal items on v1 (the `lecture_copy` index says so; the vaults are not
  scanned); the refusal states the impact as a count.

### Scenario 5 — Exam review «مراجعة الامتحان» (Phase 3)

| | |
|---|---|
| **Covers** | AOS-S5.1–S5.6, 17.11, 17.13, 8.15, 14.10 |

Steps:

1. زينب opens «وضع الامتحان», picks the subject Anatomy and an exam date 14 days ahead, 90 min per weekday.
2. The system gathers lectures 1–8 (incl. an official lecture published yesterday), questions linked to them with resolved
   keys, questions with unresolved keys (separately), radar markers from lectures 5 and 6 (from VTT fixtures), and due cards.
3. She reviews the proposal, removes lecture 2, changes one day to 30 minutes, moves one task, and saves.
4. She goes offline and opens the plan.

Pass when:

* The proposal lists every gathered item with its reason («مرتبطة بالمحاضرة 5», «إشارة من الدكتور — مؤشر وليس احتمال»,
  «بطاقة مستحقة») and real counts; unresolved-key questions are shown apart and not counted as documented.
* Daily capacity is respected; items that do not fit are listed by name, not dropped.
* Edits are saved in place with history; rebalancing keeps her edits.
* No percentage appears without a known denominator; no probability wording.
* The plan is readable offline.

### Scenario 6 — Image search «البحث بالصورة» (Phase 2)

| | |
|---|---|
| **Covers** | AOS-S6.1–S6.3, 15.9, 15.10, 15.14, 19A.2 |

Inputs (generated from the fixtures): (a) p.17 of Lecture 5 rendered, perspective-warped, rotated 7°, with glare and JPEG
quality 60; (b) a slide from an unrelated deck; (c) a heavily blurred photo; (d) a slide from a lecture in a subject زينب is
not a member of.

Steps: زينب opens «ابحث بصورة» and submits (a), (b), (c) and (d) in turn.

Pass when:

* (a) top result is Lecture 5, p.17 («ص 17»), with a labelled confidence («تطابق مرتفع») and its basis (e.g. «تطابق 41
  كلمة من النص المطبوع + تشابه الصفحة»); other candidate pages are listed below.
* (b) «لا تطابق ضمن مصادرك (بُحث في 9 محاضرات)» — no invented result.
* (c) the OCR_FAILED reason «الصورة غير مقروءة» with a retake hint.
* (d) never returns the non-member lecture.
* None of the query images becomes a library source.
* With owner hall photos available, top-1 precision on ≥ 30 photos is reported `[eval]`.

## 9. Additional acceptance tests (§22 «اختبر أيضاً»)

| # | test (spec wording) | steps | pass when | here · blocker |
|---|---|---|---|---|
| X1 | Performance on weak devices «الأداء على الأجهزة الضعيفة» | Open a 300-page lecture and a 5,000-stroke page, write for 2 minutes, zoom and flip pages, in «خفيف» mode, on a low-end Android phone and a BOOX tablet; the same script in CI with CPU throttling ×4. | No long task > 200 ms while writing; zoom ≤ 1 s; no crash; numbers published per device. | partial — CI throttling here; devices for the real run |
| X2 | Battery while recording and writing «استهلاك البطارية» | 60 min of recording + writing at fixed screen brightness, with and without the battery saver (AOS-19L.6), on iPad, Samsung and BOOX. | Drain % per hour recorded per device and mode; no claim without the measurement. | no — real devices |
| X3 | Sync between 3 or more devices «التزامن بين 3 أجهزة أو أكثر» | 3 clients (here: browser contexts; then devices) edit personal layers and one collaborative layer, with random offline periods, 30 minutes. | Server state equals each client state (hash); no duplicate and no lost op; every op exactly once. | yes (contexts) · devices for the device run |
| X4 | Android ↔ iPad when the transport supports it | Scenario 3 with an iPad host and a Samsung client on one hotspot, through the native shell. | Room forms, transfer and shared layer work, or the matrix records which transport failed and why. | no — devices + native shell |
| X5 | Conflicting edits «تضارب التعديلات» | Same note edited on two devices offline; same collaborative stroke moved by two users; edit vs delete. | Personal note: both versions kept (keep-both, labelled «جهاز آخر لك»); collaborative layer: converges without copies; the documented rule is applied in every case. | yes |
| X6 | Transfer cut mid-file «انقطاع النقل في منتصف الملف» | Cut a 200 MB recording upload and a 20 MB peer transfer at 50 %. | Resume from the last verified chunk; no corrupt file accepted; no duplicate source created. | yes |
| X7 | App restart during sync «إعادة تشغيل التطبيق أثناء المزامنة» | Kill the tab (and the native app) during a push of 500 ops and during a pull; reopen. | The outbox resumes; every op applied exactly once; the pull cursor is consistent; nothing lost. | yes (web) · devices for native |
| X8 | Data integrity after restoring a backup «سلامة البيانات بعد استعادة نسخة احتياطية» | (a) Legacy-owner migration (journaled, ADR-0003 §5): backup → move the database to vault #1 → verify, including a crash injected after every journal step; (b) a legacy IndexedDB outbox queued before the upgrade is replayed after it; (c) the owner links existing private lectures to official ones (AOS-19H.3/19H.4); (d) per-vault and per-space backup and restore-verify; (e) operator whole-server restore. | (a) the vault file sha256 equals the pre-move reference before the first boot, and checksums and per-table row counts are recorded again after the first boot; old password and an unused recovery code validate; devices keep their pull cursor and epoch; every injected crash resumes to the same end state, and the server never enters setup mode while a legacy database or vault files exist; (b) every queued op is applied exactly once (none stays `rejected`); (c) every linked item exists on the official version or in the review list, and the private source is unchanged; (d)/(e) restore-verify passes, the blob mark pass finds every referenced blob, and devices re-sync per the epoch rules. | yes |
| X9 | Permissions and possible leaks «الصلاحيات والتسريبات المحتملة» | Matrix: every resource type (file, source, layer, note, publication, discussion, recording, transcript, room, export, offline package, search hit, AI artifact, platform operation) × role (§4.3) × visibility × access path (route, file token, sync pull, search, export, offline package, AI scope, cache hit, duplicate check, notification text) × **two subjects in two universities** in one deployment. | Every forbidden cell returns 403/404 or nothing, with no title or count leaked; tokens are bound to user and scope; a moderator of subject A gets nothing of subject B; a non-member reading a public explanation gets no quote or snapshot of the official page; the platform-operation routes refuse every role but the platform admin; the matrix runs in CI. | yes |
| X10 | ASR quality on real Arabic–English samples «جودة ASR» | Harness run from the Control Center (AOS-OC.10) on owner-supplied lecture segments with reference transcripts, ≥ 10 minutes per stratum (Iraqi dialect, MSA, code-switched). | Report per stratum with 95 % intervals: Arabic WER/CER, English WER, English-term preservation, transliteration count, medical-term recall, real-time factor and CPU-minutes per audio hour, deletion runs; **pass** = every owner-confirmed floor of §7.7 met in every stratum; the capability label is updated only from this report. | no — real lecture recordings + an engine |
| X11 | Accuracy of linking audio to pages and writing «دقة ربط الصوت بالصفحات والكتابة» | Scripted session with known stroke and page-turn times; real session with a manual reference. | Stroke offsets within ±250 ms; page-at-time correct for ≥ 95 % of sampled seconds on the scripted session; real-session precision reported. | partial — devices for the real session |

**Existing acceptance suites stay.** AC-01…AC-30 (`docs/ACCEPTANCE.md`) keep running inside a vault from Phase 1. AC-01 is
split (§3.2, ARCHITECTURE_DELTA §15.3): **AC-01a** — every step of today's AC-01 passes for a user who never joins a
channel, with no channel UI on those screens — and **AC-01b** — no cross-user leakage, two users in two subjects of two
universities, through every route, pull, search, export, file, token, AI scope, notification and WebSocket. Both are
Phase 1 exit criteria. AC-23, AC-24 and AC-30 gain per-user variants (X3, X7, X8).

## 10. Coverage check

Generated from the tables in §7 by the script in BUILD_PLAN Appendix A (one row per item; 495 gap-analysis items + 10 owner-clarification items + 11 design-review items). The status counts of the gap-analysis items equal the gap analysis exactly.

| section | items | have | partial | missing | conflict | Ph1 | Ph2 | Ph3 | Ph4 | Ph5 | here: yes / partial / no |
|---|---|---|---|---|---|---|---|---|---|---|---|
| §1 Notes & document engine | 39 | 23 | 9 | 7 | 0 | 36 | 3 | 0 | 0 | 0 | 33 / 6 / 0 |
| §2 Channels | 19 | 0 | 8 | 5 | 6 | 17 | 1 | 1 | 0 | 0 | 18 / 1 / 0 |
| §3 Smart import | 18 | 5 | 7 | 5 | 1 | 15 | 3 | 0 | 0 | 0 | 18 / 0 / 0 |
| §4 Forks, copies & layers | 20 | 0 | 10 | 10 | 0 | 13 | 6 | 0 | 1 | 0 | 20 / 0 / 0 |
| §5 Social & marketplace | 35 | 0 | 2 | 26 | 7 | 5 | 30 | 0 | 0 | 0 | 35 / 0 / 0 |
| §6 Discussions | 10 | 0 | 6 | 4 | 0 | 0 | 9 | 1 | 0 | 0 | 10 / 0 / 0 |
| §7 Live recording & ASR | 28 | 2 | 10 | 16 | 0 | 0 | 0 | 28 | 0 | 0 | 6 / 12 / 10 |
| §8 Exam Radar | 19 | 0 | 5 | 14 | 0 | 0 | 0 | 19 | 0 | 0 | 7 / 12 / 0 |
| §9 Live copilot | 19 | 2 | 6 | 11 | 0 | 0 | 0 | 18 | 0 | 1 | 3 / 7 / 9 |
| §10 Smart selection & AI pen | 25 | 0 | 21 | 3 | 1 | 0 | 19 | 3 | 0 | 3 | 4 / 21 / 0 |
| §11 Nearby & offline sync | 28 | 0 | 11 | 15 | 2 | 1 | 0 | 1 | 26 | 0 | 14 / 10 / 4 |
| §12 Study rooms | 21 | 0 | 8 | 13 | 0 | 0 | 0 | 0 | 21 | 0 | 19 / 2 / 0 |
| §13 Replay & timeline | 12 | 0 | 5 | 7 | 0 | 0 | 0 | 12 | 0 | 0 | 11 / 1 / 0 |
| §14 AI tutor | 19 | 11 | 8 | 0 | 0 | 5 | 0 | 2 | 0 | 12 | 8 / 11 / 0 |
| §15 Multimodal search | 15 | 3 | 6 | 5 | 1 | 3 | 10 | 2 | 0 | 0 | 7 / 7 / 1 |
| §16 Knowledge graph | 11 | 3 | 7 | 0 | 1 | 0 | 0 | 0 | 0 | 11 | 11 / 0 / 0 |
| §17 Dashboard & exam planning | 17 | 2 | 12 | 3 | 0 | 0 | 16 | 1 | 0 | 0 | 17 / 0 / 0 |
| §18 Administration | 18 | 0 | 10 | 3 | 5 | 16 | 2 | 0 | 0 | 0 | 18 / 0 / 0 |
| §19 Next-generation A–L | 40 | 4 | 20 | 11 | 5 | 10 | 2 | 8 | 0 | 20 | 25 / 14 / 1 |
| §20 UI/UX | 21 | 14 | 7 | 0 | 0 | 18 | 2 | 1 | 0 | 0 | 17 / 4 / 0 |
| §21 Data model, security & privacy | 46 | 6 | 25 | 11 | 4 | 34 | 4 | 6 | 2 | 0 | 45 / 1 / 0 |
| §22 Scenario items (S1, S5, S6) | 15 | 2 | 7 | 6 | 0 | 0 | 3 | 12 | 0 | 0 | 5 / 7 / 3 |
| Owner clarifications (PRD-added) | 10 | 0 | 3 | 7 | 0 | 6 | 2 | 2 | 0 | 0 | 0 / 6 / 4 |
| Design-review additions (§7.24) | 11 | 0 | 6 | 5 | 0 | 10 | 0 | 1 | 0 | 0 | 9 / 1 / 1 |
| **total** | **516** | **77** | **219** | **187** | **33** | **189** | **112** | **118** | **50** | **47** | **360 / 123 / 33** |

Gap-analysis items only: 495 = 77 have + 210 partial + 175 missing + 33 conflict (matches the gap analysis). Phase counts use the phase in which an item *starts* (a `1/2` item counts under Phase 1).

| phase | must (M) | should (S) | could (C) | total |
|---|---|---|---|---|
| 1 | 123 | 60 | 6 | 189 |
| 2 | 25 | 79 | 8 | 112 |
| 3 | 58 | 50 | 10 | 118 |
| 4 | 25 | 19 | 6 | 50 |
| 5 | 1 | 39 | 7 | 47 |

### 10.1 Must rows that cannot be fully tested in this container

Generated from §7. `no` rows pass only on real devices or data; `partial` rows pass here except for a `[dev]` or `[eval]`
part. Each one is either passed on the real thing or listed «Not run (reason)» in the phase report (§5.2).

| phase | `M` rows with Here = no | `M` rows with Here = partial |
|---|---|---|
| 1 | OC.2 | 1.1, 1.2, 1.39, 14.1, 20.4, 20.20, OC.1, OC.5, OC.6, OC.7, OC.8 |
| 2 | OC.2, OC.3, OC.9 | 10.1, 15.9, 15.14, S6.1, S6.2, S6.3, OC.1 |
| 3 | 7.2, 7.3, 7.4, 7.6, 7.7, 7.8, 9.2, S1.2, S1.4, OC.4, OC.9, 21.50 | 7.1, 7.20, 7.21, 7.22, 7.28, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 9.11, 9.14, 9.15, 9.16, 9.18, 20.13, 21.39, S1.1, S5.4, OC.10 |
| 4 | 11.8 | 11.1, 11.4, 11.9, 11.10, 11.11, 11.14, 11.23, 12.11, 12.15 |
| 5 | — | 14.1 |

## 11. Owner questions and assumed defaults

The design proceeds on the default in each row until the owner answers. A changed answer changes only the rows named.
**This is the only numbered list of owner questions.** ARCHITECTURE_DELTA §17 and the ADRs' question sections (ADR-0003 §7,
ADR-0004 §5, ADR-0005 §8, ADR-0006 §4) use these numbers and these defaults; a script-free check is the «Q» column there.

| # | question | assumed default | affects |
|---|---|---|---|
| Q1 | Should anything ever be paid (paid explanations, paid plans)? | **No payments.** The marketplace is a free listing; «Subscribe to Course» means following a subject. | §3.2, AOS-2.16, 5.27 |
| Q2 | What does «Public» mean: every signed-in user of this deployment, or anyone on the internet (anonymous pages, search-engine indexing)? | **Signed-in users only**; no anonymous pages, no indexing. The only new public routes are registration and the join-link preview (channel title only). | AOS-5.23, 15.7, 2.13 |
| Q3 | Open sign-up, or accounts only through class codes, invite links or the platform admin? | **No open sign-up.** An account is created when joining with a valid code or link, or by the platform admin. | AOS-2.11–2.13, 21.1 |
| Q4 | Which university, college and stages come first, and who are the first channel admins? | The owner (user #1) creates one university channel and administers it until delegating. | AOS-2.1, 18.1–18.2 |
| Q5 | Who may publish official lectures directly? | Subject Moderators and Admins publish directly; Contributor uploads are drafts that a Subject Moderator approves; Assistants handle membership and moderation, not official files. Official files are members-only even when an explanation on them is public, and quotes from them are withheld from non-members. | AOS-18.4, 5.23, §4.3 |
| Q6 | Must publications be approved before others see them? | Course-only publications go live at once, with the Phase 1 report → hide/restore flow behind them (AOS-18.7/18.8, Phase 1 parts); Public publications need a moderator's approval (Phase 2). | AOS-5.12, 18.7, 18.8 |
| Q7 | May every member publish explanations, or only approved explainers? | Every member; a subject can restrict publishing to Contributors. | AOS-5.12, §4.3 |
| Q8 | Recording consent: what must be confirmed before a recording leaves the recorder, or is processed outside the deployment? | Private recordings for oneself need only the visible indicator. **Any share** of a recording or its transcript needs **both** the subject's lecturer recording policy (attested by a Subject Moderator from the lecturer's agreement; it names the allowed scopes, whether external processing is allowed, and that a notice is shown in the hall) **and** the recorder's attestation for that share. A recording outside any subject needs the recorder's attestation per recording. **External processing** of lecture audio or its transcript (cloud ASR, an LLM in the copilot or radar) needs the lecturer policy to allow it plus the user's own consent naming the provider. Room recordings need every participant's consent. A subject can forbid sharing. | AOS-21.39, 21.41, 21.42, 12.15, 2.6, 19F.4 |
| Q9 | Which speech-to-text engine, may audio go to a cloud provider, and what monthly cap? | None enabled until the harness has run on the owner's set (≥ 10 minutes per stratum) and met the floors of Q28. First candidates: whisper.cpp on a separate worker (no audio leaves the deployment, chunked with VAD) and one cloud engine listing `ar-IQ`. No cloud provider until the owner approves a named provider after reading its data terms; each user then still opts in. Per-user minutes and CPU-minute quotas set by the owner (§6.2). | §7.7, AOS-7.2–7.10 |
| Q10 | Who pays for AI used by other users, and how much may each use? | AI is on only for user #1 until the owner sets per-user and per-space monthly caps (§6.2 suggests $2 per student); other users see «غير مُفعّل لحسابك»; a live copilot session is capped at $0.50 (estimate). | AOS-21.46, 14.1 |
| Q11 | May moderators extend the Exam Radar phrase list with dialect phrases? | Yes: seed list = the spec's phrases + common Iraqi variants; moderators extend it per subject. | AOS-8.1–8.7 |
| Q12 | In the data model, does «Reviews» mean spaced-repetition reviews or ratings of explanations? | Both: `review_event` (exists) and a separate explanation-rating entity. | AOS-21.28, 5.29 |
| Q13 | «Unanswered Questions»: never attempted, no known key, or discussion questions without an accepted answer? | Two filters: never attempted, and discussion questions without an accepted answer. | AOS-17.16 |
| Q14 | When a user deletes their account, what happens to explanations others forked or follow? | Phase 1 policy: the vault and private data are deleted; publications are withdrawn from listings; author names are rendered at read time, so they show «طالب سابق» everywhere at once; forks others already made are **not** erased (the deletion preview says so); followed copies freeze at the last version. Moderators cannot edit other users' vaults, so «full removal» means withdrawal plus name removal. | AOS-21.44 |
| Q15 | Minimum group size before group aggregates are shown? | 5 for usage and quality statistics; **10** for exam-room aggregates, which also exclude the viewer's own answers and use coarse buckets (participants know each other). | AOS-12.19, 18.15 |
| Q16 | How do we know a student missed a lecture? | A channel lecture not opened or recorded by the student before the next lecture of the subject is published; the student can also mark «فاتتني». | AOS-19F.1 |
| Q17 | Direct messages between students? (not in the spec) | No direct messages; contextual discussions and rooms only. | IA |
| Q18 | Anonymous posts in discussions? | No; display names are shown and moderators see the author. | AOS-6.x |
| Q19 | When should the native apps start, and will the owner hold an Apple Developer Program and a Google Play Console account? | **Default (§5.3):** iPad shell and native ink right after Phase 1, in parallel with Phase 2; Android with Phase 3. Decision points: D-A Apple account by 2026-12-15; D-G Google account by 2027-02-15. | AOS-OC.1–OC.4, OC.9, §5.3 |
| Q20 | Non-medical subjects too? | Yes. Medical-specific features (USMLE-style vignettes, medical-term defaults) appear only on subjects marked medical. | AOS-14.6, 2.1 |
| Q21 | Arabic-only interface? | Yes, with English terms isolated; no English UI in these phases. | NFR-L1 |
| Q22 | Default storage quotas? | 2 GB per student vault (≈ 69 hours of recording at today's 64 kbps, §6.2) and 20 GB per subject space, adjustable by the platform admin; blobs in R2. | AOS-21.45, OC.7 |
| Q23 | Is a student laptop acceptable as an optional LAN hub for rooms? | Yes as a documented fallback; the primary path is WebRTC peer rooms inside the native app. | AOS-11.1, 11.4 |
| Q24 | How long are subject and room recordings kept? | Until the recorder or a moderator deletes them; room recordings expire after one academic year unless pinned (enforced by a retention job, ARCHITECTURE_DELTA §14). | AOS-21.20, 21.41 |
| Q25 | Followed copies: apply updates automatically or ask first? | **Flagged inversion of the spec's literal wording.** Spec §4 says updates «تصل إليها» and offers «خيار معاينة التغييرات»; this design defaults to *preview, then «طبّق التحديث»*, with «طبّق التحديثات تلقائيًا» per copy and skipping a version. Reason: an automatic change of what a student is reading mid-study surprised users in the design walkthroughs of J3 and cannot be undone by them; the personal layer is safe either way. If the owner prefers the literal default, `update_policy` defaults to `auto` with a visible change summary and an undo; nothing else changes. | AOS-4.14 |
| Q26 | Shared devices (a family tablet, a lab computer): clear local data on sign-out? | Keep local data by default with the option «امسح بيانات هذا الجهاز عند الخروج»; devices registered as shared always clear. | AOS-4.7 |
| Q27 | How many devices may join one offline room? | 30 per host (star topology), **untested** beyond two peers; each joiner pairs with its own QR exchange; larger rooms need the online server or a hub. | AOS-11.1 |
| Q28 | Absolute quality floors for speech recognition | The proposed floors of §7.7 (per stratum: Arabic CER ≤ 0.20 Iraqi / ≤ 0.15 MSA, English-term preservation ≥ 0.90, glossary recall ≥ 0.80, no deletion run ≥ 10 words). | AOS-7.2–7.7, 21.50, S1.4 |
| Q29 | History retention (time machine) | Keep everything until the user's quota is reached, then thin to one snapshot per day for items older than 180 days, after telling the user. | AOS-4.15, 4.16, 13.12 |
| Q30 | Online voice in teaching rooms needs TURN/SFU servers that cost money. Provide them? | Not designed until the owner decides; online teaching rooms carry pen and text live and voice only as a recording; peer voice works on the same network. | AOS-12.11 |
| Q31 | Who may write in a collaborative copy? | The creator invites named members with edit or view; course-wide collaborative copies only by a Subject Moderator. | AOS-4.4, 12.9 |
| Q32 | Store-and-forward relay between devices in a hall | Off by default; when a host enables it, rooms are relay-blind (relays cannot read). | AOS-11.28 |
| Q33 | Who provides reference transcripts for the ASR evaluation? | The owner, by correcting evaluation-only drafts in the app (AOS-OC.10); corrected drafts are labelled as such, because correcting a draft biases the reference toward that engine. | AOS-S1.4, OC.10 |
| Q34 | Withdrawing an official lecture for rights reasons («rights_takedown») | Removes access to the official file in every copy; the users' ink and notes stay over placeholders that state the reason. | AOS-18.12, 21.40 |
| Q35 | Move personal notes to a new official version automatically? | No: one tap with a preview; automatic only if the user enables «انقل ملاحظاتي تلقائيًا» (Scenario 4 variant). | AOS-3.13, 4.20 |
| Q36 | One space per what? | **Decided by the design review:** one space per subject from Phase 1 (isolation between subjects and universities by file; ADR-0003 §3.1). A course-level shared space is a later explicit choice, never a default. | AOS-21.6, §4.2 |
## Appendix A — Glossary and Arabic UI terms

| term | Arabic UI | meaning |
|---|---|---|
| Channel | القناة | A node of the academic tree (University … Subject) with members and roles. |
| Space | — (internal) | The shared store of one channel (official lectures, publications, discussions, rooms). |
| Vault | — (internal) | One user's private store: today's MedLevo database, one per user. |
| Official lecture | المحاضرة الرسمية | A lecture published by an authorised role; its versions are immutable. |
| Start Studying | ابدأ الدراسة | Creates or reopens the user's personal copy of a lecture. |
| Personal copy | نسختي | Stub of an official lecture version in the user's vault plus the personal layer. |
| Independent fork | نسخة مستقلة | A personal copy that also contains a frozen copy of an explanation layer. |
| Followed copy | نسخة متابَعة | A personal copy with a read-only explanation layer that receives the publisher's updates. |
| Collaborative copy | نسخة تعاونية | A shared document several authorised users write on together. |
| Layer | طبقة | Authorship/visibility unit: رسمي · شرح · ملاحظاتي · تعليقات المجموعة · اقتراحات. |
| Publication | منشور / شرح منشور | Immutable snapshot of a layer with a visibility and a version number. |
| Visibility | مرئي لـ | خاص · أعضاء المادة · المتابعون · أشخاص محددون · عام. |
| Follow a course | تابع المادة | Adds a subject's lectures to the library automatically (not a payment). |
| Join with code | انضم برمز | Class code, QR or invite link; may create a join request «طلب انضمام». |
| Origin labels | رسمي · مرجع · شرح طالب · راجعه مشرف المادة · مولّد آليًا · ملاحظاتي · قال الدكتور في التسجيل | Always text + icon, never colour alone. «مرجع» = an uploaded reference source (book, article), the spec's external reference; never shown as «رسمي». |
| Exam highlight | إشارة امتحانية | A lecturer cue detected in the transcript; never a prediction. |
| Exam Radar | رادار الامتحان | Per-lecture view of exam highlights. |
| Live copilot | المباشر | Calm rail section active during a recording or room. |
| Room | غرفة | Silent «غرفة هادئة», group «غرفة جماعية», teaching «غرفة شرح», exam «غرفة امتحان». |
| Timeline | الخط الزمني | Audio, transcript, pages, ink, photos, notes and markers on one clock. |
| Replay | إعادة العرض | Progressive redraw of writing synced with audio. |
| E-ink mode | وضع الحبر الإلكتروني | No motion, high contrast, grey ink palette, paging. |

## Appendix B — Measured basis for the decisions this PRD relies on

The spikes ran in this container (Node 22.22 with `node:sqlite` / SQLite 3.50.4; headless Chromium 141; a 4-vCPU VM that
another workflow kept at load ≈ 11–14). Their scripts and raw outputs were kept outside the repository by the concurrency
rule; the numbers below are the evidence this PRD cites. Device numbers do not exist yet.

**Tenancy (option chosen: Vault + Spaces + System on SQLite).**
* Row-level `owner_id` in one database was rejected. A forgotten filter returned 575,998 rows of 2,000 users. The sync
  handlers look rows up by client-supplied id, so another user's id could be pushed. The upload duplicate check would
  reveal other users' titles. Global bm25 statistics leak across users: one user's score moved −20.59 → −7.64 after another
  user wrote 5,000 rows. The change would touch ~1,720 SQL statements.
* PostgreSQL row-level security was rejected for now: an asynchronous rewrite of a synchronous data layer (1,496 db call sites,
  166 transactions), FTS5 and the Arabic `ml_norm` function, and the verified backup/restore.
* The chosen design measured:
  * 0 cross-tenant reads over 200 interleaved Fastify requests; unbound access refused.
  * Binding overhead 6.85 → 7.10 µs per statement.
  * A follow stub costs 10.2 KB and 0.7 ms per 40-page lecture; mirroring would cost ≈ 649 KB, i.e. ≈ 487 GB for 5,000
    students × 150 lectures.
  * Pinning 60 cited regions costs 61 KB.
  * Scoped search with tokens inside MATCH: 8–14 ms vs 86–242 ms post-filter on 246k chunks.
  * Vault pool hit 0.24 ms, miss 28 ms p50.
* The legacy owner's database becomes vault #1 byte-for-byte (§9 X8).

**Collaboration (Yjs for multi-writer layers only).** 5,000 strokes, 3 offline peers.
* Yjs with each stroke one immutable value holding packed points:
  * build 0.20 ms per stroke; delta 1,350 B per stroke;
  * 6.7 MB document (4.95 MB gzip); merges 9–21 ms;
  * converged 3/3; «edit beats concurrent delete», like the server's annotation rule;
  * per-user UndoManager never undid a peer's stroke.
* Automerge 3 also converged, but commit time grew to 5.6 ms per stroke, merges took 1.6–2.5 s, there is no undo manager
  and the history never shrinks.
* The existing op-log already gives single-writer layers the right rules.
* Packing points cuts payloads ≈ 5.5× (29.1 → 5.28 B per point).

**Nearby (common denominator = same Wi-Fi/hotspot).**
* WebRTC DataChannel with two out-of-band SDP hops and no STUN/TURN connected every time between Chromium contexts and
  processes. 5 MB arrived intact in 0.42–1.40 s (28/28 hash matches).
* The offerer never reached ICE «complete», so pairing must not wait for it. One compressed SDP fits a version-13–16 QR.
* A LAN hub over plain http loses the service worker, `crypto.subtle` and the microphone; a self-signed https still failed
  service-worker registration.
* From public documentation only:
  * Web Bluetooth cannot link two browsers and is absent on iOS.
  * Nearby Connections is Android/Play-services based.
  * Multipeer is Apple-only and disconnects when the app goes to the background.

**Speech recognition.**
* whisper.cpp built here in 138 s. On 481 s of English read speech:
  * tiny: RTF 0.21, WER 8.7 %;
  * base-q5_1: RTF 0.29, WER 9.1 %;
  * small-q5_1: RTF 0.68, WER 10.4 %.
* Long-form decoding dropped whole passages (up to 47 words), so VAD chunking is required and deletions must be counted.
* OpenMP spin-waiting on a shared CPU made decoding 25× slower (`OMP_WAIT_POLICY=passive` fixes it).
* No Arabic or Iraqi audio was run; nothing is claimed.
* The evaluation harness (Arabic WER/CER, English WER, term preservation, transliteration, glossary recall, RTF) is ready
  for owner recordings.

**Client platform (native shell, not a rewrite).**
* The real ink renderer in headless Chromium (software raster):
  * live frame 2.5–4.4 ms median;
  * full repaint of a realistic 5,000-stroke page 3.8 s; zoom step 3.0 s.
* A tile/bitmap cache is therefore required (NFR-P2).
* PencilKit-class latency, Pencil prediction, double-tap/squeeze and system palm rejection are native-only.
* A Flutter/KMP rewrite would discard ≈ 60.7k lines of web client, 14k of CSS and 110 web test files.
* A Capacitor-class shell + native ink and nearby plugins reuses everything (owner clarification 2).
* Nothing native can be built or tested in this container (no Xcode, Android SDK, KVM or devices); it goes through cloud CI
  and TestFlight / Play internal testing.

## Appendix C — Cross-reference to the note-app parity gaps

[`docs/research/NOTE_APP_FEATURE_PARITY.md`](../research/NOTE_APP_FEATURE_PARITY.md) plans the depth of the personal notes
engine in tracks N1–N5 (gaps G01–G71). To avoid building twice, the Academic OS items below **reuse** those gap plans; the
Academic OS adds only the multi-user part (author, layer, permission, publication).

| Academic OS item | parity gap(s) |
|---|---|
| AOS-1.2 palm rejection | G02 palm-rejection settings |
| AOS-1.3 pen types / presets | G01 pen feel, G03 synced colour slots |
| AOS-1.5 pencil | G06 pencil nib |
| AOS-1.7 shapes | G20 shape fill and more shapes |
| AOS-1.8 ruler | G08 ruler |
| AOS-1.12 resize | G19 free resize and rotation |
| AOS-1.17 images | G16 crop and cut a region |
| AOS-1.19 diagrams | G21 connectors, G22 snapping |
| AOS-1.18 tables, AOS-1.23 side notes | G25 rich formatting, G36 typed document |
| AOS-1.20 links | G44 web links and links to study objects |
| AOS-1.27 tabs, AOS-20.12 multiple files | G39 document tabs and windows |
| AOS-1.33 infinite canvas | G35 infinite canvas |
| AOS-1.34 / 1.35 exports | G56 PDF export with ink |
| AOS-1.37 / 15.2 handwriting search | G45 search typed items and titles |
| AOS-4.6 / 4.10 layers | G23 owner layers (the Academic OS generalises them to authorship layers) |
| AOS-7.1 recording across navigation | G53 recording control |
| AOS-7.13 / 7.16 / 7.18 playback | G52 speed, skip, silence skip, noise reduction |
| AOS-10.10 flashcards from a selection | G18 lasso → card, G62 card suggestions |
| AOS-10.11 / 10.13 define, read aloud | G70 define and read aloud on PDF text, G63 read-aloud |
| AOS-10.18 correct handwriting | G10 handwriting editing, G11 neat copy, G13 medical spellcheck |
| AOS-12.1 Pomodoro, AOS-17.8 study time | G65 study timer |
| AOS-12.11 live teaching | G54 presentation / teach-back mode |
| AOS-13.4 replay | G51 stroke replay with the recording |
| AOS-19A.1 lecture camera | G29 camera capture, G30 document scanner |
| AOS-20.8 shortcuts, AOS-20.9 toolbars | G66 toolbar customisation, G14 ink gestures |
| AOS-21.44 delete data | G59 erase-everything and per-category erase |
| AOS-OC.7 backups | G57 scheduled automatic backups |
| AOS-1.21 equations | **none** — the parity study ruled math «out of scope (spec §01)» under the old spec; the newer spec (§1 «معادلات», §10 equation selection, Q20 non-medical subjects) overrides that, so AOS-1.21 is an Academic OS work item built by BUILD_PLAN track P2-T5, not by N1–N5 |

## Appendix D — Baseline evidence and how to re-check it

The `Now` column of §7 is the gap analysis's claim (§1). Each §7 section maps to the rows of
[`docs/REQUIREMENTS_MATRIX.md`](../REQUIREMENTS_MATRIX.md) part A (old spec §00–§62), which already name the screens,
routes, tables and tests behind today's status. A build track re-checks its rows against these before it builds, records
the file and test evidence in a new «AOS» part of the matrix, and corrects any `Now` value that does not hold.

| §7 section | REQUIREMENTS_MATRIX part A rows that hold today's evidence |
|---|---|
| 7.1 §1 notes and document engine | §23 workspace, §25 anchors, §26 reader tools, §27 pencil matrix, §28 handwriting, §46 search, §47 offline, §55 performance |
| 7.2 §2 channels | §02 single owner (superseded), §05 library, §06 source registry, §13 upload |
| 7.3 §3 smart import | §05, §06, §07 source versions, §13 upload pipeline, §14 layout analysis, §36 duplicates |
| 7.4 §4 copies and layers | §07, §18 artifact versioning, §25 anchors, §47 sync |
| 7.5 §5 social and marketplace | §02 (superseded) — no baseline evidence exists |
| 7.6 §6 discussions | §30 rail selection actions, §33 question vault |
| 7.7–7.9 §7–§9 live lecture, radar, copilot | §29 audio and voice notes, §33, §40 Exam DNA, §51 AI adapters |
| 7.10 §10 AI pen | §28, §30, §31 summaries and compare, §37 generated MCQs |
| 7.11–7.12 §11–§12 nearby and rooms | §47 offline and sync, §39 exams |
| 7.13 §13 replay | §29 |
| 7.14 §14 tutor | §03, §08 Source Lock, §10 provenance, §19 rules engine, §20 teaching engine, §43 FSRS, §44 learning profile |
| 7.15 §15 search | §46 universal search, §32 image explorer |
| 7.16 §16 knowledge graph | §16 Course Brain |
| 7.17 §17 dashboard | §45 home and planner, §43, §44 |
| 7.18 §18 administration | §02 (superseded), §48 Control Center, §49 security |
| 7.19 §19 next-generation | §16, §24 Lecture Twin, §29, §45, §55 |
| 7.20 §20 UI/UX | §22 design system, §23, §55 |
| 7.21 §21 data model and security | §49, §50 stack, §53 jobs, §54 data model, §56 observability |
| 7.22 scenario items | §29, §45, §46 |
| 7.23–7.24 PRD-added items | none (new) |
