/**
 * MetaRow — the one 28 px `text-xs` line under a finished answer (chat revamp SPEC
 * §10.3, §8 item 3). It replaces the pre-revamp "Evidence & execution" accordion:
 *
 *   ▸ 4 lookups · 6.2 s · 2.1k tokens · $0.004 · Sources 3        [Copy][+][↻]
 *
 *  - the left figure is a disclosure that reopens the run log in place
 *    (`aria-expanded` / `aria-controls`); a turn without lookups reads
 *    "Answered in 1.1 s" instead; a stopped, partial or failed turn leads with that word;
 *  - the token figure opens the usage card (click, tap, Enter; or hover with a mouse);
 *  - a turn without recorded usage reads "Usage not recorded · —", never 0, followed by
 *    the model and source the turn ran on when the response names them (compatibility
 *    and pre-revamp turns carry no usage card to show them in);
 *  - "Sources n" discloses citations and console links;
 *  - the icon actions on the right are always visible on the latest turn; on older
 *    turns they keep their space and appear on hover or focus-within. They fade with
 *    OPACITY, never `visibility: hidden`: a hidden element cannot take focus, so on a
 *    turn with no earlier focusable control (every pre-revamp turn) Copy and Ask again
 *    would be unreachable by keyboard (WCAG 2.1.1).
 */
import * as React from 'react';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { ChatResponse } from '@/lib/types';
import { displayText } from '../stream-events';
import { formatDuration, lookupCount, lookupsLabel, turnDurationMs } from './format';
import type { RunLogStep } from './RunLog';
import { UsageCard } from './UsageCard';

export type TurnOutcomeWord = 'Stopped' | 'Partial' | 'Failed';

const DISCLOSURE =
  'inline-flex min-h-6 min-w-0 items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function Dot() {
  return (
    <span className="shrink-0 text-muted-foreground/60" aria-hidden>
      ·
    </span>
  );
}

export interface MetaRowProps {
  response: ChatResponse;
  steps: readonly RunLogStep[];
  outcome?: TurnOutcomeWord | null;
  /** The run log disclosure (absent when the turn ran no lookups). */
  log?: { open: boolean; onToggle: () => void; controls: string } | null;
  /** The Sources disclosure (absent when nothing was cited). */
  sources?: { open: boolean; onToggle: () => void; controls: string; count: number } | null;
  /** Right-aligned icon actions. */
  actions?: React.ReactNode;
  /** Latest turn: actions always visible; older turns: on hover / focus-within. */
  actionsAlwaysVisible?: boolean;
  className?: string;
}

export function MetaRow({
  response,
  steps,
  outcome = null,
  log = null,
  sources = null,
  actions,
  actionsAlwaysVisible = false,
  className,
}: MetaRowProps) {
  const lookups = lookupCount(steps);
  const usage = response.usage ?? null;
  const duration = turnDurationMs(
    steps.flatMap((step) => (step.result ? [step.result] : [])),
    usage,
  );
  const timeText = duration !== null ? formatDuration(duration) : null;
  const sourceNames = Array.from(new Set(steps.flatMap((step) => step.result?.sources ?? [])));
  // Per-turn provenance for a turn without a usage card (display text only).
  const provenance = usage
    ? []
    : [displayText(response.effective_model, 60), displayText(response.effective_source_name || response.effective_source_id, 60)].filter(
        Boolean,
      );

  const lead = (() => {
    const prefix = outcome ? `${outcome} · ` : '';
    if (lookups > 0) return `${prefix}${lookupsLabel(lookups)}${timeText ? ` · ${timeText}` : ''}`;
    if (timeText) return `${prefix}${outcome ? '' : 'Answered in '}${timeText}`;
    return outcome ?? '';
  })();

  return (
    <div className={cn('flex min-h-7 items-center gap-2 text-xs text-muted-foreground', className)} data-testid="meta-row">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {lead ? (
          log ? (
            <button
              type="button"
              className={DISCLOSURE}
              aria-expanded={log.open}
              aria-controls={log.controls}
              onClick={log.onToggle}
            >
              <ChevronRight
                className={cn('size-3.5 shrink-0 transition-transform motion-reduce:transition-none', log.open && 'rotate-90')}
                aria-hidden
              />
              <span className="truncate tabular-nums">{lead}</span>
            </button>
          ) : (
            <span className="truncate tabular-nums">{lead}</span>
          )
        ) : null}
        {lead ? <Dot /> : null}
        {usage ? (
          usage.calls === 0 && usage.total_tokens === 0 ? (
            <span className="truncate">No model call · $0</span>
          ) : (
            <UsageCard usage={usage} sources={sourceNames} />
          )
        ) : (
          <span className="truncate">Usage not recorded · —</span>
        )}
        {provenance.map((value, index) => (
          <React.Fragment key={index}>
            <Dot />
            <span className={cn('truncate', index === 0 && response.effective_model ? 'font-mono' : undefined)} data-testid="turn-provenance">
              {value}
            </span>
          </React.Fragment>
        ))}
        {sources && sources.count > 0 ? (
          <>
            <Dot />
            <button
              type="button"
              className={DISCLOSURE}
              aria-expanded={sources.open}
              aria-controls={sources.controls}
              onClick={sources.onToggle}
            >
              Sources {sources.count}
            </button>
          </>
        ) : null}
      </div>
      {actions ? (
        <div
          className={cn(
            'flex shrink-0 items-center gap-0.5',
            !actionsAlwaysVisible &&
              'opacity-0 transition-opacity group-focus-within/turn:opacity-100 group-hover/turn:opacity-100 focus-within:opacity-100 motion-reduce:transition-none',
          )}
          data-actions-visibility={actionsAlwaysVisible ? 'always' : 'hover'}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
