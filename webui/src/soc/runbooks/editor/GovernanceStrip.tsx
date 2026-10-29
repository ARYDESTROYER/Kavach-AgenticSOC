/**
 * The editor's governance strip (Round 14, SPEC §4.10.5, §4.10.12, C11 A): the four states
 * on one line ("Draft · v5 by you", "In review · needs a second person", "Published · v4
 * is live", "Retired · read only"), the current one marked, then the facts a reviewer
 * needs: the live version and who published it, open cases pinned to it, the review date
 * and the owner. A built-in shows its own line: read only, updated with releases.
 *
 * Every stored value (names, owner) is rendered as plain text (#9).
 */
import * as React from 'react';
import { ChevronRight, Lock } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Panel } from '@/design-system/panel';
import type { RunbookDetail } from '@/lib/types-runbooks';

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

function who(name: string | null | undefined, username: string | null): string {
  if (!name) return 'someone';
  return username && name === username ? 'you' : name;
}

/** The stage the editor is showing: the most advanced unpublished version, else published or retired. */
export function currentStage(detail: RunbookDetail | null, isNew: boolean): Stage {
  if (isNew || !detail) return 'draft';
  if (detail.draft) return 'draft';
  if (detail.in_review) return 'in_review';
  if (detail.summary.retired) return 'retired';
  return 'published';
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
  const openOnLive = live ? detail?.open_runs_by_version?.[String(live.version)] ?? 0 : 0;
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
          {live ? (
            <Fact label="Live version">
              v{live.version.toLocaleString()}
              {live.published_by ? `, published by ${live.published_by}` : ''}
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
          {due ? (
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
              {summary.last_reviewed_by ? ` by ${summary.last_reviewed_by}` : ''}
            </Fact>
          ) : null}
        </dl>
      ) : null}
    </Panel>
  );
}

