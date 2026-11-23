/**
 * The Team activity range control (Round 15 SPEC D3.11): the page header's one time
 * control. Presets (Today, Yesterday, Last 7 days, Last 30 days) and a custom range of
 * whole calendar days in the operator time zone, at most 92 of them, following the Audit
 * log's custom range. It looks and reads like the shared `TimeRangePicker` (an outline
 * trigger named "Today, time range", a popover of plain buttons), but its values are the
 * server's window tokens, never Elasticsearch date math.
 */
import * as React from 'react';
import { Clock } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

import {
  TEAM_MAX_DAYS,
  TEAM_PRESETS,
  customRangeError,
  rangeLabel,
  type TeamRange,
} from './team-format';

export interface TeamRangeControlProps {
  value: TeamRange;
  onChange: (range: TeamRange) => void;
  /** The operator time zone the days are counted in (named in the menu). */
  timezone?: string | null;
}

export function TeamRangeControl({ value, onChange, timezone }: TeamRangeControlProps) {
  const [open, setOpen] = React.useState(false);
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  React.useEffect(() => {
    if (!open) return;
    setFrom(value.kind === 'custom' ? value.from : '');
    setTo(value.kind === 'custom' ? value.to : '');
  }, [open, value]);
  const error = customRangeError(from, to);
  const ready = Boolean(from && to && !error);
  const label = rangeLabel(value);
  const fromId = React.useId();
  const toId = React.useId();
  const errorId = React.useId();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="min-w-0 max-w-full gap-2 font-normal" aria-label={`${label}, time range`}>
          <Clock className="opacity-70" aria-hidden="true" />
          <span className="min-w-0 truncate tabular-nums">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="mb-2 text-xs font-medium text-muted-foreground">Quick ranges</div>
        <div role="group" aria-label="Time ranges" className="flex flex-col gap-1">
          {TEAM_PRESETS.map((preset) => {
            const active = value.kind === 'preset' && value.preset === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-current={active || undefined}
                onClick={() => {
                  onChange({ kind: 'preset', preset: preset.id });
                  setOpen(false);
                }}
                className={cn(
                  'flex items-center justify-between rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  active ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground hover:bg-muted',
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <form
          className="mt-3 space-y-3 border-t border-border pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            onChange({ kind: 'custom', from, to });
            setOpen(false);
          }}
        >
          <p className="text-sm font-medium text-foreground">Custom range</p>
          <p className="text-xs text-muted-foreground">
            Whole days{timezone ? ` in ${timezone}` : ''}, at most {TEAM_MAX_DAYS}.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={fromId}>Start</Label>
              <Input id={fromId} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={toId}>End</Label>
              <Input
                id={toId}
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className="h-8"
              />
            </div>
          </div>
          {error ? (
            <p id={errorId} className="text-xs text-critical-text">
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
