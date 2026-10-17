/**
 * What a chart is SHOWING right now, for the card's image download (Round 12 P0-8): the
 * block after a client re-bin and a brush zoom, the zoom itself (so the image can say it
 * is a slice), and the series a legend toggle hid. A chart writes it into the ref its
 * card provides; the card reads it when "Download PNG / SVG" is chosen, so the image is
 * what the analyst was looking at. It is a ref, not state: publishing never re-renders
 * anything.
 */
import * as React from 'react';

import type { ChartBlock } from '../schema';

/** A brush zoom, in words the image can carry ("Zoomed to Jul 2026 – Oct 2026 (4 of 12 points)"). */
export interface ChartZoomView {
  /** The first and last shown positions' full labels. */
  first: string;
  last: string;
  /** Positions shown, of the whole series' positions. */
  shown: number;
  total: number;
}

export interface ChartView {
  /** The block as drawn (re-binned, zoomed). */
  block: ChartBlock;
  /** `hidden[k]`: series k is hidden by its legend toggle (colours stay bound to k). */
  hidden: readonly boolean[];
  /** The zoom the block is cut to, else null: the image must say it is a slice. */
  zoom: ChartZoomView | null;
}

export type ChartViewRef = React.MutableRefObject<ChartView | null>;

export const ChartViewContext = React.createContext<ChartViewRef | null>(null);

/**
 * The series toggles a chart hands to its card's ⋯ menu (Round 13, SPEC-chat T16): when
 * a line chart names every series whole at the line ends, it draws no legend, and the
 * menu's "Series" checkboxes (each with its line colour as a key) show and hide them
 * instead (at least one always stays visible).
 */
export interface ChartSeriesMenu {
  labels: readonly string[];
  /** `hidden[k]`: series k is hidden. */
  hidden: readonly boolean[];
  toggle: (index: number) => void;
  /** `colors[k]`: series k's line colour, drawn as a key beside its checkbox. */
  colors?: readonly string[];
}

/**
 * What a card lends the chart it draws inline (never the expanded sheet's copy):
 *  - `groupBy`: the card's "Group by" control, which the chart places at the left of its
 *    ONE 28 px control row (the zoom hint, range and Reset zoom sit on the right);
 *  - `publishSeries`: where the chart hands its series toggles when it draws no legend.
 */
export interface ChartControls {
  groupBy: React.ReactNode | null;
  publishSeries: ((menu: ChartSeriesMenu | null) => void) | null;
}

export const ChartControlsContext = React.createContext<ChartControls | null>(null);

/** Publish the view as currently drawn; it is cleared when the chart unmounts. */
export function usePublishChartView(block: ChartBlock, hidden: readonly boolean[], zoom: ChartZoomView | null = null): void {
  const ref = React.useContext(ChartViewContext);
  const key = hidden.map((h) => (h ? 1 : 0)).join('');
  const zoomKey = zoom ? JSON.stringify([zoom.first, zoom.last, zoom.shown, zoom.total]) : '';
  React.useEffect(() => {
    if (!ref) return undefined;
    const z = zoomKey ? (JSON.parse(zoomKey) as [string, string, number, number]) : null;
    const view: ChartView = {
      block,
      hidden: key.split('').map((c) => c === '1'),
      zoom: z ? { first: z[0], last: z[1], shown: z[2], total: z[3] } : null,
    };
    ref.current = view;
    return () => {
      if (ref.current === view) ref.current = null;
    };
  }, [ref, block, key, zoomKey]);
}
