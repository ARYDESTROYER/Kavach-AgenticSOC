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
import { Database } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type {
  Preferences,
  StorageLifecycleConfig,
  StorageLifecycleStatus,
  StorageLifecycleTarget,
} from '@/lib/types';
import { Callout, LoadingGlyph, LoadingState, StatusDot, type StatusTone } from '@/design-system';
import { Button } from '@/ui/button';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { useNavigateOptional } from '@/soc/router';
import {
  announceJobAccepted,
  retainJobSubmissionIntent,
  type JobSubmissionIntent,
} from '@/soc/jobs/jobs';

import { NumPref, SettingRow, SettingsGroup, SettingsSection, errMsg } from './primitives';

const DEFAULT_STORAGE_LIFECYCLE: StorageLifecycleConfig = {
  enabled: true,
  hot_days: 180,
  warm_days: 90,
  archive_target: 'aws_glacier',
  glacier_storage_class: 'GLACIER',
  delete_after_archive: false,
};

const GLACIER_CLASSES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'GLACIER', label: 'Glacier Flexible Retrieval' },
  { value: 'DEEP_ARCHIVE', label: 'Glacier Deep Archive' },
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

/**
 * The dot tone of a lifecycle state: the healthy states stay neutral (status shows only
 * for exceptions), a state that needs attention is amber.
 */
function statusTone(value: string): StatusTone {
  if (
    value === 'blocked' ||
    value === 'not_configured' ||
    value === 'drifted' ||
    value === 'pending_disable' ||
    value === 'unsupported'
  ) return 'warning';
  return 'neutral';
}

function TargetRow({ target }: { target: StorageLifecycleTarget }) {
  return (
    <li className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,9rem)_minmax(0,1fr)] sm:items-start sm:gap-4 xl:px-5">
      <span className="text-sm font-medium text-foreground">{target.label}</span>
      <StatusDot tone={statusTone(target.enforcement)}>{readableState(target.enforcement)}</StatusDot>
      <span className="text-sm text-muted-foreground">{target.reason}</span>
    </li>
  );
}

/** The three tiers as one row of terms: Hot, Warm, Archive. */
function TierLine({
  hotDays,
  warmDays,
  archiveFrom,
  archiveNote,
  label,
}: {
  hotDays: number;
  warmDays: number;
  archiveFrom: number;
  archiveNote?: string;
  label: string;
}) {
  return (
    <dl className="grid gap-4 sm:grid-cols-3" aria-label={label}>
      <div>
        <dt className="text-sm text-muted-foreground">Hot</dt>
        <dd className="mt-0.5 text-base font-medium tabular-nums text-foreground">First {hotDays} days</dd>
      </div>
      <div>
        <dt className="text-sm text-muted-foreground">Warm</dt>
        <dd className="mt-0.5 text-base font-medium tabular-nums text-foreground">
          Next {warmDays} days, until day {archiveFrom}
        </dd>
      </div>
      <div>
        <dt className="text-sm text-muted-foreground">Archive</dt>
        <dd className="mt-0.5 text-base font-medium tabular-nums text-foreground">From day {archiveFrom}</dd>
        {archiveNote ? <dd className="mt-0.5 text-sm text-muted-foreground">{archiveNote}</dd> : null}
      </div>
    </dl>
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

  const applyStatus = readOnly
    ? 'Settings are read-only in this deployment; native lifecycle changes cannot be applied.'
    : loading
      ? 'Checking the backend capability before Apply becomes available.'
      : error
        ? 'Reload storage status before applying the saved policy.'
        : draftDiffers
          ? 'Save the desired policy first; Apply always uses the saved settings.'
          : !statusMatchesDraft
            ? 'Refreshing the saved policy status; Apply stays locked until the backend confirms the same values.'
            : !backendCanApply
              ? `${readableBackend(status?.state_backend ?? '')} reports this policy as advisory or unavailable; no native movement will be claimed.`
              : 'Ready to apply the saved policy to eligible append-only Agentic SOC ledgers.';

  return (
    <SettingsSection title="Storage & retention">
      <SettingsGroup
        id="storage-effective"
        title="Effective lifecycle"
        caption="What the state backend does with the saved policy now."
        action={
          <RefreshButton
            label="Refresh status"
            refreshing={loading}
            onClick={() => void loadStatus()}
          />
        }
      >
        {loading ? (
          <SettingRow variant="block">
            <LoadingState
              label="Loading storage lifecycle"
              description="Checking the state backend and its native tiering capability."
              layout="panel"
              shape="rows"
            />
          </SettingRow>
        ) : error ? (
          <SettingRow variant="block">
            <Callout intent="error" title="Storage status unavailable">
              {error}
            </Callout>
          </SettingRow>
        ) : status ? (
          <div className="divide-y divide-border/70" data-testid="storage-lifecycle-status">
            <SettingRow
              variant="status"
              label={`${readableBackend(status.state_backend)} state`}
              help={status.policy_name ? `Native policy ${status.policy_name}.` : undefined}
              status={
                <StatusDot tone={statusTone(status.effective_state)}>{readableState(status.effective_state)}</StatusDot>
              }
            />
            <SettingRow variant="block">
              <TierLine
                label="Storage lifecycle timeline"
                hotDays={status.policy.hot_days}
                warmDays={status.policy.warm_days}
                archiveFrom={status.policy.archive_from_days}
                archiveNote="Desired · not configured."
              />
            </SettingRow>
            {!status.capabilities.supported && status.capabilities.reason ? (
              <SettingRow variant="block">
                <Callout intent="warning" title="Native Hot to Warm movement is not available">
                  {status.capabilities.reason}
                </Callout>
              </SettingRow>
            ) : null}
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        id="storage-policy"
        title="Desired policy"
        caption="Saved with the page's Save and Discard. Saving records intent; Apply below is a separate step."
      >
        <SettingRow
          variant="switch"
          label="Lifecycle enabled"
          help="Move eligible append-only Agentic SOC data from Hot to Warm."
          checked={draft.enabled}
          disabled={readOnly}
          onCheckedChange={(enabled) => changePolicy({ enabled })}
        />
        {/* Up to 3650 days with steppers and the unit: the field takes 12rem, and so does its
            column (a row's column is never narrower than its number field). */}
        <SettingRow variant="field" controlWidth="12rem">
          <NumPref
            label="Hot retention"
            help="Append-only ledgers stay Hot for this long. Default 180 days."
            unit="days"
            value={draft.hot_days}
            min={1}
            max={3650}
            disabled={readOnly || !draft.enabled}
            onChange={(hot_days) => changePolicy({ hot_days })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth="12rem">
          <NumPref
            label="Warm retention"
            help="More time before the desired archive boundary. Default 90 days."
            unit="days"
            value={draft.warm_days}
            min={1}
            max={3650}
            disabled={readOnly || !draft.enabled}
            onChange={(warm_days) => changePolicy({ warm_days })}
          />
        </SettingRow>
        <SettingRow
          variant="select"
          label="Desired Glacier class"
          help="Intent only, until an independent checksummed export and restore pipeline is configured."
          value={draft.glacier_storage_class}
          options={GLACIER_CLASSES}
          disabled={readOnly || !draft.enabled}
          onValueChange={(value) =>
            changePolicy({
              glacier_storage_class: value as StorageLifecycleConfig['glacier_storage_class'],
            })
          }
        />
        <SettingRow variant="block">
          <TierLine
            label="Desired storage lifecycle"
            hotDays={draft.hot_days}
            warmDays={draft.warm_days}
            archiveFrom={archiveFrom}
          />
        </SettingRow>
        <SettingRow
          variant="status"
          label="Automatic deletion"
          help="Automatic deletion is off and cannot be turned on in this release."
          status={<StatusDot>Off</StatusDot>}
        />
      </SettingsGroup>

      <SettingsGroup
        id="storage-preview"
        title="Preview and apply"
        caption="Audit and usage ledgers are the only targets a native lifecycle can move. Mutable cases stay Hot, and connected source logs stay external and read-only."
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void previewDraft()}
            disabled={previewing}
            aria-busy={previewing || undefined}
          >
            {previewing ? <LoadingGlyph size="sm" className="size-4" /> : null}
            Preview draft
          </Button>
        }
      >
        <SettingRow variant="block" bleed>
          {projected?.targets?.length ? (
            <ul aria-label="Storage lifecycle scope" className="divide-y divide-border/70">
              {projected.targets.map((target) => (
                <TargetRow key={target.id} target={target} />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-sm text-muted-foreground xl:px-5">
              Load the effective status or preview the draft to see exactly what is in scope.
            </p>
          )}
        </SettingRow>
        <SettingRow
          variant="action"
          label="Apply supported lifecycle"
          help={<span aria-live="polite">{applyStatus}</span>}
          action={
            <Button
              type="button"
              onClick={() => void applyPersistedPolicy()}
              disabled={applyDisabled}
              aria-busy={applying || undefined}
              title={draftDiffers ? 'Save the desired policy before applying it' : undefined}
            >
              {applying ? <LoadingGlyph size="sm" className="size-4" /> : <Database className="h-4 w-4" aria-hidden />}
              Apply saved policy
            </Button>
          }
        />
        <SettingRow variant="block">
          <p className="max-w-[42rem] text-sm text-muted-foreground">
            Glacier is desired but not configured. Never move an Elasticsearch snapshot repository
            prefix to Glacier; an archive needs an independent export, checksum, manifest and restore
            path.
          </p>
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  );
}

export default StorageLifecycleSection;
