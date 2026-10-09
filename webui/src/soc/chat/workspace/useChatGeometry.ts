/**
 * useChatGeometry — the Chat frame's three zones from its MEASURED width (chat revamp
 * SPEC §10.1), never from viewport breakpoints: the app nav rail (240 / 64 px) and the
 * shell gutter already took their share before the frame is measured.
 *
 *   C_min = 640 px of conversation, always.
 *   History rail: docked (264 px + hairline) while frame − 265 ≥ C_min; else a 48 px
 *   icon strip (+ hairline); below a 640 px frame, a left Sheet.
 *   Report panel: a split (320–480 px, default 360, + its 9 px separator handle) only
 *   if the conversation keeps ≥ C_min — collapsing the docked rail to the strip first
 *   when that is enough — otherwise an overlay Sheet.
 *
 * Reference widths (SPEC §10.1): 1280/nav 240 → frame 992: rail docked, conversation
 * 727, panel overlay; 1280/nav 64 → frame 1168: strip + split, conversation 750;
 * 1440/nav 64 → frame 1328: docked + split, conversation 694.
 */
import * as React from 'react';

export const C_MIN = 640;
export const RAIL_WIDTH = 264;
export const STRIP_WIDTH = 48;
/** A zone's width including its 1 px hairline. */
export const RAIL_TOTAL = RAIL_WIDTH + 1;
export const STRIP_TOTAL = STRIP_WIDTH + 1;
export const PANEL_MIN = 320;
export const PANEL_MAX = 480;
export const PANEL_DEFAULT = 360;
/**
 * The split separator's hit target: the Case Manager split idiom (a 9 px transparent
 * handle around a centred 1 px hairline), wide enough to grab with a pointer.
 */
export const SPLIT_HANDLE_PX = 9;
/** The thread toolbar shows the conversation total from this width. */
export const TOOLBAR_TOTAL_MIN = 560;
/** Below this width the toolbar's History and Report controls drop their words. */
export const TOOLBAR_COMPACT_MAX = 480;

export type RailMode = 'docked' | 'strip' | 'sheet';
export type PanelMode = 'split' | 'overlay';

export interface ChatGeometryInput {
  /** The measured frame width; 0 = not measured yet (treated as roomy). */
  frameWidth: number;
  /** The viewer collapsed the docked rail to the strip. */
  railCollapsed: boolean;
  panelOpen: boolean;
  panelWidth: number;
}

export interface ChatGeometry {
  rail: RailMode;
  /** How the report panel shows when open. */
  panel: PanelMode;
  /** The conversation zone's width (frame minus the docked zones). */
  conversationWidth: number;
  /** Docking the rail is possible at this width (the strip is a choice, not forced). */
  railCanDock: boolean;
}

export function clampPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return PANEL_DEFAULT;
  return Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, value)));
}

/** The pure layout rule (exported for tests and the reference-width table). */
export function computeGeometry({ frameWidth, railCollapsed, panelOpen, panelWidth }: ChatGeometryInput): ChatGeometry {
  // Not measured yet (first paint, tests without layout): assume a roomy desktop frame.
  const width = frameWidth > 0 ? frameWidth : 1600;
  if (width < C_MIN) {
    return { rail: 'sheet', panel: 'overlay', conversationWidth: width, railCanDock: false };
  }
  const railCanDock = width - RAIL_TOTAL >= C_MIN;
  const baseRail: RailMode = railCanDock && !railCollapsed ? 'docked' : 'strip';
  const railTotal = (mode: RailMode) => (mode === 'docked' ? RAIL_TOTAL : STRIP_TOTAL);
  if (!panelOpen) {
    return { rail: baseRail, panel: 'split', conversationWidth: width - railTotal(baseRail), railCanDock };
  }
  const panelTotal = clampPanelWidth(panelWidth) + SPLIT_HANDLE_PX;
  if (width - railTotal(baseRail) - panelTotal >= C_MIN) {
    return { rail: baseRail, panel: 'split', conversationWidth: width - railTotal(baseRail) - panelTotal, railCanDock };
  }
  if (width - STRIP_TOTAL - panelTotal >= C_MIN) {
    return { rail: 'strip', panel: 'split', conversationWidth: width - STRIP_TOTAL - panelTotal, railCanDock };
  }
  return { rail: baseRail, panel: 'overlay', conversationWidth: width - railTotal(baseRail), railCanDock };
}

const RAIL_COLLAPSED_KEY = 'soc.chat.railCollapsed';
const PANEL_WIDTH_KEY = 'soc.chat.reportPanelWidth';

function readStorage(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage?.removeItem(key);
    else window.localStorage?.setItem(key, value);
  } catch {
    /* A presentation preference only: everything works without storage. */
  }
}

export interface UseChatGeometry extends ChatGeometry {
  frameRef: React.RefCallback<HTMLElement>;
  frameWidth: number;
  railCollapsed: boolean;
  setRailCollapsed: (collapsed: boolean) => void;
  panelWidth: number;
  /** Set the split panel width (clamped); `persist` stores it for this viewer. */
  setPanelWidth: (width: number, persist?: boolean) => void;
}

/**
 * Measure the frame with a ResizeObserver and derive the zones. The rail-collapsed
 * choice and the panel width are per-viewer presentation preferences (localStorage).
 */
export function useChatGeometry(panelOpen: boolean): UseChatGeometry {
  const [frameWidth, setFrameWidth] = React.useState(0);
  const [railCollapsed, setRailCollapsedState] = React.useState(() => readStorage(RAIL_COLLAPSED_KEY) === '1');
  const [panelWidth, setPanelWidthState] = React.useState(() => {
    const stored = readStorage(PANEL_WIDTH_KEY);
    return stored === null || stored.trim() === '' ? PANEL_DEFAULT : clampPanelWidth(Number(stored));
  });
  const observerRef = React.useRef<ResizeObserver | null>(null);

  const frameRef = React.useCallback<React.RefCallback<HTMLElement>>((node) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    const measure = (width?: number) => {
      const next = Math.round(width ?? node.getBoundingClientRect().width);
      setFrameWidth((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      measure(entry?.contentRect?.width);
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  React.useEffect(() => () => observerRef.current?.disconnect(), []);

  const setRailCollapsed = React.useCallback((collapsed: boolean) => {
    setRailCollapsedState(collapsed);
    writeStorage(RAIL_COLLAPSED_KEY, collapsed ? '1' : null);
  }, []);

  const setPanelWidth = React.useCallback((width: number, persist = false) => {
    const next = clampPanelWidth(width);
    setPanelWidthState(next);
    if (persist) writeStorage(PANEL_WIDTH_KEY, String(next));
  }, []);

  const geometry = computeGeometry({ frameWidth, railCollapsed, panelOpen, panelWidth });
  return { ...geometry, frameRef, frameWidth, railCollapsed, setRailCollapsed, panelWidth, setPanelWidth };
}
