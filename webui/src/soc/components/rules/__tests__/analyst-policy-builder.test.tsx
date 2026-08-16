/**
 * AnalystPolicyBuilder — the operator's "declared benign" editor.
 *
 * Before this component the whole feature was API-only: the schema describes
 * `analyst_rule_policies` as an array-of-model, and the generic Advanced form can only
 * DESCRIBE structured fields ("edit in its dedicated section") — a section that did not
 * exist. An operator could not see, review or revoke a declaration that closes cases
 * without a human, which for this feature is a governance gap, not a cosmetic one.
 *
 * The load-bearing rules pinned here:
 *   1. the consequence is stated in the operator's own words, not implied;
 *   2. a LIVE declaration routes deletion through the host's confirm dialog;
 *   3. an expired-but-enabled row does not read as active.
 */
import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';

import { AnalystPolicyBuilder, isLiveDeclaration } from '../AnalystPolicyBuilder';
import type { AnalystRulePolicyConfig } from '@/lib/types';

/** The editors use HelpTip/Tooltip internally; mirror `rules-editors.test.tsx`. */
function wrap(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const policy = (over: Partial<AnalystRulePolicyConfig> = {}): AnalystRulePolicyConfig => ({
  id: 'arp-1',
  rule_id: 'web_shell_php',
  reason: 'Internal PHP CI runner',
  enabled: true,
  source_id: null,
  ...over,
});

describe('AnalystPolicyBuilder', () => {
  it('states the consequence plainly instead of implying it', () => {
    wrap(<AnalystPolicyBuilder policies={[]} onChange={vi.fn()} />);
    expect(
      screen.getByText(/closes matching alerts with no model call and no human/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/genuine attack matching a declared rule closes silently/i))
      .toBeInTheDocument();
    // ...and points at the bounds that make it reversible.
    expect(screen.getByText(/risk ceiling/i)).toBeInTheDocument();
    expect(screen.getByText(/reinvestigating one always overrides/i)).toBeInTheDocument();
  });

  it('offers an empty state that says when NOT to use it', () => {
    wrap(<AnalystPolicyBuilder policies={[]} onChange={vi.fn()} />);
    expect(screen.getByText('No declarations')).toBeInTheDocument();
    expect(
      screen.getByText(/confirming more of its cases will not change the outcome/i),
    ).toBeInTheDocument();
  });

  it('adds a declaration through the host callback', () => {
    const onChange = vi.fn();
    wrap(<AnalystPolicyBuilder policies={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /declare a rule benign/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ rule_id: '', enabled: true, created_by: 'operator' });
  });

  it('routes deletion of a LIVE declaration through the host confirm dialog', () => {
    const onChange = vi.fn();
    const onRequestRemove = vi.fn();
    wrap(
      <AnalystPolicyBuilder
        policies={[policy()]}
        onChange={onChange}
        onRequestRemove={onRequestRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove declaration/i }));
    expect(onRequestRemove).toHaveBeenCalledWith(0, expect.objectContaining({ id: 'arp-1' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('deletes a disabled declaration directly — nothing is closing because of it', () => {
    const onChange = vi.fn();
    wrap(
      <AnalystPolicyBuilder
        policies={[policy({ enabled: false })]}
        onChange={onChange}
        onRequestRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove declaration/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('marks an expired declaration so it cannot read as active', () => {
    wrap(
      <AnalystPolicyBuilder
        policies={[policy({ expires_at: '2020-01-01T00:00:00Z' })]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('expired')).toBeInTheDocument();
    expect(screen.getByText(/1 declaration · 0 live/)).toBeInTheDocument();
  });
});

describe('isLiveDeclaration', () => {
  it('is live only when enabled and not past its expiry', () => {
    expect(isLiveDeclaration(policy())).toBe(true);
    expect(isLiveDeclaration(policy({ enabled: false }))).toBe(false);
    expect(isLiveDeclaration(policy({ expires_at: '2020-01-01T00:00:00Z' }))).toBe(false);
    expect(isLiveDeclaration(policy({ expires_at: '2999-01-01T00:00:00Z' }))).toBe(true);
    // An unparseable expiry must not silently disable a declaration the operator
    // believes is active — fail toward the state the row displays.
    expect(isLiveDeclaration(policy({ expires_at: 'not-a-date' }))).toBe(true);
  });
});
