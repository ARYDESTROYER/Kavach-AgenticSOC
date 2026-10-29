/**
 * Round-6 — the "SLA, priority & suppression" settings section (mounts the orphaned G6
 * config editors: SlaPolicyEditor / PriorityMatrixEditor / SuppressionRuleBuilder).
 *
 * This section is the previously-missing UI mount point (PROPOSAL §G6 R5). The spec proves:
 *   (a) all three editors render;
 *   (b) each writes its OWN Preferences block through the shared deep-merge `update`
 *       buffer — SLA → `sla`, priority → `priority_matrix`, suppression → `suppression_rules`
 *       — and NEVER `decide()` / a case status (#3);
 *   (c) deleting a LIVE suppression rule routes through the ConfirmDialog (it can hide
 *       events), and confirming filters it out of `suppression_rules`;
 *   (d) Round 14 (SPEC §4.9.6): the SLA policy is one panel with a row per priority
 *       ("P1 Critical", respond and resolve minutes), the backend defaults when a target is
 *       absent, and an edit to one target keeps the others.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences, SuppressionRuleConfig } from '@/lib/types';

import { CasePolicySection } from '../case-policy';

function renderSection(prefs: Partial<Preferences> = {}) {
  const update = vi.fn<[Partial<Preferences>], void>();
  const utils = render(
    <TooltipProvider>
      <CasePolicySection prefs={prefs as Preferences} update={update} />
    </TooltipProvider>,
  );
  return { update, ...utils };
}

const LIVE_RULE: SuppressionRuleConfig = {
  field: 'rule.name',
  value: 'known-benign-scan',
  reason: 'benign',
  enabled: true,
  created_by: 'operator',
};

describe('CasePolicySection — mounts the orphaned G6 editors', () => {
  it('renders all three editors', () => {
    renderSection({ sla: {}, priority_matrix: {}, suppression_rules: [] });
    expect(screen.getByRole('switch', { name: /^sla tracking$/i })).toBeTruthy();
    expect(screen.getByRole('switch', { name: /enable priority derivation/i })).toBeTruthy();
    // The suppression builder's add affordance.
    expect(screen.getByRole('button', { name: /add rule/i })).toBeTruthy();
  });

  it('the SLA editor writes prefs.sla', () => {
    const { update } = renderSection({ sla: {} });
    fireEvent.click(screen.getByRole('switch', { name: /^sla tracking$/i }));
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as { sla?: { enabled?: boolean } };
    expect(patch).toHaveProperty('sla');
    expect(patch.sla?.enabled).toBe(true);
  });

  it('the priority-matrix editor writes prefs.priority_matrix', () => {
    const { update } = renderSection({ priority_matrix: {} });
    fireEvent.click(screen.getByRole('switch', { name: /enable priority derivation/i }));
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as { priority_matrix?: { enabled?: boolean } };
    expect(patch).toHaveProperty('priority_matrix');
    expect(patch.priority_matrix?.enabled).toBe(true);
  });

  it('the suppression builder adds an operator rule to prefs.suppression_rules', () => {
    const { update } = renderSection({ suppression_rules: [] });
    fireEvent.click(screen.getByRole('button', { name: /add rule/i }));
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as { suppression_rules?: SuppressionRuleConfig[] };
    expect(patch.suppression_rules).toHaveLength(1);
    // A fresh operator rule is provenance-stamped, enabled.
    expect(patch.suppression_rules?.[0].created_by).toBe('operator');
  });

  it('deleting a LIVE suppression rule confirms first, then filters it out', () => {
    const { update } = renderSection({ suppression_rules: [LIVE_RULE] });
    // Removing a live rule opens the ConfirmDialog rather than deleting immediately.
    fireEvent.click(screen.getByRole('button', { name: /remove suppression rule/i }));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText(/delete this suppression rule/i)).toBeTruthy();

    // Confirm → the rule is filtered out via the deep-merge `update` buffer (#3-safe).
    fireEvent.click(screen.getByRole('button', { name: /^delete rule$/i }));
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as { suppression_rules?: SuppressionRuleConfig[] };
    expect(patch.suppression_rules).toEqual([]);
  });

  it('shows one SLA row per priority with the backend defaults, and edits one target', () => {
    const { update } = renderSection({
      sla: { enabled: true, targets: { P2: { response_minutes: 45, resolve_minutes: 600 } } },
    } as Partial<Preferences>);
    const rows = document.querySelectorAll('[data-sla-level]');
    expect([...rows].map((r) => r.getAttribute('data-sla-level'))).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(screen.getByText('P1 Critical')).toBeInTheDocument();
    // The help line reads the minutes as people say them (SPEC §4.9.5).
    expect(screen.getByText('Respond within 15 minutes, resolve within 4 hours.')).toBeInTheDocument();
    expect(screen.getByText('Respond within 45 minutes, resolve within 10 hours.')).toBeInTheDocument();
    const p1 = rows[0] as HTMLElement;
    const respond = within(p1).getByLabelText(/Respond/) as HTMLInputElement;
    expect(respond.value).toBe('15');
    fireEvent.focus(respond);
    fireEvent.change(respond, { target: { value: '20' } });
    fireEvent.blur(respond);
    const patch = update.mock.calls.at(-1)?.[0] as Partial<Preferences>;
    expect(patch.sla?.targets?.P1?.response_minutes).toBe(20);
    // The other priorities keep what was stored.
    expect(patch.sla?.targets?.P2).toEqual({ response_minutes: 45, resolve_minutes: 600 });
  });

  it('keeps an SLA target when its field is emptied (never 0, which breaches every case)', () => {
    const { update } = renderSection({ sla: { enabled: true } } as Partial<Preferences>);
    const p1 = document.querySelector('[data-sla-level="P1"]') as HTMLElement;
    for (const [name, shown] of [[/Respond/, '15'], [/Resolve/, '240']] as const) {
      const field = within(p1).getByLabelText(name) as HTMLInputElement;
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: '' } });
      fireEvent.blur(field);
      expect(field.value).toBe(shown);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps the SLA rows read-only while tracking is off', () => {
    renderSection({ sla: { enabled: false } } as Partial<Preferences>);
    const p1 = document.querySelector('[data-sla-level="P1"]') as HTMLElement;
    expect(within(p1).getByLabelText(/Respond/)).toBeDisabled();
  });
});
