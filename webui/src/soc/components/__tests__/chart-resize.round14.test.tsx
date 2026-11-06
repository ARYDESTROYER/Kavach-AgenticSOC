/**
 * Overview charts on a resize (Round 14 closing fixes, the §4.8.3 frame budget).
 *
 * The first size of each chart is measured before paint. A later resize (the navigation
 * rail toggling, a window drag) that only GROWS the box redraws the chart as a React
 * transition, which React renders in slices between frames instead of one long task; the
 * old drawing stays at its drawn scale meanwhile. A box that SHRINKS, or a first real size,
 * redraws at once, so a stale drawing never stands past its panel or shrinks under its
 * labels for more than the frame the resize lands in. These tests pin which path each
 * resize takes (React's `startTransition` is spied on) and that every new size reaches the
 * drawing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

// The transition path, observable: the spy runs the redraw at once (inside `act`), so a
// test sees both WHICH path a resize took and the size it drew.
const startTransition = vi.hoisted(() => vi.fn((callback: () => void) => callback()));
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, default: { ...react, startTransition }, startTransition };
});

import { CloseAttributionChart } from '../CloseAttributionChart';
import { NoiseFunnel } from '../NoiseFunnel';
import { token } from '../palette';
import type { NoiseReduction } from '@/lib/types';

interface Observed {
  callback: ResizeObserverCallback;
  targets: Element[];
}

let observed: Observed[] = [];

function stubResizeObserver(): void {
  observed = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly entry: Observed;
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observed.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        observed = observed.filter((entry) => entry !== this.entry);
      }
    },
  );
}

/** Deliver a resize to every observer of `target`. */
function resize(target: Element): void {
  act(() => {
    for (const entry of observed) {
      if (entry.targets.includes(target)) entry.callback([], {} as ResizeObserver);
    }
  });
}

function sizeElement(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => height });
}

beforeEach(() => {
  startTransition.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderCloseAttribution() {
  render(
    <div style={{ position: 'relative', height: 200 }}>
      <CloseAttributionChart
        points={[
          { x: '05:00', ai: 3, human: 1, system: 0 },
          { x: '06:00', ai: 2, human: 2, system: 1 },
        ]}
        bands={[
          { key: 'ai', label: 'AI agent', color: token('chart-1') },
          { key: 'human', label: 'Human', color: token('chart-2') },
          { key: 'system', label: 'System', color: token('chart-8') },
        ]}
        ariaLabel="Cases closed by the agent versus by a human"
      />
    </div>,
  );
  const figure = screen.getByTestId('human-vs-ai-figure');
  return { figure, svg: () => figure.querySelector('svg') as SVGSVGElement };
}

describe('CloseAttributionChart on a resize', () => {
  it('redraws the plot at the size a later resize reports', () => {
    stubResizeObserver();
    const { figure, svg } = renderCloseAttribution();
    // jsdom lays nothing out: before any size the plot draws at its fallback width.
    const before = svg().getAttribute('width');

    sizeElement(figure, 720, 180);
    resize(figure);
    expect(svg()).toHaveAttribute('width', '720');
    expect(svg()).toHaveAttribute('height', '180');
    expect(svg()).toHaveAttribute('viewBox', '0 0 720 180');
    expect(before).not.toBe('720');

    // The navigation expands again: a narrower box redraws narrower.
    sizeElement(figure, 544, 180);
    resize(figure);
    expect(svg()).toHaveAttribute('width', '544');

    // A resize to the same rounded size redraws nothing new.
    sizeElement(figure, 544.4, 180.2);
    resize(figure);
    expect(svg()).toHaveAttribute('width', '544');

    // The navigation collapses: a wider box redraws wider.
    sizeElement(figure, 800, 180);
    resize(figure);
    expect(svg()).toHaveAttribute('width', '800');
  });

  it('redraws a growing box as a transition and a shrinking box at once', () => {
    stubResizeObserver();
    const { figure, svg } = renderCloseAttribution();
    // The mount measure is never a transition (it runs before paint).
    expect(startTransition).not.toHaveBeenCalled();

    // A first real size replaces the fallback drawing at once.
    sizeElement(figure, 720, 180);
    resize(figure);
    expect(startTransition).not.toHaveBeenCalled();

    // Wider: a transition (the old plot keeps its size, with room to spare, meanwhile).
    sizeElement(figure, 896, 180);
    resize(figure);
    expect(startTransition).toHaveBeenCalledTimes(1);
    expect(svg()).toHaveAttribute('width', '896');

    // Narrower, in width or in height: at once, never a stale plot past its panel.
    sizeElement(figure, 720, 180);
    resize(figure);
    sizeElement(figure, 720, 160);
    resize(figure);
    expect(startTransition).toHaveBeenCalledTimes(1);
    expect(svg()).toHaveAttribute('width', '720');
    expect(svg()).toHaveAttribute('height', '160');
  });

  it('clips the plot on x, so a plot drawn for a wider box never paints past its panel', () => {
    stubResizeObserver();
    const { figure } = renderCloseAttribution();
    expect(figure).toHaveClass('overflow-x-clip');
    expect(figure.className).not.toMatch(/overflow-(hidden|y-)/);
  });
});

function funnelData(): NoiseReduction {
  return {
    window_hours: 24,
    generated_at: '2026-10-26T09:00:00Z',
    bands: ['critical', 'high', 'medium', 'low', 'info'],
    stages: [
      { key: 'ingested', label: 'Ingested', source: 'counters', deterministic: true, total: 1000, by_severity: {} },
      { key: 'clustered', label: 'Clustered', source: 'counters', deterministic: true, total: 220, by_severity: {} },
      { key: 'cases', label: 'Cases opened', source: 'cases', deterministic: false, total: 40, by_severity: {} },
      { key: 'auto_cleared', label: 'Auto-cleared', source: 'cases', deterministic: true, total: 25, by_severity: {} },
      { key: 'escalated', label: 'Escalated', source: 'cases', deterministic: true, total: 15, by_severity: {} },
      { key: 'closed', label: 'Closed by human', source: 'cases', deterministic: true, total: 7, by_severity: {} },
    ],
    drops: { suppressed: 0, ignored: 0 },
    reduction: { overall_pct: 96, human_reduction_pct: 87 },
    counters: { available: true, since: '2026-10-25T00:00:00Z', incomplete: false },
    cases_meta: { truncated: false, store_total: 40, fetched: 40 },
  };
}

describe('NoiseFunnel on a resize', () => {
  function renderFunnel() {
    render(<NoiseFunnel data={funnelData()} variant="flat" />);
    const band = screen.getByTestId('noise-flow-band');
    let width = 0;
    Object.defineProperty(band, 'getBoundingClientRect', {
      configurable: true,
      value: () => DOMRect.fromRect({ width, height: 280 }),
    });
    return {
      band,
      setWidth: (next: number) => {
        width = next;
      },
      viewBoxWidth: () => Number(band.querySelector('svg')?.getAttribute('viewBox')?.split(' ')[2]),
    };
  }

  it('re-lays the simple flow out at the width a later resize reports', () => {
    stubResizeObserver();
    const { band, setWidth, viewBoxWidth } = renderFunnel();
    const before = viewBoxWidth();
    expect(before).toBeGreaterThan(0);

    setWidth(912);
    resize(band);
    expect(viewBoxWidth()).toBe(912);

    setWidth(736);
    resize(band);
    expect(viewBoxWidth()).toBe(736);

    setWidth(1088);
    resize(band);
    expect(viewBoxWidth()).toBe(1088);
  });

  it('re-lays a growing band out as a transition and a shrinking band at once', () => {
    stubResizeObserver();
    const { band, setWidth, viewBoxWidth } = renderFunnel();
    expect(startTransition).not.toHaveBeenCalled();

    // A first real size, then a narrower band: both at once (a stale drawing in a
    // smaller box would be scaled down under labels that keep their size).
    setWidth(912);
    resize(band);
    setWidth(736);
    resize(band);
    expect(startTransition).not.toHaveBeenCalled();
    expect(viewBoxWidth()).toBe(736);

    // Wider: a transition, one per delivered resize.
    setWidth(912);
    resize(band);
    expect(startTransition).toHaveBeenCalledTimes(1);
    setWidth(1088);
    resize(band);
    expect(startTransition).toHaveBeenCalledTimes(2);
    expect(viewBoxWidth()).toBe(1088);
  });
});
