/**
 * Settings shared form bits — the small building blocks every settings section
 * renderer composes (Round-5 Sett-A decomposition).
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
  SettingsTOC,
  type SettingsTOCItem,
} from '@/soc/components/SettingsGrid';
import { Field } from '@/soc/components/Field';
import { SecretField } from '@/soc/components/SecretField';

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
        <div className="sticky top-[calc(var(--header-h)+0.5rem)] z-10 -mx-1 overflow-x-auto border-y border-border/80 bg-background/95 px-1 py-1">
          <SettingsTOC items={toc!} active={active} orientation="horizontal" className="min-w-max flex-row gap-1" />
        </div>
      ) : null}
      {children}
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
}) {
  // Keep raw text while EDITING so the field can be cleared/retyped without snapping to
  // 0 (the old `value ?? 0` controlled input committed `Number('') === 0` on clear and
  // showed a literal "0" for an unset pref). Commit on blur: parse and clamp to
  // [min,max].
  //
  // ⚠ AN EMPTY FIELD IS NOT A VALUE. Clearing the input and blurring used to commit
  // `min ?? 0`, so EVERY numeric preference rendered WITHOUT a `min` silently wrote a
  // literal 0 — an invented value the operator never typed. For the per-case caps that
  // is not a stricter limit, it is a broken configuration: `max_tokens = 0` makes the
  // budget exceeded at the FIRST loop check, before any model call, so the run fails to
  // human with zero gateway calls and no error audit row (a silent, $0, invisible
  // failure), and `max_tool_calls = 0` burns the ReAct loop with no evidence gathered.
  // An empty field now restores the CURRENT value and commits NOTHING — one line here
  // fixes every numeric preference in Settings at once. (`min` is still enforced for a
  // value the operator actually typed; it is no longer a fallback for absence.)
  const [text, setText] = React.useState<string>(value == null ? '' : String(value));
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => {
    if (!editing) setText(value == null ? '' : String(value));
  }, [value, editing]);

  const commit = (raw: string) => {
    setEditing(false);
    const trimmed = raw.trim();
    if (trimmed === '') {
      // Cleared: restore what the pref currently holds and do not call onChange.
      setText(value == null ? '' : String(value));
      return;
    }
    let n = Number(trimmed);
    if (Number.isNaN(n)) {
      setText(value == null ? '' : String(value));
      return;
    }
    if (min != null && n < min) n = min;
    if (max != null && n > max) n = max;
    setText(String(n));
    if (n !== value) onChange(n);
  };

  return (
    <Field label={label} description={help} className={cn('min-w-0', className)}>
      <Input
        type="number"
        value={text}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          setEditing(true);
          setText(e.target.value);
        }}
        onBlur={(e) => commit(e.target.value)}
      />
    </Field>
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
            <SelectValue placeholder="— select a model —" />
          </SelectTrigger>
          <SelectContent>
            {!hasCurrent ? <SelectItem value={current}>{current}</SelectItem> : null}
            {options.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No models available — add an LLM key.
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
