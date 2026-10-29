/**
 * BarList — the sub/percent footer row is conditional (round-6 ui-theme).
 *
 * A bar with neither a `sub` nor `showPercent` must NOT render the trailing footer
 * row, so those bars don't each accrue a stray 4px (`mt-1`) trailer that makes the
 * inter-row rhythm inconsistent versus bars that DO show a sub/percent.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BarList } from '../BarList';

describe('BarList footer row', () => {
  it('renders no trailing footer row when a bar has neither a sub nor showPercent', () => {
    // The footer is the only element with the exact `mt-1` class (the bar track is `mt-1.5`).
    const { container } = render(<BarList items={[{ label: 'Alpha', value: 10 }]} />);
    expect(container.querySelector('.mt-1')).toBeNull();
  });

  it('renders the footer row (with the %) when showPercent is set', () => {
    const { container, getByText } = render(
      <BarList items={[{ label: 'Alpha', value: 10 }]} showPercent />,
    );
    expect(container.querySelector('.mt-1')).not.toBeNull();
    expect(getByText('100%')).toBeInTheDocument();
  });

  it('renders the footer row when an item supplies a sub caption', () => {
    const { container, getByText } = render(
      <BarList items={[{ label: 'Alpha', value: 10, sub: 'last 24h' }]} />,
    );
    expect(container.querySelector('.mt-1')).not.toBeNull();
    expect(getByText('last 24h')).toBeInTheDocument();
  });
});

describe('BarList figures and shares (Round 14, audit finding 24)', () => {
  const ITEMS = [
    { label: 'Alpha', value: 60 },
    { label: 'Beta', value: 30 },
    { label: 'Gamma', value: 10 },
  ];

  it('reads the percentage as a share of the largest row by default', () => {
    const { getAllByText } = render(<BarList items={ITEMS} showPercent />);
    expect(getAllByText(/%$/).map((el) => el.textContent)).toEqual(['100%', '50%', '17%']);
  });

  it('reads it as a share of the total with percentOf="total", bars still relative to the largest', () => {
    const { getAllByText, getAllByRole } = render(<BarList items={ITEMS} showPercent percentOf="total" />);
    expect(getAllByText(/%$/).map((el) => el.textContent)).toEqual(['60%', '30%', '10%']);
    expect(getAllByRole('progressbar').map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['100', '50', '17']);
  });

  it('says "<1%" for a share that rounds to nothing, never 0%', () => {
    const { getByText } = render(
      <BarList items={[{ label: 'Big', value: 999 }, { label: 'Tiny', value: 1 }]} showPercent percentOf="total" />,
    );
    expect(getByText('<1%')).toBeInTheDocument();
  });

  it('sets values, ranks and percentages in Inter with tabular figures, and has no capital title', () => {
    const { container, getByText } = render(<BarList items={ITEMS} showPercent showRank />);
    expect(container.querySelector('[class*="font-mono"]')).toBeNull();
    expect(container.querySelector('.uppercase')).toBeNull();
    expect(getByText('60')).toHaveClass('tabular-nums');
    expect(getByText('01')).toHaveClass('tabular-nums');
  });
});
