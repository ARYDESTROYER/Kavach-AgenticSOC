/**
 * The composer meter's two gauges (Round 12, diagnosis/layout.md (f2)).
 *
 * - {@link ContextRing}: the ring in the composer bar is CONTEXT-WINDOW use (system
 *   prompt + history + draft ÷ `context_window`), the reading people expect from a ring
 *   beside a token count (Claude, Cursor). It used to be today's AI spend, which printed
 *   "0%" next to "≈ 3.2k" and read as an empty context.
 * - {@link BudgetBar}: today's spend against the daily AI budget, shown only inside the
 *   meter's popover. Under SPEC D5 chat is not paused by that budget and its spend is
 *   not counted in it, so it is a reference figure, not a composer-level gauge.
 *
 * Both are real meters (`role="meter"`, min/max/now and an `aria-valuetext` that says
 * the numbers). Colour never carries the meaning alone: the percentage is printed beside
 * the ring and the level adds words for assistive tech.
 */
import { cn } from '@/lib/cn';
import {
  budgetValueText,
  contextValueText,
  formatContextPercent,
  type BudgetMeterValue,
  type ContextMeterValue,
} from './format';

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const clampPercent = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

export interface ContextRingProps {
  value: ContextMeterValue;
  className?: string;
  /**
   * Drawn inside a control that names it (the narrow composer's meter button, SPEC-chat
   * T13): no meter role of its own, hidden from assistive tech.
   */
  decorative?: boolean;
}

/** Context-window use: a 16 px ring and its percentage ("<1%", "12%"). */
export function ContextRing({ value, className, decorative = false }: ContextRingProps) {
  const clamped = clampPercent(value.percent);
  const dash = (clamped / 100) * CIRCUMFERENCE;
  const high = value.level === 'high';
  const semantics = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({
        role: 'meter',
        'aria-label': 'Context window used',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': Math.round(clamped),
        'aria-valuetext': contextValueText(value),
      } as const);
  return (
    <span
      {...semantics}
      data-level={value.level}
      data-testid="context-ring"
      className={cn('inline-flex items-center gap-1 tabular-nums', high ? 'text-warning-text' : 'text-muted-foreground', className)}
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4 -rotate-90" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r={RADIUS} fill="none" strokeWidth="2" className="stroke-border" />
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
          className={high ? 'stroke-warning' : 'stroke-primary'}
        />
      </svg>
      <span aria-hidden="true">{formatContextPercent(value.percent)}</span>
    </span>
  );
}

const LEVEL_FILL: Record<BudgetMeterValue['level'], string> = {
  ok: 'bg-primary',
  warn: 'bg-warning',
  critical: 'bg-critical',
};

export interface BudgetBarProps {
  value: BudgetMeterValue;
  className?: string;
}

/** Today's spend against the daily AI budget: a thin bar for the meter's popover. */
export function BudgetBar({ value, className }: BudgetBarProps) {
  const clamped = clampPercent(value.percent);
  const levelWord = value.level === 'critical' ? ' Limit reached.' : value.level === 'warn' ? ' Nearing the limit.' : '';
  return (
    <span
      role="meter"
      aria-label="Daily AI budget"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-valuetext={`${budgetValueText(value)}.${levelWord}`}
      data-level={value.level}
      data-testid="budget-bar"
      className={cn('block h-1.5 w-full overflow-hidden rounded-full bg-border', className)}
    >
      <span
        aria-hidden="true"
        className={cn('block h-full rounded-full', LEVEL_FILL[value.level])}
        // A non-zero spend always shows a sliver, so "some" never looks like "none".
        style={{ width: `${clamped > 0 ? Math.max(clamped, 2) : 0}%` }}
      />
    </span>
  );
}
