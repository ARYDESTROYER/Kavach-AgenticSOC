/**
 * The editor's governance strip (Round 14, SPEC §4.10.5, §4.10.12, C11 A): the four states
 * on one line ("Draft · v5 by you", "In review · needs a second person", "Published · v4
 * is live", "Retired · read only"), the current one marked, then the facts a reviewer
 * needs: the live version and who published it, open cases pinned to it, the review date
 * and the owner. A retired runbook says which version was retired, by whom and when, and the
 * open cases that still run it; a draft or a version in review it still holds is named as
 * waiting (the page shows the retired version), so an action on it never acts on a version
 * the page does not name. A version sent back to draft shows the reviewer's reason where the
 * author works, with who sent it back and when ("Show all" for earlier notes). A built-in
 * shows its own line: read only, updated with releases. A person is named the same way
 * everywhere: "you" for the signed-in person, else their name.
 *
 * Every stored value (names, owner, review notes) is rendered as plain text (#9).
 */
import * as React from 'react';
import { ChevronRight, Lock } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Panel } from '@/design-system/panel';
import type { RunbookDetail, RunbookReviewNote } from '@/lib/types-runbooks';
import { Button } from '@/ui/button';

import { formatDay, reviewDueState, reviewDueWords } from '../shared/dates';

export interface GovernanceStripProps {
  detail: RunbookDetail | null;
  /** The signed-in person, so the author reads "you". */
  username: string | null;
  /** A runbook that does not exist yet. */
  isNew: boolean;
  /** Unsaved edits on top of the version shown. */
  dirty: boolean;
  /**
   * The viewer can duplicate a built-in here (`runbooks:manage`, not Demo Mode). The built-in
   * line only points to "Duplicate to customise" when that action is offered.
   */
  canDuplicate?: boolean;
  now?: number;
}

type Stage = 'draft' | 'in_review' | 'published' | 'retired';

const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  draft: 'Draft',
  in_review: 'In review',
  published: 'Published',
  retired: 'Retired',
};

/** A person as the editor names them: "you" for the signed-in person, else their name. */
export function who(name: string | null | undefined, username: string | null): string {
  if (!name) return 'someone';
  return username && name === username ? 'you' : name;
}

/**
 * The stage the editor is showing: a retired runbook is retired (it shows its retired
 * version, read only), else the most advanced unpublished version, else published.
 */
export function currentStage(detail: RunbookDetail | null, isNew: boolean): Stage {
  if (isNew || !detail) return 'draft';
  if (detail.summary.retired) return 'retired';
  if (detail.draft) return 'draft';
  if (detail.in_review) return 'in_review';
  return 'published';
}

/** "Sent back by Asha on Nov 5, 2026" for one review note. */
export function reviewNoteLine(note: RunbookReviewNote, username: string | null): string {
  const day = note.at ? formatDay(note.at) : '';
  return `Sent back by ${who(note.by, username)}${day ? ` on ${day}` : ''}`;
}

/** Review notes newest first, the order both the strip and History list them in. */
export function newestNotesFirst(notes: readonly RunbookReviewNote[]): RunbookReviewNote[] {
  return [...notes].reverse();
}

/**
 * The reviewer's reasons on the version being written: the latest first, the rest behind
 * "Show all". Plain text, line breaks kept (#9).
 */
function ReviewNotes({ notes, username }: { notes: RunbookReviewNote[]; username: string | null }) {
  const [all, setAll] = React.useState(false);
  const listId = React.useId();
  const newestFirst = newestNotesFirst(notes);
  const shown = all ? newestFirst : newestFirst.slice(0, 1);
  return (
    <section aria-label="Review notes" className="space-y-2 border-t border-border/70 pt-3" data-review-notes="">
      <ul id={listId} className="space-y-2">
        {shown.map((note, index) => (
          <li key={`${note.at}-${index}`} className="text-sm" data-review-note="">
            <p className="font-medium text-foreground">{reviewNoteLine(note, username)}</p>
            <p className="whitespace-pre-line text-foreground [overflow-wrap:anywhere]">{note.text}</p>
          </li>
        ))}
      </ul>
      {notes.length > 1 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          aria-expanded={all}
          aria-controls={listId}
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show the latest only' : `Show all ${notes.length.toLocaleString()} notes`}
        </Button>
      ) : null}
    </section>
  );
}

function stageNote(stage: Stage, detail: RunbookDetail | null, isNew: boolean, dirty: boolean, username: string | null): string | null {
  if (stage === 'draft') {
    if (isNew) return 'not saved yet';
    if (detail?.draft) return `v${detail.draft.version.toLocaleString()} by ${who(detail.draft.author, username)}`;
    return dirty ? 'unsaved changes' : null;
  }
  if (stage === 'in_review') return detail?.in_review ? 'needs a second person' : null;
  if (stage === 'published') {
    return detail?.live && !detail.summary.retired ? `v${detail.live.version.toLocaleString()} is live` : null;
  }
  return detail?.summary.retired ? 'read only' : null;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function GovernanceStrip({ detail, username, isNew, dirty, canDuplicate = false, now }: GovernanceStripProps) {
  const builtin = detail?.summary.origin === 'builtin';
  const live = detail?.live ?? null;
  const summary = detail?.summary ?? null;
  const retired = !!summary?.retired;
  const retiredDoc = retired ? detail?.retired ?? null : null;
  const openOnLive = live ? detail?.open_runs_by_version?.[String(live.version)] ?? 0 : 0;
  const openOnRetired = retiredDoc ? detail?.open_runs_by_version?.[String(retiredDoc.version)] ?? 0 : 0;
  // The version being written and the reasons a reviewer gave on it. A retired runbook can
  // still hold one: it waits there, named below, with its notes.
  const writing = detail?.draft ?? detail?.in_review ?? null;
  const notes = writing?.review_notes ?? [];
  const due = summary?.review_due_at ?? null;
  const dueState = reviewDueState(due, now);
  const dueWords = reviewDueWords(due, now);
  const cadence = live?.definition.review_every_days ?? detail?.draft?.definition.review_every_days ?? null;

  if (builtin && summary) {
    return (
      <Panel as="section" aria-label="Governance" className="space-y-2" data-governance-strip="builtin">
        <p className="flex items-start gap-2 text-sm text-foreground">
          <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span data-builtin-line="">
            {canDuplicate
              ? 'Built-in runbooks are read only. Duplicate one to customise it: your copy starts as a draft you own, and once published it replaces this one for matching.'
              : 'Built-in runbooks are read only and are updated with Agentic SOC releases.'}
          </span>
        </p>
        <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm">
          <Fact label="State">
            <span className="font-medium text-success-text">
              Published{summary.live_version != null ? ` · v${summary.live_version.toLocaleString()} built-in` : ''}
            </span>
          </Fact>
          <Fact label="Updated">with Agentic SOC releases</Fact>
          <Fact label="Open cases">
            {openOnLive > 0
              ? `${openOnLive.toLocaleString()} open ${openOnLive === 1 ? 'case runs' : 'cases run'} this version`
              : 'No open cases use it'}
          </Fact>
        </dl>
      </Panel>
    );
  }

  const stages: Stage[] = ['draft', 'in_review', 'published', 'retired'];
  const current = currentStage(detail, isNew);
  return (
    <Panel as="section" aria-label="Governance" className="space-y-3" data-governance-strip="operator">
      <ol className="flex flex-wrap items-center gap-1.5" aria-label="Lifecycle">
        {stages.map((stage, index) => {
          const note = stageNote(stage, detail, isNew, dirty, username);
          const isCurrent = stage === current;
          return (
            <li key={stage} className="flex items-center gap-1.5" data-stage={stage}>
              <span
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
                  isCurrent
                    ? 'border-primary bg-primary/10 font-semibold text-foreground'
                    : stage === 'published' && note
                      ? 'border-success/30 text-success-text'
                      : note
                        ? 'border-border text-foreground'
                        : 'border-border text-muted-foreground',
                )}
              >
                {STAGE_LABEL[stage]}
                {note ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="font-normal">{note}</span>
                  </>
                ) : null}
              </span>
              {index < stages.length - 1 ? <ChevronRight className="size-3 text-muted-foreground" aria-hidden /> : null}
            </li>
          );
        })}
      </ol>
      {summary ? (
        <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm">
          {retired ? (
            <Fact label="Retired">
              {retiredDoc ? `v${retiredDoc.version.toLocaleString()}` : 'yes'}
              {retiredDoc?.retired_by ? `, retired by ${who(retiredDoc.retired_by, username)}` : ''}
              {retiredDoc?.retired_at ? ` on ${formatDay(retiredDoc.retired_at)}` : ''}
            </Fact>
          ) : live ? (
            <Fact label="Live version">
              v{live.version.toLocaleString()}
              {live.published_by ? `, published by ${who(live.published_by, username)}` : ''}
              {live.published_at ? ` on ${formatDay(live.published_at)}` : ''}
            </Fact>
          ) : (
            <Fact label="Live version">none yet</Fact>
          )}
          {live && openOnLive > 0 ? (
            <Fact label="Open cases">
              {detail?.draft || detail?.in_review
                ? `${openOnLive.toLocaleString()} open ${openOnLive === 1 ? 'case stays' : 'cases stay'} on v${live.version.toLocaleString()}`
                : `${openOnLive.toLocaleString()} open ${openOnLive === 1 ? 'case runs' : 'cases run'} v${live.version.toLocaleString()}`}
            </Fact>
          ) : null}
          {retiredDoc && openOnRetired > 0 ? (
            <Fact label="Open cases">
              {`${openOnRetired.toLocaleString()} open ${openOnRetired === 1 ? 'case still runs' : 'cases still run'} v${retiredDoc.version.toLocaleString()}`}
            </Fact>
          ) : null}
          {retired && writing ? (
            <Fact label="Waiting">
              {`v${writing.version.toLocaleString()} ${writing.state === 'in_review' ? 'in review' : 'draft'} by ${who(writing.author, username)}, kept while the runbook is retired`}
            </Fact>
          ) : null}
          {due && !retired ? (
            <Fact label="Review due">
              <span
                className={cn(
                  dueState === 'overdue' || dueState === 'today' ? 'font-medium text-warning-text' : undefined,
                )}
              >
                {formatDay(due)}
                {dueWords ? `, ${dueWords.charAt(0).toLowerCase()}${dueWords.slice(1)}` : ''}
              </span>
              {cadence ? <span className="text-muted-foreground"> (every {cadence.toLocaleString()} days)</span> : null}
            </Fact>
          ) : null}
          {summary.owner ? <Fact label="Owner">{summary.owner}</Fact> : null}
          {summary.last_reviewed_at ? (
            <Fact label="Last reviewed">
              {formatDay(summary.last_reviewed_at)}
              {summary.last_reviewed_by ? ` by ${who(summary.last_reviewed_by, username)}` : ''}
            </Fact>
          ) : null}
        </dl>
      ) : null}
      {notes.length ? <ReviewNotes notes={notes} username={username} /> : null}
    </Panel>
  );
}

