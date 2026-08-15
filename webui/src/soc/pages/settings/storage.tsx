/**
 * Capability-aware storage lifecycle settings.
 *
 * This surface is intentionally honest about scope: Agentic SOC can apply native
 * Hot -> Warm lifecycle only to its own append-only ledgers when the state backend
 * supports it. Mutable cases and live metadata remain Hot, connected source logs stay
 * external/read-only, and Glacier remains desired policy until a checksummed
 * export/restore pipeline is configured. Automatic deletion is never offered.
 */
import * as React from 'react';
import {
  Archive,
  Database,
  Flame,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Snowflake,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type {
  Preferences,
  StorageLifecycleConfig,
  StorageLifecycleStatus,
  StorageLifecycleTarget,
} from '@/lib/types';
import { cn } from '@/lib/cn';
import { LoadingState } from '@/design-system';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import {
  SettingsCard,
  SettingsGrid,
  type SettingsTOCItem,
} from '@/soc/components/SettingsGrid';
import { useNavigateOptional } from '@/soc/router';
import {
  announceJobAccepted,
  retainJobSubmissionIntent,
  type JobSubmissionIntent,
} from '@/soc/jobs/jobs';

import { NumPref, SectionShell, SwitchPref, errMsg } from './primitives';

const DEFAULT_STORAGE_LIFECYCLE: StorageLifecycleConfig = {
  enabled: true,
  hot_days: 180,
  warm_days: 90,
  archive_target: 'aws_glacier',
  glacier_storage_class: 'GLACIER',
  delete_after_archive: false,
};

const STORAGE_TOC: SettingsTOCItem[] = [
  { anchor: 'storage-effective', label: 'Effective lifecycle', icon: Database },
  { anchor: 'storage-policy', label: 'Desired policy', icon: Flame },
  { anchor: 'storage-preview', label: 'Preview & safe scope', icon: ShieldCheck },
];

function normalizedConfig(value?: Partial<StorageLifecycleConfig> | null): StorageLifecycleConfig {
  return {
    ...DEFAULT_STORAGE_LIFECYCLE,
    ...(value ?? {}),
    archive_target: 'aws_glacier',
    delete_after_archive: false,
  };
}

function samePolicy(a: StorageLifecycleConfig, b: StorageLifecycleConfig): boolean {
  return (
    a.enabled === b.enabled &&
    a.hot_days === b.hot_days &&
    a.warm_days === b.warm_days &&
    a.archive_target === b.archive_target &&
    a.glacier_storage_class === b.glacier_storage_class &&
    a.delete_after_archive === b.delete_after_archive
  );
}

function readableBackend(value: string): string {
  if (value === 'elasticsearch') return 'Elasticsearch';
  if (value === 'postgres') return 'PostgreSQL';
  if (value === 'sqlite') return 'SQLite';
  if (value === 'memory') return 'In-memory fallback';
  return value || 'Unknown';
}

function readableState(value: string): string {
  return value.replace(/_/g, ' ');
}

function statusVariant(value: string): 'success' | 'warning' | 'info' | 'outline' {
  if (value === 'active' || value === 'managed') return 'success';
  if (
    value === 'blocked' ||
    value === 'not_configured' ||
    value === 'drifted' ||
    value === 'pending_disable' ||
    value === 'unsupported'
  ) return 'warning';
  if (value === 'external' || value === 'advisory' || value === 'export_only') return 'info';
  return 'outline';
}

function TargetRow({ target }: { target: StorageLifecycleTarget }) {
  return (
    <li className="grid gap-2 border-b border-border/70 py-3 last:border-b-0 sm:grid-cols-[minmax(0,12rem)_auto_minmax(0,1fr)] sm:items-start">
      <span className="text-sm font-medium text-foreground">{target.label}</span>
      <Badge variant={statusVariant(target.enforcement)} className="w-fit capitalize">
        {readableState(target.enforcement)}
      </Badge>
      <span className="text-xs leading-relaxed text-muted-foreground">{target.reason}</span>
    </li>
  );
}

export interface StorageLifecycleSectionProps {
  prefs: Preferences;
  /** The server-saved snapshot owned by Settings' global Save/Discard lifecycle. */
  persistedPrefs: Preferences;
  update: (patch: Partial<Preferences>) => void;
  readOnly?: boolean;
}

export function StorageLifecycleSection({
  prefs,
  persistedPrefs,
  update,
  readOnly = false,
}: StorageLifecycleSectionProps) {
  const navigate = useNavigateOptional();
  const draft = normalizedConfig(prefs.storage_lifecycle);
  const persisted = normalizedConfig(persistedPrefs.storage_lifecycle);
  const draftDiffers = !samePolicy(draft, persisted);
  const persistedKey = JSON.stringify(persisted);
  const [status, setStatus] = React.useState<StorageLifecycleStatus | null>(null);
  const [preview, setPreview] = React.useState<StorageLifecycleStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [applying, setApplying] = React.useState(false);
  const jobSubmissionIntentRef = React.useRef<JobSubmissionIntent | null>(null);

  const loadStatus = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.get<StorageLifecycleStatus>('storage/lifecycle');
      setStatus(next);
      setPreview(next);
    } catch (cause) {
      setError(errMsg(cause, 'Could not load storage lifecycle status.'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadStatus();
    // Re-check the authoritative policy after the page-wide Save replaces its saved
    // snapshot. Draft edits alone do not change `persistedKey`, so this never turns
    // typing into a request loop.
  }, [loadStatus, persistedKey]);

  const changePolicy = (patch: Partial<StorageLifecycleConfig>) => {
    update({
      storage_lifecycle: {
        ...draft,
        ...patch,
        archive_target: 'aws_glacier',
        delete_after_archive: false,
      },
    });
  };

  const previewDraft = async () => {
    setPreviewing(true);
    try {
      const next = await api.post<StorageLifecycleStatus>('storage/lifecycle/preview', draft);
      setPreview(next);
      toast.success('Storage lifecycle preview updated.');
    } catch (cause) {
      toast.error(errMsg(cause, 'Could not preview the storage lifecycle.'));
    } finally {
      setPreviewing(false);
    }
  };

  const backendCanApply = Boolean(
    status?.state_backend === 'elasticsearch' &&
      (draft.enabled ? status.capabilities?.supported : status.capabilities?.can_manage),
  );
  const statusMatchesDraft = Boolean(
    status?.policy && samePolicy(draft, normalizedConfig(status.policy)),
  );
  const applyDisabled =
    readOnly ||
    loading ||
    Boolean(error) ||
    draftDiffers ||
    !statusMatchesDraft ||
    !backendCanApply ||
    applying;

  const applyPersistedPolicy = async () => {
    if (applyDisabled) return;
    setApplying(true);
    try {
      const params = { acknowledge: true, policy: persisted };
      const intent = retainJobSubmissionIntent(
        jobSubmissionIntentRef.current,
        'storage_lifecycle_apply',
        params,
      );
      jobSubmissionIntentRef.current = intent;
      const job = await api.jobs.submit({
        kind: 'storage_lifecycle_apply',
        idempotency_key: intent.idempotencyKey,
        params,
      });
      jobSubmissionIntentRef.current = null;
      announceJobAccepted(job);
      toast.success('Storage lifecycle apply job accepted.', {
        description: 'The provider mutation runs server-side; its durable outcome remains in Inbox.',
        action: { label: 'Open Inbox', onClick: () => navigate('inbox') },
      });
    } catch (cause) {
      toast.error(errMsg(cause, 'Could not start the storage lifecycle job.'));
    } finally {
      setApplying(false);
    }
  };

  const projected = preview ?? status;
  const archiveFrom = draft.hot_days + draft.warm_days;

  return (
    <SectionShell
      title="Storage & retention"
      sub="Set retention intent for Agentic SOC-owned state. The Console never changes retention on connected source logs."
      toc={STORAGE_TOC}
    >
      <SettingsGrid>
        <SettingsCard
          anchor="storage-effective"
          title="Effective lifecycle"
          icon={Database}
          description="Provider status for the saved policy. Active means the native policy matches; the timeline remains the saved desired boundary."
          wide="full"
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadStatus()}
              disabled={loading}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
              Refresh status
            </Button>
          }
        >
          {loading ? (
            <LoadingState
              label="Loading storage lifecycle"
              description="Checking the state backend and its native tiering capability."
              layout="panel"
              shape="rows"
            />
          ) : error ? (
            <Alert variant="destructive">
              <AlertTitle>Storage status unavailable</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : status ? (
            <div className="space-y-5" data-testid="storage-lifecycle-status">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{readableBackend(status.state_backend)} state</Badge>
                <Badge variant={statusVariant(status.effective_state)} className="capitalize">
                  {readableState(status.effective_state)}
                </Badge>
                {status.policy_name ? (
                  <span className="font-mono text-xs text-muted-foreground">{status.policy_name}</span>
                ) : null}
              </div>

              <div className="grid border-y border-border sm:grid-cols-3" aria-label="Storage lifecycle timeline">
                <div className="space-y-1 px-1 py-4 sm:pr-5">
                  <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-high-text">
                    <Flame className="h-4 w-4" aria-hidden /> Hot
                  </span>
                  <p className="text-lg font-semibold tabular-nums text-foreground">
                    First {status.policy.hot_days} days
                  </p>
                  <p className="text-xs text-muted-foreground">Immediate operational access.</p>
                </div>
                <div className="space-y-1 border-t border-border px-1 py-4 sm:border-l sm:border-t-0 sm:px-5">
                  <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-info-text">
                    <Snowflake className="h-4 w-4" aria-hidden /> Warm
                  </span>
                  <p className="text-lg font-semibold tabular-nums text-foreground">
                    Next {status.policy.warm_days} days · until day {status.policy.archive_from_days}
                  </p>
                  <p className="text-xs text-muted-foreground">Native only where the backend supports it.</p>
                </div>
                <div className="space-y-1 border-t border-border px-1 py-4 sm:border-l sm:border-t-0 sm:pl-5">
                  <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <Archive className="h-4 w-4" aria-hidden /> Archive
                  </span>
                  <p className="text-lg font-semibold tabular-nums text-foreground">
                    From day {status.policy.archive_from_days}
                  </p>
                  <p className="text-xs text-muted-foreground">Desired · not configured.</p>
                </div>
              </div>

              {!status.capabilities.supported && status.capabilities.reason ? (
                <Alert variant="warning">
                  <AlertTitle>Native Hot → Warm movement is not available</AlertTitle>
                  <AlertDescription>{status.capabilities.reason}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}
        </SettingsCard>

        <SettingsCard
          anchor="storage-policy"
          title="Desired policy"
          icon={Flame}
          description="These values use the page-wide Save / Discard controls. Saving records intent; Apply is a separate, explicit infrastructure action."
          wide="full"
        >
          <div className="space-y-5">
            <SwitchPref
              label="Lifecycle enabled"
              help="Enable native Hot → Warm movement for eligible Agentic SOC-owned append-only data."
              checked={draft.enabled}
              disabled={readOnly}
              onChange={(enabled) => changePolicy({ enabled })}
            />
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <NumPref
                label="Hot retention (days)"
                help="Append-only ledgers stay Hot for this long. Default: 180 days."
                value={draft.hot_days}
                min={1}
                max={3650}
                disabled={readOnly || !draft.enabled}
                onChange={(hot_days) => changePolicy({ hot_days })}
              />
              <NumPref
                label="Warm retention (days)"
                help="Additional time before the desired archive boundary. Default: 90 days."
                value={draft.warm_days}
                min={1}
                max={3650}
                disabled={readOnly || !draft.enabled}
                onChange={(warm_days) => changePolicy({ warm_days })}
              />
              <div className="space-y-2">
                <Label htmlFor="storage-glacier-class">Desired Glacier class</Label>
                <Select
                  value={draft.glacier_storage_class}
                  disabled={readOnly || !draft.enabled}
                  onValueChange={(value) =>
                    changePolicy({
                      glacier_storage_class: value as StorageLifecycleConfig['glacier_storage_class'],
                    })
                  }
                >
                  <SelectTrigger id="storage-glacier-class">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GLACIER">Glacier Flexible Retrieval</SelectItem>
                    <SelectItem value="DEEP_ARCHIVE">Glacier Deep Archive</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Intent only until an independent checksummed export and restore pipeline is configured.
                </p>
              </div>
            </div>

            <div className="grid border-y border-border py-4 sm:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Hot</p>
                <p className="mt-1 font-mono text-sm tabular-nums text-foreground">First {draft.hot_days} days</p>
              </div>
              <div className="mt-3 border-t border-border pt-3 sm:mt-0 sm:border-l sm:border-t-0 sm:px-5 sm:pt-0">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Warm</p>
                <p className="mt-1 font-mono text-sm tabular-nums text-foreground">
                  Next {draft.warm_days} days · until day {archiveFrom}
                </p>
              </div>
              <div className="mt-3 border-t border-border pt-3 sm:mt-0 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Desired archive</p>
                <p className="mt-1 font-mono text-sm tabular-nums text-foreground">From day {archiveFrom}</p>
              </div>
            </div>

            <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>Automatic deletion is off and cannot be enabled in this release.</span>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="storage-preview"
          title="Preview & safe scope"
          icon={ShieldCheck}
          description="Preview the draft without changing infrastructure, then apply only the persisted policy to supported owned-state targets."
          wide="full"
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void previewDraft()}
              disabled={previewing}
            >
              <RefreshCw className={cn('h-4 w-4', previewing && 'animate-spin')} aria-hidden />
              {previewing ? 'Previewing…' : 'Preview draft'}
            </Button>
          }
        >
          <div className="space-y-5">
            {projected?.targets?.length ? (
              <ul aria-label="Storage lifecycle scope">
                {projected.targets.map((target) => (
                  <TargetRow key={target.id} target={target} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Load the effective status or preview the draft to inspect exact target scope.
              </p>
            )}

            <Alert variant="info">
              <ShieldCheck className="h-4 w-4" aria-hidden />
              <AlertTitle>Safe lifecycle boundary</AlertTitle>
              <AlertDescription>
                Audit and usage ledgers are the only enforceable targets where native lifecycle is supported.
                Mutable cases remain Hot. Connected source logs stay external and read-only.
              </AlertDescription>
            </Alert>

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">Apply supported lifecycle</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground" aria-live="polite">
                  {readOnly
                    ? 'Settings are read-only in this deployment; native lifecycle changes cannot be applied.'
                    : loading
                      ? 'Checking the backend capability before Apply becomes available.'
                      : error
                        ? 'Reload storage status before applying the saved policy.'
                        : draftDiffers
                          ? 'Save the desired policy first; Apply always uses the persisted settings snapshot.'
                          : !statusMatchesDraft
                            ? 'Refreshing the saved policy status; Apply stays locked until the backend confirms the same values.'
                            : !backendCanApply
                              ? `${readableBackend(status?.state_backend ?? '')} reports this policy as advisory or unavailable; no native movement will be claimed.`
                              : 'Ready to apply the saved policy to eligible append-only Agentic SOC ledgers.'}
                </p>
              </div>
              <Button
                type="button"
                onClick={() => void applyPersistedPolicy()}
                disabled={applyDisabled}
                title={draftDiffers ? 'Save the desired policy before applying it' : undefined}
              >
                {applying ? (
                  <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Database className="h-4 w-4" aria-hidden />
                )}
                {applying ? 'Applying…' : 'Apply saved policy'}
              </Button>
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Glacier is desired but not configured. Never transition an Elasticsearch snapshot-repository
              prefix to Glacier; archive requires an independent export, checksum, manifest, and restore path.
            </p>
          </div>
        </SettingsCard>
      </SettingsGrid>
    </SectionShell>
  );
}

export default StorageLifecycleSection;
