/**
 * The non-blocking Reinvestigate dialog (Round 16 SPEC §4.5 WP09, research R4): it posts
 * `wait: false`, closes on the `202` and the header chip shows the run at once; a second
 * request (`409 investigation_running`) is a toast; a closed case whose events another
 * open case holds (`409 open_case_exists`) says so in the server's words; a refusal is
 * worded. When the run ends, the case is read again and handed over, with a toast for
 * your own run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import type { Case, InvestigationsActive, InvestigationView } from '@/lib/types';

const h = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public body?: unknown,
    ) {
      super(message);
    }
  }
  return {
    FakeApiError,
    request: vi.fn(),
    getCase: vi.fn(),
    read: vi.fn(),
    onEvent: null as null | ((ev: { type: string; data: unknown; lastEventId: string }) => void),
    toastInfo: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    canViewCost: true,
  };
});

vi.mock('@/lib/api', () => ({ api: { getCase: h.getCase, reinvestigateCase: h.request }, ApiError: h.FakeApiError }));
vi.mock('sonner', () => ({ toast: { info: h.toastInfo, error: h.toastError, success: h.toastSuccess } }));
vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ hasPermission: (r: string, a: string) => (r === 'cost' && a === 'view' ? h.canViewCost : true) }),
}));
vi.mock('@/lib/api-investigations', () => ({ getActiveInvestigations: h.read }));
vi.mock('@/lib/useEventStream', () => ({
  subscribeEvents: (_topics: string[], opts: { onEvent: typeof h.onEvent }) => {
    h.onEvent = opts.onEvent;
    return () => undefined;
  },
}));

import { fmtMoney } from '@/lib/format';
import { ReinvestigateDialog, finishedToastText, reinvestigateErrorText } from '../ReinvestigateDialog';
import { AiRunChip } from '../AiRunChip';
import { investigationSnapshot, resetInvestigationsForTests } from '../store';

const T0 = Date.parse('2026-11-25T10:00:00Z');
const CASE = { case_id: 'case-1', case_number: 'CASE-0042', token_cost: 0.25, status: 'investigating' } as Case;

function view(over: Partial<InvestigationView> = {}): InvestigationView {
  return {
    run_id: 'inv-9',
    case_id: 'case-1',
    state: 'running',
    phase: 'triage',
    trigger: 'manual',
    queued_at: new Date(Date.now()).toISOString(),
    started_at: new Date(Date.now()).toISOString(),
    deadline_at: new Date(Date.now() + 120_000).toISOString(),
    time_cap_seconds: 120,
    finished_at: null,
    outcome: null,
    status_after: null,
    verdict_after: null,
    ...over,
  };
}

function body(over: Partial<InvestigationsActive> = {}): InvestigationsActive {
  return {
    items: [],
    recent: [],
    new_runs: 0,
    slots: { in_use: 0, cap: 3 },
    process_local: true,
    generated_at: new Date(Date.now()).toISOString(),
    ...over,
  };
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderDialog(over: Partial<React.ComponentProps<typeof ReinvestigateDialog>> = {}) {
  const onOpenChange = vi.fn();
  const onReinvestigated = vi.fn();
  const utils = render(
    <>
      <AiRunChip caseId="case-1" />
      <ReinvestigateDialog
        caseRecord={CASE}
        open
        onOpenChange={onOpenChange}
        models={{ providers: { openai: ['gpt-x'] } } as never}
        onReinvestigated={onReinvestigated}
        {...over}
      />
    </>,
  );
  return { ...utils, onOpenChange, onReinvestigated };
}

const reinvestigate = () => fireEvent.click(screen.getByRole('button', { name: /Reinvestigate/ }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetInvestigationsForTests();
  h.request.mockReset();
  h.getCase.mockReset();
  h.read.mockReset();
  h.read.mockImplementation(async () => body());
  h.toastInfo.mockReset();
  h.toastError.mockReset();
  h.toastSuccess.mockReset();
  h.canViewCost = true;
  h.onEvent = null;
});

afterEach(() => {
  resetInvestigationsForTests();
  vi.useRealTimers();
});

describe('ReinvestigateDialog', () => {
  it('says it does not block, with the time cap once the store knows it', async () => {
    h.read.mockImplementation(async () => body({ items: [view({ case_id: 'case-7', run_id: 'other' })] }));
    renderDialog();
    await settle();
    expect(screen.getByText(/It can take up to the investigation time cap \(2 minutes\)\./)).toBeInTheDocument();
    expect(screen.getByText(/You can keep working; the result appears on the case when it finishes\./)).toBeInTheDocument();
    expect(screen.getByText(`Investigation cost to date ${fmtMoney(0.25)}.`, { exact: false })).toBeInTheDocument();
  });

  it('posts wait:false, closes on the 202, and the chip shows the run at once', async () => {
    h.request.mockResolvedValue({ run_id: 'inv-9', case_id: 'case-1', state: 'queued' });
    const { onOpenChange } = renderDialog();
    await settle();
    expect(screen.queryByTestId('ai-run-chip')).toBeNull();
    reinvestigate();
    await settle();
    expect(h.request).toHaveBeenCalledWith('case-1', { wait: false });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('ai-run-chip')).toHaveTextContent('AI queued');
    expect(investigationSnapshot().byCase.get('case-1')?.requested_by_you).toBe(true);
  });

  it('toasts a second request (409 investigation_running) and closes', async () => {
    h.request.mockRejectedValue(
      new h.FakeApiError(409, 'An AI investigation is already running on this case.', {
        detail: { code: 'investigation_running', run: view() },
      }),
    );
    const { onOpenChange } = renderDialog();
    await settle();
    reinvestigate();
    await settle();
    expect(h.toastInfo).toHaveBeenCalledWith('An AI investigation is already running on this case.');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('shows the run a 409 names when this console did not know it (no live stream)', async () => {
    renderDialog();
    await settle();
    expect(screen.queryByTestId('ai-run-chip')).toBeNull();
    // Someone else's run started after the case opened; with no stream, nothing said so.
    const other = view({ run_id: 'inv-3', trigger: 'automatic', queued_at: new Date(T0 - 5000).toISOString() });
    h.read.mockImplementation(async () => body({ items: [other] }));
    h.request.mockRejectedValue(
      new h.FakeApiError(409, 'An AI investigation is already running on this case.', {
        detail: { code: 'investigation_running', run: other },
      }),
    );
    reinvestigate();
    await settle();
    expect(h.toastInfo).toHaveBeenCalledWith('An AI investigation is already running on this case.');
    expect(screen.getByTestId('ai-run-chip')).toHaveTextContent('AI working');
  });

  it("says why a closed case cannot be reinvestigated in the server's words (409 open_case_exists)", async () => {
    h.request.mockRejectedValue(
      new h.FakeApiError(409, 'An open case already holds these events. Reinvestigate that case.', {
        detail: { code: 'open_case_exists', case_id: 'case-2' },
      }),
    );
    const { onOpenChange } = renderDialog();
    await settle();
    reinvestigate();
    await settle();
    expect(h.toastError).toHaveBeenCalledWith('An open case already holds these events. Reinvestigate that case.');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('words a refusal and hides the cost without cost:view', async () => {
    h.canViewCost = false;
    h.request.mockRejectedValue(new h.FakeApiError(403, 'permission denied: cases:reinvestigate'));
    renderDialog();
    await settle();
    expect(screen.queryByText(/Investigation cost to date/)).toBeNull();
    reinvestigate();
    await settle();
    expect(h.toastError).toHaveBeenCalledWith('You do not have permission to reinvestigate cases.');
    expect(reinvestigateErrorText(new Error('boom'))).toBe('boom');
    expect(reinvestigateErrorText(null)).toBe('The reinvestigation could not be started.');
  });

  it('reads the case again when your run ends and says so', async () => {
    h.request.mockResolvedValue({ run_id: 'inv-9', case_id: 'case-1', state: 'queued' });
    const next = { ...CASE, status: 'needs_human', verdict: 'NEEDS_HUMAN' } as Case;
    h.getCase.mockResolvedValue(next);
    const { onReinvestigated } = renderDialog();
    await settle();
    reinvestigate();
    await settle();
    act(() => h.onEvent?.({ type: 'case.investigation', data: { ...view(), active: 1, new_runs: 0 }, lastEventId: '1' }));
    await settle(1_000);
    act(() =>
      h.onEvent?.({
        type: 'case.investigation',
        data: { ...view({ state: 'finished', outcome: 'decided', status_after: 'needs_human' }), active: 0, new_runs: 0 },
        lastEventId: '2',
      }),
    );
    await settle();
    expect(h.getCase).toHaveBeenCalledWith('case-1');
    expect(onReinvestigated).toHaveBeenCalledWith(next);
    expect(h.toastSuccess).toHaveBeenCalledWith('AI investigation finished on CASE-0042: Open · awaiting analyst.');
  });

  it('keeps the finish toast when the case on screen blanks for a moment while it reloads', async () => {
    h.request.mockResolvedValue({ run_id: 'inv-9', case_id: 'case-1', state: 'queued' });
    let reply: (value: Case) => void = () => undefined;
    h.getCase.mockImplementation(() => new Promise<Case>((resolve) => (reply = resolve)));
    const onOpenChange = vi.fn();
    const onReinvestigated = vi.fn();
    const props = { open: true, onOpenChange, models: null, onReinvestigated };
    const { rerender } = render(<ReinvestigateDialog caseRecord={CASE} {...props} />);
    await settle();
    reinvestigate();
    await settle();
    act(() =>
      h.onEvent?.({
        type: 'case.investigation',
        data: { ...view({ state: 'finished', outcome: 'decided', status_after: 'needs_human' }), active: 0, new_runs: 0 },
        lastEventId: '7',
      }),
    );
    await settle();
    expect(h.getCase).toHaveBeenCalledTimes(1);
    // The case reloads: the page hands the dialog no case for a moment, then the same one.
    rerender(<ReinvestigateDialog caseRecord={null} {...props} />);
    rerender(<ReinvestigateDialog caseRecord={CASE} {...props} />);
    const next = { ...CASE, status: 'needs_human' } as Case;
    await act(async () => {
      reply(next);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onReinvestigated).toHaveBeenCalledWith(next);
    expect(h.toastSuccess).toHaveBeenCalledWith('AI investigation finished on CASE-0042: Open · awaiting analyst.');
    expect(h.getCase).toHaveBeenCalledTimes(1);
  });

  it('says so for your own run when its 202 comes after the run ended', async () => {
    let started: (value: unknown) => void = () => undefined;
    h.request.mockImplementation(() => new Promise((resolve) => (started = resolve)));
    const same = { ...CASE, status: 'needs_human' } as Case;
    h.getCase.mockResolvedValue(same);
    const { onReinvestigated } = renderDialog({ caseRecord: same });
    await settle();
    reinvestigate();
    await settle();
    // The run starts and ends before the answer arrives; the status does not move.
    act(() => h.onEvent?.({ type: 'case.investigation', data: { ...view(), active: 1, new_runs: 0 }, lastEventId: '8' }));
    act(() =>
      h.onEvent?.({
        type: 'case.investigation',
        data: { ...view({ state: 'finished', outcome: 'decided', status_after: 'needs_human' }), active: 0, new_runs: 0 },
        lastEventId: '9',
      }),
    );
    await settle();
    expect(onReinvestigated).toHaveBeenCalledWith(same);
    expect(h.toastSuccess).not.toHaveBeenCalled();
    await act(async () => {
      started({ run_id: 'inv-9', case_id: 'case-1', state: 'queued' });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.toastSuccess).toHaveBeenCalledTimes(1);
    expect(h.toastSuccess).toHaveBeenCalledWith('AI investigation finished on CASE-0042: Open · awaiting analyst.');
    expect(h.getCase).toHaveBeenCalledTimes(1);
  });

  it("does not read the case again for a run that changed nothing, and says nothing about someone else's", async () => {
    renderDialog();
    await settle();
    act(() =>
      h.onEvent?.({ type: 'case.investigation', data: { ...view({ trigger: 'automatic' }), active: 1, new_runs: 0 }, lastEventId: '3' }),
    );
    await settle(1_000);
    act(() =>
      h.onEvent?.({
        type: 'case.investigation',
        data: { ...view({ trigger: 'automatic', state: 'finished', outcome: 'unchanged' }), active: 0, new_runs: 0 },
        lastEventId: '4',
      }),
    );
    await settle();
    expect(h.getCase).not.toHaveBeenCalled();
    expect(h.toastInfo).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it('words every way a run can end', () => {
    expect(finishedToastText(view({ outcome: 'cancelled' }), 'CASE-0042')).toBe(
      'The AI investigation on CASE-0042 stopped before it finished. The case was not changed.',
    );
    expect(finishedToastText(view({ outcome: 'failed' }), 'CASE-0042')).toBe('The AI investigation on CASE-0042 could not finish.');
    expect(finishedToastText(view({ outcome: 'unchanged' }), 'CASE-0042')).toBe(
      'AI investigation finished on CASE-0042: no change to the case.',
    );
    expect(finishedToastText(view({ outcome: 'routed_to_person', status_after: 'needs_human' }), 'CASE-0042')).toBe(
      'AI investigation finished on CASE-0042: Open · awaiting analyst.',
    );
  });
});
