/**
 * Jobs — durable personal work plus permission-scoped operational projections.
 *
 * A READ-ONLY table of the durable async LLM batch-job registry: which low-urgency
 * investigations were routed through a provider's discounted async batch API (~50%
 * off) and how far each has progressed (submit -> poll -> retrieve -> retrieved).
 *
 * Every authenticated actor can see their own application jobs. Related LLM Batch
 * rows/config require models:read; scheduler health is projected only when the server
 * authorizes automation:read. System projections never become personal Inbox items.
 *
 * #9: every value (job id / provider / model / state) is attacker-influenceable and is
 * rendered as PLAIN text / in a fenced CodeBlock — never HTML, never re-fed into a
 * prompt. The unified projection excludes provider handles and raw provider errors;
 * no credential or provider-private diagnostic is shown. #6: this viewer never records
 * a ledger row — the batch service writes exactly one UsageDoc per result at the
 * discounted rate. #3: a batch job is advisory plumbing and never touches `decide()`.
 */
import * as React from 'react';
import { Activity, Download, Info, Layers, Percent, Square } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { LoadingState } from '@/design-system';
import { errorMessage } from '@/lib/errorMessage';
import type {
  BackgroundJob,
  BackgroundJobStatus,
  BatchConfig,
  SystemWorkerHealth,
} from '@/lib/types';
import { useEventStream } from '@/lib/useEventStream';
import { fmtNumber, humanizeAge, humanizeToken, DASH } from '@/lib/format';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Progress } from '@/ui/progress';
import { Switch } from '@/ui/switch';
import { Label } from '@/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Separator } from '@/ui/separator';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { KpiTile } from '@/soc/components/KpiTile';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { InlineCode } from '@/soc/components/CodeBlock';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { Can, useCan } from '@/soc/components/Can';
import { LabeledSlider } from '@/soc/components/LabeledSlider';
import { TagInput } from '@/soc/components/TagInput';
import { EffectiveConfigPreview } from '@/soc/components/rules/EffectiveConfigPreview';
import { useConfigEditor } from '@/soc/components/rules';
import {
  SettingsGrid,
  SettingsCard,
  StickySaveBar,
} from '@/soc/components/SettingsGrid';
import {
  batchApi,
  BATCH_STATE_META,
  BATCH_STATE_ORDER,
  type BatchJobRow,
} from '@/soc/Batch.api';
import {
  downloadJobArtifact,
  isActiveJobStatus,
  JOBS_CHANGED_EVENT,
  jobSummary,
} from '@/soc/jobs/jobs';

/** Backend defaults (mirror `config.BatchConfig`). */
const DEFAULT_BATCH_CONFIG: Required<BatchConfig> = {
  enabled: false,
  severity_floor: 3,
  providers: ['anthropic', 'openai'],
  flex: false,
  prefer_discounted_alerts: true,
  fallback_to_standard: true,
};

/** OCSF severity_id 1–6 tick labels for the severity-floor slider. */
const SEVERITY_TICKS = [
  { value: 1, label: 'Info' },
  { value: 2, label: 'Low' },
  { value: 3, label: 'Med' },
  { value: 4, label: 'High' },
  { value: 5, label: 'Crit' },
  { value: 6, label: 'Fatal' },
];
const SEVERITY_NAME: Record<number, string> = {
  1: 'Informational',
  2: 'Low',
  3: 'Medium',
  4: 'High',
  5: 'Critical',
  6: 'Fatal',
};

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

export default function BatchJobs() {
  return <BatchJobsInner />;
}

export function BatchJobsInner() {
  const canReadModels = useCan('models', 'read');
  const canManage = useCan('models', 'manage');
  const [applicationJobs, setApplicationJobs] = React.useState<BackgroundJob[]>([]);
  const [rows, setRows] = React.useState<BatchJobRow[]>([]);
  const [workers, setWorkers] = React.useState<{
    scheduler_runtime_running: boolean;
    workers: Record<string, SystemWorkerHealth>;
  } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const cfg = useConfigEditor<BatchConfig>(api.batch, DEFAULT_BATCH_CONFIG, {
    enabled: canReadModels,
  });
  const draft = { ...DEFAULT_BATCH_CONFIG, ...cfg.draft };

  const saveConfig = React.useCallback(async () => {
    try {
      await cfg.save();
      toast.success('Batch policy saved.');
    } catch (e) {
      toast.error(errorMessage(e, 'Could not save the batch policy.'));
    }
  }, [cfg]);

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
        cell: (job) => (
          <span className="inline-flex justify-end gap-1.5">
            {job.result?.artifact_id ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7"
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
        ),
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

  return (
    <PageContainer variant="wide" className="flex flex-col gap-6">
      <PageHeader
        icon={Layers}
        eyebrow="Operations"
        title="Jobs"
        description="Durable application work continues across navigation and reload. Personal progress, cancellation, failures, and verified artifacts stay available here and in Inbox."
        actions={
          <RefreshButton
            // Refresh only re-loads the read-only jobs table; it must NOT reload the
            // config (that would silently clobber unsaved policy edits — the editor
            // has its own load-on-mount + LoadError retry).
            onClick={() => void load()}
            refreshing={loading}
          />
        }
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
            <DataTable
              ariaLabel="Application jobs"
              columns={applicationColumns}
              rows={applicationJobs}
              getRowId={(job) => job.job_id}
              loading={loading}
              loadingRows={6}
              empty={
                <EmptyState
                  compact
                  icon={Layers}
                  title="No application jobs yet"
                  description="Exports, bulk case work, imports, resets, and other long-running operations will appear here."
                />
              }
            />
          )}

          {workers ? (
            <section className="space-y-3" aria-labelledby="system-workers-heading">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 id="system-workers-heading" className="text-sm font-semibold text-foreground">
                    System workers
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Read-only scheduler health. Worker rows are operational state and never personal Inbox notifications.
                  </p>
                </div>
                <Badge variant={workers.scheduler_runtime_running ? 'success' : 'secondary'}>
                  {workers.scheduler_runtime_running ? 'Scheduler running' : 'Scheduler unavailable'}
                </Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {Object.entries(workers.workers).map(([name, worker]) => (
                  <div key={name} className="border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
                        <Activity className="size-3.5 text-muted-foreground" aria-hidden />
                        {humanizeToken(name)}
                      </span>
                      <Badge variant={worker.running ? 'info' : worker.last_error ? 'critical' : 'secondary'}>
                        {worker.running ? 'Running' : worker.gated ? 'Gated' : worker.enabled ? 'Idle' : 'Disabled'}
                      </Badge>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {worker.cadence || 'Cadence unavailable'} · {worker.processed.toLocaleString()} processed
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Last success {worker.last_success_at ? humanizeAge(worker.last_success_at) : DASH}
                    </p>
                    {worker.last_error ? (
                      <p className="mt-1 break-words text-xs text-critical-text">{worker.last_error}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {canReadModels ? (
            <section className="space-y-4" aria-labelledby="llm-batch-heading">
              <div>
                <h2 id="llm-batch-heading" className="text-sm font-semibold text-foreground">
                  Related LLM Batch jobs
                </h2>
                <p className="text-xs text-muted-foreground">
                  Read-only provider batch progress. These shared model-service records are not personal application jobs.
                </p>
              </div>
              <div className="grid border-y border-border/70 sm:grid-cols-2 lg:grid-cols-4">
                <KpiTile
                  label="Total jobs"
                  value={fmtNumber(totals.total)}
                  accent="primary"
                  icon={Layers}
                  variant="strip"
                  className="border-b border-border/70 sm:border-r lg:border-b-0"
                />
                <KpiTile
                  label="In flight"
                  value={fmtNumber(totals.active)}
                  accent="info"
                  variant="strip"
                  className="border-b border-border/70 lg:border-b-0 lg:border-r"
                />
                <KpiTile
                  label="Jobs done"
                  value={fmtNumber(totals.done)}
                  accent="success"
                  variant="strip"
                  className="border-b border-border/70 sm:border-b-0 sm:border-r"
                />
                <KpiTile
                  label="Requests retrieved"
                  value={fmtNumber(totals.retrieved)}
                  sub={`of ${fmtNumber(totals.requests)} total`}
                  accent="primary"
                  variant="strip"
                />
              </div>
              <DataTable
                ariaLabel="Related LLM Batch jobs"
                columns={columns}
                rows={rows}
                getRowId={(row) => row.id}
                loading={loading}
                loadingRows={6}
                empty={
                  <EmptyState
                    compact
                    icon={Layers}
                    title="No LLM Batch jobs yet"
                    description="Low-urgency investigations routed through a provider's async Batch API will appear here."
                  />
                }
              />
            </section>
          ) : null}
        </>
      )}

      {!initialLoading && canReadModels ? (
        <>
      <Separator />

      {/* ── Config editor (R6) ───────────────────────────────────────────── */}
      {cfg.error ? (
        <LoadError
          error={cfg.error}
          title="Could not load batch policy"
          fallback="Could not load the batch policy."
          onRetry={() => void cfg.reload()}
        />
      ) : (
        <SettingsGrid>
          <SettingsCard
            anchor="batch-policy"
            icon={Layers}
            title="Discounted inference"
            description="Prefer live Flex for compatible alert investigations, with an optional async Batch queue for low-urgency work."
            wide
          >
            {cfg.loading ? (
              // Don't flash the default-valued form while the persisted policy loads.
              <LoadingState
                label="Loading batch policy"
                description="Preparing the saved discounted-inference configuration."
                layout="panel"
                shape="panel"
              />
            ) : (
            <fieldset disabled={!canManage} className="space-y-6">
              <Alert>
                <Info className="h-4 w-4" aria-hidden />
                <AlertTitle>Two discounted paths, one decision contract</AlertTitle>
                <AlertDescription>
                  Compatible official OpenAI alert investigations use live Flex by
                  default. Async Batch remains opt-in for low-urgency work. Unsupported
                  providers and models stay on standard service, and the usage ledger
                  records the tier actually returned. Neither path changes verdicts or
                  deterministic case decisions. Fresh installs assign official OpenAI
                  GPT-5.6 Luna, so eligible alert/case calls can use Flex immediately.
                </AlertDescription>
              </Alert>

              <div className="grid gap-5 sm:grid-cols-2">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label htmlFor="prefer-discounted-alerts" className="text-sm font-medium">
                      Prefer discounted alert inference
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Route compatible OpenAI GPT-5, o3 and o4-mini alert work through
                      the live Flex tier. Chat, standup, overview and model tests remain
                      standard.
                    </p>
                  </div>
                  <Switch
                    id="prefer-discounted-alerts"
                    checked={draft.prefer_discounted_alerts}
                    onCheckedChange={(value) => cfg.update({ prefer_discounted_alerts: value })}
                  />
                </div>
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label htmlFor="discounted-standard-fallback" className="text-sm font-medium">
                      Standard fallback
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Keep alert processing moving at the standard tier if Flex is
                      unavailable. Fallback calls are recorded at standard pricing.
                    </p>
                  </div>
                  <Switch
                    id="discounted-standard-fallback"
                    checked={draft.fallback_to_standard}
                    onCheckedChange={(value) => cfg.update({ fallback_to_standard: value })}
                  />
                </div>
              </div>

              <Separator />

              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Asynchronous Batch queue
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Optional delayed processing for the low-urgency event-detection funnel.
                </p>
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="batch-enabled" className="text-sm font-medium">
                    Enable batch routing
                  </Label>
                    <p className="text-xs text-muted-foreground">
                      When on, candidates at or below the severity floor go to the async
                      Batch API (~50% off) instead of a live call.
                    </p>
                </div>
                <Switch
                  id="batch-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(v) => cfg.update({ enabled: v })}
                />
              </div>

              <div className="max-w-2xl">
                <LabeledSlider
                  label="Severity floor"
                  description="A candidate at or below this OCSF severity is batch-eligible; above it stays synchronous."
                  value={draft.severity_floor}
                  min={1}
                  max={6}
                  step={1}
                  ticks={SEVERITY_TICKS}
                  editable={false}
                  disabled={!canManage}
                  formatValue={(v) => SEVERITY_NAME[v] ?? String(v)}
                  onChange={(v) => cfg.update({ severity_floor: v })}
                />
              </div>

              <TagInput
                label="Batch providers"
                description="Providers whose batch APIs may be used (e.g. anthropic, openai)."
                value={draft.providers ?? []}
                disabled={!canManage}
                placeholder="add a provider…"
                onChange={(next) => cfg.update({ providers: next })}
              />

              <EffectiveConfigPreview
                summary={
                  `${draft.prefer_discounted_alerts ? 'Compatible alert inference prefers live Flex' : 'Live discounted alert inference is off'}${draft.fallback_to_standard ? ' with standard fallback' : ' without standard fallback'}. ${draft.enabled ? `Async Batch also routes candidates at or below ${SEVERITY_NAME[draft.severity_floor] ?? draft.severity_floor} severity via ${(draft.providers ?? []).length ? (draft.providers ?? []).join(', ') : 'no providers'}.` : 'The separate async Batch queue is off.'}`
                }
                lines={[
                  { label: 'Live alert tier', value: draft.prefer_discounted_alerts ? 'Flex preferred' : 'standard only' },
                  { label: 'Standard fallback', value: draft.fallback_to_standard ? 'on' : 'off' },
                  { label: 'Severity floor', value: SEVERITY_NAME[draft.severity_floor] ?? String(draft.severity_floor) },
                  { label: 'Providers', value: (draft.providers ?? []).join(', ') || DASH },
                ]}
                belowFloorNote
                noteText="One usage-ledger row is still written per resolved call (#6). Batch routing changes only where a call runs, never the decision."
              />

              {!canManage ? (
                <p className="text-xs text-muted-foreground">
                  You have read-only access. Ask a SOC administrator to change the batch
                  policy.
                </p>
              ) : null}
            </fieldset>
            )}
          </SettingsCard>
        </SettingsGrid>
      )}

      <Can resource="models" action="manage">
        <StickySaveBar
          visible={cfg.dirty}
          busy={cfg.saving}
          message="Unsaved batch-policy changes."
          onSave={() => void saveConfig()}
          onDiscard={cfg.discard}
        />
      </Can>
        </>
      ) : null}
    </PageContainer>
  );
}
