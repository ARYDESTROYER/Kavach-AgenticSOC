/**
 * CaseHistory: the case's lifecycle in the Collaboration tab, with who, when and the
 * actions taken (Round 15, SPEC D4.2, D8.3).
 *
 * It reads the case's own append-only `history` (the activity endpoint is unchanged,
 * [ru] M8): each `analyst_action` entry (the verb, the person, the classification it
 * recorded, the actions taken, a bulk or review marker and the note), the deterministic
 * `decision` entries, owner changes (`assigned`), an analyst policy close and an
 * auto-close review. Newest first, in append order (never re-sorted on a timestamp, so
 * one malformed time cannot reorder the trail).
 *
 * Round 16 (SPEC §4.5 WP14, research data-visibility R6) shows what people wrote and the
 * events that arrived later: the reason a status move recorded (the Hold and De-escalate
 * dialogs collect it; it is paired with the action by its time on the status timeline),
 * the resolution note an action recorded, and each `attach` entry ("12 new events
 * attached", by the system). Two entries stay out on purpose: `precedent_ratification`
 * and `precedent_projection_ack` record that an operator reused the AI verdict as a weak
 * precedent and that it was indexed; neither changes the case's lifecycle, and the audit
 * log keeps both.
 *
 * SECURITY (#9): the analyst name, the assignee, the note, the reason and the resolution
 * are UNTRUSTED text, rendered as plain text nodes. Every other word is Console copy. Read
 * only: nothing here changes the case (#3).
 */
import * as React from 'react';

import type { Case } from '@/lib/types';
import { cn } from '@/lib/cn';
import { formatTimestamp, humanizeAge, humanizeToken } from '@/lib/format';

import { Button } from '@/ui/button';

import { dispositionWords } from '@/soc/components/outcome';

import { actionTakenWords } from './shared';

/** Who made a history entry: a person, the AI agent, or the system's own code. */
export type HistoryActor = 'person' | 'agent' | 'system';

export interface CaseHistoryItem {
  key: string;
  ts: string | null;
  /** The person or component, as shown. UNTRUSTED when `actor` is `person`. */
  who: string;
  actor: HistoryActor;
  /** What happened, in Console words ("Closed as false positive"). */
  title: string;
  /** Short secondary facts ("In a bulk job", "Priority high"). */
  details: string[];
  /** The actions taken, in words (D4.2). */
  actionsTaken: string[];
  /** The note the person wrote (UNTRUSTED). */
  note: string;
  /** The reason the status move recorded, when it differs from the note (UNTRUSTED). */
  reason?: string;
  /** The resolution note the action recorded (UNTRUSTED). */
  resolution?: string;
}

/** The past-tense words for an analyst verb. */
const VERB_WORDS: Record<string, string> = {
  close: 'Closed',
  resolve: 'Resolved',
  reopen: 'Reopened',
  escalate: 'Escalated',
  deescalate: 'De-escalated',
  hold: 'Put on hold',
  resume: 'Resumed',
  acknowledge: 'Acknowledged',
  set_disposition: 'Classified',
  confirm_fp: 'Confirmed a false positive',
  set_status: 'Changed the status',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function analystTitle(entry: Record<string, unknown>): string {
  const action = text(entry.action);
  const verb = VERB_WORDS[action] ?? (action ? humanizeToken(action) : 'Updated the case');
  const classified = text(entry.classified_disposition);
  if (classified && action !== 'confirm_fp') return `${verb} as ${dispositionWords(classified).toLowerCase()}`;
  return verb;
}

function decisionItem(entry: Record<string, unknown>, key: string): CaseHistoryItem {
  const status = text(entry.status).toLowerCase();
  const by = text(entry.decision_by).toLowerCase();
  const agent = by === 'agent';
  let title: string;
  if (status === 'closed' || status === 'resolved') {
    title = status === 'resolved' ? 'Resolved automatically' : 'Closed automatically';
  } else if (status === 'escalated' || entry.escalate === true) {
    title = 'Escalated automatically';
  } else if (status === 'needs_human') {
    title = 'Sent to an analyst';
  } else {
    title = status ? `Set to ${humanizeToken(status).toLowerCase()}` : 'Decided';
  }
  return {
    key,
    ts: text(entry.ts) || null,
    who: agent ? 'AI agent' : 'Case manager',
    actor: agent ? 'agent' : 'system',
    title,
    details: [],
    actionsTaken: [],
    note: '',
  };
}

/**
 * The reasons on the status timeline, by the time of the move. An analyst action and the
 * status move it made share one time (`case.updated_at`), so the time pairs them.
 */
function reasonsByTime(c: Pick<Case, 'history'> | Case): Map<string, string> {
  const out = new Map<string, string>();
  const moves = (c as { status_history?: unknown }).status_history;
  if (!Array.isArray(moves)) return out;
  for (const move of moves) {
    if (!move || typeof move !== 'object') continue;
    const at = text((move as Record<string, unknown>).at);
    const reason = text((move as Record<string, unknown>).reason);
    if (at && reason) out.set(at, reason);
  }
  return out;
}

/** The case's lifecycle history, newest first (pure). */
export function caseHistoryItems(c: Pick<Case, 'history'> | Case): CaseHistoryItem[] {
  const history = (c as { history?: unknown }).history;
  if (!Array.isArray(history)) return [];
  const reasons = reasonsByTime(c);
  const out: CaseHistoryItem[] = [];
  history.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const entry = raw as Record<string, unknown>;
    const event = text(entry.event);
    const key = `${index}-${event}`;
    const ts = text(entry.ts) || null;
    if (event === 'analyst_action') {
      const details: string[] = [];
      if (text(entry.batch)) details.push('In a bulk job');
      if (text(entry.review_via)) details.push('From an auto-close review');
      const assignee = text(entry.assignee);
      if (assignee) details.push(`Assigned to ${assignee}`);
      const priority = text(entry.priority);
      if (priority) details.push(`Priority ${humanizeToken(priority).toLowerCase()}`);
      const actions = Array.isArray(entry.actions_taken)
        ? entry.actions_taken.map(actionTakenWords).filter(Boolean)
        : [];
      const note = text(entry.note);
      // The route stores the note as the reason when no reason was given: show it once.
      const reason = ts ? (reasons.get(ts) ?? '') : '';
      out.push({
        key,
        ts,
        who: text(entry.analyst) || 'Unknown',
        actor: 'person',
        title: analystTitle(entry),
        details,
        actionsTaken: actions,
        note,
        reason: reason && reason !== note ? reason : '',
        resolution: text(entry.resolution),
      });
    } else if (event === 'decision') {
      out.push(decisionItem(entry, key));
    } else if (event === 'attach') {
      const added = Number(entry.added_events);
      const count = Number.isFinite(added) && added > 0 ? Math.round(added) : 0;
      out.push({
        key,
        ts,
        who: 'Ingest',
        actor: 'system',
        title: count
          ? `${count.toLocaleString('en-US')} new event${count === 1 ? '' : 's'} attached`
          : 'New events attached',
        details: [],
        actionsTaken: [],
        note: '',
      });
    } else if (event === 'assigned') {
      const assignee = text(entry.assignee);
      out.push({
        key,
        ts,
        who: text(entry.analyst) || 'Unknown',
        actor: 'person',
        title: assignee ? `Assigned to ${assignee}` : 'Removed the owner',
        details: [],
        actionsTaken: [],
        note: '',
      });
    } else if (event === 'analyst_policy') {
      out.push({
        key,
        ts,
        who: 'Analyst policy',
        actor: 'system',
        title: 'Closed by an analyst policy',
        details: [],
        actionsTaken: [],
        note: '',
      });
    } else if (event === 'auto_close_review') {
      const agrees = entry.agrees;
      out.push({
        key,
        ts,
        who: text(entry.analyst) || 'Unknown',
        actor: 'person',
        title: 'Reviewed the automatic close',
        details:
          agrees === true ? ['Agreed with the AI'] : agrees === false ? ['Disagreed with the AI'] : [],
        actionsTaken: [],
        note: '',
      });
    }
  });
  return out.reverse();
}

/** How many entries show before "Show all". */
const HISTORY_PREVIEW = 8;

const DOT: Record<HistoryActor, string> = {
  person: 'bg-primary',
  agent: 'bg-muted-foreground',
  system: 'bg-muted-foreground/60',
};

export const CaseHistory: React.FC<{ c: Case; className?: string }> = ({ c, className }) => {
  const items = React.useMemo(() => caseHistoryItems(c), [c]);
  const [showAll, setShowAll] = React.useState(false);
  if (!items.length) {
    return <p className={cn('text-sm text-muted-foreground', className)}>No lifecycle changes yet.</p>;
  }
  const shown = showAll ? items : items.slice(0, HISTORY_PREVIEW);
  const hidden = items.length - shown.length;
  return (
    <div className={cn('space-y-2', className)}>
      <ol data-testid="case-history" className="relative space-y-3 border-l border-border/70 pl-4">
        {shown.map((item) => (
          <li key={item.key} data-testid="case-history-item" data-actor={item.actor} className="relative">
            <span aria-hidden className={cn('absolute -left-[1.3rem] top-1.5 size-2 rounded-full', DOT[item.actor])} />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium text-foreground">{item.title}</span>
              {item.ts ? (
                <time
                  className="ml-auto whitespace-nowrap text-2xs text-muted-foreground"
                  dateTime={item.ts}
                  title={formatTimestamp(item.ts)}
                >
                  {humanizeAge(item.ts)}
                </time>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {/* UNTRUSTED name: a plain text node. */}
              <span className={cn(item.actor === 'person' && 'text-foreground')}>{item.who}</span>
              {item.details.map((detail) => (
                <span key={detail}> · {detail}</span>
              ))}
            </p>
            {item.actionsTaken.length ? (
              <p className="mt-0.5 text-xs" data-testid="case-history-actions">
                <span className="text-muted-foreground">Actions taken: </span>
                <span className="text-foreground">{item.actionsTaken.join(', ')}</span>
              </p>
            ) : null}
            {item.reason ? (
              /* UNTRUSTED reason: plain text. */
              <p className="mt-0.5 whitespace-pre-wrap break-words text-xs" data-testid="case-history-reason">
                <span className="text-muted-foreground">Reason: </span>
                <span className="text-foreground/80">{item.reason}</span>
              </p>
            ) : null}
            {item.resolution ? (
              /* UNTRUSTED resolution: plain text. */
              <p className="mt-0.5 whitespace-pre-wrap break-words text-xs" data-testid="case-history-resolution">
                <span className="text-muted-foreground">Resolution: </span>
                <span className="text-foreground/80">{item.resolution}</span>
              </p>
            ) : null}
            {item.note ? (
              /* UNTRUSTED note: plain text, clamped (its full text is in the hover title). */
              <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-foreground/80" title={item.note}>
                {item.note}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      {hidden > 0 || showAll ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setShowAll((value) => !value)}
          aria-expanded={showAll}
        >
          {showAll ? 'Show fewer' : `Show ${hidden.toLocaleString()} earlier`}
        </Button>
      ) : null}
    </div>
  );
};

export default CaseHistory;
