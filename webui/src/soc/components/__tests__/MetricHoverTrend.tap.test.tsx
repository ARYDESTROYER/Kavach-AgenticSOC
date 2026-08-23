/**
 * MetricHoverTrend — press/tap toggle (touch access) contract.
 *
 * Hover cannot open the card on touch-only devices (Radix ignores touch pointers
 * and suppresses trigger focus), so a press toggles the card:
 *   - a NON-clickable wrapped metric (default `focusable`, so toggle defaults ON)
 *     opens on press and closes on a second press — even though Radix dismisses an
 *     open card on pointerdown outside its portalled content (the trigger is
 *     outside it), the pre-press state is recorded so the second press stays a CLOSE;
 *   - a wrapper around a CLICKABLE child (`focusable={false}`, toggle defaults OFF)
 *     is untouched: the child's own click still fires and never opens the card;
 *   - with an explicit `toggleOnClick`, presses on interactive DESCENDANTS are
 *     ignored so a nested control (e.g. a HelpTip button) never fights the card.
 *
 * Pointer events are dispatched directly (fireEvent) because jsdom has no real
 * PointerEvent; React routes the 'pointerdown'/'pointerup' types regardless.
 */
import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import { MetricHoverTrend } from '../MetricHoverTrend';

const POINTS = [
  { label: '2026-07-01T05:00:00Z', value: 2 },
  { label: '2026-07-01T06:00:00Z', value: 5 },
];

function tap(el: Element) {
  fireEvent.pointerDown(el);
  fireEvent.pointerUp(el);
}

describe('MetricHoverTrend — press/tap toggle', () => {
  it('opens on press and closes on a second press for a non-clickable wrapped metric', async () => {
    render(
      <MetricHoverTrend metric="Test metric" points={POINTS} windowLabel="last 24 hours">
        <div>42 things</div>
      </MetricHoverTrend>,
    );
    const trigger = screen.getByTestId('metric-trend-trigger');

    tap(trigger);
    expect(await screen.findByTestId('metric-trend-card')).toBeInTheDocument();

    // Second press: Radix's dismiss layer already closed the card on the
    // pointerdown (the trigger is outside the portalled content) — the recorded
    // pre-press state keeps this press a CLOSE instead of an instant re-open.
    tap(trigger);
    await waitFor(() => expect(screen.queryByTestId('metric-trend-card')).toBeNull());
  });

  it('leaves a wrapper around a clickable child inert: the click navigates, no card opens', async () => {
    const onClick = vi.fn();
    render(
      <MetricHoverTrend
        metric="Test metric"
        points={POINTS}
        windowLabel="last 24 hours"
        focusable={false}
      >
        <button type="button" onClick={onClick}>
          Drill down
        </button>
      </MetricHoverTrend>,
    );
    const child = screen.getByRole('button', { name: 'Drill down' });

    fireEvent.pointerDown(child);
    fireEvent.pointerUp(child);
    fireEvent.click(child);

    expect(onClick).toHaveBeenCalledTimes(1);
    // Give any (wrong) card a beat to appear, then assert none did. (act-wrapped:
    // the shared lazy sparkline chunk may finish loading during this window.)
    await act(async () => new Promise((r) => setTimeout(r, 250)));
    expect(screen.queryByTestId('metric-trend-card')).toBeNull();
  });

  it('with an explicit toggleOnClick, ignores presses on interactive descendants', async () => {
    render(
      <MetricHoverTrend
        metric="Test metric"
        points={POINTS}
        windowLabel="last 24 hours"
        focusable={false}
        toggleOnClick={true}
      >
        <div>
          <span>3 things</span>
          <button type="button" aria-label="About Test metric">
            ?
          </button>
        </div>
      </MetricHoverTrend>,
    );

    // A press on the nested control must never toggle the card.
    tap(screen.getByRole('button', { name: 'About Test metric' }));
    await act(async () => new Promise((r) => setTimeout(r, 250)));
    expect(screen.queryByTestId('metric-trend-card')).toBeNull();

    // A press on the tile body itself does.
    tap(screen.getByText('3 things'));
    expect(await screen.findByTestId('metric-trend-card')).toBeInTheDocument();
  });
});
