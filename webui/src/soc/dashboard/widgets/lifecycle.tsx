/**
 * `kpi.lifecycle_timing` "Response timing" (Round 5 / G7; Round 14, SPEC §4.4.3): time to
 * detect, acknowledge and resolve, and dwell time, each as the median (p50) with the
 * p90 and the cases it counts, from the server's posture rollup for the board window.
 *
 * A module like every other: its title and caption sit INSIDE its panel above four strip
 * cells (never a band header outside it). A figure the server did not measure reads
 * "Not measured", never a zero, with the server's reason ("No case has been acknowledged
 * yet") in the cell's help popover, so a long reason never lifts its numeral off the row.
 * Its numerals use the fixed size ladder, never larger than the board's headline strip.
 * Each help text states the server's own definition (`engine/metrics.py`
 * `lifecycle_intervals`). Plain text only (#9); advisory (#3).
 */
import * as React from 'react';

import { PANEL_PADDING_X, Panel } from '@/design-system/panel';
import { cn } from '@/lib/cn';
import { DASH, fmtDuration } from '@/lib/format';
import { KpiStripContext, KpiTile, KpiTileGrid, type KpiDelta, type KpiStripContextValue } from '@/soc/components/KpiTile';
import type { StatBlock } from '@/soc/pages/Metrics.posture.api';

import { isAvailable, statNumber, useDashboardData, useDashboardRequest } from '../DashboardDataProvider';
import type { DashboardRequest } from './requests';
import {
  StaleNote,
  WidgetCaption,
  WidgetExit,
  WidgetFrameContext,
  WidgetStateView,
  countOf,
  requestState,
  resolveTitle,
  signedDuration,
  staleOf,
  type WidgetProps,
} from './common';
import { sentence } from './kpi-eval';

export interface TimingCell {
  key: 'mttd' | 'mtta' | 'mttr' | 'dwell';
  label: string;
  help: string;
  value: string;
  context?: string;
  sub?: string;
}

/**
 * The four timings, each with the server's definition (`lifecycle_intervals`): detection
 * runs from the cluster's first event to case creation; the other three start at case
 * creation, or at detection when the case records it.
 */
export const TIMINGS: ReadonlyArray<{ key: TimingCell['key']; field: 'mttd_minutes' | 'mtta_minutes' | 'mttr_minutes' | 'dwell_minutes'; label: string; help: string }> = [
  {
    key: 'mttd',
    field: 'mttd_minutes',
    label: 'Time to detect',
    help: 'Median time from the first event of a case to the case being created.',
  },
  {
    key: 'mtta',
    field: 'mtta_minutes',
    label: 'Time to acknowledge',
    help: 'Median time from case creation, or detection when known, to the first acknowledgement by a person.',
  },
  {
    key: 'mttr',
    field: 'mttr_minutes',
    label: 'Time to resolve',
    help: 'Median time from case creation, or detection when known, to the case first being resolved or closed.',
  },
  {
    key: 'dwell',
    field: 'dwell_minutes',
    label: 'Dwell time',
    help:
      'Median time from case creation, or detection when known, to the first response (investigating, escalated, on hold, resolved or closed). This is time to first response, not time to detect.',
  },
];

/** The timings the posture comparison publishes (`compare=prev`), by cell. */
const COMPARED_FIELD: Partial<Record<TimingCell['key'], string>> = {
  mtta: 'mtta_p50',
  mttr: 'mttr_p50',
};

/**
 * The change of a timing's p50 against the window before, where the server published
 * both figures and the read was not truncated (a partly counted previous window would
 * overstate the change). Lower is better for every timing.
 */
export function timingDelta(
  key: TimingCell['key'],
  posture: { compare?: unknown; truncated?: unknown } | null | undefined,
): KpiDelta | undefined {
  const field = COMPARED_FIELD[key];
  if (!field || !posture || posture.truncated === true) return undefined;
  const block = (posture.compare as Record<string, { value?: unknown; prev?: unknown }> | undefined)?.[field];
  const cur = block?.value;
  const prev = block?.prev;
  if (typeof cur !== 'number' || typeof prev !== 'number' || !Number.isFinite(cur) || !Number.isFinite(prev)) return undefined;
  const d = cur - prev;
  return { value: d, label: signedDuration(d) };
}

/**
 * One cell per timing: p50 with p90 and the count, or "Not measured" (short, so the
 * numerals stay on one row) with the server's reason added to the help.
 */
export function timingCells(lifecycle: Partial<Record<string, StatBlock | undefined>> | undefined): TimingCell[] {
  return TIMINGS.map((t) => {
    const block = lifecycle?.[t.field];
    const p50 = statNumber(block?.p50 as number | string | undefined);
    if (!isAvailable(block) || p50 == null) {
      const reason = block?.reason ? sentence(block.reason) : 'No case in the window has this figure yet.';
      return { key: t.key, label: t.label, help: `${t.help} Not measured. ${reason}`, value: DASH, sub: 'Not measured' };
    }
    const p90 = statNumber(block?.p90 as number | string | undefined);
    const count = typeof block?.count === 'number' ? block.count : null;
    const context = [p90 != null ? `p90 ${fmtDuration(p90)}` : null, count != null ? countOf(count, 'case') : null]
      .filter(Boolean)
      .join(' · ');
    return { key: t.key, label: t.label, help: t.help, value: fmtDuration(p50), context: context || undefined };
  });
}

const STRIP_CONTEXT: KpiStripContextValue = { density: 'comfortable' };
const POSTURE_REQ: DashboardRequest = { key: 'posture' };

export function LifecycleTimingWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Response timing');
  const mode = React.useContext(WidgetFrameContext);
  const { windowInfo, retry } = useDashboardData();
  const answer = useDashboardRequest({ key: 'posture' });
  const posture = answer.data;
  const state = requestState(answer, () => retry(POSTURE_REQ));
  const stale = state ? null : staleOf(answer, () => retry(POSTURE_REQ));
  const cells = timingCells(posture?.lifecycle as Partial<Record<string, StatBlock | undefined>> | undefined);
  const partial = posture && posture.window_covered === false;
  const edit = mode === 'edit';
  return (
    <Panel
      title={title}
      actions={
        // MTTA, MTTR and dwell are listed on Analytics' Performance tab.
        <WidgetExit target={{ label: 'View performance', page: 'metrics', opts: { tab: 'performance' } }} />
      }
      padding="none"
      // In a fixed edit-mode cell the panel fills the cell and the region under the
      // caption scrolls, so a short cell never cuts the figures off.
      className={cn('flex h-full flex-col', edit && 'min-h-0 overflow-hidden')}
      data-widget-timing=""
    >
      <div className={PANEL_PADDING_X}>
        <WidgetCaption>{`${windowInfo.label} · p50, with p90 and the cases counted`}</WidgetCaption>
        {stale ? <StaleNote stale={stale} /> : null}
      </div>
      <div className={cn('min-w-0', edit && 'min-h-0 flex-1 overflow-auto')} data-widget-scroll={edit ? '' : undefined}>
      {state ? (
        <div className={cn(PANEL_PADDING_X, 'pb-4 xl:pb-5 3xl:pb-6')}>
          <WidgetStateView state={state} title={title} />
        </div>
      ) : (
        <KpiStripContext.Provider value={STRIP_CONTEXT}>
          <KpiTileGrid count={cells.length} surface="panel" aria-label={title}>
            {cells.map((c) => {
              const delta = c.sub ? undefined : timingDelta(c.key, posture);
              // The comparison's words lead the context line (see the strip).
              const context = delta ? [`vs prior ${windowInfo.short}`, c.context].filter(Boolean).join(' · ') : c.context;
              return (
                <KpiTile
                  key={c.key}
                  testId={`timing-${c.key}`}
                  label={c.label}
                  value={c.value}
                  context={context}
                  sub={c.sub}
                  help={c.help}
                  helpLabel={`About ${c.label}`}
                  delta={delta}
                  goodDirection="down"
                  roll={false}
                  // The fixed hero ladder (30/24/20 px): this module's numerals never
                  // outgrow the board's headline strip, whose cells are narrower.
                  size="default"
                  numeral="hero"
                />
              );
            })}
          </KpiTileGrid>
        </KpiStripContext.Provider>
      )}
      {partial ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground xl:px-5 3xl:px-6">
          About: {posture?.window_coverage_reason || 'part of the window could not be read.'}
        </p>
      ) : null}
      </div>
    </Panel>
  );
}
