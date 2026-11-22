// Smart chat skills (wp/smart-rail): the «/» query, Arabic-folded matching and the owner's request wording. Pure logic.
import { describe, expect, it } from 'vitest';
import { CHAT_SKILLS } from '@medlevo/shared';
import { foldAr, matchSkills, requestText, SKILL_DEFS, slashQuery } from './skills';

const items = SKILL_DEFS.map((def) => ({ def }));

describe('smart chat skills', () => {
  it('one definition per shared skill id, each with a «/» command and a hint', () => {
    expect(SKILL_DEFS.map((d) => d.id).sort()).toEqual([...CHAT_SKILLS].sort());
    for (const d of SKILL_DEFS) {
      expect(d.command).toBeTruthy();
      expect(d.hint).toBeTruthy();
    }
    // explain / summarize are questions to the chat itself; every other skill comes back as a card
    expect(SKILL_DEFS.filter((d) => d.mode === 'chat').map((d) => d.id)).toEqual(['explain_page', 'summarize']);
  });

  it('the «/» menu opens only for a one-line command at the start of the text', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/mc')).toBe('mc');
    expect(slashQuery('ما /mcq')).toBeNull();
    expect(slashQuery('/mcq\nx')).toBeNull();
    expect(slashQuery('/mcq صعبة')).toBeNull(); // the owner is writing text after the command
  });

  it('matching folds diacritics, alef forms and taa marbuta; prefix matches come first', () => {
    expect(foldAr('لخّص')).toBe('لخص');
    expect(foldAr('أسئلة')).toBe('اسئله');
    expect(matchSkills('', items)).toHaveLength(SKILL_DEFS.length);
    expect(matchSkills('اسئله', items).map((i) => i.def.id)).toEqual(['lecture_questions']);
    expect(matchSkills('MCQ', items)[0]!.def.id).toBe('mcq');
    expect(matchSkills('اشرح', items).map((i) => i.def.id)).toEqual(['explain_page', 'explain_figure']);
    expect(matchSkills('zzz', items)).toEqual([]);
  });

  it('the request wording names the count, the difficulty and the page (it also names a new conversation)', () => {
    expect(requestText('mcq', { count: 3, difficultyLabel: 'صعب', page: 'ص 13' })).toBe('اسألني 3 أسئلة MCQ — صعب من ص 13');
    expect(requestText('mcq', { count: 1 })).toBe('اسألني سؤال MCQ واحدًا من هذه الصفحة');
    expect(requestText('compare', { items: ['Ultrasound', 'CT'] })).toBe('قارن: Ultrasound / CT');
    expect(requestText('explain_page', { selection: true })).toBe('اشرح التحديد');
  });
});
