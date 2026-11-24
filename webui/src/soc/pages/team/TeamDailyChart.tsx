/**
 * Work per day (Round 15 SPEC D3.11): the team's case work per calendar day, stacked by
 * at most seven kinds (closed, acknowledged, commented, reviewed, escalated, reopened and
 * other case work), on the Okabe-Ito categorical ramp, with a legend and a tooltip.
 * Sign-ins are not case work and are not drawn. recharts `stackId`; this module is part
 * of the lazy Team activity chunk.
 *
 * Every label is app-authored or an ISO date; nothing a person typed is drawn here.
 */
import * as React from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { fmtNumber } from '@/lib/format';
import type { TeamChartKind, TeamDay } from '@/lib/types-team';
import { categorical } from '@/soc/components/palette';

import { CHART_ORDER, CHART_WORDS, dayLabel } from './team-format';

const AXIS_TICK = { fill: 'hsl(var(--muted-foreground))', fontSize: 11 } as const;

/**
 * The ramp slot of each kind: one colour per kind, "other" on the neutral grey. Six of
 * the seven colours: `--chart-6` (slot 5) is skipped because in the light theme it nearly
 * matches `--chart-2` (acknowledged), worst under deuteranopia; `--chart-7` is the best
 * six-of-seven choice across both themes and every colour-vision type.
 */
const SLOT: Readonly<Record<TeamChartKind, number>> = {
  closed: 0,
  acknowledged: 1,
  commented: 2,
  reviewed: 3,
  escalated: 4,
  reopened: 6,
  other: 7,
};

/** The widest a day's bar is drawn, so a one-day range is a bar, not a slab. */
export const TEAM_BAR_MAX_PX = 48;

export function kindColor(kind: TeamChartKind): string {
  return categorical(SLOT[kind]);
}

interface TooltipEntry {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
}

function DayTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipEntry[]; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter((p) => typeof p.value === 'number' && p.value > 0);
  const total = rows.reduce((sum, p) => sum + (p.value as number), 0);
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-elev2">
      <div className="mb-1 font-medium text-foreground">{label}</div>
      {rows.length === 0 ? (
        <div className="text-muted-foreground">No case work</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {[...rows].reverse().map((p) => (
            <li key={String(p.dataKey)} className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
              <span className="text-muted-foreground">{p.name}</span>
              <span className="ml-auto font-mono font-semibold tabular-nums text-foreground">
                {fmtNumber(p.value as number)}
              </span>
            </li>
          ))}
          <li className="flex items-center gap-2 border-t border-border pt-1">
            <span className="text-muted-foreground">Total</span>
            <span className="ml-auto font-mono font-semibold tabular-nums text-foreground">{fmtNumber(total)}</span>
          </li>
        </ul>
      )}
    </div>
  );
}

export interface TeamDailyChartProps {
  days: TeamDay<TeamChartKind>[];
  height?: number;
}

/** The stacked bars, or nothing to draw when the window holds no case work. */
export function TeamDailyChart({ days, height = 240 }: TeamDailyChartProps) {
  const now = React.useMemo(() => new Date(), []);
  const data = React.useMemo(
    () => days.map((d) => ({ day: dayLabel(d.date, now), ...d.counts })),
    [days, now],
  );
  const totals = CHART_ORDER.map((kind) => ({
    kind,
    total: days.reduce((sum, d) => sum + (d.counts[kind] ?? 0), 0),
  }));
  const summary = totals
    .filter((t) => t.total > 0)
    .map((t) => `${CHART_WORDS[t.kind]} ${fmtNumber(t.total)}`)
    .join(', ');
  const shown = CHART_ORDER.filter((kind) => totals.find((t) => t.kind === kind)?.total);
  return (
    <div
      role="img"
      aria-label={`Case work per day over ${days.length} ${days.length === 1 ? 'day' : 'days'}: ${summary || 'none'}.`}
      style={{ height }}
      data-testid="team-daily-chart"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
          barCategoryGap="20%"
          maxBarSize={TEAM_BAR_MAX_PX}
        >
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis dataKey="day" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={12} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={44} />
          <Tooltip content={<DayTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.5)' }} />
          <Legend
            verticalAlign="bottom"
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
            // The words in the body ink, never the series colour (contrast in both themes).
            formatter={(value: string) => <span className="text-muted-foreground">{value}</span>}
          />
          {(shown.length ? shown : CHART_ORDER).map((kind, index, all) => (
            <Bar
              key={kind}
              dataKey={kind}
              name={CHART_WORDS[kind]}
              stackId="work"
              fill={kindColor(kind)}
              radius={index === all.length - 1 ? [3, 3, 0, 0] : undefined}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
