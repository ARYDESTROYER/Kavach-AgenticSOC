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

describe('MetricHoverTrend — suppressFocusOpen (a modal just returned focus here)', () => {
  /** Wait past `openDelay` (160ms) and its grace, inside act. */
  const settle = () => act(async () => new Promise((r) => setTimeout(r, 450)));

  it('opens on focus when not held (control)', async () => {
    render(
      <MetricHoverTrend metric="Test metric" points={POINTS} windowLabel="last 24 hours">
        <div>42 things</div>
      </MetricHoverTrend>,
    );
    act(() => screen.getByTestId('metric-trend-trigger').focus());
    expect(await screen.findByTestId('metric-trend-card')).toBeInTheDocument();
  });

  it('refuses a focus-only open while held, but a hover still opens the card', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    render(
      <MetricHoverTrend metric="Test metric" points={POINTS} windowLabel="last 24 hours" suppressFocusOpen>
        <div>42 things</div>
      </MetricHoverTrend>,
    );
    const trigger = screen.getByTestId('metric-trend-trigger');
    act(() => trigger.focus());
    await settle();
    expect(screen.queryByTestId('metric-trend-card')).toBeNull();
    await userEvent.hover(trigger);
    expect(await screen.findByTestId('metric-trend-card')).toBeInTheDocument();
  });

  it('while held, a pointer already resting on the trigger opens it on its first movement', async () => {
    render(
      <MetricHoverTrend metric="Test metric" points={POINTS} windowLabel="last 24 hours" suppressFocusOpen>
        <div>42 things</div>
      </MetricHoverTrend>,
    );
    const trigger = screen.getByTestId('metric-trend-trigger');
    // No pointerenter: the browser saw no boundary change when the modal closed.
    fireEvent.pointerMove(trigger);
    expect(await screen.findByTestId('metric-trend-card')).toBeInTheDocument();
  });

  it('while held, a synthetic enter with no movement (a modal closing over a resting pointer) opens nothing', async () => {
    render(
      <MetricHoverTrend metric="Test metric" points={POINTS} windowLabel="last 24 hours" suppressFocusOpen>
        <div>42 things</div>
      </MetricHoverTrend>,
    );
    const trigger = screen.getByTestId('metric-trend-trigger');
    // The browser's boundary update: over/enter only, no move.
    fireEvent.pointerOver(trigger);
    await settle();
    expect(screen.queryByTestId('metric-trend-card')).toBeNull();
    // The operator then moves the pointer: that is a hover.
    fireEvent.pointerMove(trigger);
    expect(await screen.findByTestId('metric-trend-card')).toBeInTheDocument();
  });

  it('while held, a pointer that moves and leaves before the delay opens nothing', async () => {
    render(
      <MetricHoverTrend metric="Test metric" points={POINTS} windowLabel="last 24 hours" suppressFocusOpen>
        <div>42 things</div>
      </MetricHoverTrend>,
    );
    const trigger = screen.getByTestId('metric-trend-trigger');
    fireEvent.pointerMove(trigger);
    fireEvent.pointerLeave(trigger);
    await settle();
    expect(screen.queryByTestId('metric-trend-card')).toBeNull();
  });
});
