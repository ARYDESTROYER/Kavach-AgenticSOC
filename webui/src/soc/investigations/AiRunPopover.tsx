/**
 * What the AI is doing on a case, in the header chip's popover (Round 16 SPEC §4.5 WP09,
 * research ai-investigating §4.6 item 3): the step it is on, who or what started it, how
 * long it has run against the time cap (or why it waits), what happens if you act now,
 * and a link to its steps in the audit log. Every value is an enum, a count or a time
 * from the run (#7); a requester's name renders as text (#9).
 */
import * as React from 'react';
import { Check, Circle } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { InvestigationSlots, InvestigationView } from '@/lib/types';
import { AuditLogLink } from '@/soc/components/audit/AuditLink';
import { ActivityGlyph } from '@/soc/chat-activity/glyph';
import { statusWords } from '@/soc/pages/casedetail/caseFacts';

import { spokenDuration } from './aiRunText';

/** The five steps of a run, in order, by the phase the server reports. */
export const AI_RUN_STEPS: ReadonlyArray<{ phase: InvestigationView['phase']; label: string }> = [
  { phase: 'triage', label: 'Triage' },
  { phase: 'specialist', label: 'Specialist and runbook' },
  { phase: 'evidence', label: 'Looking up evidence' },
  { phase: 'verdict', label: 'Verdict' },
  { phase: 'decision', label: 'Deciding' },
];

/** Who or what started a run. A name only for a viewer allowed to see accounts. */
export function aiRunOrigin(run: InvestigationView): string {
  switch (run.trigger) {
    case 'manual':
      if (run.requested_by_you) return 'You started it.';
      return run.requested_by ? `Started by ${run.requested_by}.` : 'Started by a person.';
    case 'job':
      return 'Started by a background job.';
    case 'drain':
      return 'Started when an investigation slot came free.';
    case 'detection':
      return 'Started by event detection.';
    default:
      return 'Started automatically.';
  }
}

/** "2 minutes", "90 seconds": the time cap as words. */
export function capWords(seconds: number): string {
  return seconds % 60 === 0 && seconds >= 60 ? spokenDuration(seconds * 1000) : `${seconds.toLocaleString()} seconds`;
}

/** The time line of a running run, or the waiting line of a queued one. */
export function aiRunTimeLine(run: InvestigationView, slots: InvestigationSlots | null, now: number): string {
  if (run.state === 'queued') {
    const wait =
      slots && slots.cap > 0
        ? `Waiting for a free slot: ${slots.in_use.toLocaleString()} of ${slots.cap.toLocaleString()} investigations are running.`
        : 'Waiting for a free investigation slot.';
    return `${wait} The time cap starts when it begins.`;
  }
  const started = Date.parse(run.started_at || run.queued_at || '');
  const since = Number.isFinite(started) ? `Started ${spokenDuration(now - started)} ago.` : 'Running now.';
  return run.time_cap_seconds > 0
    ? `${since} The time cap for an investigation is ${capWords(run.time_cap_seconds)}.`
    : since;
}

/** The words for how a run ended (the announcement and the finished popover). */
export function aiRunFinishedText(run: InvestigationView): string {
  switch (run.outcome) {
    case 'cancelled':
      return 'AI investigation stopped before it finished. The case was not changed.';
    case 'failed':
      return 'AI investigation could not finish.';
    case 'unchanged':
      return 'AI investigation finished: no change to the case.';
    default:
      return run.status_after
        ? `AI investigation finished: ${statusWords(run.status_after)}.`
        : 'AI investigation finished.';
  }
}

export const ACT_NOW_TEXT =
  'If you close or change the status before it finishes, its result sets the status again. Your disposition, note, actions taken, comments and screenshots are kept.';

export interface AiRunPopoverBodyProps {
  caseId: string;
  /** The run in flight, or the one that just finished. */
  run: InvestigationView;
  slots: InvestigationSlots | null;
  now: number;
  titleId: string;
}

export const AiRunPopoverBody: React.FC<AiRunPopoverBodyProps> = ({ caseId, run, slots, now, titleId }) => {
  const done = run.state === 'finished';
  const current = AI_RUN_STEPS.findIndex((step) => step.phase === run.phase);
  return (
    <div className="space-y-3 text-xs leading-relaxed" data-testid="ai-run-popover">
      <p id={titleId} className="text-sm font-semibold text-foreground">
        {done ? 'AI investigation finished' : run.state === 'queued' ? 'AI investigation waiting' : 'AI investigation running'}
      </p>
      {done ? (
        <p className="text-foreground">{aiRunFinishedText(run)}</p>
      ) : (
        <ol className="space-y-1" aria-label="Steps">
          {AI_RUN_STEPS.map((step, index) => {
            const state = run.state === 'queued' || index > current ? 'todo' : index === current ? 'now' : 'done';
            return (
              <li
                key={step.phase}
                aria-current={state === 'now' ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2',
                  state === 'now' ? 'font-medium text-foreground' : state === 'done' ? 'text-foreground/80' : 'text-muted-foreground',
                )}
              >
                {state === 'now' ? (
                  <ActivityGlyph status="running" className="size-3 border-[1.5px]" />
                ) : state === 'done' ? (
                  <Check className="size-3 shrink-0 text-success" aria-hidden />
                ) : (
                  <Circle className="size-3 shrink-0" aria-hidden />
                )}
                <span>
                  {index + 1}. {step.label}
                  {state === 'done' ? <span className="sr-only"> (done)</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <p className="text-muted-foreground">
        {/* A person's name is shown as text only (#9). */}
        {aiRunOrigin(run)} {done ? null : aiRunTimeLine(run, slots, now)}
      </p>
      {done ? null : <p className="text-muted-foreground">{ACT_NOW_TEXT}</p>}
      <AuditLogLink opts={{ scope: 'agent', from: 'now-24h', case: caseId }} className="inline-block text-xs">
        See its steps in the audit log
      </AuditLogLink>
    </div>
  );
};
