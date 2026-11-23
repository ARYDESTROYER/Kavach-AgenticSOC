/**
 * CaseDetail: feedback-into-close (Round-7 #10, DERIVED model).
 *
 * The standalone Feedback tab is retired; AI-decision grading now folds INTO the close
 * dialog. On a close-with-verdict the orchestrator's `runAction` fires TWO SEPARATE api
 * calls (#3 intact):
 *
 *   1. `caseActionExec`: the EXISTING lifecycle verb; the backend still runs the real
 *                          deterministic `decide()`/`apply()`.
 *   2. `caseFeedback`: a best-effort grading POST, with the agree/override assessment
 *                          DERIVED from the disposition ↔ verdict diff. It NEVER touches
 *                          `decide()`.
 *
 * This spec pins the two-call contract behaviourally (a live mount over a mocked
 * `@/lib/api`, like the sibling CaseDetail.footer/campaign specs):
 *
 *   - closing a VERDICT-bearing case issues BOTH the action POST and the feedback POST,
 *     the feedback carrying the DERIVED assessment;
 *   - CANCELLING the dialog issues NEITHER;
 *   - closing a NO-VERDICT case issues ONLY the action POST (grading is skipped).
 *
 * #9 is unaffected: no attacker-influenceable text is rendered by these assertions.
 */
import type * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { caseActionExec, caseFeedback, getCase, toastMock } = vi.hoisted(() => ({
  caseActionExec: vi.fn(),
  caseFeedback: vi.fn(),
  getCase: vi.fn(),
  toastMock: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));

const BASE_CASE = {
  case_id: 'case-91',
  case_number: 'TLSOC-091',
  title: 'Credential stuffing burst',
  status: 'open',
  disposition: null as string | null,
  confidence: 0.8,
  risk_score: 68,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T01:00:00Z',
  escalation_level: 0,
  evidence: [],
  assets: {},
  iocs: [],
  tags: [],
  comments: [],
};

vi.mock('@/lib/api', async () => {
  // Keep the REAL `ApiError`: `runAction` (and the shared `errorMessage`) narrow on it
  // to tell a 4xx rejection of the grading apart from a transport fault.
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    ApiError: actual.ApiError,
    setUnauthorizedHandler: vi.fn(),
    api: {
      getCase,
      getModels: ok({ providers: {} }),
      getSettings: ok({ prefs: {}, configured: {}, read_only: false }),
      caseActionExec,
      caseFeedback,
      cases: {
        threatContext: ok(null),
        notify: ok({ sent: [] }),
      },
    },
  };
});

import { AuthProvider } from '../../auth';
import { RouterProvider } from '../../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CaseDetail } from '../CaseDetail';

function renderWithProviders(node: React.ReactNode) {
  return render(
    <AuthProvider>
      <RouterProvider>
        <TooltipProvider>{node}</TooltipProvider>
      </RouterProvider>
    </AuthProvider>,
  );
}

/**
 * Open the close dialog with C (Round 15, D8.2: "Close case" is the primary action only
 * while a case is open, investigating or awaiting an analyst, and in Take action
 * otherwise; C opens it in every status that allows a close).
 */
function openCloseDialog() {
  act(() => (document.activeElement as HTMLElement | null)?.blur());
  fireEvent.keyDown(document.body, { key: 'c' });
}

/** Open the "Close case" dialog and pick a disposition (leaves it submittable). */
async function openCloseDialogAndPick(disposition: RegExp): Promise<HTMLElement> {
  await waitFor(
    () => expect(screen.getByText('Credential stuffing burst')).toBeInTheDocument(),
    { timeout: 5000 },
  );
  openCloseDialog();
  const dialog = await screen.findByRole('dialog');
  // Round 12: the disposition picker is a radio-card group (with definitions).
  fireEvent.click(within(dialog).getByRole('radio', { name: disposition }));
  return dialog;
}

describe('CaseDetail: feedback-into-close (two separate POSTs, #3)', () => {
  beforeEach(() => {
    caseActionExec.mockReset();
    caseFeedback.mockReset();
    getCase.mockReset();
    toastMock.error.mockReset();
    toastMock.warning.mockReset();
  });

  it('closing a VERDICT-bearing case issues BOTH the action POST and a derived feedback POST', async () => {
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'true_positive' });
    caseActionExec.mockResolvedValue({
      ...BASE_CASE,
      verdict: 'true_positive',
      status: 'closed',
      disposition: 'true_positive',
    });
    caseFeedback.mockResolvedValue({
      ...BASE_CASE,
      verdict: 'true_positive',
      status: 'closed',
      disposition: 'true_positive',
      feedback: [{ assessment: 'agree' }],
    });

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/True positive/i);

    // The DERIVED agree/override badge proves the grading section wired the
    // verdict ↔ disposition diff (true_positive matches true_positive → agree).
    await screen.findByText(/Your classification agrees with the AI/i);

    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    // 1) The deterministic close verb (decide()/apply() runs server-side, #3).
    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
    const [, actionInput] = caseActionExec.mock.calls[0];
    expect(actionInput.action).toBe('close');
    expect(actionInput.disposition).toBe('true_positive');
    // The analyst operated the picker, so the wire asserts INTENT alongside the value.
    // Without this the backend applies the disposition but records no classification.
    expect(actionInput.disposition_declared).toBe(true);

    // 2) The SEPARATE grading POST, carrying the derived 'agree' assessment.
    await waitFor(() => expect(caseFeedback).toHaveBeenCalledTimes(1));
    const [feedbackId, feedbackBody] = caseFeedback.mock.calls[0];
    expect(feedbackId).toBe('case-91');
    expect(feedbackBody.assessment).toBe('agree');
  });

  it('confirms the close with the recorded outcome and offers Reopen (not "Undo"), which posts the reopen verb', async () => {
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'needs_human' });
    caseActionExec
      .mockResolvedValueOnce({ ...BASE_CASE, verdict: 'needs_human', status: 'closed', disposition: 'false_positive' })
      .mockResolvedValueOnce({ ...BASE_CASE, verdict: 'needs_human', status: 'open', disposition: 'false_positive' });
    caseFeedback.mockResolvedValue(null);
    toastMock.success.mockReset();

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/False positive/i);
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    const [message, options] = toastMock.success.mock.calls[0] as [
      string,
      { action?: { label: string; onClick: () => void }; duration?: number; description?: string },
    ];
    expect(message).toBe('Closed as false positive.');
    expect(options?.duration).toBe(8000);
    // A reopen keeps the recorded classification (and the resolved-case precedent), so
    // it is labelled for what it does and says the outcome stays until a new close.
    expect(options?.action?.label).toBe('Reopen');
    expect(options?.action?.label).not.toBe('Undo');
    expect(options?.description).toMatch(/keeps this outcome on record until you close the case again/i);

    options!.action!.onClick();
    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(2));
    expect(caseActionExec.mock.calls[1][1]).toMatchObject({ action: 'reopen' });
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenLastCalledWith('Reopened. The recorded outcome stays until you close it again.'),
    );
  });

  it('posts NO grade when an analyst settles a Needs-human case without grading it (Agreement stays honest)', async () => {
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'NEEDS_HUMAN' });
    caseActionExec.mockResolvedValue({ ...BASE_CASE, verdict: 'NEEDS_HUMAN', status: 'closed', disposition: 'false_positive' });
    caseFeedback.mockResolvedValue(null);

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/False positive/i);
    await within(dialog).findByText(/settles the AI's hand-off/i);
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    // The close is the analyst's record; an untouched grade on a hand-off is not "agree".
    expect(caseFeedback).not.toHaveBeenCalled();
  });

  it('a Needs-human close the analyst DID grade posts the grade without a made-up assessment', async () => {
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'NEEDS_HUMAN' });
    caseActionExec.mockResolvedValue({ ...BASE_CASE, verdict: 'NEEDS_HUMAN', status: 'closed', disposition: 'false_positive' });
    caseFeedback.mockResolvedValue(null);

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/False positive/i);
    fireEvent.click(within(dialog).getByRole('button', { name: /rate the ai/i }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Accuracy: 4 of 5' }));
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(caseFeedback).toHaveBeenCalledTimes(1));
    const [, body] = caseFeedback.mock.calls[0];
    expect(body).toMatchObject({ accuracy: 0.8 });
    expect(body).not.toHaveProperty('assessment');
  });

  it('a duplicate close the analyst rated posts the stars with no assessment (nothing to compare)', async () => {
    // The backend's Agreement rate counts only grades that carry an assessment, so a
    // star-only grade here neither inflates nor deflates it (Round 12 final review).
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'TRUE_POSITIVE' });
    caseActionExec.mockResolvedValue({ ...BASE_CASE, verdict: 'TRUE_POSITIVE', status: 'closed', disposition: 'duplicate' });
    caseFeedback.mockResolvedValue(null);

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/Duplicate/i);
    fireEvent.click(within(dialog).getByRole('button', { name: /rate the ai/i }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Accuracy: 4 of 5' }));
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(caseFeedback).toHaveBeenCalledTimes(1));
    const [, body] = caseFeedback.mock.calls[0];
    expect(body).toMatchObject({ accuracy: 0.8 });
    expect(body).not.toHaveProperty('assessment');
  });

  it('POSTs the assessment DERIVED from the FINAL disposition, whatever the rating disclosure did', async () => {
    // Regression (Round 7): the derived agree/override used to be synced into parent state
    // by an effect inside the grading section, so a section collapsed before a later
    // disposition change POSTed a STALE assessment. Round 15 (D4.4) never asks it: it is
    // derived AT SUBMIT from the committed disposition against the verdict, so opening and
    // closing "Rate the AI" cannot freeze it.
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'true_positive' });
    caseActionExec.mockResolvedValue({
      ...BASE_CASE,
      verdict: 'true_positive',
      status: 'closed',
      disposition: 'false_positive',
    });
    caseFeedback.mockResolvedValue({
      ...BASE_CASE,
      verdict: 'true_positive',
      status: 'closed',
      disposition: 'false_positive',
      feedback: [{ assessment: 'disagree' }],
    });

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/True positive/i);
    await screen.findByText(/Your classification agrees with the AI/i);

    // Open and close the rating disclosure, then flip to an OVERRIDE.
    const rate = within(dialog).getByRole('button', { name: /rate the ai/i });
    fireEvent.click(rate);
    fireEvent.click(rate);
    fireEvent.click(within(dialog).getByRole('radio', { name: /False positive/i }));
    await within(dialog).findByText(/Your classification overrides the AI/i);

    // D4.3: an override needs a note before it can go.
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    fireEvent.click(submit);
    expect(caseActionExec).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/analyst note \(required\)/i), {
      target: { value: 'The source IP is our scanner.' },
    });
    fireEvent.click(submit);

    // The deterministic close carries the final disposition and the note.
    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
    expect(caseActionExec.mock.calls[0][1]).toMatchObject({
      disposition: 'false_positive',
      note: 'The source IP is our scanner.',
    });

    // The grading POST carries the assessment DERIVED AT SUBMIT from the FINAL disposition
    // (false_positive) against the verdict (true_positive) = 'disagree'.
    await waitFor(() => expect(caseFeedback).toHaveBeenCalledTimes(1));
    expect(caseFeedback.mock.calls[0][1].assessment).toBe('disagree');
  });

  it('CANCELLING the close dialog issues NEITHER the action nor the feedback POST', async () => {
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'true_positive' });

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/True positive/i);

    // Cancel routes through `closeAction` (setPending(null)) and triggers NO POST at
    // all: neither the deterministic action nor the grading feedback.
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(caseActionExec).not.toHaveBeenCalled();
    expect(caseFeedback).not.toHaveBeenCalled();
  });

  it('SURFACES a 422 rejection instead of swallowing it (G1c)', async () => {
    // The catch used to discard the result outright, so a rejected grading was
    // invisible: the case closed, the toast said nothing, and the analyst walked away
    // believing their ground truth had been recorded. The catch stays (a grading
    // failure must never read as a close failure, #3), but it must SAY so.
    const { ApiError } = await import('@/lib/api');
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'true_positive' });
    caseActionExec.mockResolvedValue({
      ...BASE_CASE,
      verdict: 'true_positive',
      status: 'closed',
      disposition: 'true_positive',
    });
    caseFeedback.mockRejectedValue(
      new ApiError(422, 'actual_outcome: input is not a valid enumeration member'),
    );

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/True positive/i);
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    const message = String(toastMock.error.mock.calls[0][0]);
    expect(message).toMatch(/grading was rejected/i);
    expect(message).toMatch(/not a valid enumeration member/i);
    // The CLOSE still succeeded: it is a separate call and must not be reported as
    // failed. The terminal footer proves the lifecycle action landed.
    await screen.findByRole('button', { name: /reopen/i });
  });

  it('reports a transport fault as a warning, not as a close failure', async () => {
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'true_positive' });
    caseActionExec.mockResolvedValue({
      ...BASE_CASE,
      verdict: 'true_positive',
      status: 'closed',
      disposition: 'true_positive',
    });
    caseFeedback.mockRejectedValue(new TypeError('Failed to fetch'));

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/True positive/i);
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    expect(String(toastMock.warning.mock.calls[0][0])).toMatch(/was not recorded/i);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('never sets actual_outcome from the disposition (D4.4): the declared disposition is the label', async () => {
    // The close's grade carries the derived assessment only. A feedback label would pin
    // ground truth against a later reclassification, which the declared disposition
    // (`explicit_analyst_disposition`) already records.
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'false_positive' });
    caseActionExec.mockResolvedValue({ ...BASE_CASE, verdict: 'false_positive', status: 'closed', disposition: 'benign' });
    caseFeedback.mockResolvedValue(null);

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/^Benign/i);
    expect(within(dialog).queryByLabelText(/what actually happened/i)).toBeNull();
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(caseFeedback).toHaveBeenCalledTimes(1));
    const [, body] = caseFeedback.mock.calls[0];
    expect(body).toMatchObject({ assessment: 'agree' });
    expect(body).not.toHaveProperty('actual_outcome');
  });

  it('sends the actions taken with the close (D4.2), and nothing when none were chosen', async () => {
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'true_positive' });
    caseActionExec.mockResolvedValue({ ...BASE_CASE, verdict: 'true_positive', status: 'closed', disposition: 'true_positive' });
    caseFeedback.mockResolvedValue(null);

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/True positive/i);
    const group = within(dialog).getByRole('group', { name: /actions taken/i });
    fireEvent.click(within(group).getByRole('button', { name: 'Blocked an indicator' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Reset credentials' }));
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
    expect(caseActionExec.mock.calls[0][1]).toMatchObject({
      action: 'close',
      actions_taken: ['blocked_indicator', 'reset_credentials'],
    });
    // Tags and the resolution left the dialog (D4.1, D4.6): never sent from it.
    expect(caseActionExec.mock.calls[0][1]).not.toHaveProperty('tags');
    expect(caseActionExec.mock.calls[0][1]).not.toHaveProperty('resolution');
  });

  it('closing a NO-VERDICT case issues ONLY the action POST (grading skipped)', async () => {
    // No AI verdict to grade: the second POST must be suppressed.
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: undefined });
    caseActionExec.mockResolvedValue({
      ...BASE_CASE,
      verdict: undefined,
      status: 'closed',
      disposition: 'false_positive',
    });

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/False positive/i);

    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    // The close resolves and re-renders the footer to the terminal (Reopen) state: a
    // signal that runAction's whole continuation (incl. the grading guard) ran. With no
    // verdict the feedback POST is skipped; only the deterministic action POST fired.
    await screen.findByRole('button', { name: /reopen/i });
    expect(caseActionExec).toHaveBeenCalledTimes(1);
    expect(caseFeedback).not.toHaveBeenCalled();
  });
});

/**
 * The ground-truth intent gate (G1).
 *
 * `case_manager.apply()` derives `case.disposition` from the LLM verdict. The dialog
 * used to PRE-SEED its disposition picker from that value, which meant (a) the
 * "a disposition is mandatory" guard was already satisfied before the analyst had
 * chosen anything, and (b) a bare Close → Confirm posted the model's own answer back as
 * if a human had given it. The backend then recorded it as `explicit_analyst_disposition`
 * (the exact closed loop where the tuner "confirms" the verdicts it is meant to audit).
 *
 * Two things are pinned here: the picker opens EMPTY on an already-dispositioned case,
 * and the wire carries `disposition_declared` only once the analyst has picked.
 */
describe('CaseDetail: the disposition picker never answers for the analyst (G1)', () => {
  beforeEach(() => {
    caseActionExec.mockReset();
    caseFeedback.mockReset();
    getCase.mockReset();
    toastMock.error.mockReset();
    toastMock.warning.mockReset();
  });

  /** A case the AGENT already dispositioned: apply() mapped verdict → disposition. */
  const AGENT_DISPOSITIONED = {
    ...BASE_CASE,
    status: 'escalated',
    verdict: 'true_positive',
    disposition: 'true_positive',
    decision_by: 'system',
  };

  it('opens the close dialog with an EMPTY picker and a DISABLED submit', async () => {
    getCase.mockResolvedValue(AGENT_DISPOSITIONED);

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText('Credential stuffing burst')).toBeInTheDocument(),
    );
    openCloseDialog();
    const dialog = await screen.findByRole('dialog');

    // The picker opens with NOTHING chosen, NOT the model's answer.
    const picker = within(dialog).getByRole('radiogroup', { name: /disposition \(required\)/i });
    for (const radio of within(picker).getAllByRole('radio')) expect(radio).not.toBeChecked();

    // …so the mandatory-choice guard is real.
    expect(within(dialog).getByRole('button', { name: /^close case/i })).toBeDisabled();
    expect(caseActionExec).not.toHaveBeenCalled();

    // The information the pre-seed used to carry is still there: as READ-ONLY
    // context describing the picker, not as its value.
    const help = within(dialog).getByText(/currently recorded: true positive/i);
    expect(picker).toHaveAttribute('aria-describedby', help.id);
  });

  it('declares the disposition only once the analyst has picked one', async () => {
    getCase.mockResolvedValue(AGENT_DISPOSITIONED);
    caseActionExec.mockResolvedValue({ ...AGENT_DISPOSITIONED, status: 'closed' });
    caseFeedback.mockResolvedValue({ ...AGENT_DISPOSITIONED, status: 'closed' });

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    // Re-affirming the model's own value is a legitimate analyst statement: the gate
    // is on INTENT, not on the value differing. So pick the SAME disposition the agent
    // had already written and prove the flag rides along.
    const dialog = await openCloseDialogAndPick(/True positive/i);
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
    expect(caseActionExec.mock.calls[0][1]).toMatchObject({
      action: 'close',
      disposition: 'true_positive',
      disposition_declared: true,
    });
  });
});
