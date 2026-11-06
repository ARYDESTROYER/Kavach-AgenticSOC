/**
 * AnalystPolicyBuilder: the operator's "declared benign" editor.
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

  it('deletes a disabled declaration directly, since nothing is closing because of it', () => {
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
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText(/1 declaration · 0 live/)).toBeInTheDocument();
  });
});

describe('AnalystPolicyBuilder risk ceiling (Round 14, Y4)', () => {
  it('is a NumberField from 0 to 100 whose empty state means no ceiling', () => {
    wrap(<AnalystPolicyBuilder policies={[policy({ max_risk_score: null })]} onChange={vi.fn()} />);
    const field = screen.getByRole('spinbutton', { name: /max risk/i });
    expect(field).toHaveAttribute('aria-valuemin', '0');
    expect(field).toHaveAttribute('aria-valuemax', '100');
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', 'No ceiling');
    expect(document.querySelector('input[type="number"]')).toBeNull();
    // No ceiling set: nothing to clear.
    expect(screen.queryByRole('button', { name: /clear the risk ceiling/i })).toBeNull();
  });

  it('says in its help line that Clear removes a ceiling (an emptied field keeps it), and sizes from its range', () => {
    wrap(<AnalystPolicyBuilder policies={[policy({ max_risk_score: 60 })]} onChange={vi.fn()} />);
    const field = screen.getByRole('spinbutton', { name: /max risk/i });
    expect(field).toHaveAccessibleDescription(
      'Above this score the case is investigated instead of closed. With no value there is no ceiling; use Clear to remove one.',
    );
    expect(field).not.toHaveAccessibleDescription(/Empty means no ceiling/);
    // 0 to 100 fits the 8rem field (SPEC §4.9.2), not the full column.
    expect(field.closest('[data-number-field]')).toHaveAttribute('data-number-field', 'sm');
  });

  it('commits a typed ceiling clamped to the 0 to 100 range', () => {
    const onChange = vi.fn();
    wrap(<AnalystPolicyBuilder policies={[policy({ max_risk_score: null })]} onChange={onChange} />);
    const field = screen.getByRole('spinbutton', { name: /max risk/i });
    fireEvent.change(field, { target: { value: '140' } });
    fireEvent.blur(field);
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ max_risk_score: 100 })]);
  });

  it('keeps the ceiling when the field is emptied, and Clear removes it', () => {
    const onChange = vi.fn();
    wrap(<AnalystPolicyBuilder policies={[policy({ max_risk_score: 60 })]} onChange={onChange} />);
    const field = screen.getByRole('spinbutton', { name: /max risk/i });
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    // An emptied field is not a value: it never stores a ceiling of 0.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /clear the risk ceiling/i }));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ max_risk_score: null })]);
  });

  it('names the switch after the rule and uses sentence-case states without em dashes', () => {
    const { container } = wrap(
      <AnalystPolicyBuilder
        policies={[policy({ enabled: false, created_by: 'agent' })]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('switch', { name: 'Declaration for web_shell_php enabled' })).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('Drafted by the agent')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('\u2014');
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

describe('AnalystPolicyBuilder rows (Round 14, SPEC §4.9.6)', () => {
  it('lists declarations as hairline rows like the suppression rules beside them', () => {
    wrap(
      <AnalystPolicyBuilder
        policies={[policy(), policy({ id: 'arp-2', rule_id: 'dns_tunnel', enabled: false })]}
        onChange={vi.fn()}
      />,
    );
    const list = screen.getByRole('list', { name: 'Declarations' });
    expect(list).toHaveClass('divide-y');
    const rows = Array.from(list.querySelectorAll(':scope > li'));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.className).not.toMatch(/\bborder\b|\brounded-/);
    }
  });

  it('keeps the row glyph beside its text and names each field by its visible label', () => {
    wrap(<AnalystPolicyBuilder policies={[policy({ created_by: 'agent', enabled: false })]} onChange={vi.fn()} />);
    const text = screen.getByText('Close matching cases without a model call');
    const textLine = text.parentElement as HTMLElement;
    expect(textLine).toHaveClass('flex-wrap');
    expect(textLine).toContainElement(screen.getByText('Drafted by the agent'));
    const pair = textLine.parentElement as HTMLElement;
    expect(pair.className).not.toMatch(/\bflex-wrap\b/);
    expect(pair.querySelector(':scope > svg')).not.toBeNull();
    // Each field's name is its label (WCAG 2.5.3), not a different sentence.
    for (const name of ['Reason', 'Source (optional)', 'Expires (optional)']) {
      expect(screen.getByLabelText(name, { selector: 'input' })).not.toHaveAttribute('aria-label');
    }
  });
});
