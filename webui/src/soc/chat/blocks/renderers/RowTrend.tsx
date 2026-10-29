/**
 * A row's trend (Round 14, SPEC §4.6.3, §4.7.3): a small sparkline of the row's counts
 * over the answer's window, newest on the right, for a table row (a rule, a severity
 * level). Five or more points draw a line; fewer draw dots, because a line through two or
 * three points suggests a shape the data does not have. A bucket that was not measured
 * breaks the line (never drawn as zero, G3), and a measured point left alone between two
 * gaps is a dot on it (never dropped).
 *
 * The drawing is decorative (`aria-hidden`); its text twin ("first 0, peak 57, latest 57")
 * is read instead, so the trend is never conveyed by shape alone.
 */
import { cn } from '@/lib/cn';
import { token } from '@/soc/components/palette';

import { trendSentence } from '../charts/SparklineChart';

const W = 64;
const H = 18;
const PAD = 2;
/** Below this many points a line would invent a shape: dots instead. */
export const LINE_MIN_POINTS = 5;

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The x and y of each measured point inside the sparkline box (null where not measured). */
export function trendGeometry(points: ReadonlyArray<number | null>): Array<{ x: number; y: number } | null> {
  const n = points.length;
  const peak = Math.max(0, ...points.filter(isNum));
  const scale = peak > 0 ? peak : 1;
  return points.map((v, i) => {
    if (!isNum(v)) return null;
    const x = n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - 2 * PAD);
    const y = H - PAD - (Math.max(0, v) / scale) * (H - 2 * PAD);
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  });
}

type TrendPoint = { x: number; y: number };

/**
 * The line's runs of consecutive measured points (a gap breaks the line). A run of one, a
 * measured point between two gaps, is kept: it is drawn as a dot, never dropped.
 */
export function trendRuns(geo: ReadonlyArray<TrendPoint | null>): TrendPoint[][] {
  const out: TrendPoint[][] = [];
  let run: TrendPoint[] = [];
  for (const p of geo) {
    if (p) run.push(p);
    else {
      if (run.length) out.push(run);
      run = [];
    }
  }
  if (run.length) out.push(run);
  return out;
}

export interface RowTrendProps {
  points: ReadonlyArray<number | null>;
  /** A palette token for the stroke (a severity level's own hue); primary by default. */
  tone?: string;
  className?: string;
}

export function RowTrend({ points, tone = 'primary', className }: RowTrendProps) {
  const geo = trendGeometry(points);
  const measured = geo.filter((p): p is TrendPoint => p !== null);
  const color = token(tone);
  const dots = measured.length < LINE_MIN_POINTS;
  return (
    <span className={cn('inline-flex items-center', className)} data-testid="row-trend" data-shape={dots ? 'dots' : 'line'}>
      <svg aria-hidden width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block shrink-0 overflow-visible">
        <rect x={0} y={H - 0.5} width={W} height={0.5} fill={token('muted-foreground', 0.35)} />
        {dots
          ? measured.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={1.75} fill={color} />)
          : trendRuns(geo).map((run, i) =>
              run.length === 1 ? (
                <circle key={i} cx={run[0].x} cy={run[0].y} r={1.75} fill={color} data-trend-dot="" />
              ) : (
                <polyline
                  key={i}
                  points={run.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ),
            )}
      </svg>
      <span className="sr-only">{measured.length ? `Trend: ${trendSentence(points, 'count')}` : 'No trend measured.'}</span>
    </span>
  );
}
