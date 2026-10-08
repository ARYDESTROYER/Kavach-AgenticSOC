/**
 * UsageCard — a turn's exact usage behind the meta row's token figure (SPEC §8 item 3).
 *
 * Input (uncached + cache read + cache write, the user-facing definition of §3.4),
 * cached, output, total, embedding, cost, model latency, model and the sources the
 * lookups queried, with the honest "estimated" and "simulated" qualifiers spelled out.
 * The trigger is a real button: Radix opens the card on hover AND on keyboard focus,
 * and the button's accessible name already carries the headline figures.
 */
import * as React from 'react';

import { fmtNumber } from '@/lib/format';
import type { TurnUsage } from '@/lib/types';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/ui/hover-card';
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

/** The meta row's token figure: a button that opens the card on hover and focus. */
export function UsageCard({ usage, sources }: UsageCardProps) {
  const summary = usageSummary(usage);
  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="min-w-0 truncate rounded-sm tabular-nums hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${summary}. Usage details`}
        >
          {summary}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72 p-3">
        <UsageDetails usage={usage} sources={sources} />
      </HoverCardContent>
    </HoverCard>
  );
}
