/**
 * TimeRangePicker: the in-house compact time-range control for the three-zone
 * dashboard control bar (DESIGN_STANDARD §4.3, IMPLEMENTATION Dash-B).
 *
 * It is intentionally dependency-free: NO `@elastic/datemath`, NO `moment` (both
 * drag moment.js; REJECTED in the dep ledger §13). Ranges are stored as **relative
 * ES date-math strings** (`now-24h`/`now-7d`/`now`) and resolved to absolute ms at
 * render/query time via a small (~40-line) parser below, so a shared/bookmarked URL
 * always reflects "last 24h" rather than a frozen absolute window.
 *
 * Public surface:
 *   - `<TimeRangePicker value onChange refresh onRefreshChange onRefreshTick />`
 *     : a controlled Radix Popover with relative presets + an auto-refresh selector.
 *     Round 14 (SPEC §4.9.2, C8): the picker is the ONE page-level time control, in the
 *     page header's controls slot. A page that supports fewer ranges or cadences passes
 *     `presets` (its ranges, in order) and `refreshOptions` (its cadences); the trigger,
 *     the menu and the accessible names stay the same everywhere.
 *   - Pure helpers (fully unit-testable, no DOM): `parseDateMath`, `resolveRange`,
 *     `serializeRange`, `parseRange`, `PRESETS`, `REFRESH_OPTIONS`.
 *   - `useAutoRefresh(refresh, onTick)`: the interval hook that PAUSES on a hidden
 *     tab (Page Visibility API) and honours a `refresh` of `'off'`.
 *
 * URL round-trip: the parent owns where the range lives (the app uses a hash router
 * with `?`-query segments). We expose `serializeRange`/`parseRange` so a caller can
 * put `from`/`to` into any `URLSearchParams` and read them back verbatim.
 *
 * a11y: fully keyboard operable (Radix Popover + roving Tabs/Select); the trigger
 * carries an `aria-label` describing the current range; the auto-refresh Select has
 * an accessible name; every value is plain text (UNTRUSTED-safe: presets/labels are
 * app-authored, never operator/log-derived).
 */
import * as React from 'react';
import { Clock } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/ui/select';

/* -------------------------------------------------------------- types + data -- */

/** A time range as RELATIVE ES date-math strings + a human label. */
export interface TimeRange {
  /** ES date-math start, e.g. `now-24h`. */
  from: string;
  /** ES date-math end, e.g. `now`. */
  to: string;
  /** Human label shown on the trigger, e.g. `Last 24 hours`. */
  label: string;
}

/** An absolute (resolved) range in epoch-ms: what a query actually uses. */
export interface ResolvedRange {
  fromMs: number;
  toMs: number;
}

export type RefreshValue = 'off' | '5s' | '30s' | '1m' | '5m' | 'live';

/** The relative presets exposed in the picker (DESIGN_STANDARD §4.3). */
export const PRESETS: readonly TimeRange[] = [
  { from: 'now-15m', to: 'now', label: 'Last 15 minutes' },
  { from: 'now-1h', to: 'now', label: 'Last 1 hour' },
  { from: 'now-24h', to: 'now', label: 'Last 24 hours' },
  { from: 'now-7d', to: 'now', label: 'Last 7 days' },
  { from: 'now-30d', to: 'now', label: 'Last 30 days' },
];

/** The default range when a URL carries none. */
export const DEFAULT_RANGE: TimeRange = PRESETS[2]; // Last 24 hours

/** Auto-refresh options; default is Off (cost-metered). */
export const REFRESH_OPTIONS: readonly { value: RefreshValue; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'live', label: 'Live' },
  { value: '5s', label: '5 seconds' },
  { value: '30s', label: '30 seconds' },
  { value: '1m', label: '1 minute' },
  { value: '5m', label: '5 minutes' },
];

/** Compact trigger copy; the menu and aria-label retain the full option wording. */
const REFRESH_TRIGGER_LABEL: Record<RefreshValue, string> = {
  off: 'Off',
  live: 'Live',
  '5s': '5 sec',
  '30s': '30 sec',
  '1m': '1 min',
  '5m': '5 min',
};

/** Refresh cadence → poll interval in ms (`off` → 0 = never). */
export const REFRESH_MS: Record<RefreshValue, number> = {
  off: 0,
  '5s': 5_000,
  '30s': 30_000,
  '1m': 60_000,
  '5m': 300_000,
  // Live uses a visibility-aware five-second poll. It is deliberately explicit in
  // the UI even though the cadence matches 5s: Live is the dashboard's default,
  // continuously-following operating mode rather than an ad-hoc interval choice.
  live: 5_000,
};

/* -------------------------------------------------------- ES date-math parse -- */

/** Unit → milliseconds for the date-math grammar we support. */
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Truncate an epoch-ms timestamp to the start of the given rounding unit (`/d`, `/h`, …). */
function roundDown(ms: number, unit: string): number {
  const d = new Date(ms);
  switch (unit) {
    case 's':
      d.setMilliseconds(0);
      break;
    case 'm':
      d.setSeconds(0, 0);
      break;
    case 'h':
      d.setMinutes(0, 0, 0);
      break;
    case 'd':
      d.setHours(0, 0, 0, 0);
      break;
    case 'w': {
      // Round to the start of the week (Sunday), matching ES's default `/w`.
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - d.getDay());
      break;
    }
    default:
      return ms;
  }
  return d.getTime();
}

/**
 * Parse an ES date-math expression into epoch-ms. Supports the dashboard subset:
 *   - `now`
 *   - `now±<n><unit>` (e.g. `now-24h`, `now+30m`) with units s/m/h/d/w
 *   - a trailing rounding op `/<unit>` (e.g. `now-1d/d` = start of yesterday)
 *   - a bare ISO-8601 / epoch-ms absolute anchor (falls back to `Date.parse`)
 * Returns `null` on anything unparseable (caller falls back to a default).
 *
 * `nowMs` is injectable so tests are deterministic (defaults to `Date.now()`).
 */
export function parseDateMath(expr: string, nowMs: number = Date.now()): number | null {
  if (typeof expr !== 'string') return null;
  const s = expr.trim();
  if (!s) return null;

  if (s.startsWith('now')) {
    let ms = nowMs;
    let rest = s.slice(3);
    // Optional signed offset: (+|-)<digits><unit>
    const off = rest.match(/^([+-])(\d+)([smhdw])/);
    if (off) {
      const sign = off[1] === '-' ? -1 : 1;
      ms += sign * parseInt(off[2], 10) * UNIT_MS[off[3]];
      rest = rest.slice(off[0].length);
    }
    // Optional rounding: /<unit>
    const round = rest.match(/^\/([smhdw])/);
    if (round) {
      ms = roundDown(ms, round[1]);
      rest = rest.slice(round[0].length);
    }
    // Anything left over is malformed.
    return rest.length === 0 ? ms : null;
  }

  // Absolute anchor: epoch-ms (pure digits) or an ISO date string.
  if (/^\d+$/.test(s)) return Number(s);
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Resolve a {from,to} date-math range to absolute epoch-ms. Falls back to the
 * DEFAULT_RANGE bounds for an unparseable side so a query never gets `NaN`.
 */
export function resolveRange(range: TimeRange, nowMs: number = Date.now()): ResolvedRange {
  const fromMs = parseDateMath(range.from, nowMs) ?? nowMs - UNIT_MS.d;
  const toMs = parseDateMath(range.to, nowMs) ?? nowMs;
  return { fromMs, toMs };
}

/* ---------------------------------------------------------------- URL codec -- */

const FROM_KEY = 'from';
const TO_KEY = 'to';

/**
 * Serialize a range into flat query params (`?from=now-24h&to=now`). The label is
 * DERIVED on read (never persisted: it may change with i18n/preset edits), so the
 * URL stays minimal and forward-compatible.
 */
export function serializeRange(
  range: TimeRange,
  params: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  params.set(FROM_KEY, range.from);
  params.set(TO_KEY, range.to);
  return params;
}

/**
 * Derive a human label for a {from,to} pair: a known preset's label (from `presets`, the
 * shared list by default), else the raw pair.
 */
export function labelForRange(
  from: string,
  to: string,
  presets: readonly TimeRange[] = PRESETS,
): string {
  const matches = (p: TimeRange) => p.from === from && p.to === to;
  const hit = presets.find(matches) ?? PRESETS.find(matches);
  return hit ? hit.label : `${from} → ${to}`;
}

/**
 * Parse a range from query params (a `URLSearchParams` or a raw query string). Returns
 * `fallback` (`DEFAULT_RANGE` unless given) when either bound is absent, so a bare URL
 * still yields a valid range. `presets` names a page's own ranges (Round 14).
 */
export function parseRange(
  source: URLSearchParams | string,
  presets: readonly TimeRange[] = PRESETS,
  fallback: TimeRange = DEFAULT_RANGE,
): TimeRange {
  const params =
    typeof source === 'string'
      ? new URLSearchParams(source.replace(/^[?#]/, ''))
      : source;
  const from = params.get(FROM_KEY);
  const to = params.get(TO_KEY);
  if (!from || !to) return fallback;
  return { from, to, label: labelForRange(from, to, presets) };
}

/* ------------------------------------------------------------- auto-refresh -- */

/**
 * useAutoRefresh: fire `onTick` on the chosen cadence, PAUSING while the tab is
 * hidden (Page Visibility API) so a backgrounded dashboard never burns metered
 * queries. `'off'` (or a hidden tab) means no timer at all. The interval restarts
 * cleanly when the tab becomes visible again.
 */
export function useAutoRefresh(refresh: RefreshValue, onTick: () => void): void {
  // Keep the latest callback without re-arming the interval each render.
  const cb = React.useRef(onTick);
  React.useEffect(() => {
    cb.current = onTick;
  }, [onTick]);

  React.useEffect(() => {
    const ms = REFRESH_MS[refresh] ?? 0;
    if (ms <= 0) return;
    if (typeof window === 'undefined') return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const start = () => {
      if (timer != null || isHidden()) return;
      timer = setInterval(() => cb.current(), ms);
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (isHidden()) stop();
      else start();
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);
}

/* ---------------------------------------------------------------- component -- */

export interface TimeRangePickerProps {
  /** Current range (controlled). */
  value: TimeRange;
  /** Emitted when the operator picks a preset. */
  onChange: (range: TimeRange) => void;
  /** Current auto-refresh cadence (controlled). Default `'off'`. */
  refresh?: RefreshValue;
  /** Emitted when the operator changes the auto-refresh cadence. */
  onRefreshChange?: (refresh: RefreshValue) => void;
  /**
   * Called on each auto-refresh tick (paused on a hidden tab). When provided, the
   * picker owns the interval via `useAutoRefresh`; omit it if the parent drives its
   * own timer off `refresh`.
   */
  onRefreshTick?: () => void;
  /** ISO/ms timestamp of the last successful load, rendered as a "· HH:MM" stamp. */
  lastRefreshedMs?: number | null;
  className?: string;
  size?: 'sm' | 'md';
  /** Squared, low-contrast command-center chrome used by dense dashboard mastheads. */
  chrome?: 'default' | 'command';
  /**
   * The ranges this page supports, in order (Round 14). Defaults to the shared
   * {@link PRESETS}; Analytics passes the last 24 hours, 7 days and 30 days, Logs adds a
   * shorter range. The current `value` is always shown on the trigger, even when it is
   * not one of them (a range read from a shared link).
   */
  presets?: readonly TimeRange[];
  /**
   * The auto-refresh cadences this page supports (Round 14), as values from
   * {@link REFRESH_OPTIONS}, which keeps their order and labels. Defaults to all of
   * them; Logs passes `['off', 'live']`.
   */
  refreshOptions?: readonly RefreshValue[];
}

function formatStamp(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function TimeRangePicker({
  value,
  onChange,
  refresh = 'off',
  onRefreshChange,
  onRefreshTick,
  lastRefreshedMs,
  className,
  size = 'md',
  chrome = 'default',
  presets = PRESETS,
  refreshOptions,
}: TimeRangePickerProps) {
  const [open, setOpen] = React.useState(false);

  // The picker optionally owns the refresh interval (paused on hidden tab).
  useAutoRefresh(refresh, onRefreshTick ?? noop);

  const pick = React.useCallback(
    (preset: TimeRange) => {
      onChange({ ...preset });
      setOpen(false);
    },
    [onChange],
  );
  // The cadences offered: the page's own subset, in the shared order, and always the
  // current one (a cadence read from a shared link stays visible and selectable).
  const cadences = React.useMemo(
    () =>
      refreshOptions
        ? REFRESH_OPTIONS.filter((o) => refreshOptions.includes(o.value) || o.value === refresh)
        : REFRESH_OPTIONS,
    [refreshOptions, refresh],
  );

  const triggerH = size === 'sm' ? 'h-8' : 'h-9';
  const refreshLabel = REFRESH_OPTIONS.find((option) => option.value === refresh)?.label ?? refresh;
  const refreshTriggerLabel = REFRESH_TRIGGER_LABEL[refresh] ?? refreshLabel;
  const command = chrome === 'command';
  const rangeLabel = command
    ? value.label
        .replace(/ hours?$/i, 'h')
        .replace(/ days?$/i, 'd')
        .replace(/ weeks?$/i, 'w')
    : value.label;
  const commandChrome = command
    ? // 8px, concentric with every other button/select (Round 12; was a squared 3px).
      'rounded-md border-border/70 bg-transparent font-mono text-muted-foreground shadow-none hover:border-border-strong hover:bg-hover hover:text-foreground'
    : undefined;

  return (
    <div className={cn('inline-flex min-w-0 max-w-full items-center gap-2', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size={size === 'sm' ? 'sm' : 'default'}
            className={cn('gap-2 font-normal', commandChrome)}
            aria-label={`Time range: ${value.label}`}
          >
            <Clock className="opacity-70" aria-hidden="true" />
            <span className="tabular-nums">{rangeLabel}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Quick ranges</div>
          {/* A labelled GROUP of plain buttons, NOT a listbox/option composite (each
              button is its own tab stop with Enter/Space activation and there is no
              roving-tabindex/arrow navigation, so `listbox`/`option` would mis-announce
              the interaction model). `aria-current` marks the active range for AT. */}
          <div role="group" aria-label="Relative time ranges" className="flex flex-col gap-1">
            {presets.map((p) => {
              const active = p.from === value.from && p.to === value.to;
              return (
                <button
                  key={`${p.from}|${p.to}`}
                  type="button"
                  aria-current={active || undefined}
                  onClick={() => pick(p)}
                  className={cn(
                    // 6px items inside the 10px popover (concentric radii, Round 12).
                    'flex items-center justify-between rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                    active
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-foreground hover:bg-muted',
                  )}
                >
                  <span>{p.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">{p.from}</span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      {onRefreshChange ? (
        <Select value={refresh} onValueChange={(v) => onRefreshChange(v as RefreshValue)}>
          <SelectTrigger
            aria-label={`Auto-refresh interval: ${refreshLabel}`}
            // Keep the selected cadence visible at every width now that the separate
            // manual-refresh button owns the sole refresh glyph.
            className={cn(
              'w-24 gap-1.5 px-2',
              triggerH,
              commandChrome,
            )}
          >
            <span className="!inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
              {refresh === 'live' ? (
                <span
                  className="block size-2 shrink-0 animate-pulse rounded-full bg-success ring-2 ring-success/20 motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : null}
              {refreshTriggerLabel}
            </span>
          </SelectTrigger>
          <SelectContent>
            {cadences.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                <span className="inline-flex items-center gap-2">
                  {o.value === 'live' ? (
                    <span
                      className="h-2 w-2 animate-pulse rounded-full bg-success ring-2 ring-success/20 motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : null}
                  {o.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {lastRefreshedMs != null ? (
        <span className="hidden whitespace-nowrap text-xs text-muted-foreground tabular-nums sm:inline">
          · {formatStamp(lastRefreshedMs)}
        </span>
      ) : null}
    </div>
  );
}
TimeRangePicker.displayName = 'TimeRangePicker';

function noop() {
  /* no-op */
}
