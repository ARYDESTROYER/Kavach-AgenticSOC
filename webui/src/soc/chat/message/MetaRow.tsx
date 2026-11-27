/**
 * MetaRow — the one 28 px `text-xs` line under a finished answer (chat revamp SPEC
 * §10.3, §8 item 3; Round 13 SPEC-chat T10):
 *
 *   ▸ 4 lookups · 6.2 s · $0.004 · Sources 3          [In report ✓][Copy][👍][👎][⋯]
 *
 *  - the left figure is a disclosure that reopens the run log in place
 *    (`aria-expanded` / `aria-controls`); a turn without lookups reads
 *    "Answered in 1.1 s" instead; a stopped, failed or partial turn (a real failure, never
 *    a limit, Round 12) leads with that word;
 *  - the COST opens the usage card, which holds the tokens (click, tap, Enter; or hover
 *    with a mouse); a turn without a cost keeps the token figure as the trigger;
 *  - a turn without recorded usage reads "Usage not recorded", never 0 and never a dash,
 *    followed by the model and source the turn ran on when the response names them
 *    (compatibility and pre-revamp turns carry no usage card to show them in);
 *  - "Sources n" discloses citations and console links;
 *  - the actions on the right (the host's: Copy, the rating pair and ⋯) are always
 *    visible on the latest turn; on older turns they keep their space and appear on hover
 *    or focus-within. The "In report" chip (`pinned`) sits just before them and never
 *    fades: it is a state, so it shows at rest on every turn. They fade with OPACITY, never `visibility: hidden`:
 *    a hidden element cannot take focus, so on a turn with no earlier focusable control
 *    Copy and Ask again would be unreachable by keyboard (WCAG 2.1.1).
 *
 * Figures never truncate. Below 30rem (a phone, the slim case panel) the row keeps
 * "4 lookups · 6.2 s", the rating pair and ⋯; the cost, the provenance and Sources move
 * into ⋯ ("Usage details", "Sources"), and the usage card opens from there, anchored to
 * the row's actions (`usageOpen`).
 */
import * as React from 'react';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { ChatResponse } from '@/lib/types';
import { Popover, PopoverAnchor, PopoverContent } from '@/ui/popover';
import { displayText } from '../stream-events';
import { formatDuration, lookupCount, lookupsLabel, turnDurationMs } from './format';
import type { TurnOutcomeWord } from './notice-copy';
import type { RunLogStep } from './RunLog';
import { UsageCard, UsageDetails } from './UsageCard';

export type { TurnOutcomeWord };

const DISCLOSURE =
  'inline-flex min-h-6 items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Shown only when the meta row is at least 30rem wide (literal for Tailwind). */
export const META_WIDE_ONLY = 'hidden @[30rem]/meta:inline-flex';

function Dot({ className }: { className?: string }) {
  return (
    <span className={cn('shrink-0 text-muted-foreground/60', className)} aria-hidden>
      ·
    </span>
  );
}

/** "4 lookups · 6.2 s" (or "Answered in 1.1 s", or the outcome word first). Exported for tests. */
export function metaLead(
  steps: readonly RunLogStep[],
  usage: ChatResponse['usage'] | null | undefined,
  outcome: TurnOutcomeWord | null,
): string | null {
  const lookups = lookupCount(steps);
  const duration = turnDurationMs(
    steps.flatMap((step) => (step.result ? [step.result] : [])),
    usage ?? null,
  );
  const time = duration !== null ? formatDuration(duration) : null;
  if (lookups > 0) return [outcome, lookupsLabel(lookups), time].filter(Boolean).join(' · ');
  if (time) return outcome ? `${outcome} · ${time}` : `Answered in ${time}`;
  return outcome;
}

export interface MetaRowProps {
  response: ChatResponse;
  steps: readonly RunLogStep[];
  outcome?: TurnOutcomeWord | null;
  /** The run log disclosure (absent when the turn ran no lookups). */
  log?: { open: boolean; onToggle: () => void; controls: string } | null;
  /** The Sources disclosure (absent when nothing was cited). */
  sources?: { open: boolean; onToggle: () => void; controls: string; count: number } | null;
  /** Right-aligned actions (the host's wide and narrow forms, switched by `@[30rem]/meta`). */
  actions?: React.ReactNode;
  /**
   * A state the row shows at rest on EVERY turn (the "In report" chip), just before the
   * actions and outside their hover fade, so an older answer's report state stays seen.
   */
  pinned?: React.ReactNode;
  /** Latest turn: actions always visible; older turns: on hover / focus-within. */
  actionsAlwaysVisible?: boolean;
  /**
   * The usage card opened from the narrow row's ⋯ menu ("Usage details"): anchored to the
   * row's actions, since the cost figure is not shown below 30rem.
   */
  usageOpen?: boolean;
  onUsageOpenChange?: (open: boolean) => void;
  /** Where focus goes when that card closes (the ⋯ trigger that opened it). */
  usageReturnFocus?: () => HTMLElement | null;
  className?: string;
}

export function MetaRow({
  response,
  steps,
  outcome = null,
  log = null,
  sources = null,
  actions,
  pinned = null,
  actionsAlwaysVisible = false,
  usageOpen = false,
  onUsageOpenChange,
  usageReturnFocus,
  className,
}: MetaRowProps) {
  const usage = response.usage ?? null;
  const sourceNames = Array.from(new Set(steps.flatMap((step) => step.result?.sources ?? [])));
  // Per-turn provenance for a turn without a usage card (display text only).
  const provenance = usage
    ? []
    : [displayText(response.effective_model, 60), displayText(response.effective_source_name || response.effective_source_id, 60)].filter(
        Boolean,
      );
  const lead = metaLead(steps, usage, outcome);
  const word = outcome ? <span data-testid="turn-outcome">{outcome}</span> : null;
  // The outcome word keeps its own element (tests and assistive tech find it); the rest
  // of the lead is one run of text that never truncates.
  const leadNode = lead ? (
    word && lead.startsWith(outcome ?? '') ? (
      <>
        {word}
        {lead.slice((outcome ?? '').length)}
      </>
    ) : (
      lead
    )
  ) : null;
  const simulated = usage?.simulated === true && !(usage.calls === 0 && usage.total_tokens === 0);
  const noModel = !!usage && usage.calls === 0 && usage.total_tokens === 0;

  const actionsBox = actions ? (
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
  ) : null;

  return (
    <div
      className={cn('@container/meta flex min-h-7 items-center gap-2 text-xs text-muted-foreground', className)}
      data-testid="meta-row"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {leadNode ? (
          log ? (
            <button
              type="button"
              className={cn(DISCLOSURE, 'shrink-0 whitespace-nowrap tabular-nums')}
              aria-expanded={log.open}
              aria-controls={log.controls}
              onClick={log.onToggle}
              data-testid="meta-lead"
            >
              <ChevronRight
                className={cn('size-3.5 shrink-0 transition-transform motion-reduce:transition-none', log.open && 'rotate-90')}
                aria-hidden
              />
              <span>{leadNode}</span>
            </button>
          ) : (
            <span className="shrink-0 whitespace-nowrap tabular-nums" data-testid="meta-lead">
              {leadNode}
            </span>
          )
        ) : null}
        {/* Everything after the lead needs the wide row: below 30rem it lives in ⋯. */}
        <span className={cn(META_WIDE_ONLY, 'min-w-0 items-center gap-1.5')} data-testid="meta-wide">
          {leadNode ? <Dot /> : null}
          {usage ? (
            noModel ? (
              <span className="whitespace-nowrap">No model call · $0</span>
            ) : (
              <>
                <UsageCard usage={usage} sources={sourceNames} simulatedOutside />
                {simulated ? (
                  <>
                    <Dot />
                    {/* Spoken in the usage figure's name; here so it is always seen. */}
                    <span className="shrink-0" aria-hidden>
                      simulated
                    </span>
                  </>
                ) : null}
              </>
            )
          ) : (
            <span className="whitespace-nowrap">Usage not recorded</span>
          )}
          {provenance.map((value, index) => (
            <React.Fragment key={index}>
              <Dot />
              <span
                className={cn('min-w-0 truncate', index === 0 && response.effective_model ? 'font-mono' : undefined)}
                title={value}
                data-testid="turn-provenance"
              >
                {value}
              </span>
            </React.Fragment>
          ))}
          {sources && sources.count > 0 ? (
            <>
              <Dot />
              <button
                type="button"
                className={cn(DISCLOSURE, 'shrink-0 whitespace-nowrap')}
                aria-expanded={sources.open}
                aria-controls={sources.controls}
                onClick={sources.onToggle}
              >
                Sources {sources.count}
              </button>
            </>
          ) : null}
        </span>
      </div>
      {pinned}
      {actionsBox && usage && onUsageOpenChange ? (
        // The narrow row's "Usage details" (⋯) opens the same card, anchored here.
        <Popover open={usageOpen} onOpenChange={onUsageOpenChange}>
          <PopoverAnchor asChild>{actionsBox}</PopoverAnchor>
          <PopoverContent
            align="end"
            className="w-72 p-3"
            aria-label="Usage details"
            onCloseAutoFocus={(event) => {
              const target = usageReturnFocus?.();
              if (!target) return;
              event.preventDefault();
              target.focus();
            }}
            data-testid="meta-usage-details"
          >
            <UsageDetails usage={usage} sources={sourceNames} />
          </PopoverContent>
        </Popover>
      ) : (
        actionsBox
      )}
    </div>
  );
}
