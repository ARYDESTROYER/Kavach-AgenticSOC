/**
 * The Audit log's control band (Round 14 SPEC §4.5.1): on the canvas under the page
 * header, divider-led. The scope control (People and settings, Agent activity, All) with
 * a help tip; the server-side search box (`/` focuses it; Enter searches); the Event,
 * Actor, Outcome and More filters menus; the active filters as removable chips with
 * Clear all; and the quick views. On a phone the menus fold into "Filters (n)", a sheet.
 *
 * Every filter is applied by the server (never a client filter over a window). Values a
 * person types are checked against the read API's grammar before they are applied; a
 * search qualifier (`actor:`, `event:`, `outcome:`, `case:`, `target:`, `ip:`) becomes
 * its structured filter and is never sent as a query language.
 */
import * as React from 'react';
import { CalendarRange, Check, ChevronDown, ListFilter, Search, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { AuditActorType, AuditOutcome, AuditRecord, AuditScope } from '@/lib/types-audit';
import { Button } from '@/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/ui/sheet';
import { HelpTip } from '@/soc/components/HelpTip';
import { SegmentedControl } from '@/soc/components/SegmentedControl';

import { AUDIT_QUICK_VIEWS, AUDIT_QUICK_VIEWS_HELP, actorLabel, auditEventGroups, eventFilterLabel, quickViewActive } from './events';
import {
  ACTOR_KIND_FILTER_LABEL,
  OUTCOME_FILTER_LABEL,
  SCOPES,
  SCOPE_LABEL,
  activeFilterCount,
  isIpAddress,
  isoSecond,
  parseSearch,
  type AuditLocalFilters,
  type AuditView,
} from './audit-model';

const NAV_ID = /^[\w.:-]{1,128}$/;
const PRINTABLE = /^[^\p{C}\u2028\u2029]+$/u;

export type ViewPatch = Partial<AuditView>;
export type LocalPatch = Partial<AuditLocalFilters>;

export interface FilterChip {
  key: string;
  label: string;
  clear: { view?: ViewPatch; local?: LocalPatch };
}

/**
 * The active filters as chips, in a stable order; also the export dialog's summary.
 * `caseLabels` (from the loaded rows, `caseLabelsOf`) names the filtered case by its
 * case number when a row resolved it; otherwise the chip shows the id it was given.
 */
export function filterChips(
  view: AuditView,
  local: AuditLocalFilters,
  caseLabels?: ReadonlyMap<string, string>,
): FilterChip[] {
  const chips: FilterChip[] = [];
  if (view.q) chips.push({ key: 'q', label: `Search: "${view.q}"`, clear: { view: { q: null } } });
  if (view.event) chips.push({ key: 'event', label: `Event: ${eventFilterLabel(view.event)}`, clear: { view: { event: null } } });
  if (view.actor) chips.push({ key: 'actor', label: `Actor: ${actorLabel(view.actor)}`, clear: { view: { actor: null } } });
  if (view.actorContains)
    chips.push({ key: 'actor_contains', label: `Actor contains: ${view.actorContains}`, clear: { view: { actorContains: null } } });
  if (local.actorKind)
    chips.push({ key: 'actor_kind', label: `Actor kind: ${ACTOR_KIND_FILTER_LABEL[local.actorKind]}`, clear: { local: { actorKind: null } } });
  if (view.outcome) chips.push({ key: 'outcome', label: `Outcome: ${OUTCOME_FILTER_LABEL[view.outcome]}`, clear: { view: { outcome: null } } });
  if (view.caseId)
    chips.push({ key: 'case', label: `Case: ${caseLabels?.get(view.caseId) ?? view.caseId}`, clear: { view: { caseId: null } } });
  if (view.target) chips.push({ key: 'target', label: `Target: ${view.target}`, clear: { view: { target: null } } });
  if (view.ip) chips.push({ key: 'ip', label: `Client IP: ${view.ip}`, clear: { view: { ip: null } } });
  if (local.sourceId) chips.push({ key: 'source', label: `Source: ${local.sourceId}`, clear: { local: { sourceId: null } } });
  if (local.surface) chips.push({ key: 'surface', label: `Surface: ${local.surface}`, clear: { local: { surface: null } } });
  return chips;
}

const SCOPE_HELP =
  'People and settings: sign-ins, access and every change a person made, plus configuration and case work. ' +
  'Agent activity: what the AI agent and the system did on their own, one investigation per row. All: both.';

/* ---------------------------------------------------------------- facet menus -- */

/**
 * A pressed toggle (a quick view, an actor kind): the border, the tint AND a check
 * glyph, so the state is never colour alone (SPEC §3.3); in forced colours, where tints
 * and borders flatten, an outline keeps it. At least 24 px tall.
 */
const TOGGLE =
  'inline-flex min-h-6 items-center gap-1 rounded-md border px-2 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'forced-colors:aria-pressed:outline forced-colors:aria-pressed:outline-2 forced-colors:aria-pressed:outline-offset-1';
const TOGGLE_ON = 'border-primary bg-primary/10 text-foreground';

function PressedMark({ on }: { on: boolean }) {
  return on ? <Check className="size-3 shrink-0" aria-hidden /> : null;
}

const FacetTrigger = React.forwardRef<
  HTMLButtonElement,
  { label: string; current?: string | null } & Omit<React.ComponentProps<typeof Button>, 'value'>
>(function FacetTrigger({ label, current, ...props }, ref) {
  return (
    <Button ref={ref} variant="outline" size="sm" className="max-w-[16rem] gap-1.5 font-normal" {...props}>
      <span className={current ? 'text-muted-foreground' : 'text-foreground'}>{label}</span>
      {current ? <span className="min-w-0 truncate text-foreground">{current}</span> : null}
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    </Button>
  );
});

function EventFacet({ value, onPick }: { value: string | null; onPick: (event: string | null) => void }) {
  const [open, setOpen] = React.useState(false);
  const groups = React.useMemo(() => auditEventGroups(), []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FacetTrigger label="Event" current={value ? eventFilterLabel(value) : null} aria-label={value ? `Event: ${eventFilterLabel(value)}` : 'Event'} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command label="Events">
          <CommandInput placeholder="Search events" aria-label="Search events" />
          <CommandList className="max-h-80">
            <CommandEmpty>No event has that name.</CommandEmpty>
            {value ? (
              <CommandGroup>
                <CommandItem
                  value="any event clear"
                  onSelect={() => {
                    onPick(null);
                    setOpen(false);
                  }}
                >
                  <X aria-hidden />
                  Any event
                </CommandItem>
              </CommandGroup>
            ) : null}
            {groups.map((group) => (
              <CommandGroup key={group.category} heading={group.label}>
                {group.options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={`${option.label} ${option.value}`}
                    onSelect={() => {
                      onPick(option.value);
                      setOpen(false);
                    }}
                    className={option.kind === 'category' ? 'font-medium' : undefined}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {value === option.value ? <Check aria-label="Selected" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const ACTOR_KINDS: readonly AuditActorType[] = ['human', 'agent', 'system', 'service'];

function ActorFacet({
  view,
  local,
  knownActors,
  onChange,
}: {
  view: AuditView;
  local: AuditLocalFilters;
  /** Actors in the loaded rows, with how many loaded rows each one has. */
  knownActors: ReadonlyArray<{ actor: string; count: number }>;
  onChange: (view: ViewPatch, local?: LocalPatch) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(view.actorContains ?? '');
  React.useEffect(() => {
    if (open) setDraft(view.actorContains ?? '');
  }, [open, view.actorContains]);
  const current = view.actor ? actorLabel(view.actor) : view.actorContains ? `contains ${view.actorContains}` : null;
  const kindLabel = local.actorKind ? ACTOR_KIND_FILTER_LABEL[local.actorKind] : null;
  const applyTyped = () => {
    const text = draft.trim();
    if (text && (!PRINTABLE.test(text) || text.length > 128)) return;
    onChange({ actorContains: text || null, actor: null });
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FacetTrigger
          label="Actor"
          current={[current, kindLabel].filter(Boolean).join(', ') || null}
          aria-label={current || kindLabel ? `Actor: ${[current, kindLabel].filter(Boolean).join(', ')}` : 'Actor'}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3">
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            applyTyped();
          }}
        >
          <Label htmlFor="audit-actor-contains">Name contains</Label>
          <div className="flex gap-2">
            <Input
              id="audit-actor-contains"
              value={draft}
              maxLength={128}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type part of a name"
              className="h-8"
            />
            <Button type="submit" size="sm">
              Apply
            </Button>
          </div>
        </form>
        {knownActors.length ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">In the events loaded (exact name)</p>
            <ul className="max-h-48 overflow-y-auto">
              {knownActors.map(({ actor, count }) => (
                <li key={actor}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange({ actor, actorContains: null });
                      setOpen(false);
                    }}
                    aria-pressed={view.actor === actor}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 truncate">{actorLabel(actor)}</span>
                    <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{count.toLocaleString()}</span>
                    {view.actor === actor ? <Check className="size-4 shrink-0" aria-hidden /> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <fieldset className="space-y-1.5 border-t border-border/70 pt-3">
          <legend className="mb-1 text-xs text-muted-foreground">Kind</legend>
          <div className="flex flex-wrap gap-1.5">
            {[null, ...ACTOR_KINDS].map((kind) => (
              <button
                key={kind ?? 'any'}
                type="button"
                aria-pressed={local.actorKind === kind}
                onClick={() => onChange({}, { actorKind: kind })}
                className={cn(TOGGLE, local.actorKind === kind ? TOGGLE_ON : 'border-border text-muted-foreground hover:bg-hover')}
              >
                <PressedMark on={local.actorKind === kind} />
                {kind ? ACTOR_KIND_FILTER_LABEL[kind] : 'Any'}
              </button>
            ))}
          </div>
        </fieldset>
        {view.actor || view.actorContains ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange({ actor: null, actorContains: null });
              setOpen(false);
            }}
          >
            Any actor
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

const OUTCOME_CHOICES: ReadonlyArray<AuditOutcome | null> = [null, 'success', 'failure', 'denied', 'partial', 'unknown'];
/** The radio value of "Any" (no outcome filter); never an outcome the API knows. */
const ANY_OUTCOME = 'any';

function OutcomeFacet({ value, onPick }: { value: AuditOutcome | null; onPick: (o: AuditOutcome | null) => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <FacetTrigger label="Outcome" current={value ? OUTCOME_FILTER_LABEL[value] : null} aria-label={value ? `Outcome: ${OUTCOME_FILTER_LABEL[value]}` : 'Outcome'} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {/* Radio items: the current choice is `aria-checked`, not a glyph alone. */}
        <DropdownMenuRadioGroup
          value={value ?? ANY_OUTCOME}
          onValueChange={(next) => onPick(next === ANY_OUTCOME ? null : (next as AuditOutcome))}
        >
          {OUTCOME_CHOICES.map((o) => (
            <DropdownMenuRadioItem key={o ?? ANY_OUTCOME} value={o ?? ANY_OUTCOME}>
              {o ? OUTCOME_FILTER_LABEL[o] : 'Any'}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface MoreDraft {
  caseId: string;
  sourceId: string;
  surface: string;
  ip: string;
}

function moreErrors(d: MoreDraft): Partial<Record<keyof MoreDraft, string>> {
  const errors: Partial<Record<keyof MoreDraft, string>> = {};
  if (d.caseId && !NAV_ID.test(d.caseId)) errors.caseId = 'Use letters, digits, dots, dashes, colons or underscores.';
  if (d.sourceId && !NAV_ID.test(d.sourceId)) errors.sourceId = 'Use letters, digits, dots, dashes, colons or underscores.';
  if (d.surface && (!PRINTABLE.test(d.surface) || d.surface.length > 80)) errors.surface = 'Up to 80 printable characters.';
  if (d.ip && !isIpAddress(d.ip)) errors.ip = 'An IPv4 or IPv6 address.';
  return errors;
}

function MoreFilters({
  view,
  local,
  onChange,
  inline = false,
}: {
  view: AuditView;
  local: AuditLocalFilters;
  onChange: (view: ViewPatch, local?: LocalPatch) => void;
  /** Render the form itself (the phone sheet), not a menu button. */
  inline?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const initial = (): MoreDraft => ({
    caseId: view.caseId ?? '',
    sourceId: local.sourceId ?? '',
    surface: local.surface ?? '',
    ip: view.ip ?? '',
  });
  const [draft, setDraft] = React.useState<MoreDraft>(initial);
  React.useEffect(() => {
    if (open || inline) setDraft(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inline, view.caseId, view.ip, local.sourceId, local.surface]);
  const errors = moreErrors(draft);
  const invalid = Object.keys(errors).length > 0;
  const count = [view.caseId, view.ip, local.sourceId, local.surface].filter(Boolean).length;
  const field = (key: keyof MoreDraft, label: string, placeholder: string) => (
    <div className="space-y-1">
      <Label htmlFor={`audit-more-${key}`}>{label}</Label>
      <Input
        id={`audit-more-${key}`}
        value={draft[key]}
        placeholder={placeholder}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value.trim() }))}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `audit-more-${key}-error` : undefined}
        className="h-8"
      />
      {errors[key] ? (
        <p id={`audit-more-${key}-error`} className="text-xs text-critical-text">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const form = (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        onChange(
          { caseId: draft.caseId || null, ip: draft.ip || null },
          { sourceId: draft.sourceId || null, surface: draft.surface || null },
        );
        setOpen(false);
      }}
    >
      {field('caseId', 'Case', 'Case id')}
      {field('sourceId', 'Source', 'Source id')}
      {field('surface', 'Surface', 'For example settings or session')}
      {field('ip', 'Client IP', 'For example 203.0.113.24')}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange({ caseId: null, ip: null }, { sourceId: null, surface: null });
            setOpen(false);
          }}
        >
          Clear these
        </Button>
        <Button type="submit" size="sm" disabled={invalid}>
          Apply
        </Button>
      </div>
    </form>
  );
  if (inline) return form;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FacetTrigger label="More filters" current={count ? `(${count})` : null} aria-label={count ? `More filters, ${count} set` : 'More filters'} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {form}
      </PopoverContent>
    </Popover>
  );
}

/* --------------------------------------------------------------- custom range -- */

/** `2026-10-25T15:10` (a `datetime-local` value, read as UTC) from an instant. */
function localInputValue(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '' : isoSecond(ms).slice(0, 16);
}

/**
 * "Custom range": a start and an end, both in UTC, to the minute. The header's time
 * range presets cover the relative windows; this sets absolute instants.
 */
export function AuditCustomRange({
  view,
  onApply,
}: {
  view: Pick<AuditView, 'from' | 'to'>;
  onApply: (range: { from: string; to: string }) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  React.useEffect(() => {
    if (!open) return;
    const isAbsolute = /^\d{4}-/.test(view.from);
    setFrom(isAbsolute ? localInputValue(view.from) : '');
    setTo(view.to && /^\d{4}-/.test(view.to) ? localInputValue(view.to) : '');
  }, [open, view.from, view.to]);
  const fromMs = from ? Date.parse(`${from}:00Z`) : NaN;
  const toMs = to ? Date.parse(`${to}:00Z`) : NaN;
  const error =
    !from || !to
      ? null
      : Number.isNaN(fromMs) || Number.isNaN(toMs)
        ? 'Enter a date and a time.'
        : fromMs >= toMs
          ? 'The end must be after the start.'
          : null;
  const ready = Boolean(from && to && !error);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 font-normal">
          <CalendarRange className="size-4" aria-hidden />
          Custom
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            onApply({ from: isoSecond(fromMs), to: isoSecond(toMs) });
            setOpen(false);
          }}
        >
          <p className="text-sm font-medium text-foreground">Custom range (UTC)</p>
          <div className="space-y-1">
            <Label htmlFor="audit-range-from">Start</Label>
            <Input id="audit-range-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="audit-range-to">End</Label>
            <Input
              id="audit-range-to"
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'audit-range-error' : undefined}
              className="h-8"
            />
          </div>
          {error ? (
            <p id="audit-range-error" className="text-xs text-critical-text">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!ready}>
              Apply
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ the band -- */

export interface AuditControlBandProps {
  view: AuditView;
  local: AuditLocalFilters;
  phone: boolean;
  /** Apply a change to the URL filters (and the in-memory ones). */
  onChange: (view: ViewPatch, local?: LocalPatch) => void;
  /** Clear every filter a person added (scope and time stay). */
  onClearAll: () => void;
  knownActors: ReadonlyArray<{ actor: string; count: number }>;
  /** Case numbers by internal case id, from the loaded rows (the "Case:" chip). */
  caseLabels?: ReadonlyMap<string, string>;
  searchRef: React.RefObject<HTMLInputElement>;
}

export function AuditControlBand({
  view,
  local,
  phone,
  onChange,
  onClearAll,
  knownActors,
  caseLabels,
  searchRef,
}: AuditControlBandProps) {
  const [draft, setDraft] = React.useState(view.q ?? '');
  const [sheetOpen, setSheetOpen] = React.useState(false);
  // The applied search changes from outside (a chip removed, a link): show it.
  React.useEffect(() => setDraft(view.q ?? ''), [view.q]);
  const chips = filterChips(view, local, caseLabels);
  // "Filters (n)" counts what the sheet holds: the search box stays on the band.
  const sheetCount = activeFilterCount(view, local) - (view.q ? 1 : 0);
  const pending = draft.trim() !== (view.q ?? '');

  const submitSearch = () => {
    const parsed = parseSearch(draft);
    onChange({ q: parsed.q, ...parsed.patch });
    setDraft(parsed.q ?? '');
  };

  const search = (
    <form
      role="search"
      className={cn('relative min-w-[12rem] flex-1', phone && 'min-w-0')}
      onSubmit={(e) => {
        e.preventDefault();
        submitSearch();
      }}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        ref={searchRef}
        type="search"
        value={draft}
        maxLength={400}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && draft) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(view.q ?? '');
          }
        }}
        placeholder="Search events, people and targets"
        aria-label="Search the audit log"
        aria-describedby="audit-search-hint"
        aria-keyshortcuts="/"
        className={cn('h-8 pl-9 text-sm', phone ? 'pr-3' : pending ? 'pr-14' : 'pr-8')}
      />
      {/* The key that acts next: `/` focuses the box; once the text changes, Enter searches.
          A phone has no such keys, so the hint gives its room back to the placeholder. */}
      {phone ? null : (
        <kbd
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-sm border border-border px-1 font-mono text-2xs text-muted-foreground"
          aria-hidden
          data-testid="audit-search-key"
        >
          {pending ? 'Enter' : '/'}
        </kbd>
      )}
      <span id="audit-search-hint" className="sr-only">
        Press Enter to search. You can narrow with actor:, event:, outcome:, case:, target: or ip:.
      </span>
    </form>
  );

  const facets = (
    <>
      <EventFacet value={view.event} onPick={(event) => onChange({ event })} />
      <ActorFacet view={view} local={local} knownActors={knownActors} onChange={onChange} />
      <OutcomeFacet value={view.outcome} onPick={(outcome) => onChange({ outcome })} />
    </>
  );

  const quickViews = (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" role="group" aria-label="Quick views">
      <span className="inline-flex items-center gap-0.5">
        <span aria-hidden>Quick views</span>
        <HelpTip label="What the quick views match" text={AUDIT_QUICK_VIEWS_HELP} />
      </span>
      {AUDIT_QUICK_VIEWS.map((qv) => {
        const active = quickViewActive(qv, view.event, view.outcome);
        return (
          <button
            key={qv.id}
            type="button"
            aria-pressed={active}
            onClick={() =>
              // A second press clears the view. Every view reads People and settings rows,
              // so from Agent activity (where it could match nothing) it switches scope.
              onChange(
                active
                  ? { event: null, outcome: null }
                  : { event: qv.event ?? null, outcome: qv.outcome ?? null, ...(view.scope === 'agent' ? { scope: qv.scope } : {}) },
              )
            }
            className={cn(TOGGLE, active ? TOGGLE_ON : 'border-border/70 text-foreground hover:bg-hover')}
          >
            <PressedMark on={active} />
            {qv.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="flex flex-col gap-3 border-b border-border/70 pb-3" data-testid="audit-control-band">
      <div className="flex flex-wrap items-center gap-2">
        <div className={cn('flex items-center gap-1', phone && 'w-full')}>
          <SegmentedControl<AuditScope>
            aria-label="Scope"
            size="sm"
            fitted={phone}
            className={phone ? 'w-full' : undefined}
            value={view.scope}
            onValueChange={(scope) => onChange({ scope })}
            options={SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s] }))}
          />
          <HelpTip label="What each scope shows" text={SCOPE_HELP} />
        </div>
        {search}
        {phone ? (
          // A Radix trigger, so Esc or Close hands focus back to this button.
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <ListFilter className="size-4" aria-hidden />
                {sheetCount > 0 ? `Filters (${sheetCount})` : 'Filters'}
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" size="xl" className="gap-0 p-0">
              <SheetHeader className="px-4 py-4 pr-14">
                <SheetTitle className="text-md">Filters</SheetTitle>
                <SheetDescription>Every filter is applied to the whole audit log, not only the rows loaded.</SheetDescription>
              </SheetHeader>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
                <div className="flex flex-wrap gap-2">{facets}</div>
                <div className="border-t border-border/70 pt-4">
                  <MoreFilters view={view} local={local} onChange={onChange} inline />
                </div>
                <div className="border-t border-border/70 pt-4">{quickViews}</div>
              </div>
            </SheetContent>
          </Sheet>
        ) : (
          // The facet menus wrap together, so a narrow window never strands one on its own line.
          <div className="flex shrink-0 items-center gap-2">
            {facets}
            <MoreFilters view={view} local={local} onChange={onChange} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
        {/* Basis auto: when the chips and the quick views do not fit side by side, the quick
            views take the next line rather than squeezing "Clear all" under the chips. */}
        <div className="flex min-w-0 flex-auto flex-wrap items-center gap-1.5" aria-label="Active filters" role="group">
          {chips.length ? (
            <>
              {chips.map((chip) => (
                <span
                  key={chip.key}
                  className="inline-flex max-w-[22rem] items-center gap-1 rounded-md border border-border bg-muted/50 py-0.5 pl-2 pr-0.5 text-xs text-foreground"
                >
                  <span className="min-w-0 truncate" title={chip.label}>
                    {chip.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => onChange(chip.clear.view ?? {}, chip.clear.local)}
                    aria-label={`Remove filter ${chip.label}`}
                    className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                </span>
              ))}
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onClearAll}>
                Clear all
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">No filters added</span>
          )}
        </div>
        {phone ? null : quickViews}
      </div>
    </div>
  );
}

/** Actors in the loaded rows with their loaded-row counts, most frequent first (at most 20). */
export function loadedActors(records: readonly AuditRecord[]): Array<{ actor: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of records) if (r.actor) counts.set(r.actor, (counts.get(r.actor) ?? 0) + 1);
  return Array.from(counts, ([actor, count]) => ({ actor, count }))
    .sort((a, b) => b.count - a.count || a.actor.localeCompare(b.actor))
    .slice(0, 20);
}
