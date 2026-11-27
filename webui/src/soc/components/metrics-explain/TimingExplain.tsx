/**
 * A lifecycle median you can hover and click (Round 16 SPEC §4.5 WP12; acceptance:
 * "MTTA, MTTR and dwell show p50, p90, mean and count, plus Show all N").
 *
 * Wraps the shown duration in the Explain trigger. Hover or focus gives the one-line
 * reading ("Median 24m over 40 cases; p90 2h, mean 51m"); a click, Enter, Space or tap
 * opens the panel with the clock's definition, p50, p90, mean, the longest time, the
 * count and, for MTTR, who closed the cases. Opening it reads the cases behind the
 * figure once (`GET /api/metrics/explain`), which adds the rank arithmetic of the median
 * and a "Show all N" button that opens them in a side sheet.
 *
 * Lazy-only (it imports the Explain kit): rendered by the Overview, the Analytics page
 * and the Response timing widget, never by an entry module.
 */
import * as React from 'react';

import { ExplainTrigger } from '@/design-system/explain';
import { getMetricExplain } from '@/lib/api-metrics-explain';
import type { MetricExplainResponse, MttrByDecider } from '@/lib/types-metrics-explain';
import type { StatBlock } from '@/soc/pages/Metrics.posture.api';

import { TIMING_DEFINITIONS, explainTiming, type TimingExplainInput } from './builders';

/**
 * The side sheet loads on first "Show all": its table, sheet and route-link modules stay
 * out of every page that only shows a figure.
 */
const SamplesSheet = React.lazy(() => import('./SamplesSheet').then((m) => ({ default: m.SamplesSheet })));

export interface TimingExplainProps {
  metric: TimingExplainInput['metric'];
  /** The figure's name, for example "Time to resolve". */
  title: string;
  block: StatBlock | undefined;
  /** The window the figure covers, in hours (0 for all time). */
  windowHours: number;
  /** The same window in words ("the last 24 hours"). */
  window: string;
  /** Where the window comes from, when it is not the time range above (an all-time tile). */
  windowSource?: string;
  byDecider?: MttrByDecider;
  /** The shown duration. */
  children: React.ReactNode;
  /** Told when the hover line or the panel opens or closes. */
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

type Load = { state: 'idle' } | { state: 'loading' } | { state: 'done'; data: MetricExplainResponse } | { state: 'failed' };

export function TimingExplain({
  metric,
  title,
  block,
  windowHours,
  window,
  windowSource,
  byDecider,
  children,
  onOpenChange,
  className,
}: TimingExplainProps) {
  const [load, setLoad] = React.useState<Load>({ state: 'idle' });
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [sheetRequested, setSheetRequested] = React.useState(false);
  const hostRef = React.useRef<HTMLSpanElement>(null);
  const loadKey = `${metric}|${windowHours}|${block?.count ?? ''}|${block?.p50 ?? ''}`;
  const loadedKey = React.useRef<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abortRef.current?.abort(), []);

  const fetchSamples = React.useCallback(() => {
    if (loadedKey.current === loadKey) return;
    loadedKey.current = loadKey;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoad({ state: 'loading' });
    getMetricExplain(metric, windowHours, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setLoad({ state: 'done', data });
      },
      () => {
        if (controller.signal.aborted) return;
        loadedKey.current = null;
        setLoad({ state: 'failed' });
      },
    );
  }, [loadKey, metric, windowHours]);

  const data = load.state === 'done' ? load.data : null;
  // The cases are listed only when they describe the figure on screen (same count).
  const matching = data && data.stat && block && data.stat.count === block.count && data.stat.p50 === block.p50 ? data : null;
  const explanation = React.useMemo(
    () =>
      explainTiming({
        metric,
        title,
        block,
        window,
        definition: TIMING_DEFINITIONS[metric],
        byDecider: matching?.by_decider ?? byDecider,
        samples: matching && !matching.hidden_by_scope ? matching.samples.map((s) => s.minutes ?? s.value) : undefined,
        sampleCount: matching?.sample_count,
        samplesOffset: matching?.samples_offset,
        windowSource,
      }),
    [metric, title, block, window, windowSource, byDecider, matching],
  );
  if (!explanation) return <>{children}</>;

  const measured = Boolean(block?.available) && (block?.count ?? 0) > 0;
  const showAll = matching && matching.samples.length > 0;
  const detail = measured ? (
    <div className="space-y-1.5" data-testid="timing-explain-detail">
      {load.state === 'loading' ? <p className="text-muted-foreground">Reading the cases behind this figure.</p> : null}
      {load.state === 'failed' ? <p className="text-muted-foreground">The cases behind this figure could not be read.</p> : null}
      {data && !matching ? (
        <p className="text-muted-foreground">The figure changed since it was shown. Refresh to list its cases.</p>
      ) : null}
      {matching?.samples_withheld ? <p className="text-muted-foreground">{matching.samples_withheld}</p> : null}
      {showAll ? (
        <button
          type="button"
          onClick={() => {
            setSheetRequested(true);
            setSheetOpen(true);
          }}
          className="inline-flex min-h-7 items-center rounded-md border border-border px-2 font-medium text-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {matching!.samples_truncated
            ? `Show ${matching!.samples.length.toLocaleString('en-US')} of ${matching!.visible_count.toLocaleString('en-US')}`
            : `Show all ${matching!.visible_count.toLocaleString('en-US')}`}
        </button>
      ) : null}
    </div>
  ) : undefined;

  return (
    <span ref={hostRef} className={className} data-timing-explain={metric}>
      <ExplainTrigger
        explanation={explanation}
        detail={detail}
        onOpenChange={(open) => {
          if (open && measured) fetchSamples();
          onOpenChange?.(open);
        }}
      >
        {children}
      </ExplainTrigger>
      {sheetRequested ? (
        <React.Suspense fallback={null}>
          <SamplesSheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            title={title}
            data={matching}
            onCloseAutoFocus={(event) => {
              const trigger = hostRef.current?.querySelector<HTMLElement>('[data-explain-trigger]');
              if (trigger) {
                event.preventDefault();
                trigger.focus();
              }
            }}
          />
        </React.Suspense>
      ) : null}
    </span>
  );
}
