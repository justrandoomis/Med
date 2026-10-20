// Round 7 — independent review of track H4 (items 2 + 3): what the deterministic extractors present as STATED must be
// what the sentence states. Found by the reviewer (each case failed before the fix):
//  * prose relations: a hedge / refutation («is thought to», «falsely said to», «يُعتقد خطأً أن», «من الخطأ القول إن»,
//    «Whether X causes Y remains controversial») became a 'stated' relation, and clause fragments became concept names
//    («Smoking is thought to», «Students should know that ischemia», «hypercapnia causes acidosis»,
//    «perforation less often than cholecystitis») — each of them a new suggested concept;
//  * algorithms: «If fever, tachycardia and leukocytosis are present, start antibiotics» was split at the first comma
//    (condition «fever» → action «tachycardia and leukocytosis are present, start antibiotics»); «Otherwise healthy
//    children can be discharged» was attached as the «otherwise» branch of the rule before it, and an «otherwise» line
//    far from its rule was attached too.
import { describe, expect, it } from 'vitest';
import { extractAlgorithms } from '../../src/modules/brain/algorithms';
import type { RegionIn } from '../../src/modules/brain/extract';
import { extractProseRelations } from '../../src/modules/brain/prose';

type R = RegionIn & { text_origin?: string | null };
let n = 0;
const reg = (kind: string, text: string): R => ({ id: `RV${++n}`, page_id: 'P1', page_index: 0, kind, text, structure_json: null, parent_region_id: null, text_origin: 'digital' });
const triples = (sentences: string[]) => extractProseRelations(sentences.map((s) => reg('paragraph', s))).map((s) => `${s.from} —${s.relation}→ ${s.to}`);

describe('prose relations: a hedge, a refutation or a clause is never a stated relation (review H4)', () => {
  it('English hedges and refutations produce nothing', () => {
    expect(
      triples([
        'Smoking is thought to cause cancer.',
        'Smoking is believed to be a cause of cancer.',
        'Vaccines falsely said to cause autism.',
        'Vaccines were wrongly claimed to cause autism.',
        'Whether ischemia causes necrosis remains controversial.',
        'Students should know that ischemia causes necrosis.',
        'It was once believed that bad air causes malaria.',
        'Some authors suggest that stress causes peptic ulcers.',
        'Opium is no longer the treatment of choice for appendicitis.',
      ]),
    ).toEqual([]);
  });

  it('a name is never a clause: verbs, comparisons and «that»-clauses are not names; the plain statement in the same sentence stays', () => {
    expect(
      triples([
        'Hypoxia causes cyanosis and hypercapnia causes acidosis.',
        'Appendicitis causes perforation less often than cholecystitis.',
        'Ischemia occasionally causes necrosis.',
      ]),
    ).toEqual(['Hypoxia —causes→ cyanosis']);
  });

  it('Arabic hedges and refutations produce nothing; a list item that holds another relation is not a name', () => {
    expect(
      triples([
        'يعتقد أن التدخين يسبب التهاب الزائدة.',
        'يُعتقد خطأً أن اللقاحات تسبب التوحد.',
        'من الخطأ القول إن اللقاحات تسبب التوحد.',
        'يقال إن التدخين يسبب السرطان.',
        'من المحتمل أن التدخين يسبب السرطان.',
        'ما زال الجدل قائمًا حول ما إذا كان التدخين يسبب التهاب الزائدة.',
        'التدخين يسبب أحيانًا التهاب الزائدة.',
      ]),
    ).toEqual([]);
    // «الزرقة وفرط الكربمية يسبب الحماض» was read as ONE name caused by «نقص الأكسجة»; a «و» before a non-«ال» word is not
    // a list boundary here, so nothing is read rather than a wrong pair
    expect(triples(['نقص الأكسجة يسبب الزرقة وفرط الكربمية يسبب الحماض.'])).toEqual([]);
  });

  it('plain statements are still read (no loss of the cases the builder tested)', () => {
    expect(
      triples([
        'Gallstones can cause acute pancreatitis.',
        'Appendicitis may cause perforation.',
        'Delayed diagnosis of appendicitis leads to perforation.',
        'التهاب الزائدة يسبب الانثقاب.',
        'التدخين قد يسبب السرطان.',
      ]),
    ).toEqual([
      'Gallstones —causes→ acute pancreatitis',
      'Appendicitis —causes→ perforation',
      'Delayed diagnosis of appendicitis —causes→ perforation',
      'التهاب الزائدة —causes→ الانثقاب',
      'التدخين —causes→ السرطان',
    ]);
  });
});

const algoOf = (regions: R[]) =>
  extractAlgorithms(regions).map((a) => {
    const text = new Map(a.nodes.map((x) => [x.key, x.text]));
    return `${a.kind}: ${a.edges.map((e) => `${text.get(e.from)} > ${text.get(e.to)}${e.label ? ` (${e.label})` : ''}`).join(' | ')}`;
  });

describe('algorithms: arrow direction in an Arabic line (review H4)', () => {
  it('«→» in a right-to-left Arabic line is drawn pointing at the EARLIER item, so its direction is not read; «←» is', () => {
    // displayed right to left, «الألم → الفحص» shows as «الفحص → الألم»: the printed arrow points back at «الألم»
    expect(algoOf([reg('heading', 'مسار التشخيص'), reg('paragraph', 'الألم → الفحص → التشخيص')])).toEqual([]);
    expect(algoOf([reg('heading', 'مسار التشخيص'), reg('paragraph', 'الألم ← الفحص ← التشخيص')])).toEqual(['arrow_chain: الألم > الفحص | الفحص > التشخيص']);
    // an English line keeps «→»
    expect(algoOf([reg('heading', 'Pathway'), reg('paragraph', 'Pain → Examination → Diagnosis')])).toEqual(['arrow_chain: Pain > Examination | Examination > Diagnosis']);
  });
});

describe('algorithms: a condition / action split is what the sentence says (review H4)', () => {
  it('«If A, B and C …, do X» with several commas and no «then» is ambiguous: not read as a rule', () => {
    expect(
      algoOf([
        reg('heading', 'Management of sepsis'),
        reg('paragraph', 'If fever, tachycardia and leukocytosis are present, start antibiotics.'),
        reg('paragraph', 'If the patient is hypotensive, give fluids.'),
      ]),
    ).toEqual(['conditional: the patient is hypotensive > give fluids']);
    // with an explicit «then» the split is printed: read
    expect(
      algoOf([reg('heading', 'Management of sepsis'), reg('paragraph', 'If fever, tachycardia and leukocytosis are present then start antibiotics.')]),
    ).toEqual(['conditional: fever, tachycardia and leukocytosis are present > start antibiotics']);
  });

  it('Arabic: «إذا A، وB، …» (the action would start with «و» or hold another «،») is not split there', () => {
    expect(
      algoOf([
        reg('heading', 'تدبير التهاب الزائدة'),
        reg('paragraph', 'إذا كان الطفل مستقرًا، والألم خفيفًا، يُراقب.'),
        reg('paragraph', 'إذا كان غير مستقر، يُنعش.'),
      ]),
    ).toEqual(['conditional: كان غير مستقر > يُنعش']);
  });

  it('«Otherwise healthy …» is not an «otherwise» branch; an «otherwise» line belongs only to the rule right before it', () => {
    expect(
      algoOf([
        reg('heading', 'Approach'),
        reg('paragraph', 'If the scan is positive, operate. Otherwise healthy children can be discharged home.'),
      ]),
    ).toEqual(['conditional: the scan is positive > operate']);
    expect(
      algoOf([
        reg('heading', 'Approach'),
        reg('paragraph', 'If the scan is positive, operate.'),
        reg('paragraph', 'Imaging is often helpful in children.'),
        reg('paragraph', 'Otherwise, observe.'),
      ]),
    ).toEqual(['conditional: the scan is positive > operate']);
    // right after its rule, «Otherwise, …» is that rule's other branch (as before)
    expect(algoOf([reg('heading', 'Approach'), reg('paragraph', 'If the scan is positive, operate. Otherwise, observe.')])).toEqual([
      'conditional: the scan is positive > operate | the scan is positive > observe (Otherwise)',
    ]);
  });
});

describe('prose relations: hyphenated eponyms are names (review H4)', () => {
  it('«May-Thurner syndrome» is not the modal «may»', () => {
    expect(triples(['May-Thurner syndrome causes deep vein thrombosis.'])).toEqual(['May-Thurner syndrome —causes→ deep vein thrombosis']);
  });
});
