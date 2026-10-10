# MedLevo evaluation report — eval-20261010T152136-015d6292

> Mode: **scripted** — AI axes ran with the evaluation-only scripted provider: they measure the server's validation and abstention guarantees, **not** a model's quality.
> Every rate is shown with its denominator and a Wilson 95% interval. A sample under 30 cases is a small sample; no rate here is an accuracy claim beyond these synthetic TEST FIXTURE cases.

* Run: 2026-10-10 15:21:36 UTC → 2026-10-10 15:21:51 UTC · label «F5 baseline (catalogue v1)» · set filter: all
* Catalogue: eval-catalogue-2026.10-1 · 149 cases (80 regression, 69 tuning) · regression hash `8e8344f0789688d4`
* System: app 0.1.0 @ 77b7fdd89a51 · node v22.22.0
* Versions: pipeline=process-v1 · index=chunk-v1 · question_parser=qparse-v1 · question_matcher=qmatch-v1 · ai_rules=rules-2026.10-1 · studybook_generator=studybook-gen-3 · claim_verifier=claims-v1 · ocr.tesseract.js=7.0.0 · ocr.data.eng=1.0.0 · ocr.data.ara=1.0.0 · pdf.pdfjs-dist=6.4.299

## Overall

| set | result |
|---|---|
| regression (frozen) | 79/80 (95% CI 93%–99%) |
| tuning examples | 69/69 passed (95% CI lower bound 95%) |

## Per axis

| axis | kind | regression | tuning |
|---|---|---|---|
| text_accuracy — دقة النص المستخرج | deterministic | 6/6 passed (95% CI lower bound 61%, small sample) | 23/23 passed (95% CI lower bound 86%, small sample) |
| negation_numbers — حفظ النفي والأرقام والوحدات | deterministic | 17/17 passed (95% CI lower bound 82%, small sample) | 7/7 passed (95% CI lower bound 65%, small sample) |
| options_completeness — اكتمال الخيارات | deterministic | 3/3 passed (95% CI lower bound 44%, small sample) | 12/12 passed (95% CI lower bound 76%, small sample) |
| key_binding — ربط مفتاح الإجابة | deterministic | 18/18 passed (95% CI lower bound 82%, small sample) | 11/11 passed (95% CI lower bound 74%, small sample) |
| citation_validity — صحة الاستشهاد | deterministic | 5/5 passed (95% CI lower bound 57%, small sample) | — |
| claim_support — دعم الادعاء بالدليل | scripted_ai | 6/6 passed (95% CI lower bound 61%, small sample) | — |
| abstention — الامتناع الصحيح عند غياب الدليل | scripted_ai | 4/4 passed (95% CI lower bound 51%, small sample) | — |
| over_abstention — عدم الامتناع حين يوجد دليل واضح | scripted_ai | 4/5 (95% CI 38%–96%, small sample) | — |
| image_match — مطابقة الصورة للطلب | deterministic | 4/4 passed (95% CI lower bound 51%, small sample) | 7/7 passed (95% CI lower bound 65%, small sample) |
| lecture_link — ربط السؤال بالمحاضرة | deterministic | 3/3 passed (95% CI lower bound 44%, small sample) | 7/7 passed (95% CI lower bound 65%, small sample) |
| rtl_bidi — تنسيق العربية والإنجليزية (RTL/bidi) | deterministic | 9/9 passed (95% CI lower bound 70%, small sample) | 2/2 passed (95% CI lower bound 34%, small sample) |

## Cases that did not pass (1)

| case | set | outcome | expected | observed | reason |
|---|---|---|---|---|---|
| overabstain.pregnancy_test | regression | fail | {"supported_shown":true} | {"status":"abstained","abstain":"not_found_in_scope","linked_claims":0,"generator_calls":0,"script_errors":[]} | امتنع النظام (not_found_in_scope) مع وجود دليل واضح في المحاضرة. |

## All cases

| case | axis | set | outcome | fixture |
|---|---|---|---|---|
| text.appendicitis.p0.periumbilical | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.p0.mcburney | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.p0.not_exclude | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.p1.ultrasound_is_the_first_line | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.p1.ectopic_pregnancy | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.p2.alvarado | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.p2.leukocytosis | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.p2.10_10_l | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.p3.figure_1 | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.ar1 | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.ar2 | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.ar3 | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.no_reversed_lam_alef | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.appendicitis.page_labels | text_accuracy | tuning | pass | golden/lecture_appendicitis.pdf |
| text.cholecystitis.page_labels | text_accuracy | tuning | pass | golden/lecture_cholecystitis.pdf |
| text.mixed_scanned.ocr_pylori | text_accuracy | tuning | pass | golden/mixed_scanned_lecture.pdf |
| text.mixed_scanned.ocr_ubt | text_accuracy | tuning | pass | golden/mixed_scanned_lecture.pdf |
| text.shock_docx.heading.shock_ | text_accuracy | tuning | pass | golden/lecture_notes_shock.docx |
| text.shock_docx.heading.classification | text_accuracy | tuning | pass | golden/lecture_notes_shock.docx |
| text.shock_docx.heading.initial_assessment | text_accuracy | tuning | pass | golden/lecture_notes_shock.docx |
| text.shock_pptx.title.shock_overview | text_accuracy | tuning | pass | golden/slides_shock.pptx |
| text.shock_pptx.title.types_of_shock | text_accuracy | tuning | pass | golden/slides_shock.pptx |
| text.shock_pptx.title.initial_management | text_accuracy | tuning | pass | golden/slides_shock.pptx |
| text.g4_long_en.no_bogus_question | text_accuracy | regression | pass | acceptance/g4_long_questions.pdf |
| text.g4_long_en.no_running_header | text_accuracy | regression | pass | acceptance/g4_long_questions.pdf |
| text.g4_long_en.stem_across_pages | text_accuracy | regression | pass | acceptance/g4_long_questions.pdf |
| text.g4_long_ar.stem | text_accuracy | regression | pass | acceptance/g4_long_question_ar.pdf |
| text.g4_formats.no_bogus_question | text_accuracy | regression | pass | acceptance/g4_key_formats.pdf |
| text.g4_merged.count | text_accuracy | regression | pass | acceptance/g4_sections_merged_key.pdf |
| neg.surgery.A2.not | negation_numbers | tuning | pass | golden/questions_surgery_course1.pdf |
| neg.surgery.B2.except | negation_numbers | tuning | pass | golden/questions_surgery_course1.pdf |
| neg.surgery.A4.value | negation_numbers | tuning | pass | golden/questions_surgery_course1.pdf |
| neg.prev.Q3.na | negation_numbers | tuning | pass | golden/questions_previous_exam_2024.pdf |
| neg.prev.Q3.k | negation_numbers | tuning | pass | golden/questions_previous_exam_2024.pdf |
| neg.appendicitis.not_exclude | negation_numbers | tuning | pass | golden/lecture_appendicitis.pdf |
| neg.appendicitis.wcc | negation_numbers | tuning | pass | golden/lecture_appendicitis.pdf |
| neg.g4_units.Q1 | negation_numbers | regression | pass | acceptance/g4_units_negation.pdf |
| neg.g4_units.Q2 | negation_numbers | regression | pass | acceptance/g4_units_negation.pdf |
| neg.g4_units.Q3 | negation_numbers | regression | pass | acceptance/g4_units_negation.pdf |
| neg.g4_units.Q4.option | negation_numbers | regression | pass | acceptance/g4_units_negation.pdf |
| neg.g4_units.Q4.not | negation_numbers | regression | pass | acceptance/g4_units_negation.pdf |
| neg.g4_units.Q5.except | negation_numbers | regression | pass | acceptance/g4_units_negation.pdf |
| neg.g4_neg_ar.Q1 | negation_numbers | regression | pass | acceptance/g4_negation_ar.pdf |
| neg.g4_neg_ar.Q1.stem | negation_numbers | regression | pass | acceptance/g4_negation_ar.pdf |
| neg.g4_neg_ar.Q2 | negation_numbers | regression | pass | acceptance/g4_negation_ar.pdf |
| neg.g4_neg_ar.Q3 | negation_numbers | regression | pass | acceptance/g4_negation_ar.pdf |
| neg.g4_neg_ar.Q4 | negation_numbers | regression | pass | acceptance/g4_negation_ar.pdf |
| neg.g4_neg_ar.Q4.decimal | negation_numbers | regression | pass | acceptance/g4_negation_ar.pdf |
| neg.g4_neg_ar.E5 | negation_numbers | regression | pass | acceptance/g4_negation_ar.pdf |
| neg.g4_neg_ar.E6 | negation_numbers | regression | pass | acceptance/g4_negation_ar.pdf |
| neg.g4_long_en.vitals | negation_numbers | regression | pass | acceptance/g4_long_questions.pdf |
| neg.g4_long_en.not | negation_numbers | regression | pass | acceptance/g4_long_questions.pdf |
| neg.g4_long_ar.except | negation_numbers | regression | pass | acceptance/g4_long_question_ar.pdf |
| opt.surgery.A1 | options_completeness | tuning | pass | golden/questions_surgery_course1.pdf |
| opt.surgery.A2 | options_completeness | tuning | pass | golden/questions_surgery_course1.pdf |
| opt.surgery.A3 | options_completeness | tuning | pass | golden/questions_surgery_course1.pdf |
| opt.surgery.A4 | options_completeness | tuning | pass | golden/questions_surgery_course1.pdf |
| opt.surgery.B1 | options_completeness | tuning | pass | golden/questions_surgery_course1.pdf |
| opt.surgery.B2 | options_completeness | tuning | pass | golden/questions_surgery_course1.pdf |
| opt.surgery.B3 | options_completeness | tuning | pass | golden/questions_surgery_course1.pdf |
| opt.surgery.B3.labels | options_completeness | tuning | pass | golden/questions_surgery_course1.pdf |
| opt.prev.Q1 | options_completeness | tuning | pass | golden/questions_previous_exam_2024.pdf |
| opt.prev.Q2 | options_completeness | tuning | pass | golden/questions_previous_exam_2024.pdf |
| opt.prev.Q3 | options_completeness | tuning | pass | golden/questions_previous_exam_2024.pdf |
| opt.photo.Q7 | options_completeness | tuning | pass | golden/question_photo_circled.png |
| opt.g4_long_en.Q2 | options_completeness | regression | pass | acceptance/g4_long_questions.pdf |
| opt.g4_long_en.Q3 | options_completeness | regression | pass | acceptance/g4_long_questions.pdf |
| opt.g4_long_ar.Q2 | options_completeness | regression | pass | acceptance/g4_long_question_ar.pdf |
| key.surgery.A1 | key_binding | tuning | pass | golden/questions_surgery_course1.pdf |
| key.surgery.A2 | key_binding | tuning | pass | golden/questions_surgery_course1.pdf |
| key.surgery.A3 | key_binding | tuning | pass | golden/questions_surgery_course1.pdf |
| key.surgery.A4 | key_binding | tuning | pass | golden/questions_surgery_course1.pdf |
| key.surgery.B1 | key_binding | tuning | pass | golden/questions_surgery_course1.pdf |
| key.surgery.B2 | key_binding | tuning | pass | golden/questions_surgery_course1.pdf |
| key.surgery.B3 | key_binding | tuning | pass | golden/questions_surgery_course1.pdf |
| key.prev.Q1 | key_binding | tuning | pass | golden/questions_previous_exam_2024.pdf |
| key.prev.Q2 | key_binding | tuning | pass | golden/questions_previous_exam_2024.pdf |
| key.prev.Q3 | key_binding | tuning | pass | golden/questions_previous_exam_2024.pdf |
| key.photo.circled | key_binding | tuning | pass | golden/question_photo_circled.png |
| key.g4_merged.A1 | key_binding | regression | pass | acceptance/g4_sections_merged_key.pdf |
| key.g4_merged.A2 | key_binding | regression | pass | acceptance/g4_sections_merged_key.pdf |
| key.g4_merged.B1 | key_binding | regression | pass | acceptance/g4_sections_merged_key.pdf |
| key.g4_merged.B2 | key_binding | regression | pass | acceptance/g4_sections_merged_key.pdf |
| key.g4_merged.B3 | key_binding | regression | pass | acceptance/g4_sections_merged_key.pdf |
| key.g4_merged.C1 | key_binding | regression | pass | acceptance/g4_sections_merged_key.pdf |
| key.g4_formats.1_1 | key_binding | regression | pass | acceptance/g4_key_formats.pdf |
| key.g4_formats.1_2 | key_binding | regression | pass | acceptance/g4_key_formats.pdf |
| key.g4_formats.2_1 | key_binding | regression | pass | acceptance/g4_key_formats.pdf |
| key.g4_formats.2_2 | key_binding | regression | pass | acceptance/g4_key_formats.pdf |
| key.g4_formats.2_3 | key_binding | regression | pass | acceptance/g4_key_formats.pdf |
| key.g4_inline.1_1 | key_binding | regression | pass | acceptance/g4_sections_inline_keys.pdf |
| key.g4_inline.1_2 | key_binding | regression | pass | acceptance/g4_sections_inline_keys.pdf |
| key.g4_inline.2_1 | key_binding | regression | pass | acceptance/g4_sections_inline_keys.pdf |
| key.g4_inline.2_2 | key_binding | regression | pass | acceptance/g4_sections_inline_keys.pdf |
| key.g4_inline.2_3 | key_binding | regression | pass | acceptance/g4_sections_inline_keys.pdf |
| key.g4_long_en.Q2 | key_binding | regression | pass | acceptance/g4_long_questions.pdf |
| key.g4_long_ar.Q2 | key_binding | regression | pass | acceptance/g4_long_question_ar.pdf |
| cite.valid_in_scope | citation_validity | regression | pass | golden/lecture_appendicitis.pdf |
| cite.unknown_alias | citation_validity | regression | pass | golden/lecture_appendicitis.pdf |
| cite.fabricated_id | citation_validity | regression | pass | golden/lecture_appendicitis.pdf |
| cite.out_of_scope | citation_validity | regression | pass | golden/lecture_appendicitis.pdf |
| cite.valid_plus_unknown | citation_validity | regression | pass | golden/lecture_appendicitis.pdf |
| support.restated | claim_support | regression | pass | golden/lecture_appendicitis.pdf |
| support.cross_language | claim_support | regression | pass | golden/lecture_appendicitis.pdf |
| support.changed_number | claim_support | regression | pass | golden/lecture_appendicitis.pdf |
| support.added_negation | claim_support | regression | pass | golden/lecture_appendicitis.pdf |
| support.changed_unit | claim_support | regression | pass | golden/lecture_appendicitis.pdf |
| support.topical_only | claim_support | regression | pass | golden/lecture_appendicitis.pdf |
| abstain.out_of_scope | abstention | regression | pass | golden/lecture_appendicitis.pdf |
| abstain.real_patient | abstention | regression | pass | golden/lecture_appendicitis.pdf |
| abstain.fabricated_alias | abstention | regression | pass | golden/lecture_appendicitis.pdf |
| abstain.unsupported_answer | abstention | regression | pass | golden/lecture_appendicitis.pdf |
| overabstain.anchored | over_abstention | regression | pass | golden/lecture_appendicitis.pdf |
| overabstain.retrieved_ct | over_abstention | regression | pass | golden/lecture_appendicitis.pdf |
| overabstain.retrieved_wcc | over_abstention | regression | pass | golden/lecture_appendicitis.pdf |
| overabstain.arabic_question | over_abstention | regression | pass | golden/lecture_appendicitis.pdf |
| overabstain.pregnancy_test | over_abstention | regression | fail | golden/lecture_appendicitis.pdf |
| image.caption.1 | image_match | tuning | pass | — |
| image.caption.2 | image_match | tuning | pass | — |
| image.caption.3 | image_match | tuning | pass | — |
| image.caption.4 | image_match | tuning | pass | — |
| image.caption.5 | image_match | tuning | pass | — |
| image.caption.6 | image_match | tuning | pass | — |
| image.caption.7 | image_match | tuning | pass | — |
| image.atlas.xray_ptx | image_match | regression | pass | acceptance/g3_image_atlas.pdf |
| image.atlas.arabic | image_match | regression | pass | acceptance/g3_image_atlas.pdf |
| image.atlas.ct | image_match | regression | pass | acceptance/g3_image_atlas.pdf |
| image.atlas.child | image_match | regression | pass | acceptance/g3_image_atlas.pdf |
| link.surgery.A1 | lecture_link | tuning | pass | golden/questions_surgery_course1.pdf |
| link.surgery.A2 | lecture_link | tuning | pass | golden/questions_surgery_course1.pdf |
| link.surgery.A3 | lecture_link | tuning | pass | golden/questions_surgery_course1.pdf |
| link.surgery.A4 | lecture_link | tuning | pass | golden/questions_surgery_course1.pdf |
| link.surgery.B1 | lecture_link | tuning | pass | golden/questions_surgery_course1.pdf |
| link.surgery.B2 | lecture_link | tuning | pass | golden/questions_surgery_course1.pdf |
| link.surgery.B3 | lecture_link | tuning | pass | golden/questions_surgery_course1.pdf |
| link.g5_ar.Q1 | lecture_link | regression | pass | acceptance/g5_questions_ar.pdf |
| link.g5_ar.Q2 | lecture_link | regression | pass | acceptance/g5_questions_ar.pdf |
| link.g5_ar.Q3 | lecture_link | regression | pass | acceptance/g5_questions_ar.pdf |
| bidi.no_controls.appendicitis | rtl_bidi | tuning | pass | golden/lecture_appendicitis.pdf |
| bidi.no_controls.shock_docx | rtl_bidi | tuning | pass | golden/lecture_notes_shock.docx |
| bidi.no_controls.g4_neg_ar | rtl_bidi | regression | pass | acceptance/g4_negation_ar.pdf |
| bidi.no_controls.g5_lecture_ar | rtl_bidi | regression | pass | acceptance/g5_lecture_ar.pdf |
| bidi.logical_order.g4_long_ar | rtl_bidi | regression | pass | acceptance/g4_long_question_ar.pdf |
| bidi.dir.1 | rtl_bidi | regression | pass | — |
| bidi.dir.2 | rtl_bidi | regression | pass | — |
| bidi.dir.3 | rtl_bidi | regression | pass | — |
| bidi.dir.4 | rtl_bidi | regression | pass | — |
| bidi.isolate.term | rtl_bidi | regression | pass | — |
| bidi.isolate.value | rtl_bidi | regression | pass | — |

## Notes

* كل الحالات على ملفات اختبار اصطناعية (TEST FIXTURE)؛ ليست مرجعًا طبيًا، والنتائج مقيدة بنطاق هذه الحالات وحجمها وطريقة تقييمها.
* كل نسبة مكتوبة مع مقامها وفاصل ثقة 95% (Wilson). عينة أقل من 30 حالة «عينة صغيرة» ولا تُعمَّم.
* عينة الانحدار مجمّدة عند إصدار الكتالوج ومنفصلة عن أمثلة الضبط (مجموعة Golden Set التي طُوّرت عليها أدوات الاستخراج).
* محاور الذكاء الاصطناعي شُغّلت بمزود مكتوب مسبقًا للتقييم فقط: تقيس ضمانات الخادم (التحقق من الأدلة، الامتناع، عدم الامتناع الزائد)، لا جودة نموذج. تقييم نموذج حقيقي يحتاج ANTHROPIC_API_KEY وتشغيل `npm run eval -- --mode=live`.
