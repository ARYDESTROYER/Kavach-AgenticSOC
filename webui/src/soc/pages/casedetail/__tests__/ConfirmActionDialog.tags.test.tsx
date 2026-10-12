/**
 * Close dialog Tags (Round 12 polish, tour finding 9).
 *
 * A sentence typed into Tags was saved on Close as the tag "Scheduled vendor API sync
 * from the known": the field added its pending text on blur and the server cut it to
 * 40 characters. Now the dialog uses the shared TagInput: pending text is never added
 * on the analyst's behalf, a submit with pending text stops and asks (the field says
 * "Not added yet. Press Enter to add it, or clear the field." and takes focus), and a
 * tag over 40 characters is refused with a message, never cut.
 *
 * Reverify: at 1440x900, 1366x768 and 1600x1000 that message sat below the dialog's
 * scroll area (focus does not scroll an input that is already on screen), so Close
 * looked like it did nothing. The blocked submit now scrolls the whole Tags field,
 * message included, into view. A case holds up to 25 tags (the server answers 422 past
 * that), so Tags stops at the case's remaining room and says why.
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { CASE_TAG_MAX_COUNT } from '@/lib/tags';
import { TAG_FIELD_SCROLL_MARGIN, TAG_PENDING_BLOCKED } from '@/soc/components/TagInput';
import { ConfirmActionDialog } from '../ConfirmActionDialog';
import { ALL_ACTIONS, DURABLE_CONTEXT_NOTE } from '../shared';
import { emptyGradingDraft } from '../grading';

const SENTENCE = 'Scheduled vendor API sync from the known service account';

function Harness({
  onSubmit,
  onSubmitAndNext,
  seen,
  caseTags,
}: {
  onSubmit: () => void;
  onSubmitAndNext?: () => void;
  seen: { tags: string[]; draft: string };
  caseTags?: string[];
}) {
  const [tags, setTags] = React.useState<string[]>([]);
  const [draft, setDraft] = React.useState('');
  const [disposition, setDisposition] = React.useState('false_positive');
  const [grading, setGrading] = React.useState(emptyGradingDraft());
  seen.tags = tags;
  seen.draft = draft;
  return (
    <ConfirmActionDialog
      pending={ALL_ACTIONS.close_disposition}
      acting={false}
      onClose={vi.fn()}
      onSubmit={onSubmit}
      onSubmitAndNext={onSubmitAndNext}
      note=""
      onNoteChange={vi.fn()}
      resolution=""
      onResolutionChange={vi.fn()}
      priority=""
      onPriorityChange={vi.fn()}
      assignee=""
      onAssigneeChange={vi.fn()}
      tags={tags}
      onTagsChange={setTags}
      tagDraft={draft}
      onTagDraftChange={setDraft}
      caseTags={caseTags}
      disposition={disposition}
      onDispositionChange={setDisposition}
      currentDisposition="undetermined"
      reason=""
      onReasonChange={vi.fn()}
      verdict="NEEDS_HUMAN"
      confidence={0.57}
      grading={grading}
      onGradingChange={setGrading}
    />
  );
}

function footer() {
  return within(screen.getByTestId('confirm-action-footer'));
}

describe('Close dialog Tags field', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is a labelled TagInput with the case tag limit', () => {
    render(<Harness onSubmit={vi.fn()} seen={{ tags: [], draft: '' }} />);
    const input = screen.getByRole('textbox', { name: 'Tags (optional)' });
    expect(input).not.toHaveAttribute('maxlength');
  });

  it('stops Close while text is typed but not added, and never adds it', () => {
    const onSubmit = vi.fn();
    const seen = { tags: [] as string[], draft: '' };
    render(<Harness onSubmit={onSubmit} seen={seen} />);
    const input = screen.getByRole('textbox', { name: 'Tags (optional)' });
    fireEvent.change(input, { target: { value: 'vendor-sync' } });
    fireEvent.blur(input);
    expect(seen.tags).toEqual([]);

    fireEvent.click(footer().getByRole('button', { name: 'Close case' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(TAG_PENDING_BLOCKED);
    expect(document.activeElement).toBe(input);
    expect(seen.tags).toEqual([]);

    // Enter adds it; Close then goes through with the tag the analyst confirmed.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(seen.tags).toEqual(['vendor-sync']);
    expect(screen.queryByText(TAG_PENDING_BLOCKED)).toBeNull();
    fireEvent.click(footer().getByRole('button', { name: 'Close case' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('stops Close & next the same way, and clearing the field lets it through', () => {
    const onSubmitAndNext = vi.fn();
    const seen = { tags: [] as string[], draft: '' };
    render(<Harness onSubmit={vi.fn()} onSubmitAndNext={onSubmitAndNext} seen={seen} />);
    const input = screen.getByRole('textbox', { name: 'Tags (optional)' });
    fireEvent.change(input, { target: { value: 'oops' } });
    fireEvent.click(footer().getByRole('button', { name: 'Close & next' }));
    expect(onSubmitAndNext).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(footer().getByRole('button', { name: 'Close & next' }));
    expect(onSubmitAndNext).toHaveBeenCalledTimes(1);
    expect(seen.tags).toEqual([]);
  });

  it('refuses a tag over 40 characters with a message and keeps the full text', () => {
    const seen = { tags: [] as string[], draft: '' };
    render(<Harness onSubmit={vi.fn()} seen={seen} />);
    const input = screen.getByRole('textbox', { name: 'Tags (optional)' });
    fireEvent.change(input, { target: { value: SENTENCE } });
    expect(screen.getByRole('alert')).toHaveTextContent('This is longer than 40 characters. Shorten it to add it.');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(seen.tags).toEqual([]);
    expect(seen.draft).toBe(SENTENCE);
    expect(seen.tags.some((t) => t.startsWith('Scheduled vendor'))).toBe(false);
  });

  it('reads its copy without em dashes', () => {
    render(<Harness onSubmit={vi.fn()} seen={{ tags: [], draft: '' }} />);
    const dialog = screen.getByTestId('confirm-action-dialog');
    expect(dialog.textContent ?? '').not.toContain('—');
    expect(DURABLE_CONTEXT_NOTE).not.toContain('—');
  });

  it('scrolls the Tags field, with its message, into view when Close is blocked', () => {
    const calls: Element[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      calls.push(this);
    });
    render(<Harness onSubmit={vi.fn()} seen={{ tags: [], draft: '' }} />);
    const input = screen.getByRole('textbox', { name: 'Tags (optional)' });
    fireEvent.change(input, { target: { value: 'vendor-sync' } });
    fireEvent.blur(input);
    calls.length = 0;

    fireEvent.click(footer().getByRole('button', { name: 'Close case' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(TAG_PENDING_BLOCKED);
    const field = input.closest(`.${TAG_FIELD_SCROLL_MARGIN}`) as HTMLElement;
    expect(field.contains(alert)).toBe(true);
    expect(calls).toContain(field);
    // The field sits inside the dialog's own scroll area, which is what scrolls.
    expect(screen.getByTestId('confirm-action-body').contains(field)).toBe(true);

    // A second Close with the same text still brings it back into view.
    calls.length = 0;
    fireEvent.click(footer().getByRole('button', { name: 'Close case' }));
    expect(calls).toContain(field);
  });

  it('stops at the room the case has left, and says why', () => {
    const existing = Array.from({ length: CASE_TAG_MAX_COUNT - 1 }, (_, i) => `t${i}`);
    const seen = { tags: [] as string[], draft: '' };
    render(<Harness onSubmit={vi.fn()} seen={seen} caseTags={existing} />);
    const input = screen.getByRole('textbox', { name: 'Tags (optional)' });
    expect(input).toBeEnabled();
    // A tag the case already has takes no room.
    fireEvent.change(input, { target: { value: 't0' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: 'last-one' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(seen.tags).toEqual(['t0', 'last-one']);
    expect(input).toBeDisabled();
    expect(screen.getByText(`That makes ${CASE_TAG_MAX_COUNT} tags on this case, the most it can hold.`)).toBeVisible();
  });

  it('explains a case that is already full', () => {
    const full = Array.from({ length: CASE_TAG_MAX_COUNT }, (_, i) => `t${i}`);
    render(<Harness onSubmit={vi.fn()} seen={{ tags: [], draft: '' }} caseTags={full} />);
    expect(screen.getByRole('textbox', { name: 'Tags (optional)' })).toBeDisabled();
    expect(
      screen.getByText(
        `A case can hold up to ${CASE_TAG_MAX_COUNT} tags, and this one has ${CASE_TAG_MAX_COUNT}. Remove one in the case header to add another here.`,
      ),
    ).toBeVisible();
  });
});
