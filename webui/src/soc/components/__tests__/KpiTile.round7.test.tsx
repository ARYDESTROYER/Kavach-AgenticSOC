/**
 * KpiTile — Round-7 W0.1 additive props (`countTo` / `format` / `spark` / `help` /
 * `helpLabel`). Existing call sites (no new props) are unaffected — covered by
 * KpiTile.test.tsx + KpiTile.delta-neutral.test.tsx, which stay green.
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { KpiTile } from '../KpiTile';

/**
 * The rolling numeral has two renderers: the CSS `<CountUp>` (`data-testid="count-up"`)
 * is the Suspense fallback until the lazy motion.dev spring (`AnimatedNumber`) loads, and
 * `React.lazy` keeps the loaded spring for every later tile in this file. Which one is on
 * screen at first paint is therefore a race with that chunk, so these tests assert the
 * numeral's TEXT on whichever renderer is showing, then wait for the spring to replace
 * the fallback (inside `waitFor`, so the lazy load settles within the test, not after
 * it) and assert the same text again: the upgrade never changes what the tile says.
 */
async function springLoaded(): Promise<void> {
  await waitFor(() => expect(screen.queryByTestId('count-up')).toBeNull());
}

describe('KpiTile round-7 props', () => {
  // Load the spring module before the first tile, so `springLoaded` waits on React.lazy
  // only, never on a cold worker loading motion.dev (which could outlast waitFor's one
  // second on a busy machine).
  beforeAll(async () => {
    await import('../motion/AnimatedNumber');
  });

  it('countTo renders a rolling numeral (static first mount = the target), overriding `value`', async () => {
    render(<KpiTile label="Open" value="0" countTo={7} />);
    const tile = screen.getByTestId('kpi-open');
    // The count-up numeral wins over the placeholder `value`, from the first paint on.
    expect(tile).toHaveTextContent('7');
    expect(within(tile).queryByText('0')).toBeNull();
    await springLoaded();
    expect(tile).toHaveTextContent('7');
    expect(within(tile).queryByText('0')).toBeNull();
  });

  it('countTo runs through `format`', async () => {
    render(<KpiTile label="Events" value="—" countTo={2048} format={(n) => n.toLocaleString('en-US')} />);
    const tile = screen.getByTestId('kpi-events');
    expect(tile).toHaveTextContent('2,048');
    await springLoaded();
    expect(tile).toHaveTextContent('2,048');
    expect(within(tile).queryByText('2048')).toBeNull();
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

  it('renders a clickable tile’s HelpTip BESIDE the trigger, never nested inside it', () => {
    // The help used to be SUPPRESSED on a clickable tile, because the tile is itself a
    // <button> and a nested button is invalid DOM (React logs `validateDOMNesting`, which
    // the zero-console gate treats as a failure). Suppression was the wrong half of the
    // trade: it deleted the explanation rather than relocating it. The trigger now renders
    // as a SIBLING in the same cell — exactly the arrangement `breakdown` already uses —
    // so the help is reachable by pointer, keyboard AND touch, and still contributes
    // nothing to the tile's accessible name.
    render(<KpiTile label="Open" value="9" help="explanation" onClick={() => {}} />);

    // Anchored names: the help trigger's own accessible name CONTAINS the tile's label
    // ("About Open"), so a loose /Open/ matches both buttons — which is itself a small
    // proof that the two are distinct controls rather than one nested in the other.
    const tile = screen.getByRole('button', { name: /^Open\b/ });
    const help = screen.getByRole('button', { name: 'About Open' });
    expect(help).toBeInTheDocument();
    // The load-bearing half: present, but NOT inside the trigger.
    expect(tile.contains(help)).toBe(false);
    expect(tile.querySelector('button')).toBeNull();
    // Still one cell: they share a common ancestor that is not the document.
    expect(help.closest('div')?.parentElement).toBe(tile.parentElement);
  });

  it('renders the decorative sparkline slot ONLY when ≥5 points are supplied', () => {
    const { container, rerender } = render(
      <KpiTile label="Trend" value="10" spark={[1, 2, 3]} />,
    );
    expect(container.querySelector('div[aria-hidden].h-7')).toBeNull();
    rerender(<KpiTile label="Trend" value="10" spark={[1, 2, 3, 4, 5]} />);
    expect(container.querySelector('div[aria-hidden].h-7')).not.toBeNull();
  });

  it('reserves the strip caption gutter ONLY while a spark occupies it', () => {
    // The 4rem right gutter exists solely to clear the absolutely-positioned strip
    // spark (`bottom-4 right-4 w-14`). Reserving it unconditionally cut ~10 characters
    // off every strip caption on the tiles that pass no series — permanently empty
    // space, ellipsizing load-bearing subs such as the degraded open-stock line.
    const CAPTION = 'Open now \u00b7 not window-filtered \u00b7 lower bound';
    const sub = () => screen.getByText(CAPTION).className;
    for (const chrome of ['framed', 'strip'] as const) {
      const { rerender, unmount } = render(
        <KpiTile label="Open Cases" value="12" variant="strip" chrome={chrome} sub={CAPTION} />,
      );
      expect(sub()).not.toMatch(/\bpr-16\b/);
      rerender(
        <KpiTile
          label="Open Cases"
          value="12"
          variant="strip"
          chrome={chrome}
          sub={CAPTION}
          spark={[1, 2, 3, 4, 5]}
        />,
      );
      // Framed: the `sub` caption; strip chrome: the hero context line. Either way the
      // caption wraps short of the corner spark instead of running under it.
      expect(sub()).toMatch(/\bpr-16\b/);
      unmount();
    }
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
