/**
 * Domain badges — map Agentic SOC enums/values onto the shared <Badge> primitive.
 *
 * Every badge here renders short, controlled labels (humanized enum tokens or
 * formatted numbers) — never raw free-form UNTRUSTED strings. When a value is an
 * arbitrary string the backend produced (e.g. an open-ended category), it is
 * passed through `humanizeToken` and rendered as plain text inside the Badge.
 *
 * a11y (Round-5 W0-E / DESIGN_STANDARD §6.1): meaning is NEVER color-only. Every
 * semantic badge (severity/status/verdict/disposition/risk/posture/urgency) shows a
 * `SEMANTIC_ICON` shape beside the color from the ONE palette.ts authority, so the
 * reading survives colorblindness / monochrome (WCAG 1.4.1). The icon is decorative
 * (`aria-hidden`) — the badge TEXT already carries the meaning — and can be turned
 * off per call with `icon={false}` for the rare space-constrained inline use.
 */
import { Bot, type LucideIcon } from 'lucide-react';
import { Badge, type BadgeProps } from '@/ui/badge';
import { cn } from '@/lib/cn';
import { DASH, humanizeToken, fmtPercent, toPercentValue, formatTimestamp } from '@/lib/format';
import {
  SEVERITY_COLOR,
  STATUS_COLOR,
  VERDICT_COLOR,
  SEMANTIC_ICON,
  scoreBand,
  type ScoreBand,
} from './palette';
import { ProvenanceTag } from './ProvenanceTag';
import {
  canonicalVerdict,
  confidencePercent,
  verdictWords,
  type CaseOutcome,
} from './outcome';

type Variant = NonNullable<BadgeProps['variant']>;

/**
 * Render the beside-color `SEMANTIC_ICON` shape for a semantic KEY (WCAG 1.4.1).
 * Decorative (`aria-hidden`) — the badge text carries the meaning; the glyph is the
 * redundant non-color channel. Sized to 12px so it sits inside the badge's `gap-1`
 * without pushing the label. Returns null when the key has no mapped icon or the
 * caller opted out.
 */
function SemanticGlyph({ iconKey, show }: { iconKey: string; show: boolean }) {
  if (!show) return null;
  const Icon: LucideIcon | undefined = SEMANTIC_ICON[iconKey];
  if (!Icon) return null;
  return <Icon className="size-3 shrink-0" aria-hidden />;
}

/**
 * Bridge a palette.ts TOKEN NAME (the ONE authority, §1.6) to a Badge variant.
 * palette.ts speaks in token names (`critical`/`high`/`primary`/`muted`/…); the
 * Badge cva speaks in variant names. `primary` → the filled `default`; `muted` →
 * the neutral `secondary`; every semantic token maps to its same-named variant.
 */
const TOKEN_VARIANT: Record<string, Variant> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
  success: 'success',
  warning: 'warning',
  primary: 'default',
  muted: 'secondary',
};

function tokenVariant(name: string): Variant {
  return TOKEN_VARIANT[name] ?? 'secondary';
}

// --------------------------------------------------------------------------- //
// Severity — accepts a number (0..100 or a 1..4/1..5 bucket) or a string label
// ("critical"/"high"/"medium"/"low"/"info"). Normalises to one severity band.
// --------------------------------------------------------------------------- //
type SeverityBand = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Normalise a numeric severity into a band via the ONE 0-100 ladder (palette.ts
 *  scoreBand: 0-21 low / 22-47 medium / 48-73 high / 74-100 critical). A value at
 *  or below the low floor with no signal reads as `info`.
 *
 *  The number is interpreted on an EXPLICIT `[0, scaleMax]` scale (default the ONE
 *  0-100 ladder). Magnitude-based scale INFERENCE was removed — it was non-monotonic
 *  (a raw 15 scaled to 100 → Critical while 16 stayed 16 → Low, so a smaller number
 *  could read as a HIGHER band). A caller with a known small-bucket scale (e.g. Wazuh
 *  rule.level on 0-16, or a 1-5 bucket) passes `scaleMax` so the mapping stays
 *  monotonic without guessing from the value's magnitude. */
export function severityBandFromNumber(n: number, scaleMax = 100): SeverityBand {
  const max = scaleMax > 0 ? scaleMax : 100;
  const scaled = Math.max(0, Math.min(100, (n / max) * 100));
  const band: ScoreBand = scoreBand(scaled);
  // A genuinely-nil score reads as informational, not a "low" alert.
  if (band === 'low' && scaled < 8) return 'info';
  return band;
}

/**
 * The ONE severity-band authority: normalise a numeric OR string severity onto a
 * single band (or null when absent). Exported so list surfaces (filter/sort) and the
 * SeverityBadge share ONE ladder and can never drift (fixes the "shown Critical but
 * filtered as High" class of bug). Accepts the string aliases the badge accepts
 * (crit/med/moderate/informational/none).
 */
export function severityBand(
  severity: number | string | null | undefined,
  scaleMax = 100,
): SeverityBand | null {
  if (severity === null || severity === undefined || severity === '') return null;
  if (typeof severity === 'number') {
    if (Number.isNaN(severity)) return null;
    return severityBandFromNumber(severity, scaleMax);
  }
  const t = severity.trim().toLowerCase();
  if (t === 'critical' || t === 'crit') return 'critical';
  if (t === 'high') return 'high';
  if (t === 'medium' || t === 'med' || t === 'moderate') return 'medium';
  if (t === 'low') return 'low';
  if (t === 'info' || t === 'informational' || t === 'none') return 'info';
  const asNum = Number(t);
  if (!Number.isNaN(asNum)) return severityBandFromNumber(asNum, scaleMax);
  return null;
}

/** The band ORDERING (ascending) — shared so a severity sort agrees with the badge. */
export const SEVERITY_BAND_ORDER: readonly SeverityBand[] = [
  'info',
  'low',
  'medium',
  'high',
  'critical',
];

// Derived from the ONE SEVERITY_COLOR authority (palette.ts, §1.6) → Badge variants,
// so the severity chip color can never drift from the chart/legend color.
const SEVERITY_VARIANT: Record<SeverityBand, Variant> = {
  critical: tokenVariant(SEVERITY_COLOR.critical),
  high: tokenVariant(SEVERITY_COLOR.high),
  medium: tokenVariant(SEVERITY_COLOR.medium),
  low: tokenVariant(SEVERITY_COLOR.low),
  info: tokenVariant(SEVERITY_COLOR.info),
};

const SEVERITY_LABEL: Record<SeverityBand, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export interface SeverityBadgeProps {
  severity: number | string | null | undefined;
  className?: string;
  /** Optional visible noun after the band, e.g. "Critical severity" in case headers. */
  labelSuffix?: string;
  /** Append the raw numeric value in parens (e.g. "High (72)"). */
  showValue?: boolean;
  /** Show the beside-color SEMANTIC_ICON shape (§6.1). Default true. */
  icon?: boolean;
  /** The maximum of the numeric severity scale (default the ONE 0-100 ladder). Pass a
   *  smaller max for a known small-bucket source (e.g. 15 for Wazuh rule.level) so a
   *  numeric reading stays monotonic without magnitude-based scale inference. */
  scaleMax?: number;
}

export function SeverityBadge({
  severity,
  className,
  labelSuffix,
  showValue,
  icon = true,
  scaleMax = 100,
}: SeverityBadgeProps) {
  const band = severityBand(severity, scaleMax);
  if (!band) {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        {DASH}
      </Badge>
    );
  }
  const suffix = showValue && typeof severity === 'number' ? ` (${Math.round(severity)})` : '';
  return (
    <Badge variant={SEVERITY_VARIANT[band]} className={className}>
      <SemanticGlyph iconKey={band} show={icon} />
      {SEVERITY_LABEL[band]}
      {labelSuffix ? ` ${labelSuffix}` : ''}
      {suffix}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Status — case lifecycle states. Open-ended; common ones get a semantic colour.
// --------------------------------------------------------------------------- //
function statusVariant(status: string): Variant {
  const t = status.trim().toLowerCase();
  // Route the canonical lifecycle statuses through the ONE STATUS_COLOR authority
  // (palette.ts, §1.6) so the badge + charts never drift (fixes escalated→high).
  if (t in STATUS_COLOR) return tokenVariant(STATUS_COLOR[t as keyof typeof STATUS_COLOR]);
  switch (t) {
    // Legacy / non-lifecycle states not in the canonical STATUS_COLOR map.
    case 'open':
    case 'in_progress':
      return 'info';
    case 'needs_human':
      // Legacy alias of "open · awaiting analyst" — an open/attention state.
      return 'high';
    case 'reopened':
      return 'warning';
    case 'error':
    case 'failed':
      return 'critical';
    default:
      return 'secondary';
  }
}

/** Human-facing label for a status. The legacy NEEDS_HUMAN alias renders as a
 *  clearer "Open · awaiting analyst" per the F8 taxonomy. */
function statusLabel(status: string): string {
  const t = status.trim().toLowerCase();
  if (t === 'needs_human') return 'Open · awaiting analyst';
  if (t === 'on_hold') return 'On hold';
  return humanizeToken(status);
}

/** Normalise a status string to a SEMANTIC_ICON key (§6.1 non-color signaling). */
function statusIconKey(status: string): string {
  const t = status.trim().toLowerCase();
  if (t === 'reopened') return 'investigating';
  return t;
}

export interface StatusBadgeProps {
  status: string | null | undefined;
  className?: string;
  /** Show the beside-color SEMANTIC_ICON shape (§6.1). Default true. */
  icon?: boolean;
}

export function StatusBadge({ status, className, icon = true }: StatusBadgeProps) {
  if (!status) {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        {DASH}
      </Badge>
    );
  }
  return (
    <Badge variant={statusVariant(status)} className={className}>
      <SemanticGlyph iconKey={statusIconKey(status)} show={icon} />
      {statusLabel(status)}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Disposition — the investigative OUTCOME axis (orthogonal to lifecycle status).
// true_positive (alarming) / false_positive + benign (success) / suspicious
// (amber) / duplicate + undetermined (neutral). Permissive to unknown values.
// --------------------------------------------------------------------------- //
function dispositionVariant(disposition: string): Variant {
  const t = disposition.trim().toLowerCase();
  // Disposition shares the verdict value-space (the investigative OUTCOME axis), so
  // it routes through the same VERDICT_COLOR authority (§1.6): TP→critical, FP/benign
  // →info (neutral blue-grey), suspicious→high, duplicate/undetermined→neutral.
  if (t in VERDICT_COLOR) return tokenVariant(VERDICT_COLOR[t as keyof typeof VERDICT_COLOR]);
  return 'secondary';
}

/** Normalise a verdict/disposition string to a SEMANTIC_ICON key (§6.1). */
function verdictIconKey(v: string): string {
  return v.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export interface DispositionBadgeProps {
  disposition: string | null | undefined;
  className?: string;
  /** Show the beside-color SEMANTIC_ICON shape (§6.1). Default true. */
  icon?: boolean;
}

export function DispositionBadge({ disposition, className, icon = true }: DispositionBadgeProps) {
  if (!disposition || disposition.trim().toLowerCase() === 'none') {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        <SemanticGlyph iconKey="undetermined" show={icon} />
        Undetermined
      </Badge>
    );
  }
  return (
    <Badge variant={dispositionVariant(disposition)} className={className}>
      <SemanticGlyph iconKey={verdictIconKey(disposition)} show={icon} />
      {humanizeToken(disposition)}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Verdict — TRUE_POSITIVE / FALSE_POSITIVE / NEEDS_HUMAN (+ unverdicted).
// --------------------------------------------------------------------------- //
function verdictVariant(verdict: string): Variant {
  const t = verdict.trim().toLowerCase();
  // Route through the ONE VERDICT_COLOR authority (palette.ts, §1.6). This applies
  // the FP→info (neutral blue-grey, NOT green) fix by construction; unknown values
  // degrade to the neutral secondary variant.
  if (t in VERDICT_COLOR) return tokenVariant(VERDICT_COLOR[t as keyof typeof VERDICT_COLOR]);
  return 'secondary';
}

export interface VerdictBadgeProps {
  verdict: string | null | undefined;
  className?: string;
  /** Show the beside-color SEMANTIC_ICON shape (§6.1). Default true. */
  icon?: boolean;
}

export function VerdictBadge({ verdict, className, icon = true }: VerdictBadgeProps) {
  if (!verdict || verdict.trim().toLowerCase() === 'none') {
    // Match DispositionBadge's "no outcome yet" grammar: muted + the undetermined
    // glyph (both badges live on the same investigative-outcome value-space, §6.1).
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        <SemanticGlyph iconKey="undetermined" show={icon} />
        Unverdicted
      </Badge>
    );
  }
  return (
    <Badge variant={verdictVariant(verdict)} className={className}>
      <SemanticGlyph iconKey={verdictIconKey(verdict)} show={icon} />
      {humanizeToken(verdict)}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Confidence — a 0..1 (or 0..100) score, coloured by how confident the agent is,
// optionally annotated against an auto-close threshold.
// --------------------------------------------------------------------------- //
export interface ConfidenceBadgeProps {
  confidence: number | null | undefined;
  /** Auto-close confidence bar (0..1). When set, low-confidence renders muted. */
  threshold?: number;
  /** Optional trailing note (e.g. "below bar"). Controlled text only. */
  note?: string;
  className?: string;
}

export function ConfidenceBadge({ confidence, threshold, note, className }: ConfidenceBadgeProps) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        {DASH}
      </Badge>
    );
  }
  const pct = toPercentValue(confidence);
  let variant: Variant;
  if (typeof threshold === 'number') {
    const barPct = toPercentValue(threshold);
    variant = pct >= barPct ? 'success' : 'medium';
  } else {
    variant = pct >= 75 ? 'success' : pct >= 50 ? 'medium' : 'low';
  }
  return (
    <Badge variant={variant} className={className}>
      {/* tabular-nums so the percentage digits stay column-aligned down a dense list (#8). */}
      <span className="tabular-nums">{fmtPercent(confidence)}</span>
      {note ? ` · ${note}` : ''}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Risk — a normalised 0..100 score.
// --------------------------------------------------------------------------- //
function riskVariant(score: number): Variant {
  // The ONE 0-100 ladder (palette.ts scoreBand): 0-21 low / 22-47 medium /
  // 48-73 high / 74-100 critical. Risk never reads as "info" (it is a real score).
  return SEVERITY_VARIANT[scoreBand(score)];
}

export interface RiskBadgeProps {
  score: number | null | undefined;
  className?: string;
  /** Prefix the label (default "Risk"). */
  label?: string;
  /** Show the beside-color SEMANTIC_ICON shape (§6.1). Default true. */
  icon?: boolean;
}

export function RiskBadge({ score, className, label = 'Risk', icon = true }: RiskBadgeProps) {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        {label} {DASH}
      </Badge>
    );
  }
  const rounded = Math.max(0, Math.min(100, Math.round(score)));
  return (
    <Badge variant={riskVariant(rounded)} className={className}>
      <SemanticGlyph iconKey={scoreBand(rounded)} show={icon} />
      {/* tabular-nums so the digits stay column-aligned down a dense list (#8). */}
      <span className="tabular-nums">{label} {rounded}</span>
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Posture — an overall security-posture label (e.g. "Critical"/"Elevated"/
// "Guarded"/"Stable"). Accepts a label string or a 0..100 score to derive one.
// --------------------------------------------------------------------------- //
type PostureBand = 'critical' | 'elevated' | 'guarded' | 'stable';

function postureFromScore(score: number): PostureBand {
  // Reuse the ONE 0-100 ladder (palette.ts scoreBand) so posture shares cut-points
  // with severity/risk; posture just relabels the four bands.
  const BAND_TO_POSTURE: Record<ScoreBand, PostureBand> = {
    critical: 'critical',
    high: 'elevated',
    medium: 'guarded',
    low: 'stable',
  };
  return BAND_TO_POSTURE[scoreBand(score)];
}

function postureBand(posture: number | string | null | undefined): PostureBand | null {
  if (posture === null || posture === undefined || posture === '') return null;
  if (typeof posture === 'number') {
    return Number.isNaN(posture) ? null : postureFromScore(posture);
  }
  const t = posture.trim().toLowerCase();
  if (t === 'critical' || t === 'severe') return 'critical';
  if (t === 'elevated' || t === 'high') return 'elevated';
  if (t === 'guarded' || t === 'moderate' || t === 'medium') return 'guarded';
  if (t === 'stable' || t === 'low' || t === 'nominal' || t === 'healthy') return 'stable';
  const asNum = Number(t);
  return Number.isNaN(asNum) ? null : postureFromScore(asNum);
}

const POSTURE_VARIANT: Record<PostureBand, Variant> = {
  critical: 'critical',
  elevated: 'high',
  guarded: 'medium',
  stable: 'success',
};

const POSTURE_LABEL: Record<PostureBand, string> = {
  critical: 'Critical',
  elevated: 'Elevated',
  guarded: 'Guarded',
  stable: 'Stable',
};

/** Posture band → SEMANTIC_ICON severity key (§6.1), so posture shares the shape
 *  vocabulary with severity/risk (critical/high/medium/low glyphs). */
const POSTURE_ICON_KEY: Record<PostureBand, ScoreBand> = {
  critical: 'critical',
  elevated: 'high',
  guarded: 'medium',
  stable: 'low',
};

export interface PostureBadgeProps {
  posture: number | string | null | undefined;
  className?: string;
  /** Show the beside-color SEMANTIC_ICON shape (§6.1). Default true. */
  icon?: boolean;
}

export function PostureBadge({ posture, className, icon = true }: PostureBadgeProps) {
  const band = postureBand(posture);
  if (!band) {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        {DASH}
      </Badge>
    );
  }
  return (
    <Badge variant={POSTURE_VARIANT[band]} className={className}>
      <SemanticGlyph iconKey={POSTURE_ICON_KEY[band]} show={icon} />
      {POSTURE_LABEL[band]}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Category — an open-ended case/entity category. The label is backend-derived so
// it is humanized and rendered as plain text; the colour is neutral/outline.
// --------------------------------------------------------------------------- //
export interface CategoryBadgeProps {
  category: string | null | undefined;
  className?: string;
}

export function CategoryBadge({ category, className }: CategoryBadgeProps) {
  if (!category) {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        Uncategorized
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={className}>
      {humanizeToken(category)}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// UrgencyPill — a derived "how urgent is this open case" signal computed from its
// age, risk score, and status. Closed cases are not urgent.
// --------------------------------------------------------------------------- //
type UrgencyBand = 'critical' | 'high' | 'medium' | 'low';

const CLOSED_STATUSES = new Set(['closed', 'resolved']);

function ageHours(createdAt?: string | null): number | null {
  if (!createdAt) return null;
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) return null;
  return Math.max(0, (Date.now() - then) / 3_600_000);
}

function computeUrgency(
  createdAt?: string | null,
  riskScore?: number | null,
  status?: string | null,
): { band: UrgencyBand; label: string } | null {
  if (status && CLOSED_STATUSES.has(status.trim().toLowerCase())) return null;
  const risk = typeof riskScore === 'number' && !Number.isNaN(riskScore) ? riskScore : 0;
  const hrs = ageHours(createdAt);
  const escalated = status
    ? ['needs_human', 'escalated'].includes(status.trim().toLowerCase())
    : false;

  // Score blends risk with how long the case has been waiting + escalation.
  let urgency = risk;
  if (hrs !== null) {
    if (hrs >= 24) urgency += 25;
    else if (hrs >= 8) urgency += 15;
    else if (hrs >= 2) urgency += 5;
  }
  if (escalated) urgency += 20;

  let band: UrgencyBand;
  if (urgency >= 85) band = 'critical';
  else if (urgency >= 60) band = 'high';
  else if (urgency >= 35) band = 'medium';
  else band = 'low';

  return { band, label: URGENCY_LABEL[band] };
}

const URGENCY_LABEL: Record<UrgencyBand, string> = {
  critical: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const URGENCY_VARIANT: Record<UrgencyBand, Variant> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

/** Coerce an advisory band string (from the backend `urgency_band`) to a known
 *  UrgencyBand, or null when absent/unrecognised. Tolerant of case/whitespace. */
function asUrgencyBand(band?: string | null): UrgencyBand | null {
  if (!band) return null;
  const t = band.trim().toLowerCase();
  return (['critical', 'high', 'medium', 'low'] as readonly string[]).includes(t)
    ? (t as UrgencyBand)
    : null;
}

export interface UrgencyPillProps {
  createdAt?: string | null;
  riskScore?: number | null;
  status?: string | null;
  /**
   * Advisory urgency band from the backend (`Case.urgency_band`, engine/priority.py).
   * When a recognised band is supplied AND the case is not closed/resolved, it is
   * shown VERBATIM (the advisory reading wins); otherwise the pill falls back to the
   * client-derived urgency (age + risk + escalation). Omitting it preserves the
   * pre-existing behaviour exactly (back-compatible).
   */
  band?: string | null;
  className?: string;
  /** Show the beside-color SEMANTIC_ICON shape (§6.1). Default true. */
  icon?: boolean;
}

export function UrgencyPill({ createdAt, riskScore, status, band, className, icon = true }: UrgencyPillProps) {
  // A closed/resolved case is never urgent — mirror computeUrgency's guard so an
  // explicit advisory band can't resurrect an "Urgent" pill on a terminal case.
  const closed = status ? CLOSED_STATUSES.has(status.trim().toLowerCase()) : false;
  const advisory = closed ? null : asUrgencyBand(band);
  const u = advisory
    ? { band: advisory, label: URGENCY_LABEL[advisory] }
    : computeUrgency(createdAt, riskScore, status);
  if (!u) {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        {DASH}
      </Badge>
    );
  }
  return (
    <Badge variant={URGENCY_VARIANT[u.band]} className={cn('rounded-full', className)}>
      {/* UrgencyBand keys (critical/high/medium/low) are SEMANTIC_ICON keys. */}
      <SemanticGlyph iconKey={u.band} show={icon} />
      {u.label}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// AutoClosedBadge — surfaces when the AI auto-closed a case (Round-7 #11). There
// is no `auto_closed` STATUS in the backend: a case is auto-closed by the AI when
// it reached a terminal lifecycle state (closed/resolved) AND the deterministic
// close decision was recorded to the `agent` actor (`decision_by === 'agent'`).
// This is the ONE predicate for that reading — the old dead `'auto'`/`'auto_closed'`
// status branches were removed. Note: the CLOSE is still made only by the
// deterministic `decide()` policy (#3); this badge is a read-only presentation of
// who the recorded decider was, it never changes lifecycle.
// --------------------------------------------------------------------------- //

const AUTO_CLOSED_TERMINAL = new Set(['closed', 'resolved']);

/**
 * True when a case was auto-closed by the AI: a terminal status
 * (`closed`/`resolved`) whose recorded close decision came from the `agent` actor.
 * An analyst/system/manual close (`decision_by !== 'agent'`) or a still-open case
 * returns false. Case/whitespace tolerant on both inputs.
 */
export function isAutoClosedByAI(
  status?: string | null,
  decisionBy?: string | null,
): boolean {
  if (!status || !decisionBy) return false;
  return (
    AUTO_CLOSED_TERMINAL.has(status.trim().toLowerCase()) &&
    decisionBy.trim().toLowerCase() === 'agent'
  );
}

/** True when `iso` parses to a moment strictly after now (an open objection window). */
function isFutureInstant(iso?: string | null): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms > Date.now();
}

export interface AutoClosedBadgeProps {
  status?: string | null;
  decisionBy?: string | null;
  /** ISO end of the operator objection window; only surfaced when still in the future. */
  objectionWindowExpiresAt?: string | null;
  /** Opt in to the trailing "reopen before {time}" note (default off — compact badge). */
  showObjection?: boolean;
  className?: string;
}

/**
 * Self-hiding badge: renders `null` unless {@link isAutoClosedByAI}. When shown it
 * reads "Auto-closed by AI" with the Bot glyph (info variant). If `showObjection`
 * is set and the objection window is still open, it appends "· reopen before {time}"
 * so an analyst knows how long they have to reverse the automated close.
 */
export function AutoClosedBadge({
  status,
  decisionBy,
  objectionWindowExpiresAt,
  showObjection = false,
  className,
}: AutoClosedBadgeProps) {
  if (!isAutoClosedByAI(status, decisionBy)) return null;
  const objection =
    showObjection && isFutureInstant(objectionWindowExpiresAt)
      ? ` · reopen before ${formatTimestamp(objectionWindowExpiresAt)}`
      : '';
  return (
    <Badge variant="info" className={className}>
      <Bot className="size-3 shrink-0" aria-hidden />
      Auto-closed by AI
      {objection}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Case outcome (Round 12, SPEC D15) — the analyst's classification once a human
// classifies, an attributed AI verdict otherwise. Three grammars, never mixed:
// STATUS = glyph + text (StatusBadge), OUTCOME = filled disposition badge with an
// `Analyst` provenance tag (OutcomeBadge), AI VERDICT = outline badge with the Bot
// glyph (AiVerdictChip). All copy is controlled; `outcome.by` is never rendered here.
// --------------------------------------------------------------------------- //

export interface OutcomeBadgeProps {
  outcome: CaseOutcome;
  className?: string;
  /** Render the `Analyst` provenance tag beside a human outcome. Default true. */
  showProvenance?: boolean;
}

/**
 * The outcome of record as a badge. Renders NOTHING while the outcome is pending —
 * an open case has no outcome yet, and the AI verdict has its own chip.
 */
export function OutcomeBadge({ outcome, className, showProvenance = true }: OutcomeBadgeProps) {
  if (outcome.source === 'pending') return null;
  if (outcome.source === 'analyst') {
    return (
      <span
        data-testid="case-outcome"
        data-outcome-source="analyst"
        className={cn('inline-flex items-center gap-1', className)}
      >
        <DispositionBadge disposition={outcome.disposition} />
        {showProvenance ? <ProvenanceTag kind="analyst" /> : null}
      </span>
    );
  }
  if (outcome.source === 'analyst_policy') {
    return (
      <span
        data-testid="case-outcome"
        data-outcome-source="analyst_policy"
        className={cn('inline-flex items-center gap-1', className)}
      >
        <Badge variant="info">
          <SemanticGlyph iconKey="benign" show />
          Declared benign
        </Badge>
        {showProvenance ? <ProvenanceTag kind="analyst" /> : null}
      </span>
    );
  }
  if (outcome.source === 'analyst_unrecorded') {
    return (
      <Badge
        variant="outline"
        data-testid="case-outcome"
        data-outcome-source="analyst_unrecorded"
        className={cn('text-muted-foreground', className)}
      >
        <SemanticGlyph iconKey="undetermined" show />
        Outcome not recorded
      </Badge>
    );
  }
  return (
    <Badge
      variant="info"
      data-testid="case-outcome"
      data-outcome-source="agent_auto"
      className={className}
    >
      <Bot className="size-3 shrink-0" aria-hidden />
      {outcome.aiVerdict === 'FALSE_POSITIVE'
        ? 'Auto-closed as false positive'
        : outcome.aiVerdict === 'TRUE_POSITIVE'
          ? 'Auto-closed as true positive'
          : 'Auto-closed'}
    </Badge>
  );
}

export interface AiVerdictChipProps {
  verdict: string | null | undefined;
  confidence?: number | null;
  className?: string;
  /** Prefix the words with "AI verdict" (default) — keeps the attribution explicit. */
  labelled?: boolean;
  /**
   * Extra classes for the "AI verdict" prefix (a narrow header can hide it visually; the
   * Bot glyph, the chip's title and its screen-reader text keep the attribution).
   */
  labelClassName?: string;
}

/**
 * The AI verdict as an OUTLINE chip with the Bot glyph — visibly a machine
 * recommendation, never styled like the analyst's filled outcome badge.
 */
export function AiVerdictChip({
  verdict,
  confidence,
  className,
  labelled = true,
  labelClassName,
}: AiVerdictChipProps) {
  const words = verdictWords(verdict);
  const pct = confidencePercent(confidence);
  const hasVerdict = Boolean(canonicalVerdict(verdict));
  return (
    <Badge
      variant="outline"
      data-testid="case-ai-verdict"
      className={cn('gap-1 font-normal text-foreground/85', className)}
      title={hasVerdict ? 'The AI verdict is a recommendation; a person or the deterministic policy decides.' : undefined}
    >
      <Bot className="size-3 shrink-0 text-primary" aria-hidden />
      {labelled ? (
        <>
          <span
            className={cn('text-muted-foreground', labelClassName)}
            aria-hidden={labelClassName ? true : undefined}
          >
            AI verdict
          </span>
          {labelClassName ? <span className="sr-only">AI verdict</span> : null}
        </>
      ) : null}
      <span className="font-medium">{words}</span>
      {hasVerdict && pct !== null ? <span className="tabular-nums text-muted-foreground">{pct}%</span> : null}
    </Badge>
  );
}
