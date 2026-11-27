/**
 * Round 15 (SPEC D6.6, D6.11, D6.12; WP7): the review's mount points in the case
 * workspace. The band says why a pending sample is here (no second button); the review
 * sheet is non-blocking (a click on the case beside it never closes it), titled, opens
 * on its title, loads the card lazily, returns focus to its opener, and Cancel closes it.
 * `useCaseReviewState` reads only for a case the agent closed, keeps the last answer for
 * the same case when a read fails, and turns a client that throws at once into "unknown".
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

import type { Case } from '@/lib/types';
import type { CaseReviewState } from '@/lib/types-reviews';

vi.mock('@/lib/api-reviews', () => ({ recordReview: vi.fn(), getCaseReviewState: vi.fn() }));

import { ReviewBand } from '../ReviewBand';
import { REVIEW_SHEET_DESCRIPTION, ReviewSheet, loadReviewCard } from '../ReviewSheet';
import { REVIEW_BAND_TEXT, REVIEW_MENU_LABEL } from '../review-plan';
import { useCaseReviewState } from '../useCaseReviewState';

const CASE = {
  case_id: 'c-rev-1',
  case_number: 'CASE-0101',
  title: 'Weekly scanner sweep',
  status: 'closed',
  decision_by: 'agent',
  verdict: 'FALSE_POSITIVE',
  confidence: 0.93,
} as unknown as Case;

const state = (over: Partial<CaseReviewState> = {}): CaseReviewState => ({
  case_id: 'c-rev-1',
  agent_closed: true,
  state: 'pending',
  can_record: true,
  ...over,
});

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errorSpy = vi.spyOn(console, 'error');
  // The card's chunk, loaded up front so it renders inside the test's own act() scope.
  await loadReviewCard();
});
afterEach(() => {
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

describe('ReviewBand', () => {
  it('says why the case is here, as a note with no button of its own', () => {
    render(<ReviewBand />);
    const band = screen.getByRole('note');
    expect(band).toHaveTextContent(REVIEW_BAND_TEXT);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ReviewSheet', () => {
  function Host({ onRecorded = vi.fn(), onReopened = vi.fn() }: { onRecorded?: () => void; onReopened?: () => void }) {
    const [open, setOpen] = React.useState(false);
    const opener = React.useRef<HTMLButtonElement | null>(null);
    return (
      <>
        <button ref={opener} type="button" onClick={() => setOpen(true)}>
          Start review
        </button>
        <p>Case evidence the reviewer reads</p>
        <ReviewSheet
          open={open}
          onOpenChange={setOpen}
          caseData={CASE}
          canReopen
          session={1}
          returnFocusRef={opener}
          onRecorded={onRecorded}
          onReopened={onReopened}
        />
      </>
    );
  }

  it('opens on its title with the card, and stays open while the case beside it is read', async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
    const sheet = await screen.findByRole('dialog', { name: REVIEW_MENU_LABEL });
    expect(screen.getByText(REVIEW_SHEET_DESCRIPTION)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: REVIEW_MENU_LABEL })).toHaveFocus());
    expect(await screen.findByText('What was it?')).toBeInTheDocument();
    // The band beside the sheet says why the case is here; the card does not repeat it.
    expect(screen.queryByText(REVIEW_BAND_TEXT)).toBeNull();

    // Reading the case: a pointer down and focus outside never close the sheet.
    const evidence = screen.getByText('Case evidence the reviewer reads');
    fireEvent.pointerDown(evidence);
    fireEvent.mouseDown(evidence);
    fireEvent.focus(evidence);
    expect(sheet).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: REVIEW_MENU_LABEL })).toBeInTheDocument();
  });

  it('closes on Cancel and gives focus back to the control that opened it', async () => {
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Start review' });
    fireEvent.click(opener);
    await screen.findByText('What was it?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: REVIEW_MENU_LABEL })).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});

describe('useCaseReviewState', () => {
  it('reads only for a case the agent closed, and again when the key changes', async () => {
    const fetcher = vi.fn(async (caseId: string) => state({ case_id: caseId }));
    const { result, rerender } = renderHook(
      ({ id, enabled, key }) => useCaseReviewState(id, enabled, key, fetcher),
      { initialProps: { id: 'c-1', enabled: false, key: 0 } },
    );
    expect(result.current).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    rerender({ id: 'c-1', enabled: true, key: 0 });
    await waitFor(() => expect(result.current?.state).toBe('pending'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    rerender({ id: 'c-1', enabled: true, key: 1 });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    // Disabled again (the case was reopened): unknown, with no read.
    rerender({ id: 'c-1', enabled: false, key: 1 });
    expect(result.current).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer for the same case when a read fails, never another case's", async () => {
    let fail = false;
    const fetcher = vi.fn(async (caseId: string) => {
      if (fail) throw new Error('down');
      return state({ case_id: caseId });
    });
    const { result, rerender } = renderHook(
      ({ id, key }) => useCaseReviewState(id, true, key, fetcher),
      { initialProps: { id: 'c-1', key: 0 } },
    );
    await waitFor(() => expect(result.current?.case_id).toBe('c-1'));
    fail = true;
    rerender({ id: 'c-1', key: 1 });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(result.current?.case_id).toBe('c-1');
    rerender({ id: 'c-2', key: 1 });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(result.current).toBeNull();
  });

  it('turns a client that throws at once into "unknown"', async () => {
    const fetcher = vi.fn(() => {
      throw new TypeError('request is not a function');
    }) as unknown as (caseId: string) => Promise<CaseReviewState>;
    const { result } = renderHook(() => useCaseReviewState('c-1', true, 0, fetcher));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
  });
});
