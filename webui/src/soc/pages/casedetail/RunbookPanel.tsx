/**
 * The Runbook tab of a case (Round 14, SPEC §4.10.11, C10 B): the run inside the case.
 *
 * Top to bottom: the runbook strip (title, pinned version, how and when it attached, Why
 * attached, Add runbook, More), the progress line, the Next step card pinned on top, the
 * phase tabs with only the selected phase's steps, "Other tasks" (the case's free-form
 * tasks), and one line on what a runbook can and cannot do. With no run: "No runbook is
 * attached to this case." and Start runbook. Several runs on a case get a run switcher.
 *
 * Lazy: loaded only when the tab opens (SPEC §3.4). The runs come from the case detail's
 * `useCaseRunbooks`, shared with the Overview card, the facts rail and the close dialog.
 * A viewer without `runbooks:run` reads every step and changes none ("You can view this
 * runbook but not update it."). While runbooks are turned off in Settings the server
 * refuses every run write, so the runs on the case are read only too ("Runbooks are
 * turned off in Settings, so steps cannot change.") and no runbook starts. Demo Mode
 * reads the Demo store; nothing differs here.
 *
 * One root element holds every state (loading, empty, the run), so the width it is
 * measured by and the polite live region never remount. A request to land somewhere (the
 * Overview card, a facts-rail phase, Start runbook, Other tasks) is handled once and then
 * reported back, so coming back to the tab never replays it.
 *
 * #3: a runbook never closes the case or changes its verdict; "Close case" on the card
 * only opens the case's own close dialog. #9: run data and lookup values are text.
 */
import * as React from 'react';
import { BookCheck, Info } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/cn';
import { api, requestResponse } from '@/lib/api';
import { downloadBlob } from '@/lib/download-blob';
import { abandonRunbookRun, switchRunbookRunVersion } from '@/lib/api-runbooks';
import type { Case } from '@/lib/types';
import type { PhaseId, RunbookAttachResult, RunbookRun } from '@/lib/types-runbooks';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { ReadOnlyNote, runbookFailure } from '@/soc/runbooks/shared';
import { RunbookRunProvider, useRunbookRunOptional } from '@/soc/runbooks/run/context';
import {
  attachedLine,
  holdsApprovalRole,
  nextStep,
  primaryRun,
  progressOf,
  runPhases,
  runStatusWords,
  type NameOf,
  type ViewerRoles,
} from '@/soc/runbooks/run/model';
import { NextStepCard, focusHeading } from '@/soc/runbooks/run/NextStepCard';
import { OtherTasks } from '@/soc/runbooks/run/OtherTasks';
import { PhaseTabs } from '@/soc/runbooks/run/PhaseTabs';
import { ProgressLine, RunbookStrip } from '@/soc/runbooks/run/RunbookStrip';
import { StartRunbookDialog } from '@/soc/runbooks/run/StartRunbookDialog';
import type { CaseRunbooksState } from '@/soc/runbooks/run/useCaseRunbooks';
import { useNarrow } from '@/soc/runbooks/run/useNarrow';
import type { PickableUser } from '@/soc/pages/CaseDetail.api';
import { caseLabel } from '@/lib/format-values';

/** Where the tab should land when it opens (from the Overview card, the facts rail, Take action or Collaboration). */
export type RunbookFocusRequest =
  | { kind: 'card'; tick: number }
  | { kind: 'step'; stepId: string; tick: number }
  | { kind: 'phase'; phase: PhaseId; tick: number }
  | { kind: 'start'; tick: number }
  | { kind: 'tasks'; tick: number };

export const RUNBOOK_BOUNDARY_NOTE =
  'A runbook guides the people on this case. It never closes the case and never changes its verdict; your case policy makes the close or escalate decision. Every step change is recorded in the audit log.';

export const READ_ONLY_RUN_NOTE = 'You can view this runbook but not update it.';
export const RUNBOOKS_OFF_RUN_NOTE = 'Runbooks are turned off in Settings, so steps cannot change.';
export const EMPTY_RUNBOOK_LEAD = 'Start one to guide the work on this case.';

export interface RunbookPanelProps {
  c: Case;
  runbooks: CaseRunbooksState;
  /** The viewer holds runbooks:run (and the case shown is the current one). */
  canRun: boolean;
  /**
   * False while runbooks are turned off in Settings: no runbook starts and the runs on the
   * case are read only (the server refuses every run write then). Defaults to true.
   */
  enabled?: boolean;
  /** False when no new runbook can start for another reason. Defaults to true. */
  canStart?: boolean;
  /** cases:write, for the free-form tasks. */
  canWriteTasks: boolean;
  hasPermission: (resource: string, action: string) => boolean;
  currentUser: string | null;
  users: PickableUser[];
  /**
   * The viewer's base role and whether role checks are off, for the approval hint ("Only a
   * soc manager can approve this step."). Unknown when absent: Approve stays offered and
   * the server decides.
   */
  viewer?: { role: string | null; unrestricted: boolean } | null;
  /** The viewer's assigned custom roles (read once, only when an approval needs them). */
  loadCustomRoles?: () => Promise<readonly string[]>;
  aiDrafts?: boolean;
  aiSuggest?: boolean;
  /** Open the case's close dialog (the card's "Close case" when every required step is done). */
  onCloseCase?: () => void;
  focusRequest?: RunbookFocusRequest | null;
  /** Called once a focus request was handled, so the caller can forget it. */
  onFocusRequestHandled?: (tick: number) => void;
  className?: string;
}

/** A user name as the person's display name when the users list has one. */
export function nameResolver(users: readonly PickableUser[]): NameOf {
  const map = new Map(users.map((u) => [u.username, (u.display_name || '').trim() || u.username] as const));
  return (username: string) => map.get(username) ?? username;
}

/** The signed-in viewer's custom roles, from their own account (`GET /api/account/me`). */
async function loadOwnCustomRoles(): Promise<readonly string[]> {
  const profile = (await api.account.get()) as unknown as { prefs?: { custom_roles?: unknown } };
  const roles = profile?.prefs?.custom_roles;
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
}

/**
 * What the Console knows of the viewer's roles. The custom roles are read once, and only
 * when a step waiting for approval names a role the base role does not settle.
 */
function useViewerRoles(
  viewer: RunbookPanelProps['viewer'],
  approvalRoles: readonly string[],
  load: () => Promise<readonly string[]>,
): ViewerRoles | null {
  const [custom, setCustom] = React.useState<readonly string[] | null>(null);
  const asked = React.useRef(false);
  const base = viewer ? { unrestricted: viewer.unrestricted, role: viewer.role, custom: null } : null;
  const needed = Boolean(base) && approvalRoles.some((role) => holdsApprovalRole(role, base) === null);
  React.useEffect(() => {
    if (!needed || asked.current) return undefined;
    asked.current = true;
    let alive = true;
    load()
      .then((roles) => {
        if (alive) setCustom(roles);
      })
      .catch(() => undefined); // unknown stays unknown: the server decides
    return () => {
      alive = false;
    };
  }, [needed, load]);
  return React.useMemo(
    () => (viewer ? { unrestricted: viewer.unrestricted, role: viewer.role, custom } : null),
    [viewer, custom],
  );
}

/** Download one run's pinned version as Markdown. */
async function exportRunVersion(run: RunbookRun): Promise<void> {
  try {
    const res = await requestResponse('GET', `runbooks/${encodeURIComponent(run.runbook_id)}/export`, {
      query: { version: run.version },
    });
    const blob = await res.blob();
    if (!downloadBlob(`${run.runbook_id}-v${run.version}.md`, blob)) toast.error('This browser could not start the download.');
  } catch (err) {
    toast.error(runbookFailure(err, 'Could not export this runbook.').message);
  }
}

/** Run `find` on the next frames until it finds what it looks for (the target may render a frame late). */
function onNextFrames(find: () => boolean, tries = 3): void {
  requestAnimationFrame(() => {
    if (!find() && tries > 1) onNextFrames(find, tries - 1);
  });
}

/**
 * Hands a focus request from outside the tab to the content inside it, once per request
 * (a remount of the tab never replays one: the caller forgets it on `onHandled`).
 */
function RequestHandler({
  request,
  rootRef,
  onPhase,
  onHandled,
}: {
  request: RunbookFocusRequest | null | undefined;
  rootRef: React.RefObject<HTMLElement | null>;
  onPhase: (phase: PhaseId) => void;
  onHandled?: (tick: number) => void;
}) {
  const ctx = useRunbookRunOptional();
  const handled = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!request || request.kind === 'start' || handled.current === request.tick) return;
    handled.current = request.tick;
    const find = (selector: string) => rootRef.current?.querySelector<HTMLElement>(selector) ?? null;
    // The Next step card's heading, else the runbook's title (an abandoned run has no card).
    const land = () => {
      const target = find('[data-next-step-heading]') ?? find('[data-runbook-title]');
      if (target) focusHeading(target);
      return Boolean(target);
    };
    if (request.kind === 'tasks') {
      onNextFrames(() => {
        const heading = find('[data-other-tasks-heading]');
        if (heading) focusHeading(heading);
        return Boolean(heading);
      });
    } else if (ctx) {
      if (request.kind === 'step') {
        if (nextStep(ctx.run)?.step.id === request.stepId) onNextFrames(land);
        else ctx.revealStep(request.stepId);
      } else if (request.kind === 'phase') {
        onPhase(request.phase);
        onNextFrames(() => {
          const tab = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-runbook-phases] [role="tab"]') ?? []).find(
            (el) => el.dataset.phase === request.phase,
          );
          tab?.focus();
          return Boolean(tab);
        });
      } else {
        onNextFrames(land);
      }
    }
    onHandled?.(request.tick);
  }, [request, ctx, rootRef, onPhase, onHandled]);
  return null;
}

function PanelSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading the runbook">
      <Skeleton className="h-10 w-80 max-w-full" />
      <Skeleton className="h-4 w-64 max-w-full" />
      <Skeleton className="h-36 w-full" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function RunbookPanel({
  c,
  runbooks,
  canRun: canRunProp,
  enabled = true,
  canStart: canStartProp,
  canWriteTasks,
  hasPermission,
  currentUser,
  users,
  viewer = null,
  loadCustomRoles = loadOwnCustomRoles,
  aiDrafts = true,
  aiSuggest = true,
  onCloseCase,
  focusRequest = null,
  onFocusRequestHandled,
  className,
}: RunbookPanelProps) {
  const { data, loading, error, refresh, applyUpdate, applyAttach } = runbooks;
  // Runbooks turned off: the server refuses every run write, so nothing here offers one.
  const canRun = canRunProp && enabled;
  const canStart = canRun && (canStartProp ?? true);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [narrow, observeWidth] = useNarrow(640);
  const setRoot = React.useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      observeWidth(el);
    },
    [observeWidth],
  );
  const nameOf = React.useMemo(() => nameResolver(users), [users]);
  const [runId, setRunId] = React.useState<string | null>(null);
  const [phaseChoice, setPhaseChoice] = React.useState<{ runId: string; phase: PhaseId } | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [abandonError, setAbandonError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState('');
  const startButtonRef = React.useRef<HTMLButtonElement | null>(null);

  const runs = React.useMemo(() => data?.runs ?? [], [data]);
  const run = runs.find((r) => r.run_id === runId) ?? primaryRun(data);

  // The phase shown: the person's choice for this run while its snapshot has that phase,
  // else a phase a request asked for, else the Next step's, else the first. A new run (or
  // a version that dropped the chosen phase) starts from the default again.
  const phases = React.useMemo(() => (run ? runPhases(run) : []), [run]);
  const askedPhase = focusRequest?.kind === 'phase' && phases.includes(focusRequest.phase) ? focusRequest.phase : null;
  const defaultPhase = askedPhase ?? (run ? nextStep(run)?.step.phase : null) ?? phases[0] ?? null;
  if (run && defaultPhase && phaseChoice?.runId !== run.run_id) {
    // Fixed when a run is first shown, so finishing a step never moves the tabs under the person.
    setPhaseChoice({ runId: run.run_id, phase: defaultPhase });
  }
  const shownPhase =
    run && phaseChoice?.runId === run.run_id && phases.includes(phaseChoice.phase) ? phaseChoice.phase : defaultPhase;
  const shownRunId = run?.run_id ?? null;
  const choosePhase = React.useCallback(
    (phase: PhaseId) => {
      if (shownRunId) setPhaseChoice({ runId: shownRunId, phase });
    },
    [shownRunId],
  );

  const approvalRoles = React.useMemo(() => {
    const out: string[] = [];
    for (const step of run?.snapshot.steps ?? []) {
      const approval = run?.steps?.[step.id]?.approval;
      const role = approval?.status === 'pending' ? approval.required_role ?? step.approval_role : null;
      if (role) out.push(role);
    }
    return out;
  }, [run]);
  const viewerRoles = useViewerRoles(viewer, approvalRoles, loadCustomRoles);

  const announce = React.useCallback((text: string) => {
    setMessage('');
    // A new node each time, so the same sentence twice is still read.
    window.setTimeout(() => setMessage(text), 30);
  }, []);

  // "Start runbook" from outside (the Take action menu), once the runs are known.
  const startTick = focusRequest?.kind === 'start' ? focusRequest.tick : null;
  const loaded = data !== null;
  React.useEffect(() => {
    if (startTick === null || !loaded) return;
    if (canStart) setPickerOpen(true);
    onFocusRequestHandled?.(startTick);
  }, [startTick, loaded, canStart, onFocusRequestHandled]);

  const onStarted = (result: RunbookAttachResult) => {
    if (result.already_attached) {
      toast.message('That runbook is already on this case.');
      void refresh();
      if (result.run) setRunId(result.run.run_id);
      return;
    }
    applyAttach(result);
    if (result.run) {
      setRunId(result.run.run_id);
      announce(`${result.run.title} started. ${attachedLine(result.run, nameOf)}.`);
    }
  };

  const caseLine = `${caseLabel(c)} · ${c.title || c.case_id}`;
  const canReadLibrary = hasPermission('runbooks', 'read');

  const liveRegion = (
    <p className="sr-only" aria-live="polite" aria-atomic="true" data-runbook-live="">
      {message}
    </p>
  );

  const picker = (
    <StartRunbookDialog
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      caseId={c.case_id}
      caseLine={caseLine}
      aiSuggest={aiSuggest}
      attachedIds={runs.map((r) => r.runbook_id)}
      onStarted={onStarted}
      returnFocusTo={() => startButtonRef.current ?? rootRef.current?.querySelector<HTMLElement>('[data-next-step-heading]') ?? null}
    />
  );

  const otherTasks = data ? (
    <OtherTasks caseId={c.case_id} tasks={data.other_tasks ?? []} canWrite={canWriteTasks} nameOf={nameOf} onChanged={refresh} />
  ) : null;

  const requests = (
    <RequestHandler request={focusRequest} rootRef={rootRef} onPhase={choosePhase} onHandled={onFocusRequestHandled} />
  );

  let content: React.ReactNode;
  if (!data) {
    content = error ? (
      <LoadError error={error} title="Could not load the runbook" onRetry={() => void refresh()} />
    ) : (
      <PanelSkeleton />
    );
  } else if (!run) {
    content = (
      <div className="space-y-6">
        {requests}
        <div className="space-y-3">
          <EmptyState
            state="no-data"
            icon={BookCheck}
            title="No runbook is attached to this case."
            description={
              <>
                {canStart ? `${EMPTY_RUNBOOK_LEAD} ` : null}
                Rules with no runbook are listed on the{' '}
                {canReadLibrary ? (
                  <a href="#/runbooks" className="underline underline-offset-2 hover:text-foreground">
                    Runbooks page
                  </a>
                ) : (
                  'Runbooks page'
                )}
                .
              </>
            }
            action={
              canStart ? (
                <Button ref={startButtonRef} onClick={() => setPickerOpen(true)}>
                  <BookCheck aria-hidden />
                  Start runbook
                </Button>
              ) : undefined
            }
          />
          {!enabled ? (
            <ReadOnlyNote className="justify-center">Runbooks are turned off in Settings, so no new runbook can start.</ReadOnlyNote>
          ) : !canRunProp ? (
            <ReadOnlyNote className="justify-center">You can view runbooks but not start one.</ReadOnlyNote>
          ) : null}
          {error ? (
            <p role="status" className="text-center text-xs text-critical-text">
              The runbook could not be refreshed. Showing what was loaded.
            </p>
          ) : null}
        </div>
        {otherTasks}
        {picker}
      </div>
    );
  } else {
    const progress = progressOf(data, run);
    const newer = data.newer_versions?.[run.run_id] ?? null;
    content = (
      <RunbookRunProvider
        caseId={c.case_id}
        caseLabel={caseLabel(c)}
        data={data}
        run={run}
        canRun={canRun}
        hasPermission={hasPermission}
        viewer={viewerRoles}
        aiDrafts={aiDrafts}
        currentUser={currentUser}
        nameOf={nameOf}
        users={users}
        applyUpdate={applyUpdate}
        announce={announce}
      >
        <div className="space-y-3">
          {requests}
          {runs.length > 1 ? (
            <nav aria-label="Runbooks on this case" className="flex flex-wrap gap-1.5">
              {runs.map((r) => (
                <Button
                  key={r.run_id}
                  size="sm"
                  variant={r.run_id === run.run_id ? 'secondary' : 'ghost'}
                  aria-current={r.run_id === run.run_id ? 'true' : undefined}
                  className={cn('h-auto max-w-full whitespace-normal py-1 text-left', r.status === 'abandoned' && 'text-muted-foreground')}
                  onClick={() => setRunId(r.run_id)}
                >
                  <span className="[overflow-wrap:anywhere]">{r.title}</span>
                  <span className="text-xs font-normal text-muted-foreground">· {runStatusWords(r)}</span>
                </Button>
              ))}
            </nav>
          ) : null}

          <RunbookStrip
            run={run}
            runCount={runs.length}
            newerVersion={newer}
            narrow={narrow}
            progress={narrow ? null : progress}
            canRun={canRun}
            canAdd={canStart}
            nameOf={nameOf}
            libraryHref={canReadLibrary ? `#/runbooks?id=${encodeURIComponent(run.runbook_id)}` : null}
            onAdd={() => setPickerOpen(true)}
            onExport={() => void exportRunVersion(run)}
            abandonError={abandonError}
            onSwitchVersion={async (version) => {
              try {
                const update = await switchRunbookRunVersion(c.case_id, run.run_id, version);
                applyUpdate(update);
                announce(`Switched to version ${version.toLocaleString()}.`);
                toast.success(`Switched to version ${version.toLocaleString()}.`);
                return true;
              } catch (err) {
                toast.error(runbookFailure(err, 'The version could not be switched.').message);
                return false;
              }
            }}
            onAbandon={async (reason) => {
              try {
                const update = await abandonRunbookRun(c.case_id, run.run_id, reason);
                applyUpdate(update);
                setAbandonError(null);
                announce('Runbook abandoned. The case did not change.');
                return true;
              } catch (err) {
                setAbandonError(runbookFailure(err, 'The run could not be abandoned.').message);
                return false;
              }
            }}
          />
          {narrow ? <ProgressLine progress={progress} short /> : null}
          {!enabled ? (
            <ReadOnlyNote>{RUNBOOKS_OFF_RUN_NOTE}</ReadOnlyNote>
          ) : !canRunProp ? (
            <ReadOnlyNote>{READ_ONLY_RUN_NOTE}</ReadOnlyNote>
          ) : null}
          {error ? (
            <p role="status" className="text-xs text-critical-text">
              The runbook could not be refreshed. Showing what was loaded.{' '}
              <button type="button" className="underline underline-offset-2" onClick={() => void refresh()}>
                Try again
              </button>
            </p>
          ) : null}

          <NextStepCard compact={narrow} onCloseCase={onCloseCase} />

          {shownPhase ? <PhaseTabs phase={shownPhase} onPhaseChange={choosePhase} narrow={narrow} /> : null}

          {otherTasks}

          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{RUNBOOK_BOUNDARY_NOTE}</span>
          </p>
          {picker}
        </div>
      </RunbookRunProvider>
    );
  }

  return (
    <div
      ref={setRoot}
      className={cn('@container/run mx-auto w-full max-w-[56rem]', className)}
      data-case-panel="runbook"
      data-narrow={narrow ? 'true' : undefined}
      aria-busy={(loading && data !== null) || undefined}
    >
      {liveRegion}
      {content}
    </div>
  );
}

export default RunbookPanel;
