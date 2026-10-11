/**
 * SegmentedControl — semantics spec (Round-6 #48). The control is a single-select
 * VALUE picker, so it must expose Radix RadioGroup semantics (role=radiogroup /
 * role=radio + aria-checked), NOT the old Tabs build which emitted role=tab plus an
 * `aria-controls` pointing at a `tabpanel` that never existed (a dangling reference).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SegmentedControl } from '../SegmentedControl';

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

describe('SegmentedControl — radiogroup semantics', () => {
  it('exposes role=radiogroup + role=radio, not a dangling role=tab', () => {
    render(
      <SegmentedControl aria-label="Pick one" value="a" onValueChange={() => {}} options={options} />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Pick one' })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute('aria-checked', 'true');
    // Neither a tab role nor a dangling aria-controls (the old defect) should remain.
    expect(screen.queryByRole('tab')).toBeNull();
    radios.forEach((r) => expect(r).not.toHaveAttribute('aria-controls'));
  });

  it('fires onValueChange with the picked value on click', async () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedControl aria-label="Pick one" value="a" onValueChange={onValueChange} options={options} />,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Beta' }));
    expect(onValueChange).toHaveBeenCalledWith('b');
  });

  it('passes a description through to the radio group', () => {
    render(
      <>
        <SegmentedControl aria-label="Pick one" aria-describedby="seg-help" value="a" onValueChange={() => {}} options={options} />
        <p id="seg-help">What each option means.</p>
      </>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Pick one' })).toHaveAccessibleDescription('What each option means.');
  });

  it('marks a disabled option as disabled', () => {
    render(
      <SegmentedControl
        aria-label="Pick one"
        value="a"
        onValueChange={() => {}}
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta', disabled: true },
        ]}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Beta' })).toBeDisabled();
  });
});
