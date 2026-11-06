/**
 * NumberField: the ONE numeric input (G6, DESIGN_STANDARD §5.2; Round 14, SPEC §4.9.2,
 * ui-standard "Forms"). Every number a person types goes through it: rule thresholds,
 * tuner knobs and every Settings preference (`NumPref` renders one). A raw
 * `type="number"` input anywhere else fails the console grammar guard.
 *
 * Contract:
 *  - controlled by `value` + `onChange(next: number)`. `value` may be absent (an unset
 *    preference shows an empty field).
 *  - while TYPING we keep the raw text so an operator can clear/edit mid-entry;
 *    on BLUR (and on Enter) we parse, clamp to [min, max], snap to `step` granularity
 *    and commit the clamped number. Out-of-range or non-numeric text sets
 *    `aria-invalid` until it is committed.
 *  - an EMPTY field on blur: `empty="default"` (the default) commits `defaultValue`,
 *    else `min`, else 0; `empty="keep"` commits nothing and shows the current value
 *    again (an empty field is the absence of a value, never a value the operator typed;
 *    Settings preferences use this, Item A2).
 *  - an UNEDITED field never commits: focusing a field and leaving it (Tab through a
 *    Settings section) rewrites nothing, even when the stored value is off the `step`
 *    grid or outside the bounds. Only text the operator typed is parsed, clamped and
 *    snapped.
 *  - Size (Round 14): the field is as wide as its numbers, not its column. `size` is
 *    `xs` (6rem), `sm` (8rem), `md` (12rem) or `full`; by default it starts at 8rem for
 *    values of up to four digits (the common case: counts, seconds, percentages) and
 *    12rem above that or without a `max`, and takes the next size up while the widest
 *    value, the unit and the steppers do not fit ("events" beside a 4-digit value and
 *    the steppers needs 12rem).
 *  - `unit` is a muted suffix INSIDE the field ("s", "min", "%", "USD"), never a label
 *    of its own beside the box.
 *  - Steppers (Round 14): the − and + buttons sit inside the field's right edge. They
 *    show when the field accepts values of up to four digits (a bounded `max` of 9,999
 *    or less), whatever the box width, or when the caller gives a `stepperStep`; they are
 *    omitted for larger values, where a step of 1 is useless; `steppers` overrides. They
 *    are pointer and touch conveniences outside the tab order (each is a 24px target),
 *    like a native number field's spin buttons.
 *  - Keyboard and semantics: the input is an APG spinbutton (`role="spinbutton"` with
 *    `aria-valuemin`, `aria-valuemax`, `aria-valuenow` and, with a unit,
 *    `aria-valuetext`), as a native number field is. ↑/↓ step, PageUp/PageDown step by
 *    ten. Home and End keep their text-editing meaning (the caret), since the value is
 *    typed: they never set the value to a bound.
 *  - `defaultValue` (+ `onChange` back to it) powers an inline "Reset" affordance.
 *
 * The clamp math is the load-bearing behavior (tested): a value below `min` commits
 * `min`, above `max` commits `max`.
 */
import * as React from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { Field } from './Field';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

export type NumberFieldSize = 'xs' | 'sm' | 'md' | 'full';

export interface NumberFieldProps {
  /** Visible label. */
  label: React.ReactNode;
  /** Optional helper text. */
  description?: React.ReactNode;
  /** Optional error text (in addition to the built-in range validation). */
  error?: React.ReactNode;
  /** Current numeric value (controlled). `null`/`undefined` shows an empty field. */
  value: number | null | undefined;
  /** Commit handler: receives the clamped or parsed number. */
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /**
   * Step granularity for the +/- buttons AND blur snapping. Default 1. `any` accepts any
   * value between the bounds without snapping (the steppers then move by 1, or by
   * `stepperStep`).
   */
  step?: number | 'any';
  /** How far one +/- press (or ↑/↓) moves, when it should differ from `step`. */
  stepperStep?: number;
  /** Muted suffix inside the field (e.g. "min", "%", "events"). */
  unit?: string;
  /** Default value; shows a reset button when the current value differs. */
  defaultValue?: number;
  /**
   * What an emptied field commits on blur: `default` (the default value, else `min`,
   * else 0) or `keep` (nothing: the current value is shown again).
   */
  empty?: 'default' | 'keep';
  /** Field width; see the module comment. Default derived from `max`, the unit and the steppers. */
  size?: NumberFieldSize;
  /** Show the − and + buttons. Default: values up to four digits, or a `stepperStep`. */
  steppers?: boolean;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  /** Optional slot on the label's right (e.g. a HelpTip). */
  labelAction?: React.ReactNode;
  /** Placeholder for an empty field. */
  placeholder?: string;
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

/** Decimal places of a step (0.01 → 2). */
function decimalsOf(step: number | undefined): number {
  if (!step || !Number.isFinite(step)) return 0;
  const text = String(step);
  if (text.includes('e-')) return Number(text.split('e-')[1]) || 0;
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Characters of the widest value a field accepts, or null when it is unbounded. Exported for tests. */
export function widestValueChars({ min, max, step }: { min?: number; max?: number; step?: number }): number | null {
  if (max == null || !Number.isFinite(max)) return null;
  const decimals = decimalsOf(step);
  const chars = (n: number) => {
    const whole = String(Math.trunc(Math.abs(n))).length;
    return whole + (decimals ? decimals + 1 : 0) + (n < 0 ? 1 : 0);
  };
  return Math.max(chars(max), min != null && Number.isFinite(min) ? chars(min) : 0);
}

/** The widths of the default sizes, in px (16px rem). */
const SIZE_PX: Record<Exclude<NumberFieldSize, 'full'>, number> = { xs: 96, sm: 128, md: 192 };

/**
 * The px a field needs for `chars` digits beside its unit and steppers: 8px a digit (13px
 * tabular figures), the 12px leading pad, the trailing room of {@link trailingRoom} at
 * 8px a unit character, and the 2px border. Exported for tests.
 */
export function numberFieldWidthNeeded(chars: number, unit: string | undefined, steppers: boolean): number {
  return chars * 8 + 12 + 8 + (unit ? unit.length * 8 + 4 : 0) + (steppers ? 50 : 0) + 2;
}

export interface NumberFieldSizeInput {
  min?: number;
  max?: number;
  step?: number;
  /** The unit inside the field; its room counts. */
  unit?: string;
  /** Whether the steppers show; defaults to the field's own rule (up to four digits). */
  steppers?: boolean;
  /**
   * The narrowest size to start from. Default: 8rem (`sm`) for values of up to four
   * digits, 12rem (`md`) above that or without a `max`. Settings preferences start from
   * 8rem whatever their digits (SPEC §4.9.6).
   */
  base?: Exclude<NumberFieldSize, 'full'>;
  /** The digits to plan the unit's room for when the field has no `max` (default 6). */
  unboundedChars?: number;
}

const SIZE_ORDER: NumberFieldSize[] = ['xs', 'sm', 'md', 'full'];

/**
 * The default width: from the base size (8rem for up to four digits, else 12rem), the
 * next size up while the widest value, the unit and the steppers do not fit, up to full.
 * Exported for tests.
 */
export function defaultNumberFieldSize(input: NumberFieldSizeInput): NumberFieldSize {
  const known = widestValueChars(input);
  const steppers = input.steppers ?? (known != null && known <= 4);
  const base = input.base ?? (known != null && known <= 4 ? 'sm' : 'md');
  const needed = numberFieldWidthNeeded(known ?? input.unboundedChars ?? 6, input.unit, steppers);
  for (const size of SIZE_ORDER.slice(SIZE_ORDER.indexOf(base))) {
    if (size === 'full' || needed <= SIZE_PX[size]) return size;
  }
  return 'full';
}

/** Steppers by default: the field accepts values of up to four characters, or the caller gives a stride. Exported for tests. */
export function defaultShowSteppers(input: { min?: number; max?: number; step?: number; stepperStep?: number }): boolean {
  if (input.stepperStep != null && input.stepperStep > 0) return true;
  return (widestValueChars(input) ?? Infinity) <= 4;
}

const SIZE_CLASS: Record<NumberFieldSize, string> = {
  xs: 'w-24',
  sm: 'w-32',
  md: 'w-48',
  full: 'w-full',
};

/**
 * The room the input keeps free on its right for the unit (about one `ch` a character
 * at 12px, plus its 4px gap) and the two 24px steppers, so typed digits never run under
 * them.
 */
function trailingRoom(unit: string | undefined, steppers: boolean): string {
  const parts = ['0.5rem'];
  if (unit) parts.push(`${unit.length}ch`, '0.25rem');
  if (steppers) parts.push('3.125rem');
  return `calc(${parts.join(' + ')})`;
}

const display = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '' : String(v));

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
      empty = 'default',
      size,
      steppers,
      required,
      disabled,
      className,
      labelAction,
      placeholder,
    },
    ref,
  ) => {
    // `any`: no snapping on commit; the steppers still need a stride.
    const snap = step === 'any' ? undefined : step;
    // Raw text mirrors `value` unless the operator is actively editing.
    const [text, setText] = React.useState<string>(display(value));
    const [editing, setEditing] = React.useState(false);

    React.useEffect(() => {
      if (!editing) setText(display(value));
    }, [value, editing]);

    const parsed = text.trim() === '' ? NaN : Number(text);
    const invalid =
      editing &&
      text.trim() !== '' &&
      (Number.isNaN(parsed) || (min != null && parsed < min) || (max != null && parsed > max));

    const commit = React.useCallback(
      (raw: string) => {
        setEditing(false);
        // Nothing typed (focus came and went, or the text was put back as it was): the
        // stored value stands as it is, even off the step grid or outside the bounds. A
        // field never rewrites a value the operator did not type.
        if (raw.trim() === display(value)) {
          setText(display(value));
          return;
        }
        let n = raw.trim() === '' ? NaN : Number(raw);
        if (Number.isNaN(n)) {
          if (empty === 'keep') {
            // An emptied or unreadable field is no value at all: show the current one again.
            setText(display(value));
            return;
          }
          n = defaultValue ?? min ?? 0;
        }
        const clamped = clampNumber(n, { min, max, step: snap });
        setText(String(clamped));
        if (clamped !== value) onChange(clamped);
      },
      [empty, defaultValue, min, max, snap, value, onChange],
    );

    const increment = stepperStep && stepperStep > 0 ? stepperStep : snap ?? 1;
    const bump = React.useCallback(
      (steps: number) => {
        const current = Number.isNaN(parsed) ? value : parsed;
        const base = current == null || !Number.isFinite(current) ? defaultValue ?? min ?? 0 : current;
        // Normalised like a snapped value, so a stride of 0.05 from 0.07 gives 0.12, never
        // 0.12000000000000001 (with `step="any"` there is no snapping to do it).
        const next = Number(clampNumber(base + steps * increment, { min, max, step: snap }).toPrecision(12));
        setEditing(false);
        setText(String(next));
        if (next !== value) onChange(next);
      },
      [parsed, value, defaultValue, increment, snap, min, max, onChange],
    );

    const canReset = defaultValue != null && value !== defaultValue;
    const current = value == null || !Number.isFinite(value) ? undefined : value;
    const atMin = min != null && current != null && current <= min;
    const atMax = max != null && current != null && current >= max;
    // Steppers follow the digits the field accepts (never the box width); the default
    // width then makes room for the digits, the unit and the steppers together.
    const showSteppers = steppers ?? defaultShowSteppers({ min, max, step: snap, stepperStep });
    const width = size ?? defaultNumberFieldSize({ min, max, step: snap, unit, steppers: showSteppers });
    // The spinbutton's value for assistive technology: the number being typed while it
    // reads as one, else the committed value.
    const typedNumber = editing && text.trim() !== '' && Number.isFinite(parsed) ? parsed : undefined;
    const valueNow = typedNumber ?? current;

    const resetSlot = canReset ? (
      // A real 24px (min-h-6) target with the `text-xs` label token: the reset is an
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
        Reset
      </button>
    ) : null;

    const stepperClass = cn(
      'pointer-events-auto inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors',
      'hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
      '[&_svg]:size-3.5',
    );

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
          // The visible field: one bordered box holding the number, its unit and the
          // steppers, so nothing hangs outside it. The input fills the box and reserves
          // room on its right for the unit and the steppers, which sit over that room:
          // a click on the unit (pointer-transparent) lands in the input, as it would on a
          // native field.
          <div
            className={cn(
              'relative flex h-9 max-w-full items-center rounded-md border bg-background text-sm text-foreground transition-colors',
              SIZE_CLASS[width],
              invalid ? 'border-critical' : 'border-input hover:border-border-strong',
              'has-[:focus-visible]:border-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background',
              disabled && 'cursor-not-allowed opacity-50',
            )}
            data-number-field={width}
          >
            {/* Labeled via Field's <label htmlFor={id}> (id set below); the
                association crosses the render-prop boundary so the linter can't
                see it statically. */}
            {/* eslint-disable-next-line jsx-a11y/control-has-associated-label */}
            <input
              ref={ref}
              id={id}
              type="text"
              // An editable APG spinbutton, as a native number field is exposed: its
              // bounds and value are announced, and the arrow keys step it.
              role="spinbutton"
              aria-valuemin={min}
              aria-valuemax={max}
              aria-valuenow={valueNow}
              aria-valuetext={unit && valueNow != null ? `${valueNow} ${unit}` : undefined}
              inputMode="decimal"
              autoComplete="off"
              value={text}
              placeholder={placeholder}
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
                } else if (e.key === 'PageUp') {
                  e.preventDefault();
                  bump(10);
                } else if (e.key === 'PageDown') {
                  e.preventDefault();
                  bump(-10);
                }
                // Home and End move the caret, as in any text field: the value is typed,
                // and jumping it to a bound (a cap of 1) on a caret key would be a trap.
              }}
              style={{ paddingRight: trailingRoom(unit, showSteppers) }}
              className={cn(
                'absolute inset-0 h-full w-full rounded-md bg-transparent pl-3 text-sm tabular-nums text-foreground outline-none',
                'placeholder:text-muted-foreground disabled:cursor-not-allowed',
              )}
            />
            {unit || showSteppers ? (
              <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5">
                {unit ? (
                  <span className="select-none whitespace-nowrap pr-1 text-xs text-muted-foreground" data-number-unit="">
                    {unit}
                  </span>
                ) : null}
                {showSteppers ? (
                  <>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Decrease"
                      aria-controls={id}
                      className={stepperClass}
                      onClick={() => bump(-1)}
                      disabled={disabled || atMin}
                    >
                      <Minus aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Increase"
                      aria-controls={id}
                      className={stepperClass}
                      onClick={() => bump(1)}
                      disabled={disabled || atMax}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </Field>
    );
  },
);
NumberField.displayName = 'NumberField';
