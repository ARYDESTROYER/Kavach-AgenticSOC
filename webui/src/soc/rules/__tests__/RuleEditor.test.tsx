/**
 * RuleEditor spec (Round-5 G6 · R2) — the four-section (Define → About → Schedule →
 * Actions) shell with a Define tab POLYMORPHIC on the `RuleForm` union. Proves each of
 * the three tiers renders its tier-specific Define surface, and that the editor is a
 * config-writer (edits flow through `onChange`, never a decision).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/ui/tooltip';

import { RuleEditor } from '../RuleEditor';
import { newRuleForm } from '../constants';
import type { RuleForm } from '../types';

function renderEditor(value: RuleForm, extra?: Partial<React.ComponentProps<typeof RuleEditor>>) {
  const onChange = vi.fn();
  render(
    <TooltipProvider>
      <RuleEditor value={value} onChange={onChange} {...extra} />
    </TooltipProvider>,
  );
  return { onChange };
}

describe('RuleEditor — four-section shell', () => {
  it('always renders the four section tabs', () => {
    renderEditor(newRuleForm('detection_match'));
    expect(screen.getByRole('tab', { name: 'Define' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Actions' })).toBeInTheDocument();
  });
});

describe('RuleEditor — Define is polymorphic per tier', () => {
  it('detection_match renders the condition builder + threshold knobs', () => {
    const form = newRuleForm('detection_match') as Extract<RuleForm, { tier: 'detection_match' }>;
    form.predicates = [{ field: 'rule.id', op: 'equals', value: '5710' }];
    renderEditor(form);
    // condition builder present
    expect(screen.getByLabelText('Condition 1 field')).toBeInTheDocument();
    // threshold knobs present (labels from the Match Define surface)
    expect(screen.getByText('Trigger after N')).toBeInTheDocument();
    expect(screen.getByText('Within window')).toBeInTheDocument();
    // labelled as a threshold rule when n>1 (default n=5)
    expect(screen.getByText('Threshold rule')).toBeInTheDocument();
  });

  it('detection_anomaly renders the sensitivity/baseline surface', () => {
    renderEditor(newRuleForm('detection_anomaly'));
    expect(screen.getByText(/Anomaly rules are advisory/i)).toBeInTheDocument();
    expect(screen.getByText(/Sensitivity/i)).toBeInTheDocument();
    expect(screen.getByText('Warm-up multiplier')).toBeInTheDocument();
    // no condition builder for the anomaly tier
    expect(screen.queryByLabelText('Condition 1 field')).toBeNull();
  });

  it('case_automation renders the post-decision conditions + the "never sets status" guard', () => {
    renderEditor(newRuleForm('case_automation'));
    expect(screen.getByText(/never sets status/i)).toBeInTheDocument();
    // the verdict CONDITION dropdown exists (bug #6: only real Verdict values)
    expect(screen.getByText('When a case matches all of these')).toBeInTheDocument();
  });
});

describe('RuleEditor — config-writer behaviour', () => {
  it('toggling enabled flows through onChange (never a decision)', () => {
    const { onChange } = renderEditor(newRuleForm('detection_match'));
    fireEvent.click(screen.getByLabelText('Rule enabled'));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as RuleForm;
    expect(next.about.enabled).toBe(false);
  });

  it('read-only mode disables the enabled switch', () => {
    renderEditor(newRuleForm('detection_match'), { readOnly: true });
    expect(screen.getByLabelText('Rule enabled')).toBeDisabled();
  });

  it('a brand-new rule can switch tiers', () => {
    const onTierChange = vi.fn();
    renderEditor(newRuleForm('detection_match'), { allowTierChange: true, onTierChange });
    // the tier selector is present (aria-label "Rule type")
    expect(screen.getByLabelText('Rule type')).toBeInTheDocument();
  });

  it('offers only persisted, executable detection controls in the normal editor', async () => {
    const form = newRuleForm('detection_match') as Extract<RuleForm, { tier: 'detection_match' }>;
    // Compatibility metadata and an old multi-row draft may still arrive from another
    // client. The normal UI must preserve them through the adapter, not advertise them
    // as active controls.
    form.predicates = [
      { field: 'rule.id', op: 'equals', value: '5710' },
      { field: 'source.ip', op: 'equals', value: '10.0.0.1' },
    ];
    form.about.mitre = ['T1110'];
    form.suppression = { by: ['source.ip'], scope: 'per_run', missingField: 'suppress' };
    form.schedule = { intervalSeconds: 60, lookbackSeconds: 30 };
    renderEditor(form);

    expect(screen.queryByLabelText('Condition 2 field')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add condition/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/enable suppression/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'About' }));
    expect(screen.queryByText(/MITRE technique ids/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
    expect(screen.getByText('Cadence comes from the source feed.')).toBeInTheDocument();
    expect(screen.queryByText('Run every')).not.toBeInTheDocument();
    expect(screen.queryByText('Additional look-back')).not.toBeInTheDocument();
  });
});

describe('RuleEditor — case-automation About identity (#25)', () => {
  it('a NEW case-automation rule has an editable Name (becomes its id) and no dead Description', async () => {
    const { onChange } = renderEditor(newRuleForm('case_automation'), { allowTierChange: true });
    await userEvent.click(screen.getByRole('tab', { name: 'About' }));
    const name = screen.getByPlaceholderText('e.g. tag-confirmed-true-positives');
    fireEvent.change(name, { target: { value: 'tag-tps' } });
    expect(onChange).toHaveBeenCalled();
    // Description has no case-automation wire home → it is hidden (no dead field).
    expect(screen.queryByPlaceholderText('Optional context for the on-call analyst.')).toBeNull();
  });

  it('an EXISTING case-automation rule shows its id READ-ONLY, not a discarded Name input', async () => {
    const form = newRuleForm('case_automation') as Extract<RuleForm, { tier: 'case_automation' }>;
    form.about.name = 'rule-xyz';
    renderEditor(form); // no allowTierChange → edit mode
    await userEvent.click(screen.getByRole('tab', { name: 'About' }));
    const id = screen.getByDisplayValue('rule-xyz');
    expect(id).toBeDisabled();
    expect(screen.getByText('Identifier')).toBeInTheDocument();
    // no editable case-automation Name input in edit mode
    expect(screen.queryByPlaceholderText('e.g. tag-confirmed-true-positives')).toBeNull();
  });
});
