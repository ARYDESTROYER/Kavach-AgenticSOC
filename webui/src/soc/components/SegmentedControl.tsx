/**
 * SegmentedControl — a single-select value picker styled as a segmented switch
 * (DESIGN_STANDARD §5.2). Replaces the hand-rolled toggle strips (Chat/Investigate,
 * density, stack-by, time-window). It is a VALUE selector, not a page-tab surface —
 * it emits `onValueChange`; render the panel yourself.
 *
 * a11y: built on Radix RadioGroup, so it exposes correct `role="radiogroup"` /
 * `role="radio"` + `aria-checked` semantics and arrow-key roving focus for free.
 * (It was previously built on Radix Tabs, which emitted `role="tab"` + an
 * `aria-controls` pointing at a `tabpanel` that never existed — a dangling reference,
 * since a value selector has no owned panel. RadioGroup is the correct primitive.)
 * Pass `aria-label` describing what the control selects. Icons inside options are
 * decorative (`aria-hidden`); the text label carries meaning.
 *
 * Sizing: `sm` (h-8) for toolbars, `md` (h-9) default. Options are equal-width when
 * `fitted`, otherwise sized to content.
 */
import * as React from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

export interface SegmentOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  /** Optional leading icon (decorative). */
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  /** Options in display order. */
  options: SegmentOption<T>[];
  /** Selected value (controlled). */
  value: T;
  onValueChange: (value: T) => void;
  /** Accessible name for the group. */
  'aria-label'?: string;
  /** Id(s) of the text that explains the choice (read after the group's name). */
  'aria-describedby'?: string;
  size?: 'sm' | 'md';
  /** Equal-width segments filling the container. Default false. */
  fitted?: boolean;
  disabled?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string = string>({
  options,
  value,
  onValueChange,
  size = 'md',
  fitted = false,
  disabled,
  className,
  ...rest
}: SegmentedControlProps<T>) {
  return (
    <RadioGroupPrimitive.Root
      value={value}
      // RadioGroup fires onValueChange only when the value actually changes.
      onValueChange={(v) => onValueChange(v as T)}
      disabled={disabled}
      aria-label={rest['aria-label']}
      aria-describedby={rest['aria-describedby']}
      // Horizontal layout → Left/Right arrows move the roving selection (matching the
      // visual order), not the default Up/Down.
      orientation="horizontal"
      className={cn(
        // A quiet segmented rail: squared hairline boundary and no resting elevation.
        // The consumer className lands on this single RadioGroup element.
        'inline-flex items-center gap-0.5 rounded-md border border-border/80 bg-transparent p-0.5 text-muted-foreground',
        size === 'sm' ? 'h-8' : 'h-9',
        fitted && 'flex w-full',
        className,
      )}
    >
      {options.map((opt) => (
        <RadioGroupPrimitive.Item
          key={opt.value}
          value={opt.value}
          disabled={disabled || opt.disabled}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium transition-colors',
            size === 'sm' ? 'h-6 px-2.5 text-xs' : 'h-7 px-3 text-sm',
            fitted && 'flex-1',
            'text-muted-foreground hover:text-foreground',
            'data-[state=checked]:bg-accent/70 data-[state=checked]:text-foreground',
            'disabled:pointer-events-none disabled:opacity-50',
            focusRing,
          )}
        >
          {opt.icon ? (
            <span className="[&_svg]:size-3.5 [&_svg]:shrink-0" aria-hidden="true">
              {opt.icon}
            </span>
          ) : null}
          {opt.label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
SegmentedControl.displayName = 'SegmentedControl';
