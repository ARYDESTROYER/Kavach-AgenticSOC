/**
 * NumPref (the shared Settings numeric field) — clearable, and it never invents a value.
 *
 * Round-6 #44 made it clearable: the old `value={value ?? 0}` controlled input (a) showed
 * a literal "0" for an unset pref and (b) snapped back to 0 the instant the field was
 * cleared. It kept raw text while editing and committed a parsed, clamped value on blur.
 *
 * Item A2 fixes what that left behind: blurring an EMPTY field committed `min ?? 0`, so
 * every numeric preference rendered WITHOUT a `min` — which included all three per-case
 * caps — silently wrote a literal 0 the operator never typed. For the caps that is not a
 * stricter limit but a broken configuration: `max_tokens = 0` makes the budget exceeded
 * at the first loop check, BEFORE any model call, so the run fails to human with zero
 * gateway calls and no error audit row (a silent, $0, invisible failure), and
 * `max_tool_calls = 0` burns the ReAct loop with no evidence gathered. An empty field now
 * restores the CURRENT value and commits nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { NumPref } from '../primitives';

describe('NumPref (Round-6 #44)', () => {
  it('renders empty (not "0") for an unset value', () => {
    render(<NumPref label="Top K" value={undefined} onChange={() => {}} />);
    expect((screen.getByLabelText('Top K') as HTMLInputElement).value).toBe('');
  });

  it('does not commit 0 the moment the field is cleared mid-edit', () => {
    const onChange = vi.fn();
    render(<NumPref label="Top K" value={5} min={1} onChange={onChange} />);
    const input = screen.getByLabelText('Top K') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits the parsed, clamped value on blur', () => {
    const onChange = vi.fn();
    render(<NumPref label="Top K" value={5} min={1} max={10} onChange={onChange} />);
    const input = screen.getByLabelText('Top K') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(10); // clamped to max
  });

  it('restores the current value (never min, never 0) when cleared and blurred', () => {
    // An empty field is the ABSENCE of a value, not the value `min`. Committing `min`
    // here silently rewrote the pref to something the operator did not type.
    const onChange = vi.fn();
    render(<NumPref label="Top K" value={5} min={2} onChange={onChange} />);
    const input = screen.getByLabelText('Top K') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('5');
  });

  it('A2: clearing a NumPref with NO min and blurring calls onChange ZERO times', () => {
    // THE BUG: `min ?? 0` meant every min-less numeric pref committed a literal 0 here —
    // and the three per-case caps were all rendered without a min.
    const onChange = vi.fn();
    render(<NumPref label="Max tokens / case" value={20000} onChange={onChange} />);
    const input = screen.getByLabelText('Max tokens / case') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(0);
    expect(input.value).toBe('20000');
  });

  it('leaves an unset pref empty (and silent) when cleared and blurred', () => {
    const onChange = vi.fn();
    render(<NumPref label="Top K" value={undefined} onChange={onChange} />);
    const input = screen.getByLabelText('Top K') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('still clamps a value the operator actually typed', () => {
    const onChange = vi.fn();
    render(<NumPref label="Timeout (seconds)" value={120} min={1} onChange={onChange} />);
    const input = screen.getByLabelText('Timeout (seconds)') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(1);
  });
});
