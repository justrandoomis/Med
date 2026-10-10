// Critic round regression (honest, specific reasons — §12, §61): «أنشئ سؤال اختيار من متعدد» on a selection said the
// feature «arrives with the generated-questions phase», although generated questions exist (/exams/generate). The
// reason now names the real limit (not wired to the reader) and the working path.
import { describe, expect, it } from 'vitest';
import { actionDisabledReason, SELECTION_AI_ACTIONS } from './aiActions';

describe('selection action reasons', () => {
  it('Create MCQ points to the generated-questions screen instead of a future phase', () => {
    const mcq = SELECTION_AI_ACTIONS.find((a) => a.id === 'mcq')!;
    const reason = actionDisabledReason(mcq, { available: true, reason: null })!;
    expect(reason).not.toContain('يصل مع مرحلة');
    expect(reason).toContain('توليد أسئلة صعبة');
    expect(reason).toContain('لم يُربط بالقارئ بعد');
  });

  it('without an AI provider the capability reason still comes first', () => {
    const mcq = SELECTION_AI_ACTIONS.find((a) => a.id === 'mcq')!;
    expect(actionDisabledReason(mcq, { available: false, reason: 'تتطلب ضبط مزود ذكاء اصطناعي على الخادم.' })).toBe('تتطلب ضبط مزود ذكاء اصطناعي على الخادم.');
  });
});
