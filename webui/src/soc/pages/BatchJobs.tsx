/**
 * Jobs: durable personal work plus permission-scoped operational projections.
 *
 * The person's own application jobs (exports, bulk case work, imports, resets), the
 * read-only scheduler health, and the read-only table of the durable async LLM batch-job
 * registry: which low-urgency investigations were routed through a provider's discounted
 * async batch API (about 50% off) and how far each has progressed (submit, poll,
 * retrieve, retrieved). Round 14 (D30): the discounted-inference settings moved to
 * Settings, General, Discounted inference; this page keeps one line that links there for
 * one release.
 *
 * Every authenticated actor can see their own application jobs. Related LLM Batch rows
 * require models:read; scheduler health is projected only when the server authorizes
 * automation:read. System projections never become personal Inbox items.
 *
 * #9: every value (job id / provider / model / state) is attacker-influenceable and is
 * rendered as PLAIN text, never HTML, never re-fed into a prompt. The unified projection
 * excludes provider handles and raw provider errors; no credential or provider-private
 * diagnostic is shown. #6: this viewer never records a ledger row. #3: a batch job is
 * advisory plumbing and never touches `decide()`.
 */
import * as React from 'react';
import { ArrowRight, Download, Layers, Percent, Square } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ListRow, ListRows, LoadingState, Panel, StatusDot } from '@/design-system';
import { errorMessage } from '@/lib/errorMessage';
import type { BackgroundJob, BackgroundJobStatus, SystemWorkerHealth } from '@/lib/types';
import { useEventStream } from '@/lib/useEventStream';
import { fmtNumber, humanizeAge, humanizeToken, DASH } from '@/lib/format';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Progress } from '@/ui/progress';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { KpiStripContext, KpiTile, KpiTileGrid, type KpiStripContextValue } from '@/soc/components/KpiTile';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { InlineCode } from '@/soc/components/CodeBlock';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { useCan } from '@/soc/components/Can';
import { pageHash, settingsSectionHash } from '@/soc/router';
import {
  batchApi,
  BATCH_STATE_META,
  BATCH_STATE_ORDER,
  type BatchJobRow,
} from '@/soc/Batch.api';
import {
  destinationActionLabel,
  downloadJobArtifact,
  isActiveJobStatus,
  JOBS_CHANGED_EVENT,
  jobSummary,
} from '@/soc/jobs/jobs';
import { auditExportView } from '@/soc/jobs/audit-export-view';

const JOB_POLL_MS = 15_000;
const JOB_POLL_MS_LIVE = 60_000;

function JobStatusBadge({ status }: { status: BackgroundJobStatus }) {
  const variant =
    status === 'succeeded'
      ? 'success'
      : status === 'partial'
        ? 'warning'
        : status === 'failed'
          ? 'critical'
          : status === 'cancelled'
            ? 'secondary'
            : 'info';
  return <Badge variant={variant}>{humanizeToken(status)}</Badge>;
}

/** A controlled, colour-coded state badge (plain-text label, #9). */
function StateBadge({ state }: { state: string }) {
  const meta = BATCH_STATE_META[state] ?? { label: humanizeToken(state), variant: 'secondary' as const };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

/** A compact discount pill (e.g. "50% off"). */
function DiscountPill({ discount }: { discount: number }) {
  const pct = Number.isFinite(discount) ? Math.round((1 - discount) * 100) : 0;
  if (pct <= 0) {
    return <span className="text-xs text-muted-foreground">{DASH}</span>;
  }
  return (
    <Badge variant="info" className="gap-1">
      <Percent className="h-3 w-3" aria-hidden />
      {pct}% off
    </Badge>
  );
}

/** The Batch panel's tiles: strip tiles at the compact density, on the panel's grid. */
const COMPACT_TILES: KpiStripContextValue = { density: 'compact' };

/** A worker's schedule in words (the scheduler and config tokens, SPEC §4.9.5). */
const CADENCE_WORDS: Readonly<Record<string, string>> = {
  on_ingest: 'On every ingest',
  continuous: 'Continuous',
  hourly: 'Hourly',
  nightly: 'Nightly',
  daily: 'Daily',
  weekly: 'Weekly',
  manual: 'Manual only',
};

/** "On every ingest" for `on_ingest`; an unknown token in words; a missing one says so. */
export function cadenceWords(cadence: string | null | undefined): string {
  const raw = String(cadence ?? '').trim();
  if (!raw) return 'Cadence unavailable';
  return CADENCE_WORDS[raw.toLowerCase()] ?? humanizeToken(raw);
}

export default function BatchJobs() {
  return <BatchJobsInner />;
}

export function BatchJobsInner() {
  const canReadModels = useCan('models', 'read');
  const [applicationJobs, setApplicationJobs] = React.useState<BackgroundJob[]>([]);
  const [rows, setRows] = React.useState<BatchJobRow[]>([]);
  const [workers, setWorkers] = React.useState<{
    scheduler_runtime_running: boolean;
    workers: Record<string, SystemWorkerHealth>;
  } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.jobs.list({ limit: 100, offset: 0 });
      setApplicationJobs(Array.isArray(res.jobs) ? res.jobs : []);
      setWorkers(res.system_workers ?? null);
      if (!canReadModels) {
        setRows([]);
      } else if (res.related === undefined) {
        // Compatibility with a backend that has the durable personal registry but
        // predates the additive related projection.
        const legacy = await batchApi.jobs();
        setRows(legacy?.jobs ?? []);
      } else {
        setRows(res.related?.llm_batches ?? []);
      }
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [canReadModels]);

  const onJobsEvent = React.useCallback(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void load();
  }, [load]);
  const { live } = useEventStream(['jobs'], { enabled: true, onEvent: onJobsEvent });

  React.useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    };
    tick();
    const interval = window.setInterval(tick, live ? JOB_POLL_MS_LIVE : JOB_POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    const onJobsChanged = () => tick();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(JOBS_CHANGED_EVENT, onJobsChanged);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(JOBS_CHANGED_EVENT, onJobsChanged);
    };
  }, [live, load]);

  const initialLoading = loading && applicationJobs.length === 0 && rows.length === 0;

  // ---- Aggregate stats over the loaded jobs (all client-side, read-only). ---- //
  const totals = React.useMemo(() => {
    const total = rows.length;
    const active = rows.filter((r) => BATCH_STATE_ORDER.includes(r.state) && r.state !== 'retrieved').length;
    const done = rows.filter((r) => r.state === 'retrieved').length;
    const requests = rows.reduce((a, r) => a + (r.requests || 0), 0);
    const retrieved = rows.reduce((a, r) => a + (r.retrieved || 0), 0);
    return { total, active, done, requests, retrieved };
  }, [rows]);

  const cancelJob = React.useCallback(
    async (job: BackgroundJob) => {
      try {
        await api.jobs.cancel(job.job_id);
        toast.info('Cancellation requested. The job will stop at a safe checkpoint.');
        await load();
      } catch (e) {
        toast.error(errorMessage(e, 'Could not request cancellation.'));
      }
    },
    [load],
  );

  const downloadArtifact = React.useCallback(async (job: BackgroundJob) => {
    if (!job.result?.artifact_id) return;
    try {
      const filename = await downloadJobArtifact(job);
      toast.success(`Downloaded ${filename}.`);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not download the job artifact.'));
    }
  }, []);

  const applicationColumns = React.useMemo<DataTableColumn<BackgroundJob>[]>(
    () => [
      {
        id: 'job',
        header: 'Job',
        lockVisible: true,
        cell: (job) => (
          <span className="space-y-0.5">
            <span className="block text-sm font-medium text-foreground">
              {humanizeToken(job.kind)}
            </span>
            <InlineCode>{job.job_id}</InlineCode>
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: (job) => <JobStatusBadge status={job.status} />,
      },
      {
        id: 'progress',
        header: 'Progress',
        cell: (job) => {
          const done = Math.max(0, Number(job.progress.done || 0));
          const total = Math.max(0, Number(job.progress.total || 0));
          const value = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
          return (
            <span className="block min-w-44 space-y-1">
              <span className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span>{job.progress.unit}</span>
                <span className="tabular-nums">{done.toLocaleString()} / {total.toLocaleString()}</span>
              </span>
              <Progress value={value} className="h-1.5" />
            </span>
          );
        },
      },
      {
        id: 'result',
        header: 'Result',
        cell: (job) => (
          <span className="block max-w-80 text-xs text-muted-foreground">
            {jobSummary(job)}
            {job.failures_truncated > 0
              ? ` ${job.failures_truncated.toLocaleString()} additional failures omitted.`
              : ''}
          </span>
        ),
      },
      {
        id: 'created',
        header: 'Created',
        align: 'right',
        cell: (job) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {humanizeAge(job.created_at)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        align: 'right',
        cell: (job) => {
          // SPEC §4.5.8: a finished audit export links into the audit log, in the view it
          // holds. The row's own name tells this job's controls from the next row's.
          const view = auditExportView(job);
          const name = `${humanizeToken(job.kind)} ${job.job_id}`;
          return (
            <span className="inline-flex justify-end gap-1.5">
              {view ? (
                <Button asChild variant="outline" size="sm" className="h-7">
                  <a href={pageHash(view.page, view.opts)} aria-label={`${destinationActionLabel(view)} for ${name}`}>
                    {destinationActionLabel(view)}
                    <ArrowRight className="size-3.5" aria-hidden />
                  </a>
                </Button>
              ) : null}
              {job.result?.artifact_id ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  aria-label={`Download ${name}`}
                  onClick={() => void downloadArtifact(job)}
                >
                  <Download className="size-3.5" aria-hidden />
                  Download
                </Button>
              ) : null}
              {isActiveJobStatus(job.status) ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  disabled={job.cancel_requested}
                  onClick={() => void cancelJob(job)}
                >
                  <Square className="size-3.5" aria-hidden />
                  {job.cancel_requested ? 'Stopping…' : 'Cancel'}
                </Button>
              ) : null}
            </span>
          );
        },
      },
    ],
    [cancelJob, downloadArtifact],
  );

  const columns = React.useMemo<DataTableColumn<BatchJobRow>[]>(
    () => [
      {
        id: 'id',
        header: 'Job',
        lockVisible: true,
        cell: (r) => <InlineCode>{r.id}</InlineCode>,
      },
      {
        id: 'provider',
        header: 'Provider',
        cell: (r) => (
          <span className="text-sm text-foreground">{humanizeToken(r.provider) || DASH}</span>
        ),
      },
      {
        id: 'model',
        header: 'Model',
        cell: (r) =>
          r.model ? <InlineCode>{r.model}</InlineCode> : <span className="text-muted-foreground">{DASH}</span>,
      },
      {
        id: 'state',
        header: 'State',
        cell: (r) => <StateBadge state={r.state} />,
      },
      {
        id: 'requests',
        header: 'Requests',
        align: 'right',
        cell: (r) => (
          <span className="tabular-nums text-sm">
            <span className="font-semibold text-foreground">{fmtNumber(r.retrieved)}</span>
            <span className="text-muted-foreground"> / {fmtNumber(r.requests)}</span>
          </span>
        ),
      },
      {
        id: 'discount',
        header: 'Discount',
        align: 'right',
        cell: (r) => <DiscountPill discount={r.discount} />,
      },
      {
        id: 'submitted_at',
        header: 'Submitted',
        align: 'right',
        cell: (r) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {humanizeAge(r.submitted_at)}
          </span>
        ),
      },
      {
        id: 'polled_at',
        header: 'Last poll',
        align: 'right',
        cell: (r) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {humanizeAge(r.polled_at)}
          </span>
        ),
      },
    ],
    [],
  );

  const workerEntries = workers ? Object.entries(workers.workers) : [];

  return (
    <PageContainer variant="wide">
      <PageHeader
        title="Jobs"
        help="Durable application work continues across navigation and reload. Progress, cancellation, failures and verified artifacts stay here and in Inbox."
        controls={<RefreshButton display="icon" label="Refresh jobs" onClick={() => void load()} refreshing={loading} />}
      />

      {initialLoading ? (
        <LoadingState
          label="Loading jobs"
          description="Preparing durable work, related model batches, and worker health."
          layout="panel"
          shape="rows"
          shapeRows={6}
        />
      ) : (
        <>
          {error ? (
            <LoadError
              error={error}
              title="Could not load jobs"
              fallback="Could not load jobs."
              onRetry={() => void load()}
            />
          ) : null}

          {error && applicationJobs.length === 0 ? null : (
            <Panel title="Your jobs" padding="none" data-testid="jobs-application">
              <DataTable
                ariaLabel="Application jobs"
                surface="panel"
                columns={applicationColumns}
                rows={applicationJobs}
                getRowId={(job) => job.job_id}
                loading={loading}
                loadingRows={6}
                emptyState={
                  <div className="px-4 pb-4 xl:px-5 3xl:px-6">
                    <EmptyState
                      compact
                      icon={Layers}
                      title="No application jobs yet"
                      description="Exports, bulk case work, imports, resets, and other long-running operations will appear here."
                    />
                  </div>
                }
              />
            </Panel>
          )}

          {workers ? (
            <Panel
              title="System workers"
              caption="Read-only scheduler health, never personal Inbox notifications."
              aside={
                <StatusDot tone={workers.scheduler_runtime_running ? 'neutral' : 'warning'}>
                  {workers.scheduler_runtime_running ? 'Scheduler running' : 'Scheduler unavailable'}
                </StatusDot>
              }
              padding="none"
              data-testid="jobs-workers"
            >
              {workerEntries.length ? (
                <ListRows aria-label="System workers" className="border-t border-border/70">
                  {workerEntries.map(([name, worker]) => (
                    <ListRow
                      key={name}
                      className="px-4 xl:px-5 3xl:px-6"
                      title={humanizeToken(name)}
                      description={
                        <>
                          {cadenceWords(worker.cadence)} · {worker.processed.toLocaleString()} processed · last
                          success {worker.last_success_at ? humanizeAge(worker.last_success_at) : 'never'}
                          {worker.last_error ? <span className="text-critical-text"> · {worker.last_error}</span> : null}
                        </>
                      }
                      status={
                        <StatusDot
                          tone={worker.last_error && !worker.running ? 'critical' : worker.running ? 'info' : 'neutral'}
                        >
                          {worker.running ? 'Running' : worker.gated ? 'Gated' : worker.enabled ? 'Idle' : 'Disabled'}
                        </StatusDot>
                      }
                    />
                  ))}
                </ListRows>
              ) : (
                <p className="px-4 pb-4 text-sm text-muted-foreground xl:px-5 3xl:px-6">No scheduled workers.</p>
              )}
            </Panel>
          ) : null}

          {canReadModels ? (
            <>
              <Panel
                title="Related LLM Batch jobs"
                caption="Read-only provider batch progress. These shared model-service records are not personal application jobs."
                padding="none"
                data-testid="jobs-llm-batch"
              >
                {/* The Batch figures belong to this panel, above its table: on their own
                    they read as a summary of the whole page, beside "Your jobs". A strip
                    draws its own panel, so the tiles sit on this one's grid. */}
                <KpiStripContext.Provider value={COMPACT_TILES}>
                  <div role="group" aria-label="Related LLM Batch summary" data-testid="jobs-llm-batch-summary">
                    <KpiTileGrid count={4} surface="panel">
                      <KpiTile label="Total jobs" value={fmtNumber(totals.total)} />
                      <KpiTile label="In flight" value={fmtNumber(totals.active)} />
                      <KpiTile label="Jobs done" value={fmtNumber(totals.done)} />
                      <KpiTile
                        label="Requests retrieved"
                        value={fmtNumber(totals.retrieved)}
                        context={`of ${fmtNumber(totals.requests)} total`}
                      />
                    </KpiTileGrid>
                  </div>
                </KpiStripContext.Provider>
                <DataTable
                  ariaLabel="Related LLM Batch jobs"
                  surface="panel"
                  columns={columns}
                  rows={rows}
                  getRowId={(row) => row.id}
                  loading={loading}
                  loadingRows={6}
                  emptyState={
                    <div className="px-4 pb-4 xl:px-5 3xl:px-6">
                      <EmptyState
                        compact
                        icon={Layers}
                        title="No LLM Batch jobs yet"
                        description="Low-urgency investigations routed through a provider's async Batch API will appear here."
                      />
                    </div>
                  }
                />
              </Panel>
              {/* D30: the discounted-inference settings live in Settings now (one release). */}
              <p className="text-sm text-muted-foreground" data-testid="jobs-discounted-inference-moved">
                Discounted inference settings moved to{' '}
                <a
                  href={settingsSectionHash('discounted-inference')}
                  className="rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Settings, General, Discounted inference
                </a>
                .
              </p>
            </>
          ) : null}
        </>
      )}
    </PageContainer>
  );
}
