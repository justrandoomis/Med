// Critic round regression (§48 «لا تعرض Logs تقنية خام فقط دون تفسير قابل للفهم», Arabic-first UI):
// the Control Center history («السجل») showed raw English field names (policy, items, report, questions,
// new_questions, keys_bound …) and raw JSON dumps of an exam's policy / build report next to each entry.
// Every row the owner sees must now carry an Arabic label and a readable value; nested objects are left out
// (the entry's Arabic summary already says what happened), raw ids never appear.
import { describe, expect, it } from 'vitest';
import { changesOf } from '../../src/modules/control/history';

const RAW = /[{}[\]"]|\b(policy|report|items|questions|new_questions|attached|keys_bound|keys_unbound|true|false|null)\b/;

function expectReadable(rows: ReturnType<typeof changesOf>) {
  for (const r of rows) {
    expect(r.label, `label «${r.label}» is Arabic`).toMatch(/[؀-ۿ]/);
    for (const v of [r.before, r.after]) if (v !== null) expect(v, `value of «${r.label}»`).not.toMatch(RAW);
  }
}

describe('control history rows are words, never raw keys or JSON', () => {
  it('exam creation (policy + build report objects): no JSON dump, the count is labelled', () => {
    const rows = changesOf(null, {
      policy: { pause_allowed: false, hints: 'off', show_solution: 'at_end', shuffle_options: true, per_question_seconds: null, total_seconds: null, anti_shortcut: false },
      items: 3,
      report: { requested: 3, matched: 7, scorable: 6, unscorable: 1, by_origin: { source: 3, generated: 0, owner: 0 }, exclusions: [{ code: 'unscorable' }] },
    });
    expect(rows).toEqual([{ label: 'عدد الأسئلة', before: null, after: '3' }]);
    expectReadable(rows);
  });

  it('question extraction counts get Arabic labels', () => {
    const rows = changesOf(null, { questions: 7, new_questions: 7, attached: 0, keys_bound: 6, keys_unbound: 0 });
    expect(rows.map((r) => r.label)).toEqual(['أسئلة مستخرجة', 'أسئلة جديدة', 'أُلحقت بأسئلة موجودة', 'مفاتيح رُبطت بأسئلتها', 'مفاتيح لم تُربط']);
    expect(rows.map((r) => r.after)).toEqual(['7', '7', '0', '6', '0']);
    expectReadable(rows);
  });

  it('codes are translated, booleans are نعم/لا, page indexes become the page numbers the owner sees', () => {
    const rows = changesOf({ mistake_type: null, socratic_default: false }, { mistake_type: 'knowledge_gap', socratic_default: true, page_indexes: [0, 2], job_id: '01JOB' });
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by['نوع الخطأ']!.after).not.toBe('knowledge_gap');
    expect(by['نوع الخطأ']!.after).toMatch(/[؀-ۿ]/);
    expect(by['الأسلوب السقراطي']).toEqual({ label: 'الأسلوب السقراطي', before: 'لا', after: 'نعم' });
    expect(by['صفحات الملف']!.after).toBe('1، 3');
    expectReadable(rows);
  });

  it('unknown internal keys, nested settings maps and source ids are left out; a duplicate is said in words', () => {
    const rows = changesOf(
      { source_priority: { explain: ['lecture'] }, rev: 3, sort_order: 1 },
      { source_priority: { explain: ['lecture', 'course_reference'] }, rev: 4, sort_order: 2, duplicate_of: '01M4JK2GMF7W620W6EZ70KP0A7', file_name: 'lecture.pdf' },
    );
    expect(rows).toEqual([
      { label: 'نسخة مطابقة لـ', before: null, after: 'مصدر موجود في مكتبتك' },
      { label: 'اسم الملف', before: null, after: 'lecture.pdf' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('01M4JK2GMF7W620W6EZ70KP0A7');
  });

  it('still reports the before → after facts it always did', () => {
    expect(changesOf({ priority: 0, lecture_kind: null }, { priority: 10, lecture_kind: 'clinical' })).toEqual([
      { label: 'الأولوية', before: '0', after: '10' },
      { label: 'نوع المحاضرة', before: '—', after: 'سريري' },
    ]);
  });
});
