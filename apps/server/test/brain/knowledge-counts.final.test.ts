// Round 7 final critic sweep: the «لماذا هذه الحالة؟» reasons of «خريطة معرفتي» counted with fixed forms — «قرأت 5 من 12
// صفحات», «12 أسئلة مرتبطة», «أجبت 12 مرات». Arabic counted nouns agree with their number (Arabic-first, §22).
import { describe, expect, it } from 'vitest';
import { knowledgeReadingAr, knowledgePracticeAr } from '../../src/modules/brain/student';

describe('Student Knowledge Map reasons — Arabic number agreement (Round 7 final)', () => {
  it('pages read', () => {
    expect(knowledgeReadingAr(0, 1)).toBe('قرأت 0 من صفحة واحدة يُذكر فيها.');
    expect(knowledgeReadingAr(1, 2)).toBe('قرأت 1 من صفحتين يُذكر فيهما.');
    expect(knowledgeReadingAr(2, 7)).toBe('قرأت 2 من 7 صفحات يُذكر فيها.');
    expect(knowledgeReadingAr(5, 12)).toBe('قرأت 5 من 12 صفحة يُذكر فيها.');
    expect(knowledgeReadingAr(0, 0)).toBe('لا صفحة معروفة له في نسخ الدراسة.');
  });
  it('questions and answers', () => {
    expect(knowledgePracticeAr(1, 0, 0)).toBe('سؤال واحد مرتبط به؛ لم تجب عنه بعد.');
    expect(knowledgePracticeAr(2, 1, 1)).toBe('سؤالان مرتبطان به؛ أجبت مرة واحدة (1 محسوبة).');
    expect(knowledgePracticeAr(4, 2, 1)).toBe('4 أسئلة مرتبطة به؛ أجبت مرتين (1 محسوبة).');
    expect(knowledgePracticeAr(12, 12, 10)).toBe('12 سؤالًا مرتبطًا به؛ أجبت 12 مرة (10 محسوبة).');
    expect(knowledgePracticeAr(3, 5, 5)).toBe('3 أسئلة مرتبطة به؛ أجبت 5 مرات (5 محسوبة).');
    expect(knowledgePracticeAr(0, 0, 0)).toBe('لا أسئلة مرتبطة به بعد.');
  });
});
