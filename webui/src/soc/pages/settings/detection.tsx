/**
 * Detection settings section (Round-5 Sett-A decomposition + Round-5 R1 auto-close
 * dead-field fix; Round 14 grouped panels).
 *
 * Governs clustering, the deterministic risk weights, asset criticality, escalation,
 * the auto-close policy, and opt-in cross-source correlation.
 *
 * ROUND-5 R1 (bug #1): the auto-close editor used to bind the DEAD
 * `prefs.fp_auto_close` scalar, while `decide()` (case_manager.py) reads
 * `prefs.auto_close`, so the flagship autonomy toggle did NOTHING. This section writes
 * `prefs.auto_close.<verdict>` (the field `decide()` actually reads) via one reusable
 * `<VerdictAutoClose>` group rendered TWICE (false_positive + true_positive).
 * `fp_auto_close` is intentionally left in place (the `_migrate_fp_auto_close` legacy
 * path still consumes it); it is simply no longer edited here.
 *
 * INVARIANT #3: this section only WRITES config. The close or escalate decision is
 * always made by deterministic code (`decide()`) against that config, never by these
 * controls. TRUE_POSITIVE auto-close is an explicit opt-in (OFF by default) and
 * NEEDS_HUMAN NEVER auto-closes (code-enforced; shown as a locked status row).
 */
import { Lock, RotateCcw } from 'lucide-react';

import { humanizeToken } from '@/lib/format';
import type { AutoClosePolicy, RiskWeights, VerdictAutoClose as VerdictAutoCloseConfig } from '@/lib/types';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { NumberField } from '@/soc/components/NumberField';
import { TagInput } from '@/soc/components/TagInput';
import { SCORE_BANDS, type ScoreBand } from '@/soc/components/palette';
import { AssetCriticalityEditor } from '@/soc/components/rules';

import { durationReading, withReading } from './duration';
import { NumPref, SettingRow, SettingsGroup, SettingsSection, type SecProps } from './primitives';

/* --------------------------------------------------------------------------- */
/* Risk weights: one number per factor of the deterministic risk model. Binds to   */
/* the REAL `prefs.risk_weights` fields; the per-factor share of the score is the  */
/* honest normalised share (compute_risk() normalises by the weight sum), and the  */
/* score-band scale uses the ONE canonical ladder from palette (22/48/74).         */
/* --------------------------------------------------------------------------- */

export const RISK_WEIGHT_KEYS = ['volume', 'velocity', 'reputation', 'diversity', 'asset_criticality'] as const;
type RiskWeightKey = (typeof RISK_WEIGHT_KEYS)[number];

/** Defaults mirror `config.py` `RiskWeights`: used to fill an unset field for display
 *  and to power "Reset to defaults". Kept in sync with the backend (additive-safe). */
export const RISK_WEIGHT_DEFAULTS: Record<RiskWeightKey, number> = {
  volume: 0.25,
  velocity: 0.2,
  reputation: 0.3,
  diversity: 0.15,
  asset_criticality: 0.1,
};

const RISK_WEIGHT_HELP: Record<RiskWeightKey, string> = {
  volume: 'How many alerts clustered into the case.',
  velocity: 'How fast those alerts arrived.',
  reputation: 'The threat intelligence reputation of the indicators involved.',
  diversity: 'How many distinct entities and signals the cluster spans.',
  asset_criticality: 'How critical the assets involved are (from Asset criticality).',
};

const BAND_ORDER: ScoreBand[] = ['low', 'medium', 'high', 'critical'];
const BAND_CLS: Record<ScoreBand, string> = {
  low: 'bg-low',
  medium: 'bg-medium',
  high: 'bg-high',
  critical: 'bg-critical',
};

/** The share each weight takes of the score, in whole percent (0 when every weight is 0). */
export function weightShares(weights: RiskWeights): Record<RiskWeightKey, number> {
  const values = RISK_WEIGHT_KEYS.map((k) => Math.max(0, Number(weights[k] ?? RISK_WEIGHT_DEFAULTS[k])));
  const sum = values.reduce((a, b) => a + b, 0);
  return Object.fromEntries(
    RISK_WEIGHT_KEYS.map((k, i) => [k, sum > 0 ? Math.round((values[i] / sum) * 100) : 0]),
  ) as Record<RiskWeightKey, number>;
}

/** A read-only reference of the ONE canonical 0 to 100 score-band ladder (palette.SCORE_BANDS). */
function ScoreScaleBar() {
  const total = 100;
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-foreground">Score bands</p>
      <div className="flex h-2 overflow-hidden rounded-full" aria-hidden>
        {BAND_ORDER.map((b) => {
          const [from, to] = SCORE_BANDS[b];
          return (
            <span
              key={b}
              className={cn('h-full', BAND_CLS[b])}
              style={{ width: `${((to - from + 1) / total) * 100}%` }}
            />
          );
        })}
      </div>
      <ul className="mt-1.5 flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground">
        {BAND_ORDER.map((b) => {
          const [from, to] = SCORE_BANDS[b];
          return (
            <li key={b}>
              <span className="capitalize">{b}</span>{' '}
              <span className="tabular-nums">
                {from} to {to}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DetectionSection({ prefs, update }: SecProps) {
  const corr = prefs.default_correlation || {};
  const weights = prefs.risk_weights || {};
  const shares = weightShares(weights);
  const weightSum = RISK_WEIGHT_KEYS.reduce(
    (sum, k) => sum + Math.max(0, Number(weights[k] ?? RISK_WEIGHT_DEFAULTS[k])),
    0,
  );
  const resetWeights = () => update({ risk_weights: { ...RISK_WEIGHT_DEFAULTS } });
  return (
    <SettingsSection title="Detection">
      <SettingsGroup
        id="detection-correlation"
        title="Correlation"
        caption="Alerts that share an entity within the window cluster into one case, once per cluster."
      >
        <SettingRow variant="field" controlWidth="8rem">
          <NumPref
            label="Alerts to open a case"
            help="How many alerts must share an entity within the window."
            value={corr.n}
            min={1}
            onChange={(v) => update({ default_correlation: { ...corr, n: v } })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth="8rem">
          <NumPref
            label="Window"
            help="How far apart those alerts may be."
            unit="s"
            value={corr.window_seconds}
            min={1}
            onChange={(v) => update({ default_correlation: { ...corr, window_seconds: v } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        id="detection-risk"
        title="Risk weights"
        caption="How the deterministic risk score is built. Weights are normalised to a score from 0 to 100, so they need not add up to 1."
        action={
          <Button variant="outline" size="sm" onClick={resetWeights}>
            <RotateCcw aria-hidden />
            Reset to defaults
          </Button>
        }
      >
        {RISK_WEIGHT_KEYS.map((k) => (
          <SettingRow key={k} variant="field" controlWidth="8rem">
            <NumberField
              label={humanizeToken(k)}
              description={`${RISK_WEIGHT_HELP[k]} ${shares[k]}% of the score.`}
              value={Number(weights[k] ?? RISK_WEIGHT_DEFAULTS[k])}
              min={0}
              max={1}
              step="any"
              stepperStep={0.05}
              empty="keep"
              onChange={(v) => update({ risk_weights: { ...weights, [k]: v } })}
            />
          </SettingRow>
        ))}
        <SettingRow variant="block">
          <p className="mb-3 text-sm text-muted-foreground">
            Total weight <span className="font-medium tabular-nums text-foreground">{weightSum.toFixed(2)}</span>
          </p>
          <ScoreScaleBar />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        id="detection-asset"
        title="Asset criticality"
        caption="High-value networks and hosts raise the risk score. Criticality only raises risk; it never closes or escalates a case."
      >
        <SettingRow variant="block">
          <AssetCriticalityEditor
            networks={prefs.asset_networks ?? []}
            onNetworksChange={(next) => update({ asset_networks: next })}
            exact={prefs.asset_criticality ?? {}}
            onExactChange={(next) => update({ asset_criticality: next })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        id="detection-escalation"
        title="Escalation"
        caption="When a case goes to a person instead of closing."
      >
        <SettingRow variant="field" controlWidth="8rem">
          <NumPref
            label="Escalation confidence"
            help="Below this verdict confidence, a case is escalated for a person."
            value={prefs.escalation_confidence}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => update({ escalation_confidence: v })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth="8rem">
          <NumPref
            label="Critical severity"
            help="The source severity treated as critical."
            value={prefs.critical_severity}
            step={0.5}
            onChange={(v) => update({ critical_severity: v })}
          />
        </SettingRow>
      </SettingsGroup>

      <AutonomyControls prefs={prefs} update={update} />

      <CrossSourceGroup prefs={prefs} update={update} />
    </SettingsSection>
  );
}

function CrossSourceGroup({ prefs, update }: SecProps) {
  const x = prefs.cross_source_correlation || {};
  const set = (patch: Partial<typeof x>) =>
    update({ cross_source_correlation: { ...x, ...patch } });
  const entityKeys = Array.isArray(x.entity_keys)
    ? x.entity_keys
    : ['ip', 'host', 'user', 'file_hash', 'domain'];
  const enabled = x.enabled ?? false;
  return (
    <SettingsGroup
      id="detection-crosssource"
      title="Cross-source correlation"
      caption="A second pass links open cases from different sources that share an entity. It shows them as related cases and never merges them."
    >
      <SettingRow
        variant="switch"
        label="Cross-source correlation"
        help="Off by default."
        checked={enabled}
        onCheckedChange={(v) => set({ enabled: v })}
      />
      {/* The knobs disable with the switch, so the group reads as one unit (#20); each
          disabled control dims itself, and the text stays at full contrast. */}
      <div className="divide-y divide-border/70">
        <SettingRow variant="field" controlWidth="8rem">
          <NumPref
            label="Time window"
            help="How far apart the cases may be."
            unit="s"
            value={x.time_window_seconds ?? 300}
            min={1}
            disabled={!enabled}
            onChange={(v) => set({ time_window_seconds: v })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth="8rem">
          <NumPref
            label="Minimum distinct sources"
            help="How many sources must see the entity."
            value={x.min_sources ?? 2}
            min={2}
            disabled={!enabled}
            onChange={(v) => set({ min_sources: v })}
          />
        </SettingRow>
        <SettingRow variant="field" wide mono>
          <TagInput
            label="Entity keys"
            description="The entity kinds to link cases on."
            placeholder="Add a key"
            value={entityKeys}
            disabled={!enabled}
            onChange={(next) => set({ entity_keys: next.map((k) => k.trim()).filter(Boolean) })}
          />
        </SettingRow>
      </div>
    </SettingsGroup>
  );
}

/** Conservative per-verdict defaults (mirror `config.py` `AutoClosePolicy`). Applied
 * only to fill an absent field for a control's readout; never written unless edited. */
const VERDICT_DEFAULTS: Record<'false_positive' | 'true_positive', Required<VerdictAutoCloseConfig>> = {
  false_positive: { enabled: true, min_confidence: 0.85, max_risk_score: 30, objection_window_minutes: 1440 },
  true_positive: { enabled: false, min_confidence: 0.95, max_risk_score: 10, objection_window_minutes: 4320 },
};

/**
 * ONE reusable per-verdict-class auto-close group. Rendered TWICE (for
 * `false_positive` and `true_positive`) by {@link AutonomyControls}. It reads and
 * writes exactly `prefs.auto_close.<verdictKey>`, the nested field
 * `case_manager.decide()` evaluates (#3), so toggling it actually changes what the
 * engine does. Every control is labelled: the enable switch row, then the confidence,
 * risk ceiling and objection window as `NumberField`s.
 *
 * An emptied field is no value (`empty="keep"`): it shows the current bar again and
 * commits nothing. Committing the field's minimum instead would silently loosen the
 * policy (a confidence bar of 0% auto-closes at any confidence, an objection window of 0
 * closes at once), the opposite of what clearing a field means.
 */
function VerdictAutoClose({
  verdictKey,
  label,
  optIn,
  entry,
  onChange,
  id,
}: {
  verdictKey: 'false_positive' | 'true_positive';
  label: string;
  /** When true this class is an explicit opt-in (TRUE_POSITIVE). */
  optIn?: boolean;
  entry: VerdictAutoCloseConfig;
  onChange: (next: VerdictAutoCloseConfig) => void;
  id?: string;
}) {
  const d = VERDICT_DEFAULTS[verdictKey];
  const enabled = entry.enabled ?? d.enabled;
  const minConf = entry.min_confidence ?? d.min_confidence;
  const maxRisk = entry.max_risk_score ?? d.max_risk_score;
  const objWindow = entry.objection_window_minutes ?? d.objection_window_minutes;
  const set = (patch: Partial<VerdictAutoCloseConfig>) => onChange({ ...entry, ...patch });
  const noun = label.toLowerCase();

  const enableHelp = optIn
    ? `Off by default. When on, a ${noun} verdict that clears both bars below is closed automatically and audited. Turn it on only when you trust the agent to resolve confirmed detections.`
    : `When on, a ${noun} verdict that clears both bars below is closed automatically and audited. When off, every ${noun} case waits for a person.`;

  return (
    <SettingsGroup
      id={id}
      title={`${label} auto-close`}
      caption={optIn ? 'An explicit opt-in, off by default.' : 'Code closes the case only when the verdict clears both bars.'}
    >
      <SettingRow
        variant="switch"
        label={`Auto-close confident ${noun}s`}
        help={enableHelp}
        checked={enabled}
        onCheckedChange={(v) => set({ enabled: v })}
      />
      <div className="divide-y divide-border/70">
        <SettingRow variant="field" controlWidth="8rem">
          <NumberField
            label="Minimum confidence to auto-close"
            description="The verdict confidence must be at or above this bar."
            value={Math.round(minConf * 100)}
            min={0}
            max={100}
            unit="%"
            empty="keep"
            disabled={!enabled}
            onChange={(v) => set({ min_confidence: v / 100 })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth="8rem">
          <NumberField
            label="Maximum risk score to auto-close"
            description={`A case scoring above this (0 to 100) is never auto-closed, even as a ${noun}.`}
            value={maxRisk}
            min={0}
            max={100}
            empty="keep"
            disabled={!enabled}
            onChange={(v) => set({ max_risk_score: v })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth="8rem">
          <NumberField
            label="Objection window"
            description={withReading(
              'How long before an auto-close takes effect, so a person can object.',
              durationReading(objWindow * 60, 60),
            )}
            value={objWindow}
            min={0}
            unit="min"
            // Unbounded, so it would plan for 12rem; minutes up to five digits fit 8rem.
            size="sm"
            empty="keep"
            disabled={!enabled}
            onChange={(v) => set({ objection_window_minutes: v })}
          />
        </SettingRow>
      </div>
    </SettingsGroup>
  );
}

function AutonomyControls({ prefs, update }: SecProps) {
  // R1: read + write the LIVE `prefs.auto_close` policy, the field decide() acts on.
  const policy: AutoClosePolicy = prefs.auto_close || {};
  const setVerdict = (key: 'false_positive' | 'true_positive', next: VerdictAutoCloseConfig) =>
    update({ auto_close: { ...policy, [key]: next } });

  return (
    <>
      <VerdictAutoClose
        id="detection-autoclose"
        verdictKey="false_positive"
        label="False positive"
        entry={policy.false_positive || {}}
        onChange={(next) => setVerdict('false_positive', next)}
      />
      <VerdictAutoClose
        verdictKey="true_positive"
        label="True positive"
        optIn
        entry={policy.true_positive || {}}
        onChange={(next) => setVerdict('true_positive', next)}
      />
      {/* NEEDS_HUMAN: code-enforced never-auto-close, shown as a LOCKED status row (no
          toggle), so operators see the guarantee without a way to turn it off. */}
      <SettingsGroup title="Needs human">
        <SettingRow
          variant="status"
          label="Cases that need a person"
          help="A case the agent routes to Needs human always waits for an analyst. This is enforced in code and cannot be changed."
          status={
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <Lock className="h-3.5 w-3.5" aria-hidden />
              Locked: never auto-closes
            </span>
          }
        />
      </SettingsGroup>
    </>
  );
}
