# Evaluation, comparison and rollback (§57)

MedLevo measures its accuracy on **separate axes** over a catalogue of cases with **known answers**, keeps a
**regression set apart from the tuning examples**, reports every rate **with its denominator and a 95% interval**, and
requires a **side-by-side comparison** before any change of model, OCR, chunking, retrieval or rules is kept — with a
written way back. No result here is a claim about accuracy beyond these synthetic TEST FIXTURE cases.

Code: `apps/server/src/modules/control/evaluation/` (catalogue, harness, evaluators, runner, report, store, the
evaluation-only scripted provider), CLI `apps/server/src/cli/eval.ts`, Control Center → «تقييم الجودة»
(`/control/evaluation`), contract `packages/shared/src/quality-api.ts`, tables `evaluation_case` + `evaluation_run`
(migration `0710_quality_ops.sql`).

## 1. What a run does

```bash
npm run eval                                  # whole catalogue, scripted AI axes, report → eval-reports/
npm run eval -- --set=regression              # only the frozen regression set
npm run eval -- --axis=key_binding,lecture_link
npm run eval -- --only=key.g4_,cite.          # case id prefixes
npm run eval -- --label="chunker v2" --compare=docs/eval/baseline.json
npm run eval -- --mode=live                   # AI axes with the configured provider (needs ANTHROPIC_API_KEY)
npm run eval -- --strict                      # exit 5 when any regression case fails or errors (a gate for a fully green set)
npm run eval -- --set=regression --compare=docs/eval/baseline.json --no-record   # what CI runs: exit 4 on a NEW failure, 6 if not comparable
npm run eval -- --help
```

1. A **throwaway MedLevo server** is built in a temporary data directory (its own database, the real modules, an
   evaluation owner). The owner's library is never touched; the directory is deleted at the end.
2. Exactly the fixtures the selected cases read are **uploaded through the real API** (`/api/sources/upload`, and
   `/api/questions/quick-add` for the photographed question) into courses, question sources before their lecture
   (AC-16 order), and **processed by the real pipeline** (pdf.js, poppler, tesseract OCR, question extraction,
   lecture matching, figure captions).
3. Every case is evaluated against what the real system produced — through the HTTP API where a view exists
   (`/api/questions/:id`, `/api/questions/for-lecture/:id`, `/api/media/images/match`, `/api/studybook/threads/*`), the
   services otherwise (`validateClaims`, `validateImageCandidate`, `detectDir` / `segmentRuns`, the export renderer).
4. The report is written as **JSON + Markdown** (`eval-reports/<run>.json|md` and `latest.*`), and recorded in the
   server's database when it exists (Control Center → «تقييم الجودة» shows the latest run, the run history and the
   comparison with the previous run; «نزّل التقرير الكامل» downloads the Markdown).

Exit codes: 0 report written · 1 the run failed · 2 usage · 4 `--compare` found a regression · 5 `--strict` and the
regression set has failures or errors · 6 `--compare` could not compare: the regression set changed (another catalogue
hash), or regression cases the base run passed were **not evaluated** in this run (filtered out by `--set` / `--axis` /
`--only`, or `not_run` — e.g. `--mode=live` without a key). «No regressions» is never claimed for cases that were not
compared (review of track F5: before, such a run compared as `no_regressions` and exited 0).

### Outcomes

`pass` · `fail` (the system's answer differs; a thing it did not produce at all is a fail) · `error` (the evaluation
itself could not decide, e.g. an HTTP 400 — never counted as a pass) · `not_run` (blocked here, with the reason — e.g.
`--mode=live` without a key). The denominator of a rate is `pass + fail + error`; `not_run` is counted apart.

### Honest numbers

* Every rate is a fraction **with its denominator** and a **Wilson 95% interval**; a set under 30 cases is marked
  «عينة صغيرة» / «small sample».
* A perfect sample is written «n / n نجحت — الحد الأدنى لفاصل الثقة 95%: x%», never «100%»; interval bounds are capped
  at 99% so a rounding artefact never reads as perfection (`report.ts`, `quality-api.ts evalRateTextAr`; tested).
* «Citations exist» is never called accuracy: citation validity, claim support, abstention and over-abstention are
  four separate axes.

## 2. The catalogue (EvaluationCase store)

`catalogue.ts` holds every case: `id`, `axis`, `set`, an Arabic title, the **check** (what to look at) and the
**expected** value. At server start the control module upserts the catalogue into `evaluation_case` (with who reviewed
the expected values and where they come from); a case removed from the catalogue is **retired**, never deleted.

| axis | what is checked | cases (regression / tuning) |
|---|---|---|
| `text_accuracy` | page text contains the printed sentences (EN + AR), OCR of the scanned page, page labels from `/PageLabels` and detected footers, DOCX headings, PPTX titles, the reversed lam-alef never stored, no bogus question from a value or a key line, no running header in a stem | 6 / 23 |
| `negation_numbers` | NOT / EXCEPT / except / لا / إلا / عدا / خاطئة kept AND emphasized, values and units exactly as printed (10⁹ as a font effect, PaCO₂, «6,5», «< 0.5 mL/kg/h», «٣٫٥ ملمول/لتر») | 17 / 7 |
| `options_completeness` | the real number of options, their printed labels (A–E, أ–هـ) and texts, options at the bottom of the next page | 3 / 12 |
| `key_binding` | source key per section, sections that restart at 1, a merged key line, an unreadable key format (no guess), a trailing unlabeled key (not bound by number), missing key, a hand-circled option = unofficial mark (AC-13) | 18 / 11 |
| `citation_validity` | a valid in-scope alias is kept; an alias never handed out, a raw / fabricated id, out-of-scope evidence are refused and never become citations (AC-05 / AC-06) | 5 / 0 |
| `claim_support` | restated claim linked; cross-language claim linked (no over-rejection); changed number, added negation, changed unit not linked even when the verifier says «supported»; topical-only claim rejected by the independent verifier (AC-07) | 6 / 0 |
| `abstention` | out-of-scope question abstains **without** a generator call; real-patient request abstains; an answer citing only a fabricated alias or an unsupported claim shows nothing as supported | 4 / 0 |
| `over_abstention` | an in-scope question with a correctly cited answer is **not** abstained: anchored, retrieved by keywords (EN and AR) | 5 / 0 |
| `image_match` | the AC-09 gate on the real atlas (X-ray + pneumothorax, Arabic request, CT, child) and on caption examples (finding gone / drawn / other modality excluded) | 4 / 7 |
| `lecture_link` | questions «directly covered» by the lecture with the page, others not (golden EN; Arabic bank before its lecture) | 3 / 7 |
| `rtl_bidi` | no stored bidi control characters, paragraph direction, LTR terms and values isolated as one run in the export HTML, «11.5 ×10⁹/L» in logical order inside an Arabic stem | 9 / 2 |

**Regression vs tuning (marked per case, reported apart, never mixed into one rate):**

* **tuning** — the Golden Set (`fixtures/golden`, ground truth `expected.json`): the extractors, parsers and matchers
  were *developed against these files*, and the AC-09 caption examples were written while fixing the validator. A high
  rate here shows fit to what the system was tuned on, not generalization.
* **regression** — checks **frozen** at `CATALOGUE_VERSION` (`eval-catalogue-2026.10-1`): the acceptance fixtures
  built later by the adversarial groups G3–G5 (`fixtures/acceptance`) and the behavioural checks written for this track.
  They are **not held-out data**: G3–G5 fixed defects against these very fixtures (`docs/ACCEPTANCE.md`,
  «pass_after_fix»), so a high regression rate is not evidence of generalization either.
  Their expected values change only with a **reviewed catalogue bump**; every report carries the **regression hash**
  (sha256 of ids + checks + expected values) and two runs are compared only on the same hash (`--compare` exits 6
  otherwise, so CI fails until the baseline is re-written in the same reviewed change).
* When rules or prompts are tuned, new examples go to the **tuning** set. The regression set is never edited to make a
  run pass. Honest limit: both sets were seen by the people who wrote the code; the regression set is held fixed from
  now on, which is what keeps it useful.

**Who reviewed what** (`evaluation_case.reviewed_by`): Golden Set cases → `expected.json`, authored with the fixtures
and checked against `pdftotext` / `pdfinfo`; acceptance cases → the acceptance groups' README and tests;
behavioural cases → this track, following the evidence contract (ARCHITECTURE §3.6). The fixtures are synthetic
structural documents, not medical references, and are never shown to the owner as study material.

### AI axes: scripted vs live

There is no AI key in this environment. `claim_support`, `abstention` and `over_abstention` run the **server's real AI
path** (retrieval, Source Lock, evidence aliases, claim validation, abstention, publishing) with an
**evaluation-only scripted provider** (`scripted.ts`): each case scripts what the "model" answers, and the independent
verifier's verdict. A scripted run therefore measures the **server's guarantees** — a correctly cited answer is kept and
linked, an unsupported one is not shown as supported, an out-of-scope request abstains — **not a model's quality**; the
report says so on every scripted axis. The scripted provider is constructed only by the evaluation runner inside its
throwaway data directory; it is never registered by the server.

`--mode=live` runs the same cases against the provider configured on the server (no scripts; the real verifier). Without
`ANTHROPIC_API_KEY` those axes are `not_run` with the reason (tested). **Blocked:** model-quality evaluation has never
been run here.

## 3. Results (baseline, 2026-10-10, scripted mode)

Committed reference run: [`docs/eval/baseline.json`](eval/baseline.json) / [`baseline.md`](eval/baseline.md)
(`npm run eval -- --write-baseline`; 149 cases, 18 fixtures, ~15 s on this container).

| set | result |
|---|---|
| regression (frozen) | 79 / 80 — 95% CI 93%–99% |
| tuning examples | 69 / 69 passed — 95% CI lower bound 95% |

Per axis every regression set is a **small sample** (3–18 cases); read them as «nothing failed among these n», not as
rates. The one regression case that does not pass is a **measured over-abstention**:

* `overabstain.pregnancy_test` — «Which test is required in women of reproductive age with suspected appendicitis?» in
  the lecture-only scope abstains with `not_found_in_scope` *without calling the generator*, although the lecture states
  «A pregnancy test (β-hCG) is required in women of reproductive age.» The keyword retrieval does not surface that
  region for this wording (the anchored and other keyword questions are answered). This is reported, not tuned away:
  the fix belongs to the evidence / retrieval module, and the case stays in the frozen set to show when it is fixed.

## 4. Compare and roll back a change

Every result depends on recorded versions (`report.system`): `pipeline` (processing / OCR orchestration,
`PIPELINE_VERSION`), `index` (chunking, `INDEX_VERSION`), `question_parser`, `question_matcher`, `ai_rules`
(`AI_RULES_VERSION`), `studybook_generator`, `claim_verifier` (`VERIFIER_VERSION`), the OCR engine and language data
versions, `pdfjs-dist`, the git commit, and the models per role in live mode. Cache keys of generated content already
include the generator / verifier / rules versions and the scope (ARCHITECTURE §3.7), so a changed version never reuses
an artifact built by the old one.

**The procedure — for any change of model, OCR, Vision, chunking, retrieval or explanation rules:**

1. **Before**: on the current code, `npm run eval -- --label="before <change>"` (or use `docs/eval/baseline.json` when
   nothing changed since it was written). Keep the JSON.
2. **Make the change on a branch** and **bump the version that names it** (table below). A change that does not move
   a version is still visible through the git commit in the report, but the version bump is what invalidates caches.
3. **After**: `npm run eval -- --label="after <change>" --compare=<before>.json`. The comparison
   (`compare-<base>-<head>.md|json`) lists the system changes, the per-axis regression rates side by side, every case
   that **stopped passing**, every case that **now passes**, and every regression case the «before» run passed that
   this run did **not evaluate**. Exit 4 = a regression-set case stopped passing; exit 6 = not comparable (another
   regression set, or regression cases not evaluated — run the whole regression set).
4. **Decide**: a regression case that stopped passing blocks the change until it is explained (a real improvement
   that reveals a wrong expectation needs a reviewed catalogue bump — never a silent edit). Record the decision in the
   change log of the PR. Tuning-only differences are reported but do not block.
5. **Roll back** (table below) if the change is not kept; re-run the evaluation and confirm the comparison with the
   «before» run says `no_regressions`.

| change | version to bump | what happens to existing data | roll back |
|---|---|---|---|
| **model** (`MEDLEVO_MODEL_GENERATION / VERIFICATION / VISION`) | none in code — the model is recorded per artifact (`artifact.model`) and per call (`usage_record.model`) | Control Center → «الذكاء الاصطناعي» → impact preview lists the generated content of that role; nothing is regenerated automatically | restore the previous env value, restart the server; content generated meanwhile keeps its recorded model and can be regenerated by the owner |
| **OCR / extraction** (tesseract.js, traineddata, layout, `processing/*`) | `PIPELINE_VERSION` (`processing/pipeline.ts`); the dependency itself in `package-lock.json` | existing versions are **not** reprocessed automatically; the owner reprocesses a source (`/api/sources/versions/:id/reprocess`) — owner corrections (`owner_reviewed` regions) are kept, dependents get a content alert | revert the commit / lock file and `PIPELINE_VERSION`; reprocess the versions processed with the new code (job outputs record the pipeline version) |
| **chunking** (`processing/chunks.ts`) | `INDEX_VERSION` | chunks of another index version are replaced the next time a version is chunked (re-index / reprocess); search and retrieval keep working on the old chunks until then | revert the code and `INDEX_VERSION`; reprocess (re-index) the affected versions |
| **retrieval** (`evidence/retrieval.ts`, `pack.ts`, `terms.ts`) | no dedicated constant: the git commit in the report identifies it; bump `GENERATOR_VERSION` (`studybook/rules.ts`) when generated content should not be reused | cached artifacts are reused only when their cache key matches; nothing is regenerated automatically | revert the commit; compare again |
| **explanation rules / prompts** (`studybook/rules.ts`, owner / folder rule overrides) | `GENERATOR_VERSION`, `AI_RULES_VERSION`; owner rule changes change the per-artifact `rules_version` | Control Center impact preview → apply with a fresh token; old artifacts are no longer reused for new requests, never rewritten | revert the code / the rule change (the Control Center re-applies the old rules the same way) |
| **verifier** (`evidence/claims.ts`, `critical.ts`) | `VERIFIER_VERSION` | stored claims keep their recorded `verifier_version` per check (`verification_result`) | revert the commit and the version |
| **question parser / matcher** | `PARSER_VERSION`, `MATCHER_VERSION` | re-extraction keeps owner decisions (keys, links, duplicates); links store the matcher version | revert and re-run extraction / matching for the affected sources |
| **database schema** | a new migration file (never edit an applied one; the runner refuses a changed checksum) | forward-only; `npm run backup` before an upgrade | restore the backup taken before the upgrade (`docs/BACKUP_RESTORE.md`) |

## 5. Tests and limits

* `apps/server/test/control/evaluation.test.ts` (19): Wilson bounds, denominators, no «100%» (Arabic, English, Markdown,
  large samples too), catalogue integrity (unique ids, every axis, both sets, fixtures exist, no Golden Set file in the
  regression set), regression hash, case selection and upload order, compare (regressions / fixes / system changes /
  not comparable), the runner on the real pipeline (a subset: citation, support, abstention, over-abstention, keys,
  links, bidi, captions), wrong expectations → fail, missing question → fail, unscripted generator call → fail with its
  reason, invalid request → evaluation error, live mode without a key → not_run, the store (catalogue upsert / retire;
  an unchanged catalogue writes nothing at boot, so a restored database stays identical to its backup — AC-30; 50 runs kept), the Control Center routes (auth, 404, Markdown download), and the CLI itself (files written, `--compare`
  exit code follows the comparison).
* **Review of track F5 (2026-10-10):** a comparison used to skip every regression case the head run did not evaluate,
  so `--mode=live` without a key, an `--axis` / `--only` run, or two Control Center runs with different filters
  compared as `no_regressions`, and `--compare` exited 0 also when the regression set itself had changed (another hash)
  — a CI gate that a catalogue edit or a skipped axis passed silently. Now those cases are listed (`not_compared`), the
  verdict is `not_comparable` (a real regression still wins) and the CLI exits 6. Tests: `compareReports` (filtered /
  `not_run` / CI-shaped `--set=regression` head) and the CLI (exit 6 for a filtered run and for another catalogue hash);
  web: the not-compared list in «مقارنة بالتقييم السابق».
* `apps/web/src/features/control/quality.test.tsx`: the evaluation view (empty state, denominators, no «100%», failed
  cases with reasons, comparison, regression cases not compared, Markdown link).
* Limits: the cases are synthetic; per-axis sets are small; scripted AI axes measure the server, not a model;
  semantic retrieval does not exist (no embeddings provider), so the catalogue has no semantic-search axis; Vision
  (figure structure) and handwriting recognition are not evaluated (no vision provider here).
