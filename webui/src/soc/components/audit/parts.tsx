/**
 * Small shared marks of the Audit log (Round 14 SPEC §4.5): the outcome (text plus a
 * glyph, never colour alone), the actor (a glyph for person, AI agent or system plus the
 * name) and a time element. Every value is a plain text node (#9).
 */
import type { ReactNode } from 'react';
import { Ban, Bot, CheckCircle2, CircleDashed, CircleEllipsis, Cog, Minus, User, Workflow, XCircle } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { AuditRecord } from '@/lib/types-audit';

import { actorLabel } from './events';
import {
  ACTOR_KIND_LABEL,
  GROUP_OUTCOME_LABEL,
  actorKindKey,
  outcomeKey,
  type ActorKindKey,
  type GroupOutcomeKey,
} from './audit-model';

const OUTCOME_STYLE: Readonly<Record<GroupOutcomeKey, { Icon: typeof CheckCircle2; tone: string }>> = {
  success: { Icon: CheckCircle2, tone: 'text-success-text' },
  failure: { Icon: XCircle, tone: 'text-critical-text' },
  denied: { Icon: Ban, tone: 'text-high-text' },
  partial: { Icon: CircleDashed, tone: 'text-warning-text' },
  not_recorded: { Icon: Minus, tone: 'text-muted-foreground' },
  // An investigation group shown in part: neutral, as nothing is claimed yet.
  not_known: { Icon: CircleEllipsis, tone: 'text-muted-foreground' },
};

/** The glyph and words of one outcome key; `children` follow the words. */
function OutcomeWords({ outcome, className, children }: { outcome: GroupOutcomeKey; className?: string; children?: ReactNode }) {
  const { Icon, tone } = OUTCOME_STYLE[outcome];
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap', tone, className)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{GROUP_OUTCOME_LABEL[outcome]}</span>
      {children}
    </span>
  );
}

export interface OutcomeMarkProps {
  record: Pick<AuditRecord, 'outcome' | 'outcome_derived'>;
  className?: string;
  /** Say "derived" after the word (the inspector): the outcome was read from an older row. */
  showDerived?: boolean;
}

/** "Success", "Failed", "Denied", "Partial" or "Not recorded", with its glyph. */
export function OutcomeMark({ record, className, showDerived = false }: OutcomeMarkProps) {
  return (
    <OutcomeWords outcome={outcomeKey(record)} className={className}>
      {showDerived && record.outcome_derived ? (
        <span className="text-xs font-normal text-muted-foreground">(derived)</span>
      ) : null}
    </OutcomeWords>
  );
}

export interface GroupOutcomeMarkProps {
  /** The group row's outcome (`groupOutcomeKey`). */
  outcome: GroupOutcomeKey;
  className?: string;
}

/**
 * An investigation group's outcome: a record outcome, or "Not known" while part of the
 * run is loaded and the steps shown prove none. That one also says, to a screen reader,
 * when it will be known; on screen the row says "5 of 10 steps shown" beside Load more.
 */
export function GroupOutcomeMark({ outcome, className }: GroupOutcomeMarkProps) {
  return (
    <OutcomeWords outcome={outcome} className={className}>
      {outcome === 'not_known' ? <span className="sr-only"> until every step is loaded</span> : null}
    </OutcomeWords>
  );
}

const ACTOR_ICON: Readonly<Record<ActorKindKey, typeof User>> = {
  human: User,
  agent: Bot,
  system: Cog,
  service: Workflow,
  unknown: Minus,
};

export interface ActorMarkProps {
  record: Pick<AuditRecord, 'actor' | 'actor_type'>;
  className?: string;
}

/**
 * The actor with its kind glyph. The kind is also in the accessible name ("Person:
 * trao"), so the glyph is never the only carrier of the fact.
 */
export function ActorMark({ record, className }: ActorMarkProps) {
  const kind = actorKindKey(record);
  const Icon = ACTOR_ICON[kind];
  const name = record.actor ? actorLabel(record.actor) : 'Not recorded';
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <span
        className={cn(
          'inline-flex size-5 shrink-0 items-center justify-center rounded-full',
          kind === 'agent' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
        aria-hidden
      >
        <Icon className="size-3" />
      </span>
      <span className="sr-only">{ACTOR_KIND_LABEL[kind]}: </span>
      <span className="min-w-0 truncate" title={name}>
        {name}
      </span>
    </span>
  );
}
