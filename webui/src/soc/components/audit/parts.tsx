/**
 * Small shared marks of the Audit log (Round 14 SPEC §4.5): the outcome (text plus a
 * glyph, never colour alone), the actor (a glyph for person, AI agent or system plus the
 * name) and a time element. Every value is a plain text node (#9).
 */
import { Ban, Bot, CheckCircle2, CircleDashed, Cog, Minus, User, Workflow, XCircle } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { AuditRecord } from '@/lib/types-audit';

import { actorLabel } from './events';
import { ACTOR_KIND_LABEL, OUTCOME_LABEL, actorKindKey, outcomeKey, type ActorKindKey, type OutcomeKey } from './audit-model';

const OUTCOME_STYLE: Readonly<Record<OutcomeKey, { Icon: typeof CheckCircle2; tone: string }>> = {
  success: { Icon: CheckCircle2, tone: 'text-success-text' },
  failure: { Icon: XCircle, tone: 'text-critical-text' },
  denied: { Icon: Ban, tone: 'text-high-text' },
  partial: { Icon: CircleDashed, tone: 'text-warning-text' },
  not_recorded: { Icon: Minus, tone: 'text-muted-foreground' },
};

export interface OutcomeMarkProps {
  record: Pick<AuditRecord, 'outcome' | 'outcome_derived'>;
  className?: string;
  /** Say "derived" after the word (the inspector): the outcome was read from an older row. */
  showDerived?: boolean;
}

/** "Success", "Failed", "Denied", "Partial" or "Not recorded", with its glyph. */
export function OutcomeMark({ record, className, showDerived = false }: OutcomeMarkProps) {
  const key = outcomeKey(record);
  const { Icon, tone } = OUTCOME_STYLE[key];
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap', tone, className)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{OUTCOME_LABEL[key]}</span>
      {showDerived && record.outcome_derived ? (
        <span className="text-xs font-normal text-muted-foreground">(derived)</span>
      ) : null}
    </span>
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
