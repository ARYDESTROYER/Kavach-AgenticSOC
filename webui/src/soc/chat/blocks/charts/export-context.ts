/**
 * What a chart is SHOWING right now, for the card's image download (Round 12 P0-8): the
 * block after a client re-bin and a brush zoom, plus the series a legend toggle hid. A
 * chart writes it into the ref its card provides; the card reads it when "Download PNG /
 * SVG" is chosen, so the image is what the analyst was looking at. It is a ref, not
 * state: publishing never re-renders anything.
 */
import * as React from 'react';

import type { ChartBlock } from '../schema';

export interface ChartView {
  /** The block as drawn (re-binned, zoomed). */
  block: ChartBlock;
  /** `hidden[k]`: series k is hidden by its legend toggle (colours stay bound to k). */
  hidden: readonly boolean[];
}

export type ChartViewRef = React.MutableRefObject<ChartView | null>;

export const ChartViewContext = React.createContext<ChartViewRef | null>(null);

/** Publish the view as currently drawn; it is cleared when the chart unmounts. */
export function usePublishChartView(block: ChartBlock, hidden: readonly boolean[]): void {
  const ref = React.useContext(ChartViewContext);
  const key = hidden.map((h) => (h ? 1 : 0)).join('');
  React.useEffect(() => {
    if (!ref) return undefined;
    const view: ChartView = { block, hidden: key.split('').map((c) => c === '1') };
    ref.current = view;
    return () => {
      if (ref.current === view) ref.current = null;
    };
  }, [ref, block, key]);
}
