/**
 * Round-5 R1 — the auto-close dead-field bug fix (PROPOSAL bug #1).
 *
 * The OLD `AutonomyControls` bound `prefs.fp_auto_close`, but `decide()`
 * (case_manager.py) reads `prefs.auto_close` — so the flagship autonomy toggle wrote a
 * field the engine never consults and DID NOTHING. This spec proves the fix:
 *
 *   (a) editing the auto-close controls writes `prefs.auto_close.<verdict>` (the field
 *       `decide()` actually reads) — the FP + TP switches, the confidence slider, and
 *       the risk / objection-window number fields all patch `auto_close`;
 *   (b) NO edit ever writes the dead `fp_auto_close` key (regression guard for #1);
 *   (c) TRUE_POSITIVE auto-close is an opt-in, OFF by default;
 *   (d) NEEDS_HUMAN is a LOCKED, read-only row — there is no editable toggle for it
 *       (code-enforced never-auto-close, #3).
 *
 * Companion proof that `decide()` actually ACTS on the new value lives in the backend
 * pytest `backend/tests/test_round5_r1_auto_close_field.py` (via the pure `decide()` +
 * the `POST /api/triage/preview-decision` wrapper).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences } from '@/lib/types';

import { DetectionSection } from '../detection';

/** A minimal Preferences with a live `auto_close` policy (the field decide() reads). */
function basePrefs(): Preferences {
  return {
    auto_close: {
      false_positive: { enabled: false, min_confidence: 0.85, max_risk_score: 30, objection_window_minutes: 1440 },
      true_positive: { enabled: false, min_confidence: 0.95, max_risk_score: 10, objection_window_minutes: 4320 },
    },
  } as unknown as Preferences;
}

function renderSection(prefs: Preferences = basePrefs()) {
  const update = vi.fn<[Partial<Preferences>], void>();
  const utils = render(
    <TooltipProvider>
      <DetectionSection prefs={prefs} update={update} />
    </TooltipProvider>,
  );
  return { update, prefs, ...utils };
}

/** Merge every patch seen by `update` into one object (the effective PUT the page sends). */
function mergedPatch(update: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return update.mock.calls.reduce<Record<string, unknown>>((acc, [p]) => ({ ...acc, ...p }), {});
}

describe('R1 — auto-close editor writes prefs.auto_close (the field decide() reads)', () => {
  it('toggling "Auto-close confident false positives" patches auto_close.false_positive.enabled', () => {
    const { update } = renderSection();
    const sw = screen.getByRole('switch', { name: /auto-close confident false positives/i });
    fireEvent.click(sw);

    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as { auto_close?: { false_positive?: { enabled?: boolean } } };
    // The patch targets `auto_close` — NOT the dead `fp_auto_close`.
    expect(patch).toHaveProperty('auto_close');
    expect('fp_auto_close' in patch).toBe(false);
    expect(patch.auto_close?.false_positive?.enabled).toBe(true);
  });

  it('never writes the dead `fp_auto_close` key across a full edit sweep (regression #1)', () => {
    const { update } = renderSection();

    // Flip both verdict switches.
    fireEvent.click(screen.getByRole('switch', { name: /auto-close confident false positives/i }));
    fireEvent.click(screen.getByRole('switch', { name: /auto-close confident true positives/i }));

    const patch = mergedPatch(update);
    expect('fp_auto_close' in patch).toBe(false);
    expect(patch).toHaveProperty('auto_close');
  });

  it('renders the TP editor with auto-close OFF by default (opt-in)', () => {
    renderSection();
    const tpSwitch = screen.getByRole('switch', { name: /auto-close confident true positives/i });
    // aria-checked reflects the controlled state; defaults OFF.
    expect(tpSwitch).toHaveAttribute('aria-checked', 'false');
  });

  it('toggling the TP switch patches auto_close.true_positive.enabled', () => {
    const { update } = renderSection();
    fireEvent.click(screen.getByRole('switch', { name: /auto-close confident true positives/i }));
    const patch = update.mock.calls[0][0] as { auto_close?: { true_positive?: { enabled?: boolean } } };
    expect(patch.auto_close?.true_positive?.enabled).toBe(true);
    expect('fp_auto_close' in patch).toBe(false);
  });

  it('editing the max-risk NumberField patches auto_close.false_positive.max_risk_score', () => {
    // Start with FP enabled so the number field is not disabled. (Both the FP and TP
    // sub-editors render a same-named field — scope to the enabled FP one, which is the
    // only non-disabled match.)
    const prefs = basePrefs();
    (prefs as unknown as { auto_close: { false_positive: { enabled: boolean } } }).auto_close.false_positive.enabled = true;
    const { update } = renderSection(prefs);

    const inputs = screen.getAllByLabelText(/maximum risk score to auto-close/i) as HTMLInputElement[];
    const input = inputs.find((el) => !el.disabled);
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { value: '12' } });
    fireEvent.blur(input!);

    const patch = mergedPatch(update);
    const ac = patch.auto_close as { false_positive?: { max_risk_score?: number } } | undefined;
    expect(ac?.false_positive?.max_risk_score).toBe(12);
    expect('fp_auto_close' in patch).toBe(false);
  });

  it('NEEDS_HUMAN is a locked, read-only row, with no editable toggle for it', () => {
    renderSection();
    // There is a locked status row in its own Needs human group (named by its h3, with no
    // aria-label on a generic div, which assistive technology ignores)…
    const locked = screen.getByRole('group', { name: 'Needs human' });
    expect(within(locked).getByText('Cases that need a person')).toBeInTheDocument();
    expect(within(locked).getByText(/locked: never auto-closes/i)).toBeInTheDocument();
    expect(document.querySelector('div[aria-label]:not([role])')).toBeNull();
    // …and there is NO switch offering to auto-close needs-human.
    expect(
      screen.queryByRole('switch', { name: /auto-close confident needs.?human/i }),
    ).toBeNull();
    // Exactly two auto-close switches exist (FP + TP) — never a third for needs_human.
    // (Round 14: each switch is named by its row label, not an aria-label.)
    const switches = screen.getAllByRole('switch', { name: /auto-close confident/i });
    expect(switches).toHaveLength(2);
  });
});

describe('auto-close fields: an emptied field is no value (empty="keep")', () => {
  // Committing the field's minimum instead would silently loosen the policy: a bar of 0%
  // auto-closes at any confidence, and an objection window of 0 closes at once.
  const enabledPrefs = (): Preferences =>
    ({
      auto_close: {
        false_positive: { enabled: true, min_confidence: 0.85, max_risk_score: 30, objection_window_minutes: 1440 },
        true_positive: { enabled: false, min_confidence: 0.95, max_risk_score: 10, objection_window_minutes: 4320 },
      },
    }) as unknown as Preferences;

  it.each([
    ['Minimum confidence to auto-close', '85'],
    ['Maximum risk score to auto-close', '30'],
    ['Objection window', '1440'],
  ])('clearing "%s" and leaving it commits nothing and shows %s again', (label, shown) => {
    const { update } = renderSection(enabledPrefs());
    const group = screen.getByRole('group', { name: 'False positive auto-close' });
    const field = within(group).getByLabelText(label) as HTMLInputElement;
    expect(field.value).toBe(shown);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(update).not.toHaveBeenCalled();
    expect(field.value).toBe(shown);
  });

  it('reads the objection window in hours or days', () => {
    renderSection(enabledPrefs());
    const fp = screen.getByRole('group', { name: 'False positive auto-close' });
    expect(within(fp).getByLabelText('Objection window')).toHaveAccessibleDescription(/\(24 hours\)\.$/);
    const tp = screen.getByRole('group', { name: 'True positive auto-close' });
    expect(within(tp).getByLabelText('Objection window')).toHaveAccessibleDescription(/\(3 days\)\.$/);
  });
});

