/**
 * NumberField — a validated numeric input for rule thresholds / tuner knobs (G6,
 * DESIGN_STANDARD §5.2). Stepper buttons + clamp-on-blur + optional unit suffix +
 * optional reset-to-default, all a11y-wired through `Field`.
 *
 * Contract:
 *  - controlled by `value: number` + `onChange(next: number)`.
 *  - while TYPING we keep the raw text so an operator can clear/edit mid-entry;
 *    on BLUR (and on stepper click) we parse, clamp to [min, max], snap to `step`
 *    granularity if a `step` is given, and commit the clamped number.
 *  - out-of-range / non-numeric text sets `aria-invalid` until blur clamps it.
 *  - `unit` renders as a muted suffix inside the field (e.g. "min", "%").
 *  - `defaultValue` (+ `onChange` back to it) powers an inline reset affordance.
 *  - stepper +/- buttons are IconButtons (≥24px target) and respect min/max. They move
 *    by `stepperStep` when given (a money field snaps typed values to the cent but steps
 *    by whole dollars), else by `step`.
 *
 * The clamp math is the load-bearing behavior (tested): a value below `min`
 * commits `min`, above `max` commits `max`, and empty/NaN commits `min` (or
 * `defaultValue` when provided).
 */
import * as React from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { Field } from './Field';
import { IconButton } from './IconButton';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

export interface NumberFieldProps {
  /** Visible label. */
  label: React.ReactNode;
  /** Optional helper text. */
  description?: React.ReactNode;
  /** Optional error text (in addition to the built-in range validation). */
  error?: React.ReactNode;
  /** Current numeric value (controlled). */
  value: number;
  /** Commit handler — receives the clamped/parsed number. */
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Step granularity for the +/- buttons AND blur snapping. Default 1. */
  step?: number;
  /** How far one +/- press (or ↑/↓) moves, when it should differ from `step`. */
  stepperStep?: number;
  /** Muted suffix inside the field (e.g. "min", "%", "events"). */
  unit?: string;
  /** Default value; shows a reset button when the current value differs. */
  defaultValue?: number;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  /** Optional slot on the label's right (e.g. a HelpTip). */
  labelAction?: React.ReactNode;
}

/** Clamp `n` into [min, max] and snap to `step` granularity around `min`. Exported for tests. */
export function clampNumber(
  n: number,
  { min, max, step }: { min?: number; max?: number; step?: number },
): number {
  let v = n;
  if (step && step > 0) {
    const anchor = min ?? 0;
    v = anchor + Math.round((v - anchor) / step) * step;
    // Guard against floating-point drift (e.g. 0.1 + 0.2).
    v = Number(v.toPrecision(12));
  }
  if (min != null && v < min) v = min;
  if (max != null && v > max) v = max;
  return v;
}

export const NumberField = React.forwardRef<HTMLInputElement, NumberFieldProps>(
  (
    {
      label,
      description,
      error,
      value,
      onChange,
      min,
      max,
      step = 1,
      stepperStep,
      unit,
      defaultValue,
      required,
      disabled,
      className,
      labelAction,
    },
    ref,
  ) => {
    // Raw text mirrors `value` unless the operator is actively editing.
    const [text, setText] = React.useState<string>(String(value));
    const [editing, setEditing] = React.useState(false);

    React.useEffect(() => {
      if (!editing) setText(String(value));
    }, [value, editing]);

    const parsed = text.trim() === '' ? NaN : Number(text);
    const invalid =
      editing &&
      text.trim() !== '' &&
      (Number.isNaN(parsed) || (min != null && parsed < min) || (max != null && parsed > max));

    const commit = React.useCallback(
      (raw: string) => {
        let n = raw.trim() === '' ? NaN : Number(raw);
        if (Number.isNaN(n)) n = defaultValue ?? min ?? 0;
        const clamped = clampNumber(n, { min, max, step });
        setText(String(clamped));
        setEditing(false);
        if (clamped !== value) onChange(clamped);
      },
      [defaultValue, min, max, step, value, onChange],
    );

    const increment = stepperStep && stepperStep > 0 ? stepperStep : step;
    const bump = React.useCallback(
      (dir: 1 | -1) => {
        const base = Number.isNaN(parsed) ? value : parsed;
        const next = clampNumber(base + dir * increment, { min, max, step });
        setEditing(false);
        setText(String(next));
        if (next !== value) onChange(next);
      },
      [parsed, value, increment, step, min, max, onChange],
    );

    const canReset = defaultValue != null && value !== defaultValue;
    const atMin = min != null && value <= min;
    const atMax = max != null && value >= max;

    const resetSlot = canReset ? (
      // A real ≥24px (min-h-6) target with the `text-xs` label token — the reset is an
      // interactive affordance, so it must clear WCAG 2.5.8 Target Size like the steppers.
      <button
        type="button"
        onClick={() => onChange(defaultValue as number)}
        disabled={disabled}
        className={cn(
          'inline-flex min-h-6 items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
          focusRing,
        )}
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        reset
      </button>
    ) : null;

    return (
      <Field
        label={label}
        description={description}
        error={error}
        required={required}
        className={className}
        labelAction={
          labelAction || resetSlot ? (
            <div className="flex items-center gap-2">
              {resetSlot}
              {labelAction}
            </div>
          ) : undefined
        }
      >
        {({ id, describedBy }) => (
          <div className="flex items-center gap-1">
            <IconButton
              label="Decrease"
              size="md"
              variant="outline"
              onClick={() => bump(-1)}
              disabled={disabled || atMin}
            >
              <Minus />
            </IconButton>
            <div className="relative flex-1">
              {/* Labeled via Field's <label htmlFor={id}> (id set below); the
                  association crosses the render-prop boundary so the linter can't
                  see it statically. */}
              {/* eslint-disable-next-line jsx-a11y/control-has-associated-label */}
              <input
                ref={ref}
                id={id}
                type="text"
                inputMode="decimal"
                value={text}
                disabled={disabled}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onFocus={() => setEditing(true)}
                onChange={(e) => {
                  setEditing(true);
                  setText(e.target.value);
                }}
                onBlur={(e) => commit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
                  else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    bump(1);
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    bump(-1);
                  }
                }}
                className={cn(
                  'flex h-9 w-full rounded-md border bg-background px-3 py-1 text-sm tabular-nums text-foreground transition-colors',
                  unit && 'pr-10',
                  invalid ? 'border-critical' : 'border-input hover:border-border-strong',
                  'focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50',
                  focusRing,
                )}
              />
              {unit ? (
                <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-2xs text-muted-foreground">
                  {unit}
                </span>
              ) : null}
            </div>
            <IconButton
              label="Increase"
              size="md"
              variant="outline"
              onClick={() => bump(1)}
              disabled={disabled || atMax}
            >
              <Plus />
            </IconButton>
          </div>
        )}
      </Field>
    );
  },
);
NumberField.displayName = 'NumberField';
