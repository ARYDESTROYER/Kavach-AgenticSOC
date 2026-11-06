import * as React from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import type { SystemUpdateJob, SystemUpdateStage } from '@/lib/types';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Progress } from '@/ui/progress';
import { ScrollArea } from '@/ui/scroll-area';
import { Separator } from '@/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { usePrefersReducedMotion } from '@/soc/hooks/usePrefersReducedMotion';
import { TOP_BAR_FOLD_HIDDEN } from '@/soc/top-bar-fold';
import {
  systemUpdateStageLabel,
  type DeploymentUpgradeState,
} from '@/soc/hooks/useDeploymentUpgrade';
import { ConfirmDialog } from './ConfirmDialog';

const orderedStages: SystemUpdateStage[] = [
  'validating',
  'verifying_artifacts',
  'pulling_images',
  'quiescing',
  'backing_up',
  'updating_backend',
  'verifying_backend',
  'updating_webui',
  'verifying_webui',
  'observing',
  'completed',
];

const beforeServiceRestart = new Set<SystemUpdateStage>([
  'validating',
  'verifying_artifacts',
  'pulling_images',
]);

function stagePosition(stage: SystemUpdateStage): number {
  return orderedStages.indexOf(stage);
}

function stageState(
  stage: SystemUpdateStage,
  job: SystemUpdateJob,
): 'pending' | 'running' | 'succeeded' | 'failed' {
  if (job.status === 'succeeded') return 'succeeded';
  if (job.status === 'rolled_back' || job.status === 'rolling_back') return 'pending';
  const current = stagePosition(job.stage);
  const candidate = stagePosition(stage);
  if (candidate >= 0 && current >= 0 && candidate < current) return 'succeeded';
  if (stage === job.stage) {
    if (job.status === 'failed') return 'failed';
    if (job.status === 'cancelled') return 'failed';
    return 'running';
  }
  return 'pending';
}

function StageIcon({ state, reducedMotion }: { state: ReturnType<typeof stageState>; reducedMotion: boolean }) {
  if (state === 'succeeded') return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />;
  if (state === 'failed') return <XCircle className="h-4 w-4 text-critical" aria-hidden />;
  if (state === 'running') {
    return (
      <Loader2
        className={cn('h-4 w-4 text-primary', !reducedMotion && 'animate-spin')}
        aria-hidden
      />
    );
  }
  return <Circle className="h-4 w-4 text-muted-foreground/50" aria-hidden />;
}

export function systemUpdateTriggerPresentation(upgrade: DeploymentUpgradeState): {
  visible: boolean;
  label: string;
  accessible: string;
  tone: 'default' | 'outline' | 'destructive';
  spinning: boolean;
  priority: 'actionable' | 'secondary';
} {
  const { job, status, connection } = upgrade;
  if (job && ['queued', 'running', 'rolling_back'].includes(job.status)) {
    const rollingBack = job.status === 'rolling_back';
    const stage = rollingBack ? 'Rolling back' : systemUpdateStageLabel(job.stage);
    return {
      visible: true,
      label: stage,
      accessible: `System update in progress: ${stage}`,
      tone: rollingBack ? 'destructive' : 'outline',
      spinning: true,
      priority: 'actionable',
    };
  }
  if (job?.status === 'rolled_back') {
    return {
      visible: true,
      label: 'Rolled back',
      accessible: 'The last system update was rolled back',
      tone: 'destructive',
      spinning: false,
      priority: 'secondary',
    };
  }
  if (job?.status === 'failed') {
    return {
      visible: true,
      label: 'Update failed',
      accessible: 'The last system update failed',
      tone: 'destructive',
      spinning: false,
      priority: 'actionable',
    };
  }
  // Runtime support is authoritative. A mutable branch observation must never
  // outrank a missing/unsupported supervisor or look pre-verified in the shell.
  if (status && !status.capability.supported) {
    return {
      visible: true,
      label: status.capability.bootstrap_required ? 'Enable updates' : 'Updates unavailable',
      accessible: status.capability.bootstrap_required
        ? 'One-time update supervisor setup is required'
        : 'System updates are unavailable on this deployment',
      tone: 'outline',
      spinning: false,
      priority: 'secondary',
    };
  }
  const observation = status?.release_discovery;
  if (observation?.state === 'candidate_observed' && observation.observed_release) {
    return {
      visible: true,
      label: `Review v${observation.observed_release.version}`,
      accessible: `Verify and prepare Stable v${observation.observed_release.version} update`,
      tone: 'default',
      spinning: upgrade.preparing || upgrade.starting,
      priority: 'actionable',
    };
  }
  // A terminal receipt remains operator-relevant after the coherent-pair reload.
  // Keep it reachable until a newer candidate needs the same compact top-bar slot.
  if (job?.status === 'succeeded') {
    return {
      visible: true,
      label: 'Updated',
      accessible: 'Last system update completed; open verified receipt and rollback controls',
      tone: 'outline',
      spinning: false,
      priority: 'secondary',
    };
  }
  if (
    observation &&
    (observation.state === 'unavailable' ||
      observation.state === 'stale' ||
      observation.state === 'error')
  ) {
    return {
      visible: true,
      label: 'Check updates',
      accessible: 'Stable update check needs attention',
      tone: 'outline',
      spinning: upgrade.checking,
      priority: 'secondary',
    };
  }
  if (connection === 'unavailable' && !upgrade.checking) {
    return {
      visible: true,
      label: 'Updates unavailable',
      accessible: 'System update status is unavailable',
      tone: 'outline',
      spinning: false,
      priority: 'secondary',
    };
  }
  return {
    visible: false,
    label: '',
    accessible: '',
    tone: 'outline',
    spinning: false,
    priority: 'secondary',
  };
}

export interface SystemUpdateControlProps {
  upgrade: DeploymentUpgradeState;
  hasUnsavedChanges: boolean;
  canRollback: boolean;
}

/** Top-bar trigger, server-bound preflight, and resumable durable progress sheet. */
export function SystemUpdateControl({
  upgrade,
  hasUnsavedChanges,
  canRollback,
}: SystemUpdateControlProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const trigger = systemUpdateTriggerPresentation(upgrade);
  const observedRelease = upgrade.status?.release_discovery.observed_release ?? null;
  const verifiedRelease = upgrade.preflight?.release ?? null;
  const releaseVersion = verifiedRelease?.version ?? observedRelease?.version ?? null;
  const job = upgrade.job;

  const begin = () => {
    const activeOrUnresolvedJob =
      job && (job.status !== 'succeeded' || !observedRelease);
    if (activeOrUnresolvedJob || upgrade.status?.capability.supported !== true || !observedRelease) {
      upgrade.setProgressOpen(true);
      return;
    }
    upgrade.dismissPreflight();
    setConfirmOpen(true);
    if (!hasUnsavedChanges) void upgrade.prepare();
  };

  if (!trigger.visible) return null;

  const preflightBlocked = Boolean(upgrade.preflight?.blockers.length);
  const canCancel = Boolean(
    job &&
      (job.status === 'queued' || job.status === 'running') &&
      beforeServiceRestart.has(job.stage),
  );
  const canRequestRollback = Boolean(
    canRollback &&
      job &&
      job.status === 'succeeded' &&
      job.rollback?.supported !== false,
  );

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {trigger.accessible}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant={trigger.tone}
            data-testid="system-update-button"
            className={cn(
              'h-7 shrink-0 gap-1.5 whitespace-nowrap px-2.5 text-xs',
              trigger.tone === 'destructive' &&
                'border-critical/30 bg-critical/10 text-critical-text hover:bg-critical/15',
            )}
            aria-label={trigger.accessible}
            disabled={upgrade.starting}
            onClick={begin}
          >
            {/* A running update is progress, not a refresh: the progress ring turns while
                a job runs and the update glyph rests otherwise (SPEC §4.9.2 keeps the
                spinning refresh glyph for RefreshButton alone). */}
            {trigger.spinning ? (
              <Loader2
                className={cn('h-3.5 w-3.5', !reducedMotion && 'animate-spin')}
                aria-hidden
                data-update-progress=""
              />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
            {/* The label shows where the top bar has room (`@container/topbar`, 62rem of
                bar, folding when the bar is crowded); compact, the icon keeps its tooltip
                and full accessible name. */}
            <span className={cn('hidden @[62rem]/topbar:inline', TOP_BAR_FOLD_HIDDEN.update)}>
              {upgrade.starting ? 'Starting…' : trigger.label}
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{trigger.accessible}</TooltipContent>
      </Tooltip>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) upgrade.dismissPreflight();
        }}
        title={
          hasUnsavedChanges
            ? 'Save your changes first'
            : upgrade.preparing
              ? 'Running update preflight'
              : preflightBlocked
                ? 'Update is blocked'
                : releaseVersion
                  ? `Update to Stable v${releaseVersion}?`
                  : 'Prepare system update'
        }
        description={
          hasUnsavedChanges ? (
            <span className="block">
              You have unsaved changes. Save or discard them before updating so the Console can
              reconnect without losing your draft.
            </span>
          ) : upgrade.preparing ? (
            <span className="flex items-center gap-2">
              <Loader2
                className={cn('h-4 w-4', !reducedMotion && 'animate-spin')}
                aria-hidden
              />
              Verifying compatibility, durable configuration, backup readiness, and rollback.
            </span>
          ) : upgrade.preflight ? (
            <span className="block space-y-3 text-left">
              <span className="block">
                The supervisor will install the signed backend, Console, and bundled Help Center
                from the immutable Stable release. PostgreSQL and Redis are not upgraded.
              </span>
              <span className="block rounded-md border border-border bg-muted/30 p-3">
                <span className="block font-medium text-foreground">Backup and rollback</span>
                <span className="mt-1 block">{upgrade.preflight.backup.description}</span>
                <span className="mt-1 block">{upgrade.preflight.rollback.description}</span>
              </span>
              {upgrade.preflight.warnings.map((warning) => (
                <span key={warning.code} className="block text-warning-text">
                  {warning.message}
                  {warning.remediation ? ` ${warning.remediation}` : ''}
                </span>
              ))}
              {upgrade.preflight.blockers.map((blocker) => (
                <span key={blocker.code} className="block text-critical-text">
                  {blocker.message}
                  {blocker.remediation ? ` ${blocker.remediation}` : ''}
                </span>
              ))}
            </span>
          ) : upgrade.error ? (
            <span className="block text-critical-text">{upgrade.error}</span>
          ) : (
            <span className="block">Preparing the update details.</span>
          )
        }
        confirmLabel="Install update"
        cancelLabel={hasUnsavedChanges ? 'Return to work' : 'Keep current version'}
        hideConfirm={
          hasUnsavedChanges ||
          upgrade.preparing ||
          !upgrade.preflight ||
          preflightBlocked ||
          upgrade.starting
        }
        onConfirm={() => void upgrade.start()}
      />

      <Sheet open={upgrade.progressOpen} onOpenChange={upgrade.setProgressOpen}>
        <SheetContent side="right" size="lg" className="gap-0 p-0">
          <SheetHeader>
            <SheetTitle>System update</SheetTitle>
            <SheetDescription>
              {releaseVersion
                ? `Stable v${releaseVersion}`
                : job?.release_id
                  ? `Stable ${job.release_id}`
                  : 'Supervised deployment status'}
              {job ? ` · Job ${job.job_id.slice(0, 10)}` : ''}
            </SheetDescription>
          </SheetHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-6 p-6">
              {upgrade.connection === 'reconnecting' ? (
                <Alert variant="info" icon={<Loader2 className={cn(!reducedMotion && 'animate-spin')} />}>
                  <AlertTitle>Reconnecting to the updated services</AlertTitle>
                  <AlertDescription>
                    A short disconnect is expected while the backend and Console restart. The
                    supervisor continues the durable job and this view will resume automatically.
                  </AlertDescription>
                </Alert>
              ) : null}

              {upgrade.status && !upgrade.status.capability.supported ? (
                <Alert variant="warning" icon={<AlertTriangle />}>
                  <AlertTitle>
                    {upgrade.status.capability.bootstrap_required
                      ? 'One-time setup required'
                      : 'This deployment cannot update itself'}
                  </AlertTitle>
                  <AlertDescription className="space-y-2">
                    {upgrade.status.capability.blockers.map((blocker) => (
                      <p key={blocker.code}>
                        {blocker.message}
                        {blocker.remediation ? ` ${blocker.remediation}` : ''}
                      </p>
                    ))}
                  </AlertDescription>
                </Alert>
              ) : null}

              {upgrade.status?.capability.supported &&
              upgrade.status.release_discovery.issue &&
              (upgrade.status.release_discovery.state === 'unavailable' ||
                upgrade.status.release_discovery.state === 'stale' ||
                upgrade.status.release_discovery.state === 'error') ? (
                <Alert variant="warning" icon={<AlertTriangle />}>
                  <AlertTitle>Stable release check needs attention</AlertTitle>
                  <AlertDescription className="space-y-3">
                    <p>
                      {upgrade.status.release_discovery.issue.message}
                      {upgrade.status.release_discovery.issue.remediation
                        ? ` ${upgrade.status.release_discovery.issue.remediation}`
                        : ''}
                    </p>
                    {/* While the check runs the label says so and the button rests;
                        the glyph never spins outside RefreshButton (SPEC §4.9.2). */}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={upgrade.checking}
                      aria-busy={upgrade.checking}
                      onClick={() => void upgrade.checkNow()}
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden />
                      {upgrade.checking ? 'Checking…' : 'Check again'}
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}

              {upgrade.error && upgrade.connection !== 'reconnecting' ? (
                <Alert variant="destructive" icon={<XCircle />}>
                  <AlertTitle>Update status needs attention</AlertTitle>
                  <AlertDescription>{upgrade.error}</AlertDescription>
                </Alert>
              ) : null}

              {job ? (
                <>
                  <section aria-labelledby="system-update-progress-title" className="space-y-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 id="system-update-progress-title" className="text-sm font-semibold text-foreground">
                          {job.status === 'rolled_back'
                            ? 'Previous release restored'
                            : job.status === 'failed'
                              ? 'Update stopped'
                              : job.status === 'succeeded'
                                ? 'Release installed'
                                : systemUpdateStageLabel(job.stage)}
                        </h3>
                        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                          {upgrade.needsBrowserActivation
                            ? 'The services are healthy. Verifying and activating the new Console in this tab.'
                            : job.message}
                        </p>
                      </div>
                      <Badge
                        variant={
                          job.status === 'succeeded'
                            ? 'success'
                            : job.status === 'failed' || job.status === 'rolled_back'
                              ? 'warning'
                              : 'info'
                        }
                      >
                        {job.status.replace(/_/g, ' ')}
                      </Badge>
                    </div>
                    <Progress
                      value={job.progress}
                      variant={job.status === 'failed' ? 'critical' : job.status === 'rolled_back' ? 'warning' : 'default'}
                      aria-label={`Update progress ${Math.round(job.progress)} percent`}
                    />
                    <p className="text-right font-mono text-xs text-muted-foreground">
                      {Math.round(job.progress)}%
                    </p>
                  </section>

                  <Separator />

                  {job.status === 'rolling_back' || job.status === 'rolled_back' ? (
                    <section className="space-y-3" aria-labelledby="rollback-progress-title">
                      <h3 id="rollback-progress-title" className="text-sm font-semibold text-foreground">
                        Rollback
                      </h3>
                      <div className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/10 p-3">
                        {job.status === 'rolled_back' ? (
                          <Check className="mt-0.5 h-4 w-4 text-warning-text" aria-hidden />
                        ) : (
                          <Loader2 className={cn('mt-0.5 h-4 w-4 text-warning-text', !reducedMotion && 'animate-spin')} aria-hidden />
                        )}
                        <p className="text-sm leading-relaxed text-warning-text">
                          {job.rollback?.description ?? job.message}
                        </p>
                      </div>
                    </section>
                  ) : (
                    <section aria-labelledby="update-stages-title">
                      <h3 id="update-stages-title" className="text-sm font-semibold text-foreground">
                        Update stages
                      </h3>
                      <ol className="mt-3 space-y-1">
                        {orderedStages.map((stage) => {
                          const state = stageState(stage, job);
                          return (
                            <li
                              key={stage}
                              className={cn(
                                'flex items-center gap-3 rounded-md px-2 py-2 text-sm',
                                state === 'running' && 'bg-primary/5 text-foreground',
                                state === 'failed' && 'bg-critical/5 text-critical-text',
                                state === 'pending' && 'text-muted-foreground',
                              )}
                            >
                              <StageIcon state={state} reducedMotion={reducedMotion} />
                              <span>{systemUpdateStageLabel(stage)}</span>
                            </li>
                          );
                        })}
                      </ol>
                    </section>
                  )}

                  {job.error ? (
                    <Alert variant="destructive" icon={<XCircle />}>
                      <AlertTitle>{job.error.message}</AlertTitle>
                      {job.error.remediation ? (
                        <AlertDescription>{job.error.remediation}</AlertDescription>
                      ) : null}
                    </Alert>
                  ) : null}

                  {upgrade.receipt ? (
                    <section className="space-y-3" aria-labelledby="update-receipt-title">
                      <Separator />
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-success" aria-hidden />
                        <h3 id="update-receipt-title" className="text-sm font-semibold text-foreground">
                          Verified receipt
                        </h3>
                      </div>
                      <dl className="grid gap-3 rounded-md border border-border p-3 text-xs sm:grid-cols-2">
                        <div>
                          <dt className="text-muted-foreground">Before</dt>
                          <dd className="mt-1 font-mono text-foreground">v{upgrade.receipt.before.version}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">After</dt>
                          <dd className="mt-1 font-mono text-foreground">v{upgrade.receipt.after.version}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Backup</dt>
                          <dd className="mt-1 text-foreground">
                            {upgrade.receipt.backup_id ? 'Recorded and verified' : 'Not required'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Rollback</dt>
                          <dd className="mt-1 text-foreground">
                            {upgrade.receipt.rollback_performed ? 'Performed' : 'Not needed'}
                          </dd>
                        </div>
                      </dl>
                    </section>
                  ) : null}
                </>
              ) : upgrade.status?.capability.supported &&
                upgrade.status.release_discovery.state === 'current' ? (
                <div className="py-8 text-center">
                  <CheckCircle2 className="mx-auto h-8 w-8 text-success" aria-hidden />
                  <h3 className="mt-3 text-sm font-semibold text-foreground">System is current</h3>
                  <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                    The latest Stable branch observation matches this deployment. Any future
                    candidate is still verified from signed release assets before installation.
                  </p>
                </div>
              ) : null}
            </div>
          </ScrollArea>

          <SheetFooter className="items-center justify-between sm:justify-between">
            <p className="text-xs text-muted-foreground">
              Closing this panel does not stop the durable update job.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              {canCancel ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void upgrade.cancel()}>
                  Cancel before restart
                </Button>
              ) : null}
              {canRequestRollback ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void upgrade.rollback()}>
                  <RotateCcw className="h-4 w-4" aria-hidden />
                  Roll back
                </Button>
              ) : null}
              {!job &&
              (upgrade.connection === 'unavailable' ||
                upgrade.status?.release_discovery.state === 'unavailable' ||
                upgrade.status?.release_discovery.state === 'stale' ||
                upgrade.status?.release_discovery.state === 'error') ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void upgrade.checkNow()}>
                  Retry
                </Button>
              ) : null}
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
