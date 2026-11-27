/**
 * Rules editor components — net-new specs (G6 R4/R6).
 *
 * Covers the config-writer editors + shared threshold-UX primitives:
 *   - validateCidr sniff (accept/reject),
 *   - AssetCriticalityEditor add/edit/remove + NumberField clamp on criticality,
 *   - SlaPolicyEditor enable gate + target edit,
 *   - PriorityMatrixEditor cell edit + default,
 *   - SuppressionRuleBuilder add/edit/enable + delete confirm hook,
 *   - EffectiveConfigPreview below-floor copy (#4),
 *   - TunerSuggestionChip advisory apply.
 *
 * Every editor is a CONFIG WRITER — it emits config via `onChange` and never calls
 * `decide()` / sets a status / bills an LLM. Values render plain (#9).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

import {
  AssetCriticalityEditor,
  validateCidr,
  SlaPolicyEditor,
  PriorityMatrixEditor,
  SuppressionRuleBuilder,
  EffectiveConfigPreview,
  TunerSuggestionChip,
} from '../index';

function wrap(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

/* ── validateCidr ──────────────────────────────────────────────────────── */
describe('validateCidr', () => {
  it('accepts a well-formed IPv4 CIDR', () => {
    expect(validateCidr('10.0.0.0/8')).toBeNull();
    expect(validateCidr('192.168.1.0/24')).toBeNull();
  });
  it('rejects a missing prefix / bad octet / bad prefix', () => {
    expect(validateCidr('10.0.0.0')).toBeTruthy();
    expect(validateCidr('999.0.0.0/8')).toBeTruthy();
    expect(validateCidr('10.0.0.0/40')).toBeTruthy();
    expect(validateCidr('')).toBeTruthy();
  });
  it('accepts an IPv6 CIDR', () => {
    expect(validateCidr('2001:db8::/32')).toBeNull();
    expect(validateCidr('fe80::/200')).toBeTruthy();
  });
  it('says each range in plain words, with no dashes', () => {
    expect(validateCidr('10.0.0.0')).toBe('Include a prefix length, for example 10.0.0.0/8.');
    expect(validateCidr('999.0.0.0/8')).toBe('Each IPv4 octet must be 0 to 255.');
    expect(validateCidr('10.0.0.0/40')).toBe('IPv4 prefix must be 0 to 32.');
    expect(validateCidr('fe80::/200')).toBe('IPv6 prefix must be 0 to 128.');
  });
});

/* ── AssetCriticalityEditor ────────────────────────────────────────────── */
describe('AssetCriticalityEditor', () => {
  function renderEditor(over: Partial<React.ComponentProps<typeof AssetCriticalityEditor>> = {}) {
    const onNetworksChange = vi.fn();
    const onExactChange = vi.fn();
    wrap(
      <AssetCriticalityEditor
        networks={over.networks ?? []}
        exact={over.exact ?? {}}
        onNetworksChange={over.onNetworksChange ?? onNetworksChange}
        onExactChange={over.onExactChange ?? onExactChange}
      />,
    );
    return { onNetworksChange, onExactChange };
  }

  it('adds a CIDR network with a default criticality', () => {
    const { onNetworksChange } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /add network/i }));
    expect(onNetworksChange).toHaveBeenCalledWith([{ cidr: '', criticality: 50 }]);
  });

  it('surfaces a validation error for a malformed CIDR (plain text, #9)', () => {
    renderEditor({ networks: [{ cidr: 'nope', criticality: 50 }] });
    // The row shows the inline validation message.
    expect(screen.getByText(/prefix length/i)).toBeInTheDocument();
  });

  it('clamps an over-max criticality on the network NumberField (blur)', () => {
    const onNetworksChange = vi.fn();
    renderEditor({ networks: [{ cidr: '10.0.0.0/8', criticality: 50 }], onNetworksChange });
    const input = screen.getAllByLabelText('Criticality')[0] as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.blur(input, { target: { value: '9999' } });
    expect(onNetworksChange).toHaveBeenCalledWith([{ cidr: '10.0.0.0/8', criticality: 100 }]);
  });

  it('removes a network', () => {
    const onNetworksChange = vi.fn();
    renderEditor({ networks: [{ cidr: '10.0.0.0/8', criticality: 50 }], onNetworksChange });
    fireEvent.click(screen.getByRole('button', { name: /remove network/i }));
    expect(onNetworksChange).toHaveBeenCalledWith([]);
  });

  it('edits the exact-value criticality map without dropping the key', () => {
    const onExactChange = vi.fn();
    renderEditor({ exact: { 'db-prod-01': 80 }, onExactChange });
    const input = screen.getByDisplayValue('db-prod-01');
    fireEvent.change(input, { target: { value: 'db-prod-02' } });
    expect(onExactChange).toHaveBeenCalledWith({ 'db-prod-02': 80 });
  });

  it('"Add asset" renders a real, typeable empty row instead of a no-op (#34)', () => {
    const onExactChange = vi.fn();
    renderEditor({ exact: {}, onExactChange });
    fireEvent.click(screen.getByRole('button', { name: /add asset/i }));
    // A new empty entity input appears (the row is not folded away before render).
    const inputs = screen.getAllByLabelText('Asset entity value');
    expect(inputs).toHaveLength(1);
    // Typing into it folds the new key (default criticality 50) into the wire map.
    fireEvent.change(inputs[0], { target: { value: 'db-01' } });
    expect(onExactChange).toHaveBeenCalledWith({ 'db-01': 50 });
  });

  it('clearing an entity to retype it keeps the row instead of deleting it (#34)', () => {
    const onExactChange = vi.fn();
    renderEditor({ exact: { 'db-01': 80 }, onExactChange });
    fireEvent.change(screen.getByDisplayValue('db-01'), { target: { value: '' } });
    // The row survives the transient empty value; the folded map just drops the empty key.
    expect(screen.getByLabelText('Asset entity value')).toBeInTheDocument();
    expect(onExactChange).toHaveBeenLastCalledWith({});
  });
});

/* ── SlaPolicyEditor ───────────────────────────────────────────────────── */
describe('SlaPolicyEditor', () => {
  it('toggles enabled and disables the target fields when off', () => {
    const onChange = vi.fn();
    wrap(<SlaPolicyEditor policy={{ enabled: false }} onChange={onChange} />);
    // The enable switch flips enabled.
    fireEvent.click(screen.getByLabelText(/enable sla tracking/i));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    // While disabled, a response-target input is disabled.
    const responseInputs = screen.getAllByLabelText('Response target');
    expect((responseInputs[0] as HTMLInputElement).disabled).toBe(true);
  });

  it('shows per-level defaults that mirror the backend (P1 15/240 … P4 480/4320), not a flat 60/1440', () => {
    wrap(<SlaPolicyEditor policy={{ enabled: true }} onChange={vi.fn()} />);
    const response = screen.getAllByLabelText('Response target') as HTMLInputElement[];
    const resolve = screen.getAllByLabelText('Resolution target') as HTMLInputElement[];
    // Descending per-level defaults, not a single flat fallback.
    expect(response.map((i) => i.value)).toEqual(['15', '30', '120', '480']);
    expect(resolve.map((i) => i.value)).toEqual(['240', '480', '1440', '4320']);
  });

  it('edits a P1 response target when enabled', () => {
    const onChange = vi.fn();
    wrap(<SlaPolicyEditor policy={{ enabled: true, targets: { P1: { response_minutes: 15 } } }} onChange={onChange} />);
    const input = screen.getAllByLabelText('Response target')[0] as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.blur(input, { target: { value: '20' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: expect.objectContaining({ P1: expect.objectContaining({ response_minutes: 20 }) }),
      }),
    );
  });
});

/* ── PriorityMatrixEditor ──────────────────────────────────────────────── */
describe('PriorityMatrixEditor', () => {
  it('renders a labelled cell for every impact/urgency pair', () => {
    wrap(<PriorityMatrixEditor matrix={{ enabled: true }} onChange={vi.fn()} />);
    // 3x3 default grid → 9 cell selects, all labelled for a11y.
    expect(
      screen.getByRole('combobox', { name: /high impact, high urgency/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: /low impact, low urgency/i }),
    ).toBeInTheDocument();
  });

  it('toggles enable', () => {
    const onChange = vi.fn();
    wrap(<PriorityMatrixEditor matrix={{ enabled: false }} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/enable priority derivation/i));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('shows the advisory note by default and drops it with intro={false} (D26)', () => {
    const { unmount } = wrap(<PriorityMatrixEditor matrix={{ enabled: true }} onChange={vi.fn()} />);
    expect(screen.getByText('Priority is advisory')).toBeInTheDocument();
    unmount();
    wrap(<PriorityMatrixEditor intro={false} matrix={{ enabled: true }} onChange={vi.fn()} />);
    expect(screen.queryByText('Priority is advisory')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // The grid is still all there.
    expect(screen.getByRole('combobox', { name: /high impact, high urgency/i })).toBeInTheDocument();
    // The corner header reads as words, not arrows.
    expect(screen.getByRole('columnheader', { name: 'Impact by urgency' })).toBeInTheDocument();
  });
});

/* ── SuppressionRuleBuilder ────────────────────────────────────────────── */
describe('SuppressionRuleBuilder', () => {
  it('adds an operator-stamped rule', () => {
    const onChange = vi.fn();
    wrap(<SuppressionRuleBuilder rules={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /add rule/i }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ field: '', value: '', enabled: true, created_by: 'operator' }),
    ]);
  });

  it('routes a live-rule delete through onRequestRemove (host confirm)', () => {
    const onChange = vi.fn();
    const onRequestRemove = vi.fn();
    wrap(
      <SuppressionRuleBuilder
        rules={[{ field: 'rule.name', value: 'scanner', enabled: true }]}
        onChange={onChange}
        onRequestRemove={onRequestRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove suppression rule/i }));
    // A live rule is NOT removed directly — it asks the host to confirm.
    expect(onRequestRemove).toHaveBeenCalledWith(0, expect.objectContaining({ value: 'scanner' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a disabled rule directly (no confirm needed)', () => {
    const onChange = vi.fn();
    const onRequestRemove = vi.fn();
    wrap(
      <SuppressionRuleBuilder
        rules={[{ field: 'rule.name', value: 'x', enabled: false }]}
        onChange={onChange}
        onRequestRemove={onRequestRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove suppression rule/i }));
    expect(onChange).toHaveBeenCalledWith([]);
    expect(onRequestRemove).not.toHaveBeenCalled();
  });

  it('renders an agent-drafted rule value as plain text (#9)', () => {
    wrap(
      <SuppressionRuleBuilder
        rules={[{ field: 'user.name', value: '<script>alert(1)</script>', created_by: 'agent', enabled: true }]}
        onChange={vi.fn()}
      />,
    );
    // The attacker-influenceable value is rendered inertly as an input value, not markup.
    expect(screen.getByDisplayValue('<script>alert(1)</script>')).toBeInTheDocument();
    expect(screen.getByText('Drafted by the agent')).toBeInTheDocument();
  });

  it('lists rules as hairline rows, never a bordered box per rule (Round 14)', () => {
    wrap(
      <SuppressionRuleBuilder
        rules={[
          { field: 'rule.name', value: 'scanner', enabled: true },
          { field: 'source.ip', value: '10.0.0.5', enabled: false },
        ]}
        onChange={vi.fn()}
      />,
    );
    const list = screen.getByRole('list', { name: 'Suppression rules' });
    expect(list).toHaveClass('divide-y');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.className).not.toMatch(/\bborder\b|\brounded-/);
    }
    // States in sentence case: the switch names its rule, the off rule says "Off".
    expect(screen.getByRole('switch', { name: 'Suppression rule for rule.name enabled' })).toBeChecked();
    expect(within(rows[1]).getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('2 suppression rules')).toBeInTheDocument();
  });

  it('labels every field visibly, like the declarations beside it, and names each by its label', () => {
    wrap(
      <SuppressionRuleBuilder
        rules={[{ field: 'rule.name', value: 'scanner', reason: 'Lab scanner', created_by: 'operator', enabled: true }]}
        onChange={vi.fn()}
      />,
    );
    // A placeholder is not a label (WCAG 3.3.2): each label is on screen, not sr-only.
    for (const name of ['Field', 'Value', 'Reason', 'Expires (optional)']) {
      const input = screen.getByLabelText(name, { selector: 'input' });
      // The label is the name: no aria-label that says something else (WCAG 2.5.3).
      expect(input).not.toHaveAttribute('aria-label');
      const label = document.querySelector(`label[for="${input.id}"]`) as HTMLElement;
      expect(label).toHaveTextContent(name);
      expect(label.className).not.toMatch(/\bsr-only\b/);
    }
    expect(screen.getByLabelText('Expires (optional)')).toHaveAttribute('type', 'date');
    // The provenance reads in sentence case, as "Declared by operator" does.
    expect(screen.getByText('Created by operator')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/[\u2013\u2014]/);
  });

  it('keeps the row glyph beside its text; only the badges wrap', () => {
    wrap(
      <SuppressionRuleBuilder
        rules={[{ field: 'user.name', value: 'svc', created_by: 'agent', enabled: false }]}
        onChange={vi.fn()}
      />,
    );
    const text = screen.getByText('Drop matching events');
    const textLine = text.parentElement as HTMLElement;
    expect(textLine).toHaveClass('flex-wrap');
    expect(textLine).toContainElement(screen.getByText('Drafted by the agent'));
    // The glyph and the wrapping line sit in a pair that never wraps.
    const pair = textLine.parentElement as HTMLElement;
    expect(pair.className).not.toMatch(/\bflex-wrap\b/);
    expect(pair.querySelector(':scope > svg')).not.toBeNull();
  });

  it('shows the standing warning by default and drops it with intro={false} (D26)', () => {
    const { unmount } = wrap(<SuppressionRuleBuilder rules={[]} onChange={vi.fn()} />);
    expect(screen.getByText('Suppression drops events before triage')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/[\u2013\u2014]/);
    unmount();
    wrap(<SuppressionRuleBuilder intro={false} rules={[]} onChange={vi.fn()} />);
    expect(screen.queryByText('Suppression drops events before triage')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // The list itself stays: the count, Add rule and the empty state.
    expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument();
    expect(screen.getByText('No suppression rules')).toBeInTheDocument();
  });
});

/* ── EffectiveConfigPreview ────────────────────────────────────────────── */
describe('EffectiveConfigPreview', () => {
  it('renders the #4 non-destructive below-floor note by default', () => {
    wrap(<EffectiveConfigPreview summary="Auto-forward clusters of >= 5 events" />);
    expect(screen.getByText(/candidate only — never dropped/i)).toBeInTheDocument();
  });

  it('omits the note when belowFloorNote is false', () => {
    wrap(<EffectiveConfigPreview summary="hi" belowFloorNote={false} />);
    expect(screen.queryByText(/never dropped/i)).not.toBeInTheDocument();
  });
});

/* ── TunerSuggestionChip ───────────────────────────────────────────────── */
describe('TunerSuggestionChip', () => {
  it('applies the suggestion locally (advisory only)', () => {
    const onApply = vi.fn();
    wrap(<TunerSuggestionChip current={3} suggested={4} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: /apply tuner suggestion 4/i }));
    expect(onApply).toHaveBeenCalledWith(4);
  });

  it('renders nothing when the suggestion equals the current value', () => {
    const { container } = wrap(<TunerSuggestionChip current={4} suggested={4} onApply={vi.fn()} />);
    expect(within(container).queryByText(/tuner suggests/i)).not.toBeInTheDocument();
  });

  it('renders nothing when there is no suggestion', () => {
    const { container } = wrap(<TunerSuggestionChip current={4} suggested={null} onApply={vi.fn()} />);
    expect(within(container).queryByText(/tuner suggests/i)).not.toBeInTheDocument();
  });
});
