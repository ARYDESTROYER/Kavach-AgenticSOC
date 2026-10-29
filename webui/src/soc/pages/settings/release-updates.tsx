/**
 * Updates & releases settings section: read-only upstream source discovery and its
 * operator-configurable GitHub refs (Round 14 grouped panels).
 */
import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type {
  Preferences,
  ReleaseUpdateConfig,
  UpstreamReleaseCandidate,
  UpstreamReleasesResponse,
} from '@/lib/types';
import { Callout, LoadingState } from '@/design-system';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { RefreshButton } from '@/soc/components/RefreshButton';

import { NumPref, SettingRow, SettingsGroup, SettingsSection, TextPref, errMsg } from './primitives';

const DEFAULT_RELEASE_UPDATES: ReleaseUpdateConfig = {
  enabled: true,
  repository_url: 'https://github.com/ARYDESTROYER/Agentic-Kibana',
  stable_branch: 'main',
  testing_branch: 'Testing',
  check_interval_minutes: 360,
};

function normalizedConfig(value?: Partial<ReleaseUpdateConfig> | null): ReleaseUpdateConfig {
  return { ...DEFAULT_RELEASE_UPDATES, ...(value ?? {}) };
}

function sameConfig(left: ReleaseUpdateConfig, right: ReleaseUpdateConfig): boolean {
  return (
    left.enabled === right.enabled &&
    left.repository_url === right.repository_url &&
    left.stable_branch === right.stable_branch &&
    left.testing_branch === right.testing_branch &&
    left.check_interval_minutes === right.check_interval_minutes
  );
}

function checkedLabel(value: string | null): string {
  if (!value) return 'Not checked yet';
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return timestamp.toLocaleString();
}

function ChannelObservation({ candidate }: { candidate: UpstreamReleaseCandidate }) {
  const available = candidate.state === 'available';
  const disabled = candidate.state === 'disabled';
  return (
    <SettingRow variant="block">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">
              {candidate.channel === 'stable' ? 'Stable' : 'Testing'}
            </h4>
            <Badge
              variant={available && !candidate.stale ? 'success' : disabled ? 'outline' : 'warning'}
            >
              {candidate.stale
                ? 'Last verified'
                : available
                  ? 'Observed'
                  : disabled
                    ? 'Disabled'
                    : 'Unavailable'}
            </Badge>
          </div>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {candidate.branch}
          </p>
        </div>
        {candidate.source_url || candidate.commit_url ? (
          <div className="flex flex-wrap items-center justify-end gap-1">
            {candidate.source_url ? (
              <Button asChild variant="ghost" size="sm">
                <a href={candidate.source_url} target="_blank" rel="noreferrer">
                  Open branch
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </Button>
            ) : null}
            {candidate.commit_url ? (
              <Button asChild variant="ghost" size="sm">
                <a href={candidate.commit_url} target="_blank" rel="noreferrer">
                  Review commit
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {available ? (
        <>
          {candidate.stale && candidate.error_message ? (
            <p className="mt-3 text-xs leading-relaxed text-warning-text">
              {candidate.error_message}
            </p>
          ) : null}
          <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Version</dt>
              <dd className="mt-0.5 font-mono font-medium text-foreground">
                {candidate.version ?? 'Unknown'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Commit</dt>
              <dd className="mt-0.5 font-mono font-medium text-foreground">
                {candidate.commit_sha?.slice(0, 12) ?? 'Unknown'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Checked</dt>
              <dd className="mt-0.5 text-foreground">{checkedLabel(candidate.checked_at)}</dd>
            </div>
          </dl>
        </>
      ) : candidate.error_message ? (
        <p className="mt-3 text-xs leading-relaxed text-warning-text">
          {candidate.error_message}
        </p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Source discovery is off. The running application continues unchanged.
        </p>
      )}
    </SettingRow>
  );
}

export interface ReleaseUpdatesSectionProps {
  prefs: Preferences;
  persistedPrefs: Preferences;
  update: (patch: Partial<Preferences>) => void;
  readOnly?: boolean;
}

export function ReleaseUpdatesSection({
  prefs,
  persistedPrefs,
  update,
  readOnly = false,
}: ReleaseUpdatesSectionProps) {
  const draft = normalizedConfig(prefs.release_updates);
  const persisted = normalizedConfig(persistedPrefs.release_updates);
  const draftDiffers = !sameConfig(draft, persisted);
  const persistedKey = JSON.stringify(persisted);
  const [status, setStatus] = React.useState<UpstreamReleasesResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const loadSequenceRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.upstreamReleases({ cache: 'no-store' });
      if (sequence === loadSequenceRef.current) setStatus(next);
    } catch (cause) {
      if (sequence === loadSequenceRef.current) {
        setError(errMsg(cause, 'Could not load upstream release status.'));
      }
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    return () => {
      // Ignore an observation started for the previous saved source or an
      // unmounted Settings page if it resolves after its replacement.
      loadSequenceRef.current += 1;
    };
  }, [load, persistedKey]);

  const change = (patch: Partial<ReleaseUpdateConfig>) => {
    update({ release_updates: { ...draft, ...patch } });
  };

  const checkNow = async () => {
    if (draftDiffers || checking) return;
    setChecking(true);
    setError(null);
    try {
      const next = await api.checkUpstreamReleases();
      setStatus(next);
      toast.success('Upstream branches checked.');
    } catch (cause) {
      const message = errMsg(cause, 'Could not check upstream branches.');
      setError(message);
      toast.error(message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <SettingsSection title="Updates & releases">
      <SettingsGroup
        id="release-source"
        title="Source and channels"
        caption="The backend checks one public GitHub repository. Repository and branch values are checked before they can be saved."
      >
        <SettingRow
          variant="switch"
          label="Check for source updates"
          help="On by default. Branch checks are cached and read-only; they never clone, run, deploy, restart or migrate anything."
          checked={draft.enabled}
          disabled={readOnly}
          onCheckedChange={(enabled) => change({ enabled })}
        />
        <SettingRow variant="field" wide mono>
          <TextPref
            label="Public repository"
            help="A https://github.com/owner/repository address. Private hosts and other addresses are refused."
            value={draft.repository_url}
            disabled={readOnly || !draft.enabled}
            onChange={(repository_url) => change({ repository_url })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth="12rem" mono>
          <TextPref
            label="Stable branch"
            help="The supported release branch, normally main. Only a signed Stable release from it can be installed."
            value={draft.stable_branch}
            disabled={readOnly || !draft.enabled}
            onChange={(stable_branch) => change({ stable_branch })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth="12rem" mono>
          <TextPref
            label="Testing branch"
            help="The integration branch. Testing revisions can never be installed from the Console."
            value={draft.testing_branch}
            disabled={readOnly || !draft.enabled}
            onChange={(testing_branch) => change({ testing_branch })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth="9rem">
          <NumPref
            label="Check interval"
            help="Default 360 minutes. Cached checks keep public API use low."
            unit="min"
            value={draft.check_interval_minutes}
            min={15}
            max={10_080}
            step={15}
            disabled={readOnly || !draft.enabled}
            onChange={(check_interval_minutes) => change({ check_interval_minutes })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        id="release-observed"
        title="Observed revisions"
        caption={
          draftDiffers
            ? 'Save or discard the source changes before checking; discovery always uses the saved configuration.'
            : status
              ? `The latest version and commit on each saved branch. Automatic checks are cached for ${Math.round(status.cache.max_age_seconds / 60)} minutes.`
              : 'The latest version and commit on each saved branch. These do not authorize an installation.'
        }
        action={
          <RefreshButton
            label="Check now"
            refreshing={checking}
            disabled={loading || draftDiffers}
            onClick={() => void checkNow()}
          />
        }
      >
        {loading ? (
          <SettingRow variant="block">
            <LoadingState
              label="Checking release source"
              description="Reading the backend's cached branch observations."
              layout="panel"
              shape="rows"
            />
          </SettingRow>
        ) : error ? (
          <SettingRow variant="block">
            <Callout
              intent="error"
              title="Release source unavailable"
              action={
                <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                  Retry
                </Button>
              }
            >
              {error}
            </Callout>
          </SettingRow>
        ) : status ? (
          <>
            <ChannelObservation candidate={status.channels.stable} />
            <ChannelObservation candidate={status.channels.testing} />
          </>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="How Stable updates are installed">
        <SettingRow variant="block">
          <div className="max-w-[42rem] space-y-2 text-sm text-muted-foreground">
            <p>
              Discovery is not deployment. Branch observations stay read-only; they never make a
              branch installable or authorize a change on the host.
            </p>
            <p>
              A supported standalone Compose deployment can offer <strong className="font-medium text-foreground">Update vX</strong> to
              a freshly signed-in platform owner after the backend and the updater verify an
              immutable signed release plan, compatibility, durable configuration, backup readiness
              and automatic rollback.
            </p>
            <p>
              Older deployments need the documented one-time supervisor bootstrap. Custom stacks,
              unsupported state backends and Testing branch revisions stay manual and show a clear
              blocker instead of an update action.
            </p>
            <p>
              The browser only confirms the release the server offers. It never receives or sends
              image references, host paths, commands or deployment credentials.
            </p>
            <p>
              After a successful update, this tab reloads only when the same-origin Console manifest
              exactly matches the healthy Stable backend version and commit. Unknown provenance stays
              blocked, with a manual retry instead of a reload loop.
            </p>
          </div>
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
