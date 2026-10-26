/**
 * The two Settings row layouts of `Field` (Round 14, SPEC §4.9.2 and §4.9.6), as
 * `FieldLayoutRenderer`s. They live with the lazy Settings primitives, not in Field
 * itself, because Field ships at first paint (Login and Wizard import it) and only
 * Settings-style rows use them (SPEC §3.4). `SettingRow` provides one of them to every
 * Field inside it through `FieldLayoutContext`; a single Field can take one through its
 * `layout` prop. Field wires the ids; these only place the parts.
 *
 * - `inlineFieldLayout`: the Settings row. The label (14px medium) and its description
 *   (13px muted, at most 42rem) on the left, the control on the row's end in a column
 *   `--setting-control-w` wide (16rem unless the row says otherwise; a narrower control
 *   such as a `NumberField` aligns to the column's end, so every control in a group
 *   shares one right edge); below 640px the control stacks under the description.
 * - `wideFieldLayout`: the Settings row for a wide control (a text area, a tag list, a
 *   segmented control). The same 14px medium label and 13px muted description, in that
 *   order, with the control at full width under them.
 */
import { cn } from '@/lib/cn';
import type { FieldLayoutRenderer } from '@/soc/components/Field';

/** The row label: 14px medium on a 20px line. */
const ROW_LABEL = 'text-base leading-5';

export const inlineFieldLayout: FieldLayoutRenderer = ({
  label,
  labelAction,
  control,
  description,
  descriptionId,
  error,
  errorId,
  className,
  rootProps,
  rootRef,
}) => (
  // DOM order stays label, control, description, error (reading order); the grid
  // areas place the description under the label and the control on the row's end.
  <div
    ref={rootRef}
    data-field-layout="inline"
    className={cn(
      'grid min-w-0 grid-cols-1 gap-x-6 gap-y-1',
      'sm:grid-cols-[minmax(0,1fr)_var(--setting-control-w,16rem)]',
      // With a description the control is centred on the label and the description
      // together; without one it shares the label's line.
      description
        ? "[grid-template-areas:'label'_'desc'_'control'_'error'] sm:[grid-template-areas:'label_control'_'desc_control'_'error_error']"
        : "[grid-template-areas:'label'_'control'_'error'] sm:[grid-template-areas:'label_control'_'error_error']",
      className,
    )}
    {...rootProps}
  >
    <div className={cn('flex min-w-0 items-center gap-2 [grid-area:label]', description ? 'sm:self-end' : 'sm:self-center')}>
      {label(ROW_LABEL)}
      {labelAction ? <div className="ml-auto shrink-0">{labelAction}</div> : null}
    </div>
    <div className="mt-1 flex min-w-0 items-center justify-start [grid-area:control] sm:mt-0 sm:justify-end sm:self-center">
      {control}
    </div>
    {description ? (
      <p id={descriptionId} className="max-w-[42rem] text-sm text-muted-foreground [grid-area:desc]">
        {description}
      </p>
    ) : null}
    {error ? (
      <p id={errorId} role="alert" className="text-xs font-medium text-critical-text [grid-area:error]">
        {error}
      </p>
    ) : null}
  </div>
);

export const wideFieldLayout: FieldLayoutRenderer = ({
  label,
  labelAction,
  control,
  description,
  descriptionId,
  error,
  errorId,
  className,
  rootProps,
  rootRef,
}) => (
  // The label, its description, then the control at full width (reading order is the
  // visual order), the error last.
  <div ref={rootRef} data-field-layout="wide" className={cn('min-w-0', className)} {...rootProps}>
    <div className="flex min-w-0 items-center gap-2">
      {label(ROW_LABEL)}
      {labelAction ? <div className="ml-auto shrink-0">{labelAction}</div> : null}
    </div>
    {description ? (
      <p id={descriptionId} className="mt-0.5 max-w-[42rem] text-sm text-muted-foreground">
        {description}
      </p>
    ) : null}
    <div className="mt-2 min-w-0">{control}</div>
    {error ? (
      <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-critical-text">
        {error}
      </p>
    ) : null}
  </div>
);
