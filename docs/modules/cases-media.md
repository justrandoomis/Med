# Clinical cases, OSCE, viva and media (track D3)

Spec: §29 (lecture audio layer), §32 (Medical Image Explorer, overlays, Image Quiz), §42 (case / OSCE / viva
simulation), §44 (case signals for the Weakness Center), AC-08 (uncertain labels never become quiz answers), AC-09
(image candidates must match modality, region and finding).

Everything deterministic works without an AI provider. Without one, AI generation and the AI viva judge report
`requires_configuration` with an Arabic reason; automatic transcription, automatic segment-to-page linking and external
image search are not built, and the API and UI say so. In-app recording (with pen ↔ recording time links) was built in
track F4 (section at the end).

## 1. Server: `/api/cases` (owner session; mutations need the CSRF header like every `/api` route)

| Route | What it does |
| --- | --- |
| `GET /` | `CaseListResponse`: cases + capabilities (authoring, generation, AI judge, voice, text mode) |
| `POST /` · `PUT /:id` | Owner authoring (`CaseSaveRequest {definition, scope, base_version_no}`). Every save is a new immutable version. A stale `base_version_no` gets 409. The kind cannot change after creation. |
| `GET /:id` · `DELETE /:id` · `POST /:id/restore` | Detail (current version, validation, honesty notes, evidence status per sentence) / trash / restore |
| `POST /evidence/suggest` | Deterministic retrieval of evidence candidates for one sentence, inside the case's Source Lock |
| `POST /generate` | AI generation as a job (`cases.generate`, rate-limited like other AI routes). Refused with 409 `AI_NOT_CONFIGURED` and the reason when no provider exists. |
| `POST /:id/attempts` | Starts an attempt, idempotent by client `attempt_id`. The attempt pins `case_version_id`; options are `feedback immediate/end`, `judge deterministic/ai`, `mode text/voice` (voice is refused with the reason). |
| `GET /attempts?case_id=` · `GET /attempts/:id` | History · `CaseRunView` (only what has been revealed; no unrevealed fact, no unchosen decision's consequence) |
| `POST /attempts/:id/events` | Appends one event, idempotent by client `event_id`: a resend with the same id is not applied twice and returns `duplicate` with the current run; an id already used by another attempt is refused with 409 |
| `GET /attempts/:id/report` | `CaseReportView` after finishing |
| `GET /signals?since=` | Case / OSCE / viva signals in the shared `WeaknessSignal` shape (see §5) |

Capability: `ai.cases` is set to `available` by the module. The registry turns that into `requires_configuration`
when no provider is configured. No new `FEATURE_KEYS` were added (see §6).

### Data (`0770_cases.sql`; no existing migration edited)

- `clinical_case` (additive columns): `origin` (`owner`/`generated`), `current_version_no`, `station_type`,
  `source_id`, `generation_json`, `status_reasons_json`, `deleted_at`.
- `clinical_case_version`: one row per save, holding the definition, scope, validation issues and claim ids. Old
  versions are never rewritten, so an attempt always replays against the version it started on.
- `case_attempt` (additive): `case_version_id`, `feedback`, `judge`, `mode`, `last_seq`.
- `case_event`: append-only event log (`id` = client event id, `UNIQUE(attempt_id, seq)`). The older
  `case_attempt.events_json` column is left unused.

### Definition and validation (`definition.ts`)

A definition has facts (`initial` or revealed by a decision / a stage / an OSCE question), stages with decisions
(appropriateness `appropriate` / `acceptable` / `inappropriate`, consequence, next stage, revealed facts,
explanation), a checklist (each item is satisfied by chosen decisions or by matched phrases, optionally ordered, with
a rationale), an OSCE block (station type, role, patient script) or a viva block (questions with points, follow-ups
and misconceptions).

- Structural errors (unknown references, unreachable or never-ending stages, duplicate ids) make it a `draft`, and a
  draft cannot be started. Warnings (for example a rubric item with no supported rationale) make it `needs_review`
  with Arabic reasons. A case with no issues is `ready`.
- Honesty notes (`honestyFor`) list what the simulation can and cannot assess for each kind and station type. For
  example, an examination station cannot assess physical technique, and the score is an estimate from this checklist
  only. Patient details are labelled «بيانات تعليمية مؤلفة».

### Evidence (`claims.ts`, through the evidence services)

Every medical sentence (decision explanations, rubric rationales, viva corrections) is a claim validated by
`validateClaims` with owner type `case` against the case's Source Lock.

- Owner-authored sentences are never dropped. Unsupported ones are kept and marked (`no_evidence`, `rejected` with
  the reason, `needs_review` when no verifier is available, or `conflict`). An unchanged sentence reuses its earlier
  claim.
- Generated sentences that fail validation are removed and listed. `pruneUnsupported` then removes rubric items, viva
  points and misconceptions left without supported rationale, and viva questions left without points. The removals
  are shown with the case.
- `recordDependencies` registers the regions used, so source changes raise the evidence module's alerts.

### Engine (`engine.ts`, pure and deterministic)

`initialState` / `apply` / `replay` over the event log: `choose`, `advance`, `utterance` (OSCE question or statement),
`viva_answer`, `revise` (a new text; the original stays in history), `override_item` (the owner's verdict on a
checklist item or viva point, kept beside the automatic verdict) and `finish`. The engine refuses anything the
definition does not allow (an unknown decision, a stage that is not current, an answer to a question that is not
pending). The same events always produce the same state.

- Case: branching follows only the definition. Facts are revealed only as defined, and their values never change.
- OSCE (text): the simulated patient answers only with defined facts. A question that matches no defined fact gets a
  fixed «not defined» reply and reveals nothing; a negatively phrased question («no nausea?») still asks about the
  fact. The checklist is judged by phrase matching (`text.ts`: normalized Arabic and English, Arabic proclitics, and a
  negation guard inside the clause: a cue such as «not», «no», «لا», «negative for» up to 4 words before the phrase;
  punctuation and «but / لكن» end a clause). The order check compares where each ordered step was first mentioned.
- After `finish`, only `override_item` is accepted: a text revised after the report was seen is refused (409) instead
  of silently becoming an automatic match. Stored logs still replay as they are.
- Viva: follow-ups are chosen from the definition by which points are still missing. Coverage is phrase matching, or
  an AI verdict when the owner chose the AI judge and a provider exists. The AI judge may only mark points that exist
  in the definition, and its verdict is stored in the event payload so a replay never calls the AI again.
- The report gives met / not met per item with the reason, the order check, viva gaps and misconceptions, the
  explanations with their evidence status, a review plan, the honesty notes, and an estimate labelled as an estimate
  from this checklist only.

### Generation (`generate.ts`)

The job resolves the scope (it must include the requested lecture; page ids must belong to its pinned version),
builds an evidence pack, and abstains without calling the model when there is too little evidence. Otherwise it calls
`ctx.ai.generateStructured('case_sim', …)` with a schema, validates the claims, removes unsupported content, runs
structural validation, and saves version 1 as `origin: generated` (labelled). Checkpoints make it resumable.
A decision consequence written by the model is unverified scenario text, so every generated decision with a
consequence adds a warning: the case is `needs_review` (still playable) until the owner has checked that it invents no
harm, complication or result and saved it. An edit is refused (409) while the generation has not finished.

## 2. Server: `/api/media`

| Route | What it does |
| --- | --- |
| `GET /status` | What works and what does not, with reasons: playback, manual transcript and subtitle import work; transcription `requires_configuration`; recording, auto-linking and external images not built |
| `GET /audio` · `GET /audio/:id/stream` · `PATCH /audio/:id` | One audio asset per audio source version (created lazily) · authenticated Range stream from the files store · duration reported by the owner's player (labelled; the server does not decode audio) |
| `GET /audio/:id/transcript` | Segments with original and corrected text, origin label, links, revision counts, imports |
| `POST /audio/:id/segments` · `PATCH/DELETE /segments/:id` · `POST /segments/:id/restore` · `GET /segments/:id/revisions` | Manual segments; a correction never overwrites the original; `base_rev` refuses stale edits; delete is a tombstone; full revision history |
| `POST /audio/:id/import` | WebVTT / SRT import (`subtitles.ts`). Replacing an earlier import tombstones only its uncorrected segments; corrected and manual segments are kept and counted. Skipped cues are reported with Arabic reasons. |
| `POST /segments/:id/links` · `DELETE /links/:id` · `POST /links/:id/confirm` · `GET /links?page_id=` | Segment ↔ page / region links, labelled `manual` («ربط يدوي (أنشأته أنت)») or `auto` («ربط تلقائي — قابل للتعديل، تحقق منه»); an auto link can be confirmed («ربط تلقائي أكّدته») or removed |
| `GET /images` · `GET /images/:id` · `PATCH /images/:id/meta` | Image Explorer over the `image_asset` rows written by processing: origin badge (source photo / source drawing / re-organized diagram / generated illustration), kind facet counted from the images that exist, owner classification in `image_meta` (labelled and audited) |
| `POST /images/:id/overlays` · `PATCH/DELETE /overlays/:id` | Non-destructive overlays (highlight rect, arrow, occlusion mask, label point), normalized to the original image, with a certainty label, `base_rev` and tombstones |
| `POST /images/match` | AC-09 gate over the owner's own images: accepted or excluded, each with reasons |
| `POST /quiz` · `GET /quiz/:id` · `GET /quiz/:id/image` · `POST /quiz/:id/answer` · `POST /quiz/:id/finish` | Image Quiz (see below) |

Capabilities: `workspace.audio` is `available` with a reason that names what is not built; `external.images` is
`not_implemented` with the reason (no image provider; external fetch is off by default).

### Data (`0650_media.sql`; no existing migration edited)

- Additive columns on `audio_asset`, `transcript_segment`, `media_region_link` and `media_overlay`.
- New tables: `transcript_revision`, `transcript_import`, `image_meta`, `image_quiz`, `image_quiz_answer`.
- Every new foreign key into a table that the sources purge removes uses `ON DELETE CASCADE`, so a permanent delete
  is never blocked (tested). References to other modules' tables are plain TEXT.

### Transcript search

Each live segment writes an `owner_content_fts` row (entity `transcript_segment`) with the normalized search key of
the displayed text (the correction if there is one, otherwise the original). The universal search reads it. A deleted
segment's row is removed.

### Image Quiz (AC-08, no leak)

- Only occlusion masks with a label whose certainty is not `uncertain` are asked. Excluded masks are counted with the
  reason, never with their label. A quiz where every label is uncertain is refused.
- The quiz payload has neutral keys (`m1`, `m2`…) and mask geometry only: no image id, file id, caption, title,
  source, page or label. The image comes from `/api/media/quiz/:id/image` with `no-store`, no file name and no ETag.
- PNG images are served with the masks burned into a derived copy (the stored file is untouched), so removing a layer
  in the browser reveals nothing. Other formats are served as-is with client-drawn masks (`masks_rendered: 'client'`),
  and the UI says so.
- Answers are append-only and matched against the label and its aliases (normalized Arabic). A non-matching answer
  can be self-marked correct; it is stored as `self_marked_correct`, not as a match. The source is revealed only after
  finishing.
- Eligibility is checked again when answering: a mask that was removed, emptied or marked uncertain after the quiz
  started is refused (409, without its label) and never graded as a fixed answer (AC-08).

### AC-09 validator (`validate-image.ts`)

Checks modality (metadata or caption), anatomic region (same region, or a part or whole of it, such as lung within
chest), that the caption states the finding without denying it, the age group when requested, and origin
(generated illustrations, re-organized diagrams and educational drawings / diagrams from a source are never the
requested real example, unless a drawing was asked for). Unknown is never accepted. The caption check uses the strict
`caption` negation mode: any pre-negation cue earlier in the same sentence («no evidence of», «without», «negative
for», «absence of», «to rule out», «لا يوجد دليل على», «عدم وجود») or a post-negation cue later in it («excluded»,
«ruled out», «not seen», «absent», «غير موجود», «مستبعد») excludes the image; commas, colons and brackets do not end
the sentence. Today it runs over the owner's library («ابحث في صوري»). It is the gate any future external provider
must pass.

## 3. Web (Arabic, RTL, 390 px to desktop, light and dark)

- **Review hub** (`features/review/ReviewHub.tsx`, minimal edit): two entries, «حالات وOSCE» → `/cases` and «الصور
  والصوت» → `/media`.
- `/cases`: list with kind, origin, status and last attempt. The AI generation panel is shown disabled with the
  server's reason when generation is unavailable.
- `/cases/new` and `/cases/:id/edit`: an editor for every kind (facts, stages and decisions, checklist, OSCE script,
  viva). Evidence is picked from Source Lock suggestions. A local draft is kept per case, and the base version is
  sent so a conflicting save is refused. A local draft written on an older version (saved elsewhere since, or a save
  refused with 409) is set aside, never overwritten, and offered: «استعد مسودتي» puts it in the editor and saving
  creates a new version on top of the current one; «تجاهلها» discards it.
- `/cases/:id`: authored label, status reasons, evidence status per sentence (`CitationChip`), honesty notes,
  attempts.
- `/cases/run/:attemptId`: patient chart (revealed facts only, each with how it was revealed), the current stage,
  OSCE or viva panel, and the attempt history. A typed OSCE question or viva answer stays on the device
  (`localStorage`) until sent. A failed send keeps the input and is retried with the same `event_id`; once the retry
  is stored the field is cleared so it is not sent twice. Finishing with unsent text asks first. Voice mode is
  disabled with the reason.
- `/cases/report/:attemptId`: estimate labelled as an estimate, met / not met in words with reasons, order check,
  viva gaps, owner override per item (sent as an event, kept beside the automatic verdict; for viva points both
  «ذكرتها بصياغة أخرى» and «لم أذكرها فعلًا»), review plan, honesty notes.
- `/media`: Images tab (origin badges, kind filters from existing images only, «ابحث في صوري» AC-09 panel, external
  search unavailable with the reason) and Audio tab.
- `/media/images/:id`: the image with SVG overlays drawn by pointer (rect, arrow, mask, label) or, without a pointer,
  placed at the centre and positioned with number fields (rect, point and arrow), a list of overlays with certainty
  and quiz eligibility, the owner's classification form, and «اختبر نفسك على هذه الصورة».
- `/media/quiz/:id`: neutral image and numbered masks, per-mask check, self-mark, and the reveal after finishing.
- `/media/audio/:id`: player (Range stream), segments with original and correction, revision history, manual
  segments with times, VTT/SRT import, links to pages labelled manual or auto, transcript filter. «سجّل» is disabled
  with the reason. The correction form shows the exact times (milliseconds kept) and sends a time only when it was
  changed, so correcting the text never re-times an imported cue.

## 4. Tests (real results, 2026-10-10)

The counts in this section are from the build. The review added regression tests; the current counts and results are
in §7.

Server: `apps/server/test/cases/*.test.ts` (31 tests) and `apps/server/test/media/*.test.ts` (26 tests).

- Engine (16): phrase matching with proclitics and negation, structural validation, honesty notes, determinism under
  replay, fact reveal, branching, refusals, checklist with overrides, OSCE patient answers only defined facts, order
  check, viva follow-up choice, AI verdict restricted to defined points.
- Cases API (10): manual authoring without AI (labels, versioning, missing-evidence reasons), drafts cannot start,
  strict input, idempotent start and events, version pinning, `feedback: end` hides judgements, voice refused, OSCE
  report, viva gaps and misconceptions, AI judge refused without a provider and stored with one, auth and CSRF.
- Cases with evidence (5): attached evidence validated, unsupported owner sentences kept and marked, out-of-scope
  evidence refused, claim reuse, Source Lock suggestions. Generation is refused without a provider. With the
  test-only scripted provider, unsupported sentences and rubric items are removed and the rest linked through the
  verifier. Generation abstains without a model call when evidence is too thin.
- Media units (13): VTT (BOM, CRLF, NOTE/STYLE, voice tags, entities, Arabic) and SRT parsing, invalid cues with
  reasons, quiz answer normalization, AC-09 (modality, region hierarchy, negated or missing caption, unknowns, age
  group, generated origin, Arabic).
- Media API (13): audio Range stream and duration, honest status, segment corrections, history, stale edits and
  tombstones, Arabic VTT import and replace, transcript search, manual vs auto link labels with confirm and remove,
  explorer badges and facets, overlays, quiz with no leak (payload, neutral image route, burned PNG), Arabic alias,
  all-uncertain quiz refused, non-PNG client masks, AC-09 matcher, auth, sources purge not blocked.

Web: `features/cases/cases.test.tsx` (8) covers the authoring model round-trip, the runner (revealed facts only, an
event per choice, retry with the same event id, OSCE text kept until sent, viva pending question) and the report
(estimate wording, override as an event). `features/media/media.test.tsx` (5) covers time codes, overlay geometry,
the Arabic transcript filter, the Image Quiz (nothing in the DOM before answering, check, self-mark, reveal after
finishing) and the recording screen.

End to end: `node apps/web/src/features/cases/real-server-check.mjs`, run after the web build, uses the real server,
the built app and Chromium. It covered authoring, runner, report, OSCE, editor, images, overlay, quiz neutrality,
audio import, search, Range stream, no horizontal overflow at 1280 and 390, and dark mode. Result: all 40 checks
passed.

| Command | Result |
| --- | --- |
| `npm test -w @medlevo/server` | 61 files passed; 826 passed, 1 expected fail |
| `npx vitest run test/cases test/media` (in `apps/server`) | 5 files, 57 passed |
| `npm test -w @medlevo/web` | 63 files, 492 passed |
| `npx tsc -p apps/server --noEmit` / `npx tsc -p apps/web --noEmit` | clean |
| `npm run build -w @medlevo/web` | succeeded |

## 5. Not done / limits

- **Voice mode, automatic transcription, automatic segment-to-page linking and external image search are not
  built.** (In-app recording: track F4 below.) Each is reported with its reason. No automatic linker exists, so the auto-link label and
  its controls are only exercised with a test fixture.
- **Weakness Center integration**: case signals are published at `GET /api/cases/signals` in the `WeaknessSignal`
  shape (with `case_id`, `item_id`, `source_ids`, `owner_judged`). Since track F2 the learning Weakness Center reads
  them (`caseSignals(ctx)` in `learning/weakness.ts`) as their OWN types: `case` for a case, `osce` for an OSCE
  station, `viva` for a viva point (the `viva` type was added in F2; before it viva points were typed `case`). They are
  grouped by the case and by the sources their evidence cites — see `docs/modules/learning.md` §6.
- Phrase matching is a heuristic. It can miss a correct paraphrase or accept a passing mention; a double negation
  («never forget to ask about fever») counts as negated. The report says this, and the owner can override any item.
- AC-09 caption checks are lexical: a hedged caption («possible pneumothorax») or a caption that names the finding
  for another figure («compare with Figure 3, which shows a pneumothorax») is not detected. G3 (AC-09): a caption that
  names two modalities («Chest X-ray and CT side by side; the CT shows …») is now excluded as ambiguous (unless the
  owner classified the image), a caption that says the picture is drawn («(artist's illustration)», «رسم توضيحي») is
  never a real example, and a finding that is gone («resolved / healed pneumothorax», «زوال …») is not shown.
- The owner's certainty label on an overlay (for example «من تعليق المصدر») is not checked against the caption.
- Two saves of the same case racing through evidence validation are refused with 409 inside the transaction; this is
  not covered by a deterministic test (the race needs real asynchronous I/O).
- The OSCE order check uses the position of first mention in the typed text, not the real sequence of actions.
- Image Quiz masks are burned in server-side only for PNG. Other formats use client-drawn masks, and the UI says so.
- The audio duration comes from the owner's player (labelled). The server does not decode audio.
- Cases and media need a connection. Nothing was added to the offline (Dexie) schema; only unsent runner input and
  editor drafts are kept in `localStorage`.
- The universal search labels transcript hits with origin «recognized» whatever their real origin (imported, manual).
  That code belongs to the search module and was not changed here.
- No case export or import, and no case sharing.

## 6. Cross-track notes and deviations

- No `FEATURE_KEYS` were added: the control center's capabilities screen uses an exhaustive
  `Record<FeatureKey, …>`, so a new key would break another track's build. The module uses the existing keys
  `ai.cases`, `workspace.audio` and `external.images`.
- Shared files: `packages/shared/src/index.ts` (append-only exports of `cases-api` and `media-api`). New shared
  files: `packages/shared/src/cases-api.ts`, `packages/shared/src/media-api.ts`.
- `features/review/ReviewHub.tsx` (owned by L2): two `TOOLS` entries and two icon imports, nothing else.
- `case_attempt.events_json` is not used; the log lives in `case_event`.

## 7. Independent review (2026-10-10)

An adversarial review of this track read the server, web and test code and probed it with scripts. Confirmed issues
and what was done (each with a regression test unless said otherwise):

| Severity | Issue | Fix |
| --- | --- | --- |
| major | AC-09: «Chest X-ray: no evidence of pneumothorax», «negative for», «ruled out», «excluded», «absence of», «لا يوجد دليل على …» were accepted as examples of the finding (the negation window was 2 words, no post-negation) | clause-aware `caption` negation mode (`text.ts`, `validate-image.ts`); 11 denied phrasings + 3 positives tested |
| major | AC-09: an educational drawing / diagram from a source passed as the requested real X-ray when its caption named the modality | origin check excludes drawing kinds unless a drawing was requested |
| major | Audio: the correction form rounded times to whole seconds and always sent them, so correcting text re-timed imported cues, and a sub-second cue inside one second could not be corrected at all | exact times in the form; unchanged times are not sent (web test) |
| major | Editor: a local draft based on an older version was ignored on reload and overwritten by the next keystroke (owner writing lost after a 409 or an edit elsewhere) | set aside and offered for restore (web test) |
| major | Generated decision consequences (model-written scenario text, no evidence) were shown in a `ready` case with no review flag — a possible invented harm | warning → `needs_review` until the owner saves the case |
| minor | AC-08: a quiz kept grading a mask against its live label after the mask was marked uncertain or removed | eligibility re-checked when answering (409) |
| minor | Engine: `revise` was accepted after `finish`, turning text written after seeing the report into an automatic match | refused when appending; stored logs still replay |
| minor | OSCE/viva matching: «I would not order a CT» covered «CT»; «no evidence of nausea» counted; the patient ignored «no nausea?» | 4-word clause-aware negation for answers; patient matching ignores negation |
| minor | AI viva judge: a model call was made for an answer the engine then refused (stale question or finished attempt); a duplicate event id arriving during the call gave a 500 | judge only the pending question; duplicate re-checked in the transaction |
| minor | Two saves of one case could race to the same version number (500); an edit during a queued generation collided with the job's version 1 | version re-checked in the transaction (409); edit refused while generating (tested) |
| minor | Explorer text filter: `%` / `_` escaped without an `ESCAPE` clause, so «50%» found nothing | `ESCAPE '\'` |
| minor | Runner: after a successful re-send the text stayed in the field (duplicate on the next send); finishing with unsent text did not ask | field cleared after the retry is stored; confirm dialog (web test for the retry) |
| minor | Report: viva points judged covered could not be overruled to «not covered»; the override button left an unhandled rejection | «لم أذكرها فعلًا» override; rejections handled |
| minor | Image detail: a new overlay needed a pointer drag (no keyboard path); points and arrows had no number fields | «أضفها في وسط الصورة…» + number fields for every shape (web test) |

Reported, not changed (other tracks' files): the universal search labels transcript hits `recognized` whatever their
origin (search module).

Results after the review (2026-10-10):

| Command | Result |
| --- | --- |
| `npx vitest run test/cases test/media` (in `apps/server`) | 5 files, 65 passed |
| `npm test -w @medlevo/server` | 61 files; 834 passed, 1 expected fail |
| `npx vitest run src/features/cases src/features/media` (in `apps/web`) | 2 files, 17 passed |
| `npm test -w @medlevo/web` | 63 files, 496 passed |
| `npx tsc -p apps/server --noEmit` / `npx tsc -p apps/web --noEmit` | clean |
| `npm run build -w @medlevo/web` | succeeded |
| `node apps/web/src/features/cases/real-server-check.mjs` (after the build) | all 40 checks passed |

## 8. Integration round I1 (2026-10-10)
* **Case runner: a decision picked right after a stage appeared could be undone.** `CaseRunner` reset the picked
  decision in a passive effect keyed on the stage. A choice made before that effect ran (the radio right after the
  stage rendered) was reset to nothing, so «أكّد القرار» did nothing. Under a loaded machine this made two
  `cases.test.tsx` runner tests fail (1 of 4 parallel runs, 2 tests). The pick is now keyed by stage in state (a new
  stage starts empty without an effect). Verification: the same file run 4× in parallel, 3 rounds → 12/12 pass
  (before: 1 of 4 failed). No deterministic test reproduces the effect timing; the existing runner tests are the
  regression tests.
* **Transcript search origin** (universal search): see `docs/modules/evidence-search.md` §7.

## Track F4 — in-app recording and pen ↔ recording time links (§29, 2026-10-10)

### Server (`apps/server/src/modules/media/recordings.ts`, migration `0660_audio_recording.sql`)
* `POST /api/media/recordings` (multipart: `recording_id` = the client's ULID, `started_at`, `duration_ms?`,
  `linked_source_id?`, `node_id?`, `title?`, `device_id?`; one `file`): the bytes are streamed to a private temp file and
  **content-sniffed** — only audio is accepted (WebM / Ogg / MP4 / WAV / MP3; a WebM or MP4 holding a video track is
  refused). The recording becomes a **«ملاحظة صوتية» (`my_audio_note`) source** through the sources module's own
  `registerUpload` (owner-chosen type, folder = `node_id` or the lecture's folder, title «ملاحظة صوتية — 10/10 14:05» in
  the owner's timezone, Western digits, no bidi control marks — the `ar` formatter's RLM scrambled the date in the heading), linked
  to the lecture that was open (`source_link 'audio_for'`), and `audio_recording` maps the recording id → that source
  (`ON DELETE CASCADE` with the source; `linked_source_id` `SET NULL`). A retried upload of the same id returns the
  stored recording (`created: false`) — never a second source. The duration measured by the recording device is stored as
  the player duration (the server does not decode audio).
* `GET /api/media/recordings/:id` → `RecordingView` with `linked_strokes`: the live ink / shape annotations whose
  `data.audio_link.recording_id` is this recording, ordered by offset, with their page label and `auto` / `manual`
  origin. `GET /api/media/recordings?source_id=` lists the recordings of / linked to a source.
* Sniffing (`sources/sniff.ts`, additive): `webmAudioOnly` (EBML DocType webm/matroska, audio codec ids only) →
  `audio/webm`; `mp4AudioOnly` (every `hdlr` handler is `soun`) → `audio/mp4`. Everything else is unchanged (a WebM with
  `V_VP8`, an MP4 with a `vide` track are still «video» and refused).
* `/api/media/status.recording` → `available` with the reason that tells where it is and that it never starts by itself;
  `workspace.audio`'s reason mentions in-app recording (browser support is decided in the browser).

### Web (`apps/web/src/features/workspace/audio/`)
* `recorder.ts` — `RecorderController`: the microphone is requested ONLY by `start()` (called from the explicit menu item
  «سجّل ملاحظة صوتية…» in the reader's «خيارات العرض / القراءة» menu); nothing starts on load, reload or a timer.
  `recordingSupport()` (no `MediaRecorder` / `getUserMedia` → «unsupported»; insecure page → «insecure») is checked
  without touching the microphone and disables the menu item with its reason. getUserMedia errors are explained
  (`NotAllowedError` → how to allow it; `NotFoundError` → no microphone; `NotReadableError` → busy). Pause / resume when
  the browser supports it; paused time is excluded from stroke offsets. Chunks are written to IndexedDB every 4 s while
  recording (`recchunk:<id>:<seq>`); on stop the microphone tracks are stopped, the whole recording is stored on the device
  (`rec:<id>`, uploadState `pending`) and the chunks are dropped in the same transaction.
* `recordings.ts` — uploader like the pictures' (backoff 2 s → 10 min; a refusal of the bytes — 400/413/415/422 — is kept
  on the device with the server's reason; offline / 401 stop the run); `recoverInterruptedRecordings` turns the chunks of
  a recording whose page died before «إيقاف» back into a recording (labelled `recovered`, duration unknown) — never
  while that recording is still running; `playbackSource` plays the device copy (object URL) when this device recorded it,
  else the server stream.
* `AudioUi.tsx` — `RecordingBar` (in a bottom dock shared with the player — they stack, neither covers the other — while requesting / recording / saving / saved / error: a red dot AND
  the words «يُسجَّل الآن» or «التسجيل متوقف مؤقتًا», the time, pause / resume, «إيقاف التسجيل»; announced in a polite live
  region; closing / reloading the page while recording asks first, and leaving the reader in the app stops and saves the
  recording — it never runs on without its indicator; a permission request still pending then is cancelled), `RecordingPlayer` (plays a stroke's moment; says «رابط زمني
  تلقائي» / «عدّلته بنفسك»; explains a recording that is neither on the device nor on the server), `AudioLinkDialog`
  (m:ss, Arabic-Indic digits accepted; save → manual; «أزل الرابط»).
* The audio screen (`/media/audio/:id`) lists «ملاحظات القلم أثناء التسجيل» for an in-app recording: time («استمع» plays
  it), page label, automatic / manual label, «افتح الصفحة». Its disabled «سجّل» button is shown only when the server says
  recording is not available.

### Tests (all passing, 2026-10-10)
| file | what it proves |
|---|---|
| `srv:media/recordings.test.ts` | sniffing (audio-only WebM / MP4 accepted, with a video track refused); upload → my_audio_note source (owner type, lecture's folder), `audio_for` link, stream served as audio/webm, retry = same recording, listed for the lecture; refusals (video, PDF, empty, no folder) create nothing; strokes with `audio_link` listed (auto), an edited link → manual, a malformed link rejected by the stroke schema, an unknown id → 404 with the reason |
| `srv:media/media.test.ts` (updated) | status: recording `available`, its reason says it starts only on the owner's press |
| `web:src/features/workspace/audio/recorder.test.ts` | support / insecure reasons without touching the microphone; never starts by itself, one microphone request per start, audio only; denied / no device / busy explained, nothing recorded or linked; recording → chunks saved, offsets exclude the pause, no link before the start, tracks stopped, the whole recording stored with its duration; a failed save stays an error; device copy: chunks replaced by the recording, an interrupted recording recovered (not the live one); uploads: idempotent id + fields, refusal kept with the reason and the bytes, offline retried later |
| `web:src/features/workspace/audio/AudioUi.test.tsx` | indicator invisible until started, then dot + «يُسجَّل الآن» + time + pause / resume + stop, announced; refused microphone explained; player seeks to the moment and labels the link; missing recording explained; link editor validation |
| `e2e:f4-handwriting-audio.spec.ts` (recording test) | real server + Chromium fake microphone: no getUserMedia call before the click; indicator and stop visible; a pen stroke written while recording; stop → stored, uploaded as my_audio_note linked to the lecture, the stroke's link is automatic with a plausible offset; lasso tap → «استمع من … (رابط تلقائي)» plays; the audio screen lists the stroke |

### Independent adversarial review of F4 (2026-10-10)
Confirmed and fixed (regression tests fail on the code before the fix):
* **A recording could stay invisible on the device for ever.** A refusal (400/413/415/422) was kept on the device
  «with the reason», but nothing showed it, and the bar had already said «يُرفع عند الاتصال». Now
  `DeviceRecordingsNotice` (in the reader's bottom dock) lists recordings that need the owner's eye — refused (with the
  server's reason), recovered after an interrupted page, or still failing after an attempt — with «نزّل نسخة» (a file of
  the device copy) and «أعد محاولة الرفع» (`recordings.ts deviceRecordingsNeedingAttention / retryRecordingUpload /
  downloadRecording`; `AudioUi.test.tsx`, `recorder.test.ts`).
* **A recording that could not be stored on the device was lost on «إغلاق» or the next «سجّل».** The message told the
  owner to «retry» but there was no retry. The controller now keeps it in memory (`unsaved()`), the bar offers «أعد
  محاولة الحفظ», «نزّل نسخة» and an explicit «تخلَّ عنه» (ConfirmDialog with the consequence) and no close button; a new
  recording cannot start over it; closing the page asks first.
* **The indicator kept saying «يُسجَّل الآن» after the browser stopped the recorder by itself** (microphone unplugged,
  permission revoked, the OS took the device). The recorder's own `stop` event now ends the recording: what was recorded
  is stored and the bar says why (`interrupted`).
* **A second tab «recovered» a recording still being made in the first** (its 4-second chunks), uploading a truncated
  copy under the same id — the full one was then answered as «already stored». The recording tab now holds a Web Lock
  (`medlevo-recording:<id>`) from the start until the recording is stored; recovery skips held ids, and where the
  browser cannot list locks it waits until the newest chunk is 2 minutes old (`RECOVERY_MIN_AGE_MS`); recovery runs on
  every upload pass (not only at start), so a skipped recording is still recovered later.
* Server: **a lecture purged while the recording waited on the device made its upload fail with 404 for ever** (404 is
  retried); the recording is now stored unlinked in the folder sent (or the lecture's), and when no folder exists the
  answer is a final 400 telling the owner to download it and upload it by hand. **Two simultaneous uploads of one
  recording** (two tabs) created two my_audio_note sources and a 500; uploads of one id are now serialised in the server
  and the second gets the first's result. A retried upload of a recording whose source was trashed since is answered
  «stored» (the device stops retrying). (`srv:media/recordings.test.ts`, three «(review)» tests.)
* E2E (`e2e/f4-handwriting-audio.spec.ts` «F4 review: a recording the server refused is never invisible», phone +
  desktop, passing): the server's answer to the upload is staged as 413 → the reader lists «تسجيل واحد لم يقبله الخادم»
  with the reason, «نزّل نسخة» hands over `recording-<id>.webm`, and «أعد محاولة الرفع» (refusal lifted) stores it as the
  lecture's voice note and the notice goes away.

### Limits (honest list)
* Only Chromium with a **fake** microphone was used; no real microphone, no Safari / iPadOS (MP4 recording path is
  implemented from the format, sniff-tested with synthetic boxes only).
* A WebM written by MediaRecorder has no cue index: some browsers can only seek in it after loading; the player then
  starts from the beginning instead of the moment (it never claims otherwise). Server-side remuxing is not built.
* The upload sends the whole recording in one request (bounded by `MEDLEVO_MAX_UPLOAD_MB`); a recording larger than that
  is refused with the reason and kept on the device.
* Automatic transcription and automatic audio ↔ page alignment are still not built (no speech-to-text provider); the
  stroke time links come only from strokes written during the recording.

## Track F3 — cases of a lecture (2026-10-10; §30, §42)

* `GET /api/cases?source_id=<lecture>` (additive filter): the cases whose lecture is that source OR whose Source Lock
  names it (`json_extract(scope_json, '$.lecture_source_id')`). Used by the reader rail's «حالات» section
  (`features/workspace/panels/CasesTab.tsx`, see `docs/modules/workspace.md` «Track F3»). Tests:
  `srv:f3/unconfigured.test.ts` (filter), `web:src/features/workspace/modes/studyModes.test.tsx`,
  `e2e:f3-study-modes.spec.ts` (an owner OSCE station of the lecture listed in the rail).
