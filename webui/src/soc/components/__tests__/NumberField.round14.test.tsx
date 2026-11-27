/**
 * NumberField, Round 14 (SPEC §4.9.2, uib Y4): one bordered box holding the number, its
 * unit and its steppers; sized to its numbers (6, 8, 12rem or full; 8rem for up to four
 * characters, wider when the unit and the steppers need the room); steppers inside the
 * right edge for values of up to four digits, out of the tab order; an editable APG
 * spinbutton; an unedited field never commits; `empty="keep"` for preferences;
 * `step="any"`; PageUp/PageDown step by ten while Home and End keep the caret.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import {
  NumberField,
  defaultNumberFieldSize,
  defaultShowSteppers,
  numberFieldWidthNeeded,
  widestValueChars,
} from '../NumberField';

function box(label: string) {
  return screen.getByLabelText(label).closest('[data-number-field]') as HTMLElement;
}

describe('NumberField sizing helpers', () => {
  it('counts the widest value the field accepts', () => {
    expect(widestValueChars({ min: 1, max: 24 })).toBe(2);
    expect(widestValueChars({ min: 0, max: 1, step: 0.01 })).toBe(4);
    expect(widestValueChars({ min: -100, max: 50 })).toBe(4);
    expect(widestValueChars({ min: 1 })).toBeNull();
  });

  it('gives 8rem to values of up to four characters and 12rem above that or when unbounded', () => {
    expect(defaultNumberFieldSize({ min: 1, max: 9999 })).toBe('sm');
    expect(defaultNumberFieldSize({ min: 1, max: 10000 })).toBe('md');
    expect(defaultNumberFieldSize({ min: 1 })).toBe('md');
    expect(defaultNumberFieldSize({ min: 0, max: 1, step: 0.001 })).toBe('md');
  });

  it('takes the next size up when the unit and the steppers need the room, so the digits never hide', () => {
    // "Trigger after N" (events, up to 1000) and "Inactivity limit" (minutes, up to 1440)
    // left 3px and less for their digits at 8rem.
    expect(defaultNumberFieldSize({ min: 1, max: 1000, unit: 'events' })).toBe('md');
    expect(defaultNumberFieldSize({ min: 5, max: 1440, unit: 'minutes' })).toBe('md');
    expect(defaultNumberFieldSize({ min: 1, max: 24, unit: 'hours' })).toBe('md');
    // A short unit still fits 8rem.
    expect(defaultNumberFieldSize({ min: 1, max: 900, unit: 's' })).toBe('sm');
    // A unit too long for 12rem takes the column.
    expect(defaultNumberFieldSize({ min: 1, max: 1000, unit: 'events per minute per source' })).toBe('full');
    // Every default leaves the digits their room.
    for (const [max, unit] of [[1000, 'events'], [1440, 'minutes'], [24, 'hours'], [900, 's']] as const) {
      const size = defaultNumberFieldSize({ min: 1, max, unit });
      const px = { sm: 128, md: 192 }[size as 'sm' | 'md'];
      expect(numberFieldWidthNeeded(String(max).length, unit, true)).toBeLessThanOrEqual(px);
    }
  });

  it('starts a Settings preference at 8rem whatever its digits, still growing for a long unit', () => {
    expect(defaultNumberFieldSize({ min: 1, base: 'sm', steppers: false })).toBe('sm');
    expect(defaultNumberFieldSize({ min: 15, max: 10080, base: 'sm', steppers: false })).toBe('sm');
    expect(defaultNumberFieldSize({ min: 1, base: 'sm', steppers: false, unit: '(24 hours)' })).toBe('md');
  });

  it('shows steppers by the digits the field accepts, or for a caller stride', () => {
    expect(defaultShowSteppers({ min: 0, max: 60 })).toBe(true);
    expect(defaultShowSteppers({ min: 0, max: 1, step: 0.05 })).toBe(true);
    expect(defaultShowSteppers({ min: 1 })).toBe(false);
    expect(defaultShowSteppers({ min: 1, max: 20000 })).toBe(false);
    expect(defaultShowSteppers({ min: 1, stepperStep: 1 })).toBe(true);
  });
});

describe('NumberField box', () => {
  it('is sized to its numbers and holds the unit and the steppers inside one box', () => {
    render(<NumberField label="Lookup timeout" value={15} min={1} max={900} unit="s" onChange={() => {}} />);
    const field = box('Lookup timeout');
    expect(field).toHaveAttribute('data-number-field', 'sm');
    expect(field).toHaveClass('w-32', 'rounded-md', 'border');
    expect(field).toHaveTextContent('s');
    const increase = screen.getByRole('button', { name: 'Increase' });
    const decrease = screen.getByRole('button', { name: 'Decrease' });
    expect(field).toContainElement(increase);
    expect(field).toContainElement(decrease);
    // Pointer conveniences: the keyboard steps with the arrow keys, not by tabbing to them.
    expect(increase).toHaveAttribute('tabindex', '-1');
    expect(increase).toHaveAttribute('aria-controls', screen.getByLabelText('Lookup timeout').id);
    expect(increase).toHaveClass('size-6');
  });

  it('omits the steppers above four digits, where a step of one is useless', () => {
    render(<NumberField label="Max tokens" value={20000} min={1} onChange={() => {}} />);
    expect(box('Max tokens')).toHaveAttribute('data-number-field', 'md');
    expect(screen.queryByRole('button', { name: 'Increase' })).toBeNull();
  });

  it('keeps the steppers when the caller gives a stepper stride, or asks for them', () => {
    const { rerender } = render(
      <NumberField label="Limit per day" value={5} min={0} step={0.01} stepperStep={1} unit="USD" onChange={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Increase' })).toBeInTheDocument();
    rerender(<NumberField label="Limit per day" value={5} min={0} steppers={false} max={10} onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Increase' })).toBeNull();
  });

  it('takes an explicit size', () => {
    render(<NumberField label="Weight" value={1} min={0} max={9} size="xs" onChange={() => {}} />);
    expect(box('Weight')).toHaveClass('w-24');
  });

  it('keys the steppers on the digits it accepts, never on the box width', () => {
    const { rerender } = render(
      <NumberField label="Interval" value={30} min={0} max={60} size="full" onChange={() => {}} />,
    );
    // A small bounded value keeps its steppers in a full-width box.
    expect(box('Interval')).toHaveClass('w-full');
    expect(screen.getByRole('button', { name: 'Increase' })).toBeInTheDocument();
    // An unbounded five-digit value has none in an 8rem box.
    rerender(<NumberField label="Interval" value={20000} min={1} size="sm" onChange={() => {}} />);
    expect(box('Interval')).toHaveClass('w-32');
    expect(screen.queryByRole('button', { name: 'Increase' })).toBeNull();
  });

  it('widens for a long unit beside the steppers', () => {
    render(<NumberField label="Trigger after" value={5} min={1} max={1000} unit="events" onChange={() => {}} />);
    expect(box('Trigger after')).toHaveAttribute('data-number-field', 'md');
  });

  it('is an editable spinbutton with its bounds and value, the unit in its value text', () => {
    render(<NumberField label="Model step timeout" value={60} min={5} max={900} unit="s" onChange={() => {}} />);
    const input = screen.getByRole('spinbutton', { name: 'Model step timeout' });
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('aria-valuemin', '5');
    expect(input).toHaveAttribute('aria-valuemax', '900');
    expect(input).toHaveAttribute('aria-valuenow', '60');
    expect(input).toHaveAttribute('aria-valuetext', '60 s');
    // While typing, the value it announces is the number being typed.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '75' } });
    expect(input).toHaveAttribute('aria-valuenow', '75');
  });

  it('announces no value for an unset field', () => {
    render(<NumberField label="Top K" value={undefined} min={1} max={50} onChange={() => {}} />);
    const input = screen.getByRole('spinbutton', { name: 'Top K' });
    expect(input).not.toHaveAttribute('aria-valuenow');
    expect(input).not.toHaveAttribute('aria-valuetext');
  });

  it('names its reset in sentence case', () => {
    const onChange = vi.fn();
    render(<NumberField label="Window" value={8} min={1} max={10} defaultValue={5} onChange={onChange} />);
    const reset = screen.getByRole('button', { name: 'Reset' });
    expect(reset).toHaveTextContent('Reset');
    fireEvent.click(reset);
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it('shows an empty field for an unset value', () => {
    render(<NumberField label="Top K" value={undefined} min={1} max={50} onChange={() => {}} />);
    expect(screen.getByLabelText('Top K')).toHaveValue('');
  });
});

describe('NumberField commits', () => {
  it('with empty="keep" an emptied field commits nothing and shows the current value again', () => {
    const onChange = vi.fn();
    render(<NumberField label="Batch size" value={500} min={1} empty="keep" onChange={onChange} />);
    const input = screen.getByLabelText('Batch size');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('500');
  });

  it('with step="any" accepts any value between the bounds as typed', () => {
    const onChange = vi.fn();
    render(<NumberField label="Weight" value={0.25} min={0} max={1} step="any" onChange={onChange} />);
    const input = screen.getByLabelText('Weight');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '0.333' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(0.333);
  });

  it('never rewrites a value when the field is only focused and left', () => {
    const onChange = vi.fn();
    // Off the step grid and outside the bounds: still kept as stored.
    const { rerender } = render(
      <NumberField label="Confidence" value={0.72} min={0} max={1} step={0.05} onChange={onChange} />,
    );
    const input = screen.getByLabelText('Confidence');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('0.72');
    rerender(<NumberField label="Confidence" value={20} min={15} max={10080} step={15} onChange={onChange} />);
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    // Typing the same text back is no edit either.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('steps a step="any" field by its stride without floating-point drift', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <NumberField label="Weight" value={0.07} min={0} max={1} step="any" stepperStep={0.05} onChange={onChange} />,
    );
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(0.12);
    rerender(<NumberField label="Weight" value={1.1} step="any" onChange={onChange} />);
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(0.1);
  });

  it('steps by ten with PageUp and PageDown and leaves Home and End to the caret', () => {
    const onChange = vi.fn();
    function Controlled() {
      const [value, setValue] = React.useState(50);
      return (
        <NumberField
          label="Window"
          value={value}
          min={1}
          max={90}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Controlled />);
    const input = screen.getByLabelText('Window');
    fireEvent.keyDown(input, { key: 'PageUp' });
    expect(onChange).toHaveBeenLastCalledWith(60);
    fireEvent.keyDown(input, { key: 'PageDown' });
    fireEvent.keyDown(input, { key: 'PageDown' });
    expect(onChange).toHaveBeenLastCalledWith(40);
    expect(onChange).toHaveBeenCalledTimes(3);
    // Home and End move the caret in the typed value: they never set a bound (a cap of 1).
    const home = fireEvent.keyDown(input, { key: 'Home' });
    const end = fireEvent.keyDown(input, { key: 'End' });
    expect(home).toBe(true);
    expect(end).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(input).toHaveValue('40');
  });

  it('starts a step from the default (or the minimum) when the field is unset', () => {
    const onChange = vi.fn();
    render(<NumberField label="Retries" value={null} min={0} max={10} defaultValue={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Increase' }));
    expect(onChange).toHaveBeenLastCalledWith(4);
  });

  it('marks out-of-range text invalid on the box until it is committed', () => {
    render(<NumberField label="Window" value={5} min={1} max={10} onChange={() => {}} />);
    const input = screen.getByLabelText('Window');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '99' } });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(box('Window')).toHaveClass('border-critical');
  });
});
