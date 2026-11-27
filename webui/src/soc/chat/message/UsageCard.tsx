/**
 * UsageCard — a turn's exact usage behind the meta row's COST (SPEC §8 item 3; Round 13
 * SPEC-chat D5, T10: the cost stays in the meta row and the tokens move into this card;
 * a turn without a cost keeps the token figure as the trigger).
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
import { compactTokens, formatCost, formatDuration, inputTokens, usageSummary } from './format';

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
  /** The host shows the Demo "simulated" marker itself (so it never truncates away). */
  simulatedOutside?: boolean;
  /** Source names the lookups queried (display text). */
  sources?: readonly string[];
}

/** The turn has a cost to show (a finite, non-negative amount). */
export function hasCost(usage: Pick<TurnUsage, 'cost'>): boolean {
  return typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0;
}

/**
 * The meta row's visible figure: the cost ("$0.004", "≈ $0.004"), or the token figure
 * ("2.1k tokens") when the turn has no cost. The card holds the rest.
 */
export function usageTriggerText(usage: TurnUsage): string {
  const approx = usage.estimated ? '≈ ' : '';
  return hasCost(usage) ? `${approx}${formatCost(usage.cost)}` : usageSummary(usage, { withCost: false, withSimulated: false });
}

/**
 * The trigger's accessible name, which STARTS with its visible label (WCAG 2.5.3, so a
 * speech-input user can say what they see): "$0.06 · 16.7k tokens · simulated. Usage
 * details", or "1.2k tokens. Usage details" when the turn has no cost. "simulated" is
 * spoken here even when the row shows it outside the button (`simulatedOutside`).
 */
export function usageTriggerName(usage: TurnUsage, simulatedOutside = false): string {
  const approx = usage.estimated ? '≈ ' : '';
  const visible = usageTriggerText(usage);
  const parts = [visible];
  if (usage.simulated && !simulatedOutside) parts.push('simulated');
  if (hasCost(usage)) parts.push(`${approx}${compactTokens(usage.total_tokens)} tokens`);
  if (usage.simulated && simulatedOutside) parts.push('simulated');
  return `${parts.join(' · ')}. Usage details`;
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

/** The meta row's cost figure: a button that opens the usage details (tokens included). */
export function UsageCard({ usage, sources, simulatedOutside = false }: UsageCardProps) {
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
          // A figure never truncates (T10): the row moves it into ⋯ before it would.
          className="shrink-0 whitespace-nowrap rounded-sm tabular-nums hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={usageTriggerName(usage, simulatedOutside)}
          data-testid="usage-trigger"
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
          {usageTriggerText(usage)}
          {usage.simulated && !simulatedOutside ? ' · simulated' : null}
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
