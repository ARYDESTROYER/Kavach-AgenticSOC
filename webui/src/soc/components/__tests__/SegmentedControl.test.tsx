/**
 * SegmentedControl — semantics spec (Round-6 #48). The control is a single-select
 * VALUE picker, so it must expose Radix RadioGroup semantics (role=radiogroup /
 * role=radio + aria-checked), NOT the old Tabs build which emitted role=tab plus an
 * `aria-controls` pointing at a `tabpanel` that never existed (a dangling reference).
 */
import * as React from 'react';
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

  // Radix moves focus on the arrow key (and checks the option it lands on while the key
  // is held, which jsdom's synchronous keyup cannot show): the tests follow focus.
  it('moves with Left/Right only by default (one row: Down is not "next")', async () => {
    const user = userEvent.setup();
    render(<SegmentedControl aria-label="Pick one" value="a" onValueChange={() => {}} options={options} />);
    expect(screen.getByRole('radiogroup', { name: 'Pick one' })).toHaveAttribute('aria-orientation', 'horizontal');
    await user.click(screen.getByRole('radio', { name: 'Alpha' }));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveFocus();
  });

  it('moves with every arrow key when its options wrap into rows (orientation "both")', async () => {
    const user = userEvent.setup();
    const Harness = () => {
      const [value, setValue] = React.useState('a');
      return (
        <SegmentedControl aria-label="Pick one" orientation="both" value={value} onValueChange={setValue} options={options} />
      );
    };
    render(<Harness />);
    // No single orientation is announced for a wrapped group.
    expect(screen.getByRole('radiogroup', { name: 'Pick one' })).not.toHaveAttribute('aria-orientation');
    await user.click(screen.getByRole('radio', { name: 'Alpha' }));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Gamma' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveFocus();
  });
});

describe('SegmentedControl in forced colours (Round 14, finding 25)', () => {
  it('outlines the checked segment in the system selection colour, and only that segment', () => {
    render(
      <SegmentedControl aria-label="Pick one" value="b" onValueChange={() => {}} options={options} />,
    );
    // Forced colours replace the checked tint with Canvas; the outline keeps the state.
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveClass(
        'forced-colors:data-[state=checked]:outline',
        'forced-colors:data-[state=checked]:outline-2',
        'forced-colors:data-[state=checked]:outline-[Highlight]',
      );
    }
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveAttribute('data-state', 'checked');
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute('data-state', 'unchecked');
  });
});
