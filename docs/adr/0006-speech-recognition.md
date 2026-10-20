# ADR-0006 — Speech recognition for mixed Iraqi-Arabic / English lectures

- **Status:** Accepted for design, 2026-10-20; revised the same day after the design review (an evaluation the owner
  runs from an iPad, absolute quality floors per stratum, capacity arithmetic, one shared transcript per shared official
  recording, a separate ASR worker, CPU-minute quotas, consent for external processing). Owner questions use the numbers
  of PRD §11. No speech-to-text exists in MedLevo today:
  * `AiTask 'transcribe'` maps to `null` in `providers/anthropic.ts`;
  * `GET /api/media/status` reports `transcription: requires_configuration`, with `TRANSCRIPTION_AR`;
  * transcripts come only from typing or VTT/SRT import (`media/subtitles.ts`).

  This ADR fixes the interface, the pipeline, the evaluation and the honesty rules **before** any engine is chosen.
- **Spec:** Academic OS §7 (mixed Iraqi dialect, MSA, English and medical terms, code-switching; streaming ASR,
  code-switching detection, medical terminology, custom vocabulary per subject, diarization, noise reduction, VAD,
  silence detection, optional silence skipping that keeps the original, chapters, speed, transcript correction that
  keeps time links), §8 (Exam Radar), §9 (live copilot, offline recording always), §15 (voice search), §21 («evaluate
  whisper.cpp or sherpa-onnx … with real tests on Iraqi dialect and mixed terms; do not assume accuracy from the model
  name»), §22 (ASR quality on real Arabic–English samples).
- **Related:** ADR-0002 (AI orchestrator policy, usage records), ADR-0003 (per-user quotas, consent registry),
  ADR-0004 (resumable uploads), ADR-0005 (native background recording), ARCHITECTURE_DELTA §9 (timeline) and §10
  (Exam Radar, copilot).

## 1. Context — what was measured (spike 3, `…/scratchpad/spikes/asr`)

* **Obtainable here.**
  * whisper.cpp built from source (commit 231638a0) in 138 s on 4 vCPU (AVX2, AVX-512, VNNI).
  * Models from Hugging Face: `ggml-tiny` 77.7 MB, `ggml-base-q5_1` 59.7 MB, `ggml-small-q5_1` 190.1 MB.
  * `sherpa-onnx-node@1.13.8` installs with a prebuilt linux-x64 binary and loads. It exports `OfflineRecognizer`,
    `OnlineRecognizer`, `Vad` and `SpokenLanguageIdentification`.
  * ffmpeg is present in this container.
* **English only.** 481 s of clean read speech (LibriSpeech dummy set, 1,150 reference words), 4 threads,
  `OMP_WAIT_POLICY=passive`:

  | model | wall time | real-time factor | WER |
  |---|---|---|---|
  | tiny | 100.9 s | **0.210** | 8.70 % |
  | base-q5_1 | 139.2 s | **0.289** | 9.13 % |
  | small-q5_1 | 324.8 s | **0.675** | 10.35 % |

* **Long-form decoding drops passages.** base dropped runs of 15 and 19 words; small dropped runs of 11, **47** and 10
  words. The WER ordering above reflects these skipped segments, not model quality.
* **OpenMP spin-waiting** on a shared CPU made decoding ≈ 25× slower (84.6 s vs 3.5 s for an 11 s clip with tiny).
* **No Arabic, Iraqi or mixed audio was run.** No Arabic accuracy is claimed anywhere in this ADR.
* **Cloud options** (public docs, 2026-10-20, untested):
  * Azure Speech lists `ar-IQ`, including custom models trained on audio plus human-labelled transcripts.
  * Google Cloud STT v2 lists `ar-IQ` with chirp_3, long and short models.
  * Deepgram lists `ar-IQ`.
  * AWS Transcribe lists only `ar-AE` and `ar-SA`.
  * OpenAI lists `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize` and `whisper-1`, with
    files up to 25 MB and no per-dialect locale.
* **Harness.** `eval_asr.py` (pure Python, no dependencies) computes, with Arabic normalisation and script-aware error
  attribution:
  * WER overall, on Arabic-script tokens and on Latin tokens; CER on the Arabic part;
  * English-term preservation and a transliteration count;
  * glossary recall;
  * real-time factor.

  A self-test with two invented sentences matched hand-computed values exactly (WER 0.2308, Arabic 0.25, English 0.20,
  Arabic CER 0.50, preservation 0.80 with 1 transliteration, glossary recall 0.6667, RTF 0.2667).

## 2. Decision

### 2.1 A separate `SpeechProvider` interface behind a speech orchestrator

Speech is streamed audio with timing, not a prompt with structured output, so it does not fit `AiProvider`. A
`SpeechOrchestrator` (`ctx.speech`) owns the policy, as `ctx.ai` does for text:

* a capability per engine and mode;
* the **consent check** before audio leaves the device or the server;
* the per-user minutes quota and the per-session cap (ADR-0003 §3.8);
* a `usage_record` for every run (task `transcribe`, engine, model, seconds billed, **estimated** cost, status — never
  audio or text);
* Arabic error reasons.

```ts
// apps/server/src/modules/media/speech/types.ts (draft)
export type SpeechEngineLocation = 'device' | 'server_local' | 'cloud';

export interface SpeechCapabilities {
  engine: string;                              // 'whisper.cpp' | 'sherpa-onnx' | 'azure' | 'google' | 'deepgram' | 'openai'
  model: string;
  location: SpeechEngineLocation;
  modes: ReadonlyArray<'batch' | 'streaming'>;
  languages: ReadonlyArray<string>;            // as the vendor advertises them (e.g. 'ar-IQ', 'ar', 'en-US'), never inferred
  wordTimestamps: boolean;
  languageId: 'none' | 'segment' | 'word';
  vocabulary: 'none' | 'prompt' | 'hotwords' | 'phrase_list' | 'custom_model';
  diarization: boolean;
  maxFileBytes?: number;
}

export interface TranscribeOptions {
  languageHints: string[];                     // e.g. ['ar-IQ', 'ar', 'en']
  vocabulary?: { version: string; terms: string[] };   // §2.5
  diarization: boolean;
  vad: 'engine' | 'external' | 'none';         // 'external' = segments already cut by our VAD (§2.6)
  signal: AbortSignal;
}

export interface AsrWord { text: string; start_ms: number; end_ms: number; confidence?: number; script: 'arabic' | 'latin' | 'digit' | 'other' }
export interface AsrSegment {
  start_ms: number; end_ms: number;            // ORIGINAL recording time
  text: string;                                // exactly what the engine returned (never translated / transliterated)
  words?: AsrWord[];
  lang?: 'ar' | 'en' | 'mixed';
  confidence?: number;
  speaker?: string;                            // engine label ('S1'), never a person's name
}
export interface AsrResult { segments: AsrSegment[]; engine: string; model: string; billedSeconds: number; requestRef?: string }

export interface SpeechProvider {
  readonly name: string;
  capabilities(): SpeechCapabilities;
  transcribeFile(input: { path: string; mime: string; durationMs: number | null }, opts: TranscribeOptions): Promise<AsrResult>;
  openStream?(opts: TranscribeOptions & { sampleRate: 16000; encoding: 'pcm16' | 'opus' }): SpeechStream;
  estimateCostUsd(seconds: number, mode: 'batch' | 'streaming'): number;   // ESTIMATE, config-driven price table
}
export interface SpeechStream {
  push(chunk: Uint8Array): void;
  onPartial(fn: (s: AsrSegment) => void): void;   // drafts: shown as drafts, never stored as final
  onFinal(fn: (s: AsrSegment) => void): void;
  close(): Promise<void>;
}
```

Errors reuse `ProviderError` kinds (ADR-0002) and map to `AI_PROVIDER_ERROR` with a specific Arabic reason.

### 2.2 Engines — chosen only by measured results on the owner's recordings

No engine is the default until the harness (§2.10) has run on real lecture audio. The adapters below are all allowed
behind the same interface:

1. **`server_local`: whisper.cpp (batch).**
   * Runs as a job in a separate process with a timeout, in the same isolation pattern as LibreOffice.
   * Uses `OMP_WAIT_POLICY=passive` and a thread cap, because spin-waiting was measured at ≈ 25× slower on a shared
     CPU.
   * Always cuts audio with VAD first (§2.6), so long-form decoding cannot silently drop passages.
   * Cost: CPU time — **not free**. Arithmetic only, from the measured English real-time factors: a 60-minute lecture
     takes ≈ 12.6 / 17.3 / 40.5 min of a 4-vCPU host. §2.13 shows why that cannot serve per-student transcription.
   * It runs in a **separate worker service**, not in the web process, so it never competes with OCR and HTTP traffic.
     Render's documentation states that a persistent disk is reachable by one instance only (DOC, not tested), so the
     worker cannot share the web service's disk: it reads audio from R2 (AOS-OC.7) and writes results back through the
     job API.
2. **`server_local`: sherpa-onnx (batch and streaming).** It installs and loads here. Its streaming `OnlineRecognizer`
   and silero `Vad` are candidates for live captions on the server. Arabic and code-switching models are not
   evaluated.
3. **`cloud`: Azure, Google, Deepgram, OpenAI.** Adapters are written against the public APIs only when the owner opts
   in (owner questions 1–2).
   * Vendor dialect lists (`ar-IQ`) are recorded as **«مذكور في وثائق المزوّد، لم يُقيَّم»** (listed in the vendor's
     docs, not evaluated) and never presented as accuracy.
   * AWS is not planned: no `ar-IQ`.
4. **`device`: on-device models** in the native shell (`whisper.rn`, `capacitor-whisper`, sherpa-onnx mobile).
   * Later, and only after device measurements (ADR-0005).
   * Browser WASM is not tested and not planned for Phase 3.

### 2.3 Pipeline: the recording is never at risk

1. **Capture.** Unchanged (`apps/web/src/features/workspace/audio/*`).
   * Recording starts only on an explicit press and the indicator stays visible.
   * Chunks go to IndexedDB every 4 s.
   * Upload is resumable through the chunked upload sessions of ADR-0004 §2.7. This replaces the single 200 MB request
     for long lectures.
2. **Live captions** (optional, online, with consent; §9 Live Transcription).
   * An AudioWorklet downsamples to 16 kHz mono. Frames go over the space or vault WebSocket as Opus via WebCodecs
     `AudioEncoder` where available, else PCM16 (≈ 115 MB/h).
   * Partials are drafts in the UI. Finals are stored as `transcript_segment` rows with `origin = 'transcription'` and
     the run id.
   * The stream is **independent of the saved recording**: a dropped stream loses live captions only, never audio.
   * Streaming runs off the ink thread: worklet plus worker. The pen path gets no extra work (docs/PERFORMANCE.md
     budgets).
3. **Batch transcription** after upload. A job `transcribe_recording` has the idempotency key
   `(audio_id, engine, model, vocab_version)`:
   * decode with ffmpeg to 16 kHz mono PCM in an isolated temp dir;
   * run VAD and cut into speech windows of ≤ 30 s;
   * transcribe each window, with a checkpoint per window so a crash resumes;
   * merge, post-process (§2.4–2.5) and write a `transcription_run` plus its segments.
   * Offline-first (§9): if no engine is available, the recording is kept and the run waits as
     `waiting_for_input` with the reason. It never fails silently.
4. **Re-runs never overwrite a correction.** The existing rule is kept: `transcript_segment.text` is the engine's
   output and is never edited; user corrections go to `corrected_text` with `transcript_revision` history.
   * A new run on the same audio fills only the time ranges that have **no user-corrected segment**.
   * Corrected segments of an older run stay and are labelled «تصحيحك على تفريغ سابق» (your correction on an earlier
     transcript).
   * Time links (`media_region_link`, stroke `audio_link.offset_ms`) are in original recording time, so a re-run never
     moves them.

### 2.4 Mixed language: keep English as English

* **Script tagging.** Each word is tagged by script (Arabic / Latin / digit) after recognition. Segment language is
  `ar`, `en` or `mixed`. Engine language ids are kept when provided.
* **No translation or transliteration**, ever. Normalisation (for search and matching only) uses the same Arabic rules
  as `ml_norm` and the harness (diacritics, tatweel, alef/hamza, ة/ه, ى/ي, Arabic-Indic digits). It never changes
  `text`.
* **Rendering.** Mixed segments display through `RichTextView`/`Bidi` isolates. That part is solved already (AC-20).
* **Transliterated English** (an English term the engine wrote in Arabic script) is *counted* by the harness. Mapping it
  back to Latin is a candidate post-correction, enabled only if the harness shows it helps and never hurts.

### 2.5 Custom vocabulary per subject (medical terminology)

* **Building the vocabulary.** A job builds `asr_vocabulary` per subject and per lecture from:
  * accepted and stated Course Brain concept names and aliases (`concept`, `concept_alias`);
  * the Terms dictionary (`medical_term`: term, abbreviation, synonyms);
  * Latin-script terms that occur at least twice in the lecture PDF being recorded (headings first);
  * moderator additions for official subjects, and the user's own additions.

  It is versioned (`vocab_version` = hash of the sorted terms), so runs are reproducible.
* **Biasing**, depending on what the engine supports:
  * prompt: whisper initial prompt, with the most lecture-relevant terms cut to the engine's prompt limit;
  * hotwords: sherpa-onnx transducers;
  * phrase lists: Azure, Google;
  * custom models: Azure, only if the owner opts in.
* **Post-correction** maps a Latin-script word within a normalised edit distance ≤ 2 of a vocabulary term.
  * The result goes to `transcript_segment.normalized_text` and to `words_json[i].vocab_match`. The engine's `text` is
    kept.
  * The UI marks corrected words. Search indexes both forms.
  * The harness measures glossary recall with and without it before it is turned on.

### 2.6 VAD, silence and «skip silence»

* **Server VAD.** sherpa-onnx `Vad` (silero) or whisper.cpp's VAD produces speech/silence intervals in
  `audio_interval`. They are used for chunking, chapters and silence skipping.
* **Client meter.** An energy-based VAD in an AudioWorklet drives the level meter and the «صمت» (silence) hint only. It
  is testable here with synthetic audio.
* **«تخطَّ الصمت» (skip silence)** is a playback mode. The player jumps over silence intervals ≥ 1.5 s (configurable).
  * The original file is untouched and still streamed with Range.
  * All times stay in **original recording time**: segments, stroke offsets, timeline events, exam highlights. The
    player maps original ↔ compressed time and never stores compressed time.

### 2.7 Diarization

* Optional, only where the engine supports it.
* Labels are `S1`, `S2` with `speaker_origin = 'diarized'`, **never a name**. A user may name a speaker
  (`speaker_origin = 'owner'`).
* Imported VTT `<v Name>` keeps today's rule: the speaker is shown «كما في الملف» (as in the file) and never guessed.
* The lecturer is never identified automatically.

### 2.8 Noise reduction

* The browser constraints stay as they are (`noiseSuppression`, `echoCancellation`).
* Optional server-side denoise (ffmpeg filters) produces a **derived** 16 kHz file used **only as ASR input**. The
  original recording is never replaced.
* Denoise is enabled per engine only if the harness shows lower WER/CER on the owner's samples. The effect is never
  claimed without that measurement.

### 2.9 Transcripts as evidence, and the lecturer's words as their own origin

* A transcribed recording version gets source regions:
  * `source_page` with `kind = 'audio_segment'` (already allowed);
  * `source_region` with `kind = 'transcript'` and `locator_json {start_ms, end_ms}`;
  * `text_origin = NULL` and a new column `text_origin_ext = 'asr'`.

  The `text_origin` CHECK in `0001` cannot take a new value without a table rebuild. A rebuild like `0310` is **not
  safe** for `source_region`:
  * many tables reference it by foreign key (evidence, image_asset, question_option, answer_key_entry,
    concept_mention, parent regions);
  * two BEFORE DELETE triggers fire on it (`0500`, `0800`);
  * the runner cannot switch foreign keys off inside a migration transaction.

  So the reading engine goes into a new additive column (ARCHITECTURE_DELTA §4.2). Every check that treats OCR text as
  a machine reading also treats `text_origin_ext = 'asr'` as one.
* **Machine readings are needs_review.** ASR regions are created with `source_region.status = 'needs_review'`.
  * The existing rule in `evidence/claims.ts` (G3/AC-08, Round 7 H1-3) then keeps any claim supported only by such
    regions at `needs_review`, never `linked`.
  * When the user corrects or confirms a segment, its region becomes `owner_reviewed`, exactly as a reviewed OCR region
    does.

  The citation label is «الدقيقة m:ss», which already exists in `evidence/evidence.ts`.
* **Three origins, never merged.** The tutor, radar and copilot keep separate, visibly labelled origins:
  * **lecturer said** («قال الدكتور في التسجيل»): a quote from the transcript with its time;
  * **generated**: the existing label, evidence-checked;
  * **external reference**: the capability `external.evidence` is still `not_implemented`.

  A lecturer's spoken answer **never** becomes an official answer key (AC-13 rule; ARCHITECTURE_DELTA §10.2).

### 2.10 Evaluation harness — the only basis for any quality statement

* **Port.** The harness metrics move from the spike script into the existing evaluation store as axis `asr`
  (`control/evaluation`, `evaluation_case` / `evaluation_run`). The normalisation is identical and a test pins the
  self-test values. `npm run eval` stays for CI, but the owner never needs it.
* **Operable from an iPad (PRD AOS-OC.10; owner clarification 1).** The first draft needed a terminal and had a
  bootstrapping contradiction — references were to be made by correcting automatic drafts, while no engine could run
  before the evaluation. The in-app flow resolves both:
  1. **Mark samples.** On a recording (`/media/audio/:id`) the owner selects time ranges and taps «استخدمه للتقييم»,
     choosing the stratum (Iraqi dialect / MSA / code-switched) and the conditions (front row, back row, phone in a
     pocket). Samples stay in the owner's vault and are **never committed** to the repository.
  2. **Evaluation-only run.** In the platform section of the Control Center the owner configures a candidate engine as
     `evaluation_only`: it may transcribe the marked samples and nothing else, and the `transcription` capability
     stays `requires_configuration` for every user. Cloud candidates still need the owner's approval of the named
     provider (Q9) and the owner's own `cloud_asr` consent for these samples.
  3. **Correct.** A phone-friendly correction screen shows each draft segment with play-from-here, the word list with
     scripts marked, and a large text field; the owner corrects and taps «مراجَع». References made this way are
     labelled «مرجع مصحَّح من مسودة آلية» and the report states which engine produced the drafts, because correcting a
     draft biases the reference toward it (Q33). Typed references are labelled «مرجع مكتوب».
  4. **Run.** «شغّل التقييم» starts the harness as a server job for every candidate on the reviewed set; the report
     (tables per stratum, the floors met or missed) is shown in the same screen and kept with the run.
* **Dataset size per stratum.** At least **10 minutes per stratum** before any default, with 95 % bootstrap intervals
  reported; ≥ 2 hours in total for the Phase 3b report (X10). One owner, few lecturers and one recorder are a small,
  single-source sample: the report says so, and each subject keeps the label «لم يُقيَّم على محاضرات هذه المادة» until
  segments of that subject's lectures are in the set.
* **Reported per engine, model, vocabulary version and denoise setting:**
  * WER overall, Arabic-token WER and CER, English-token WER;
  * English-term preservation, transliteration count, glossary recall (medical terms);
  * real-time factor; **dropped runs** (deletion runs ≥ 5 words), so skipped passages show up;
  * streaming latency, for streaming engines.
* **Gates (PRD Q28).** Relative ranking alone would let a poor engine become the default when every candidate is poor.
  An engine becomes the default only if, on the owner's set:
  * it meets the **absolute floors in every stratum** — proposed for the owner to confirm or change: Arabic-token CER
    ≤ 0.20 on the Iraqi stratum and ≤ 0.15 on MSA, English-term preservation ≥ 0.90, medical glossary recall ≥ 0.80,
    no deletion run ≥ 10 words (placeholders chosen so a transcript is usable for search and the radar, **not**
    predictions of any engine);
  * among those that do, it is best on Arabic CER **and** English-term preservation;
  * its CPU-minutes (local) or price (cloud) fit the quotas of §2.13.

  An engine that misses a floor is never enabled for users, and PRD AOS-7.2–7.7, 21.50 and S1.4 stay «Blocked / Not
  met» even though a report exists. The report states the numbers and never says «accurate».

### 2.11 Capability honesty

| situation | `transcription` / `asr.batch` | `asr.streaming` | wording |
|---|---|---|---|
| no engine configured (today) | `requires_configuration` | `requires_configuration` | today's `TRANSCRIPTION_AR`: no recording is sent to a provider without an explicit action |
| engine configured, not evaluated on the owner's set | `available` + label | `available` + label | «متاح — لم يُقيَّم بعد على محاضرات باللهجة العراقية» (available — not yet evaluated on Iraqi-dialect lectures) |
| evaluated, every floor met | `available` + the measured summary | same | «قِيس على N دقيقة من محاضراتك: …» (measured on N minutes of your lectures: …) with the figures, no adjectives; per subject «لم يُقيَّم على محاضرات هذه المادة» until its lectures are in the set |
| evaluated, a floor missed | `requires_configuration` for users (evaluation-only for the owner) | same | «قيس ولم يبلغ الحد المطلوب: …» with the figures |
| cloud engine without the user's consent | `requires_configuration` for that user | same | «يحتاج موافقتك على إرسال الصوت إلى مزوّد خارجي» (needs your consent to send audio to an external provider) |
| quota used up | `requires_configuration` (quota) | same | the remaining minutes and the reset date |
| offline | recording `available`; transcription `requires_connection` | `requires_connection` | the recording is saved; transcription runs when the device is back online (§9) |

### 2.12 Consent, privacy and cost

* **Capture.** Personal recording keeps today's rules: an explicit start and a visible indicator.
* **Cloud transcription** needs a `consent_record` of kind `cloud_asr`, per recording or as a standing setting the user
  can revoke. It names the provider. The Arabic UI states that the audio leaves the deployment.
* **Shared recordings and room recordings** need the consent records of ARCHITECTURE_DELTA §5.6 before any share: the
  subject's lecturer recording policy **and** the recorder's attestation per share (PRD Q8), and every participant for
  room recordings.
* **Other people's voices.** A lecture recording carries the lecturer's and classmates' voices, not only the
  recorder's. Before lecture audio — or a transcript of it — is processed by a **cloud** ASR engine or sent to an
  **LLM** (copilot answers, live summaries, translation, radar AI, fusion), the subject's lecturer policy must allow
  external processing (it records that a notice is shown in the hall); outside any subject the recorder attests it for
  that recording. Server-local engines and the deterministic radar need no such policy, because the audio never leaves
  the deployment.
* **The user's own data to AI providers.** Private notes, handwriting crops and transcripts go to an AI provider only
  with the user's `ai_processing` consent naming the providers (PRD AOS-21.42), shown and revocable on `/me/privacy`.
* **No training.** No audio or transcript is used to train any model. Cloud adapters set the vendor's «no data
  retention / no training» options where the vendor offers them, and the owner reviews each vendor's terms before
  enabling it (PRD Q9; §4 question 2).
* **Cost.** Estimated minutes cost per engine comes from a config price table and is labelled as an estimate. Each user
  has a monthly minutes quota, live sessions have a cap, and the deployment has a ceiling (ADR-0003 §3.8).

### 2.13 Capacity, shared transcripts and quotas

Arithmetic from the measured English real-time factors (4 loaded vCPU, 4 threads): RTF 0.21 (tiny) – 0.68 (small-q5_1),
so one hour of audio occupies a 4-vCPU host for 12.6–40.5 minutes, i.e. ≈ 50–162 CPU-minutes. Arabic decoding speed is
**not measured**; a larger model is likely needed for Arabic, so the real cost is probably higher.

| workload | audio per day | 4-vCPU time per day (tiny … small-q5_1) | fits one 4-vCPU worker? |
|---|---|---|---|
| per-student transcription, one class of 30 recording 4 h a day | 120 h | 25–82 h | **no** — the queue grows without bound |
| per-student transcription, 200 students recording one 1-hour lecture | 200 h | 42–136 h | **no** |
| **one shared transcript per official recording**, one class, 4 h a day | 4 h | 0.8–2.7 h | yes |
| shared transcripts for 10 subjects with lectures the same day | 40 h | 8.4–27 h | only with the smallest models, or two workers |

Decisions:

1. **One shared recording and one transcript per lecture session.** Where the subject's lecturer policy allows sharing,
   one consented recording (the moderator's, or a student's shared with the policy) is copied into the subject's space
   and transcribed **once** there; every member's timeline, search and radar reuse it. Its cost is charged to the
   space's quota, not to students. The idempotency key becomes `(space, recording, engine, model, vocab_version)`.
2. **Personal recordings are transcribed only on request**, within a per-user **CPU-minute** quota for server-local
   engines (default 120 CPU-minutes a month once an engine is enabled, ≈ 2.4 h of audio with the smallest measured
   model) and a minutes quota for cloud engines. The UI states the cost in those units, never «free».
3. **A separate worker.** ASR runs in its own Render background worker (§2.2), reading audio from R2; live captions
   (sherpa-onnx streaming) run there too, never on the web process. Its plan is chosen from PRD §6.2 after the load
   test; one Pro Plus worker (4 CPU, $175 a month at the 2026-10-20 list price) is the starting point.
4. **Cloud engines** remove the CPU limit at a per-minute price; they are an owner decision (Q9) and the price table is
   an estimate.
5. **The radar and timeline do not wait for ASR.** Typed and imported transcripts keep working (Phase 3a).

## 3. Consequences

* MedLevo can add any engine without touching the media, timeline or radar code, and quality claims always trace back
  to measured runs on the owner's own lectures.
* **Testable here:**
  * the interface and orchestrator policy, with a fake speech provider in tests;
  * VAD and silence on synthetic audio, and skip-silence time mapping;
  * vocabulary building from Course Brain and Terms;
  * the harness metrics;
  * the whisper.cpp batch adapter on English samples (already run once);
  * resumable uploads, and re-runs that keep corrections.
* **Not testable here:** Iraqi-Arabic and code-switching accuracy (no audio), real microphones, streaming latency on
  phones, battery use, and cloud adapters (no keys).
* **Cost and complexity:** ffmpeg must be present in the production image; a CPU-heavy job kind; a new additive
  `source_region.text_origin_ext` column that every machine-reading check must honour.

## 4. Open questions (owner) — with defaults

1. **Which engine first?** (PRD Q9) Default: none enabled until the harness has run on the owner's set (≥ 10 minutes
   per stratum) and the floors of Q28 are met. The first candidates are whisper.cpp (`server_local` on the ASR worker, no
   audio leaves the deployment) and one cloud engine that lists `ar-IQ`, chosen by the owner.
2. **May audio go to a cloud provider at all?** (Q9, Q8) Default: no, until the owner approves a named provider after
   reading its data terms; then the subject's lecturer policy must allow external processing, and each user still opts
   in.
3. **Quality floors for making an engine the default.** (Q28) Default: the absolute floors of §2.10, to be confirmed by
   the owner.
4. **Who provides reference transcripts** for the evaluation set? (Q33) Default: the owner, through the in-app flow of
   §2.10 — typed, or corrected from evaluation-only drafts and marked reviewed. Corrected drafts are labelled as such in
   the dataset, because correcting a draft biases the reference toward the engine that made it.
