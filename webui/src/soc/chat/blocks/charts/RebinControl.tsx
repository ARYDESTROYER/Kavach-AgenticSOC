/**
 * "Group by" for a calendar time series (Round 12 P0-8): Day · Week · Month … — the
 * block's own bucket first, then the coarser units the server allowed (`rebin.ts`). A
 * value picker (radio group), not a menu, so the current grouping is always visible.
 * Hidden on paper: a printed chart shows the grouping it was printed in. It carries no
 * margin or alignment of its own: the chart's one control row puts it on the left
 * (Round 13, SPEC-chat T16), and the card's own row when the chart is not drawn.
 */
import { SegmentedControl } from '@/soc/components/SegmentedControl';

import type { TimeBucket } from '../schema';
import { BUCKET_WORD } from './rebin';

export interface RebinControlProps {
  choices: readonly TimeBucket[];
  value: TimeBucket;
  onChange: (bucket: TimeBucket) => void;
  /** The chart's title, for the control's accessible name. */
  title: string;
}

export function RebinControl({ choices, value, onChange, title }: RebinControlProps) {
  if (choices.length < 2) return null;
  return (
    <div className="flex shrink-0 items-center gap-2" data-print-hide data-testid="chart-rebin">
      <span className="text-2xs text-muted-foreground" aria-hidden>
        Group by
      </span>
      <SegmentedControl<TimeBucket>
        size="sm"
        aria-label={`Group ${title} by`}
        value={value}
        onValueChange={onChange}
        options={choices.map((b) => ({ value: b, label: BUCKET_WORD[b] }))}
        className="h-7 [&>button]:h-5 [&>button]:px-2 [&>button]:text-2xs"
      />
    </div>
  );
}
