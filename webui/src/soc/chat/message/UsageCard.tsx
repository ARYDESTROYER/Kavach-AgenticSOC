/**
 * UsageCard — a turn's exact usage behind the meta row's token figure (SPEC §8 item 3).
 *
 * Input (uncached + cache read + cache write, the user-facing definition of §3.4),
 * cached, output, total, embedding, cost, model latency, model and the sources the
 * lookups queried, with the honest "estimated" and "simulated" qualifiers spelled out.
 *
 * A Popover, not a hover card: a hover card has no accessibility relationship and
 * cannot open on touch. The trigger is a real button that opens it on click, tap,
 * Enter or Space (focus moves into the labelled dialog, so a screen reader hears the
 * details; Esc closes and returns focus). A mouse may also open it by hovering; a
 * hover-opened card never takes focus, and clicking then pins it open.
 */
import * as React from 'react';

import { fmtNumber } from '@/lib/format';
import type { TurnUsage } from '@/lib/types';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { formatCost, formatDuration, inputTokens, usageSummary } from './format';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums text-foreground">{value}</dd>
    </>
  );
}

export interface UsageCardProps {
  usage: TurnUsage;
  /** Source names the lookups queried (display text). */
  sources?: readonly string[];
}

/** The card body (exported for the toolbar total and tests). */
export function UsageDetails({ usage, sources = [] }: UsageCardProps) {
  const approx = usage.estimated ? '≈ ' : '';
  return (
    <div className="space-y-2 text-xs">
      <p className="font-medium text-foreground">Usage for this answer</p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        <Row label="Input tokens" value={`${approx}${fmtNumber(inputTokens(usage))}`} />
        {usage.cache_read_tokens ? <Row label="Cached input" value={fmtNumber(usage.cache_read_tokens)} /> : null}
        <Row label="Output tokens" value={`${approx}${fmtNumber(usage.output_tokens)}`} />
        <Row label="Total tokens" value={`${approx}${fmtNumber(usage.total_tokens)}`} />
        {usage.embedding_calls ? (
          <Row label="Search embeddings" value={`${usage.embedding_calls} ${usage.embedding_calls === 1 ? 'call' : 'calls'}`} />
        ) : null}
        <Row label="Model calls" value={fmtNumber(usage.calls)} />
        <Row label="Cost" value={`${approx}${formatCost(usage.cost)}${usage.simulated ? ' (simulated)' : ''}`} />
        <Row label="Model time" value={formatDuration(usage.latency_ms)} />
        {usage.model ? <Row label="Model" value={<span className="font-mono">{usage.model}</span>} /> : null}
        {sources.length ? <Row label="Sources" value={sources.join(', ')} /> : null}
      </dl>
      {usage.estimated ? (
        <p className="text-muted-foreground">≈ Estimated: the provider did not report usage, or a call was stopped mid-answer.</p>
      ) : null}
      {usage.simulated ? <p className="text-muted-foreground">Demo Mode prices are simulated; nothing was billed.</p> : null}
    </div>
  );
}

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 150;

/** The meta row's token figure: a button that opens the usage details. */
export function UsageCard({ usage, sources }: UsageCardProps) {
  const summary = usageSummary(usage);
  const [open, setOpen] = React.useState(false);
  /** Opened by a hovering mouse (not pinned): closes when the pointer leaves. */
  const hoverRef = React.useRef(false);
  const timerRef = React.useRef<number | null>(null);
  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  React.useEffect(() => clearTimer, []);
  const hoverOpen = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    clearTimer();
    if (open) return;
    timerRef.current = window.setTimeout(() => {
      hoverRef.current = true;
      setOpen(true);
    }, HOVER_OPEN_MS);
  };
  const hoverClose = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    clearTimer();
    if (!hoverRef.current) return;
    timerRef.current = window.setTimeout(() => {
      hoverRef.current = false;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        clearTimer();
        hoverRef.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="min-w-0 truncate rounded-sm tabular-nums hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${summary}. Usage details`}
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
          onClick={(event) => {
            // A click on a hover-opened card pins it instead of closing it.
            if (open && hoverRef.current) {
              hoverRef.current = false;
              clearTimer();
              event.preventDefault();
            }
          }}
        >
          {summary}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-3"
        aria-label="Usage details"
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') clearTimer();
        }}
        onPointerLeave={hoverClose}
        // A hover never moves focus; a click / key opens into the dialog.
        onOpenAutoFocus={(event) => {
          if (hoverRef.current) event.preventDefault();
        }}
      >
        <UsageDetails usage={usage} sources={sources} />
      </PopoverContent>
    </Popover>
  );
}
