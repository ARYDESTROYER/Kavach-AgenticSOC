/**
 * KpiTile — Round-7 W0.1 additive props (`countTo` / `format` / `spark` / `help` /
 * `helpLabel`). Existing call sites (no new props) are unaffected — covered by
 * KpiTile.test.tsx + KpiTile.delta-neutral.test.tsx, which stay green.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KpiTile } from '../KpiTile';

describe('KpiTile round-7 props', () => {
  it('countTo renders a rolling numeral (static first mount = the target), overriding `value`', () => {
    render(<KpiTile label="Open" value="0" countTo={7} />);
    // The count-up numeral wins over the placeholder `value`.
    expect(screen.getByTestId('count-up')).toHaveTextContent('7');
    expect(screen.queryByText('0')).toBeNull();
  });

  it('countTo runs through `format`', () => {
    render(<KpiTile label="Events" value="—" countTo={2048} format={(n) => n.toLocaleString('en-US')} />);
    expect(screen.getByTestId('count-up')).toHaveTextContent('2,048');
  });

  it('renders an inline HelpTip on a NON-clickable tile', () => {
    render(<KpiTile label="MTTA" value="12m" variant="bar" help="mean time to acknowledge" />);
    // HelpTip short-text path → a button trigger with the derived accessible name.
    expect(screen.getByRole('button', { name: 'About MTTA' })).toBeInTheDocument();
  });

  it('uses an explicit helpLabel when provided', () => {
    render(<KpiTile label="Dwell" value="1h" help="time to first response" helpLabel="How dwell is measured" />);
    expect(screen.getByRole('button', { name: 'How dwell is measured' })).toBeInTheDocument();
  });

  it('does NOT nest a HelpTip button inside a clickable tile (no invalid nested buttons)', () => {
    render(<KpiTile label="Open" value="9" help="explanation" onClick={() => {}} />);
    // The clickable tile IS a button; the help trigger is suppressed to avoid nesting.
    expect(screen.queryByRole('button', { name: /About/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Open/ })).toBeInTheDocument();
  });

  it('renders the decorative sparkline slot ONLY when ≥5 points are supplied', () => {
    const { container, rerender } = render(
      <KpiTile label="Trend" value="10" spark={[1, 2, 3]} />,
    );
    expect(container.querySelector('div[aria-hidden].h-7')).toBeNull();
    rerender(<KpiTile label="Trend" value="10" spark={[1, 2, 3, 4, 5]} />);
    expect(container.querySelector('div[aria-hidden].h-7')).not.toBeNull();
  });

  it('accepts an explicit two-point floor for exact previous/current comparisons', () => {
    const { container } = render(
      <KpiTile
        label="Rate trend"
        value="83%"
        spark={[86.28, 83.07]}
        sparkMinPoints={2}
      />,
    );
    expect(container.querySelector('div[aria-hidden].h-7')).not.toBeNull();
  });
});
