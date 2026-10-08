/**
 * BudgetRing — today's AI spend against the daily budget, as a real meter (SPEC §8,
 * §10.9): `role="meter"` with min/max/now and an `aria-valuetext` that says the
 * numbers ("42% of today's AI budget used, $4.20 of $10.00"). Hidden by the caller
 * when there is no budget or no spend figure. Colour never carries the meaning alone:
 * the percentage is always printed beside the ring, and the level adds a word for
 * assistive tech.
 */
import { cn } from '@/lib/cn';
import { budgetValueText, type BudgetMeterValue } from './format';

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const LEVEL_STROKE: Record<BudgetMeterValue['level'], string> = {
  ok: 'stroke-primary',
  warn: 'stroke-warning',
  critical: 'stroke-critical',
};
const LEVEL_TEXT: Record<BudgetMeterValue['level'], string> = {
  ok: 'text-muted-foreground',
  warn: 'text-warning-text',
  critical: 'text-critical-text',
};

export interface BudgetRingProps {
  value: BudgetMeterValue;
  className?: string;
}

export function BudgetRing({ value, className }: BudgetRingProps) {
  const clamped = Math.max(0, Math.min(100, value.percent));
  const dash = (clamped / 100) * CIRCUMFERENCE;
  const levelWord = value.level === 'critical' ? ' Limit reached.' : value.level === 'warn' ? ' Nearing the limit.' : '';
  return (
    <span
      role="meter"
      aria-label="Today's AI budget"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-valuetext={`${budgetValueText(value)}.${levelWord}`}
      data-level={value.level}
      className={cn('inline-flex items-center gap-1 tabular-nums', LEVEL_TEXT[value.level], className)}
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
          className={LEVEL_STROKE[value.level]}
        />
      </svg>
      <span aria-hidden="true">{Math.round(value.percent)}%</span>
    </span>
  );
}
