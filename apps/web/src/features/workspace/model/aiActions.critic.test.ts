// Critic round regression (honest, specific reasons — §12, §61): «أنشئ سؤال اختيار من متعدد» on a selection used to say
// it «arrives with the generated-questions phase». Track F3 wired it to the reader (the rail's Create MCQ panel), so it
// has no «not wired» reason any more; without an AI provider the capability's own reason is shown.
import { describe, expect, it } from 'vitest';
import { actionDisabledReason, SELECTION_AI_ACTIONS } from './aiActions';

describe('selection action reasons', () => {
  it('Create MCQ is wired to the reader: no «not wired» reason when generation is available', () => {
    const mcq = SELECTION_AI_ACTIONS.find((a) => a.id === 'mcq')!;
    expect(mcq.wired).toBe(true);
    expect(actionDisabledReason(mcq, { available: true, reason: null })).toBeNull();
  });

  it('without an AI provider the capability reason still comes first', () => {
    const mcq = SELECTION_AI_ACTIONS.find((a) => a.id === 'mcq')!;
    expect(actionDisabledReason(mcq, { available: false, reason: 'تتطلب ضبط مزود ذكاء اصطناعي على الخادم.' })).toBe('تتطلب ضبط مزود ذكاء اصطناعي على الخادم.');
  });
});
