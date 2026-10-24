/**
 * Round 13 (SPEC-chat T33): opening the report panel says so when it takes the docked
 * rail's room ("History collapsed to make room for the report"), once per opening; the
 * rail comes back docked when the panel closes; the analyst's own collapse and an overlay
 * panel (which takes no room) say nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const announce = vi.hoisted(() => vi.fn());
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));

import { render } from '@testing-library/react';
import { RAIL_YIELDED_MESSAGE, railYieldedToPanel, useChatGeometry } from '../useChatGeometry';

let latest: ReturnType<typeof useChatGeometry> | null = null;

function Probe({ panelOpen }: { panelOpen: boolean }) {
  const g = useChatGeometry(panelOpen);
  latest = g;
  return <div ref={g.frameRef} />;
}

function frameWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ width, height: 800 }));
}

afterEach(() => {
  vi.restoreAllMocks();
  announce.mockClear();
  window.localStorage.clear();
  latest = null;
});

describe('useChatGeometry — the rail yields to the report panel', () => {
  it('announces once when the panel collapses a docked rail, and restores it on close', () => {
    frameWidth(1216); // 1280 with the 64 px nav: docked alone, strip with the split panel.
    const view = render(<Probe panelOpen={false} />);
    expect(latest!.rail).toBe('docked');
    view.rerender(<Probe panelOpen />);
    expect(latest!.rail).toBe('strip');
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(RAIL_YIELDED_MESSAGE);
    expect(RAIL_YIELDED_MESSAGE).toBe('History collapsed to make room for the report');
    view.rerender(<Probe panelOpen />);
    expect(announce).toHaveBeenCalledTimes(1);
    // Closed: the docked rail is back, the analyst's preference untouched.
    view.rerender(<Probe panelOpen={false} />);
    expect(latest!.rail).toBe('docked');
    expect(latest!.railCollapsed).toBe(false);
    // Opened again: said again.
    view.rerender(<Probe panelOpen />);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('says nothing when the rail keeps its place or the analyst collapsed it', () => {
    frameWidth(1376); // 1440 with the 64 px nav: docked and split side by side.
    const roomy = render(<Probe panelOpen={false} />);
    roomy.rerender(<Probe panelOpen />);
    expect(latest!.rail).toBe('docked');
    roomy.unmount();
    frameWidth(1040); // 1280 with the 240 px nav: the panel is an overlay.
    const overlay = render(<Probe panelOpen={false} />);
    overlay.rerender(<Probe panelOpen />);
    expect(latest!.panel).toBe('overlay');
    overlay.unmount();
    expect(announce).not.toHaveBeenCalled();
    expect(railYieldedToPanel({ rail: 'strip', railCanDock: true }, true, true)).toBe(false);
    expect(railYieldedToPanel({ rail: 'strip', railCanDock: true }, false, true)).toBe(true);
    expect(railYieldedToPanel({ rail: 'strip', railCanDock: false }, false, true)).toBe(false);
    expect(railYieldedToPanel({ rail: 'strip', railCanDock: true }, false, false)).toBe(false);
  });
});
