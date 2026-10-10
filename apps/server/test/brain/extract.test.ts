// Course Brain — deterministic knowledge-structure extraction (§16), pure function, synthetic TEST regions.
import { describe, expect, it } from 'vitest';
import { extractKnowledge, meaningfulName, sectionRoleOf, sentencesOf, type RegionIn } from '../../src/modules/brain/extract';

let n = 0;
function r(kind: string, text: string, extra: Partial<RegionIn> = {}): RegionIn {
  n++;
  return { id: `r${n}`, page_id: extra.page_id ?? 'p1', page_index: extra.page_index ?? 0, kind, text, structure_json: extra.structure_json ?? null, parent_region_id: extra.parent_region_id ?? null };
}
const names = (x: ReturnType<typeof extractKnowledge>, role?: string) => x.mentions.filter((m) => !role || m.role === role).map((m) => m.name);

describe('section headings', () => {
  it('classifies section headings in English and Arabic', () => {
    expect(sectionRoleOf('Clinical presentation')).toBe('sign');
    expect(sectionRoleOf('Investigations — الفحوصات')).toBe('investigation');
    expect(sectionRoleOf('Differential diagnosis')).toBe('differential');
    expect(sectionRoleOf('Management pathway')).toBe('management');
    expect(sectionRoleOf('Complications')).toBe('complication');
    expect(sectionRoleOf('Drugs used')).toBe('drug');
    expect(sectionRoleOf('Normal values')).toBe('value');
    expect(sectionRoleOf('Types of shock')).toBe('classification');
    expect(sectionRoleOf('المضاعفات')).toBe('complication');
    expect(sectionRoleOf('العلاج')).toBe('management');
    expect(sectionRoleOf('Learning objectives')).toBe('objective');
    expect(sectionRoleOf('Acute Appendicitis')).toBeNull();
  });

  it('a heading names its concept without the section words; bilingual headings give one concept with both names', () => {
    const x = extractKnowledge([r('heading', 'Acute Appendicitis — التهاب الزائدة الدودية الحاد'), r('heading', 'Types of shock'), r('heading', 'Learning objectives'), r('heading', 'Initial assessment')]);
    expect(x.mentions.map((m) => [m.role, m.name, m.nameAlt])).toEqual([
      ['heading', 'Acute Appendicitis', 'التهاب الزائدة الدودية الحاد'],
      ['heading', 'shock', null],
    ]);
  });
});

describe('definitions and statements (stated, with the exact sentence)', () => {
  it('English definition patterns; «is the …» / «is a common …» are not definitions', () => {
    const x = extractKnowledge([
      r('paragraph', 'Sepsis is defined as life-threatening organ dysfunction caused by infection.'),
      r('paragraph', 'Septic shock is a subset of sepsis with circulatory failure.'),
      r('paragraph', 'Tachycardia refers to a heart rate above 100 beats per minute.'),
      r('paragraph', 'Appendicitis is a common cause of abdominal pain.'),
    ]);
    expect(names(x, 'definition')).toEqual(['Sepsis', 'Septic shock', 'Tachycardia']);
    const def = x.mentions.find((m) => m.name === 'Sepsis')!;
    expect(def.quote).toBe('Sepsis is defined as life-threatening organ dysfunction caused by infection.');
    expect(def.regionId).toBe(x.mentions.find((m) => m.name === 'Sepsis')!.regionId);
    // a statement that is not a definition still names its subject — as a plain stated mention, never a definition
    expect(x.mentions.filter((m) => m.name === 'Appendicitis').map((m) => m.role)).toEqual(['feature']);
  });

  it('classification sentences give the classified concept and its members', () => {
    const x = extractKnowledge([r('paragraph', 'Shock is classified as hypovolaemic, cardiogenic, distributive or obstructive.')]);
    expect(names(x, 'classification')).toEqual(['Shock', 'hypovolaemic', 'cardiogenic', 'distributive', 'obstructive']);
  });

  it('Arabic definition / classification patterns keep the printed (vocalized) words', () => {
    const x = extractKnowledge([
      r('paragraph', 'تُصنف الصدمة إلى نقص الحجم، قلبية، توزيعية، أو انسدادية.'),
      r('paragraph', 'يُعرَّف الإنتان بأنه خلل في وظائف الأعضاء ناتج عن العدوى.'),
    ]);
    expect(names(x, 'classification')).toEqual(['الصدمة', 'نقص الحجم', 'قلبية', 'توزيعية', 'انسدادية']);
    expect(names(x, 'definition')).toEqual(['الإنتان']);
    expect(x.mentions.find((m) => m.name === 'الإنتان')!.quote).toBe('يُعرَّف الإنتان بأنه خلل في وظائف الأعضاء ناتج عن العدوى.');
  });

  it('subjects of statements take the section role; enumerations give one mention per item; values are cut at the threshold', () => {
    const x = extractKnowledge([
      r('heading', 'Investigations'),
      r('paragraph', 'Ultrasound is the first-line imaging test in children. CT abdomen is preferred in adults.'),
      r('paragraph', 'A white cell count above 11 ×10⁹/L supports the diagnosis.'),
      r('heading', 'Differential diagnosis'),
      r('paragraph', 'The differential diagnosis includes mesenteric adenitis, ectopic pregnancy and right ureteric colic.'),
      r('heading', 'Clinical presentation'),
      r('paragraph', 'Anorexia and nausea are common; vomiting usually follows the onset of pain.'),
    ]);
    expect(names(x, 'investigation')).toEqual(['Ultrasound', 'CT abdomen']);
    expect(names(x, 'value')).toEqual(['white cell count']);
    expect(names(x, 'differential')).toEqual(['mesenteric adenitis', 'ectopic pregnancy', 'right ureteric colic']);
    expect(names(x, 'sign')).toEqual(['Anorexia', 'nausea', 'vomiting']);
    // the section heading is recorded as the mention's section
    expect(x.mentions.find((m) => m.name === 'Ultrasound')!.section).toBe('Investigations');
  });

  it('short list items inside a section; objectives are kept as objectives, never concepts', () => {
    const x = extractKnowledge([
      r('heading', 'Learning objectives'),
      r('list_item', '• Describe the typical migration of pain in acute appendicitis.'),
      r('heading', 'Initial management'),
      r('list_item', 'ABC assessment'),
      r('list_item', 'IV access'),
    ]);
    expect(x.objectives.map((o) => o.text)).toEqual(['Describe the typical migration of pain in acute appendicitis.']);
    expect(names(x, 'management')).toEqual(['ABC assessment', 'IV access']);
    expect(names(x)).not.toContain('Describe the typical migration of pain in acute appendicitis');
  });
});

describe('tables, captions and what is never read', () => {
  it('first column of a table; a row with a unit / threshold is a value; a table does not inherit the section before it', () => {
    const structure = JSON.stringify({
      type: 'table',
      rows: 4,
      cols: 3,
      cells: [
        { r: 0, c: 0, colspan: 3, header: true, text: 'Alvarado score (MANTRELS) — مكونات المقياس' },
        { r: 1, c: 0, header: true, text: 'Feature' },
        { r: 2, c: 0, text: 'Anorexia' },
        { r: 2, c: 1, text: '1' },
        { r: 2, c: 2, text: '—' },
        { r: 3, c: 0, text: 'Elevated temperature' },
        { r: 3, c: 1, text: '1' },
        { r: 3, c: 2, text: '≥ 37.3 °C' },
      ],
    });
    const x = extractKnowledge([r('heading', 'Differential diagnosis'), r('table', 'table', { structure_json: structure }), r('caption', 'Table 1: Alvarado score components')]);
    expect(x.mentions.map((m) => [m.role, m.name])).toEqual([
      ['heading', 'Alvarado score'],
      ['table_entry', 'Anorexia'],
      ['value', 'Elevated temperature'],
      ['figure', 'Alvarado score'],
    ]);
  });

  it('headers, footers, question regions and child cells are never read', () => {
    const x = extractKnowledge([r('header', 'Surgery · Course 1 · Lecture 3'), r('footer', '11'), r('question', 'Which point is tender?'), r('table_cell', 'Anorexia', { parent_region_id: 'x' })]);
    expect(x.mentions).toEqual([]);
  });

  it('pronoun / structural subjects and numbers are not concepts', () => {
    expect(meaningfulName('It')).toBe(false);
    expect(meaningfulName('Introduction')).toBe(false);
    expect(meaningfulName('12 mg')).toBe(false);
    expect(meaningfulName('Pain')).toBe(false); // generic clinical word alone
    expect(meaningfulName("McBurney's point")).toBe(true);
    const x = extractKnowledge([r('paragraph', 'It is a common finding. This is defined as nothing.')]);
    expect(x.mentions).toEqual([]);
  });

  it('sentence splitting keeps decimals and Arabic sentences', () => {
    expect(sentencesOf('Na 11.5 mmol/L is low. Ultrasound is first. يُعد التصوير الفحص الأولي.')).toEqual(['Na 11.5 mmol/L is low.', 'Ultrasound is first.', 'يُعد التصوير الفحص الأولي.']);
  });
});
