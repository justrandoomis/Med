// Round 7 H4 items 2 + 3 — the deterministic extractors, as pure functions: relations written in free prose (EN + AR,
// with exact names and the sentence; negations, leading clauses, pronouns, objectives and questions never produce a
// relation) and algorithms / flowcharts (numbered steps under a procedure heading, «if … then» rules with their
// «otherwise», arrow chains, decision lists, flowchart-figure labels with NO edges unless the owner reviewed them).
// Synthetic TEST sentences + the Golden Set lecture text (copied from the fixtures' text layer): low false positives.
import { describe, expect, it } from 'vitest';
import type { DiagramStructure } from '@medlevo/shared';
import { extractAlgorithms } from '../../src/modules/brain/algorithms';
import type { RegionIn } from '../../src/modules/brain/extract';
import { extractProseRelations } from '../../src/modules/brain/prose';

type R = RegionIn & { text_origin?: string | null };
let n = 0;
const reg = (kind: string, text: string, extra: Partial<R> = {}): R => ({ id: `R${++n}`, page_id: 'P1', page_index: 0, kind, text, structure_json: null, parent_region_id: null, text_origin: 'digital', ...extra });
const triples = (regions: R[]) => extractProseRelations(regions).map((s) => `${s.from} —${s.relation}→ ${s.to}`);

describe('relations stated in prose (H4 item 3)', () => {
  it('English: causes / caused by / results from / treated with / treatment of choice / complication of / complications include', () => {
    expect(
      triples([
        reg('paragraph', 'Gallstones can cause acute pancreatitis.'),
        reg('paragraph', 'Appendicitis can cause perforation, abscess and peritonitis.'),
        reg('paragraph', 'Acute pancreatitis is caused by gallstones or alcohol.'),
        reg('paragraph', 'Hypovolaemic shock results from haemorrhage.'),
        reg('paragraph', 'Uncomplicated appendicitis is treated with appendicectomy.'),
        reg('paragraph', 'Appendicectomy is the treatment of choice for acute appendicitis.'),
        reg('paragraph', 'Peritonitis is a recognised complication of perforated appendicitis.'),
        reg('paragraph', 'Complications of acute pancreatitis include pseudocyst, necrosis and ARDS.'),
      ]),
    ).toEqual([
      'Gallstones —causes→ acute pancreatitis',
      'Appendicitis —causes→ perforation',
      'Appendicitis —causes→ abscess',
      'Appendicitis —causes→ peritonitis',
      'gallstones —causes→ Acute pancreatitis',
      'alcohol —causes→ Acute pancreatitis',
      'haemorrhage —causes→ Hypovolaemic shock',
      'appendicectomy —treats→ Uncomplicated appendicitis',
      'Appendicectomy —treats→ acute appendicitis',
      'Peritonitis —complication_of→ perforated appendicitis',
      'pseudocyst —complication_of→ acute pancreatitis',
      'necrosis —complication_of→ acute pancreatitis',
      'ARDS —complication_of→ acute pancreatitis',
    ]);
  });

  it('Arabic: يسبب / يؤدي إلى / ينتج عن / يُعالَج … بـ / علاج … هو / من مضاعفات — names keep their harakat and are exact substrings', () => {
    const regions = [
      reg('paragraph', 'حصى المرارة قد تسبب التهاب البنكرياس الحاد.'),
      reg('paragraph', 'يؤدي انسداد لمعة الزائدة إلى التهاب الزائدة الدودية.'),
      reg('paragraph', 'الصدمة النزفية تنتج عن فقدان الدم.'),
      reg('paragraph', 'يُعالَجُ التهابُ الزائدةِ بالجراحةِ.'),
      reg('paragraph', 'علاج الصدمة الإنتانية هو المضادات الحيوية.'),
      reg('paragraph', 'التهاب الصفاق من مضاعفات انثقاب الزائدة.'),
      reg('paragraph', 'من مضاعفات التهاب البنكرياس: الكيسة الكاذبة والنخر.'),
    ];
    const out = extractProseRelations(regions);
    expect(out.map((s) => `${s.from} —${s.relation}→ ${s.to}`)).toEqual([
      'حصى المرارة —causes→ التهاب البنكرياس الحاد',
      'انسداد لمعة الزائدة —causes→ التهاب الزائدة الدودية',
      'فقدان الدم —causes→ الصدمة النزفية',
      'الجراحةِ —treats→ التهابُ الزائدةِ',
      'المضادات الحيوية —treats→ الصدمة الإنتانية',
      'التهاب الصفاق —complication_of→ انثقاب الزائدة',
      'الكيسة الكاذبة —complication_of→ التهاب البنكرياس',
      'النخر —complication_of→ التهاب البنكرياس',
    ]);
    for (const s of out) {
      expect(s.quote).toContain(s.from);
      expect(s.quote).toContain(s.to);
      expect(regions.find((r) => r.id === s.regionId)!.text).toContain(s.quote);
      expect(s.lang).toBe('ar');
    }
  });

  it('never from a negation, «rarely», a leading clause, a pronoun, a generic subject, a question, an objective, or a sentence with no relation verb', () => {
    expect(
      triples([
        reg('paragraph', 'Gallstones do not cause appendicitis.'),
        reg('paragraph', 'Appendicitis rarely causes death.'),
        reg('paragraph', 'In children, appendicitis causes vomiting.'),
        reg('paragraph', 'It causes pain.'),
        reg('paragraph', 'The patient is treated with antibiotics.'),
        reg('paragraph', 'Does appendicitis cause fever?'),
        reg('paragraph', 'Vomiting usually follows the onset of pain.'),
        reg('paragraph', 'Ultrasound is the first-line imaging test in children and in pregnant women.'),
        reg('paragraph', 'لا يسبب الحصى التهاب الزائدة.'),
        reg('paragraph', 'نادرا ما يسبب الالتهاب الوفاة.'),
        reg('heading', 'Learning objectives'),
        reg('list_item', '• Explain how obstruction causes appendicitis.'),
      ]),
    ).toEqual([]);
  });

  it('the object stops at a clause boundary («that …»); a name longer than a name is dropped, never shortened; an OCR sentence is marked', () => {
    expect(triples([reg('paragraph', 'Appendicitis causes pain in the right iliac fossa that later radiates to the back.')])).toEqual(['Appendicitis —causes→ pain in the right iliac fossa']);
    const out = extractProseRelations([reg('paragraph', 'Appendicitis can cause perforation and a very large localised collection of infected pus around the caecum.', { text_origin: 'ocr' })]);
    expect(out.map((s) => s.to)).toEqual(['perforation']);
    expect(out[0]!.ocr).toBe(true);
  });

  it('the Golden Set lectures state no relation in these patterns → nothing is extracted (no false positive)', () => {
    const golden = [
      reg('heading', 'Acute Appendicitis — التهاب الزائدة الدودية الحاد'),
      reg('heading', 'Learning objectives'),
      reg('list_item', '• Describe the typical migration of pain in acute appendicitis.\n• List the investigations used when the diagnosis is uncertain.'),
      reg('heading', 'Clinical presentation'),
      reg('paragraph', "Pain usually begins in the periumbilical region and later migrates to the right iliac fossa (McBurney's point)."),
      reg('paragraph', 'يبدأ الألم عادةً حول السرة ثم ينتقل إلى الحفرة الحرقفية اليمنى عند نقطة McBurney.'),
      reg('paragraph', 'Anorexia and nausea are common; vomiting usually follows the onset of pain.'),
      reg('paragraph', 'A white cell count above 11 ×10⁹/L supports the diagnosis, but a normal count does NOT exclude it.'),
      reg('heading', 'Investigations — الفحوصات'),
      reg('paragraph', 'Ultrasound is the first-line imaging test in children and in pregnant women.'),
      reg('paragraph', 'CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.'),
      reg('paragraph', 'A pregnancy test (β-hCG) is required in women of reproductive age.'),
      reg('heading', 'Differential diagnosis'),
      reg('paragraph', 'The differential diagnosis includes mesenteric adenitis, ectopic pregnancy and right ureteric colic.'),
      reg('paragraph', 'يجب استبعاد الحمل خارج الرحم عند النساء في سن الإنجاب.'),
      reg('paragraph', 'Total score ranges from 0 to 10.'),
      reg('heading', 'Management pathway'),
      reg('caption', 'Figure 1: Management pathway by Alvarado score (synthetic diagram).'),
      reg('paragraph', 'As shown in Figure 1, the score directs the next step: surgical review, imaging, or observation.'),
      reg('heading', 'Acute Cholecystitis — التهاب المرارة الحاد'),
      reg('paragraph', 'Right upper quadrant pain with fever suggests acute cholecystitis.'),
      reg('paragraph', "Murphy's sign is elicited by palpation under the right costal margin during inspiration."),
      reg('paragraph', 'Ultrasound is the first-line investigation for suspected gallstones.'),
      reg('paragraph', 'يُعد التصوير بالأمواج فوق الصوتية الفحص الأولي عند الشك بحصى المرارة.'),
    ];
    expect(extractProseRelations(golden)).toEqual([]);
    // …and no algorithm is invented from that text (the figure's labels are a diagram region, read in srv:brain/h4-knowledge)
    expect(extractAlgorithms(golden)).toEqual([]);
  });
});

describe('algorithms / flowcharts (H4 item 2)', () => {
  const kinds = (regions: R[]) => extractAlgorithms(regions).map((a) => `${a.kind}: ${a.nodes.map((x) => x.text).join(' | ')} :: ${a.edges.map((e) => `${e.from}>${e.to}${e.label ? `(${e.label})` : ''}`).join(' ')}`);

  it('numbered steps under a procedure heading, in printed order, linked to their regions; a numbered list under «Clinical presentation» is not an algorithm', () => {
    const regions = [
      reg('heading', 'Acute appendicitis'),
      reg('heading', 'Management of acute appendicitis'),
      reg('list_item', '1. Resuscitate with IV fluids'),
      reg('list_item', '2. Give analgesia and antibiotics'),
      reg('list_item', '3. Arrange appendicectomy'),
      reg('heading', 'Clinical presentation'),
      reg('list_item', '1. Fever'),
      reg('list_item', '2. Pain'),
    ];
    const out = extractAlgorithms(regions);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'numbered_steps', title: 'Management of acute appendicitis', conceptName: 'acute appendicitis', ordered: true, ocr: false });
    expect(out[0]!.nodes.map((x) => [x.text, x.regionId])).toEqual([
      ['Resuscitate with IV fluids', regions[2]!.id],
      ['Give analgesia and antibiotics', regions[3]!.id],
      ['Arrange appendicectomy', regions[4]!.id],
    ]);
    expect(out[0]!.edges).toEqual([
      { from: 's1', to: 's2', label: null },
      { from: 's2', to: 's3', label: null },
    ]);
  });

  it('«Step N» lines are steps under any heading; a broken numbering ends the run', () => {
    expect(kinds([reg('heading', 'Overview'), reg('paragraph', 'Step 1: Check the airway\nStep 2: Check breathing\nStep 4: Something else')])).toEqual([
      'numbered_steps: Check the airway | Check breathing :: s1>s2',
    ]);
  });

  it('«if … then» rules with «otherwise», in English and Arabic; one rule alone outside a procedure section is not an algorithm', () => {
    expect(
      kinds([
        reg('heading', 'Imaging'),
        reg('paragraph', 'If the patient is pregnant, request ultrasound. If the diagnosis remains uncertain then request CT abdomen. Otherwise, observe and re-examine.'),
        reg('heading', 'التدبير'),
        reg('paragraph', 'إذا كان المريض مستقرًا، تُجرى الأشعة المقطعية. إذا كان المريض غير مستقر فيجب إجراء الجراحة فورًا. وإلا، يُراقب المريض.'),
        reg('heading', 'Notes'),
        reg('paragraph', 'If in doubt, ask a senior.'),
      ]),
    ).toEqual([
      'conditional: the patient is pregnant | request ultrasound | the diagnosis remains uncertain | request CT abdomen | observe and re-examine :: c1>a1 c2>a2 c2>e2(Otherwise)',
      'conditional: كان المريض مستقرًا | تُجرى الأشعة المقطعية | كان المريض غير مستقر | يجب إجراء الجراحة فورًا | يُراقب المريض :: c1>a1 c2>a2 c2>e2(وإلا)',
    ]);
  });

  it('arrow chains (one node per printed text across lines; «←» forward only in an Arabic line) and decision lists', () => {
    expect(
      kinds([
        reg('heading', 'Approach to RIF pain'),
        reg('paragraph', 'Suspected appendicitis → Alvarado score → surgical review\nAlvarado score -> imaging'),
        reg('paragraph', 'Is the patient pregnant?'),
        reg('list_item', 'Yes → ultrasound'),
        reg('list_item', 'No → CT abdomen'),
        reg('heading', 'المسار'),
        reg('paragraph', 'الألم ← الفحص ← التشخيص'),
      ]),
    ).toEqual([
      'arrow_chain: Suspected appendicitis | Alvarado score | surgical review | imaging :: n1>n2 n2>n3 n2>n4',
      'decision_list: Is the patient pregnant? | ultrasound | CT abdomen :: q>b1(Yes) q>b2(No)',
      'arrow_chain: الألم | الفحص | التشخيص :: n1>n2 n2>n3',
    ]);
  });

  it('OCR text makes the algorithm uncertain', () => {
    const out = extractAlgorithms([reg('heading', 'Management'), reg('list_item', '1. Resuscitate', { text_origin: 'ocr' }), reg('list_item', '2. Operate')]);
    expect(out[0]).toMatchObject({ kind: 'numbered_steps', ocr: true });
  });

  it('a flowchart figure: OCR labels as nodes with NO edges; edges only from an owner-reviewed figure reading', () => {
    const diagram: DiagramStructure = {
      type: 'diagram',
      nodes: [
        { id: 'n1', label: 'Alvarado score', certainty: 'uncertain' },
        { id: 'n2', label: 'Surgical review', certainty: 'uncertain' },
        { id: 'n3', label: 'Observe', certainty: 'uncertain' },
      ],
      edges: [],
      understanding: 'labels_ocr_only',
    };
    const fig = reg('figure', '', { id: 'FIG' });
    const dia = reg('diagram', 'Alvarado score · Surgical review · Observe', { id: 'DIA', parent_region_id: 'FIG', structure_json: JSON.stringify(diagram), text_origin: 'ocr' });
    const regions = [reg('heading', 'Management pathway'), fig, dia, reg('caption', 'Figure 1: Management pathway by Alvarado score (synthetic diagram).')];
    const plain = extractAlgorithms(regions);
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({ kind: 'flowchart_figure', edges: [], ocr: true, reviewed: false, diagramRegionId: 'DIA', title: 'Figure 1: Management pathway by Alvarado score (synthetic diagram).' });
    expect(plain[0]!.nodes.map((x) => x.text)).toEqual(['Alvarado score', 'Surgical review', 'Observe']);
    // the same labels in a section that is not a flowchart (anatomy labels) → not an algorithm
    expect(extractAlgorithms([reg('heading', 'Anatomy of the appendix'), fig, { ...dia }])).toEqual([]);
    // the owner confirmed a reading of that diagram: its edges are used, marked as reviewed
    const reviewedStructure: DiagramStructure = {
      ...diagram,
      nodes: diagram.nodes.map((x) => ({ ...x, certainty: 'read' })),
      edges: [
        { from: 'n1', to: 'n2', label: '≥ 7', certainty: 'read' },
        { from: 'n1', to: 'n3', label: '≤ 4', certainty: 'read' },
      ],
      understanding: 'structure_read',
    };
    const rv = extractAlgorithms(regions, new Map([['DIA', { structure: reviewedStructure }]]));
    expect(rv[0]).toMatchObject({ kind: 'flowchart_figure', reviewed: true, ocr: false });
    expect(rv[0]!.edges).toEqual([
      { from: 'n1', to: 'n2', label: '≥ 7' },
      { from: 'n1', to: 'n3', label: '≤ 4' },
    ]);
  });
});

describe('the recompute\'s word test equals the regex it replaced (H4 item 4)', () => {
  it('occursAsWord(text, name) ≡ /(?:^|[^\\p{L}\\p{N}])name(?:$|[^\\p{L}\\p{N}])/u on edge cases and random strings', async () => {
    const { occursAsWord } = await import('../../src/modules/brain/relations');
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const viaRegex = (text: string, name: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${esc(name)})(?:$|[^\\p{L}\\p{N}])`, 'u').test(text);
    const cases: Array<[string, string]> = [
      ['acute appendicitis is', 'appendicitis'],
      ['appendicitis', 'appendicitis'],
      ['nonappendicitis x', 'appendicitis'],
      ['appendicitis2', 'appendicitis'],
      ['β-hcg test', 'β-hcg'],
      ['x(β-hcg)', 'β-hcg'],
      ['التهاب الزائده', 'الزائده'],
      ['والزائده', 'الزائده'],
      ['a 𝑥appendicitis', 'appendicitis'],
      ['😀appendicitis😀', 'appendicitis'],
      ['appendicitis appendicitisx appendicitis', 'appendicitis'],
      ['x', ''],
    ];
    for (const [text, name] of cases) if (name) expect(occursAsWord(text, name), `${text} / ${name}`).toBe(viaRegex(text, name));
    const alphabet = ['a', 'b', ' ', '-', 'ب', 'ة', '1', '𝑥', '😀', '.', 'é'];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let k = 0; k < 3000; k++) {
      const text = Array.from({ length: 1 + rnd(14) }, () => alphabet[rnd(alphabet.length)]).join('');
      const name = Array.from({ length: 1 + rnd(3) }, () => alphabet[rnd(alphabet.length)]).join('');
      expect(occursAsWord(text, name), JSON.stringify([text, name])).toBe(viaRegex(text, name));
    }
  });
});
