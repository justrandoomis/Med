// AC-09 — image candidate validation (§32): the gate any image candidate must pass before it may be shown as the
// requested example — a future external image provider, and today the owner's own library («ابحث في صوري»).
//
//   modality        the candidate's modality (metadata, else stated in its caption) must be the requested one
//   anatomic_region the same region, or a part / whole of it (lung ⊂ chest); a different region is excluded
//   caption_match   the caption must state the requested finding (one of its synonyms), NOT negated or excluded in the
//                   same sentence («no evidence of pneumothorax», «pneumothorax ruled out», «لا يوجد دليل على …»)
//   age_group       when the request names one: the candidate's age group (metadata or caption) must match
//   origin          a real example was requested → generated illustrations / re-organized diagrams / educational
//                   drawings are excluded
// Unknown is never accepted: a candidate whose modality / region / caption cannot be checked is excluded with the
// reason (a nearby but misleading image is worse than none). Nothing here writes explanations.
import type { ImageCandidate, ImageCheck, ImageRequest, ImageValidation } from '@medlevo/shared';
import { matchAny, tokens } from '../cases/text';

const MODALITIES: Record<string, string[]> = {
  xray: ['x-ray', 'xray', 'x ray', 'radiograph', 'radiography', 'plain film', 'cxr', 'axr', 'chest x-ray', 'chest film', 'اشعه سينيه', 'صوره شعاعيه', 'صوره بالاشعه السينيه'],
  ct: ['ct', 'computed tomography', 'cat scan', 'ct scan', 'مقطعيه', 'الطبقي المحوري', 'تصوير مقطعي'],
  mri: ['mri', 'magnetic resonance', 'mr imaging', 'رنين مغناطيسي', 'الرنين المغناطيسي'],
  ultrasound: ['ultrasound', 'sonography', 'sonogram', 'ultrasonography', 'doppler', 'echocardiography', 'echocardiogram', 'امواج فوق صوتيه', 'الامواج فوق الصوتيه', 'سونار', 'التراساوند', 'ايكو'],
  histology: ['histology', 'histopathology', 'micrograph', 'photomicrograph', 'h&e', 'h and e', 'microscopy', 'biopsy section', 'نسيجيه', 'مجهريه', 'شريحه نسيجيه'],
  clinical_photo: ['clinical photograph', 'clinical photo', 'photograph', 'clinical image', 'صوره سريريه'],
  dermoscopy: ['dermoscopy', 'dermatoscopy'],
  ecg: ['ecg', 'ekg', 'electrocardiogram', 'تخطيط القلب', 'تخطيط قلب'],
  fundoscopy: ['fundoscopy', 'fundus photograph', 'fundus', 'ophthalmoscopy', 'قاع العين'],
  endoscopy: ['endoscopy', 'endoscopic', 'colonoscopy', 'gastroscopy', 'تنظير'],
  drawing: ['diagram', 'drawing', 'illustration', 'schematic', 'رسم', 'مخطط', 'رسم توضيحي'],
};

const REGIONS: Record<string, { terms: string[]; parent?: string }> = {
  chest: { terms: ['chest', 'thorax', 'thoracic', 'الصدر', 'صدر', 'الصدري'] },
  lung: { terms: ['lung', 'lungs', 'pulmonary', 'pleura', 'pleural', 'الرئه', 'الرئتين', 'رئوي', 'الجنبه'], parent: 'chest' },
  heart: { terms: ['heart', 'cardiac', 'القلب', 'قلبي'], parent: 'chest' },
  abdomen: { terms: ['abdomen', 'abdominal', 'البطن', 'بطني'] },
  appendix: { terms: ['appendix', 'appendiceal', 'right iliac fossa', 'الزائده', 'الحفره الحرقفيه اليمني'], parent: 'abdomen' },
  liver: { terms: ['liver', 'hepatic', 'الكبد'], parent: 'abdomen' },
  gallbladder: { terms: ['gallbladder', 'biliary', 'المراره'], parent: 'abdomen' },
  kidney: { terms: ['kidney', 'kidneys', 'renal', 'الكليه', 'الكلي'], parent: 'abdomen' },
  pelvis: { terms: ['pelvis', 'pelvic', 'الحوض'] },
  head: { terms: ['head', 'skull', 'cranial', 'الراس', 'الجمجمه'] },
  brain: { terms: ['brain', 'cerebral', 'intracranial', 'الدماغ', 'المخ'], parent: 'head' },
  neck: { terms: ['neck', 'cervical', 'thyroid', 'الرقبه', 'العنق'] },
  spine: { terms: ['spine', 'spinal', 'vertebral', 'العمود الفقري'] },
  upper_limb: { terms: ['upper limb', 'arm', 'forearm', 'hand', 'wrist', 'elbow', 'shoulder', 'الطرف العلوي', 'اليد', 'الرسغ', 'المرفق', 'الكتف'] },
  lower_limb: { terms: ['lower limb', 'leg', 'knee', 'hip', 'ankle', 'foot', 'femur', 'الطرف السفلي', 'الساق', 'الركبه', 'الورك', 'الكاحل', 'القدم'] },
  skin: { terms: ['skin', 'cutaneous', 'الجلد', 'جلدي'] },
  eye: { terms: ['eye', 'ocular', 'retina', 'retinal', 'العين', 'الشبكيه'] },
};

const AGE_TERMS: Record<string, string[]> = {
  neonate: ['neonate', 'neonatal', 'newborn', 'حديث الولاده', 'وليد'],
  infant: ['infant', 'baby', 'رضيع'],
  child: ['child', 'children', 'paediatric', 'pediatric', 'boy', 'girl', 'طفل', 'الاطفال', 'طفله'],
  adolescent: ['adolescent', 'teenager', 'يافع', 'مراهق'],
  adult: ['adult', 'man', 'woman', 'بالغ', 'رجل', 'امراه'],
  elderly: ['elderly', 'older adult', 'geriatric', 'مسن', 'كبار السن'],
  pregnant: ['pregnant', 'pregnancy', 'حامل', 'الحمل'],
};

const MODALITY_LABEL_AR: Record<string, string> = {
  xray: 'أشعة سينية (X-ray)',
  ct: 'تصوير مقطعي (CT)',
  mri: 'رنين مغناطيسي (MRI)',
  ultrasound: 'أمواج فوق صوتية (Ultrasound)',
  histology: 'شريحة نسيجية (Histology)',
  clinical_photo: 'صورة سريرية',
  dermoscopy: 'تنظير جلد (Dermoscopy)',
  ecg: 'تخطيط قلب (ECG)',
  fundoscopy: 'قاع العين (Fundoscopy)',
  endoscopy: 'تنظير (Endoscopy)',
  drawing: 'رسم تعليمي',
};

function classify(text: string | null | undefined, table: Record<string, string[]>): string | null {
  if (!text?.trim()) return null;
  const t = tokens(text);
  if (t.length === 0) return null;
  let best: { key: string; at: number; len: number } | null = null;
  for (const [key, terms] of Object.entries(table)) {
    const m = matchAny(text, terms);
    if (m.matched && (!best || m.at! < best.at || (m.at === best.at && m.phrase!.length > best.len))) best = { key, at: m.at!, len: m.phrase!.length };
  }
  return best?.key ?? null;
}

export function normalizeModality(s: string | null | undefined): string | null {
  if (!s) return null;
  const direct = Object.keys(MODALITIES).find((k) => k === s.trim().toLowerCase());
  return direct ?? classify(s, MODALITIES);
}

export function normalizeRegion(s: string | null | undefined): string | null {
  if (!s) return null;
  const direct = Object.keys(REGIONS).find((k) => k === s.trim().toLowerCase());
  return direct ?? classify(s, Object.fromEntries(Object.entries(REGIONS).map(([k, v]) => [k, v.terms])));
}

function regionRelated(a: string, b: string): boolean {
  if (a === b) return true;
  const up = (x: string): string[] => {
    const out: string[] = [];
    let p = REGIONS[x]?.parent;
    while (p) {
      out.push(p);
      p = REGIONS[p]?.parent;
    }
    return out;
  };
  return up(a).includes(b) || up(b).includes(a);
}

function ageFrom(c: ImageCandidate): string | null {
  if (c.age_group) return c.age_group;
  return classify(c.caption, AGE_TERMS);
}

/** Image kinds that are drawings, not photographs / radiographs (an educational drawing is never a real example). */
const DRAWING_KINDS = new Set(['educational_drawing', 'diagram', 'table_image']);

const label = (k: string | null) => (k ? (MODALITY_LABEL_AR[k] ?? k) : 'غير معروف');

export function validateImageCandidate(candidate: ImageCandidate, request: ImageRequest): ImageValidation {
  const checks: ImageCheck[] = [];
  const wantModality = normalizeModality(request.modality);
  const wantRegion = normalizeRegion(request.anatomic_region);

  // modality
  const gotModality = normalizeModality(candidate.modality) ?? classify(candidate.caption, MODALITIES);
  if (!wantModality) checks.push({ check: 'modality', passed: false, reason_ar: `نوع التصوير المطلوب «${request.modality}» غير معروف للمدقق؛ لا يمكن التحقق.` });
  else if (!gotModality) checks.push({ check: 'modality', passed: false, reason_ar: 'لا يمكن التحقق من نوع التصوير: لا توجد بيانات ولا يذكره التعليق.' });
  else if (gotModality !== wantModality) checks.push({ check: 'modality', passed: false, reason_ar: `نوع التصوير ${label(gotModality)} لا يطابق المطلوب ${label(wantModality)}.` });
  else checks.push({ check: 'modality', passed: true, reason_ar: `نوع التصوير مطابق: ${label(gotModality)}.` });

  // anatomic region
  const gotRegion = normalizeRegion(candidate.anatomic_region) ?? normalizeRegion(candidate.caption);
  if (!wantRegion) checks.push({ check: 'anatomic_region', passed: false, reason_ar: `المنطقة المطلوبة «${request.anatomic_region}» غير معروفة للمدقق؛ لا يمكن التحقق.` });
  else if (!gotRegion) checks.push({ check: 'anatomic_region', passed: false, reason_ar: 'لا يمكن التحقق من المنطقة التشريحية: لا توجد بيانات ولا يذكرها التعليق.' });
  else if (!regionRelated(gotRegion, wantRegion)) checks.push({ check: 'anatomic_region', passed: false, reason_ar: `المنطقة (${gotRegion}) تختلف عن المطلوبة (${wantRegion}).` });
  else checks.push({ check: 'anatomic_region', passed: true, reason_ar: `المنطقة مطابقة (${gotRegion}).` });

  // caption states the finding (not negated)
  if (!candidate.caption?.trim()) checks.push({ check: 'caption_match', passed: false, reason_ar: 'لا يوجد تعليق يمكن التحقق منه أن الصورة تُظهر العلامة المطلوبة.' });
  else {
    const m = matchAny(candidate.caption, request.finding_terms, 'caption');
    if (m.matched) checks.push({ check: 'caption_match', passed: true, reason_ar: `التعليق يذكر «${m.phrase}».` });
    else if (m.negated_only) checks.push({ check: 'caption_match', passed: false, reason_ar: 'التعليق يذكر العلامة منفية أو مستبعدة (مثل «no evidence of …» أو «… ruled out»)؛ الصورة ليست مثالًا عليها.' });
    else checks.push({ check: 'caption_match', passed: false, reason_ar: 'التعليق لا يذكر العلامة المطلوبة؛ التشابه في الموضوع لا يكفي.' });
  }

  // age group (only when relevant to the request)
  if (request.age_group) {
    const got = ageFrom(candidate);
    if (!got) checks.push({ check: 'age_group', passed: false, reason_ar: 'الفئة العمرية للصورة غير معروفة، والطلب يحددها.' });
    else if (got !== request.age_group) checks.push({ check: 'age_group', passed: false, reason_ar: `الفئة العمرية (${got}) لا تطابق المطلوبة (${request.age_group}).` });
    else checks.push({ check: 'age_group', passed: true, reason_ar: 'الفئة العمرية مطابقة.' });
  }

  // origin: a real example was requested — a generated illustration, a re-organized diagram or an educational drawing
  // from a source is never a real radiograph / photograph, whatever its caption names (unless a drawing was asked for)
  const generated = candidate.origin === 'generated' || candidate.image_kind === 'generated_illustration';
  const reorganized = candidate.origin === 'reorganized' || candidate.image_kind === 'reorganized_diagram';
  const drawing = !!candidate.image_kind && DRAWING_KINDS.has(candidate.image_kind) && wantModality !== 'drawing';
  if ((request.require_real_example ?? true) && (generated || reorganized || drawing)) {
    checks.push({
      check: 'origin',
      passed: false,
      reason_ar: generated
        ? 'صورة توضيحية مولّدة، وليست مثالًا حقيقيًا.'
        : reorganized
          ? 'مخطط أعاد النظام تنظيمه، وليس صورة المثال الأصلية.'
          : 'رسم تعليمي أو مخطط من المصدر، وليس صورة حقيقية من نوع التصوير المطلوب.',
    });
  } else checks.push({ check: 'origin', passed: true, reason_ar: 'المصدر مناسب لمثال حقيقي.' });

  const failed = checks.filter((c) => !c.passed);
  return { accepted: failed.length === 0, checks, reasons_ar: failed.map((c) => c.reason_ar) };
}
