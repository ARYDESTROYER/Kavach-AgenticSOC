/**
 * Field: the a11y form-row wrapper (DESIGN_STANDARD §5.2). Composes a label +
 * control + optional description + optional error into ONE correctly-wired unit
 * so rule editors / settings forms stop hand-rolling label association.
 *
 * Wiring (done for you):
 *  - a `useId()`-derived control id is passed to the child via a render-prop
 *    (`children(ids)`) OR auto-injected when `children` is a single element.
 *  - `<label htmlFor={id} id={labelId}>` (Radix Label): clicking the label focuses
 *    the control.
 *  - for controls whose real focusable node is NOT the element Field clones (Radix
 *    `<Select>` renders its `role="combobox"` on the DESCENDANT `<SelectTrigger>`, not
 *    on the `<Select>` Root that Field would clone), use the render-prop and spread
 *    `labelledBy` onto `<SelectTrigger>` (`id={id} aria-labelledby={labelledBy}`) so the
 *    trigger, not the DOM-less Root, carries the accessible name. See H4.
 *  - `aria-describedby` points at BOTH the description and (when present) the
 *    error node, so screen readers announce them.
 *  - `aria-invalid` + `aria-errormessage` are set on the control when `error` is
 *    truthy; the error text is `role="alert"` so it's announced live.
 *  - required fields get a visual `*` AND `aria-required` on the control.
 *
 * All strings render as plain text (#9), never `dangerouslySetInnerHTML`.
 *
 * Layout (Round 14, SPEC §4.9.2 and §4.9.6): `stacked` (the default) puts the label
 * above the control and the description below it (Carbon). `inline` is the Settings row:
 * the label (14px medium) and its description (13px muted, at most 42rem) on the left,
 * the control on the row's end in a column `--setting-control-w` wide (16rem unless the
 * row says otherwise; a narrower control such as a `NumberField` aligns to the column's
 * end, so every control in a group shares one right edge); below 640px the control
 * stacks under the description. `wide` is the Settings row for a wide control (a text
 * area, a tag list, a segmented control): the same 14px medium label and 13px muted
 * description as `inline`, in that order, with the control at full width under them.
 * A `SettingRow` provides `inline` (or `wide`) to every Field inside it through
 * `FieldLayoutContext`, so `NumberField`, `NumPref`, `TextPref` and the other
 * Field-based controls lay out as rows without a prop.
 *
 * Usage (render-prop, explicit; preferred when the control needs the ids):
 *   <Field label="Correlation window" description="Minutes" error={err}>
 *     {({ id, describedBy, invalid }) => (
 *       <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} />
 *     )}
 *   </Field>
 *
 * Usage (single-element, auto-injected; the common case):
 *   <Field label="Name"><Input /></Field>
 */
import * as React from 'react';
import { Label } from '@/ui/label';
import { cn } from '@/lib/cn';

/** How a Field arranges its label, control and description. */
export type FieldLayout = 'stacked' | 'inline' | 'wide';

/**
 * The layout a Field takes when it is not given one: `SettingRow` provides `inline` so
 * the controls inside a Settings group read as rows. Outside any provider: `stacked`.
 */
export const FieldLayoutContext = React.createContext<FieldLayout>('stacked');

/** The wiring passed to a render-prop child (and auto-injected for element children). */
export interface FieldControlProps {
  /** Stable control id: set on the control's `id`. */
  id: string;
  /**
   * Stable id of the visible `<label>`: set on the control's `aria-labelledby`.
   * REQUIRED for controls whose focusable node is a descendant Field cannot clone
   * (e.g. a Radix `<SelectTrigger>`), where `htmlFor` alone cannot name the control.
   */
  labelledBy: string;
  /** Space-joined ids for `aria-describedby` (description + error, present ones only). */
  describedBy: string | undefined;
  /** `aria-invalid`: true when `error` is set. */
  invalid: boolean | undefined;
  /** `aria-required` mirror of the Field `required` prop. */
  required: boolean | undefined;
}

export interface FieldProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The visible label text (plain text). */
  label: React.ReactNode;
  /** Optional helper text under the label. */
  description?: React.ReactNode;
  /** Error message; when set the control goes `aria-invalid` and this renders as `role="alert"`. */
  error?: React.ReactNode;
  /** Marks the field required (visual `*` + `aria-required`). */
  required?: boolean;
  /** Optional slot rendered on the right of the label row (e.g. a HelpTip / reset). */
  labelAction?: React.ReactNode;
  /** Hide the visible label but keep it for AT (still associated via htmlFor). */
  hideLabel?: boolean;
  /** Extra classes for the label (a dense dialog sets its labels at `text-xs`). */
  labelClassName?: string;
  /**
   * `stacked` (label above), `inline` (a Settings row, the control on the row's end) or
   * `wide` (a Settings row with the control under the label and its description).
   * Defaults to the `FieldLayoutContext`.
   */
  layout?: FieldLayout;
  /**
   * The control. Either a render-prop `(ids) => ReactNode` OR a single element
   * (its `id`/`aria-*` are auto-injected unless already set).
   */
  children: React.ReactNode | ((props: FieldControlProps) => React.ReactNode);
}

export const Field = React.forwardRef<HTMLDivElement, FieldProps>(
  (
    {
      label,
      description,
      error,
      required,
      labelAction,
      hideLabel,
      labelClassName,
      layout: layoutProp,
      className,
      children,
      ...rest
    },
    ref,
  ) => {
    const contextLayout = React.useContext(FieldLayoutContext);
    const layout = layoutProp ?? contextLayout;
    const inline = layout === 'inline';
    const wide = layout === 'wide';
    const base = React.useId();
    const id = `${base}-control`;
    const labelId = `${base}-label`;
    const descId = description ? `${base}-desc` : undefined;
    const errId = error ? `${base}-err` : undefined;
    const describedBy = [descId, errId].filter(Boolean).join(' ') || undefined;
    const invalid = error ? true : undefined;

    const controlProps: FieldControlProps = {
      id,
      labelledBy: labelId,
      describedBy,
      invalid,
      required: required || undefined,
    };

    // A single-element child may already carry its own `id`; the auto-inject path
    // preserves it (`id: childId ?? id`), so the visible `<Label htmlFor>` must point
    // at whatever id the control actually renders with; otherwise clicking the label
    // wouldn't focus the control and AT would lose the association.
    const childEl =
      typeof children !== 'function' && React.isValidElement(children)
        ? (children as React.ReactElement<Record<string, unknown>>)
        : null;
    const controlId = (childEl?.props.id as string | undefined) ?? id;

    let control: React.ReactNode;
    if (typeof children === 'function') {
      control = (children as (p: FieldControlProps) => React.ReactNode)(controlProps);
    } else if (childEl) {
      // Auto-inject wiring, but never clobber props the caller already set.
      control = React.cloneElement(childEl, {
        id: controlId,
        'aria-describedby':
          [childEl.props['aria-describedby'] as string | undefined, describedBy].filter(Boolean).join(' ') || undefined,
        'aria-invalid': childEl.props['aria-invalid'] ?? invalid,
        'aria-required': childEl.props['aria-required'] ?? (required || undefined),
      });
    } else {
      control = children;
    }

    const labelNode = (
      <Label
        htmlFor={controlId}
        id={labelId}
        className={cn((inline || wide) && 'text-base leading-5', labelClassName, hideLabel && 'sr-only')}
      >
        {label}
        {required ? (
          <span className="ml-0.5 text-critical-text" aria-hidden="true">
            *
          </span>
        ) : null}
      </Label>
    );

    if (inline) {
      // DOM order stays label, control, description, error (reading order); the grid
      // areas place the description under the label and the control on the row's end.
      return (
        <div
          ref={ref}
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
          {...rest}
        >
          <div
            className={cn(
              'flex min-w-0 items-center gap-2 [grid-area:label]',
              description ? 'sm:self-end' : 'sm:self-center',
            )}
          >
            {labelNode}
            {labelAction ? <div className="ml-auto shrink-0">{labelAction}</div> : null}
          </div>
          <div className="mt-1 flex min-w-0 items-center justify-start [grid-area:control] sm:mt-0 sm:justify-end sm:self-center">
            {control}
          </div>
          {description ? (
            <p id={descId} className="max-w-[42rem] text-sm text-muted-foreground [grid-area:desc]">
              {description}
            </p>
          ) : null}
          {error ? (
            <p id={errId} role="alert" className="text-xs font-medium text-critical-text [grid-area:error]">
              {error}
            </p>
          ) : null}
        </div>
      );
    }

    if (wide) {
      // A Settings row for a wide control: the label, its description, then the control
      // at full width (reading order is the visual order), the error last.
      return (
        <div ref={ref} data-field-layout="wide" className={cn('min-w-0', className)} {...rest}>
          <div className="flex min-w-0 items-center gap-2">
            {labelNode}
            {labelAction ? <div className="ml-auto shrink-0">{labelAction}</div> : null}
          </div>
          {description ? (
            <p id={descId} className="mt-0.5 max-w-[42rem] text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
          <div className="mt-2 min-w-0">{control}</div>
          {error ? (
            <p id={errId} role="alert" className="mt-1 text-xs font-medium text-critical-text">
              {error}
            </p>
          ) : null}
        </div>
      );
    }

    return (
      <div ref={ref} className={cn('space-y-1.5', className)} {...rest}>
        <div className="flex items-center justify-between gap-2">
          {labelNode}
          {labelAction ? <div className="shrink-0">{labelAction}</div> : null}
        </div>
        {control}
        {description ? (
          <p id={descId} className="text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
        {error ? (
          <p id={errId} role="alert" className="text-xs font-medium text-critical-text">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
Field.displayName = 'Field';
