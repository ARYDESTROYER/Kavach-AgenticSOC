/**
 * Small shared marks of the Runbooks feature (Round 14, SPEC §4.10.11, §4.10.12): the step
 * kind chip, the step status mark, the governance badge, the provenance chip and the two
 * code-like chips (an identifier and a lookup template value).
 *
 * Used by the library and editor (W7a) and by the run inside a case (W7b). Every mark
 * carries its fact in text or in an accessible name, never in colour alone (WCAG 1.4.1),
 * and every value inside one is rendered as a plain text node (#9). Colours come only
 * from the theme tokens.
 */
import * as React from 'react';
import {
  Archive,
  Binary,
  Bot,
  Check,
  CircleCheck,
  Clock,
  Eye,
  GitBranch,
  Hand,
  Lock,
  Minus,
  NotebookPen,
  PencilLine,
  Search,
  SquareCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import type { RunbookOrigin, RunbookState, RunbookVersionState, StepKind } from '@/lib/types-runbooks';

import {
  KIND_HELP,
  KIND_LABEL,
  ORIGIN_LABEL,
  STEP_STATUS_LABEL,
  VERSION_STATE_LABEL,
  type StepDisplayStatus,
} from './labels';

export const KIND_ICON: Readonly<Record<StepKind, LucideIcon>> = {
  check: SquareCheck,
  lookup: Search,
  decision: GitBranch,
  action: Hand,
  record: NotebookPen,
};

/** The step kind as a quiet chip with its glyph ("Lookup"). */
export function KindChip({ kind, className }: { kind: StepKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return (
    <span
      data-step-kind={kind}
      title={KIND_HELP[kind]}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-sm border border-border bg-muted/50 px-1.5 py-0.5',
        'text-xs font-medium leading-none text-secondary-foreground',
        className,
      )}
    >
      <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      {KIND_LABEL[kind]}
    </span>
  );
}

const MARK_BOX = { sm: 'size-4', md: 'size-5', lg: 'size-6' } as const;
const MARK_GLYPH = { sm: 'size-2.5', md: 'size-3', lg: 'size-3.5' } as const;

/**
 * The circle at the start of a step row: empty (to do), half filled (in progress), ticked
 * (done), struck (not applicable), barred (blocked) or a clock (waiting for approval). It
 * is an image named by the status, so a screen reader hears "Done" where a sighted reader
 * sees the tick.
 */
export function StatusMark({
  status,
  size = 'md',
  className,
}: {
  status: StepDisplayStatus;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const box = MARK_BOX[size];
  const glyph = MARK_GLYPH[size];
  const common = cn(box, 'inline-flex shrink-0 items-center justify-center rounded-full', className);
  const label = STEP_STATUS_LABEL[status];
  switch (status) {
    case 'done':
      return (
        <span role="img" aria-label={label} data-status-mark={status} className={cn(common, 'bg-success text-success-foreground')}>
          <Check className={glyph} strokeWidth={3} aria-hidden />
        </span>
      );
    case 'not_applicable':
      return (
        <span
          role="img"
          aria-label={label}
          data-status-mark={status}
          className={cn(common, 'border-2 border-border-strong bg-muted text-muted-foreground')}
        >
          <Minus className={glyph} strokeWidth={3} aria-hidden />
        </span>
      );
    case 'blocked':
      return (
        <span
          role="img"
          aria-label={label}
          data-status-mark={status}
          className={cn(common, 'border-2 border-critical bg-critical/10 text-critical-text')}
        >
          <span className="h-0.5 w-2 rounded-full bg-current" aria-hidden />
        </span>
      );
    case 'waiting':
      return (
        <span
          role="img"
          aria-label={label}
          data-status-mark={status}
          className={cn(common, 'border-2 border-warning bg-warning/10 text-warning-text')}
        >
          <Clock className={glyph} strokeWidth={2.5} aria-hidden />
        </span>
      );
    case 'in_progress':
      return (
        <span role="img" aria-label={label} data-status-mark={status} className={cn(common, 'border-2 border-primary p-0.5')}>
          <span className="size-full rounded-full bg-[linear-gradient(90deg,hsl(var(--primary))_50%,transparent_50%)]" aria-hidden />
        </span>
      );
    default:
      return (
        <span
          role="img"
          aria-label={label}
          data-status-mark="todo"
          className={cn(common, 'border-2 border-border-strong bg-background')}
        />
      );
  }
}

const GOVERNANCE: Readonly<Record<RunbookVersionState, { icon: LucideIcon; tone: string }>> = {
  published: { icon: CircleCheck, tone: 'border-success/25 bg-success/10 text-success-text' },
  in_review: { icon: Eye, tone: 'border-info/25 bg-info/10 text-info-text' },
  draft: { icon: PencilLine, tone: 'border-border bg-muted text-secondary-foreground' },
  superseded: { icon: Archive, tone: 'border-border bg-transparent text-muted-foreground' },
  retired: { icon: Archive, tone: 'border-border bg-transparent text-muted-foreground' },
};

/** A runbook or version state as a badge with its glyph and version ("Published v4"). */
export function GovernanceBadge({
  state,
  version,
  className,
}: {
  state: RunbookState | RunbookVersionState;
  version?: number | null;
  className?: string;
}) {
  const meta = GOVERNANCE[state];
  const Icon = meta.icon;
  return (
    <span
      data-governance={state}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-xs font-medium leading-tight',
        meta.tone,
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {VERSION_STATE_LABEL[state]}
      {version != null ? <span className="tabular-nums">v{version.toLocaleString()}</span> : null}
    </span>
  );
}

/** Where a runbook comes from: Built-in (read only, with a lock), Yours or Imported. */
export function OriginBadge({ origin, className }: { origin: RunbookOrigin; className?: string }) {
  return (
    <span
      data-origin={origin}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-border px-1.5 py-0.5 text-xs font-medium leading-tight text-secondary-foreground',
        className,
      )}
    >
      {origin === 'builtin' ? <Lock className="size-3 shrink-0" aria-hidden /> : null}
      {ORIGIN_LABEL[origin]}
    </span>
  );
}

export type ProvenanceKind = 'auto' | 'ai' | 'person';

const PROVENANCE: Readonly<Record<ProvenanceKind, { icon: LucideIcon; label: string; wrap: string; tint: string }>> = {
  auto: { icon: Binary, label: 'Collected automatically', wrap: 'border-border bg-muted/60', tint: 'text-muted-foreground' },
  ai: { icon: Bot, label: 'AI draft', wrap: 'border-primary/30 bg-primary/10', tint: 'text-primary' },
  person: { icon: UserRound, label: 'Added by a person', wrap: 'border-border-strong bg-secondary', tint: 'text-foreground' },
};

/** Where a piece of evidence or text came from: collected automatically, an AI draft, a person. */
export function ProvenanceChip({
  kind,
  children,
  className,
}: {
  kind: ProvenanceKind;
  children?: React.ReactNode;
  className?: string;
}) {
  const meta = PROVENANCE[kind];
  const Icon = meta.icon;
  return (
    <span
      data-provenance={kind}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium leading-none text-foreground',
        meta.wrap,
        className,
      )}
    >
      <Icon className={cn('size-3 shrink-0', meta.tint)} aria-hidden />
      {children ?? meta.label}
    </span>
  );
}

/** A rule id, technique id, field name or other identifier, in the identifier face. */
export function Mono({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <code
      title={title}
      className={cn(
        'rounded-sm border border-border bg-muted/60 px-1 py-px font-mono text-xs text-foreground [overflow-wrap:anywhere]',
        className,
      )}
    >
      {children}
    </code>
  );
}

/** A lookup template value such as `{{entity.ip}}`: filled from the case, never pasted as text. */
export function TemplateChip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code
      data-template-value=""
      className={cn(
        'rounded-sm border border-primary/30 bg-primary/10 px-1 py-px font-mono text-xs text-foreground',
        className,
      )}
    >
      {children}
    </code>
  );
}

/** The person monogram used in rows (decorative beside a visible name). */
export function PersonMark({ name, className }: { name: string; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-5 shrink-0 select-none items-center justify-center rounded-full bg-muted-foreground text-2xs font-semibold leading-none text-background',
        className,
      )}
    >
      {initial}
    </span>
  );
}

/** The 6px amber dot that marks a phase with a step waiting for someone else (decorative). */
export function WaitingDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full bg-warning', className)} />;
}

/** The read-only lock line a built-in or a viewer without the grant sees. */
export function ReadOnlyNote({ children, className, id }: { children: React.ReactNode; className?: string; id?: string }) {
  return (
    <p id={id} className={cn('flex items-start gap-1.5 text-sm text-muted-foreground', className)}>
      <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
