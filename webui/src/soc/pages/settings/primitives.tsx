/**
 * Settings shared form bits: the small building blocks every settings section
 * renderer composes (Round-5 Sett-A decomposition).
 *
 * Round 14 (SPEC §4.9.6, operator choice C9 option A, "grouped panels"): a section is
 * one `SettingsSection` (its `h2` title, a help tip, "Ask about this" and its actions in
 * one row, nothing else above the settings) holding `SettingsGroup`s: each group's title
 * (15px) and one-line caption sit above one tinted panel of `SettingRow`s divided by
 * hairlines, 40px between groups, the whole section capped at 44rem for forms (tables
 * take the full width). A row is a label (14px medium) and one muted line of help (13px,
 * at most 42rem) with the control on the row's end: a switch, a select, a field (any
 * Field-based control: `NumPref`, `TextPref`, `NumberField`, `SecretInput`), a status
 * (`StatusDot`) or an action; wide fields sit under their label; a link row opens
 * another page. Below 640px every field stacks under its label, so a field never draws
 * over its label on a phone. `SectionTitle`, `SectionShell` and `SettingsCard` remain
 * only until every section has moved (WP-W9a).
 *
 * These were previously private functions inside the 2673-line `Settings.tsx`
 * god-file. They now compose the shared `Field`, input, select, switch, and Settings
 * section primitives so every extracted `<section>.tsx` inherits one accessible,
 * divider-led command-surface grammar without a circular import back into the page.
 *
 * Security: every value rendered here is operator-entered (trusted). No secrets are
 * displayed; secret rows render a `configured` boolean only.
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import type { ModelConfig, ModelsResponse, Preferences } from '@/lib/types';
import { humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';
import { materialBar } from '@/lib/ui-recipes';
import { useScrollEdgeRef } from '@/design-system/material';
import { Panel } from '@/design-system/panel';
import { ChevronRight } from 'lucide-react';

import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

import {
  SETTINGS_FORM_MAX_WIDTH,
  SettingsTOC,
  type SettingsTOCItem,
} from '@/soc/components/SettingsGrid';
import { Field, FieldLayoutContext } from '@/soc/components/Field';
import {
  NumberField,
  defaultNumberFieldSize,
  widestValueChars,
  type NumberFieldSize,
} from '@/soc/components/NumberField';
import { safeRouteHref, useRouteLinkClick } from '@/soc/route-link';
import { SecretField } from '@/soc/components/SecretField';
import { HelpTip } from '@/soc/components/HelpTip';
import { AskAboutThis } from '@/soc/components/AskAboutThis';

/** The `{ prefs, update }` contract every top-level settings section renderer takes. */
export type SecProps = {
  prefs: Preferences;
  update: (p: Partial<Preferences>) => void;
};

/** A navigation callback passed to sections that deep-link to other pages. */
export type NavigateFn = (page: unknown, opts?: unknown) => void;

export function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

export interface SectionTitleProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: string;
  sub?: string;
  /** Optional actions that belong to this active settings section. */
  actions?: React.ReactNode;
}

export function SectionTitle({ title, sub, actions, className, ...rest }: SectionTitleProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-border/80 pb-5',
        className,
      )}
      {...rest}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
        {sub ? <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{sub}</p> : null}
      </div>
      {actions ? <div className="flex max-w-full flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </div>
  );
}

/** A subsection heading used to group related controls inside one Settings section. */
export function SubHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      {children}
    </div>
  );
}

/**
 * Track which anchored `SettingsCard` is currently in view, so the in-section TOC can
 * highlight it. Pure scroll-spy via IntersectionObserver; no-ops in non-DOM envs.
 */
export function useActiveAnchor(anchors: string[]): string {
  const [active, setActive] = React.useState<string>(anchors[0] ?? '');
  React.useEffect(() => {
    setActive((cur) => (anchors.includes(cur) ? cur : anchors[0] ?? ''));
    if (typeof document === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.intersectionRatio);
          else visible.delete(e.target.id);
        }
        let best = '';
        let bestRatio = -1;
        for (const [id, ratio] of visible) {
          if (ratio > bestRatio) {
            best = id;
            bestRatio = ratio;
          }
        }
        if (best) setActive(best);
      },
      { rootMargin: '-96px 0px -55% 0px', threshold: [0, 0.25, 0.5, 1] },
    );
    const els = anchors
      .map((a) => document.getElementById(a))
      .filter((el): el is HTMLElement => Boolean(el));
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
    // anchors is a stable literal per section; join for a stable dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchors.join('|')]);
  return active;
}

/**
 * The shared wrapper for a multi-card Settings section: a section title and, for
 * long sections (≥ 2 TOC items), a sticky in-section anchor TOC that scroll-spies the
 * cards. The TOC sits as a thin sticky bar above the cards and uses the full width.
 */
export function SectionShell({
  title,
  sub,
  toc,
  children,
  actions,
  rail,
}: {
  title: string;
  sub?: string;
  toc?: SettingsTOCItem[];
  children: React.ReactNode;
  /** Optional header actions rendered on the section title's right (e.g. Reset). */
  actions?: React.ReactNode;
  /**
   * Render the in-section anchor TOC as a LEFT vertical rail beside the cards (matching
   * the focused-section mockups) instead of the default horizontal sticky strip. Opt-in
   * per section so other sections keep the horizontal bar. Falls back to no rail when the
   * section has < 2 anchors.
   */
  rail?: boolean;
}) {
  const anchors = React.useMemo(() => (toc ?? []).map((t) => t.anchor), [toc]);
  const active = useActiveAnchor(anchors);
  const showToc = (toc?.length ?? 0) >= 2;
  // The horizontal strip's scroll-edge fade (declared before the rail's early return).
  const stripRef = useScrollEdgeRef<HTMLDivElement>(undefined, showToc && !rail);

  const heading = <SectionTitle title={title} sub={sub} actions={actions} />;

  // Vertical left-rail layout (opt-in): the anchor TOC sticks on the left, cards flow on
  // the right. Card anchors + scroll-spy are unchanged, so deep-links/tests still work.
  if (rail && showToc) {
    return (
      <div className="space-y-8">
        {heading}
        <div className="grid gap-6 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-8">
          <div className="overflow-x-auto border-y border-border/80 py-1 md:sticky md:top-[calc(var(--header-h)+1rem)] md:self-start md:overflow-visible md:border-y-0 md:border-r md:py-0 md:pr-5">
            <SettingsTOC
              items={toc!}
              active={active}
              orientation="responsive"
              className="min-w-max md:min-w-0"
            />
          </div>
          <div className="min-w-0">{children}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {heading}
      {showToc ? (
        // Sticky chrome over the scrolling section: the ONE Console material (solid under
        // reduced transparency or increased contrast), never a page-local translucent fill.
        // Pinned FLUSH under the top bar: an offset left a slit between the two through
        // which scrolled fields showed. Once pinned over scrolled content its top hairline
        // gives way to the top bar's own (no doubled rule) and the scroll-edge fade shows.
        // The horizontal scroll lives on an inner row: an `overflow` on the material itself
        // would clip that fade (it hangs below the bar) and scroll it into view.
        <div
          ref={stripRef}
          className={cn(
            'sticky top-[var(--header-h)] z-10 -mx-1 border-y border-border/80',
            'data-[scrolled=true]:border-t-transparent',
            materialBar,
          )}
        >
          <div className="overflow-x-auto px-1 py-1">
            <SettingsTOC items={toc!} active={active} orientation="horizontal" className="min-w-max flex-row gap-1" />
          </div>
        </div>
      ) : null}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------------------------ */
/* Round 14: SettingsSection, SettingsGroup, SettingRow (C9 option A, grouped panels)    */
/* ------------------------------------------------------------------------------------ */

/**
 * What the Settings shell knows about the active section and hands to its
 * `SettingsSection` without every renderer threading it: the "Ask about this" topic and
 * whether the section holds unsaved changes. A prop on the section wins over this.
 */
export interface SettingsSectionContextValue {
  /** The `console_map` topic of "Ask about this" (`settings:<id>`). */
  askTopic?: string;
  /** The section holds unsaved changes (it keeps room for the save bar under its last row). */
  modified?: boolean;
}

export const SettingsSectionContext = React.createContext<SettingsSectionContextValue>({});

export interface SettingsSectionProps {
  /** The section title, the same words as its entry in `settings-sections-meta.ts`; the section's `h2`. */
  title: string;
  /** One or two plain sentences on what the section controls, shown in a help tip beside the title. */
  help?: string;
  /** Section actions on the title row (Refresh as a `RefreshButton`, Add user). */
  actions?: React.ReactNode;
  /** "Ask about this" topic; defaults to the shell's `SettingsSectionContext`. */
  askTopic?: string;
  /** Unsaved changes in this section; defaults to the shell's context. Only keeps room for the save bar. */
  modified?: boolean;
  /** `form` (default): capped at 44rem so a control sits within reach of its label. `full`: a table section. */
  width?: 'form' | 'full';
  className?: string;
  children?: React.ReactNode;
}

/**
 * One Settings section: the title row and its groups. Nothing else sits above the
 * settings (no description line, no "Modified" text; the Settings rail's dot carries the
 * unsaved state and the save bar its count).
 */
export function SettingsSection({
  title,
  help,
  actions,
  askTopic,
  modified,
  width = 'form',
  className,
  children,
}: SettingsSectionProps) {
  const ctx = React.useContext(SettingsSectionContext);
  const topic = askTopic ?? ctx.askTopic;
  const dirty = modified ?? ctx.modified ?? false;
  const titleId = `${React.useId()}-title`;
  return (
    <section
      aria-labelledby={titleId}
      data-settings-section={width}
      className={cn(
        'min-w-0',
        width === 'form' ? SETTINGS_FORM_MAX_WIDTH : 'max-w-none',
        // The save bar pins over the bottom of the content: keep 72px of room under the
        // last row so it never covers a control.
        dirty && 'pb-[72px]',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-settings-section-title="">
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 id={titleId} className="min-w-0 break-words text-2xl text-foreground">
            {title}
          </h2>
          {help ? <HelpTip text={help} label={`About ${title}`} alwaysPopover /> : null}
        </div>
        {topic || actions ? (
          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
            {topic ? <AskAboutThis topic={topic} subject={title} /> : null}
            {actions}
          </div>
        ) : null}
      </div>
      <div className="mt-6 space-y-10 xl:mt-8">{children}</div>
    </section>
  );
}

export interface SettingsGroupProps {
  /** The group title (15px semibold, sentence case); an `h3` under the section `h2`. */
  title: string;
  /** One optional line under the title. */
  caption?: React.ReactNode;
  /** One trailing action on the title line (a "Test" or "Add" button). */
  action?: React.ReactNode;
  /** Anchor id for a deep link (`#/settings?s=<section>&a=<id>`). */
  id?: string;
  className?: string;
  /** The rows (`SettingRow`s), or a table or list that bleeds to the panel edge. */
  children?: React.ReactNode;
}

/**
 * One group of related settings: its title and caption above one tinted panel, on the
 * rows' inset (16px, 20px from 1280px), and the rows inside divided by hairlines.
 */
export function SettingsGroup({ title, caption, action, id, className, children }: SettingsGroupProps) {
  const generated = React.useId();
  const titleId = `${id ?? generated}-title`;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      data-settings-group=""
      className={cn('min-w-0 scroll-mt-24 space-y-2', className)}
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 px-4 xl:px-5">
        <div className="min-w-0">
          <h3 id={titleId} className="text-md font-semibold text-foreground">
            {title}
          </h3>
          {caption ? <p className="mt-0.5 max-w-[42rem] text-sm text-muted-foreground">{caption}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <Panel as="div" padding="none" className="divide-y divide-border/70" data-settings-panel="">
        {children}
      </Panel>
    </section>
  );
}

/** The row inset inside a group panel: 16px, 20px from 1280px. */
const ROW_PAD = 'px-4 py-3.5 xl:px-5';
const ROW_LABEL = 'text-base font-medium leading-5 text-foreground';
const ROW_HELP = 'mt-0.5 max-w-[42rem] text-sm text-muted-foreground';

interface SettingRowText {
  /** The setting's name (14px medium). Plain text. */
  label: string;
  /** One muted line of help (13px, at most 42rem). */
  help?: React.ReactNode;
  className?: string;
}

/** A switch on the row's end: the label names it. */
export interface SettingSwitchRowProps extends SettingRowText {
  variant: 'switch';
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** A select on the row's end (below 640px, under the label). */
export interface SettingSelectRowProps extends SettingRowText {
  variant: 'select';
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  disabled?: boolean;
  /** The control column's width (default 16rem). */
  controlWidth?: string;
}

/**
 * A Field-based control (`NumPref`, `NumberField`, `TextPref`, `SecretInput`, a
 * `Field`): it brings its own label, and the row lays it out (label and help on the
 * left, the control on the end in a `controlWidth` column, 16rem by default, every
 * control in a group sharing one right edge). `wide` puts a wide control (a text area,
 * a tag list, a segmented control) under its 14px label and 13px help line, at full
 * width, at every width (the Field `wide` layout). `mono` sets identifier values (field
 * paths) in 13px mono.
 */
export interface SettingFieldRowProps {
  variant: 'field';
  children: React.ReactNode;
  wide?: boolean;
  mono?: boolean;
  controlWidth?: string;
  className?: string;
}

/** A status on the row's end (a `StatusDot`), with an optional action after it. */
export interface SettingStatusRowProps extends SettingRowText {
  variant: 'status';
  status: React.ReactNode;
  action?: React.ReactNode;
}

/** One action on the row's end (a button that does something here). */
export interface SettingActionRowProps extends SettingRowText {
  variant: 'action';
  action: React.ReactNode;
}

/**
 * A row that opens another page: the whole row is a link, with a trailing value and a
 * chevron. A plain click goes through the router, so the Settings unsaved-changes guard
 * is asked first (a bare hash change would drop the draft, typed secrets included). Only
 * a safe href becomes a link: a hash route, a same-origin path or an http(s) URL;
 * anything else renders the row as text with its value and no link.
 */
export interface SettingLinkRowProps extends SettingRowText {
  variant: 'link';
  href: string;
  /** The trailing value ("5 of 5 enabled"). */
  value?: React.ReactNode;
}

export type SettingRowProps =
  | SettingSwitchRowProps
  | SettingSelectRowProps
  | SettingFieldRowProps
  | SettingStatusRowProps
  | SettingActionRowProps
  | SettingLinkRowProps;

function RowText({ label, help, htmlFor, helpId }: { label: string; help?: React.ReactNode; htmlFor?: string; helpId?: string }) {
  return (
    <div className="min-w-0 flex-1">
      {htmlFor ? (
        <Label htmlFor={htmlFor} className={cn('block cursor-pointer', ROW_LABEL)}>
          {label}
        </Label>
      ) : (
        <p className={ROW_LABEL}>{label}</p>
      )}
      {help ? (
        <p id={helpId} className={ROW_HELP}>
          {help}
        </p>
      ) : null}
    </div>
  );
}

/** The link variant of `SettingRow` (its own component: it holds the router click hook). */
function SettingLinkRow({ label, help, href, value, className }: SettingLinkRowProps) {
  const safeHref = safeRouteHref(href);
  const onClick = useRouteLinkClick(safeHref);
  const trailingValue = value ? (
    <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">{value}</span>
  ) : null;
  if (!safeHref) {
    return (
      <div data-setting-row="link" className={cn('flex items-center gap-4', ROW_PAD, className)}>
        <RowText label={label} help={help} />
        {trailingValue}
      </div>
    );
  }
  return (
    <a
      href={safeHref}
      onClick={onClick}
      data-setting-row="link"
      className={cn(
        'flex items-center gap-4 transition-colors hover:bg-hover',
        ROW_PAD,
        // The ring sits inside the row: the panel clips anything drawn outside it.
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        className,
      )}
    >
      <RowText label={label} help={help} />
      {trailingValue}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </a>
  );
}

/** One setting on a group panel; see the variants above. */
export function SettingRow(props: SettingRowProps) {
  const id = React.useId();
  const helpId = `${id}-help`;

  if (props.variant === 'field') {
    const { children, wide, mono, controlWidth, className } = props;
    return (
      <div
        data-setting-row="field"
        className={cn(
          ROW_PAD,
          // Identifiers (field paths, evidence fields) read as code: 13px mono.
          mono && '[&_input]:font-mono [&_input]:text-sm [&_li]:font-mono [&_li]:text-sm',
          className,
        )}
        style={controlWidth ? ({ '--setting-control-w': controlWidth } as React.CSSProperties) : undefined}
      >
        <FieldLayoutContext.Provider value={wide ? 'wide' : 'inline'}>{children}</FieldLayoutContext.Provider>
      </div>
    );
  }

  if (props.variant === 'switch') {
    const { label, help, checked, onCheckedChange, disabled, className } = props;
    return (
      <div
        data-setting-row="switch"
        className={cn('flex items-start justify-between gap-6', ROW_PAD, disabled && 'opacity-60', className)}
      >
        <RowText label={label} help={help} htmlFor={id} helpId={help ? helpId : undefined} />
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          aria-describedby={help ? helpId : undefined}
          className="mt-0.5"
        />
      </div>
    );
  }

  if (props.variant === 'select') {
    const { label, help, value, onValueChange, options, placeholder, disabled, controlWidth, className } = props;
    return (
      <div
        data-setting-row="select"
        className={cn(ROW_PAD, className)}
        style={controlWidth ? ({ '--setting-control-w': controlWidth } as React.CSSProperties) : undefined}
      >
        <Field label={label} description={help} layout="inline">
          {({ id: controlId, labelledBy, describedBy }) => (
            <Select value={value} onValueChange={onValueChange} disabled={disabled}>
              <SelectTrigger id={controlId} aria-labelledby={labelledBy} aria-describedby={describedBy} className="w-full">
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      </div>
    );
  }

  if (props.variant === 'link') {
    return <SettingLinkRow {...props} />;
  }

  // status and action: the row's text on the left, the status and/or action on the end
  // (under the text below 640px).
  const { label, help, className } = props;
  const end =
    props.variant === 'status' ? (
      <>
        {props.status}
        {props.action}
      </>
    ) : (
      props.action
    );
  return (
    <div
      data-setting-row={props.variant}
      className={cn('flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6', ROW_PAD, className)}
    >
      <RowText label={label} help={help} />
      <div className="flex shrink-0 flex-wrap items-center gap-3">{end}</div>
    </div>
  );
}

export function TextPref({
  label,
  value,
  help,
  placeholder,
  disabled,
  onChange,
  className,
}: {
  label: string;
  value?: string;
  help?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <Field label={label} description={help} className={cn('min-w-0', className)}>
      <Input
        value={value ?? ''}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

export function NumPref({
  label,
  value,
  help,
  step,
  min,
  max,
  disabled,
  onChange,
  className,
  unit,
  size,
}: {
  label: string;
  value?: number;
  help?: string;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  className?: string;
  /** A muted unit inside the field ("h", "s", "min"). */
  unit?: string;
  /**
   * Field width. By default 8rem (SPEC §4.9.6), wider only when the widest value, the
   * unit and the steppers need it (an unbounded preference plans for six digits).
   */
  size?: NumberFieldSize;
}) {
  // Round 14: the shared NumberField (unit inside, steppers inside the right edge for
  // small values, sized to its numbers), no longer a raw number input.
  //
  // ⚠ AN EMPTY FIELD IS NOT A VALUE (`empty="keep"`). Clearing the input and blurring
  // once committed `min ?? 0`, so EVERY numeric preference rendered WITHOUT a `min`
  // silently wrote a literal 0, an invented value the operator never typed. For the
  // per-case caps that is not a stricter limit, it is a broken configuration:
  // `max_tokens = 0` makes the budget exceeded at the FIRST loop check, before any model
  // call, so the run fails to human with zero gateway calls and no error audit row (a
  // silent, $0, invisible failure), and `max_tool_calls = 0` burns the ReAct loop with no
  // evidence gathered. An empty field restores the CURRENT value and commits NOTHING.
  // `min`/`max` still clamp a value the operator actually typed.
  //
  // A typed or stored value is NEVER snapped to `step` (`step="any"`): `step` only sets
  // how far the arrow keys and the steppers move, as it did for the native number input.
  // Snapping on commit would rewrite values the operator typed (0.72 with a step of 0.05
  // becoming 0.7), and since a field that is merely tabbed through commits nothing, a
  // stored value off the step grid is kept as it is.
  //
  // Steppers show for values of up to four digits only (a step of 1 on a 20000-token cap
  // is useless), and the width plans for the digits, the unit and the steppers together.
  const steppers = (widestValueChars({ min, max, step }) ?? Infinity) <= 4;
  const width = size ?? defaultNumberFieldSize({ min, max, step, unit, steppers, base: 'sm' });
  return (
    <NumberField
      label={label}
      description={help}
      value={value}
      onChange={onChange}
      min={min}
      max={max}
      step="any"
      stepperStep={step}
      steppers={steppers}
      unit={unit}
      size={width}
      empty="keep"
      disabled={disabled}
      className={cn('min-w-0', className)}
    />
  );
}

export function SwitchPref({
  label,
  help,
  checked,
  disabled,
  onChange,
  className,
}: {
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  className?: string;
}) {
  const id = React.useId();
  const helpId = help ? `${id}-help` : undefined;
  return (
    <div
      className={cn(
        'flex min-h-12 items-start justify-between gap-5 border-b border-border/70 py-3 first:pt-0 last:border-b-0 last:pb-0',
        disabled && 'opacity-60',
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={id} className="block cursor-pointer leading-snug">
          {label}
        </Label>
        {help ? (
          <p id={helpId} className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {help}
          </p>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={label}
        aria-describedby={helpId}
        className="mt-0.5"
      />
    </div>
  );
}

export function ModelPicker({
  role,
  models,
  value,
  onChange,
}: {
  role: string;
  models: ModelsResponse | null;
  value?: ModelConfig;
  onChange: (next: ModelConfig) => void;
}) {
  const options = React.useMemo(() => {
    const out: Array<{ value: string; label: string; provider: string }> = [];
    for (const [provider, list] of Object.entries(models?.providers || {})) {
      for (const m of list) out.push({ value: m, label: `${m} · ${provider}`, provider });
    }
    return out;
  }, [models]);

  const current = value?.model || '';
  // If the current model isn't in the option list, surface it as a standalone item
  // so the Select shows the real value rather than the placeholder.
  const hasCurrent = !current || options.some((o) => o.value === current);

  return (
    <Field label={`${humanizeToken(role)} model`}>
      {({ id, labelledBy, describedBy, invalid }) => (
        <Select
          value={current || undefined}
          onValueChange={(v) => {
            const sel = options.find((o) => o.value === v);
            // Thread a self-hosted / LiteLLM model's endpoint onto the saved config so a
            // role bound to a custom model routes to the right server (the gateway also
            // resolves it from the custom-model store as a fallback). Selecting a normal
            // model clears any stale base_url so it can't pin the wrong endpoint (task 7).
            const baseUrl = models?.base_urls?.[v];
            onChange({
              provider: sel?.provider || value?.provider || 'openai',
              model: v,
              temperature: value?.temperature,
              max_tokens: value?.max_tokens,
              base_url: baseUrl || undefined,
            });
          }}
        >
          <SelectTrigger
            id={id}
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          >
            <SelectValue placeholder="Select a model" />
          </SelectTrigger>
          <SelectContent>
            {!hasCurrent ? <SelectItem value={current}>{current}</SelectItem> : null}
            {options.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No models available. Add an LLM key first.
              </div>
            ) : (
              options.map((o) => (
                <SelectItem key={`${o.provider}:${o.value}`} value={o.value}>
                  {o.label}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      )}
    </Field>
  );
}

/**
 * A write-only key input, built on the SHARED `SecretField` primitive so every secret
 * surface (settings keys, enrichment providers, notification channels, the wizard)
 * shares ONE reveal-toggle + boolean-pill + explicit-clear UX (#10). Values are buffered
 * in the section's draft and pushed via the dedicated secrets route; an empty draft is
 * never sent, so a blank value can never clobber a stored key.
 */
export function SecretInput({
  label,
  secretKey,
  configured,
  value,
  help,
  onChange,
  disabled,
}: {
  label: string;
  secretKey: string;
  configured?: boolean;
  value: string;
  help?: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  // `secretKey` is retained in the call-site contract for a stable field identity; the
  // shared SecretField manages its own control id, so it isn't threaded onto the DOM here.
  void secretKey;
  return (
    <SecretField
      label={label}
      description={help}
      configured={Boolean(configured)}
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder={configured ? '•••••••• (enter a new value to replace)' : 'Enter a value'}
      configuredLabel="Configured"
    />
  );
}

export function PostureTile({
  label,
  on,
  onText,
  offText,
}: {
  label: string;
  on: boolean;
  onText: string;
  offText: string;
}) {
  return (
    <div
      className={cn(
        'border-l-2 px-3 py-1.5 first:border-l-0',
        on ? 'border-success' : 'border-border',
      )}
    >
      <p className="text-xs font-medium uppercase tracking-[0.04em] text-muted-foreground">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <span
          className={cnDot(on)}
          aria-hidden
        />
        <span className="text-sm font-semibold text-foreground">{on ? onText : offText}</span>
      </div>
    </div>
  );
}

function cnDot(on: boolean): string {
  return on
    ? 'inline-block h-2 w-2 rounded-full bg-success'
    : 'inline-block h-2 w-2 rounded-full bg-muted-foreground/40';
}

export type { LucideIcon };
