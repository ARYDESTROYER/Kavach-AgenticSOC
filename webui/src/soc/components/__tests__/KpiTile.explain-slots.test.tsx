/**
 * KpiTile slots for acceptance package FXD1:
 *
 *   - `deltaExplain` wraps the change chip (delta-chips-unexplained), never inside a tile
 *     that is itself a button.
 *   - `pending` mutes a numeral that belongs to the window being replaced and marks the
 *     tile busy (overview-kpi-stale-window).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { KpiTile } from '../KpiTile';

const wrap = (chip: React.ReactNode) => <span data-testid="chip-explained">{chip}</span>;

describe('KpiTile deltaExplain', () => {
  it('wraps the change chip of a static tile', () => {
    render(<KpiTile label="Cases" value="38" delta={{ value: 8, label: '+8' }} deltaExplain={wrap} testId="t" />);
    expect(screen.getByTestId('chip-explained')).toHaveTextContent('+8');
  });

  it('leaves the chip of a clickable tile alone', () => {
    render(<KpiTile label="Cases" value="38" delta={{ value: 8, label: '+8' }} deltaExplain={wrap} onClick={vi.fn()} testId="t" />);
    expect(screen.queryByTestId('chip-explained')).toBeNull();
    expect(screen.getByTestId('kpi-t')).toHaveTextContent('+8');
  });
});

describe('KpiTile pending', () => {
  it('mutes the numeral and marks the tile busy', () => {
    render(<KpiTile label="FP rate" value="48%" sub="Loading 7 days" pending testId="t" />);
    const tile = screen.getByTestId('kpi-t');
    const numeral = tile.querySelector('[data-pending]');
    expect(numeral).not.toBeNull();
    expect(numeral).toHaveClass('text-muted-foreground');
    expect(numeral).toHaveTextContent('48%');
    expect(tile.closest('[aria-busy="true"]') ?? tile.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('a current numeral is ink and the tile is not busy', () => {
    render(<KpiTile label="FP rate" value="48%" testId="t" />);
    const tile = screen.getByTestId('kpi-t');
    expect(tile.querySelector('[data-pending]')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
