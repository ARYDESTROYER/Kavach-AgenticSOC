/**
 * Baseline: anomaly-baseline warm-up and coverage, and the baseline policy editor
 * (Round 4 surface, Round 5 R6 config-editor wiring, Round 14 console grammar).
 *
 * The top of the page is a read-only view of the per-entity streaming baselines that
 * "improve over time" (online EWMA/EWMV + 168 hour-of-week buckets + t-digest): a
 * `KpiStrip` of counts and the overall warm-up in a panel. Below it, the policy editor
 * exposes `Preferences.baseline` (a `BaselineConfig`) through the typed GET/PUT config
 * endpoint (W0-F F5) so an operator can tune the detector.
 *
 * Round 14 (BL1, BL3): the header is the title "Baseline" with a help tip (which now
 * carries the advisory note that used to be a permanent callout) and an icon Refresh;
 * the policy is one panel of rows whose number fields size to their numbers, and the
 * modified-z threshold is a number field, so its value shows once.
 *
 * #3: the baseline is a pure advisory PRODUCER: it ranks/emits candidate signals for
 * the EVENT-detection funnel and NEVER closes or escalates a case. The config editor is
 * a CONFIG WRITER only: deep-merge PUT, never `decide()`, never bills an LLM (#3/#6).
 * #9: every value renders as plain text via the overview component / labelled fields.
 */
import * as React from 'react';
import { Activity } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { LoadingState, Panel } from '@/design-system';
import { errorMessage } from '@/lib/errorMessage';
import type { BaselineConfig } from '@/lib/types';
import { humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Switch } from '@/ui/switch';
import { Label } from '@/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

import { useNavigateOptional } from '@/soc/router';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { ProtectedRoute, Can, useCan } from '@/soc/components/Can';
import { BaselineStatsOverview } from '@/soc/components/BaselineGauge';
import { Field } from '@/soc/components/Field';
import { NumberField } from '@/soc/components/NumberField';
import { StickySaveBar } from '@/soc/components/SettingsGrid';
import { useConfigEditor } from '@/soc/components/rules';
import { fetchBaselineStats, type BaselineStats } from '@/soc/Baseline.api';

/** Backend defaults (mirror `config.BaselineConfig`: on by default since Round 10). */
const DEFAULT_BASELINE_CONFIG: Required<BaselineConfig> = {
  enabled: true,
  half_life_days: 14,
  warmup_multiplier: 3,
  modified_z_threshold: 3.5,
  tdigest_compression: 100,
  seasonality: 'hour_of_week',
};

/** The page help: what the baseline is, and the advisory boundary (formerly a callout). */
const PAGE_HELP =
  'Per-entity streaming baselines that improve over time: warm-up progress and robust ' +
  'percentiles. The baseline is advisory. A deviation only surfaces a candidate for the ' +
  'detection funnel; it never closes, escalates or decides a case.';

/** One policy row: label and help on the left, the control on the right (stacks on a phone). */
const POLICY_ROW = 'flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6';

const SEASONALITIES: BaselineConfig['seasonality'][] = [
  'none',
  'hour_of_day',
  'hour_of_week',
  'day_of_week',
];

export default function Baseline() {
  return (
    <ProtectedRoute resource="settings" action="read">
      <BaselineInner />
    </ProtectedRoute>
  );
}

export function BaselineInner() {
  const navigate = useNavigateOptional();
  const canManage = useCan('settings', 'manage');
  const [stats, setStats] = React.useState<BaselineStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const cfg = useConfigEditor<BaselineConfig>(api.baseline, DEFAULT_BASELINE_CONFIG);
  const draft = { ...DEFAULT_BASELINE_CONFIG, ...cfg.draft };

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await fetchBaselineStats());
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const initialLoading = loading && !stats;

  const save = React.useCallback(async () => {
    try {
      await cfg.save();
      toast.success('Baseline policy saved.');
    } catch (e) {
      toast.error(errorMessage(e, 'Could not save the baseline policy.'));
    }
  }, [cfg]);

  return (
    <PageContainer variant="wide">
      <PageHeader
        title="Baseline"
        help={PAGE_HELP}
        controls={
          // Refresh only re-loads the read-only stats; it must NOT reload the config
          // (that would clobber any unsaved policy edits; the editor has its own
          // load-on-mount + LoadError retry).
          <RefreshButton
            onClick={() => void load()}
            refreshing={loading}
            label="Refresh baseline"
            display="icon"
          />
        }
      />

      {/* ── Warm-up overview (read-only) ─────────────────────────────────── */}
      {initialLoading ? (
        <LoadingState
          label="Loading anomaly baseline"
          description="Preparing warm-up coverage and entity percentiles."
          layout="panel"
          shape="panel"
        />
      ) : error && !stats ? (
        <LoadError
          error={error}
          title="Could not load the baseline"
          fallback="Could not load baseline stats."
          onRetry={() => void load()}
        />
      ) : stats ? (
        <>
          {error ? (
            <LoadError
              error={error}
              title="Could not refresh the anomaly baseline"
              fallback="The last baseline snapshot is still available."
              onRetry={() => void load()}
            />
          ) : null}
          <BaselineStatsOverview stats={stats} />
        </>
      ) : (
        <Panel as="div">
        <EmptyState
          icon={Activity}
          title="No baseline data yet"
          // #41: the baseline does NOT warm up on its own. It only produces once (1) the
          // policy below is ENABLED and (2) an events-role feed with detection is sending
          // data through the funnel. Enabling the policy alone leaves the warm-up gauge
          // perpetually empty (which reads as "broken"), so spell out both dependencies
          // and point at where the missing half — an events source — is connected.
          description="The baseline only warms up once it is enabled (in the policy below) and an events-role feed with detection is sending data. Enabling the policy on its own is not enough. Connect an events source, then let detection run to begin warming up."
          action={
            <Button variant="outline" size="sm" onClick={() => navigate('sources')}>
              Connect an events source
            </Button>
          }
        />
        </Panel>
      )}

      {!initialLoading ? (
        <>
      {/* ── Policy editor (R6) ───────────────────────────────────────────── */}
      {cfg.error ? (
        <LoadError
          error={cfg.error}
          title="Could not load the baseline policy"
          fallback="Could not load the baseline policy."
          onRetry={() => void cfg.reload()}
        />
      ) : (
        <Panel
          id="baseline-policy"
          title="Baseline policy"
          caption="On by default. An off detector emits no candidates and changes nothing."
          className="max-w-[44rem] scroll-mt-24"
          data-testid="baseline-policy"
        >
            {cfg.loading ? (
              // Never show the default-valued form while the persisted policy loads;
              // that flashes a misleading "disabled" state, then snaps to the saved
              // values. Use the shared blocking-panel grammar until it resolves.
              <LoadingState
                label="Loading baseline policy"
                description="Preparing the saved detector configuration."
                layout="panel"
                shape="panel"
              />
            ) : (
            <fieldset disabled={!canManage} className="divide-y divide-border/70">
              <legend className="sr-only">Baseline policy</legend>
              <div className={cn(POLICY_ROW, 'pt-0 sm:items-center')}>
                <div className="min-w-0 space-y-0.5">
                  <Label htmlFor="baseline-enabled" className="text-base font-medium">
                    Enable anomaly baseline
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    When on, per-signature sketches warm up and flag deviations as
                    detection candidates.
                  </p>
                </div>
                <Switch
                  id="baseline-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(v) => cfg.update({ enabled: v })}
                />
              </div>

              <div className="grid gap-x-6 gap-y-4 py-4 sm:grid-cols-2">
                <NumberField
                  label="Half-life"
                  description="EWMA decay half-life. Longer remembers more history."
                  value={draft.half_life_days}
                  min={0.5}
                  max={365}
                  step={0.5}
                  unit="days"
                  defaultValue={DEFAULT_BASELINE_CONFIG.half_life_days}
                  disabled={!canManage}
                  onChange={(v) => cfg.update({ half_life_days: v })}
                />
                <NumberField
                  label="Warm-up multiplier"
                  description="Times the seasonal period a bucket must observe before it is warm (guards a cold series)."
                  value={draft.warmup_multiplier}
                  min={1}
                  max={20}
                  step={1}
                  defaultValue={DEFAULT_BASELINE_CONFIG.warmup_multiplier}
                  disabled={!canManage}
                  onChange={(v) => cfg.update({ warmup_multiplier: v })}
                />
                <NumberField
                  label="Modified-z threshold"
                  description="The robust deviation bar; a signature above it is anomalous. 3.5 is the conventional default."
                  value={draft.modified_z_threshold}
                  min={0}
                  max={10}
                  step={0.1}
                  defaultValue={DEFAULT_BASELINE_CONFIG.modified_z_threshold}
                  disabled={!canManage}
                  onChange={(v) => cfg.update({ modified_z_threshold: v })}
                />
                <NumberField
                  label="t-digest compression"
                  description="Bounds the quantile-sketch size (higher is more precise, more memory)."
                  value={draft.tdigest_compression}
                  min={20}
                  max={1000}
                  step={10}
                  defaultValue={DEFAULT_BASELINE_CONFIG.tdigest_compression}
                  disabled={!canManage}
                  onChange={(v) => cfg.update({ tdigest_compression: v })}
                />
                <Field
                  label="Seasonality"
                  description="How observations are bucketed for seasonality."
                >
                  {({ id, describedBy }) => (
                    <Select
                      value={draft.seasonality ?? 'hour_of_week'}
                      disabled={!canManage}
                      onValueChange={(v) =>
                        cfg.update({ seasonality: v as BaselineConfig['seasonality'] })
                      }
                    >
                      <SelectTrigger id={id} aria-describedby={describedBy} className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SEASONALITIES.map((s) => (
                          <SelectItem key={s} value={s as string}>
                            {humanizeToken(s as string)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              </div>

              {!canManage ? (
                <p className="pt-4 text-sm text-muted-foreground">
                  You have read-only access. Ask a SOC administrator to change the
                  baseline policy.
                </p>
              ) : null}
            </fieldset>
            )}
        </Panel>
      )}

      <Can resource="settings" action="manage">
        <StickySaveBar
          visible={cfg.dirty}
          busy={cfg.saving}
          message="Unsaved baseline-policy changes."
          onSave={() => void save()}
          onDiscard={cfg.discard}
        />
      </Can>
        </>
      ) : null}
    </PageContainer>
  );
}
