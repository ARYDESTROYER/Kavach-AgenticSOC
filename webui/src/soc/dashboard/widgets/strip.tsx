/**
 * `kpi.strip` (Round 14, SPEC §4.4.3): six headline figures for one board, read from the
 * binding table (`kpi-bindings.ts`), evaluated by the one set of honesty rules
 * (`kpi-eval.ts`).
 *
 * Every cell has its own grant: a denied cell reads "No access" and is never fetched.
 * Case-derived cells read "Hidden while row-level scope is on." while row-level data
 * scope applies (D16) and are never fetched either. A value the source did not measure
 * reads "Not measured", never 0; a lower bound carries the "at least" mark and an
 * approximation says "about". The visible line under the numeral stays short (two lines
 * at most), so every numeral sits on the strip's one baseline; the source's reason goes
 * in the cell's help popover, which a keyboard reaches.
 *
 * The strip is the Overview's: `KpiStrip`'s composition on a grouped panel, sentence-case
 * labels, ink numerals (no colour flag on SLA breached: the approved board reads it in
 * ink), two columns below 768 px. A loading cell shows a skeleton numeral, never the dash
 * (which reads as "not measured"); failed cells, and cells that keep earlier figures
 * because a refresh failed (or has not answered within one refresh interval), are named
 * in one line with Retry inside the strip's panel. The line stays while they are read
 * again, its Retry busy ("Retrying"), so keyboard focus stays on it.
 * Values are plain text (#9); it never decides anything (#3).
 */
import * as React from 'react';

import { PANEL_PADDING_X, Panel } from '@/design-system/panel';
import { cn } from '@/lib/cn';
import { DASH, fmtNumber } from '@/lib/format';
import {
  KpiStripContext,
  KpiTile,
  KpiTileGrid,
  type KpiDelta,
  type KpiStripContextValue,
} from '@/soc/components/KpiTile';

import { useDashboardData, useDashboardRequests, type DashboardReader } from '../DashboardDataProvider';
import { kpiStripCells, type KpiStripBinding, type KpiStripPreset } from '../kpi-bindings';
import { bindingRequests, evaluateBinding, getPath, type KpiCellResult } from './kpi-eval';
import {
  RetryButton,
  SCOPED_SENTENCE,
  SCOPE_UNCONFIRMED_MESSAGE,
  WidgetFrameContext,
  countOf,
  optionChoice,
  resolveTitle,
  shareText,
  signedDuration,
  staleOf,
  staleSentence,
  type StaleInfo,
  type WidgetProps,
} from './common';

const PRESETS: readonly KpiStripPreset[] = ['operations', 'detection', 'executive'];

const PRESET_LABEL: Readonly<Record<KpiStripPreset, string>> = {
  operations: 'SOC operations key figures',
  detection: 'Detection and data health key figures',
  executive: 'Executive summary key figures',
};

/** Why a cell shows no figure, when it is not the source's own reason. */
export type StripCellGate = 'ok' | 'denied' | 'scoped' | 'waiting' | 'unconfirmed';

export interface StripCellView {
  binding: KpiStripBinding;
  gate: StripCellGate;
  result: KpiCellResult | null;
}

/**
 * The gate of each cell for this viewer: its own grant first, then row-level scope for
 * a case-derived cell (`undefined` scope = not yet known, so it waits).
 */
export function stripCellGate(
  binding: KpiStripBinding,
  can: (resource: string, action: string) => boolean,
  objectScoped: boolean | undefined,
  scopeError = false,
): StripCellGate {
  if (!can(binding.grant.resource, binding.grant.action)) return 'denied';
  if (binding.caseDerived && objectScoped === true) return 'scoped';
  if (binding.caseDerived && objectScoped === undefined) return scopeError ? 'unconfirmed' : 'waiting';
  return 'ok';
}

/** The posture comparison each cell may show (`compare=prev` on the board window). */
const COMPARED: Readonly<Record<string, { field: string; format: 'count' | 'minutes' }>> = {
  new_cases: { field: 'case_count', format: 'count' },
  cases: { field: 'case_count', format: 'count' },
  mttr_p50: { field: 'mttr_p50', format: 'minutes' },
};

/**
 * The comparison a cell shows, where the server published one for this window. None
 * when the posture read was truncated: the previous window is then only partly counted,
 * so a change against it would overstate growth.
 *
 * The chip carries the signed change only; the "vs prior 24h" words lead the cell's
 * context line instead of sitting in the numeral row, where they wrapped under the
 * numeral and lifted it off the strip's shared baseline.
 */
export function cellDelta(binding: KpiStripBinding, read: DashboardReader): KpiDelta | undefined {
  const compared = COMPARED[binding.cell];
  if (!compared) return undefined;
  const posture = read({ key: 'posture' }).data;
  if (getPath(posture, 'truncated') === true) return undefined;
  const cur = getPath(posture, `compare.${compared.field}.value`);
  const prev = getPath(posture, `compare.${compared.field}.prev`);
  if (typeof cur !== 'number' || typeof prev !== 'number' || !Number.isFinite(cur) || !Number.isFinite(prev)) {
    return undefined;
  }
  const d = cur - prev;
  if (compared.format === 'minutes') return { value: d, label: signedDuration(d) };
  return { value: d, label: `${d > 0 ? '+' : d < 0 ? '-' : ''}${fmtNumber(Math.abs(d))}` };
}

/** The muted line under a measured figure: its population or denominator. */
function cellContext(binding: KpiStripBinding, result: KpiCellResult, read: DashboardReader, phrase: string): string | undefined {
  const data = (key: Parameters<DashboardReader>[0]['key']) => read({ key, window: binding.window }).data;
  switch (`${binding.group}.${binding.cell}`) {
    case 'operations.open_now':
      return 'any arrival date';
    case 'operations.awaiting_decision':
      return 'open, AI verdict Needs human';
    case 'operations.unassigned':
      return 'open, no assignee';
    case 'operations.sla_breached': {
      const open = getPath(data('shift'), 'sla_aging.totals.open');
      return typeof open === 'number' ? `of ${fmtNumber(open)} open` : 'past the response target';
    }
    case 'operations.new_cases':
    case 'executive.cases':
    case 'detection.alerts_ingested':
      return phrase;
    case 'operations.closed': {
      const created = getPath(read({ key: 'posture' }).data, 'case_count');
      return typeof created === 'number' ? `of ${fmtNumber(created)} created in the window` : phrase;
    }
    case 'detection.sources_reporting': {
      const rows = getPath(data('sourcesHealth'), 'sources');
      const enabled = Array.isArray(rows) ? rows.filter((r) => (r as { enabled?: unknown })?.enabled === true).length : null;
      return enabled == null ? phrase : `of ${fmtNumber(enabled)} enabled, ${phrase}`;
    }
    case 'detection.silent_sources':
      return 'right now';
    case 'detection.events_per_minute':
      return `mean, ${phrase}`;
    case 'detection.alert_reduction': {
      const noise = data('noise');
      const ingested = getPath(noise, 'stages[key=ingested].total');
      const cases = getPath(noise, 'stages[key=cases].total');
      return typeof ingested === 'number' && typeof cases === 'number'
        ? `${countOf(ingested, 'alert')} to ${countOf(cases, 'case')}`
        : phrase;
    }
    case 'detection.techniques_seen': {
      const total = getPath(data('coverage'), 'total_techniques');
      return typeof total === 'number' ? `in cases, of ${fmtNumber(total)}` : 'in cases';
    }
    case 'executive.confirmed_threats':
      // No hyphenated words on this line: its tabular figures widen a hyphen.
      return 'confirmed by an analyst';
    case 'executive.mttd_p50':
    case 'executive.mttr_p50': {
      const field = binding.cell === 'mttd_p50' ? 'mttd_minutes' : 'mttr_minutes';
      const n = getPath(read({ key: 'posture' }).data, `lifecycle.${field}.count`);
      return typeof n === 'number' ? `p50 of ${countOf(n, 'case')}` : 'p50';
    }
    case 'executive.closed_by_agent': {
      const decided = getPath(data('autoClose'), 'current.decided');
      if (result.share != null && typeof decided === 'number') {
        return `${shareText(result.share)} of ${fmtNumber(decided)} decided`;
      }
      return typeof decided === 'number' ? `of ${fmtNumber(decided)} decided` : phrase;
    }
    case 'executive.sla_attainment': {
      const n = getPath(read({ key: 'posture' }).data, 'sla.evaluated');
      return typeof n === 'number' ? `of ${countOf(n, 'case')} scored` : 'response and resolve';
    }
    default:
      return undefined;
  }
}

/**
 * The numeral's placeholder while a cell loads: the shared skeleton's fill and corner on
 * an inline box sized to the numeral (never the dash, which reads as "not measured").
 */
function NumeralSkeleton() {
  return (
    <>
      <span
        aria-hidden
        className="inline-block h-[0.8em] w-[2.2em] rounded-md bg-muted/75 align-baseline"
        data-kpi-skeleton=""
      />
      <span className="sr-only">Loading</span>
    </>
  );
}

/**
 * Props for one strip tile, from a cell's gate and result. The visible line under the
 * numeral is a short state ("Not measured", "At least this many", "About 4.2"), never the
 * source's whole reason: a reason of several lines would lift this cell's numeral off the
 * strip's shared baseline. The reason goes in the help popover ({@link stripCellHelp}).
 */
export function stripTileProps(
  view: StripCellView,
  context: string | undefined,
): { value: React.ReactNode; countTo?: number; sub?: string; bound?: string; context?: string } {
  const { gate, result } = view;
  if (gate === 'denied') return { value: DASH, sub: 'No access' };
  if (gate === 'scoped') return { value: DASH, sub: SCOPED_SENTENCE };
  if (gate === 'unconfirmed') return { value: DASH, sub: SCOPE_UNCONFIRMED_MESSAGE };
  if (gate === 'waiting' || !result || result.status === 'loading') return { value: <NumeralSkeleton /> };
  if (result.status === 'error') return { value: DASH, sub: 'Could not be loaded' };
  if (result.status === 'not_measured') return { value: DASH, sub: 'Not measured' };
  if (result.qualifier === 'at least') {
    return { value: result.text, countTo: result.value ?? undefined, bound: 'At least this many' };
  }
  if (result.qualifier === 'about') return { value: result.text, sub: `About ${result.text}` };
  return {
    value: result.text,
    countTo: view.binding.format === 'count' && result.value != null ? result.value : undefined,
    context,
  };
}

/**
 * The cell's help popover: its definition, then, when the figure is missing, partial or
 * approximate, the source's reason in full ("Not measured. The alert counters have not
 * measured this window yet.").
 */
export function stripCellHelp(view: StripCellView): string {
  const definition = view.binding.definition;
  const result = view.gate === 'ok' ? view.result : null;
  if (!result?.reason) return definition;
  const lead =
    result.status === 'not_measured'
      ? 'Not measured.'
      : result.status === 'error'
        ? ''
        : result.qualifier === 'at least'
          ? 'At least this many.'
          : result.qualifier === 'about'
            ? `About ${result.text}.`
            : '';
  return [definition, lead, result.reason].filter(Boolean).join(' ');
}

/**
 * Whether a cell shows figures that are not current: one of its reads holds an earlier
 * answer while its latest read failed (until a read succeeds) or has run past one
 * refresh interval without an answer.
 */
export function stripCellStale(view: StripCellView, read: DashboardReader): StaleInfo | null {
  if (view.gate !== 'ok' || !view.result || view.result.status === 'loading' || view.result.status === 'error') return null;
  return staleOf(bindingRequests(view.binding).map(read));
}

/** "New cases", "New cases and Closed", "3 figures": the cells a sentence names. */
function cellsNamed(cells: ReadonlyArray<{ label: string }>): string {
  if (cells.length === 1) return cells[0].label;
  if (cells.length === 2) return `${cells[0].label} and ${cells[1].label}`;
  return `${cells.length} figures`;
}

/** The oldest read time among held cells, when any is known. */
function oldestLoad(cells: ReadonlyArray<{ stale: StaleInfo }>): number | null {
  const times = cells.map((c) => c.stale.loadedAt).filter((t): t is number => t != null);
  return times.length ? Math.min(...times) : null;
}

/**
 * The strip's one failure line, from the cells that failed and the cells that keep
 * earlier figures. A failed cell says so in its own tile; a held cell still shows a
 * figure, so the line names it (or counts them, past two), and says whether its refresh
 * failed or has not answered yet ("Refreshing New cases is taking longer than usual.").
 */
export function stripFailureText(
  failed: number,
  stale: ReadonlyArray<{ label: string; stale: StaleInfo }>,
  unconfirmed: boolean,
): string | null {
  const parts: string[] = [];
  if (failed === 1) parts.push('One figure could not be loaded.');
  else if (failed > 1) parts.push(`${failed} figures could not be loaded.`);
  const refreshFailed = stale.filter((c) => c.stale.reason === 'failed');
  const slow = stale.filter((c) => c.stale.reason === 'slow');
  if (refreshFailed.length > 0) {
    parts.push(staleSentence(oldestLoad(refreshFailed), `${cellsNamed(refreshFailed)} could not be refreshed.`));
  }
  if (slow.length > 0) {
    parts.push(staleSentence(oldestLoad(slow), `Refreshing ${cellsNamed(slow)} is taking longer than usual.`));
  }
  if (parts.length === 0 && unconfirmed) return SCOPE_UNCONFIRMED_MESSAGE;
  return parts.length ? parts.join(' ') : null;
}

export function KpiStripWidget(props: WidgetProps) {
  const preset = optionChoice(props.options, 'preset', PRESETS, 'operations');
  // The strip's accessible name: the operator's title, else what the preset shows.
  const label = resolveTitle(props, PRESET_LABEL[preset]);
  const { can, objectScoped, scopeError, retryScope, windowHours, windowInfo, retry } = useDashboardData();
  const edit = React.useContext(WidgetFrameContext) === 'edit';
  const cells = React.useMemo(() => kpiStripCells(preset), [preset]);
  const gates = cells.map((b) => stripCellGate(b, can, objectScoped, scopeError));

  // Every request of every cell that may be read, plus the posture comparison the new
  // cases cell shows (the same read as its value).
  const reqs = cells.flatMap((b) => bindingRequests(b));
  const enabled = cells.flatMap((b, i) => bindingRequests(b).map(() => gates[i] === 'ok'));
  const read = useDashboardRequests(reqs, enabled);

  const nowMs = Date.now();
  const views: StripCellView[] = cells.map((binding, i) => ({
    binding,
    gate: gates[i],
    result: gates[i] === 'ok' ? evaluateBinding(binding, read, { windowHours, nowMs }) : null,
  }));
  const failed = views.filter((v) => v.result?.status === 'error');
  const staleCells = views.flatMap((v) => {
    const stale = stripCellStale(v, read);
    return stale ? [{ view: v, stale }] : [];
  });
  const unconfirmed = views.some((v) => v.gate === 'unconfirmed');
  // What Retry reads again: the failed cells and the cells whose refresh failed (a slow
  // read is still running; there is nothing to retry). It is busy while one of those
  // reads is in flight.
  const retryViews = [...failed, ...staleCells.filter((c) => c.stale.reason === 'failed').map((c) => c.view)];
  const retryReqs = retryViews.flatMap((v) => bindingRequests(v.binding));
  const retrying = retryReqs.some((req) => read(req).loading);
  const canRetry = retryViews.length > 0 || unconfirmed;
  const failureText = stripFailureText(
    failed.length,
    staleCells.map((c) => ({ label: c.view.binding.label, stale: c.stale })),
    unconfirmed,
  );
  const tiles = views.map((view) => {
    const measuredValue = view.result?.status === 'value' ? view.result : null;
    const delta = measuredValue && !measuredValue.qualifier ? cellDelta(view.binding, read) : undefined;
    const ctx = measuredValue ? cellContext(view.binding, measuredValue, read, windowInfo.phrase) : undefined;
    // The comparison's words lead the context line ("vs prior 24h · last 24 hours").
    const context = delta ? [`vs prior ${windowInfo.short}`, ctx].filter(Boolean).join(' · ') : ctx;
    const tile = stripTileProps(view, context);
    return (
      <KpiTile
        key={view.binding.cell}
        testId={`strip-${view.binding.cell}`}
        label={view.binding.label}
        value={tile.value}
        countTo={tile.countTo}
        format={fmtNumber}
        sub={tile.sub}
        bound={tile.bound}
        context={tile.context}
        help={stripCellHelp(view)}
        helpLabel={`About ${view.binding.label}`}
        delta={delta}
        goodDirection={view.binding.cell === 'mttr_p50' || view.binding.cell === 'mttd_p50' ? 'down' : 'none'}
        roll={false}
        size="fluid"
        numeral="hero"
      />
    );
  });

  // `KpiStrip`'s own composition (its context, a grouped panel, the tile grid), so the
  // failure line and its Retry sit INSIDE the strip's panel, never on the bare canvas.
  // In a fixed edit-mode cell the strip fills the cell and its tiles scroll inside it, so
  // a cell shorter than the strip never cuts a context line off.
  return (
    <div className={cn('min-w-0', edit && 'flex h-full min-h-0 flex-col')} data-widget-strip={preset}>
      <KpiStripContext.Provider value={STRIP_CONTEXT}>
        <Panel
          as="div"
          padding="none"
          role="group"
          aria-label={label}
          data-kpi-strip="comfortable"
          className={cn(edit && 'flex min-h-0 flex-1 flex-col')}
        >
          <div className={cn('min-w-0', edit && 'min-h-0 flex-1 overflow-auto')} data-widget-scroll={edit ? '' : undefined}>
            <KpiTileGrid count={tiles.length} surface="panel">
              {tiles}
            </KpiTileGrid>
          </div>
          {failureText ? (
            <div
              className={cn(
                'flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 py-2.5 text-sm text-muted-foreground',
                PANEL_PADDING_X,
              )}
              role="status"
              data-strip-failure=""
            >
              <span>{failureText}</span>
              {canRetry ? (
                <RetryButton
                  busy={retrying}
                  onRetry={() => {
                    if (unconfirmed) retryScope();
                    for (const req of retryReqs) retry(req);
                  }}
                />
              ) : null}
            </div>
          ) : null}
        </Panel>
      </KpiStripContext.Provider>
    </div>
  );
}

const STRIP_CONTEXT: KpiStripContextValue = { density: 'comfortable' };
