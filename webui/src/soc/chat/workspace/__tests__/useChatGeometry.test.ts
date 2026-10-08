/**
 * The three-zone layout rule (chat revamp SPEC §10.1) at the reference widths: the
 * frame is the viewport minus the nav rail (240 / 64 px) and the 24 px gutters.
 */
import { describe, expect, it } from 'vitest';

import { C_MIN, PANEL_DEFAULT, clampPanelWidth, computeGeometry } from '../useChatGeometry';

const frame = (viewport: number, nav: 240 | 64 | 0) => viewport - nav - (viewport < 640 ? 32 : 48);
const geometry = (frameWidth: number, panelOpen = false, railCollapsed = false, panelWidth = PANEL_DEFAULT) =>
  computeGeometry({ frameWidth, panelOpen, railCollapsed, panelWidth });

describe('computeGeometry', () => {
  it('matches the 1280 px reference row', () => {
    // nav 240 → frame 992: docked rail, conversation 727, the panel is an overlay.
    expect(geometry(frame(1280, 240))).toMatchObject({ rail: 'docked', conversationWidth: 727 });
    expect(geometry(frame(1280, 240), true)).toMatchObject({ rail: 'docked', panel: 'overlay', conversationWidth: 727 });
    // nav 64 → frame 1168: 903 alone; with the panel the rail collapses to the strip (758).
    expect(geometry(frame(1280, 64))).toMatchObject({ rail: 'docked', conversationWidth: 903 });
    expect(geometry(frame(1280, 64), true)).toMatchObject({ rail: 'strip', panel: 'split', conversationWidth: 758 });
  });

  it('matches the 1440 and 1920 px reference rows', () => {
    expect(geometry(frame(1440, 240), true)).toMatchObject({ rail: 'strip', panel: 'split', conversationWidth: 742 });
    expect(geometry(frame(1440, 64), true)).toMatchObject({ rail: 'docked', panel: 'split', conversationWidth: 702 });
    expect(geometry(frame(1920, 240), true)).toMatchObject({ rail: 'docked', panel: 'split', conversationWidth: 1006 });
    expect(geometry(frame(1920, 64), true)).toMatchObject({ rail: 'docked', panel: 'split', conversationWidth: 1182 });
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
