/**
 * Knowledge settings — the LOWER-TRUST unconfirmed precedent tier.
 *
 * A fully autonomous deployment produces no analyst-confirmed outcomes, so its precedent
 * corpus is permanently empty. The escape hatch is a SEPARATE, explicitly weaker tier
 * (the agent's own auto-closed verdicts), never a loosening of the analyst-confirmed
 * gate. That distinction has to be visible in the UI or the option is a trap, so this
 * spec pins:
 *
 *   (a) the tier is labelled lower-trust, off by default, and described as PRIOR MODEL
 *       JUDGEMENTS rather than analyst decisions;
 *   (b) the switch writes `rag.use_unconfirmed_resolved_cases` (nothing else);
 *   (c) it is a sub-tier — unavailable while `rag.use_resolved_cases` (or RAG) is off;
 *   (d) each guard writes into `rag.unconfirmed_precedent` and is inert while the tier
 *       is off.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences, RagConfig } from '@/lib/types';

import { KnowledgeSection } from '../knowledge';

function prefsWith(rag: RagConfig): Preferences {
  return { rag } as unknown as Preferences;
}

function renderSection(rag: RagConfig = { enabled: true, use_resolved_cases: true }) {
  const update = vi.fn<[Partial<Preferences>], void>();
  const utils = render(
    <TooltipProvider>
      <KnowledgeSection prefs={prefsWith(rag)} update={update} />
    </TooltipProvider>,
  );
  return { update, ...utils };
}

const SWITCH_LABEL = 'Learn from unreviewed agent closes';

describe('Knowledge settings — unconfirmed precedent tier', () => {
  it('labels the tier as lower-trust, off by default, and sourced from model judgements', () => {
    renderSection();

    expect(screen.getByText('Unconfirmed precedent (lower trust)')).toBeInTheDocument();
    expect(screen.getByText('Lower trust')).toBeInTheDocument();
    // Scoped to THIS card: the analyst-precedent promotion card on the same page is
    // also (correctly) badged "Off by default", so a page-wide query would now match
    // two and stop testing the tier it is named for.
    const tierCard = screen
      .getByText('Unconfirmed precedent (lower trust)')
      .closest('section, article, div[class*="rounded"]') as HTMLElement;
    expect(within(tierCard).getByText('Off by default')).toBeInTheDocument();
    expect(screen.getByText('its own prior model judgements')).toBeInTheDocument();
    expect(screen.getByText('analyst-confirmed outcomes only')).toBeInTheDocument();

    const toggle = screen.getByRole('switch', { name: SWITCH_LABEL });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('writes only rag.use_unconfirmed_resolved_cases when enabled', () => {
    const { update } = renderSection();

    fireEvent.click(screen.getByRole('switch', { name: SWITCH_LABEL }));

    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as { rag: RagConfig };
    expect(patch.rag.use_unconfirmed_resolved_cases).toBe(true);
    // A sub-tier — it must never silently flip the confirmed source it depends on.
    expect(patch.rag.use_resolved_cases).toBe(true);
  });

  it('is unavailable while the resolved-case precedent source is off', () => {
    renderSection({ enabled: true, use_resolved_cases: false });

    expect(screen.getByRole('switch', { name: SWITCH_LABEL })).toBeDisabled();
    expect(
      screen.getByText(/Requires retrieval and the resolved-case precedent source above/),
    ).toBeInTheDocument();
  });

  it('is unavailable while retrieval itself is off', () => {
    renderSection({ enabled: false, use_resolved_cases: true });

    expect(screen.getByRole('switch', { name: SWITCH_LABEL })).toBeDisabled();
  });

  it('edits each guard into rag.unconfirmed_precedent and keeps them inert while off', () => {
    const { update, unmount } = renderSection({
      enabled: true,
      use_resolved_cases: true,
      use_unconfirmed_resolved_cases: true,
      unconfirmed_precedent: { min_recurrence: 3, max_age_days: 30 },
    });

    const recurrence = screen.getByLabelText('Minimum recurrence');
    expect(recurrence).not.toBeDisabled();
    fireEvent.change(recurrence, { target: { value: '5' } });
    fireEvent.blur(recurrence);

    const patch = update.mock.calls.at(-1)?.[0] as { rag: RagConfig };
    expect(patch.rag.unconfirmed_precedent).toMatchObject({ min_recurrence: 5, max_age_days: 30 });
    unmount();

    // Tier off → the guards are visible (so the operator can see the bounds) but inert.
    renderSection({ enabled: true, use_resolved_cases: true });
    expect(screen.getByLabelText('Minimum recurrence')).toBeDisabled();
    expect(screen.getByLabelText('Maximum context share')).toBeDisabled();
  });

  it('shows the backend guard defaults when the operator has never set them', () => {
    renderSection({
      enabled: true,
      use_resolved_cases: true,
      use_unconfirmed_resolved_cases: true,
    });

    expect(screen.getByLabelText('Minimum model confidence')).toHaveValue(0.8);
    expect(screen.getByLabelText('Minimum recurrence')).toHaveValue(3);
    expect(screen.getByLabelText('Age-out (days)')).toHaveValue(30);
    expect(screen.getByLabelText('Maximum context share')).toHaveValue(0.34);
    expect(screen.getByLabelText('Rank penalty')).toHaveValue(0.5);
    expect(screen.getByLabelText('Maximum items')).toHaveValue(50);
  });
});
