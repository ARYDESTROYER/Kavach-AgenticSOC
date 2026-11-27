/**
 * Scope controls (SPEC §10.4): the "<source> · Auto" chip with its popover (source,
 * time range and the @-scopes in one place), the removable @-scope chips, and the
 * narrow merge into one "Scope · n" chip below 560 px.
 *
 * Writes go straight to the engine (`setSourceId`, `setTimeRange`, `setScopes`); the
 * next turn carries them.
 *
 * Round 13 (SPEC-chat T23): the time range carries a one-line hint ("Auto: each lookup
 * uses its own default window.") with the rest behind a "How ranges work" disclosure;
 * the source list is at most 12rem tall and fades at its bottom edge only while more
 * rows are below (a row reached with the arrow keys scrolls clear of the fade); the
 * popover keeps a 16 px gutter from the screen edge and is never taller than the space
 * it has (it scrolls instead, so a short phone with "How ranges work" open still reaches
 * the Source heading); a missing grant reads as a sentence with its code muted beside
 * it. Opened, it focuses the chosen source (else the chosen time range), never the
 * disclosure below them. The popover is the full editor, so at narrow widths nothing
 * becomes unreachable when the chips merge. Source names are operator-configured
 * text (#9) and render as text nodes.
 */
import * as React from 'react';
import { ChevronDown, ChevronRight, Database, X } from 'lucide-react';
import type { ChatContextInfo, ChatScope, ChatTimeRange, SourceInstance } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { permissionNeedText } from './access-copy';
import { chipButton, chipRemove, chipStatic } from './chip';
import { scopeAccess } from './commands';
import { BOTTOM_FADE, revealInList, useMoreBelow } from './useMoreBelow';
import type { CatalogState } from './useComposerCatalog';
import {
  DEFAULT_TIME_PRESET_ID,
  SCOPE_LABELS,
  TIME_PRESETS,
  inlineLabel,
  presetForRange,
  scopeChipName,
  sourceChipLabel,
  sourceDisplayName,
  timeRangeHint,
  timeRangeShortHint,
  timeRangeShortLabel,
} from './format';

export interface ScopeTarget {
  sourceId: string | null;
  setSourceId: (sourceId: string | null) => void;
  timeRange: ChatTimeRange | null;
  setTimeRange: (range: ChatTimeRange | null) => void;
  scopes: ChatScope[];
  setScopes: (scopes: ChatScope[]) => void;
}

export interface ScopeControlsProps {
  target: ScopeTarget;
  context: ChatContextInfo | null;
  sources: SourceInstance[];
  sourcesState: CatalogState;
  /** Merge the Scope and @ chips into one "Scope · n" chip (narrow composer). */
  merged: boolean;
  /** Return focus to the textarea after a chip is removed. */
  onDone?: () => void;
}

const ALL_SOURCES = '__all__';

/** How many scope settings differ from the defaults (the merged chip's n). */
export function activeScopeCount(target: Pick<ScopeTarget, 'sourceId' | 'timeRange' | 'scopes'>): number {
  return target.scopes.length + (target.sourceId ? 1 : 0) + (target.timeRange ? 1 : 0);
}

function ScopeEditor({
  target,
  context,
  sources,
  sourcesState,
}: Omit<ScopeControlsProps, 'merged' | 'onDone'>) {
  const preset = presetForRange(target.timeRange);
  const access = scopeAccess(context);
  const denied = access.filter((a) => !a.allowed && a.missing);
  const sourceLegend = React.useId();
  const timeLegend = React.useId();
  const timeHint = React.useId();
  const timeMore = React.useId();
  const scopeLegend = React.useId();
  const selectedMissing = target.sourceId && !sources.some((s) => s.id === target.sourceId);
  const [rangesOpen, setRangesOpen] = React.useState(false);
  const sourceList = useMoreBelow<HTMLDivElement>();

  const toggleScope = (scope: ChatScope) => {
    target.setScopes(
      target.scopes.includes(scope) ? target.scopes.filter((s) => s !== scope) : [...target.scopes, scope],
    );
  };

  return (
    <div className="space-y-4 text-xs">
      <div>
        <h3 id={sourceLegend} className="mb-1.5 font-medium text-foreground">
          Source
        </h3>
        {sourcesState === 'denied' ? (
          <p className="text-muted-foreground">
            Choosing a source {permissionNeedText('sources:read', 'needs')}. Answers use every source you can read.
          </p>
        ) : (
          <RadioGroup
            ref={sourceList.ref}
            value={target.sourceId ?? ALL_SOURCES}
            onValueChange={(value) => target.setSourceId(value === ALL_SOURCES ? null : value)}
            aria-labelledby={sourceLegend}
            data-more-below={sourceList.moreBelow ? '' : undefined}
            data-scope-sources=""
            // `scroll-pb-6`: a row the arrow keys reach scrolls clear of the bottom fade.
            className={cn('max-h-48 scroll-pb-6 gap-0 overflow-y-auto', sourceList.moreBelow && BOTTOM_FADE)}
          >
            <SourceOption value={ALL_SOURCES} label="All sources" hint="Log questions search every source you can browse" />
            {selectedMissing ? (
              <SourceOption value={target.sourceId as string} label={sourceChipLabel(target.sourceId, sources)} hint="No longer listed" />
            ) : null}
            {sources.map((source) => (
              <SourceOption key={source.id} value={source.id} label={sourceDisplayName(source)} />
            ))}
            {sourcesState === 'loading' ? <p className="px-1 py-1 text-muted-foreground">Loading sources…</p> : null}
            {sourcesState === 'error' ? (
              <p className="px-1 py-1 text-muted-foreground">Sources could not be loaded.</p>
            ) : null}
          </RadioGroup>
        )}
      </div>

      <div>
        <h3 id={timeLegend} className="mb-1.5 font-medium text-foreground">
          Time range
        </h3>
        {/* Nine presets, Auto (no range) then last hour to all time, in three rows of
            three (Round 12, SPEC D7): one row would not fit the popover. Every arrow key
            moves to the next or previous preset (Down from the end of a row continues on
            the next), the radio-group pattern for options wrapped into rows. */}
        <SegmentedControl
          size="sm"
          fitted
          orientation="both"
          aria-label="Time range"
          aria-describedby={timeHint}
          value={preset?.id ?? ''}
          onValueChange={(id) => target.setTimeRange(TIME_PRESETS.find((p) => p.id === id)?.range ?? null)}
          options={TIME_PRESETS.map((p) => ({
            value: p.id,
            // "Auto" alone does not say what it does: its radio is named with the meaning.
            label:
              p.id === DEFAULT_TIME_PRESET_ID ? (
                <>
                  {p.short}
                  <span className="sr-only"> ({inlineLabel(p.label)})</span>
                </>
              ) : (
                p.short
              ),
          }))}
          className="grid h-auto grid-cols-3"
        />
        <p id={timeHint} className="mt-1.5 text-muted-foreground">
          {timeRangeShortHint(target.timeRange)}
        </p>
        <button
          type="button"
          aria-expanded={rangesOpen}
          aria-controls={timeMore}
          onClick={() => setRangesOpen((open) => !open)}
          className={cn('mt-1 inline-flex items-center gap-1 rounded-sm font-medium text-foreground hover:underline', focusRing)}
        >
          <ChevronRight
            className={cn('size-3.5 transition-transform motion-reduce:transition-none', rangesOpen && 'rotate-90')}
            aria-hidden="true"
          />
          How ranges work
        </button>
        {rangesOpen ? (
          <p id={timeMore} className="mt-1 text-muted-foreground" data-testid="time-range-detail">
            {/* Auto (no range): no outer limit, and each lookup keeps its own default window.
                A chosen range, the explicit 24h included, is an outer bound a question can
                only narrow: tool windows are clamped into it (§4.8.4,
                chat_tools/common.resolve_window). "All time" never clamps. The exceptions
                are named in `timeRangeHint`. */}
            {timeRangeHint(target.timeRange)}
          </p>
        ) : null}
      </div>

      <div>
        <h3 id={scopeLegend} className="mb-1.5 font-medium text-foreground">
          Limit answers to
        </h3>
        <div role="group" aria-labelledby={scopeLegend} className="flex flex-wrap gap-1.5">
          {access.map((a) => {
            const on = target.scopes.includes(a.scope);
            return (
              <button
                key={a.scope}
                type="button"
                aria-pressed={on}
                disabled={!a.allowed}
                onClick={() => toggleScope(a.scope)}
                className={cn(
                  'h-7 rounded-md border px-2 transition-colors disabled:pointer-events-none disabled:opacity-50',
                  on
                    ? 'border-primary/60 bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                  focusRing,
                )}
              >
                {a.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-muted-foreground">
          None selected means everything you can access. Type @ in your message to add one.
        </p>
        {denied.length ? (
          <p className="mt-1 text-muted-foreground">
            {denied.map((a) => `${a.label} ${permissionNeedText(a.missing as string, 'needs')}`).join(' · ')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SourceOption({ value, label, hint }: { value: string; label: string; hint?: string }) {
  const id = React.useId();
  return (
    <div className="flex items-start gap-2 rounded px-1 py-1.5 hover:bg-muted/60">
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block break-words text-foreground">{label}</span>
        {hint ? <span className="block text-2xs text-muted-foreground">{hint}</span> : null}
      </label>
    </div>
  );
}

/**
 * Where focus lands when the scope popover opens: the chosen source (the first checked
 * radio, in the source list), else the chosen time preset (sources denied), else the
 * first radio. Radix would otherwise pick the first TABBABLE element, and both radio
 * groups are still at tabIndex -1 when it looks, so focus fell on "How ranges work".
 */
export function scopeOpenFocusTarget(content: HTMLElement): HTMLElement | null {
  return (
    content.querySelector<HTMLElement>('[role="radio"][data-state="checked"]:not([disabled])') ??
    content.querySelector<HTMLElement>('[role="radio"]:not([disabled])')
  );
}

export function ScopeControls({ target, context, sources, sourcesState, merged, onDone }: ScopeControlsProps) {
  const [open, setOpen] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const sourceLabel = sourceChipLabel(target.sourceId, sources);
  const timeLabel = timeRangeShortLabel(target.timeRange);
  const timePreset = presetForRange(target.timeRange);
  const count = activeScopeCount(target);

  const chipText = merged ? (count ? `Scope · ${count}` : 'Scope') : `${sourceLabel} · ${timeLabel}`;
  const accessibleName = merged
    ? `Scope${count ? `: ${count} set` : ''}. Change source, time range and limits`
    : scopeChipName(sourceLabel, target.timeRange);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={cn(chipButton, 'max-w-[14rem] shrink')} aria-label={accessibleName}>
            {/* The narrow "Scope · n" chip names itself; without the icon it fits the row
                beside the Read-only lock and the meter instead of truncating its count. */}
            {merged ? null : <Database aria-hidden="true" />}
            {merged ? (
              <span className="truncate">{chipText}</span>
            ) : (
              // The source truncates; the time range always stays visible (a long source
              // name must never hide that All time or 12mo is in effect).
              <span className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 truncate">{sourceLabel}</span>{' '}
                <span className={timePreset ? 'shrink-0 whitespace-nowrap' : 'min-w-0 truncate'}>· {timeLabel}</span>
              </span>
            )}
            <ChevronDown aria-hidden="true" className="opacity-70" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={contentRef}
          side="top"
          align="start"
          collisionPadding={16}
          // Never taller than the room it has: it scrolls instead (a short phone).
          className="max-h-[var(--radix-popover-content-available-height)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto p-3"
          aria-label="Scope"
          onOpenAutoFocus={(event) => {
            const content = contentRef.current;
            const radio = content ? scopeOpenFocusTarget(content) : null;
            if (!radio) return; // Radix's own first-tabbable focus
            event.preventDefault();
            radio.focus({ preventScroll: true });
            const list = radio.closest<HTMLElement>('[data-scope-sources]');
            if (list) revealInList(list, (radio.parentElement as HTMLElement | null) ?? radio);
          }}
        >
          <ScopeEditor target={target} context={context} sources={sources} sourcesState={sourcesState} />
        </PopoverContent>
      </Popover>
      {merged
        ? null
        : target.scopes.map((scope) => (
            <span key={scope} className={chipStatic}>
              <span className="truncate">@{scope}</span>
              <button
                type="button"
                className={chipRemove}
                aria-label={`Remove scope ${SCOPE_LABELS[scope]}`}
                onClick={() => {
                  target.setScopes(target.scopes.filter((s) => s !== scope));
                  onDone?.();
                }}
              >
                <X aria-hidden="true" />
              </button>
            </span>
          ))}
    </>
  );
}
