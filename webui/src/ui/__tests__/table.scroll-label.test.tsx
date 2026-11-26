/**
 * `Table scrollLabel` (Round 16 bug hunt B78, WP15F).
 *
 * The shared table wrapper scrolls sideways, and a table whose rows hold nothing focusable
 * left a Safari keyboard user unable to reach the cut-off columns (axe
 * scrollable-region-focusable): Auto-close review by rule, the Team person sheet's Per day.
 * `scrollLabel` makes the wrapper a focusable region with that name.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Table, TableBody, TableCell, TableRow } from '../table';

function rows() {
  return (
    <TableBody>
      <TableRow>
        <TableCell>Brute force burst</TableCell>
        <TableCell>12</TableCell>
      </TableRow>
    </TableBody>
  );
}

describe('Table scrollLabel (B78)', () => {
  it('makes the scroll wrapper a focusable region with that name', () => {
    render(
      <Table aria-label="Auto-close review by rule" scrollLabel="Auto-close review by rule">
        {rows()}
      </Table>,
    );
    const region = screen.getByRole('region', { name: 'Auto-close review by rule' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveClass('overflow-auto');
    expect(region.querySelector('table')).not.toBeNull();
    // A visible focus ring, drawn inside so the panel edge never clips it.
    expect(region.className).toContain('focus-visible:ring-inset');
  });

  it('leaves the wrapper plain without one', () => {
    const { container } = render(<Table aria-label="Plain">{rows()}</Table>);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.tagName).toBe('DIV');
    expect(wrapper).not.toHaveAttribute('tabindex');
    expect(wrapper).not.toHaveAttribute('role');
  });

  it('has no wrapper to name when unwrapped', () => {
    const { container } = render(
      <Table unwrapped scrollLabel="Ignored" aria-label="Bare">
        {rows()}
      </Table>,
    );
    expect(container.firstElementChild?.tagName).toBe('TABLE');
    expect(screen.queryByRole('region')).toBeNull();
  });
});
