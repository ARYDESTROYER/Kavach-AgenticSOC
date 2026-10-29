/**
 * RulePreviewPanel (Round-5 G6, R5): the single highest-value trust feature: run a
 * detection rule's predicate against 7 to 14 days of RECENT data and show how many events
 * WOULD have matched, as a match-count histogram.
 *
 * THE HARD GUARANTEES (why this panel is safe):
 *  - It reads recent events through the RB `POST /api/rules/preview` endpoint, which
 *    runs on the SCOPED, READ-ONLY, HARD-CAPPED scatter-gather (#1) and evaluates the
 *    PURE predicate in-process. It NEVER calls `decide()` (#3), NEVER creates a case,
 *    NEVER escalates, and, critically, NEVER bills the LLM (#6, ZERO UsageDoc).
 *  - The optional "deterministic what-if" strip calls the PURE `previewDecision`
 *    wrapper (`POST /api/triage/preview-decision`), which re-uses the same pure
 *    `decide()` the pipeline calls and likewise bills nothing (#6).
 *  - Every log-derived value (histogram labels, sample rows) renders PLAIN text (#9).
 *
 * The histogram uses the existing recharts wrappers (`HBarChart`); recharts is already
 * a dep, so this adds no bundle. Buckets from the server are aggregated to a readable
 * set client-side (a 14-day window at hourly buckets is too many rows to show raw).
 *
 * Round 14 (SPEC §4.9.1, D26): the read-only guarantee is the help tip beside the Run
 * button, not a permanent box; the result sits on one tinted panel (no nested card);
 * "Matches over time" is a sentence-case label; the button shows a spinner only while it
 * runs (a spinning refresh glyph belongs to `RefreshButton` alone). Before the first run
 * one muted line says what Run preview does; a window with no events says so instead of
 * a rate over zero events.
 */
import * as React from 'react';
import { FlaskConical, Loader2, Play } from 'lucide-react';

import { Button } from '@/ui/button';
import { Panel } from '@/design-system/panel';
import { EmptyState } from '@/soc/components/EmptyState';
import { HelpTip } from '@/soc/components/HelpTip';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { HBarChart, type HBarDatum } from '@/soc/components/charts';
import { LoadError } from '@/soc/components/LoadError';

import { previewRule } from '../api';
import type { RuleForm } from '../types';
import { predicatesForPreview } from './preview-adapter';
import type { RulePreviewResult } from './types';

/* -------------------------------------------------- window presets --------- */

interface WindowPreset {
  value: string;
  label: string;
  /** Look-back in days. */
  days: number;
  /** Server histogram bucket width (minutes). */
  bucketMinutes: number;
  /** Client display aggregation (minutes), coarser than the server bucket. */
  displayMinutes: number;
}

/**
 * 7 and 14 days (RESEARCH_RULES_UX §6b: a window wide enough to capture weekday and
 * weekend). Also a fast 24h for a quick sanity check. Server buckets stay hourly;
 * the client re-aggregates to day buckets for the wide windows so the chart is legible.
 */
const WINDOW_PRESETS: WindowPreset[] = [
  { value: '24h', label: 'Last 24h', days: 1, bucketMinutes: 60, displayMinutes: 60 },
  { value: '7d', label: 'Last 7 days', days: 7, bucketMinutes: 60, displayMinutes: 1440 },
  { value: '14d', label: 'Last 14 days', days: 14, bucketMinutes: 60, displayMinutes: 1440 },
];

/** Hard cap on rendered bars so a wide window can never balloon the chart height (#29). */
const MAX_BARS = 60;

/** Format a bucket-start ISO string for the histogram axis (plain, locale-agnostic).
 * `widthMinutes` is the EFFECTIVE bucket width (after any bar-cap widening), so the
 * label granularity always matches what a bar actually spans. */
function bucketLabel(iso: string, widthMinutes: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  if (widthMinutes >= 1440) {
    // day bucket → YYYY-MM-DD
    return d.toISOString().slice(0, 10);
  }
  // hour bucket → MM-DD HH:00 (UTC, deterministic)
  return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 13)}:00`;
}

/**
 * Re-aggregate the server's histogram (fixed hourly buckets) into coarser display
 * buckets. Pure: floors each bucket-start to `displayMinutes` and sums counts. If the
 * result still exceeds {@link MAX_BARS} bars (e.g. a wide window shown at fine
 * granularity), the bucket width is doubled until the chart is legible, so the
 * histogram can never grow to thousands of px of scroll (#29).
 */
function toHistogramData(
  result: RulePreviewResult | null,
  displayMinutes: number,
): HBarDatum[] {
  if (!result || !result.histogram || result.histogram.length === 0) return [];
  const bucketize = (widthMs: number): Map<number, number> => {
    const sums = new Map<number, number>();
    for (const b of result.histogram) {
      const t = new Date(b.bucket).getTime();
      if (Number.isNaN(t)) continue;
      const floored = Math.floor(t / widthMs) * widthMs;
      sums.set(floored, (sums.get(floored) ?? 0) + (b.count || 0));
    }
    return sums;
  };
  let widthMs = Math.max(1, displayMinutes) * 60_000;
  let sums = bucketize(widthMs);
  while (sums.size > MAX_BARS) {
    widthMs *= 2;
    sums = bucketize(widthMs);
  }
  const widthMinutes = widthMs / 60_000;
  return Array.from(sums.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([ms, count]) => ({
      // Bar color comes from the ONE token authority via the chart's `colorToken`
      // prop (DESIGN_STANDARD §1.6/§5.4), not an inlined `hsl(var(--…))` literal.
      label: bucketLabel(new Date(ms).toISOString(), widthMinutes),
      value: count,
    }));
}

/**
 * A preview result the panel can render: the three counts are finite numbers and the
 * histogram is a list. Anything else (an older server, a proxy page, a stubbed write) is
 * reported as a failed preview instead of crashing the sheet. Exported for tests.
 */
export function isRenderablePreview(value: unknown): value is RulePreviewResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<RulePreviewResult>;
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  return (
    finite(v.matched) &&
    finite(v.scanned) &&
    finite(v.match_rate) &&
    (v.histogram === undefined || Array.isArray(v.histogram))
  );
}

/* ---------------------------------------------------------- component ------- */

export interface RulePreviewPanelProps {
  /** The rule form being previewed. Only detection-match rules have a predicate. */
  rule: RuleForm;
  /** Optional source scope (omit for all browse-capable sources). */
  sourceId?: string;
  /** Called after a successful preview so the parent can update the health chip. */
  onResult?: (result: RulePreviewResult) => void;
  /** Called when a preview errors (parent can flag health failed). */
  onError?: (err: unknown) => void;
}

/**
 * The preview panel. Renders a window picker + a "Run preview" button; on run it calls
 * the read-only `previewRule` endpoint and shows a match-count histogram + a summary.
 * Case-automation + anomaly tiers have no flat predicate to preview, so the panel
 * explains that instead of running a meaningless scan.
 */
export function RulePreviewPanel({ rule, sourceId, onResult, onError }: RulePreviewPanelProps) {
  const [windowValue, setWindowValue] = React.useState('7d');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [result, setResult] = React.useState<RulePreviewResult | null>(null);
  // The window preset the CURRENT `result` was actually run for. The histogram buckets
  // and summary must reflect THAT window, not whatever the SegmentedControl now shows;
  // otherwise switching the window (without re-running) re-buckets a stale result at a
  // mismatched granularity and can balloon the chart (#29).
  const [ranWindow, setRanWindow] = React.useState<string | null>(null);

  const preset = WINDOW_PRESETS.find((p) => p.value === windowValue) ?? WINDOW_PRESETS[1];
  const resultPreset =
    WINDOW_PRESETS.find((p) => p.value === ranWindow) ?? preset;
  const windowChangedSinceRun = result !== null && ranWindow !== null && ranWindow !== windowValue;
  const predicates = React.useMemo(() => predicatesForPreview(rule), [rule]);
  const previewable = predicates.length > 0;

  const run = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await previewRule({
        match: predicates,
        source_id: sourceId,
        from: `now-${preset.days}d`,
        bucket_minutes: preset.bucketMinutes,
        // Must stay within the backend cap (`_PreviewIn.limit` is `le=200`, the same
        // hard cap `GET /api/logs` uses). Sending >200 makes FastAPI reject the whole
        // request with a 422 before the handler runs, so the preview never returns.
        limit: 200,
      });
      if (!isRenderablePreview(res)) {
        throw new Error('The preview returned a response this Console cannot read. Try again.');
      }
      setResult(res);
      setRanWindow(windowValue);
      onResult?.(res);
    } catch (e) {
      setError(e);
      onError?.(e);
    } finally {
      setLoading(false);
    }
  }, [predicates, sourceId, preset.days, preset.bucketMinutes, windowValue, onResult, onError]);

  const histogram = React.useMemo(
    () => toHistogramData(result, resultPreset.displayMinutes),
    [result, resultPreset.displayMinutes],
  );

  if (!previewable) {
    return (
      <EmptyState
        icon={FlaskConical}
        compact
        title="Preview is for detection rules with conditions"
        description="This rule has no condition to run against recent events. Anomaly rules fire on a learned baseline, and case automation rules react after the decision. Add a detection condition to preview a match count."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          size="sm"
          aria-label="Preview window"
          value={windowValue}
          onValueChange={setWindowValue}
          options={WINDOW_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
        />
        <div className="flex items-center gap-1.5">
          {/* The read-only, no-cost guarantee, one tap away rather than a permanent box. */}
          <HelpTip
            label="About the preview"
            text="Counts how many recent events would have matched this rule, from a scoped, read-only and capped read of your sources. It never runs the AI, never creates a case and never escalates."
          />
          <Button size="sm" onClick={run} disabled={loading} aria-busy={loading || undefined}>
            {loading ? (
              <Loader2 className="animate-spin motion-essential" aria-hidden />
            ) : (
              <Play aria-hidden />
            )}
            {loading ? 'Running preview' : 'Run preview'}
          </Button>
        </div>
      </div>

      {error ? (
        <LoadError error={error} title="Preview failed" fallback="Could not run the preview." onRetry={run} />
      ) : null}

      {!result && !error && !loading ? (
        <p className="text-sm text-muted-foreground" data-testid="rule-preview-idle">
          Run a preview to count matches over the selected window.
        </p>
      ) : null}

      {result ? (
        <Panel as="div" className="space-y-3" data-testid="rule-preview-result">
            {windowChangedSinceRun ? (
              <p className="text-sm text-warning-text">
                Showing the last run over <span className="font-medium">{resultPreset.label}</span>.
                Select Run preview to refresh for <span className="font-medium">{preset.label}</span>.
              </p>
            ) : null}
            {result.scanned === 0 ? (
              // A rate over zero events means nothing, and the rule was not really tested.
              <p className="text-sm text-muted-foreground" data-testid="rule-preview-no-events">
                No events in this window to test against. Try a longer window.
              </p>
            ) : (
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                <span>
                  <span className="text-2xl font-semibold tabular-nums text-foreground">
                    {result.matched.toLocaleString()}
                  </span>{' '}
                  <span className="text-muted-foreground">matched</span>
                </span>
                <span className="text-muted-foreground">
                  of <span className="tabular-nums text-foreground">{result.scanned.toLocaleString()}</span>{' '}
                  events scanned
                </span>
                <span className="text-muted-foreground">
                  (<span className="tabular-nums">{(result.match_rate * 100).toFixed(1)}%</span> match rate)
                </span>
              </div>
            )}

            {result.hard_capped ? (
              <p className="text-sm text-warning-text">
                The scan hit the result cap, so the real match count over this window may be higher.
              </p>
            ) : null}

            {result.scanned === 0 ? null : histogram.length > 0 && result.matched > 0 ? (
              <div>
                <p className="mb-1 text-sm font-medium text-foreground">Matches over time</p>
                <HBarChart
                  data={histogram}
                  labelWidth={96}
                  colorToken="primary"
                  ariaLabel={`Match-count histogram, ${result.matched} matches across ${histogram.length} buckets`}
                />
              </div>
            ) : result.matched === 0 ? (
              <p className="text-sm text-muted-foreground">
                No matches in this window, so the rule would not have fired.
              </p>
            ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
RulePreviewPanel.displayName = 'RulePreviewPanel';
