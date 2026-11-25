/**
 * The case header chip (Round 16 SPEC §4.5 WP09, S1 and S2): "AI working · 0:42" with the
 * turning ring while the AI investigates the case, "AI queued" while it waits for a slot,
 * and for 6 s after a run this console showed ends, a success tint ("AI finished"). It
 * sits on the header's meta row after the AI verdict chip and adds no row. A click opens
 * the popover (`AiRunPopover.tsx`): the steps, who started it, the time against the cap,
 * what happens if you act now, and its steps in the audit log. While the popover is open
 * the run is read again every 3 s (the phase is served by the route, not by a frame).
 *
 * One polite announcement per change, at most one every 10 s: "AI investigation running",
 * "AI investigation waiting", then "AI investigation finished: <status words>". The ring
 * stands still under reduced motion. `compact` drops the words for a narrow pane.
 */
import * as React from 'react';
import { CheckCircle2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { ActivityGlyph } from '@/soc/chat-activity/glyph';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

import { useThrottledAnnouncement } from './announce';
import { elapsedClock } from './aiRunText';
import { AI_RUN_STEPS, AiRunPopoverBody, aiRunFinishedText } from './AiRunPopover';
import { reconcileInvestigations, useInvestigations } from './store';
import { useAiRun, useAiRunFinished } from './useAiRun';

export interface AiRunChipProps {
  caseId: string;
  compact?: boolean;
}

/** How long the success tint stays after a run ends. */
export const FINISHED_TINT_MS = 6000;
/** How often an open popover reads the run again. */
const POPOVER_READ_MS = 3000;

/** The browser clock, every `everyMs` while `everyMs` is set. */
function useNow(everyMs: number | null): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    setNow(Date.now());
    if (!everyMs) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

export const AiRunChip: React.FC<AiRunChipProps> = ({ caseId, compact = false }) => {
  const run = useAiRun(caseId);
  const done = useAiRunFinished(caseId);
  const slots = useInvestigations((s) => s.slots, Boolean(caseId));
  const [open, setOpen] = React.useState(false);
  const titleId = React.useId();
  const now = useNow(run?.state === 'running' ? 1000 : null);

  // The success tint: for 6 s after a run this console showed ended (then a re-render).
  const finished = !run && done?.shown ? done : null;
  const [tint, setTint] = React.useState(false);
  React.useEffect(() => {
    if (!finished) {
      setTint(false);
      return undefined;
    }
    const left = finished.at + FINISHED_TINT_MS - Date.now();
    setTint(left > 0);
    if (left <= 0) return undefined;
    const id = window.setTimeout(() => setTint(false), left);
    return () => window.clearTimeout(id);
  }, [finished]);

  // Opening a case reads its runs once when the page has no live stream (realtime off,
  // or the stream is down), so a run already under way shows without waiting for a poll.
  const live = useInvestigations((s) => s.live, Boolean(caseId));
  React.useEffect(() => {
    if (caseId && !live) void reconcileInvestigations(caseId);
  }, [caseId, live]);

  // While the popover is open, read the run again (its phase is not on a frame).
  const runId = run?.run_id ?? null;
  React.useEffect(() => {
    if (!open || !runId) return undefined;
    void reconcileInvestigations(caseId);
    const id = window.setInterval(() => void reconcileInvestigations(caseId), POPOVER_READ_MS);
    return () => window.clearInterval(id);
  }, [open, runId, caseId]);

  const phase = run?.state === 'running' ? AI_RUN_STEPS.find((step) => step.phase === run.phase) : undefined;
  useThrottledAnnouncement(
    run
      ? run.state === 'running'
        ? `AI investigation running${phase ? `: ${phase.label.toLowerCase()}` : ''}.`
        : 'AI investigation waiting.'
      : finished
        ? aiRunFinishedText(finished.view)
        : '',
  );

  const shown = run ?? (finished && (tint || open) ? finished.view : null);
  if (!shown) return null;
  const ended = !run;
  const label = ended ? 'AI finished' : run.state === 'running' ? 'AI working' : 'AI queued';
  const time = run?.state === 'running' ? elapsedClock(run.started_at, now) : null;
  const visible = compact ? (time ?? (ended ? 'Finished' : 'Queued')) : time ? `${label} · ${time}` : label;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="ai-run-chip"
          data-meta-item="ai-run"
          data-run-state={ended ? 'finished' : run.state}
          aria-label={`${label}. Show the AI investigation`}
          className={cn(
            'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-sm border px-1.5 text-xs font-medium tabular-nums',
            'transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            ended
              ? 'border-success/40 bg-success/10 text-success-text hover:bg-success/15'
              : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/15',
          )}
        >
          {ended ? (
            <CheckCircle2 className="size-3 shrink-0" aria-hidden />
          ) : (
            <ActivityGlyph status="running" className="size-3 border-[1.5px]" />
          )}
          <span aria-hidden className="whitespace-nowrap">
            {visible}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={12} className="w-80" aria-labelledby={titleId}>
        <AiRunPopoverBody caseId={caseId} run={shown} slots={slots} now={now} titleId={titleId} />
      </PopoverContent>
    </Popover>
  );
};
