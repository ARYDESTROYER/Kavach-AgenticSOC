/**
 * The runbook strip at the top of a case's Runbook tab (Round 14, SPEC §4.10.11): which
 * runbook, which pinned version, how and when it attached, "Why attached", "Add runbook"
 * and the More menu (Switch version when a newer one is published, Abandon run, Export as
 * Markdown). Under 640px of pane width it is one line ("Brute force and password spray ·
 * v4", the Why attached icon, the menu) so the Next step card starts high on a phone.
 *
 * With it, the progress line: "4 of 11 steps done · 1 not applicable · 5 required open ·
 * 1 waiting". On a wide pane it is the strip's last line, under how the run attached, so
 * the Next step card starts high; on a narrow pane it is its own short line under the
 * one-line strip.
 * Switching versions (any run not abandoned), abandoning (an active run) and exporting
 * never change the case (#3); each is audited by the server (#2).
 */
import * as React from 'react';
import { ArrowUpRight, BookCheck, Download, MoreHorizontal, Plus, Repeat2, XCircle } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import type { RunbookProgress, RunbookRun } from '@/lib/types-runbooks';

import { attachedLine, runStatusWords, runWorkable, type NameOf } from './model';
import { ReasonDialog } from './ReasonDialog';
import { WhyAttachedButton } from './WhyAttached';
import { ARIA_DISABLED_LOOK } from './ui';

/** The most runs a case holds (`409 run_limit` past it). */
export const MAX_RUNS_PER_CASE = 5;

function n(value: number): string {
  return Math.max(0, Math.trunc(value || 0)).toLocaleString();
}

/** "4 of 11 steps done · 1 not applicable · 5 required open · 1 waiting". */
export function ProgressLine({
  progress,
  short = false,
  className,
  id,
}: {
  progress: RunbookProgress;
  short?: boolean;
  className?: string;
  id?: string;
}) {
  const p = progress;
  const parts: React.ReactNode[] = [];
  parts.push(
    <span key="done" className="font-medium text-foreground">
      {short ? `${n(p.done)} of ${n(p.total)} done` : `${n(p.done)} of ${n(p.total)} ${p.total === 1 ? 'step' : 'steps'} done`}
    </span>,
  );
  if (!short && p.not_applicable > 0) parts.push(<span key="na">{n(p.not_applicable)} not applicable</span>);
  if (p.required_open > 0) parts.push(<span key="req">{n(p.required_open)} required open</span>);
  else if (p.total > 0) parts.push(<span key="clear">every required step done</span>);
  if (p.blocked > 0) {
    parts.push(
      <span key="blocked" className="font-medium text-critical-text">
        {n(p.blocked)} blocked
      </span>,
    );
  }
  if (p.waiting > 0) {
    parts.push(
      <span key="waiting" className="font-medium text-warning-text">
        {n(p.waiting)} waiting{short ? '' : ' for approval'}
      </span>,
    );
  }
  return (
    <p id={id} data-runbook-progress-line="" className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs tabular-nums text-muted-foreground', className)}>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span aria-hidden>·</span> : null}
          {part}
        </React.Fragment>
      ))}
    </p>
  );
}

/** The hint beside Add runbook at the run limit (read by keyboard and screen reader users). */
export const RUN_LIMIT_HINT = `A case holds at most ${MAX_RUNS_PER_CASE} runbooks.`;

export interface RunbookStripProps {
  run: RunbookRun;
  /** Every run on the case (for the run limit). */
  runCount: number;
  newerVersion: number | null;
  narrow: boolean;
  /** The run's progress: on a wide pane it is the strip's last line. */
  progress?: RunbookProgress | null;
  canRun: boolean;
  /** False when no new runbook can start (runbooks are turned off); defaults to `canRun`. */
  canAdd?: boolean;
  nameOf?: NameOf;
  onAdd: () => void;
  onSwitchVersion: (version: number) => Promise<boolean>;
  onAbandon: (reason: string) => Promise<boolean>;
  onExport: () => void;
  /** Open this runbook in the library (#/runbooks?id=...). */
  libraryHref?: string | null;
  abandonError?: string | null;
  now?: Date;
}

export function RunbookStrip({
  run,
  runCount,
  newerVersion,
  narrow,
  progress = null,
  canRun,
  canAdd = canRun,
  nameOf,
  onAdd,
  onSwitchVersion,
  onAbandon,
  onExport,
  libraryHref = null,
  abandonError = null,
  now = new Date(),
}: RunbookStripProps) {
  const [abandonOpen, setAbandonOpen] = React.useState(false);
  const [switchOpen, setSwitchOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLButtonElement | null>(null);
  const active = run.status === 'active';
  // A completed run can still move to a newer version (the server allows it); only an
  // active run can be abandoned.
  const workable = runWorkable(run);
  const atLimit = runCount >= MAX_RUNS_PER_CASE;
  const titleId = React.useId();
  const limitId = React.useId();

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={menuRef} variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Runbook actions">
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Runbook</DropdownMenuLabel>
        {narrow && canRun && canAdd ? (
          <DropdownMenuItem disabled={atLimit} onSelect={onAdd}>
            <Plus className="h-4 w-4" />
            Add runbook
          </DropdownMenuItem>
        ) : null}
        {newerVersion && canRun && workable ? (
          <DropdownMenuItem onSelect={() => setSwitchOpen(true)}>
            <Repeat2 className="h-4 w-4" />
            Switch to version {n(newerVersion)}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onExport}>
          <Download className="h-4 w-4" />
          Export as Markdown
        </DropdownMenuItem>
        {libraryHref ? (
          <DropdownMenuItem asChild>
            <a href={libraryHref}>
              <ArrowUpRight className="h-4 w-4" />
              Open in the Runbooks library
            </a>
          </DropdownMenuItem>
        ) : null}
        {canRun && active ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setAbandonOpen(true)}>
              <XCircle className="h-4 w-4" />
              Abandon run
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const versionText = `Version ${n(run.version)}`;
  const status = run.status === 'active' ? null : runStatusWords(run, now);

  return (
    <section aria-labelledby={titleId} data-runbook-strip="" data-narrow={narrow ? 'true' : undefined} className="space-y-2">
      {narrow ? (
        <div className="flex items-center gap-1">
          <BookCheck className="size-4 shrink-0 text-primary" aria-hidden />
          <h2
            id={titleId}
            tabIndex={-1}
            data-runbook-title=""
            className="ml-1 min-w-0 flex-1 truncate rounded-sm text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={run.title}
          >
            {run.title} <span className="font-normal tabular-nums text-muted-foreground">· v{n(run.version)}</span>
            {status ? <span className="font-normal text-muted-foreground"> · {status}</span> : null}
          </h2>
          <WhyAttachedButton iconOnly run={run} newerVersion={newerVersion} nameOf={nameOf} now={now} />
          {menu}
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary" aria-hidden>
            <BookCheck className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2
                id={titleId}
                tabIndex={-1}
                data-runbook-title=""
                className="min-w-0 rounded-sm text-md font-semibold text-foreground [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {run.title}
              </h2>
              <span className="rounded-sm border border-border px-1.5 py-0.5 text-xs font-medium tabular-nums leading-none text-muted-foreground">
                {versionText}
              </span>
              {status ? <span className="text-xs font-medium text-muted-foreground">{status}</span> : null}
              {newerVersion && workable ? (
                <span className="text-xs text-muted-foreground">A newer version exists (v{n(newerVersion)})</span>
              ) : null}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
              <span>{attachedLine(run, nameOf, now)}</span>
              <WhyAttachedButton run={run} newerVersion={newerVersion} nameOf={nameOf} now={now} />
            </div>
            {progress ? <ProgressLine progress={progress} className="mt-0.5" /> : null}
            {run.status === 'abandoned' && run.abandoned_reason ? (
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Abandoned: </span>
                {run.abandoned_reason}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {canRun && canAdd ? (
              <Button
                variant="outline"
                size="sm"
                className={cn('h-8', ARIA_DISABLED_LOOK)}
                onClick={atLimit ? undefined : onAdd}
                aria-disabled={atLimit || undefined}
                aria-describedby={atLimit ? limitId : undefined}
              >
                <Plus aria-hidden />
                Add runbook
              </Button>
            ) : null}
            {menu}
          </div>
          {canRun && canAdd && atLimit ? (
            <p id={limitId} className="basis-full text-right text-xs text-muted-foreground">
              {RUN_LIMIT_HINT}
            </p>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={switchOpen}
        onOpenChange={setSwitchOpen}
        title={`Switch this run to version ${n(newerVersion ?? 0)}?`}
        description={
          <>
            Steps that are in both versions keep their status, notes and evidence. Steps that are new start as To do,
            and steps the new version removed are dropped. The case does not change, and the switch is recorded in the
            audit log.
          </>
        }
        confirmLabel={`Switch to version ${n(newerVersion ?? 0)}`}
        // Opened from a menu item that is gone by now: back to the menu button.
        returnFocusRef={menuRef}
        onConfirm={() => {
          if (newerVersion) void onSwitchVersion(newerVersion);
        }}
      />
      <ReasonDialog
        open={abandonOpen}
        onOpenChange={setAbandonOpen}
        title="Abandon this runbook?"
        description="The run stays on the case, read only, and its steps keep what was recorded. Abandoning never changes the case."
        label="Why are you abandoning it?"
        placeholder="For example: the wrong runbook for this case"
        submitLabel="Abandon run"
        destructive
        error={abandonError}
        onSubmit={onAbandon}
        returnFocusTo={() => menuRef.current}
      />
    </section>
  );
}
