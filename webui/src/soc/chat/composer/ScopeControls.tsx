/**
 * Scope controls (SPEC §10.4): the "<source> · 24h" chip with its popover (source,
 * time range and the @-scopes in one place), the removable @-scope chips, and the
 * narrow merge into one "Scope · n" chip below 560 px.
 *
 * Writes go straight to the engine (`setSourceId`, `setTimeRange`, `setScopes`); the
 * next turn carries them. The popover is the full editor, so at narrow widths nothing
 * becomes unreachable when the chips merge. Source names are operator-configured
 * text (#9) and render as text nodes.
 */
import * as React from 'react';
import { ChevronDown, Database, X } from 'lucide-react';
import type { ChatContextInfo, ChatScope, ChatTimeRange, SourceInstance } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { chipButton, chipRemove, chipStatic } from './chip';
import { scopeAccess } from './commands';
import type { CatalogState } from './useComposerCatalog';
import {
  SCOPE_LABELS,
  TIME_PRESETS,
  presetForRange,
  sourceChipLabel,
  sourceDisplayName,
  timeRangeLongLabel,
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
  const scopeLegend = React.useId();
  const selectedMissing = target.sourceId && !sources.some((s) => s.id === target.sourceId);

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
          <p className="text-muted-foreground">Choosing a source needs sources:read. Answers use every source you can read.</p>
        ) : (
          <RadioGroup
            value={target.sourceId ?? ALL_SOURCES}
            onValueChange={(value) => target.setSourceId(value === ALL_SOURCES ? null : value)}
            aria-labelledby={sourceLegend}
            className="max-h-40 gap-0 overflow-y-auto"
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
        <SegmentedControl
          size="sm"
          fitted
          aria-label="Time range"
          value={preset?.id ?? ''}
          onValueChange={(id) => target.setTimeRange(TIME_PRESETS.find((p) => p.id === id)?.range ?? null)}
          options={TIME_PRESETS.map((p) => ({ value: p.id, label: p.id }))}
        />
        <p className="mt-1.5 text-muted-foreground">
          {preset
            ? `${preset.label}, unless your question names another window.`
            : `${timeRangeLongLabel(target.timeRange)}.`}
        </p>
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
            {denied.map((a) => `${a.label} needs ${a.missing}`).join(' · ')}
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
        <span className="block truncate text-foreground">{label}</span>
        {hint ? <span className="block text-2xs text-muted-foreground">{hint}</span> : null}
      </label>
    </div>
  );
}

export function ScopeControls({ target, context, sources, sourcesState, merged, onDone }: ScopeControlsProps) {
  const [open, setOpen] = React.useState(false);
  const sourceLabel = sourceChipLabel(target.sourceId, sources);
  const timeLabel = timeRangeShortLabel(target.timeRange);
  const count = activeScopeCount(target);

  const chipText = merged ? (count ? `Scope · ${count}` : 'Scope') : `${sourceLabel} · ${timeLabel}`;
  const accessibleName = merged
    ? `Scope${count ? `: ${count} set` : ''}. Change source, time range and limits`
    : `Scope: ${sourceLabel}, ${timeRangeLongLabel(target.timeRange)}. Change source and time range`;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={cn(chipButton, 'max-w-[14rem] shrink')} aria-label={accessibleName}>
            <Database aria-hidden="true" />
            <span className="truncate">{chipText}</span>
            <ChevronDown aria-hidden="true" className="opacity-70" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-[min(20rem,calc(100vw-2rem))] p-3" aria-label="Scope">
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
