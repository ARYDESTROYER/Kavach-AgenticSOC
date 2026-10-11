/**
 * The three-zone layout rule (chat revamp SPEC §10.1) at the reference widths. Round 12:
 * the frame bleeds the shell's whole inset, so the frame is the viewport minus the nav
 * rail (240 / 64 px) — no 24 px gutters. The hook measures the frame with an observer
 * that StrictMode's simulated remount re-creates (diagnosis/layout.md (g)).
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

import { C_MIN, PANEL_DEFAULT, clampPanelWidth, computeGeometry, useChatGeometry } from '../useChatGeometry';

const frame = (viewport: number, nav: 240 | 64 | 0) => viewport - nav;
const geometry = (frameWidth: number, panelOpen = false, railCollapsed = false, panelWidth = PANEL_DEFAULT) =>
  computeGeometry({ frameWidth, panelOpen, railCollapsed, panelWidth });

describe('computeGeometry', () => {
  it('matches the 1280 px reference row', () => {
    // nav 240 → frame 1040: docked rail, conversation 775, the panel is an overlay.
    expect(geometry(frame(1280, 240))).toMatchObject({ rail: 'docked', conversationWidth: 775 });
    expect(geometry(frame(1280, 240), true)).toMatchObject({ rail: 'docked', panel: 'overlay', conversationWidth: 775 });
    // nav 64 → frame 1216: 951 alone; with the panel (360 + its 9 px separator handle)
    // the rail collapses to the strip (798).
    expect(geometry(frame(1280, 64))).toMatchObject({ rail: 'docked', conversationWidth: 951 });
    expect(geometry(frame(1280, 64), true)).toMatchObject({ rail: 'strip', panel: 'split', conversationWidth: 798 });
  });

  it('matches the 1440, 1920 and 2560 px reference rows', () => {
    expect(geometry(frame(1440, 240), true)).toMatchObject({ rail: 'strip', panel: 'split', conversationWidth: 782 });
    expect(geometry(frame(1440, 64), true)).toMatchObject({ rail: 'docked', panel: 'split', conversationWidth: 742 });
    expect(geometry(frame(1920, 240), true)).toMatchObject({ rail: 'docked', panel: 'split', conversationWidth: 1046 });
    expect(geometry(frame(1920, 64), true)).toMatchObject({ rail: 'docked', panel: 'split', conversationWidth: 1222 });
    // Everything collapsed (the operator's screenshot 1): the conversation takes it all.
    expect(geometry(frame(1920, 64), false, true)).toMatchObject({ rail: 'strip', conversationWidth: 1807 });
    expect(geometry(frame(2560, 64), false, true)).toMatchObject({ rail: 'strip', conversationWidth: 2447 });
    // The split needs the panel plus its 9 px handle: one pixel less and it overlays.
    expect(geometry(265 + 640 + 360 + 9, true)).toMatchObject({ rail: 'docked', panel: 'split', conversationWidth: 640 });
    expect(geometry(49 + 640 + 360 + 8, true)).toMatchObject({ panel: 'overlay' });
  });

  it('turns both side zones into Sheets below a 640 px frame (390 px phones)', () => {
    expect(geometry(frame(390, 0))).toMatchObject({ rail: 'sheet', panel: 'overlay', railCanDock: false });
    expect(geometry(639, true)).toMatchObject({ rail: 'sheet', panel: 'overlay' });
    expect(geometry(C_MIN)).toMatchObject({ rail: 'strip' });
  });

  it('docks only while the conversation keeps 640 px, and honours a collapsed rail', () => {
    expect(geometry(905)).toMatchObject({ rail: 'docked', railCanDock: true });
    expect(geometry(904)).toMatchObject({ rail: 'strip', railCanDock: false });
    expect(geometry(1200, false, true)).toMatchObject({ rail: 'strip', railCanDock: true, conversationWidth: 1151 });
  });

  it('treats an unmeasured frame as roomy and clamps the panel width', () => {
    expect(geometry(0)).toMatchObject({ rail: 'docked' });
    expect(clampPanelWidth(100)).toBe(320);
    expect(clampPanelWidth(900)).toBe(480);
    expect(clampPanelWidth(Number.NaN)).toBe(PANEL_DEFAULT);
  });
});

/** A ResizeObserver stand-in that records live observers and lets the test resize. */
function fakeResizeObserver() {
  const live = new Set<{ cb: ResizeObserverCallback; nodes: Set<Element> }>();
  class FakeRO {
    private entry = { cb: (() => undefined) as ResizeObserverCallback, nodes: new Set<Element>() };
    constructor(cb: ResizeObserverCallback) {
      this.entry.cb = cb;
      live.add(this.entry);
    }
    observe(node: Element) {
      this.entry.nodes.add(node);
    }
    unobserve(node: Element) {
      this.entry.nodes.delete(node);
    }
    disconnect() {
      this.entry.nodes.clear();
      live.delete(this.entry);
    }
  }
  vi.stubGlobal('ResizeObserver', FakeRO);
  return {
    resize(width: number) {
      for (const entry of [...live]) {
        for (const node of entry.nodes) {
          entry.cb([{ target: node, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
        }
      }
    },
    observed: () => [...live].reduce((n, entry) => n + entry.nodes.size, 0),
  };
}

function Probe({ onGeometry }: { onGeometry: (g: ReturnType<typeof useChatGeometry>) => void }) {
  const g = useChatGeometry(false);
  onGeometry(g);
  return React.createElement('div', { ref: g.frameRef, 'data-testid': 'frame' });
}

describe('useChatGeometry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps following the frame width under React StrictMode (diagnosis (g))', () => {
    const ro = fakeResizeObserver();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ width: 1600, height: 800 }));
    let latest: ReturnType<typeof useChatGeometry> | null = null;
    const view = render(
      React.createElement(React.StrictMode, null, React.createElement(Probe, { onGeometry: (g) => (latest = g) })),
    );
    expect(latest!.frameWidth).toBe(1600);
    // StrictMode mounted, unmounted and remounted the effect: an observer is still live.
    expect(ro.observed()).toBe(1);
    // A later resize (the 900 px case that used to stay docked and crush the conversation).
    act(() => ro.resize(900));
    expect(latest!.frameWidth).toBe(900);
    expect(latest!.rail).toBe('strip');
    expect(latest!.conversationWidth).toBe(900 - 49);
    act(() => ro.resize(600));
    expect(latest!.rail).toBe('sheet');
    view.unmount();
    expect(ro.observed()).toBe(0);
  });
});
