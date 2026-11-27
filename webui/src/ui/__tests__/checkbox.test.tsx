/**
 * Checkbox — a partial selection reads as partial.
 *
 * `checked="indeterminate"` used to render the same tick as `checked`, so a "Select
 * visible" control over a half-selected list claimed every row was selected.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Checkbox } from '../checkbox';

describe('Checkbox', () => {
  it('marks an indeterminate state with a dash, not the tick', () => {
    render(<Checkbox aria-label="Select visible" checked="indeterminate" />);
    const box = screen.getByRole('checkbox', { name: 'Select visible' });
    expect(box).toHaveAttribute('data-state', 'indeterminate');
    expect(box).toHaveAttribute('aria-checked', 'mixed');
    const [tick, dash] = Array.from(box.querySelectorAll('svg'));
    expect(tick).toHaveClass('group-data-[state=indeterminate]:hidden');
    expect(dash).toHaveClass('hidden', 'group-data-[state=indeterminate]:block');
    expect(box).toHaveClass('group', 'data-[state=indeterminate]:bg-primary');
  });

  it('keeps the tick for a full selection and draws nothing when unchecked', () => {
    const { rerender } = render(<Checkbox aria-label="Row" checked />);
    expect(screen.getByRole('checkbox', { name: 'Row' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: 'Row' }).querySelectorAll('svg')).toHaveLength(2);
    rerender(<Checkbox aria-label="Row" checked={false} />);
    expect(screen.getByRole('checkbox', { name: 'Row' }).querySelectorAll('svg')).toHaveLength(0);
  });
});
