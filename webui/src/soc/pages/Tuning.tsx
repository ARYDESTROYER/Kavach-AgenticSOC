/**
 * Auto-tuning — the operator surface for deterministic, bounded threshold tuning.
 *
 * The page intentionally reads like a SOC workbench rather than a settings dashboard:
 * current authority/status, one rule-scoped review queue, a searchable evidence view,
 * observed outcomes, and an auditable policy/history workspace.
 *
 * Honest framing (#3): tuning changes which candidates are investigated. It never sets
 * verdicts or closes/escalates cases. Suppression and shadow-blocked proposals always
 * require human approval. Apply is RULE-scoped because the backend recomputes and
 * processes every current proposal for the selected rule in one request.
 */
import * as React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  DatabaseZap,
  Info,
  Loader2,
  Play,
  Radar,
  Search,
  ShieldCheck,
  Undo2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  DASH,
  fmtNumber,
  fmtPercent,
  humanizeAge,
  humanizeToken,
} from '@/lib/format';
import { errorMessage } from '@/lib/errorMessage';
import { cn } from '@/lib/cn';
import { useNavigateOptional, type Navigate } from '@/soc/router';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';

import { AgentEffectivenessSummary } from './AgentEffectiveness';
import { PageContainer } from '@/soc/components/PageContainer';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { PageHeader } from '@/soc/components/PageHeader';
import { LoadingState, Panel, StatusDot } from '@/design-system';
import { KpiStrip } from '@/soc/components/KpiStrip';
import { LoadingBar } from '@/soc/components/LoadingBar';
import { KpiTile } from '@/soc/components/KpiTile';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { InlineCode } from '@/soc/components/CodeBlock';
import { HelpTip } from '@/soc/components/HelpTip';
import { Can, ProtectedRoute, useCan } from '@/soc/components/Can';
import { RuleLink, RuleSheetHost } from '@/soc/components/RuleLink';
import { Field } from '@/soc/components/Field';
import { NumberField } from '@/soc/components/NumberField';
import { LabeledSlider } from '@/soc/components/LabeledSlider';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { EffectiveConfigPreview } from '@/soc/components/rules/EffectiveConfigPreview';
import { StickySaveBar } from '@/soc/components/SettingsGrid';
import { useMediaQuery } from '@/soc/hooks/useMediaQuery';
import { useUnsavedChanges } from '@/soc/hooks/useDirtyDraft';

import {
  DEFAULT_TUNING_CONFIG,
  KIND_LABELS,
  isLedgerRowActive,
  observedFpRate,
  tuneDelta,
  tuneValue,
  tuningApi,
  type RuleNoise,
  type TuningCadence,
  type TuningConfig,
  type TuningLedgerRow,
  type TuningRecommendation,
  type TuningRecommendationsResponse,
  type SchedulerHealthResponse,
  type TelemetryRecommendationsResponse,
} from './Tuning.api';

const CADENCES: TuningCadence[] = ['hourly', 'nightly', 'weekly', 'manual'];

const CADENCE_COPY: Record<TuningCadence, string> = {
  hourly: 'every hour',
  nightly: 'every night',
  weekly: 'every week',
  manual: 'only when run manually',
};

type RuleState = 'attention' | 'collecting' | 'within';
type RuleFilter = 'all' | RuleState;

const RULE_FILTERS: Array<{ value: RuleFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'collecting', label: 'Collecting' },
  { value: 'within', label: 'Within target' },
];

function ruleTriggerId(ruleId: string): string {
  return `tuning-rule-trigger-${encodeURIComponent(ruleId)}`;
}

function fmtUtc(iso?: string | null): string {
  if (!iso) return DASH;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return DASH;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

function ChangeArrow({ before, after }: { before: unknown; after: unknown }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 tabular-nums">
      <InlineCode>{tuneValue(before)}</InlineCode>
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <InlineCode>{tuneValue(after)}</InlineCode>
    </span>
  );
}

/** The page's explanation, shown in the header help tip (C8: no description line). */
const PAGE_HELP =
  'Find noisy rules, understand the evidence and review one bounded change at a time. Tuning never decides a case: it changes only which future candidates enter investigation, learns from analyst-confirmed outcomes and never sets a verdict, closes or escalates a case.';

/** A tab body: the modules stacked one panel gutter apart (the page rhythm). */
const TAB_BODY = 'mt-6 flex flex-col gap-4 xl:gap-5 3xl:gap-6';

function ruleState(rule: RuleNoise, minSamples: number): RuleState {
  if (rule.total < minSamples) return 'collecting';
  return rule.over_target ? 'attention' : 'within';
}

/**
 * The ONE table of the tuner's `correlation_n` INERTNESS reason codes, each a short
 * label and a plain sentence (Round 14, SPEC §5 F12).
 *
 * A noisy rule can sit over target and still get no correlation-threshold
 * recommendation, because the live pipeline would discard the raise. Leaving that
 * silent is the exact failure mode the backend fix exists to end, so the reason is
 * always shown next to the rule. The backend's own `correlation_n_inert_detail` is
 * engineering text ("configured mode=EVERY ...") and is never rendered.
 */
export const INERT_REASONS: Record<string, InertNote> = {
  alerts_role_every_override: {
    label: 'Alerts feed sends every alert',
    detail:
      'This rule reads an alerts feed, which sends every alert to triage, so raising its threshold would change nothing.',
  },
  correlation_mode_every: {
    label: 'Fires on every event',
    detail: 'This rule fires on every event, so raising its threshold would change nothing.',
  },
  inline_rule_definition_correlation: {
    label: 'Correlation set on the rule',
    detail:
      'This rule sets its own correlation, so raising the shared threshold would change nothing. Change the rule instead.',
  },
};

/** The sentence for a reason code this Console does not know yet. */
export const INERT_FALLBACK_DETAIL =
  'Raising this rule\u2019s threshold would not take effect in the pipeline, so no change is proposed.';

export interface InertNote {
  label: string;
  detail: string;
}

/**
 * The rule's inertness note, or null when a correlation-threshold raise would work
 * normally. A code a newer backend adds and this Console does not know yet keeps its
 * signal: its name (humanised) with the fallback sentence, never the raw detail.
 */
export function inertNote(rule: RuleNoise): InertNote | null {
  if (!rule.correlation_n_inert) return null;
  const code = (rule.correlation_n_inert_reason ?? '').trim();
  return (
    INERT_REASONS[code] ?? {
      label: code ? humanizeToken(code) : 'Threshold change would not take effect',
      detail: INERT_FALLBACK_DETAIL,
    }
  );
}

function RuleStateBadge({ state }: { state: RuleState }) {
  if (state === 'attention') {
    return (
      <Badge variant="high">
        <AlertTriangle className="size-3" aria-hidden />
        Needs attention
      </Badge>
    );
  }
  if (state === 'collecting') {
    return (
      <Badge variant="secondary">
        <Clock3 className="size-3" aria-hidden />
        Collecting
      </Badge>
    );
  }
  return (
    <Badge variant="success">
      <ShieldCheck className="size-3" aria-hidden />
      Within target
    </Badge>
  );
}

interface RuleExplanation {
  heading: string;
  lead: string;
  support: string;
}

interface RecommendationExplanation {
  title: string;
  instruction: string;
  effect: string;
  safety: string;
}

function analystCaseLabel(count: number): string {
  return `${fmtNumber(count)} analyst-confirmed closed ${count === 1 ? 'case' : 'cases'}`;
}

function percentagePointLabel(rate: number): string {
  const rounded = Math.round(Math.abs(rate) * 1_000) / 10;
  return `${rounded.toLocaleString()} percentage ${rounded === 1 ? 'point' : 'points'}`;
}

function explainRuleState(
  rule: RuleNoise,
  minSamples: number,
  target: number,
): RuleExplanation {
  const state = ruleState(rule, minSamples);
  const observed = observedFpRate(rule.total, rule.fp);

  if (state === 'attention') {
    const gap = Math.max(0, rule.fp_rate - target);
    return {
      heading: 'Why this rule needs attention',
      lead:
        `${analystCaseLabel(rule.total)} meet the ${fmtNumber(minSamples)}-case evidence minimum. ` +
        `The conservative false-positive estimate is ${fmtPercent(rule.fp_rate)}, ` +
        `${percentagePointLabel(gap)} above the ${fmtPercent(target)} policy target.`,
      support:
        `Observed false-positive ratio: ${fmtPercent(observed)} ` +
        `(${fmtNumber(rule.fp)} marked false positive or benign).`,
    };
  }

  if (state === 'collecting') {
    const remaining = Math.max(0, minSamples - rule.total);
    return {
      heading: 'Why this rule is still collecting evidence',
      lead:
        `${fmtNumber(rule.total)} of ${fmtNumber(minSamples)} analyst-confirmed closed cases ` +
        `have been collected. ${fmtNumber(remaining)} more ${remaining === 1 ? 'is' : 'are'} ` +
        'required before tuning can recommend a change.',
      support:
        `Current observed ratio ${fmtPercent(observed)} and conservative estimate ` +
        `${fmtPercent(rule.fp_rate)} are context only until the evidence minimum is met.`,
    };
  }

  return {
    heading: 'Why this rule is within target',
    lead:
      `The conservative false-positive estimate is ${fmtPercent(rule.fp_rate)}, at or below ` +
      `the ${fmtPercent(target)} policy target across ${analystCaseLabel(rule.total)}.`,
    support: 'No tuning action is indicated by the current evidence.',
  };
}

function explainRecommendation(
  recommendation: TuningRecommendation,
  shadowEvalEnabled: boolean,
): RecommendationExplanation {
  const before = tuneValue(recommendation.before);
  const after = tuneValue(recommendation.after);

  let title = 'Review the proposed tuning change';
  let instruction = `Change ${before} to ${after}.`;
  let effect = 'This changes which future candidates enter automatic investigation.';

  if (recommendation.kind === 'correlation_n') {
    title = 'Raise the correlation threshold';
    instruction = `Raise the threshold from ${before} to ${after}.`;
    effect =
      `Future threshold-mode clusters will require ${after} matching members before ` +
      'automatic investigation. Source events remain available.';
  } else if (recommendation.kind === 'severity_floor') {
    title = 'Raise the minimum forwarded severity';
    instruction = `Raise the selected feed’s OCSF severity floor from ${before} to ${after}.`;
    effect =
      'Lower-severity candidates remain recorded but will no longer auto-forward from that feed.';
  } else if (recommendation.kind === 'suppression') {
    title = 'Review a suppression proposal';
    instruction = 'Draft this suppression for a human decision in Approvals.';
    effect = 'Nothing is suppressed from this page.';
  }

  let safety = shadowEvalEnabled
    ? 'Eligible after retrospective replay. Evidence and safeguards are recomputed before any write.'
    : 'Eligible under the current policy. Retrospective replay is disabled and the evidence is recomputed before any write.';

  if (recommendation.reason === 'suppression_drop') {
    safety = 'Human approval is mandatory; suppression is never auto-applied.';
  } else if (recommendation.shadow_blocked) {
    safety =
      'Retrospective replay could not prove this change safe. It requires a human decision in Approvals.';
  } else if (recommendation.reason === 'policy_requires_approval') {
    safety =
      'Independent analyst evidence supports this bounded change, but review-first policy requires an explicit approval.';
  } else if (recommendation.reason === 'insufficient_analyst_evidence') {
    safety =
      'Model verdicts and automatic dispositions are excluded. More analyst-confirmed outcomes are required.';
  }

  return { title, instruction, effect, safety };
}

function explainNoRecommendation(
  state: RuleState,
  rule: RuleNoise,
  minSamples: number,
): RecommendationExplanation {
  if (state === 'collecting') {
    const remaining = Math.max(0, minSamples - rule.total);
    return {
      title: 'Keep collecting feedback',
      instruction: `${fmtNumber(remaining)} more analyst-confirmed closed ${remaining === 1 ? 'case is' : 'cases are'} needed.`,
      effect: 'No threshold change is proposed before the evidence minimum is met.',
      safety: 'The rule remains unchanged.',
    };
  }

  if (state === 'within') {
    return {
      title: 'No change recommended',
      instruction: 'The rule is operating within the configured false-positive target.',
      effect: 'Continue monitoring new verdict feedback.',
      safety: 'The rule remains unchanged.',
    };
  }

  const inert = inertNote(rule);
  if (inert) {
    return {
      title: 'Correlation threshold cannot help this rule',
      // The reason-code sentence: exactly WHY the raise would be discarded.
      instruction: inert.detail,
      effect:
        'No correlation threshold change is proposed. A raise here would be written to ' +
        'configuration the live pipeline never reads for this rule.',
      safety: 'The rule remains unchanged. Adjust the feed or the rule’s correlation instead.',
    };
  }

  return {
    title: 'Review the rule configuration',
    instruction: 'This rule exceeds policy, but no bounded tuning target is currently available.',
    effect: 'Review its correlation and feed configuration before making a manual change.',
    safety: 'No automatic change is available from this view.',
  };
}

export interface TuningProps {
  onNavigate?: Navigate;
}

export default function Tuning({ onNavigate }: TuningProps) {
  return (
    <ProtectedRoute resource="automation" action="read">
      <PageContainer variant="wide">
        <TuningInner onNavigate={onNavigate} />
      </PageContainer>
    </ProtectedRoute>
  );
}

/**
 * The page body. Its rule links (the inspector header and the ledger) share one rule sheet
 * that lives with the page (Round 14, SPEC §4.6.5), so a reload that drops the inspected
 * rule or re-renders the ledger never closes the sheet being read.
 */
export function TuningInner(props: TuningProps) {
  return (
    <RuleSheetHost>
      <TuningBody {...props} />
    </RuleSheetHost>
  );
}

function TuningBody({ onNavigate }: TuningProps) {
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const canManage = useCan('automation', 'manage');
  const hasWideRuleInspector = useMediaQuery('(min-width: 1536px)');

  const [data, setData] = React.useState<TuningRecommendationsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadedOnce, setLoadedOnce] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [busyKeys, setBusyKeys] = React.useState<Set<string>>(() => new Set());
  const busyKeysRef = React.useRef<Set<string>>(new Set());
  const [selectedRuleId, setSelectedRuleId] = React.useState<string | null>(null);
  const lastInspectorRuleRef = React.useRef<string | null>(null);
  const [lastRollback, setLastRollback] = React.useState<{
    ruleId: string;
    recordId: string;
  } | null>(null);
  const [ruleQuery, setRuleQuery] = React.useState('');
  const [ruleFilter, setRuleFilter] = React.useState<RuleFilter>('all');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(10);

  const [saved, setSaved] = React.useState<TuningConfig>(DEFAULT_TUNING_CONFIG);
  const [draft, setDraft] = React.useState<TuningConfig>(DEFAULT_TUNING_CONFIG);
  const [savingCfg, setSavingCfg] = React.useState(false);
  const [effectivenessRefreshKey, setEffectivenessRefreshKey] = React.useState(0);
  const [schedulerHealth, setSchedulerHealth] = React.useState<SchedulerHealthResponse | null>(null);
  const [telemetryRecommendations, setTelemetryRecommendations] =
    React.useState<TelemetryRecommendationsResponse | null>(null);
  const [workspaceTab, setWorkspaceTab] = React.useState<
    'operations' | 'outcomes' | 'policy'
  >('operations');

  const dirty = React.useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );
  useUnsavedChanges(dirty, canManage);
  const draftRef = React.useRef(draft);
  const savedRef = React.useRef(saved);
  React.useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  React.useEffect(() => {
    savedRef.current = saved;
  }, [saved]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [recommendations, config] = await Promise.all([
        tuningApi.recommendations(),
        tuningApi.getConfig(),
      ]);
      setData(recommendations);
      const next = { ...DEFAULT_TUNING_CONFIG, ...(config.config ?? {}) };
      setSaved(next);
      const wasDirty =
        JSON.stringify(draftRef.current) !== JSON.stringify(savedRef.current);
      if (!wasDirty) setDraft(next);
      setLoadedOnce(true);
      const [healthResult, telemetryResult] = await Promise.allSettled([
        tuningApi.schedulerHealth?.() ?? Promise.resolve(null),
        tuningApi.sourceRecommendations?.() ?? Promise.resolve(null),
      ]);
      setSchedulerHealth(
        healthResult.status === 'fulfilled' ? healthResult.value : null,
      );
      setTelemetryRecommendations(
        telemetryResult.status === 'fulfilled' ? telemetryResult.value : null,
      );
    } catch (nextError) {
      setError(nextError);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const refreshPage = React.useCallback(() => {
    setEffectivenessRefreshKey((key) => key + 1);
    void load();
  }, [load]);

  const saveConfig = React.useCallback(async () => {
    setSavingCfg(true);
    try {
      const result = await tuningApi.putConfig(draft);
      const next = { ...DEFAULT_TUNING_CONFIG, ...(result.config ?? draft) };
      setSaved(next);
      setDraft(next);
      toast.success('Tuning policy saved.');
    } catch (nextError) {
      toast.error(errorMessage(nextError, 'Could not save the tuning policy.'));
    } finally {
      setSavingCfg(false);
    }
  }, [draft]);

  const applyRule = React.useCallback(
    async (ruleId: string) => {
      const key = `rule:${ruleId}`;
      if (busyKeysRef.current.has(key)) return;
      busyKeysRef.current.add(key);
      setBusyKeys((current) => new Set(current).add(key));
      try {
        const result = await tuningApi.apply(ruleId);
        const applied = result.applied?.length ?? 0;
        const queued = result.queued_proposals?.length ?? 0;
        const blocked = result.shadow_blocked?.length ?? 0;
        const outcomes = [
          applied ? `${applied} applied` : null,
          queued ? `${queued} sent to Approvals` : null,
          blocked ? `${blocked} shadow-blocked` : null,
        ].filter(Boolean);
        if (outcomes.length) {
          const message = `${ruleId}: ${outcomes.join(' · ')}.`;
          if (applied) toast.success(message);
          else if (blocked) toast.warning(message);
          else toast.info(message);
        } else {
          toast.info(`No current change was applied for ${ruleId}.`);
        }
        await load();
      } catch (nextError) {
        toast.error(errorMessage(nextError, 'Could not process this rule.'));
      } finally {
        busyKeysRef.current.delete(key);
        setBusyKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [load],
  );

  const rollbackRule = React.useCallback(
    async (ruleId: string) => {
      const key = `rule:${ruleId}`;
      if (busyKeysRef.current.has(key)) return;
      busyKeysRef.current.add(key);
      setBusyKeys((current) => new Set(current).add(key));
      try {
        const result = await tuningApi.rollback(ruleId);
        setLastRollback({
          ruleId: result.rule_id ?? ruleId,
          recordId: result.record_id ?? '',
        });
        toast.success(`Rolled back ${ruleId}.`);
        await load();
      } catch (nextError) {
        toast.error(errorMessage(nextError, 'Could not roll back this change.'));
      } finally {
        busyKeysRef.current.delete(key);
        setBusyKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [load],
  );

  const recommendations = React.useMemo(() => data?.recommendations ?? [], [data]);
  const ruleNoise = React.useMemo(() => data?.rule_noise ?? [], [data]);
  const ledger = React.useMemo(() => data?.applied ?? [], [data]);
  const recommendationsByRule = React.useMemo(() => {
    const grouped = new Map<string, TuningRecommendation[]>();
    for (const recommendation of recommendations) {
      const current = grouped.get(recommendation.rule_id) ?? [];
      current.push(recommendation);
      grouped.set(recommendation.rule_id, current);
    }
    return grouped;
  }, [recommendations]);

  // A bounded recommendation can survive longer than the aggregate feedback row that
  // originally produced it. Keep it visible in the one review workspace instead of
  // resurrecting a second recommendations queue. The recommendation carries the same
  // independently-confirmed counters needed for an honest, synthetic evidence row.
  const reviewRules = React.useMemo(() => {
    const rows = new Map(ruleNoise.map((rule) => [rule.rule_id, rule]));
    for (const [ruleId, ruleRecommendations] of recommendationsByRule) {
      if (rows.has(ruleId) || !ruleRecommendations.length) continue;
      const recommendation = ruleRecommendations[0];
      const analystSamples =
        recommendation.analyst_samples ?? recommendation.samples ?? 0;
      const falsePositives =
        recommendation.confirmed_false_positives ??
        Math.max(0, Math.round(recommendation.fp_rate * analystSamples));
      const truePositives =
        recommendation.confirmed_true_positives ??
        Math.max(0, analystSamples - falsePositives);
      rows.set(ruleId, {
        rule_id: ruleId,
        observed: recommendation.observed_cases ?? analystSamples,
        total: analystSamples,
        analyst_samples: analystSamples,
        unconfirmed: recommendation.unconfirmed_cases ?? 0,
        fp: falsePositives,
        tp: truePositives,
        fp_rate: recommendation.fp_rate,
        volume_ewma: null,
        over_target: analystSamples >= (data?.min_samples ?? 0),
      });
    }
    return Array.from(rows.values());
  }, [data?.min_samples, recommendationsByRule, ruleNoise]);

  const lastTunedByRule = React.useMemo(() => {
    const latest = new Map<string, string>();
    for (const row of ledger) {
      const when = row.applied_at ?? '';
      if (when && when > (latest.get(row.rule_id) ?? '')) latest.set(row.rule_id, when);
    }
    return latest;
  }, [ledger]);

  const newestActiveRowByRule = React.useMemo(() => {
    const newest = new Map<string, string>();
    const newestAt = new Map<string, string>();
    for (const row of ledger) {
      if (!isLedgerRowActive(row)) continue;
      const when = row.applied_at ?? '';
      if (!newest.has(row.rule_id) || when > (newestAt.get(row.rule_id) ?? '')) {
        newest.set(row.rule_id, row.id);
        newestAt.set(row.rule_id, when);
      }
    }
    return newest;
  }, [ledger]);

  const outcomeChanges = React.useMemo(
    () =>
      ledger.map((row) => ({
        id: row.id,
        at: row.applied_at,
        label: row.rule_id,
        detail: `${KIND_LABELS[row.target] ?? humanizeToken(row.target)} ${tuneValue(row.before)} → ${tuneValue(row.after)}`,
        state: isLedgerRowActive(row) ? ('active' as const) : ('rolled_back' as const),
      })),
    [ledger],
  );

  const collecting = reviewRules.filter((rule) => ruleState(rule, data?.min_samples ?? 0) === 'collecting').length;
  const withinTarget = reviewRules.filter((rule) => ruleState(rule, data?.min_samples ?? 0) === 'within').length;
  const needsAttention = reviewRules.filter((rule) => ruleState(rule, data?.min_samples ?? 0) === 'attention').length;
  const approvalChangeCount = saved.auto_apply_confirmed
    ? recommendations.filter((row) => !row.auto_apply).length
    : recommendations.length;

  const filteredRules = React.useMemo(() => {
    const query = ruleQuery.trim().toLowerCase();
    return reviewRules
      .filter((rule) => {
        const matchesQuery = !query || rule.rule_id.toLowerCase().includes(query);
        const state = ruleState(rule, data?.min_samples ?? 0);
        return matchesQuery && (ruleFilter === 'all' || state === ruleFilter);
      })
      .sort((left, right) => {
        const rank: Record<RuleState, number> = {
          attention: 0,
          collecting: 1,
          within: 2,
        };
        const stateDelta =
          rank[ruleState(left, data?.min_samples ?? 0)] -
          rank[ruleState(right, data?.min_samples ?? 0)];
        if (stateDelta !== 0) return stateDelta;
        return left.rule_id.localeCompare(right.rule_id);
      });
  }, [data?.min_samples, reviewRules, ruleFilter, ruleQuery]);

  React.useEffect(() => {
    setPage(1);
  }, [ruleFilter, ruleQuery]);

  const pageCount = Math.max(1, Math.ceil(filteredRules.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = React.useMemo(
    () =>
      filteredRules.slice(
        (currentPage - 1) * pageSize,
        currentPage * pageSize,
      ),
    [currentPage, filteredRules, pageSize],
  );

  React.useEffect(() => {
    if (selectedRuleId && !pageRows.some((rule) => rule.rule_id === selectedRuleId)) {
      setSelectedRuleId(null);
    }
  }, [pageRows, selectedRuleId]);

  const selectedRule = selectedRuleId
    ? reviewRules.find((rule) => rule.rule_id === selectedRuleId) ?? null
    : null;

  const restoreInspectorTriggerFocus = React.useCallback(() => {
    const ruleId = lastInspectorRuleRef.current;
    if (!ruleId) return;
    window.requestAnimationFrame(() => {
      document.getElementById(ruleTriggerId(ruleId))?.focus();
    });
  }, []);

  const closeRuleInspector = React.useCallback(() => {
    setSelectedRuleId(null);
    restoreInspectorTriggerFocus();
  }, [restoreInspectorTriggerFocus]);

  const ledgerColumns = React.useMemo<DataTableColumn<TuningLedgerRow>[]>(
    () => [
      {
        id: 'rule',
        header: 'Rule / knob',
        lockVisible: true,
        className: 'min-w-[14rem] max-w-[22rem]',
        cell: (row) => (
          <div className="min-w-0 space-y-0.5">
            {/* Round 14 (SPEC §4.6.5): the rule opens its picture, the rule sheet. */}
            <RuleLink
              rule={row.rule_id}
              origin="Auto-tuning"
              title={row.rule_id}
              className="block max-w-full truncate text-xs text-foreground"
            />
            <span className="text-xs text-muted-foreground">
              {KIND_LABELS[row.target] ?? humanizeToken(row.target)}
            </span>
          </div>
        ),
      },
      {
        id: 'change',
        header: 'Change',
        cell: (row) => (
          <div className="flex flex-wrap items-center gap-2">
            <ChangeArrow before={row.before} after={row.after} />
            {tuneDelta(row.before, row.after) ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {tuneDelta(row.before, row.after)}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'reason',
        header: 'Reason',
        cell: (row) => (
          <span className="line-clamp-2 text-xs text-muted-foreground">
            {row.rationale || row.reason || DASH}
          </span>
        ),
      },
      {
        id: 'applied',
        header: 'Applied / result',
        cell: (row) => (
          <div className="space-y-1">
            <span className="block text-xs tabular-nums text-muted-foreground">
              {humanizeAge(row.applied_at ?? null)}
            </span>
            {isLedgerRowActive(row) ? (
              <Badge variant="info">Active</Badge>
            ) : (
              <Badge variant="secondary">Rolled back</Badge>
            )}
          </div>
        ),
      },
      {
        id: 'action',
        header: '',
        align: 'right',
        cell: (row) =>
          isLedgerRowActive(row) && newestActiveRowByRule.get(row.rule_id) === row.id ? (
            <Can resource="automation" action="manage">
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Rollback latest change for ${row.rule_id}`}
                disabled={busyKeys.has(`rule:${row.rule_id}`)}
                onClick={() => rollbackRule(row.rule_id)}
              >
                {busyKeys.has(`rule:${row.rule_id}`) ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Undo2 className="mr-1 size-3.5" aria-hidden />
                )}
                Rollback
              </Button>
            </Can>
          ) : null,
      },
    ],
    [busyKeys, newestActiveRowByRule, rollbackRule],
  );

  const kpis: Array<{ label: string; value: number; sub: string }> = [
    {
      label: 'Needs attention',
      value: needsAttention,
      sub: `${fmtNumber(recommendations.length)} bounded ${recommendations.length === 1 ? 'change' : 'changes'}`,
    },
    {
      label: 'Collecting evidence',
      value: collecting,
      sub: `Below ${fmtNumber(data?.min_samples ?? 0)} samples`,
    },
    {
      label: 'Within target',
      value: withinTarget,
      sub: 'Enough evidence, no change',
    },
  ];

  // The page's modules are direct children of the default export's PageContainer, which
  // owns the rhythm (header to first module, one panel gutter between modules).
  return (
    <>
      <PageHeader
        title="Auto-tuning"
        help={PAGE_HELP}
        controls={<RefreshButton onClick={refreshPage} refreshing={loading} label="Refresh auto-tuning" display="icon" />}
        actions={data ? <OperatingPolicyLine data={data} /> : undefined}
      />

      <LoadingBar
        active={loading && Boolean(data)}
        size="sm"
        label="Refreshing auto-tuning"
      />

      {loading && !data ? (
        <LoadingState
          label="Loading auto-tuning"
          description="Reading rule feedback, bounded recommendations, and policy state."
          layout="page"
          shape="page"
        />
      ) : null}

      {error && !data ? (
        <LoadError
          error={error}
          title="Could not load tuning data"
          fallback="Could not load tuning data."
          onRetry={() => void load()}
        />
      ) : null}

      {data ? (
        <>
          {error ? (
            <LoadError
              error={error}
              title="Refresh failed"
              fallback="The previous tuning evidence remains visible."
              onRetry={() => void load()}
            />
          ) : null}

          <Tabs
            value={workspaceTab}
            onValueChange={(value) =>
              setWorkspaceTab(value as 'operations' | 'outcomes' | 'policy')
            }
          >
            <TabsList
              variant="underline"
              aria-label="Auto-tuning workspace"
              data-testid="tuning-workspace-tabs"
            >
              <TabsTrigger value="operations">Operations</TabsTrigger>
              <Can resource="metrics" action="view">
                <TabsTrigger value="outcomes">Outcomes</TabsTrigger>
              </Can>
              <TabsTrigger value="policy">Policy &amp; history</TabsTrigger>
            </TabsList>

            <TabsContent value="operations" className={TAB_BODY}>
              <KpiStrip label="Health summary" density="compact" data-testid="tuning-health-strip">
                {kpis.map((kpi) => (
                  <KpiTile key={kpi.label} label={kpi.label} value={fmtNumber(kpi.value)} context={kpi.sub} />
                ))}
              </KpiStrip>

              <Panel
                title="Rule review"
                count={`${fmtNumber(reviewRules.length)} monitored ${reviewRules.length === 1 ? 'rule' : 'rules'}`}
                aside={
                  <HelpTip
                    label="How rules are ordered"
                    text="Rules that need attention come first, then rules still collecting evidence, then rules within target. Select one to see why it is in that state, the next step, its expected effect and the safety replay. The conservative Wilson estimate is the policy gate; the observed rate is context."
                  />
                }
                className="space-y-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="relative min-w-0 sm:w-64">
                      <Search
                        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden
                      />
                      <Input
                        value={ruleQuery}
                        onChange={(event) => setRuleQuery(event.target.value)}
                        placeholder="Search rules"
                        aria-label="Search monitored rules"
                        className="pl-9"
                      />
                    </div>
                    <SegmentedControl
                      aria-label="Filter rules by state"
                      size="sm"
                      value={ruleFilter}
                      onValueChange={setRuleFilter}
                      options={RULE_FILTERS}
                      className="max-w-full overflow-x-auto"
                    />
                </div>

                {approvalChangeCount ? (
                  <section
                    className="flex flex-col gap-2 border-l-2 border-warning/50 py-1 pl-4 sm:flex-row sm:items-center sm:justify-between"
                    aria-label="Approval path summary"
                  >
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {fmtNumber(approvalChangeCount)} proposed {approvalChangeCount === 1 ? 'change requires' : 'changes require'} human approval under the current policy. Select a rule to review it before sending.
                    </p>
                    <Can
                      resource="proposals"
                      action="read"
                      fallback={<span className="text-xs text-muted-foreground">Requires Approvals access</span>}
                    >
                      <Button size="sm" variant="ghost" onClick={() => navigate('approvals')}>
                        Open Approvals
                        <ArrowRight className="ml-1 size-3.5" aria-hidden />
                      </Button>
                    </Can>
                  </section>
                ) : null}

                <div
                  className={cn(
                    'grid min-w-0 gap-5',
                    selectedRule && '2xl:grid-cols-[minmax(0,1fr)_24rem]',
                  )}
                >
                  <RuleList
                    rules={pageRows}
                    total={filteredRules.length}
                    minSamples={data.min_samples}
                    target={data.fp_rate_target}
                    selectedRuleId={selectedRuleId}
                    recommendationsByRule={recommendationsByRule}
                    shadowEvalEnabled={saved.shadow_eval}
                    lastTunedByRule={lastTunedByRule}
                    onSelect={(ruleId) => {
                      lastInspectorRuleRef.current = ruleId;
                      setSelectedRuleId((current) => (current === ruleId ? null : ruleId));
                    }}
                    emptyQuery={Boolean(ruleQuery.trim()) || ruleFilter !== 'all'}
                    page={currentPage}
                    pageCount={pageCount}
                    pageSize={pageSize}
                    onPageChange={setPage}
                    onPageSizeChange={(next) => {
                      setPageSize(next);
                      setPage(1);
                    }}
                  />

                  {selectedRule && hasWideRuleInspector ? (
                    <RuleDetailPanel
                      id="tuning-rule-detail"
                      rule={selectedRule}
                      recommendations={recommendationsByRule.get(selectedRule.rule_id) ?? []}
                      history={ledger.filter((row) => row.rule_id === selectedRule.rule_id)}
                      minSamples={data.min_samples}
                      target={data.fp_rate_target}
                      shadowEvalEnabled={saved.shadow_eval}
                      autoApplyConfirmed={saved.auto_apply_confirmed}
                      processing={busyKeys.has(`rule:${selectedRule.rule_id}`)}
                      onApplyRule={(ruleId) => void applyRule(ruleId)}
                      onOpenApprovals={() => navigate('approvals')}
                      onClose={closeRuleInspector}
                    />
                  ) : null}
                </div>

                <Sheet
                  open={Boolean(selectedRule && !hasWideRuleInspector)}
                  onOpenChange={(open) => !open && setSelectedRuleId(null)}
                >
                  <SheetContent
                    id="tuning-rule-detail"
                    side="right"
                    size="default"
                    className="gap-0 p-0"
                    aria-describedby={undefined}
                    onOpenAutoFocus={(event) => {
                      event.preventDefault();
                      (event.currentTarget as HTMLElement)
                        .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
                        ?.focus();
                    }}
                    onCloseAutoFocus={(event) => {
                      event.preventDefault();
                      restoreInspectorTriggerFocus();
                    }}
                  >
                    <SheetHeader className="sr-only">
                      <SheetTitle>
                        {selectedRule ? `Rule evidence for ${selectedRule.rule_id}` : 'Rule evidence'}
                      </SheetTitle>
                      <SheetDescription>
                        Evidence, recommendations, thresholds, and recent tuning history.
                      </SheetDescription>
                    </SheetHeader>
                    {selectedRule ? (
                      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
                        <RuleDetailPanel
                          variant="sheet"
                          rule={selectedRule}
                          recommendations={recommendationsByRule.get(selectedRule.rule_id) ?? []}
                          history={ledger.filter((row) => row.rule_id === selectedRule.rule_id)}
                          minSamples={data.min_samples}
                          target={data.fp_rate_target}
                          shadowEvalEnabled={saved.shadow_eval}
                          autoApplyConfirmed={saved.auto_apply_confirmed}
                          processing={busyKeys.has(`rule:${selectedRule.rule_id}`)}
                          onApplyRule={(ruleId) => void applyRule(ruleId)}
                          onOpenApprovals={() => navigate('approvals')}
                          onClose={closeRuleInspector}
                        />
                      </div>
                    ) : null}
                  </SheetContent>
                </Sheet>
              </Panel>

              {lastRollback ? (
                <section
                  className="border-l-2 border-success/50 py-1 pl-4"
                  aria-label="Rollback confirmation"
                >
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-sm font-semibold text-success-text">
                        Rollback successful
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Reversed the latest change for{' '}
                        <InlineCode>{lastRollback.ruleId}</InlineCode>
                        {lastRollback.recordId ? (
                          <>
                            {' '}(<InlineCode>{lastRollback.recordId}</InlineCode>)
                          </>
                        ) : null}
                        .
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Dismiss rollback confirmation"
                      onClick={() => setLastRollback(null)}
                    >
                      <X className="size-4" aria-hidden />
                    </Button>
                  </div>
                </section>
              ) : null}
            </TabsContent>

            <Can resource="metrics" action="view">
              <TabsContent value="outcomes" className={TAB_BODY}>
                <>
                  <AgentEffectivenessSummary
                    refreshKey={effectivenessRefreshKey}
                    changes={outcomeChanges}
                    onOpenFull={() => navigate('metrics', { tab: 'effectiveness' })}
                  />
                  <TelemetryOpportunities data={telemetryRecommendations} />
                </>
              </TabsContent>
            </Can>

            <TabsContent value="policy" className={TAB_BODY}>
              {loadedOnce ? (
                <TuningPolicy
                  draft={draft}
                  canManage={canManage}
                  onChange={setDraft}
                />
              ) : null}

              <SchedulerHealth health={schedulerHealth} />

              <Panel
                title="Audit history"
                padding="none"
                aside={
                  <HelpTip
                    label="About the audit history"
                    text="Applied changes are append-only. Rollback is offered only for the newest active change the API can reverse for a rule."
                  />
                }
              >
                {ledger.length ? (
                  <DataTable
                    columns={ledgerColumns}
                    rows={ledger}
                    getRowId={(row) => row.id}
                    density="compact"
                    surface="panel"
                    ariaLabel="Applied tuning changes"
                  />
                ) : (
                  <p className="px-4 pb-4 text-sm text-muted-foreground xl:px-5 xl:pb-5 3xl:px-6 3xl:pb-6">
                    No applied tuning changes were returned for this view.
                  </p>
                )}
              </Panel>

              <Can resource="automation" action="manage">
                <StickySaveBar
                  visible={dirty}
                  busy={savingCfg}
                  message="Unsaved tuning-policy changes."
                  onSave={() => void saveConfig()}
                  onDiscard={() => setDraft(saved)}
                />
              </Can>
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </>
  );
}

/**
 * The operating policy as one muted line in the header (no third band between the
 * header and the tabs, [uib] TU4): "Active · Approval-first · Nightly · 99 closed cases".
 * Each fact keeps its name for assistive technology.
 */
function OperatingPolicyLine({ data }: { data: TuningRecommendationsResponse }) {
  const facts: Array<[string, React.ReactNode]> = [
    ['Policy', data.enabled ? 'Active' : 'Paused'],
    ['Writes', data.auto_apply_confirmed ? 'Confirmed auto-apply' : 'Approval-first'],
    ['Cadence', humanizeToken(data.cadence)],
    [
      'Evidence',
      <>
        <span className="tabular-nums">{fmtNumber(data.window_cases)}</span> closed{' '}
        {data.window_cases === 1 ? 'case' : 'cases'}
      </>,
    ],
  ];
  return (
    <dl
      aria-label="Operating policy"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground"
      data-testid="tuning-operating-policy"
    >
      {facts.map(([term, value], index) => (
        <div key={term} className="flex items-center gap-1.5">
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          <dt className="sr-only">{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PolicySignalBar({
  value,
  target,
  state,
}: {
  value: number;
  target: number;
  state: RuleState;
}) {
  const boundedValue = Math.max(0, Math.min(1, value));
  const boundedTarget = Math.max(0, Math.min(1, target));
  return (
    <div className="relative h-1.5 overflow-hidden bg-muted" aria-hidden>
      <span
        className={cn(
          'absolute inset-y-0 left-0',
          state === 'attention'
            ? 'bg-high'
            : state === 'within'
              ? 'bg-success'
              : 'bg-info',
        )}
        style={{ width: `${boundedValue * 100}%` }}
      />
      <span
        className="absolute inset-y-[-2px] w-px bg-foreground/70"
        style={{ left: `${boundedTarget * 100}%` }}
      />
    </div>
  );
}

function RuleList({
  rules,
  total,
  minSamples,
  target,
  selectedRuleId,
  recommendationsByRule,
  shadowEvalEnabled,
  lastTunedByRule,
  onSelect,
  emptyQuery,
  page,
  pageCount,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  rules: RuleNoise[];
  total: number;
  minSamples: number;
  target: number;
  selectedRuleId: string | null;
  recommendationsByRule: Map<string, TuningRecommendation[]>;
  shadowEvalEnabled: boolean;
  lastTunedByRule: Map<string, string>;
  onSelect: (ruleId: string) => void;
  emptyQuery: boolean;
  page: number;
  pageCount: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  if (!rules.length && total === 0) {
    return (
      <div className="border-t border-border/70">
        <EmptyState
          icon={Radar}
          title={emptyQuery ? 'No matching rules' : 'No rules monitored yet'}
          description={
            emptyQuery
              ? 'Try a different search or state filter.'
              : 'Rules appear after closed-case feedback has been accumulated.'
          }
          compact
        />
      </div>
    );
  }

  return (
    <div className="min-w-0 border-t border-border/70" aria-label="Monitored rules">
      <div className="hidden grid-cols-[minmax(13rem,0.9fr)_minmax(15rem,1fr)_minmax(15rem,0.85fr)_auto] gap-5 border-b border-border/70 px-3 py-2 text-xs font-medium text-muted-foreground xl:grid" aria-hidden="true">
        <span>Rule and state</span>
        <span>Policy evidence</span>
        <span>Next step</span>
        <span className="sr-only">Open detail</span>
      </div>
      <div role="list" className="divide-y divide-border/70">
        {rules.map((rule) => {
          const state = ruleState(rule, minSamples);
          const recs = recommendationsByRule.get(rule.rule_id) ?? [];
          const explanation = explainRuleState(rule, minSamples, target);
          const action = recs.length
            ? explainRecommendation(recs[0], shadowEvalEnabled)
            : explainNoRecommendation(state, rule, minSamples);
          const observed = observedFpRate(rule.total, rule.fp);
          const rowInert = inertNote(rule);
          const actionLabel = recs.length > 1
            ? `${fmtNumber(recs.length)} bounded changes`
            : action.title;
          const selected = selectedRuleId === rule.rule_id;
          const descriptionId = `${ruleTriggerId(rule.rule_id)}-description`;
          return (
            <div key={rule.rule_id} role="listitem">
              <button
                id={ruleTriggerId(rule.rule_id)}
                type="button"
                aria-label={`Inspect rule ${rule.rule_id}`}
                aria-describedby={descriptionId}
                aria-expanded={selected}
                aria-controls={selected ? 'tuning-rule-detail' : undefined}
                onClick={() => onSelect(rule.rule_id)}
                className={cn(
                  'grid w-full min-w-0 gap-3 border-l-2 border-l-transparent px-3 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  'hover:bg-accent/20 xl:grid-cols-[minmax(13rem,0.9fr)_minmax(15rem,1fr)_minmax(15rem,0.85fr)_auto] xl:items-center xl:gap-5',
                  selected && 'border-l-primary/70 bg-accent/25',
                )}
              >
                <span id={descriptionId} className="sr-only">
                  {explanation.lead} {explanation.support} {action.title}. {action.instruction}
                  {rowInert ? ` A threshold change would not help: ${rowInert.detail}` : ''}
                </span>

                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="block min-w-0 flex-1 truncate font-mono text-xs font-semibold text-foreground"
                      title={rule.rule_id}
                    >
                      {rule.rule_id}
                    </span>
                    <RuleStateBadge state={state} />
                  </span>
                  {/* Tabular figures on the number only: on prose Inter's tabular hyphen
                      opens a gap ("analyst - confirmed", [uib] TU2). */}
                  <span className="mt-1 block text-xs text-muted-foreground">
                    <span className="tabular-nums">{fmtNumber(rule.total)}</span> analyst-confirmed cases
                    {lastTunedByRule.get(rule.rule_id)
                      ? ` · tuned ${humanizeAge(lastTunedByRule.get(rule.rule_id))}`
                      : ''}
                  </span>
                </span>

                <span className="min-w-0">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground xl:hidden">
                    Policy evidence
                  </span>
                  <span className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="font-semibold tabular-nums text-foreground">
                      {state === 'collecting'
                        ? `${fmtNumber(rule.total)} / ${fmtNumber(minSamples)} confirmed`
                        : `${fmtPercent(rule.fp_rate)} conservative`}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      target {fmtPercent(target)}
                    </span>
                  </span>
                  <span className="mt-2 block">
                    <PolicySignalBar value={rule.fp_rate} target={target} state={state} />
                  </span>
                  <span className="mt-1.5 block text-xs text-muted-foreground">
                    <span className="tabular-nums">{fmtPercent(observed)}</span> observed false-positive ratio
                  </span>
                </span>

                <span className="min-w-0">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground xl:hidden">
                    Next step
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {actionLabel}
                    </span>
                    {recs.length ? (
                      <Badge
                        variant={recs.every((rec) => rec.auto_apply) ? 'info' : 'warning'}
                      >
                        {recs.every((rec) => rec.auto_apply)
                          ? 'Safety check eligible'
                          : 'Approval required'}
                      </Badge>
                    ) : null}
                    {/* Why a noisy rule gets NO correlation_n recommendation. */}
                    {rowInert ? <Badge variant="secondary">Threshold change would not help</Badge> : null}
                  </span>
                  <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {action.instruction}
                  </span>
                </span>

                <span className="flex items-center justify-end self-center">
                  <ChevronRight
                    className={cn(
                      'size-4 shrink-0 text-muted-foreground transition-transform',
                      selected && 'rotate-90',
                    )}
                    aria-hidden
                  />
                </span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-3 border-t border-border/70 px-3 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span className="tabular-nums">
          {fmtNumber(total)} matching {total === 1 ? 'rule' : 'rules'} · Page {page} of{' '}
          {pageCount}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="tuning-page-size" className="text-xs text-muted-foreground">
            Rows
          </Label>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => onPageSizeChange(Number(value))}
          >
            <SelectTrigger id="tuning-page-size" className="h-8 w-[4.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 25, 50].map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            aria-label="Previous rules page"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label="Next rules page"
            disabled={page >= pageCount}
            onClick={() => onPageChange(Math.min(pageCount, page + 1))}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

function RuleDetailPanel({
  id,
  variant = 'aside',
  rule,
  recommendations,
  history,
  minSamples,
  target,
  shadowEvalEnabled,
  autoApplyConfirmed,
  processing,
  onApplyRule,
  onOpenApprovals,
  onClose,
}: {
  id?: string;
  variant?: 'aside' | 'sheet';
  rule: RuleNoise;
  recommendations: TuningRecommendation[];
  history: TuningLedgerRow[];
  minSamples: number;
  target: number;
  shadowEvalEnabled: boolean;
  autoApplyConfirmed: boolean;
  processing: boolean;
  onApplyRule: (ruleId: string) => void;
  onOpenApprovals: () => void;
  onClose: () => void;
}) {
  const state = ruleState(rule, minSamples);
  const Root = variant === 'aside' ? 'aside' : 'div';
  const explanation = explainRuleState(rule, minSamples, target);
  const inert = inertNote(rule);
  const actionExplanations = recommendations.length
    ? recommendations.map((recommendation) => ({
        recommendation,
        copy: explainRecommendation(recommendation, shadowEvalEnabled),
      }))
    : [{ recommendation: null, copy: explainNoRecommendation(state, rule, minSamples) }];
  const hasEligibleChange = recommendations.some((recommendation) => recommendation.auto_apply);
  const hasRestrictedChange = recommendations.some((recommendation) => !recommendation.auto_apply);
  const headlineStats = [
    { label: 'Analyst outcomes', value: fmtNumber(rule.total) },
    { label: 'Conservative estimate', value: fmtPercent(rule.fp_rate) },
    { label: 'Policy target', value: fmtPercent(target) },
  ];
  const technicalStats = [
    { label: 'Observed cases', value: fmtNumber(rule.observed ?? rule.total) },
    { label: 'Observed FP ratio', value: fmtPercent(observedFpRate(rule.total, rule.fp)) },
    { label: 'Unconfirmed', value: fmtNumber(rule.unconfirmed ?? 0) },
    {
      label: 'Recent average volume',
      value: rule.volume_ewma == null ? DASH : rule.volume_ewma.toFixed(1),
    },
  ];

  return (
    <Root
      id={id}
      className={cn(
        'min-w-0 space-y-5',
        variant === 'aside' &&
          'border-y border-border/70 py-4 xl:sticky xl:top-[calc(var(--header-h)+1rem)] xl:self-start xl:border-l xl:border-y-0 xl:py-1 xl:pl-5',
      )}
      aria-label={`Detail for rule ${rule.rule_id}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">
            Rule review
          </p>
          <p className="mt-1 break-all text-sm font-semibold text-foreground">
            <RuleLink rule={rule.rule_id} origin="Auto-tuning" />
          </p>
          <div className="mt-2">
            <RuleStateBadge state={state} />
          </div>
        </div>
        {variant === 'aside' ? (
          <Button size="sm" variant="ghost" aria-label="Close rule detail" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </Button>
        ) : null}
      </header>

      <section
        className={cn(
          'border-l-2 py-0.5 pl-4',
          state === 'attention'
            ? 'border-high/60'
            : state === 'collecting'
              ? 'border-info/60'
              : 'border-success/60',
        )}
        aria-labelledby="tuning-rule-why-heading"
      >
        <h3
          id="tuning-rule-why-heading"
          className="text-sm font-semibold text-foreground"
        >
          {explanation.heading}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-foreground">{explanation.lead}</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {explanation.support}
        </p>
      </section>

      {/* Why a noisy rule gets no correlation_n recommendation. Shown independently of
          the recommended action, because the rule can also carry a RE-TARGETED change
          (a severity floor) whose copy would otherwise hide the structural reason. */}
      {inert ? (
        <section className="space-y-1.5" aria-labelledby="tuning-rule-inert-heading">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              id="tuning-rule-inert-heading"
              className="text-sm font-semibold text-foreground"
            >
              A threshold change would not help
            </h3>
            <Badge variant="secondary">{inert.label}</Badge>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{inert.detail}</p>
        </section>
      ) : null}

      <section className="space-y-3" aria-labelledby="tuning-rule-action-heading">
        <h3
          id="tuning-rule-action-heading"
          className="text-sm font-semibold text-foreground"
        >
          Recommended action
        </h3>
        <ul className="divide-y divide-border/70 border-y border-border/70">
          {actionExplanations.map(({ recommendation, copy }, index) => (
            <li key={recommendation?.kind ?? `none-${index}`} className="space-y-4 py-4">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">{copy.title}</p>
                  {recommendation ? (
                    <Badge
                      variant={recommendation.auto_apply && autoApplyConfirmed ? 'info' : 'warning'}
                    >
                      {recommendation.auto_apply && autoApplyConfirmed
                        ? 'Can apply after safety check'
                        : 'Approval required'}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-foreground">
                  {copy.instruction}
                </p>
              </div>

              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Expected operational effect
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {copy.effect}
                </p>
              </div>

              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Safety replay
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {copy.safety}
                </p>
              </div>
            </li>
          ))}
        </ul>

        {hasEligibleChange || hasRestrictedChange ? (
          <Can resource="automation" action="manage">
            <Button
              size="sm"
              variant="outline"
              disabled={processing}
              onClick={() => onApplyRule(rule.rule_id)}
              aria-label={`Process all changes for ${rule.rule_id}`}
            >
              {processing ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden />
              ) : (
                <Play className="mr-1 size-3.5" aria-hidden />
              )}
              {hasEligibleChange && autoApplyConfirmed
                ? 'Apply after recheck'
                : 'Send to Approvals'}
            </Button>
          </Can>
        ) : null}
        {hasRestrictedChange ? (
          <Can
            resource="proposals"
            action="read"
            fallback={<span className="text-xs text-muted-foreground">Requires Approvals access</span>}
          >
            <Button size="sm" variant="ghost" onClick={onOpenApprovals}>
              Open Approvals
              <ArrowRight className="ml-1 size-3.5" aria-hidden />
            </Button>
          </Can>
        ) : null}
      </section>

      <section className="space-y-3" aria-labelledby="tuning-rule-measurements-heading">
        <div>
          <h3
            id="tuning-rule-measurements-heading"
            className="text-sm font-semibold text-foreground"
          >
            Supporting measurements
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Policy compares the conservative estimate after at least{' '}
            {fmtNumber(minSamples)} analyst-confirmed closed cases. The observed ratio is
            context, not the gate by itself.
          </p>
        </div>
        <PolicySignalBar value={rule.fp_rate} target={target} state={state} />
        <dl className="grid grid-cols-1 border-y border-border/70 sm:grid-cols-3">
          {headlineStats.map((stat, index) => (
            <div
              key={stat.label}
              className={cn(
                'py-2.5 sm:px-3',
                index > 0 && 'border-t border-border/70 sm:border-l sm:border-t-0',
                index === 0 && 'sm:pl-0',
              )}
            >
              <dt className="text-xs font-medium text-muted-foreground">
                {stat.label}
              </dt>
              <dd className="mt-1.5 text-sm font-semibold tabular-nums text-foreground">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">
            Technical context
          </summary>
          <dl className="mt-2 divide-y divide-border/60 border-y border-border/60">
            {technicalStats.map((stat) => (
              <div key={stat.label} className="flex items-center justify-between gap-4 py-2">
                <dt>{stat.label}</dt>
                <dd className="font-medium tabular-nums text-foreground">{stat.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 leading-relaxed">
            Recent average volume is an advisory EWMA over dated analyst-confirmed activity;
            it never controls a recommendation.
          </p>
        </details>
      </section>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">
          Recent history
        </h3>
        {history.length ? (
          <ul className="divide-y divide-border/70 border-y border-border/70">
            {history.slice(0, 5).map((row) => (
              <li key={row.id} className="space-y-1.5 py-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="tabular-nums text-muted-foreground">
                    {fmtUtc(row.applied_at ?? null)}
                  </span>
                  <Badge variant={isLedgerRowActive(row) ? 'info' : 'secondary'}>
                    {isLedgerRowActive(row) ? 'Active' : 'Rolled back'}
                  </Badge>
                </div>
                <ChangeArrow before={row.before} after={row.after} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No applied changes returned for this rule.</p>
        )}
      </div>
    </Root>
  );
}

function TelemetryOpportunities({
  data,
}: {
  data: TelemetryRecommendationsResponse | null;
}) {
  return (
    <Panel
      title="Telemetry opportunities"
      count={data ? `${fmtNumber(data.recommendations.length)} evidence-backed` : undefined}
      aside={
        <HelpTip
          label="How telemetry opportunities are found"
          text="Missing fields that materially limited a recent investigation, with the cases and evidence query behind each one. A recommendation needs query-backed evidence from recent analyst-confirmed cases; a connector being absent is never enough."
        />
      }
      className="space-y-3"
    >

      {!data ? (
        <div className="flex items-start gap-3 border-y border-border/70 py-4 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          Telemetry analysis is unavailable. Tuning remains usable; no source recommendation
          is inferred from connector inventory alone.
        </div>
      ) : data.status === 'not_available' || !data.recommendations.length ? (
        <div className="flex items-start gap-3 border-y border-border/70 py-4">
          {data.capture_status === 'not_available' ? (
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden />
          )}
          <div>
            <p className="text-sm font-medium text-foreground">
              {data.capture_status === 'not_available'
                ? 'Telemetry evidence capture not available'
                : 'No evidence-backed gap found'}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {data.capture_not_available_reason ||
                data.not_available_reason ||
                `No qualifying field gap was found across ${fmtNumber(data.scanned_cases)} recent cases.`}
            </p>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-border/70 border-y border-border/70">
          {data.recommendations.map((row) => (
            <article
              key={`${row.source_type}:${row.field}`}
              className="grid gap-4 py-4 lg:grid-cols-[minmax(11rem,0.55fr)_minmax(18rem,1fr)_minmax(18rem,1.15fr)]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <DatabaseZap className="size-4 shrink-0 text-primary" aria-hidden />
                  <span>{row.source_label}</span>
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{row.field}</p>
                <Badge className="mt-2" variant="secondary">
                  {fmtNumber(row.affected_case_count)} affected cases
                </Badge>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Expected investigation benefit
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-foreground">{row.benefit}</p>
                {row.case_ids.length ? (
                  <p className="mt-2 break-words font-mono text-xs text-muted-foreground">
                    Cases: {row.case_ids.slice(0, 5).join(', ')}
                    {row.case_ids.length > 5 ? ` +${row.case_ids.length - 5}` : ''}
                  </p>
                ) : null}
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Evidence
                </p>
                <ul className="mt-1.5 space-y-2">
                  {row.evidence.map((item, index) => (
                    <li key={`${item.query}:${index}`} className="text-xs leading-relaxed">
                      <p className="text-foreground">{item.result}</p>
                      <p className="mt-0.5 break-all font-mono text-muted-foreground">
                        {item.query}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
      )}

      {data?.truncated ? (
        <p className="text-xs text-muted-foreground">
          This view is bounded to the most recent qualifying cases; export remains the
          complete evidence path.
        </p>
      ) : null}
    </Panel>
  );
}

function SchedulerHealth({ health }: { health: SchedulerHealthResponse | null }) {
  const rows = health ? Object.entries(health.workers) : [];
  const workerLabel = (key: string) => {
    if (key === 'threshold_tuner') return 'Threshold tuner';
    if (key === 'campaign_correlation') return 'Campaign correlation';
    if (key === 'batch_jobs') return 'Batch jobs';
    return humanizeToken(key);
  };

  return (
    <Panel
      title="Continuous-improvement workers"
      aria-label="Continuous-improvement worker health"
      aside={
        <>
          <HelpTip
            label="About the continuous-improvement workers"
            text="Runtime evidence for the jobs that learn from feedback, reconcile campaigns and retrieve asynchronous inference results."
          />
          <StatusDot tone={health?.scheduler_runtime_running ? 'neutral' : 'warning'}>
            {health?.scheduler_runtime_running ? 'Scheduler running' : 'Scheduler unavailable'}
          </StatusDot>
        </>
      }
      className="space-y-3"
    >

      {!health ? (
        <div className="flex items-start gap-3 border-y border-border/70 py-4 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          Worker health could not be read. This does not prove that a scheduled job ran.
        </div>
      ) : (
        <div className="divide-y divide-border/70 border-y border-border/70">
          {rows.map(([key, worker]) => {
            const state = worker.last_error
              ? 'Error'
              : worker.running
                ? 'Running'
                : !worker.enabled
                  ? 'Disabled'
                  : worker.gated
                    ? 'Waiting'
                    : 'Ready';
            const variant = worker.last_error
              ? 'critical'
              : worker.running
                ? 'success'
                : worker.enabled
                  ? 'info'
                  : 'secondary';
            return (
              <article
                key={key}
                className="grid gap-3 py-4 md:grid-cols-[minmax(12rem,0.8fr)_minmax(8rem,0.45fr)_minmax(15rem,1fr)_auto] md:items-center"
              >
                <div>
                  <p className="text-sm font-semibold text-foreground">{workerLabel(key)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {humanizeToken(worker.cadence || 'manual')} cadence
                  </p>
                </div>
                <Badge variant={variant}>{state}</Badge>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Last success</dt>
                    <dd className="mt-0.5 tabular-nums text-foreground">
                      {fmtUtc(worker.last_success_at)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Processed</dt>
                    <dd className="mt-0.5 tabular-nums text-foreground">
                      {fmtNumber(worker.processed)}
                    </dd>
                  </div>
                </dl>
                <p className="max-w-xs text-xs leading-relaxed text-muted-foreground md:text-right">
                  {worker.last_error ||
                    (worker.last_attempt_at
                      ? `Last attempted ${humanizeAge(worker.last_attempt_at)}`
                      : 'No attempt recorded yet')}
                </p>
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function TuningPolicy({
  draft,
  canManage,
  onChange,
}: {
  draft: TuningConfig;
  canManage: boolean;
  onChange: React.Dispatch<React.SetStateAction<TuningConfig>>;
}) {
  return (
    <Panel
      title="Tuning policy"
      aside={
        <>
          <HelpTip
            label="About the tuning policy"
            text="Define when enough analyst-confirmed evidence exists and how far a bounded adjustment may move. Review-first is the default."
          />
          <StatusDot tone={draft.enabled ? 'neutral' : 'warning'}>
            {draft.enabled ? 'Automation active' : 'Automation paused'}
          </StatusDot>
        </>
      }
      className="space-y-4"
    >
      <fieldset disabled={!canManage} className="min-w-0 border-t border-border/70">
        <div className="grid gap-5 pt-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.75fr)]">
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4 border-b border-border/70 pb-5">
              <div>
                <Label htmlFor="tuning-enabled" className="text-sm font-medium">
                  Enable auto-tuning
                </Label>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                  Run on the selected cadence. Recommendations use analyst-confirmed
                  outcomes and never determine a case verdict or disposition.
                </p>
              </div>
              <Switch
                id="tuning-enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => onChange((current) => ({ ...current, enabled }))}
              />
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Cadence" description="How often the tuner evaluates feedback.">
                {({ id, labelledBy, describedBy }) => (
                  <Select
                    value={draft.cadence}
                    disabled={!canManage}
                    onValueChange={(cadence) =>
                      onChange((current) => ({ ...current, cadence: cadence as TuningCadence }))
                    }
                  >
                    <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CADENCES.map((cadence) => (
                        <SelectItem key={cadence} value={cadence}>
                          {humanizeToken(cadence)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>

              <NumberField
                label="Minimum samples"
                description="Closed-case observations required before a rule is eligible."
                value={draft.min_samples}
                min={1}
                max={100000}
                step={1}
                defaultValue={DEFAULT_TUNING_CONFIG.min_samples}
                disabled={!canManage}
                onChange={(min_samples) =>
                  onChange((current) => ({ ...current, min_samples }))
                }
              />

              <LabeledSlider
                label="Target false-positive rate"
                description="A rule becomes actionable only when its conservative rate clears this target."
                value={Math.round(draft.fp_rate_target * 100)}
                min={0}
                max={100}
                step={1}
                disabled={!canManage}
                formatValue={(value) => `${value}%`}
                onChange={(value) =>
                  onChange((current) => ({ ...current, fp_rate_target: value / 100 }))
                }
              />

              <div className="flex items-start justify-between gap-4 pt-1">
                <div>
                  <Label htmlFor="tuning-shadow" className="text-sm">
                    Shadow-evaluate first
                  </Label>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Block any change that would have hidden a recent true positive.
                  </p>
                </div>
                <Switch
                  id="tuning-shadow"
                  checked={draft.shadow_eval}
                  onCheckedChange={(shadow_eval) =>
                    onChange((current) => ({
                      ...current,
                      shadow_eval,
                      // Automatic writes are never valid without the shadow guard.
                      auto_apply_confirmed: shadow_eval
                        ? current.auto_apply_confirmed
                        : false,
                    }))
                  }
                />
              </div>
            </div>

            <details className="border-t border-border/70 pt-4">
              <summary className="cursor-pointer text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Advanced statistical controls
              </summary>
              <p className="mt-1 text-xs text-muted-foreground">
                Conservative defaults are recommended unless you are calibrating against a known baseline.
              </p>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <div className="flex items-start justify-between gap-4 sm:col-span-2">
                  <div>
                    <Label htmlFor="tuning-auto-apply" className="text-sm">
                      Auto-apply confirmed bounded changes
                    </Label>
                    <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                      Off by default. When enabled, only independently analyst-confirmed,
                      shadow-safe bounded changes can write without an approval. Suppression
                      and safety conflicts always require human review.
                    </p>
                  </div>
                  <Switch
                    id="tuning-auto-apply"
                    checked={draft.auto_apply_confirmed}
                    onCheckedChange={(auto_apply_confirmed) =>
                      onChange((current) => ({
                        ...current,
                        auto_apply_confirmed,
                        // Enabling the exceptional write policy also enables its
                        // mandatory true-positive shadow check.
                        shadow_eval: auto_apply_confirmed ? true : current.shadow_eval,
                      }))
                    }
                  />
                </div>
                <NumberField
                  label="Max correlation-n step"
                  description="Maximum integer movement in one cadence."
                  value={draft.max_n_step}
                  min={0}
                  max={10}
                  step={1}
                  defaultValue={DEFAULT_TUNING_CONFIG.max_n_step}
                  disabled={!canManage}
                  onChange={(max_n_step) =>
                    onChange((current) => ({ ...current, max_n_step }))
                  }
                />
                <NumberField
                  label="Wilson z-score"
                  description="Confidence used for the conservative FP estimate."
                  value={draft.wilson_z}
                  min={0}
                  max={5}
                  step={0.01}
                  defaultValue={DEFAULT_TUNING_CONFIG.wilson_z}
                  disabled={!canManage}
                  onChange={(wilson_z) =>
                    onChange((current) => ({ ...current, wilson_z }))
                  }
                />
                <LabeledSlider
                  label="EWMA smoothing"
                  description="Lower values react slowly; higher values react quickly."
                  value={draft.ewma_alpha}
                  min={0.01}
                  max={1}
                  step={0.01}
                  disabled={!canManage}
                  formatValue={(value) => value.toFixed(2)}
                  onChange={(ewma_alpha) =>
                    onChange((current) => ({ ...current, ewma_alpha }))
                  }
                />
              </div>
            </details>
          </div>

          <EffectiveConfigPreview
            className="self-start rounded-none border-x-0 bg-transparent"
            summary={
              draft.enabled
                ? `Evaluate noisy rules ${CADENCE_COPY[draft.cadence]}; require ${fmtNumber(draft.min_samples)} samples and a conservative FP rate above ${Math.round(draft.fp_rate_target * 100)}%.`
                : 'Auto-tuning is paused. Recommendations remain visible, but no scheduled change is applied.'
            }
            lines={[
              { label: 'FP target', value: `${Math.round(draft.fp_rate_target * 100)}%` },
              { label: 'Minimum evidence', value: fmtNumber(draft.min_samples) },
              { label: 'Maximum step', value: `+${fmtNumber(draft.max_n_step)}` },
              { label: 'Shadow check', value: draft.shadow_eval ? 'Required' : 'Disabled' },
              {
                label: 'Write mode',
                value: draft.auto_apply_confirmed
                  ? 'Confirmed auto-apply'
                  : 'Approval required',
              },
            ]}
            noteText="Suppression and safety conflicts are never auto-applied. A severity floor affects forwarding only; it never discards a candidate."
          />
        </div>
      </fieldset>

      {!canManage ? (
        <p className="text-xs text-muted-foreground">
          You have read-only access. Ask an administrator with automation management access to edit this policy.
        </p>
      ) : null}
    </Panel>
  );
}
