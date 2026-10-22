// AOS-21.46 (track C3, web part): wherever an AI action is offered, the account's remaining AI allowance is visible —
// from C1's QuotaView (`/api/accounts/me/quota`: remaining_usd, resets_at, blocked_reason_ar). Never an invented
// number: estimated amounts say so, a missing allowance says nothing is known, a blocked one says why.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { QuotaView } from '@medlevo/shared';
import { setFetchImpl } from '../../src/lib/api';
import { AiAllowanceNote, aiAllowanceLine, aiAllowanceStore } from '../../src/lib/aiAllowance';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const RESETS = Date.UTC(2026, 10, 1, 0, 0, 0);
function quota(ai: Partial<QuotaView['ai']>): QuotaView {
  return {
    storage: { used_bytes: 0, limit_bytes: null },
    ai: { month: '2026-10', used_usd_est: 0.58, limit_usd: 1, remaining_usd: 0.42, resets_at: RESETS, blocked_reason_ar: null, ...ai },
    asr: { month: '2026-10', used_minutes: 0, limit_minutes: null },
  };
}

let hits = 0;
function serve(q: QuotaView | null, status = 200) {
  hits = 0;
  setFetchImpl(async (url) => {
    if (url.split('?')[0] === '/api/accounts/me/quota') {
      hits++;
      return q ? json(q) : json({ error: { code: 'INTERNAL', message: 'تعذّر' } }, status);
    }
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
}
beforeEach(() => aiAllowanceStore.reset());
afterEach(() => setFetchImpl(null));

describe('the sentence', () => {
  it('remaining of a monthly allowance, estimated, with the day it starts again; amounts in Latin digits', () => {
    const line = aiAllowanceLine(quota({}), 'Asia/Baghdad');
    expect(line.tone).toBe('neutral');
    expect(line.text).toContain('المتبقي من رصيدك للذكاء الاصطناعي هذا الشهر');
    expect(line.amount).toBe('$0.42 من $1.00');
    expect(line.text).toContain('تقديري');
    expect(line.text).toContain('يتجدد');
  });
  it('an older server without remaining_usd: computed from the limit and what was used, never below zero', () => {
    expect(aiAllowanceLine(quota({ remaining_usd: undefined, used_usd_est: 1.4, limit_usd: 1 })).amount).toBe('$0.00 من $1.00');
  });
  it('blocked: why, in the server’s words (no provider, no consent, spent, the deployment ceiling)', () => {
    const line = aiAllowanceLine(quota({ remaining_usd: 0, blocked_reason_ar: 'نفد رصيدك الشهري للذكاء الاصطناعي.' }));
    expect(line.tone).toBe('warning');
    expect(line.text).toContain('نفد رصيدك الشهري للذكاء الاصطناعي.');
  });
  it('no monthly limit for this account: what was used, nothing invented', () => {
    const line = aiAllowanceLine(quota({ limit_usd: null, remaining_usd: undefined }));
    expect(line.text).toContain('لا حد شهري لحسابك');
    expect(line.amount).toBe('$0.58');
  });
});

describe('<AiAllowanceNote />', () => {
  it('reads the account’s quota once and shows the remaining allowance next to the AI action', async () => {
    serve(quota({}));
    render(<AiAllowanceNote />);
    const note = await screen.findByRole('note', { name: 'رصيد الذكاء الاصطناعي' });
    expect(note.textContent).toContain('$0.42 من $1.00');
    render(<AiAllowanceNote />);
    await waitFor(() => expect(screen.getAllByRole('note', { name: 'رصيد الذكاء الاصطناعي' })).toHaveLength(2));
    expect(hits).toBe(1);
  });
  it('blocked: the reason is shown', async () => {
    serve(quota({ remaining_usd: 0, blocked_reason_ar: 'لم توافق بعد على معالجة الذكاء الاصطناعي.' }));
    render(<AiAllowanceNote />);
    expect((await screen.findByRole('note', { name: 'رصيد الذكاء الاصطناعي' })).textContent).toContain('لم توافق بعد على معالجة الذكاء الاصطناعي.');
  });
  it('the server could not say: the allowance is said to be unknown — never a number', async () => {
    serve(null, 500);
    render(<AiAllowanceNote />);
    const note = await screen.findByRole('note', { name: 'رصيد الذكاء الاصطناعي' });
    expect(note.textContent).toContain('تعذّر معرفة رصيدك');
    expect(note.textContent).not.toMatch(/\$\d/);
  });
  it('refreshes after an AI action (the store is told) so the number follows the spending', async () => {
    serve(quota({}));
    render(<AiAllowanceNote />);
    const note = await screen.findByRole('note', { name: 'رصيد الذكاء الاصطناعي' });
    await waitFor(() => expect(note.textContent).toContain('$0.42 من $1.00'));
    serve(quota({ remaining_usd: 0.3, used_usd_est: 0.7 }));
    await act(async () => {
      aiAllowanceStore.spent();
    });
    await waitFor(() => expect(screen.getByRole('note', { name: 'رصيد الذكاء الاصطناعي' }).textContent).toContain('$0.30 من $1.00'));
  });
});

describe('where AI actions are offered', () => {
  const surfaces = [
    'features/workspace/panels/ExplainTab.tsx',
    'features/workspace/studybook/StudyBookPane.tsx',
    'features/workspace/panels/CreateMcqPanel.tsx',
    'features/workspace/panels/CasesTab.tsx',
    'features/exams/GenerateScreen.tsx',
    'features/exams/WrittenScreen.tsx',
    'features/questions/AnswerCheck.tsx',
    'features/studybook/diagrams/DiagramPanel.tsx',
  ];
  it.each(surfaces)('%s shows <AiAllowanceNote />', (file) => {
    expect(readFileSync(join(__dirname, '../../src', file), 'utf8')).toContain('<AiAllowanceNote');
  });
});
