// H1: in «امتحن نفسك» the lasso «اسأل عن المحدد» on handwriting is disabled with the same reason as the other explain
// actions (the rail's explanation section is hidden in that mode, so the action could only open an empty rail).
// «تحويل إلى نص» stays available (reading the owner's own writing reveals no solution).
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXAM_MODE_HIDDEN_AR, newId } from '@medlevo/shared';
import { InkProvider, useInkSelectionActions } from '../../src/features/workspace/ink';
import { __resetStores } from '../../src/features/workspace/ink/store';
import { HandwritingHost } from '../../src/features/workspace/handwriting/HandwritingHost';

beforeEach(() => {
  __resetStores();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

function Probe() {
  const a = useInkSelectionActions();
  return (
    <p>
      <span data-testid="ask">{a?.ask?.reason ?? 'enabled'}</span>
      <span data-testid="convert">{a?.convert?.reason ?? 'enabled'}</span>
    </p>
  );
}

function host(askHiddenReason: string | null) {
  return render(
    <InkProvider documentKey={`doc-${newId()}`}>
      <HandwritingHost sourceId="S1" nodeId={null} online askHiddenReason={askHiddenReason}>
        <Probe />
      </HandwritingHost>
    </InkProvider>,
  );
}

describe('«اسأل عن المحدد» in exam mode (H1)', () => {
  it('is disabled with the exam-mode reason; «تحويل إلى نص» is not affected by the mode', () => {
    host(EXAM_MODE_HIDDEN_AR);
    expect(screen.getByTestId('ask').textContent).toBe(EXAM_MODE_HIDDEN_AR);
    expect(screen.getByTestId('convert').textContent).not.toBe(EXAM_MODE_HIDDEN_AR);
  });

  it('outside exam mode it is enabled (online)', () => {
    host(null);
    expect(screen.getByTestId('ask').textContent).toBe('enabled');
  });
});
