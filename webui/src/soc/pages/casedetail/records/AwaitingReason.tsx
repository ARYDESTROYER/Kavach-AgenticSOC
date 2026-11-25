/**
 * Why a case is still waiting for an investigation (Round 16 SPEC §4.5 WP14, research
 * data-visibility R13). Shown only for a case with no AI verdict that records an
 * `awaiting_reason`: the reason in plain words, and "Why is this waiting?", a popover that
 * reads `GET /api/cases/{id}/forwarding` when it opens. That route walks the same
 * deterministic gates ingest walked, with today's settings, and for the risk floor it
 * gives the routing score against the floor. The routing score uses only the signals
 * available before enrichment, so it can differ from the case's stored risk.
 *
 * It is also the inspector's hold-reason fact (research data-visibility R6): while a case
 * is on hold, the reason the Hold dialog recorded (`status_reason`), as "On hold: ...".
 *
 * The reason and the gate sentence are the server's own words over configuration and
 * flags, never log text; the hold reason is a person's text. All of them are rendered as
 * text nodes (#9). It only narrates: nothing here decides or changes the case (#3).
 */
import * as React from 'react';

import { getCaseForwarding, type CaseForwarding } from '@/lib/api-case-records';
import { errorMessage } from '@/lib/errorMessage';
import type { Case } from '@/lib/types';

import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

export interface AwaitingReasonProps {
  caseRecord: Case;
  /** Injectable for tests. */
  load?: (caseId: string, signal?: AbortSignal) => Promise<CaseForwarding>;
}

/** The stored reason, read defensively (it is not on every case). */
export function awaitingReasonOf(c: Case): string {
  const value = (c as { awaiting_reason?: unknown }).awaiting_reason;
  return typeof value === 'string' ? value.trim() : '';
}

/** The reason the ingest pipeline recorded, in plain words. */
export function awaitingWords(reason: string): string {
  const text = reason.trim();
  if (!text) return '';
  if (/^deferred:/i.test(text)) {
    return 'Waiting for a free investigation slot. The cap on automatic investigations per poll was reached, so it starts on a later poll.';
  }
  if (text === 'automated background investigation is disabled') return 'Automatic investigation is turned off.';
  if (text === "every event is below its feed's severity floor") return "Every event is below its feed's severity floor.";
  if (text === 'auto-correlate is off for this source or feed') return 'Auto-correlate is off for this source or feed.';
  const floor = /^available-signal routing score (\d+) is below the auto-investigate floor (\d+)$/.exec(text);
  if (floor) {
    return `Its routing score, ${Number(floor[1]).toLocaleString('en-US')}, is below the floor of ${Number(floor[2]).toLocaleString('en-US')} for an automatic investigation.`;
  }
  return text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.');
}

/** What each forwarding gate means, in plain words. */
export const GATE_WORDS: Record<string, string> = {
  ignored: 'Every event belongs to a feed set to be ignored.',
  suppressed: 'Every event matches a live suppression rule.',
  background_scan: 'Automatic investigation is turned off.',
  severity_floor: "Every event is below its feed's severity floor.",
  auto_correlate: 'Auto-correlate is off for this source or feed.',
  risk_floor: 'The routing score is below the floor for an automatic investigation.',
  forwarded: 'With today\'s settings, these events would go to an investigation.',
  unknown: 'The events of this case can no longer be read, so the gates cannot be walked again.',
};

function score(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

export const ForwardingDetails: React.FC<{ data: CaseForwarding }> = ({ data }) => (
  <div className="space-y-2 text-xs" data-testid="awaiting-forwarding">
    <p className="text-foreground">{GATE_WORDS[data.gate] ?? data.sentence}</p>
    {data.sentence && GATE_WORDS[data.gate] ? <p className="text-muted-foreground">{data.sentence}</p> : null}
    {typeof data.routing_total === 'number' && typeof data.risk_floor === 'number' ? (
      <p className="text-muted-foreground" data-testid="awaiting-routing">
        {`Routing score ${score(data.routing_total)} against a floor of ${score(data.risk_floor)}${
          data.routing_gate_applied ? '' : ' (the floor does not apply to these events)'
        }. The routing score uses only the signals known before enrichment, so it can differ from the case's risk.`}
      </p>
    ) : null}
    {(data.notes ?? []).length ? (
      <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
        {(data.notes ?? []).map((note, index) => (
          <li key={`${index}-${note}`}>{note}</li>
        ))}
      </ul>
    ) : null}
    <p className="text-muted-foreground">This reading uses today&apos;s settings.</p>
  </div>
);

export const AwaitingReason: React.FC<AwaitingReasonProps> = ({ caseRecord, load = getCaseForwarding }) => {
  const reason = awaitingReasonOf(caseRecord);
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: CaseForwarding }
  >({ kind: 'loading' });
  const titleId = React.useId();

  React.useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    let pending: Promise<CaseForwarding>;
    try {
      pending = load(caseRecord.case_id, controller.signal);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending
      .then((data) => {
        if (!controller.signal.aborted) setState({ kind: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ kind: 'error', message: errorMessage(error, 'Why this case is waiting could not be loaded.') });
        }
      });
    return () => controller.abort();
  }, [open, caseRecord.case_id, load]);

  // The hold reason (data-visibility R6): the reason the Hold dialog recorded, while the
  // case is on hold. Person-written text: a plain text node (#9).
  const holdReason = caseRecord.status === 'on_hold' ? (caseRecord.status_reason ?? '').trim() : '';
  const hold = holdReason ? (
    <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground" data-testid="hold-reason">
      <span className="text-foreground">On hold: </span>
      {holdReason}
    </p>
  ) : null;
  if (caseRecord.verdict || !reason) return hold;
  return (
    <div className="space-y-1" data-testid="awaiting-reason">
      {hold}
      <p className="text-xs text-muted-foreground">
        <span className="text-foreground">Waiting: </span>
        {awaitingWords(reason)}
      </p>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Why is this waiting?
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-labelledby={titleId} className="w-[min(92vw,22rem)] space-y-2">
          <p id={titleId} className="text-sm font-semibold text-foreground">
            Why this case is waiting
          </p>
          {state.kind === 'loading' ? <p className="text-xs text-muted-foreground">Reading the gates.</p> : null}
          {state.kind === 'error' ? (
            <p role="alert" className="text-xs text-critical-text">
              {state.message}
            </p>
          ) : null}
          {state.kind === 'ready' ? <ForwardingDetails data={state.data} /> : null}
        </PopoverContent>
      </Popover>
    </div>
  );
};
