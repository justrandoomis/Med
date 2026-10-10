# Skills Audit (§00, §61)

This log lists only skills that were **actually loaded and read** with the Skill tool during the build. Each row
comes from the structured reports of the agents that used them (workflow journals of rounds 1–5). The search
areas listed in §00 are not installed skills; they are just areas we looked for skills in.

| Skill (real name) | What it does | Phase(s) it served | Available & read | How it was applied |
|---|---|---|---|---|
| `workflow-authoring` | Reference for orchestrating multi-agent workflows | All rounds (orchestration) | Yes (loaded at start) | Structure of each round: parallel tracks, each followed by an independent adversarial reviewer; resume after container restarts |
| `anthropic-skills:frontend-design` | Intentional visual direction, avoiding templated defaults | R1 design system; R2 library/workspace/ink; R3 evidence; R4 control/cases | Yes | Token plan (one indigo-ink accent, warm paper, no medical clichés), one signature element per screen (book-cloth covers, page folio), screenshot self-critique |
| `anthropic-skills:apple-design` | Apple-style interaction & motion translated to the web | R1 shell; R2 workspace & ink; R4 learning web | Yes | Press feedback, 1:1 pointer tracking with capture, drag-to-dismiss sheets, reduced-motion fallbacks, no decorative motion |
| `design:design-system` | Structuring and documenting a design system | R1 | Yes | `docs/design-system.md`: token categories, component variants/states/a11y notes, do/don't |
| `design:accessibility-review` | WCAG 2.1 AA audit checklist | R1, R2, R3, R4 | Yes | Contrast computed per token, keyboard support for composite widgets, 44px touch targets, live regions, status never by colour alone |
| `design:ux-copy` | UX microcopy (errors, confirmations, empty states) | R2 library/upload | Yes | Arabic errors as what happened + why + how to fix; destructive confirmations that state consequences |
| `anthropic-skills:pdf` | PDF reading/extraction/rendering/OCR guidance | R2 processing pipeline | Yes | Chose pdfjs text items + operator list for figures, poppler `pdftoppm` for rasterization before OCR |
| `anthropic-skills:vercel-react-best-practices` | React rendering performance | R2 ink engine | Yes | No React render per pointermove (refs + rAF), memoized objects, lazy chunks |
| `claude-api` | Anthropic API / SDK reference (models, structured output, pricing) | R3 AI provider adapter | Yes | Anthropic adapter: model defaults, structured output, error mapping, cost **estimates** (see ADR-0002) |
| `anthropic-skills:webapp-testing` | Playwright testing of local web apps | R3, R4 real-server browser checks | Yes | Reconnaissance-then-action browser checks against the real server with Golden Set uploads, screenshots inspected |
| `dataviz` | Accessible, consistent charts | R4 learning web (Mistake Genome, forecast, Exam DNA) | Yes | One hue, denominators shown, values as text, table twin, bars `aria-hidden` |
| `code-review` | Diff review for correctness bugs | R4 learning server | Yes | Found 10 issues in the learning module (sync field merge, stale flags, recompute cost); all fixed with regression tests |

Round 5 (integration and acceptance) adds rows below once its agents report.

## Considered but not used

| Skill | Why it was not used |
|---|---|
| `anthropic-skills:docx`, `anthropic-skills:pptx` | DOCX/PPTX are **read** with `mammoth` and `jszip` inside the processing pipeline; these skills are for authoring office files. DOCX export is not implemented (see the requirements matrix). |
| `anthropic-skills:xlsx`, slide and marketing skills | Not needed by this product (§00: do not run unrelated skills just because they exist). |
| `security-review` | The security work was done by the per-track adversarial reviewers and by the Round 5 G8 security sweep (auth on every route, CSRF, files, ZIP, SSRF, secrets). |

## Capabilities still needed (requests in the format required by §00)

These are not missing skills. They are a service key, a device and providers. A skill file cannot supply any of them (§00).

| Need | Type | Effect of not having it | What works today |
|---|---|---|---|
| `ANTHROPIC_API_KEY` on the server | Service API key (put it in the server environment / `.env`, never in the repo) | All AI tasks (explanation, chat, Study Book, summaries, generated questions, written grading, figure explanation, case generation) report `requires_configuration` | Every deterministic feature: library, processing and OCR, reader, ink, search, evidence and Source Lock, Question Vault and extraction/matching, exams with source questions, flashcards and SRS, planner, offline, backup |
| iPad + Apple Pencil | Test device | Pressure, tilt, hover, palm rejection and latency are implemented from the specs but **not tested** on a real device (AC-28) | Ink works with mouse, touch and stylus in Chromium; the capability panel tells you honestly what the current device reports |
| Embeddings provider | External service | Semantic search is disabled with its reason | Keyword search with Arabic normalization, using synonyms from your own dictionary |
| Speech-to-text provider | External service | Automatic lecture transcription and voice OSCE/viva are disabled | Audio playback, VTT/SRT transcript import, manual transcript editing and links |
| External image search provider | External service | External image retrieval is disabled (`external.images`) | The image explorer for your own sources, plus the AC-09 validator ready to gate future candidates |

**Optional skill requests**, which would improve existing work rather than unblock anything:

«أحتاج مهارة في **تطوير طبقة iPadOS أصلية (SwiftUI + PencilKit)**. السبب: بناء مكوّن حبر أصلي يشارك نموذج المستندات والمزامنة الحالي (§27). فائدتها: زمن استجابة منخفض للقلم، النقر المزدوج والضغط (squeeze) وScribble، وهي غير متاحة للويب. ارفع ملف SKILL.md مع ملفاته التابعة أو حزمة المهارة كاملة. تأثير غيابها: تحسين اختياري. البديل الحالي: حبر الويب/PWA مع مصفوفة قدرات صادقة في `docs/CAPABILITY_MATRIX.md`.»

«أحتاج مهارة في **معايير كتابة أسئلة الاختيار من متعدد الطبية (item-writing guidelines)**. السبب: تشديد فحوص جودة الأسئلة المولدة والمشتتات (§37–§38). فائدتها: قواعد صياغة موثقة تُضاف إلى الفحوص الحتمية والتحقق المستقل الحاليين. ارفع ملف SKILL.md مع ملفاته التابعة. تأثير غيابها: تحسين اختياري. البديل الحالي: فحوص حتمية (إجابة واحدة أفضل، خيارات متمايزة، عدم وجود تلميحات طول/صياغة، إبراز النفي، أدلة لكل مشتت) + تحقق مستقل بالذكاء الاصطناعي عند توفر المفتاح.»
