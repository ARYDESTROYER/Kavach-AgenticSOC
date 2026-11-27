/**
 * Round 16 acceptance fix (FXA2): a confirmed AI step draft leaves a trace.
 *
 * Once a person confirms the AI's draft as the step's note, the draft is no longer
 * offered, but the step keeps where the note started: one line with the model and the
 * time, and "Show the AI draft" opens the draft as the model wrote it, as plain text.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { StepState } from '@/lib/types-runbooks';
import { AiDraftBox, CONFIRMED_DRAFT_HIDE, CONFIRMED_DRAFT_SHOW, confirmedDraftLine } from '../StepParts';

const HOSTILE = '<img src=x onerror=alert(1)>';

const DRAFT = {
  text: `Demo draft: the lookup found no account changes. ${HOSTILE}`,
  created_at: '2026-11-26T11:37:52Z',
  model: 'gpt-5.6-luna',
  usage_id: 'req-1',
  confirmed: true,
};

const state = (draft: typeof DRAFT | null): StepState =>
  ({ status: 'done', note: 'Edited by me: no account changes seen.', ai_draft: draft }) as unknown as StepState;

function box(draft: typeof DRAFT | null) {
  return render(
    <AiDraftBox state={state(draft)} editing={false} text="" onText={() => undefined} fieldId="draft-field" />,
  );
}

describe('a confirmed AI draft', () => {
  it('names the model and the time the AI drafted', () => {
    const now = new Date('2026-11-26T12:00:00Z');
    expect(confirmedDraftLine(DRAFT, now)).toBe('Started from an AI draft (gpt-5.6-luna, 11:37 UTC).');
    expect(confirmedDraftLine({ ...DRAFT, model: '' }, now)).toBe('Started from an AI draft (11:37 UTC).');
    expect(confirmedDraftLine({ ...DRAFT, model: '', created_at: '' }, now)).toBe('Started from an AI draft.');
  });

  it('keeps one line and shows the original draft as plain text on request', () => {
    box(DRAFT);
    expect(screen.getByText(/^Started from an AI draft \(gpt-5\.6-luna, /)).toBeInTheDocument();
    // No longer offered as a draft to confirm.
    expect(screen.queryByRole('region', { name: 'AI draft note' })).toBeNull();
    const toggle = screen.getByRole('button', { name: CONFIRMED_DRAFT_SHOW });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const original = document.querySelector('[data-ai-draft-original]') as HTMLElement;
    expect(original).not.toBeVisible();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: CONFIRMED_DRAFT_HIDE })).toHaveAttribute('aria-expanded', 'true');
    expect(original).toBeVisible();
    expect(original.textContent).toBe(DRAFT.text);
    expect(document.querySelector('img')).toBeNull();
  });

  it('still offers a pending draft as before, and shows nothing without one', () => {
    box({ ...DRAFT, confirmed: false });
    expect(screen.getByRole('region', { name: 'AI draft note' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CONFIRMED_DRAFT_SHOW })).toBeNull();
  });

  it('shows nothing for a step without a draft', () => {
    const { container } = box(null);
    expect(container).toBeEmptyDOMElement();
  });
});
