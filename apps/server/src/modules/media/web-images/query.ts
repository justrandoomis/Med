// Query building for the web image search: the image services index English, so an Arabic query is turned into
// English medical terms with a SMALL built-in dictionary (no AI, nothing sent anywhere to translate). Words the
// dictionary does not know are left out and reported («untranslated») so the owner can type the English term.
// Latin words (English / Latin terms the owner or the figure description already used) pass through.

/** Arabic medical phrase → English term. Longer phrases are matched first. Normalized (no diacritics, ى→ي, ة→ه, أإآ→ا). */
const DICTIONARY_RAW: Array<[string, string]> = [
  // tumours & pathology
  ['سرطان غدي', 'adenocarcinoma'],
  ['سرطانة غدية', 'adenocarcinoma'],
  ['سرطانه غديه', 'adenocarcinoma'],
  ['سرطان الخلايا الحرشفية', 'squamous cell carcinoma'],
  ['سرطانة حرشفية', 'squamous cell carcinoma'],
  ['سرطان الخلايا القاعدية', 'basal cell carcinoma'],
  ['ورم غدي', 'adenoma'],
  ['ورم حبيبي', 'granuloma'],
  ['ورم حبيبومي', 'granuloma'],
  ['ورم ليفي', 'fibroma'],
  ['ورم شحمي', 'lipoma'],
  ['ورم دموي', 'hemangioma'],
  ['ورم ميلانيني', 'melanoma'],
  ['ورم لمفي', 'lymphoma'],
  ['لمفومة', 'lymphoma'],
  ['ابيضاض الدم', 'leukemia'],
  ['سرطان الدم', 'leukemia'],
  ['ساركوما', 'sarcoma'],
  ['سرطان', 'carcinoma'],
  ['سرطانة', 'carcinoma'],
  ['ورم', 'tumor'],
  ['حبيبوم', 'granuloma'],
  ['التهاب', 'inflammation'],
  ['التهاب حاد', 'acute inflammation'],
  ['التهاب مزمن', 'chronic inflammation'],
  ['نخر', 'necrosis'],
  ['نخر تجبني', 'caseous necrosis'],
  ['نخر تخثري', 'coagulative necrosis'],
  ['تليف', 'fibrosis'],
  ['تشمع', 'cirrhosis'],
  ['تشمع الكبد', 'liver cirrhosis'],
  ['خراج', 'abscess'],
  ['احتشاء', 'infarction'],
  ['احتشاء عضلة القلب', 'myocardial infarction'],
  ['خثرة', 'thrombus'],
  ['جلطة', 'thrombus'],
  ['انصمام', 'embolism'],
  ['تصلب الشرايين', 'atherosclerosis'],
  ['عصيدة', 'atheroma'],
  ['ضمور', 'atrophy'],
  ['تضخم', 'hyperplasia'],
  ['ضخامة', 'hypertrophy'],
  ['حؤول', 'metaplasia'],
  ['خلل التنسج', 'dysplasia'],
  ['نقائل', 'metastasis'],
  ['انتقال', 'metastasis'],
  ['سل', 'tuberculosis'],
  ['السل', 'tuberculosis'],
  ['ساركويد', 'sarcoidosis'],
  ['داء كرون', 'crohn disease'],
  ['التهاب القولون التقرحي', 'ulcerative colitis'],
  ['قرحة', 'ulcer'],
  ['سليلة', 'polyp'],
  ['بوليب', 'polyp'],
  ['كيس', 'cyst'],
  ['خلايا عملاقة', 'giant cells'],
  ['خلية عملاقة', 'giant cell'],
  ['خلايا لانغهانس', 'langhans giant cells'],
  ['خلايا ظهارانية', 'epithelioid cells'],
  ['خلايا بلازمية', 'plasma cells'],
  ['خلايا لمفاوية', 'lymphocytes'],
  ['عدلات', 'neutrophils'],
  ['بلاعم', 'macrophages'],
  ['امراض', 'pathology'],
  ['علم الامراض', 'pathology'],
  ['باثولوجي', 'pathology'],
  // imaging & preparation
  ['نسيج', 'histology'],
  ['نسيجي', 'histology'],
  ['نسيجية', 'histology'],
  ['هستولوجي', 'histology'],
  ['شريحة', 'micrograph'],
  ['شريحة نسيجية', 'histology micrograph'],
  ['مجهر', 'micrograph'],
  ['مجهري', 'micrograph'],
  ['خزعة', 'biopsy'],
  ['عينة عيانية', 'gross specimen'],
  ['عياني', 'gross pathology'],
  ['صبغة', 'stain'],
  ['هيماتوكسيلين', 'hematoxylin eosin'],
  ['اشعة سينية', 'x-ray'],
  ['اشعة', 'radiograph'],
  ['صورة شعاعية', 'radiograph'],
  ['اشعة مقطعية', 'ct scan'],
  ['طبقي محوري', 'ct scan'],
  ['رنين مغناطيسي', 'mri'],
  ['موجات فوق صوتية', 'ultrasound'],
  ['سونار', 'ultrasound'],
  ['تخطيط القلب', 'ecg'],
  ['تشريح', 'anatomy'],
  ['مخطط', 'diagram'],
  // organs & regions
  ['القولون', 'colon'],
  ['قولون', 'colon'],
  ['المستقيم', 'rectum'],
  ['الامعاء الدقيقة', 'small intestine'],
  ['المعدة', 'stomach'],
  ['معدة', 'stomach'],
  ['المريء', 'esophagus'],
  ['الكبد', 'liver'],
  ['كبد', 'liver'],
  ['المرارة', 'gallbladder'],
  ['البنكرياس', 'pancreas'],
  ['الطحال', 'spleen'],
  ['الكلية', 'kidney'],
  ['الكلى', 'kidney'],
  ['كلية', 'kidney'],
  ['المثانة', 'bladder'],
  ['البروستات', 'prostate'],
  ['البروستاتا', 'prostate'],
  ['الرحم', 'uterus'],
  ['عنق الرحم', 'cervix'],
  ['المبيض', 'ovary'],
  ['الخصية', 'testis'],
  ['الثدي', 'breast'],
  ['ثدي', 'breast'],
  ['الرئة', 'lung'],
  ['رئة', 'lung'],
  ['الرئتين', 'lung'],
  ['الصدر', 'chest'],
  ['القلب', 'heart'],
  ['قلب', 'heart'],
  ['الشريان', 'artery'],
  ['الدماغ', 'brain'],
  ['دماغ', 'brain'],
  ['الغدة الدرقية', 'thyroid'],
  ['الدرقية', 'thyroid'],
  ['العقدة اللمفاوية', 'lymph node'],
  ['عقدة لمفاوية', 'lymph node'],
  ['الجلد', 'skin'],
  ['جلد', 'skin'],
  ['العظم', 'bone'],
  ['عظم', 'bone'],
  ['نقي العظم', 'bone marrow'],
  ['الدم', 'blood'],
  ['لطاخة دم', 'blood smear'],
  ['العين', 'eye'],
];

/** words carrying no search meaning */
const AR_STOP = new Set(['في', 'من', 'على', 'الى', 'إلى', 'عن', 'مع', 'او', 'أو', 'و', 'ال', 'هذا', 'هذه', 'صورة', 'صور', 'شكل', 'مثال', 'حالة', 'لل', 'ذات', 'نوع']);
const EN_STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'and', 'or', 'with', 'for', 'to', 'image', 'images', 'picture', 'photo', 'showing', 'shows', 'figure', 'this', 'that', 'is', 'are', 'from']);

export function normalizeArabic(s: string): string {
  return s
    .replace(/[ً-ٰٟـ]/g, '') // diacritics, tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

const DICTIONARY: Array<{ words: string[]; ar: string; en: string }> = DICTIONARY_RAW.map(([ar, en]) => ({ words: normalizeArabic(ar).split(/\s+/), ar, en })).sort((a, b) => b.words.length - a.words.length);
const ARABIC = /[؀-ۿ]/;

export interface BuiltQuery {
  /** the English query sent to the providers ('' when nothing usable is left) */
  en: string;
  translated: Array<{ ar: string; en: string }>;
  untranslated: string[];
}

/** «سرطان غدي في القولون» → «adenocarcinoma colon»; Latin words pass through; at most 10 terms */
export function buildQuery(input: string): BuiltQuery {
  const tokens = input
    .replace(/[«»"'“”()[\]{}،؛,.;:!?؟]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const out: string[] = [];
  const translated: BuiltQuery['translated'] = [];
  const untranslated: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const tok = tokens[i]!;
    if (!ARABIC.test(tok)) {
      const w = tok.toLowerCase().replace(/[^\p{L}\p{N}&+-]/gu, '');
      if (w && !EN_STOP.has(w)) out.push(w);
      i++;
      continue;
    }
    // longest dictionary phrase starting here; the Arabic article «ال» and the conjunction «و» are tried both ways
    let hit: { len: number; en: string; ar: string } | null = null;
    for (const d of DICTIONARY) {
      if (i + d.words.length > tokens.length) continue;
      const window = tokens.slice(i, i + d.words.length).map((t) => normalizeArabic(t).replace(/^و(?=ال)/, ''));
      const same = d.words.every((w, k) => window[k] === w || window[k] === `ال${w}` || `ال${window[k]}` === w);
      if (same) {
        hit = { len: d.words.length, en: d.en, ar: tokens.slice(i, i + d.words.length).join(' ') };
        break;
      }
    }
    if (hit) {
      out.push(...hit.en.split(' '));
      translated.push({ ar: hit.ar, en: hit.en });
      i += hit.len;
      continue;
    }
    const n = normalizeArabic(tok);
    if (!AR_STOP.has(tok) && !AR_STOP.has(n) && n.length > 1) untranslated.push(tok);
    i++;
  }
  const seen = new Set<string>();
  const terms = out.filter((w) => (seen.has(w) ? false : (seen.add(w), true))).slice(0, 10);
  return { en: terms.join(' '), translated, untranslated };
}

/** terms that make a result more likely to be a medical reference picture */
export const MEDICAL_HINTS = /\b(histolog\w*|micrograph\w*|patholog\w*|biops\w*|h&e|hematoxylin|haematoxylin|eosin|stain\w*|gross|specimen|radiograph\w*|x-?ray|ct|mri|ultrasound|sonograph\w*|endoscop\w*|carcinoma|adenocarcinoma|tumou?r|granulom\w*|lesion|necrosis|fibrosis|cell\w*|tissue|anatom\w*|clinical|case|patient|lymph|mucosa\w*)\b/i;

/** unsafe or off-topic words: a result whose title / caption has them is left out (medical nudity is not filtered) */
export const UNSAFE_TERMS = /\b(porn\w*|xxx|erotic\w*|hentai|nsfw|gore|meme)\b/i;
