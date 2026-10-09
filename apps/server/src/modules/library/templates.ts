// Optional study templates (§05): a suggested skeleton for a subject. Nothing here is enforced —
// the owner renames, moves or deletes anything afterwards. Titles are organisational labels only
// (no medical claims). English subject/system names are kept as the owner will see them in sources.
import type { StudyTemplate, StudyTemplateFolder } from '@medlevo/shared';

const containers = (): StudyTemplateFolder[] => [
  { title: 'المحاضرات', kind: 'folder' },
  { title: 'المراجع', kind: 'folder' },
  { title: 'مصادر الأسئلة', kind: 'folder' },
];

const topics = (...titles: string[]): StudyTemplateFolder[] => titles.map((title) => ({ title, kind: 'topic_folder' }));

export const STUDY_TEMPLATES: StudyTemplate[] = [
  {
    key: 'anatomy',
    title_ar: 'التشريح',
    title_en: 'Anatomy',
    description_ar: 'مقسّم حسب مناطق الجسم، مع مجلدات للمحاضرات والمراجع والأسئلة.',
    explanation_template: 'anatomical',
    cover: { style: 'linen', color: 'rose', symbol: 'bone' },
    icon: 'bone',
    skeleton: [...containers(), ...topics('الطرف العلوي — Upper limb', 'الطرف السفلي — Lower limb', 'الصدر — Thorax', 'البطن والحوض — Abdomen & pelvis', 'الرأس والعنق — Head & neck', 'التشريح العصبي — Neuroanatomy')],
  },
  {
    key: 'physiology',
    title_ar: 'الفسلجة',
    title_en: 'Physiology',
    description_ar: 'مقسّمة حسب أجهزة الجسم، لتتبّع الآليات من الخلية إلى العضو.',
    explanation_template: 'physiological_mechanism',
    cover: { style: 'linen', color: 'sky', symbol: 'activity' },
    icon: 'activity',
    skeleton: [...containers(), ...topics('الخلية والغشاء — Cell & membrane', 'العصب والعضلة — Nerve & muscle', 'القلب والدوران — Cardiovascular', 'التنفس — Respiratory', 'الكلى — Renal', 'الجهاز الهضمي — Gastrointestinal', 'الغدد الصماء — Endocrine', 'الجهاز العصبي — Neurophysiology')],
  },
  {
    key: 'biochemistry',
    title_ar: 'الكيمياء الحيوية',
    title_en: 'Biochemistry',
    description_ar: 'المسارات الأيضية والإنزيمات والبيولوجيا الجزيئية.',
    explanation_template: 'biochemical_pathway',
    cover: { style: 'grid', color: 'amber', symbol: 'flask' },
    icon: 'flask',
    skeleton: [...containers(), ...topics('الأيض — Metabolism', 'الإنزيمات — Enzymes', 'البيولوجيا الجزيئية — Molecular biology', 'التغذية — Nutrition')],
  },
  {
    key: 'pathology',
    title_ar: 'علم الأمراض',
    title_en: 'Pathology',
    description_ar: 'علم الأمراض العام ثم الجهازي، مع مكان لصور الشرائح.',
    explanation_template: 'pathology',
    cover: { style: 'linen', color: 'plum', symbol: 'microscope' },
    icon: 'microscope',
    skeleton: [
      ...containers(),
      { title: 'علم الأمراض العام — General pathology', kind: 'section', children: topics('أذية الخلية — Cell injury', 'الالتهاب — Inflammation', 'الأورام — Neoplasia') },
      { title: 'علم الأمراض الجهازي — Systemic pathology', kind: 'section' },
      { title: 'صور وشرائح', kind: 'folder' },
    ],
  },
  {
    key: 'pharmacology',
    title_ar: 'الأدوية',
    title_en: 'Pharmacology',
    description_ar: 'مبادئ علم الأدوية ثم المجموعات الدوائية حسب الأجهزة.',
    explanation_template: 'drug',
    cover: { style: 'dots', color: 'teal', symbol: 'pill' },
    icon: 'pill',
    skeleton: [...containers(), ...topics('المبادئ العامة — General pharmacology', 'الجهاز العصبي الذاتي — Autonomic', 'الجهاز العصبي المركزي — CNS', 'القلب والأوعية — Cardiovascular', 'المضادات الحيوية والعلاج الكيميائي — Chemotherapy')],
  },
  {
    key: 'microbiology',
    title_ar: 'الأحياء المجهرية',
    title_en: 'Microbiology',
    description_ar: 'الجراثيم والفيروسات والفطريات والطفيليات والمناعة.',
    explanation_template: 'microbe',
    cover: { style: 'dots', color: 'green', symbol: 'microscope' },
    icon: 'microscope',
    skeleton: [...containers(), ...topics('الجراثيم — Bacteriology', 'الفيروسات — Virology', 'الفطريات — Mycology', 'الطفيليات — Parasitology', 'المناعة — Immunology')],
  },
  {
    key: 'internal_medicine',
    title_ar: 'الباطنية',
    title_en: 'Internal medicine',
    description_ar: 'مقسّمة حسب التخصصات الباطنية.',
    explanation_template: 'clinical_medicine',
    cover: { style: 'linen', color: 'indigo', symbol: 'stethoscope' },
    icon: 'stethoscope',
    skeleton: [...containers(), ...topics('القلبية — Cardiology', 'الصدرية — Respiratory', 'الجهاز الهضمي — Gastroenterology', 'الكلى — Nephrology', 'الغدد الصماء — Endocrinology', 'أمراض الدم — Hematology', 'الجهاز العصبي — Neurology', 'الروماتيزم — Rheumatology', 'الأمراض المعدية — Infectious diseases')],
  },
  {
    key: 'surgery',
    title_ar: 'الجراحة',
    title_en: 'Surgery',
    description_ar: 'الجراحة العامة والتخصصات الجراحية، مع مكان للكورسات.',
    explanation_template: 'surgical',
    cover: { style: 'linen', color: 'slate', symbol: 'syringe' },
    icon: 'syringe',
    skeleton: [...containers(), ...topics('الجراحة العامة — General surgery', 'البطن الحاد — Acute abdomen', 'الإصابات — Trauma', 'المسالك البولية — Urology', 'العظام — Orthopedics', 'الأوعية الدموية — Vascular', 'الثدي والغدد — Breast & endocrine')],
  },
  {
    key: 'pediatrics',
    title_ar: 'الأطفال',
    title_en: 'Pediatrics',
    description_ar: 'حديثو الولادة والنمو والأمراض حسب الأجهزة.',
    explanation_template: 'pediatric',
    cover: { style: 'dots', color: 'sky', symbol: 'baby' },
    icon: 'baby',
    skeleton: [...containers(), ...topics('حديثو الولادة — Neonatology', 'النمو والتطور — Growth & development', 'التغذية — Nutrition', 'الأمراض المعدية — Infections', 'الأمراض حسب الأجهزة — Systems')],
  },
  {
    key: 'obgyn',
    title_ar: 'النسائية والتوليد',
    title_en: 'Obstetrics & Gynecology',
    description_ar: 'التوليد وأمراض النساء في قسمين منفصلين.',
    explanation_template: 'obstetric',
    cover: { style: 'linen', color: 'rose', symbol: 'heart' },
    icon: 'heart',
    skeleton: [
      ...containers(),
      { title: 'التوليد — Obstetrics', kind: 'section' },
      { title: 'أمراض النساء — Gynecology', kind: 'section' },
    ],
  },
  {
    key: 'radiology',
    title_ar: 'الأشعة',
    title_en: 'Radiology',
    description_ar: 'حسب المنطقة والتقنية، مع مجلد لصور الحالات.',
    explanation_template: 'imaging',
    cover: { style: 'grid', color: 'slate', symbol: 'scan' },
    icon: 'scan',
    skeleton: [...containers(), ...topics('الصدر — Chest', 'البطن — Abdomen', 'الأشعة العصبية — Neuroradiology', 'العظام والعضلات — Musculoskeletal', 'التقنيات والفيزياء — Modalities & physics'), { title: 'صور الحالات', kind: 'folder' }],
  },
  {
    key: 'community_medicine',
    title_ar: 'طب المجتمع',
    title_en: 'Community medicine',
    description_ar: 'الوبائيات والإحصاء الحيوي وصحة المجتمع.',
    explanation_template: 'community',
    cover: { style: 'grid', color: 'green', symbol: 'activity' },
    icon: 'activity',
    skeleton: [...containers(), ...topics('الوبائيات — Epidemiology', 'الإحصاء الحيوي — Biostatistics', 'تعزيز الصحة — Health promotion')],
  },
];

export function findTemplate(key: string): StudyTemplate | undefined {
  return STUDY_TEMPLATES.find((t) => t.key === key);
}
