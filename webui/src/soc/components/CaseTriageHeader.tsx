/**
 * CaseTriageHeader — the FOUR honestly-distinct triage chips (#12).
 *
 * Replaces the old "three panels all derived from risk_score" header with four
 * chips that answer DIFFERENT questions, sourced from `GET /api/cases/{id}/triage`:
 *
 *   RISK     — the deterministic 0-100 score (+ its volume/velocity/reputation/…
 *              breakdown, shown via the existing RiskGauge + a mini bar list).
 *   SEVERITY — what the SOURCE asserted on the events (SIEM/EDR rating), badged
 *              "(derived)" honestly when no source severity existed.
 *   IMPACT   — how important the affected asset is (asset criticality).
 *   PRIORITY — the derived P1..P4 (ITIL Impact×Urgency), advisory ordering only.
 *
 * Each chip carries a HelpTip showing the exact INPUTS the backend used, so the
 * number is never a black box.
 *
 * SECURITY (#9): every value here is read-time-derived case data. Chip values are
 * numbers / enum bands rendered as plain text; the HelpTip `inputs` (entity value,
 * severity raw, …) are operator/log-derived and rendered ONLY as plain text inside
 * the tooltip — never as markup. #3: these bands are PRESENTATION ONLY and were
 * never fed to the deterministic decide().
 */
import * as React from 'react';
import { Activity, Crosshair, Gauge, ListOrdered } from 'lucide-react';

import { cn } from '@/lib/cn';
import { DASH } from '@/lib/format';

import { Skeleton } from '@/ui/skeleton';
import { RiskGauge } from '@/soc/components/RiskGauge';
import { HelpTip } from '@/soc/components/HelpTip';
import { scoreBand } from '@/soc/components/palette';
import { severityBandFromNumber } from '@/soc/components/badges';
import { RISK_FACTOR_HELP, RISK_HELP_TEXT } from '@/soc/components/riskCopy';

// Re-exported so the existing `import { RISK_HELP_TEXT, RISK_FACTOR_HELP } from
// '../CaseTriageHeader'` path (used by CaseTriageHeader.test.tsx and other consumers)
// keeps working after the copy moved to `riskCopy.ts` (Round-7 W0.3).
export { RISK_FACTOR_HELP, RISK_HELP_TEXT } from '@/soc/components/riskCopy';

import type {
  ImpactChip,
  PriorityChip,
  RiskChip,
  SeverityChip,
  TriageChips,
} from '@/soc/pages/CaseDetail.api';

/* ----------------------------------------------------------------- tones --- */

type ChipTone = 'critical' | 'high' | 'medium' | 'low' | 'info';

const TONE_TEXT: Record<ChipTone, string> = {
  critical: 'text-critical',
  high: 'text-high',
  medium: 'text-medium',
  low: 'text-low',
  info: 'text-info',
};
const TONE_ACCENT: Record<ChipTone, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
};
const TONE_BAR: Record<ChipTone, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
};

/** Map an advisory band string → a chip tone (the 5-band semantic palette). */
function toneForBand(band?: string): ChipTone {
  switch ((band || '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    default:
      return 'info';
  }
}

/** Map a 0-100 magnitude → a chip tone. Delegates to the ONE SEVERITY authority
 *  (`badges.ts severityBandFromNumber`, the 74/48/22/8 ladder) so the risk-factor bar
 *  tones share ONE ladder with every SeverityBadge and can never drift (Round-7 W2.c).
 *  (RiskCard's accent stripe intentionally stays on `scoreBand` — the 4-band RISK ladder
 *  the embedded RiskGauge uses; that is a separate axis and is left untouched.) */
function toneForScore(score: number): ChipTone {
  return severityBandFromNumber(score);
}

/** Title-case a band/level token for display ("high" → "High", "P1" → "P1"). */
function label(token?: string | null): string {
  const t = (token || '').trim();
  if (!t) return DASH;
  if (/^p\d$/i.test(t)) return t.toUpperCase();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/* --------------------------------------------------------------- chip shell -- */

/** Shared chip frame: a top accent bar, an uppercase label with a HelpTip, and a
 *  large headline value. All children are plain text. */
const ChipShell: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tone: ChipTone;
  value: string;
  /** Optional secondary line under the value (plain text). */
  sub?: React.ReactNode;
  /** HelpTip text + an optional code block of the precise inputs. */
  helpText: string;
  helpCode?: string;
  children?: React.ReactNode;
  'data-testid'?: string;
}> = ({ icon: Icon, label: lbl, tone, value, sub, helpText, helpCode, children, ...rest }) => (
  <div
    data-testid={rest['data-testid']}
    className="relative flex min-h-[7.5rem] flex-col overflow-hidden rounded-lg border border-border bg-card p-4"
  >
    <span aria-hidden="true" className={cn('absolute inset-x-0 top-0 h-0.5', TONE_ACCENT[tone])} />
    <div className="flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
        {lbl}
      </span>
      <HelpTip text={helpText} code={helpCode} label={`What ${lbl.toLowerCase()} means`} />
    </div>
    <div className={cn('mt-2 text-2xl font-bold leading-none tracking-tight', TONE_TEXT[tone])}>
      {value}
    </div>
    {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    {children ? <div className="mt-auto pt-3">{children}</div> : null}
  </div>
);

/* ----------------------------------------------------------- risk breakdown -- */

const RISK_COMPONENTS: Array<{ key: string; label: string }> = [
  { key: 'volume', label: 'Volume' },
  { key: 'velocity', label: 'Velocity' },
  { key: 'reputation', label: 'Reputation' },
  { key: 'diversity', label: 'Diversity' },
  { key: 'asset_criticality', label: 'Asset' },
];

/** A compact horizontal breakdown of the risk components (each 0-100). Plain data. */
const RiskBreakdownBars: React.FC<{ breakdown: Record<string, number | undefined> }> = ({
  breakdown,
}) => {
  const rows = RISK_COMPONENTS.map((c) => ({
    label: c.label,
    value: Math.max(0, Math.min(100, Number(breakdown?.[c.key] ?? 0))),
  })).filter((r) => Number.isFinite(r.value));
  if (rows.every((r) => r.value === 0)) return null;
  return (
    <div className="space-y-1.5">
      <div
        data-testid="risk-factors-help"
        className="flex items-center gap-1 text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground"
      >
        <span>Factors</span>
        <HelpTip text={RISK_FACTOR_HELP} label="How the 5 risk factors are weighted" />
      </div>
      {/* Label + value sit ABOVE a full-width bar (not beside it). Inside the ~120px
          risk-chip column, a side-by-side w-16 label + w-7 number left the bar a ~14px
          sliver (and clipped on smaller desktops); stacking gives the bar the full
          column width at the same overall height. */}
      {rows.map((r) => {
        const tone = toneForScore(r.value);
        return (
          <div key={r.label} className="space-y-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                {r.label}
              </span>
              <span className="shrink-0 text-[0.65rem] tabular-nums text-muted-foreground">
                {Math.round(r.value)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full', TONE_BAR[tone])}
                style={{ width: `${r.value}%` }}
                aria-hidden
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* --------------------------------------------------------- inputs → help code */

/** Build a plain-text "inputs" block for a chip's HelpTip (#9: plain text only). */
function inputsCode(inputs: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!inputs) return undefined;
  const lines: string[] = [];
  for (const k of keys) {
    const v = inputs[k];
    if (v === undefined || v === null || v === '') continue;
    lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return lines.length ? lines.join('\n') : undefined;
}

/* ------------------------------------------------------------------- chips -- */

const RiskCard: React.FC<{ risk: RiskChip }> = ({ risk }) => {
  const score = Math.max(0, Math.min(100, Number(risk?.value ?? 0)));
  // The accent stripe uses the SAME 0-100 ladder (palette.ts scoreBand — 74/48/22) as
  // the embedded RiskGauge, so the stripe and the gauge arc never disagree. The 5-band
  // toneForScore read "info" (blue-grey) for scores <15 while the gauge collapses <15
  // into "low" (blue), so the two coloured the same number differently.
  const band = scoreBand(score);
  const help = risk.inputs?.definition || RISK_HELP_TEXT;
  return (
    <div
      data-testid="triage-chip-risk"
      className="relative flex min-h-[7.5rem] flex-col overflow-hidden rounded-lg border border-border bg-card p-4"
    >
      <span aria-hidden="true" className={cn('absolute inset-x-0 top-0 h-0.5', TONE_ACCENT[band])} />
      <div className="flex items-center gap-1.5">
        <Gauge className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
          Risk
        </span>
        <HelpTip text={help} label="What risk means" />
      </div>
      <div className="mt-2 flex items-start gap-3">
        <div className="shrink-0">
          <RiskGauge score={score} size={108} />
        </div>
        <div className="min-w-0 flex-1 self-center">
          <RiskBreakdownBars breakdown={risk.breakdown || {}} />
        </div>
      </div>
    </div>
  );
};

/**
 * The severity band's provenance sub-label. `severity.source` is a THREE-token
 * vocabulary, not a boolean: `source_out_of_range` means the source DID assert a rating
 * and it exceeded the declared ceiling, so the band is our clamped arithmetic rather than
 * the source's claim. Reading it as "derived (no source rating)" while printing that very
 * rating next to it would be a plain falsehood.
 */
function severitySubLabel(source?: string): string {
  if (source === 'source_asserted') return 'source-asserted';
  if (source === 'source_out_of_range') return 'source rating above declared ceiling';
  return 'derived (no source rating)';
}

const SeverityCard: React.FC<{ severity: SeverityChip }> = ({ severity }) => {
  const tone = toneForBand(severity?.band);
  const help =
    severity.inputs?.definition ||
    "The maximum severity the SOURCE asserted on the member events — the SIEM/EDR's own rating, not our computed risk.";
  const code = inputsCode(severity.inputs, ['severity_max', 'severity_min']);
  return (
    <ChipShell
      data-testid="triage-chip-severity"
      icon={Activity}
      label="Severity"
      tone={tone}
      value={label(severity?.band)}
      helpText={help}
      helpCode={code}
      sub={
        <span>
          {severitySubLabel(severity?.source)}
          {typeof severity?.raw === 'number' ? ` · raw ${severity.raw}` : ''}
        </span>
      }
    />
  );
};

const ImpactCard: React.FC<{ impact: ImpactChip }> = ({ impact }) => {
  const tone = toneForBand(impact?.band);
  const help =
    impact.inputs?.definition ||
    "How important the affected asset is, from the operator's asset-criticality map / internal-network policy.";
  const code = inputsCode(impact.inputs, ['entity_type', 'entity_value']);
  const crit = typeof impact?.criticality === 'number' ? Math.round(impact.criticality) : null;
  return (
    <ChipShell
      data-testid="triage-chip-impact"
      icon={Crosshair}
      label="Impact"
      tone={tone}
      value={label(impact?.band)}
      helpText={help}
      helpCode={code}
      sub={crit !== null ? <span>asset criticality {crit}/100</span> : <span>asset criticality {DASH}</span>}
    />
  );
};

const PriorityCard: React.FC<{ priority: PriorityChip }> = ({ priority }) => {
  // Priority tone tracks the urgency band (how pressing) for an honest colour.
  const tone = toneForBand(priority?.urgency?.band || priority?.impact);
  const help =
    priority.inputs?.definition ||
    'ITIL priority = Impact × Urgency, looked up in the operator priority matrix. Advisory ordering only — it never changes the verdict or the deterministic close/escalate decision.';
  const code = inputsCode(priority.inputs, ['impact_band', 'urgency_band', 'matrix_enabled']);
  const level = priority?.level || priority?.default || null;
  return (
    <ChipShell
      data-testid="triage-chip-priority"
      icon={ListOrdered}
      label="Priority"
      tone={tone}
      value={label(level)}
      helpText={help}
      helpCode={code}
      sub={
        <span>
          impact {label(priority?.impact)} × urgency {label(priority?.urgency?.band)}
          {priority?.matched === false ? ' · default' : ''}
        </span>
      }
    />
  );
};

/* --------------------------------------------------------------- component -- */

/** The four honest chip axes. `only` selects + orders a subset (see below). */
export type TriageChipKey = 'risk' | 'severity' | 'impact' | 'priority';

const ALL_CHIP_KEYS: readonly TriageChipKey[] = ['risk', 'severity', 'impact', 'priority'];

/** Grid columns keyed by the number of chips rendered, so a 1- or 3-chip subset packs
 *  tightly instead of leaving empty lg:grid-cols-4 columns. */
const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
};

export interface CaseTriageHeaderProps {
  chips: TriageChips | null;
  loading?: boolean;
  className?: string;
  /**
   * Render only this SUBSET of chips, in this order. Used to split the four chips
   * across the CaseDetail Overview's two provenance sections — SEVERITY (source-
   * asserted) under "Reported by source", RISK/IMPACT/PRIORITY (code-derived) under
   * "Our assessment". Omit → all four (the default header).
   */
  only?: readonly TriageChipKey[];
}

/**
 * The four-chip triage header. Renders skeletons while loading, then the honestly-
 * distinct chips. Defensive: a missing chip degrades to a low/zero band (the backend
 * already returns a renderable shell for an unknown case). `only` narrows to a subset.
 */
export const CaseTriageHeader: React.FC<CaseTriageHeaderProps> = ({
  chips,
  loading,
  className,
  only,
}) => {
  const keys = only && only.length ? only : ALL_CHIP_KEYS;
  const gridCols = GRID_COLS[keys.length] ?? GRID_COLS[4];
  if (loading) {
    return (
      <div className={cn('grid gap-3', gridCols, className)}>
        {/* Height approximates the rendered chip (the RiskCard gauge + factor breakdown
            makes the real chips ~172px, well above the old 120px), so the header footprint
            barely shifts on the loading→loaded transition. */}
        {keys.map((k) => (
          <Skeleton key={k} className="h-[10.75rem] rounded-lg" />
        ))}
      </div>
    );
  }
  // Not loading and still no chips ⇒ the /triage fetch failed (it always returns a
  // renderable shell on success). Render nothing so the overview degrades to its
  // legacy Verdict/Confidence headline panels instead of shimmering forever.
  if (!chips) return null;
  const chipFor = (k: TriageChipKey): React.ReactNode => {
    switch (k) {
      case 'risk':
        return <RiskCard key="risk" risk={chips.risk} />;
      case 'severity':
        return <SeverityCard key="severity" severity={chips.severity} />;
      case 'impact':
        return <ImpactCard key="impact" impact={chips.impact} />;
      case 'priority':
        return <PriorityCard key="priority" priority={chips.priority} />;
    }
  };
  return (
    <div className={cn('grid gap-3', gridCols, className)}>{keys.map(chipFor)}</div>
  );
};

export default CaseTriageHeader;
