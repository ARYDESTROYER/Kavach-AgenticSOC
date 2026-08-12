/**
 * CaseDetail — Overview panel (task 7c redesign).
 *
 * A clean, scannable case briefing, top to bottom:
 *   1. DECISION SUMMARY — verdict headline + one-sentence summary, recommended action,
 *      and auto-close note. The embedded Case Manager presents this as a flat dashboard
 *      band with an accessible signal profile (risk / confidence / recorded risk-factor
 *      bars); the default sheet retains its familiar card + compact chip row. Lifecycle
 *      controls live outside this read-only panel.
 *   2. PROVENANCE ROW — three peer columns that keep WHO-said-what obvious:
 *      SOURCE SAYS (SIEM facts) · AGENT FOUND (the AI findings) · CODE DECIDED
 *      (the deterministic route). A delta cue bridges source severity vs. our risk band
 *      when they disagree. The default sheet keeps the pinned deterministic
 *      <DecisionCard>; the embedded Case Manager consolidates the same unique authority
 *      facts into CODE DECIDED so it does not repeat verdict/confidence/risk/result (#3).
 *   3. ENTITY ROW — PRIMARY ENTITY (value + scope + reputation/geo + copy) · MINI ATTACK
 *      STORY (rule fired → agent searched → intel checked → case-manager routed) ·
 *      ENTITY RELATIONSHIP (entity → rule → surface).
 *   4. EVIDENCE — an evidence checklist table + a "reproduce investigation" panel.
 *   5. COLLAPSIBLES — related cases + provenance & audit (status timeline, automation,
 *      run/cost meta), folded away by default.
 *
 * SECURITY (#9): every case-derived value (title, summary, entity, IPs, rules, queries,
 * evidence, tags, source ids, enrichment) is UNTRUSTED — rendered as plain text or
 * inside <CodeBlock>/<InlineCode>/badges, never as markup or a CSS/href value.
 * #3: this panel is read-only; it never decides or mutates the case — both the default
 * <DecisionCard> and embedded authority lane only PROJECT the recorded result.
 */
import * as React from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Crosshair,
  Database,
  GitBranch,
  Globe,
  Gauge,
  History,
  Info,
  Link2,
  Lock,
  Search,
  Shield,
  ShieldCheck,
  Tag,
  Target,
  Zap,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { Case, CaseRationale } from '@/lib/types';
import { DASH, fmtMoney, fmtPercent, formatTimestamp, humanizeAge, humanizeToken } from '@/lib/format';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import { Skeleton } from '@/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';

import { scoreBand, type ScoreBand } from '@/soc/components/palette';
import { EmptyState } from '@/soc/components/EmptyState';
import { CodeBlock, InlineCode } from '@/soc/components/CodeBlock';
import {
  VerdictBadge,
  StatusBadge,
  DispositionBadge,
  ConfidenceBadge,
  AutoClosedBadge,
  isAutoClosedByAI,
  SeverityBadge,
  severityBand,
} from '@/soc/components/badges';
import { ProvenanceTag, severityProvenance, type Provenance } from '@/soc/components/ProvenanceTag';
import { DecisionCard } from './DecisionCard';
import { InvestigationInputs } from './InvestigationInputs';
import { BaselineSignatureCard } from '@/soc/components/BaselineGauge';
import type { TriageChips } from '@/soc/pages/CaseDetail.api';
import { baselineApi, type BaselineSignature } from '@/soc/Baseline.api';
import type { Navigate } from '@/soc/router';

import {
  type FpPolicy,
  type ScoreTone,
  CASE_MANAGER_PANEL_PADDING,
  MetaItem,
  PanelCard,
  SectionHeading,
  type CasePanelPresentation,
  confidenceCalibration,
  verdictHeadline,
} from './shared';

const RULED_OUT_RE =
  /\b(no\s+(match|evidence|sign|indicat|hit|result)|not\s+(malicious|found|present|observed)|ruled\s+out|clean|benign|negative|nothing\s+(found|suspicious)|false\s+positive|cleared)\b/i;

function isRuledOut(summary?: string): boolean {
  return !!summary && RULED_OUT_RE.test(summary);
}

/** Title-case a lowercase band token for prose ("high" → "High"). */
function titleBand(band: string): string {
  return band ? band.charAt(0).toUpperCase() + band.slice(1) : band;
}

/** Compact display label for a band/level token ("high" → "High", "p1" → "P1"). */
function chipLabel(token?: string | null): string {
  const t = (token || '').trim();
  if (!t) return DASH;
  if (/^p\d$/i.test(t)) return t.toUpperCase();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** The first sentence of a longer body (falls back to the trimmed whole). */
function firstSentence(text?: string): string {
  if (!text) return '';
  const trimmed = text.trim();
  const m = trimmed.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : trimmed).trim();
}

/** A calm human decision headline from the verdict + lifecycle status. */
function decisionHeadline(verdict?: string, status?: string): string {
  const v = (verdict || '').trim().toLowerCase();
  const s = (status || '').trim().toLowerCase();
  let lead: string;
  if (!v || v === 'none') lead = 'Not yet verdicted';
  else if (v === 'true_positive') lead = 'Likely a true positive';
  else if (v === 'false_positive') lead = 'Likely a false positive';
  else if (v === 'benign') lead = 'Assessed benign';
  else if (v === 'needs_human') lead = 'Needs human review';
  else if (v === 'suspicious') lead = 'Suspicious activity';
  else lead = humanizeToken(verdict);
  let tail = '';
  if (s === 'needs_human') tail = 'needs human review';
  else if (s === 'escalated') tail = 'escalated';
  else if (s === 'on_hold') tail = 'on hold';
  else if (s === 'resolved') tail = 'resolved';
  else if (s === 'closed') tail = 'closed';

  // Verdict and lifecycle are separate axes, but they can carry the same meaning
  // (for example needs_human + needs_human). Do not repeat that label in prose.
  const canonical = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  if (!tail || v === s || canonical(lead) === canonical(tail)) return lead;
  return `${lead} — ${tail}`;
}

/** True when an IP sits in a private / link-local / loopback range (best-effort). */
function isPrivateIp(ip: string): boolean {
  return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1\b|fe80:|f[cd][0-9a-f]{2}:)/i.test(
    ip.trim(),
  );
}

/**
 * The full one-line auto-close note (brief) + a compact tag (CODE DECIDED). Returns null
 * when no FP policy is configured. `line`/`tag` are our own controlled copy (#9).
 */
function autoCloseSummary(
  policy: FpPolicy,
  c: Case,
): { line: string; tag: string } | null {
  if (!policy || typeof policy.min_confidence !== 'number') return null;
  const v = (c.verdict || '').toLowerCase();
  const isFp = v.includes('false') || v === 'fp' || v.includes('benign');
  if (!policy.enabled) {
    // This sentence describes the CURRENT false-positive auto-close policy. It is
    // relevant only to a case actually assessed as false-positive/benign and still
    // needing (or having received) human handling. Never attach it to true-positive
    // or NEEDS_HUMAN verdicts, and do not contradict an already-recorded AI close.
    // Presentation only — no policy or lifecycle decision changes here.
    if (!isFp || isAutoClosedByAI(c.status, c.decision_by)) return null;
    return {
      line: 'False-positive auto-close is disabled',
      tag: 'Disabled · held for review',
    };
  }
  if (!isFp) {
    return {
      line: 'NEEDS_HUMAN and true-positive verdicts never auto-close — the auto-close bar applies to false positives only.',
      tag: 'Held for a human',
    };
  }
  const conf = typeof c.confidence === 'number' ? c.confidence : null;
  const risk = typeof c.risk_score === 'number' ? c.risk_score : null;
  const confOk = conf !== null && conf >= policy.min_confidence;
  const riskOk =
    typeof policy.max_risk_score !== 'number' || (risk !== null && risk <= policy.max_risk_score);
  const bar = policy.min_confidence.toFixed(2);
  if (confOk && riskOk) {
    return {
      line: `Eligible for auto-close: confidence is at/above the ${bar} bar and risk is within the policy ceiling.`,
      tag: 'Eligible for auto-close',
    };
  }
  if (!confOk) {
    return { line: `Below the ${bar} auto-close confidence bar — held for a human.`, tag: 'Held for a human' };
  }
  return {
    line: 'Above the confidence bar but risk exceeds the auto-close ceiling — held for a human.',
    tag: 'Held for a human',
  };
}

/* ------------------------------------------------------------- small pieces -- */

/** An uppercase section label + optional provenance legend + a quiet divider. */
const SectionLabel: React.FC<{
  children: React.ReactNode;
  provenance?: React.ReactNode;
  testId?: string;
  quiet?: boolean;
}> = ({ children, provenance, testId, quiet = false }) => (
  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
    <span
      data-testid={testId}
      className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground"
    >
      {children}
    </span>
    {provenance ? <span className="flex items-center gap-1">{provenance}</span> : null}
    {!quiet ? <span aria-hidden="true" className="h-px flex-1 bg-border" /> : null}
  </div>
);

/**
 * Case Manager shares the dashboard's single-canvas surface grammar: content is
 * grouped by hairline dividers instead of being boxed into independent cards.
 * These classes only ever decorate the embedded presentation; the legacy sheet
 * continues to use the normal PanelCard surface unchanged.
 */
const EMBEDDED_FLAT_SECTION =
  'rounded-none border-x-0 border-b-0 border-t border-border/70 bg-transparent px-0 py-5 shadow-none';
const EMBEDDED_FLAT_COLUMN =
  'rounded-none border-0 bg-transparent p-0 shadow-none';
const EMBEDDED_MAJOR_SECTION = 'border-t border-border/60 pt-6';

/** One compact chip in the DECISION BRIEF strip: a small label over a bold value. */
const BriefChip: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
      {label}
    </span>
    <span className="text-sm font-semibold tracking-tight text-foreground">{value}</span>
  </div>
);

/** Clamp an arbitrary score-like value into the visible 0..100 range. */
function boundedScore(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

const METER_FILL: Record<ScoreBand | 'primary', string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  primary: 'bg-primary',
};

/**
 * A compact score visual with a complete textual equivalent. The visible value and
 * the labelled progressbar expose the same fact; colour is never the only signal.
 */
const SignalMeter: React.FC<{
  label: string;
  value: number;
  display: string;
  tone: ScoreBand | 'primary';
  description: string;
}> = ({ label, value, display, tone, description }) => {
  const bounded = boundedScore(value);
  return (
    <div className="space-y-1.5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
            {label}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="shrink-0 font-mono text-lg font-semibold tabular-nums text-foreground">
          {display}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label}: ${display}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(bounded)}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          aria-hidden="true"
          className={cn('h-full rounded-full', METER_FILL[tone])}
          style={{ width: `${bounded}%` }}
        />
      </div>
    </div>
  );
};

/** A dependency-free "copy this value" chip (#9-safe — copies a plain string). */
const CopyChip: React.FC<{ value: string; label: string }> = ({ value, label }) => {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onCopy = React.useCallback(() => {
    void copyText(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : label}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? (
        <Check className="h-3 w-3 text-success" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
};

/** One of the three provenance columns (SOURCE SAYS / AGENT FOUND / CODE DECIDED). */
const ProvenanceColumn: React.FC<{
  title: string;
  kind: Provenance;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  compact?: boolean;
}> = ({ title, kind, icon: Icon, children, compact = false }) => (
  <PanelCard
    data-overview-surface={compact ? 'flat-column' : undefined}
    className={cn('flex min-w-0 flex-col', compact && EMBEDDED_FLAT_COLUMN)}
  >
    <div className="mb-3 flex items-center gap-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <h3 className="flex-1 text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </h3>
      <ProvenanceTag kind={kind} />
    </div>
    <div className="space-y-3">{children}</div>
  </PanelCard>
);

/**
 * One inspectable Agent-found fact. The visible row stays as compact as the
 * dashboard-style provenance column, while the disclosure gives the analyst the
 * exact persisted evidence behind the count. A real button is used (instead of a
 * hover-only span) so keyboard and touch operators can inspect the same detail.
 */
const AgentFindingMetric: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: React.ReactNode;
  detail: React.ReactNode;
  tone?: string;
}> = ({ icon: Icon, label, detail, tone = 'text-muted-foreground' }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        className="group flex w-full items-start gap-2 rounded-sm py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon
          className={cn('mt-0.5 h-4 w-4 shrink-0 transition-colors group-hover:text-foreground', tone)}
          aria-hidden
        />
        <span className="text-foreground/90 underline-offset-4 group-hover:underline">{label}</span>
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" align="start" className="max-w-[min(28rem,calc(100vw-2rem))] p-3">
      <div className="space-y-1.5 text-xs leading-relaxed text-popover-foreground">{detail}</div>
    </TooltipContent>
  </Tooltip>
);

/** A labelled, default-closed disclosure for the lower-value sections. */
const CollapsibleSection: React.FC<{
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ label, icon: Icon, defaultOpen = false, children }) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-6 pt-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
};

/* ------------------------------------------------------- status timeline -- */

/** Append-only lifecycle transition trail (F8). `by`/`reason` are operator/agent
 *  text — rendered as plain text (#9). Renders nothing when empty. */
const StatusTimeline: React.FC<{
  history?: Case['status_history'];
  statusReason?: string;
  flat?: boolean;
}> = ({ history, statusReason, flat = false }) => {
  const entries = Array.isArray(history) ? history : [];
  if (!entries.length && !statusReason) return null;
  // Newest last (chronological), reversed for newest-first display.
  const ordered = [...entries].reverse();
  return (
    <PanelCard
      data-overview-surface={flat ? 'flat-section' : undefined}
      className={cn(flat && EMBEDDED_FLAT_SECTION)}
    >
      <SectionHeading icon={History}>Status timeline</SectionHeading>
      {statusReason ? (
        <p className="mb-3 text-xs text-muted-foreground">
          {/* UNTRUSTED status reason — plain text. */}
          Current reason: <span className="text-foreground/90">{statusReason}</span>
        </p>
      ) : null}
      {ordered.length ? (
        <ol className="relative space-y-4 border-l border-border pl-5">
          {ordered.map((e, i) => (
            <li key={`${e.at}-${i}`} className="relative">
              <span
                aria-hidden="true"
                className={cn(
                  'absolute -left-[1.4rem] top-1 h-2.5 w-2.5 rounded-full border-2 bg-primary',
                  flat ? 'border-background' : 'border-card',
                )}
              />
              <div className="flex flex-wrap items-center gap-2">
                {e.from_status ? <StatusBadge status={e.from_status} /> : null}
                <span className="text-xs text-muted-foreground">{DASH}</span>
                <StatusBadge status={e.to_status} />
                <span className="text-xs text-muted-foreground">
                  {e.at ? humanizeAge(e.at) : ''}
                  {e.by ? <> · {humanizeToken(e.by)}</> : null}
                </span>
              </div>
              {e.reason ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {/* UNTRUSTED — plain text. */}
                  {e.reason}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState icon={History} compact title="No lifecycle transitions recorded yet" />
      )}
    </PanelCard>
  );
};

/* ----------------------------------------- related cases + source breakdown */

/**
 * Cross-source linkage panel (F6). Renders RELATED cases (never merged) + a source
 * breakdown when present. All case-derived text is UNTRUSTED → plain text. Renders
 * nothing when no cross-source data is present.
 */
const RelatedCrossSource: React.FC<{ c: Case; onNavigate?: Navigate; flat?: boolean }> = ({
  c,
  onNavigate,
  flat = false,
}) => {
  const relatedIds = React.useMemo(
    () =>
      (Array.isArray(c.related_case_ids) ? c.related_case_ids : []).filter(
        (rid): rid is string => typeof rid === 'string' && !!rid && rid !== c.case_id,
      ),
    [c.related_case_ids, c.case_id],
  );
  const breakdown = React.useMemo(() => {
    const b = c.source_breakdown;
    if (!b || typeof b !== 'object') return [] as Array<[string, number]>;
    return Object.entries(b)
      .filter(([, v]) => typeof v === 'number')
      .sort((a, bb) => bb[1] - a[1]);
  }, [c.source_breakdown]);

  // Best-effort titles for the related case ids (fetch the recent list, map by id).
  const [titles, setTitles] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!relatedIds.length) return;
    let cancelled = false;
    void api
      .listCases({ limit: 200 })
      .then((res) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const rc of res.cases) {
          if (relatedIds.includes(rc.case_id)) {
            map[rc.case_id] = rc.title || rc.case_number || rc.case_id;
          }
        }
        setTitles(map);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [relatedIds]);

  if (!relatedIds.length && !breakdown.length && !c.cross_source_cluster_id) return null;

  const openRelated = (rid: string) => {
    if (onNavigate) onNavigate('cases', { caseId: rid });
  };

  return (
    <div className={cn('grid gap-6 lg:grid-cols-2', flat && 'xl:gap-8')}>
      <PanelCard
        data-overview-surface={flat ? 'flat-column' : undefined}
        className={cn(flat && EMBEDDED_FLAT_COLUMN)}
      >
        <SectionHeading icon={GitBranch}>Related cases</SectionHeading>
        {relatedIds.length ? (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              Grouped by a shared entity across sources within the cross-source window. These are
              RELATED — they are never merged into this case.
            </p>
            <ul className="space-y-2">
              {relatedIds.map((rid) => (
                <li key={rid} className="flex items-center gap-2">
                  <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <button
                    type="button"
                    onClick={() => openRelated(rid)}
                    disabled={!onNavigate}
                    className={cn(
                      'truncate rounded-sm text-left text-sm',
                      onNavigate
                        ? 'text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                        : 'cursor-default text-foreground',
                    )}
                    title={titles[rid] || rid}
                  >
                    {/* UNTRUSTED title / id — plain text. */}
                    {titles[rid] || rid}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <EmptyState icon={GitBranch} compact title="No related cases" />
        )}
        {c.cross_source_cluster_id ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Cross-source group{' '}
            {/* UNTRUSTED id — plain text, mono. */}
            <span className="font-mono text-foreground/80">{c.cross_source_cluster_id}</span>
          </p>
        ) : null}
      </PanelCard>

      <PanelCard
        data-overview-surface={flat ? 'flat-column' : undefined}
        className={cn(flat && EMBEDDED_FLAT_COLUMN)}
      >
        <SectionHeading icon={Globe}>Source breakdown</SectionHeading>
        {breakdown.length ? (
          <dl className="divide-y divide-border">
            {breakdown.map(([sid, count]) => (
              <div
                key={sid}
                className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                {/* UNTRUSTED source id — plain text, truncated. */}
                <dt className="min-w-0 truncate font-mono text-xs text-foreground" title={sid}>
                  {sid}
                </dt>
                <dd className="shrink-0">
                  <Badge variant="outline" className="tabular-nums">
                    {count}
                  </Badge>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Single source.</p>
        )}
      </PanelCard>
    </div>
  );
};

/* ----------------------------------------------- threshold automation (F10) */

/** Map an automation action verb → label + icon + tone. */
const AUTOMATION_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; tone: ScoreTone }
> = {
  tag: { label: 'Tagged', icon: Tag, tone: 'info' },
  recommend: { label: 'Recommendation', icon: Info, tone: 'medium' },
  notify: { label: 'Notified', icon: Bell, tone: 'info' },
  run_playbook: { label: 'Queued playbook', icon: BookOpen, tone: 'low' },
  request_approval: { label: 'Proposed (needs approval)', icon: Lock, tone: 'high' },
};

/**
 * Shows the SAFE actions threshold automation applied to this case (F10). Renders
 * nothing when none ran. Non-binding: automation can tag / recommend / notify / queue a
 * re-investigation / draft a Proposal, but NEVER sets the case status. All detail text
 * is operator/agent-authored → plain text (#9).
 */
const AutomationApplied: React.FC<{ c: Case; flat?: boolean }> = ({ c, flat = false }) => {
  const actions = Array.isArray(c.automation_actions) ? c.automation_actions : [];
  if (!actions.length) return null;
  return (
    <PanelCard
      data-overview-surface={flat ? 'flat-section' : undefined}
      className={cn(flat && EMBEDDED_FLAT_SECTION)}
    >
      <SectionHeading icon={Zap}>Automation applied</SectionHeading>
      <p className="mb-3 text-xs text-muted-foreground">
        Threshold-automation actions taken after the deterministic decision. These are
        non-binding — automation can tag, recommend, notify, queue a re-investigation, or draft a
        proposal, but it never changes the lifecycle status or auto-closes a case.
      </p>
      <ul className="space-y-2">
        {actions.map((a, i) => {
          const meta = AUTOMATION_META[String(a.action || '')] || {
            label: humanizeToken(String(a.action || 'Action')),
            icon: Zap,
            tone: 'info' as ScoreTone,
          };
          const Icon = meta.icon;
          return (
            <li
              key={`${a.rule_id || a.action || i}-${i}`}
              className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm"
            >
              <Badge variant={meta.tone === 'low' ? 'success' : meta.tone} className="shrink-0 gap-1">
                <Icon className="h-3 w-3" />
                {meta.label}
              </Badge>
              <div className="min-w-0 flex-1">
                {a.detail ? (
                  /* UNTRUSTED — plain text. */
                  <p className="whitespace-pre-wrap text-foreground/90">{a.detail}</p>
                ) : null}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {a.rule_id ? <span className="font-mono">rule {a.rule_id}</span> : null}
                  {a.proposal_id ? (
                    <span className="font-mono">proposal {a.proposal_id}</span>
                  ) : null}
                  {a.at ? <span>{humanizeAge(a.at)}</span> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </PanelCard>
  );
};

/**
 * The severity-token bar color for a 0-100 risk FACTOR. Uses the ONE palette ladder
 * (`scoreBand` — 74/48/22) so a factor bar shares cut-points with every other
 * risk-coloured element. Literal class strings so the Tailwind JIT emits them.
 */
const FACTOR_BAR_COLOR: Record<ScoreBand, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
};

export function riskFactorBarColor(value: number): string {
  return FACTOR_BAR_COLOR[scoreBand(value)];
}

const RISK_FACTOR_META = [
  {
    key: 'volume',
    label: 'Volume',
    definition:
      'Cluster event count, log-normalized against a 50-event reference so very large clusters level off.',
  },
  {
    key: 'velocity',
    label: 'Velocity',
    definition:
      'Events per minute across the observed cluster span; it saturates near 10 per minute and contributes zero below 3 events.',
  },
  {
    key: 'reputation',
    label: 'Reputation',
    definition:
      'The clamped 0–100 enrichment reputation signal supplied to deterministic scoring.',
  },
  {
    key: 'diversity',
    label: 'Diversity',
    definition: 'Distinct rule types normalized against a five-rule-type reference.',
  },
  {
    key: 'asset_criticality',
    label: 'Asset criticality',
    definition:
      'The configured exact-entity or network-policy value for the affected asset.',
  },
] as const;

type RiskFactorKey = (typeof RISK_FACTOR_META)[number]['key'];
type RiskFactor = {
  key: RiskFactorKey;
  label: string;
  value: number;
  definition: string;
  caseReason: string;
};

type RiskFactorContext = {
  eventCount: number | null;
  ruleTypeCount: number | null;
  reputationInput: number | null;
  entityType: string | null;
  entityValue: string;
};

/** Case-specific half of a factor tooltip; never reverse-engineers missing inputs. */
function riskFactorCaseReason(
  key: RiskFactorKey,
  value: number,
  context: RiskFactorContext,
): string {
  const score = Math.round(boundedScore(value));
  if (key === 'volume') {
    return context.eventCount !== null
      ? `The case records ${context.eventCount} correlated event${context.eventCount === 1 ? '' : 's'}; its stored Volume factor is ${score}/100.`
      : `The deterministic breakdown stores Volume at ${score}/100; the underlying event count is not retained in this view.`;
  }
  if (key === 'velocity') {
    if (context.eventCount !== null && context.eventCount < 3 && score === 0) {
      return `The case records ${context.eventCount} event${context.eventCount === 1 ? '' : 's'}; Velocity is 0/100 because this factor does not contribute below 3 events.`;
    }
    return `The deterministic breakdown stores Velocity at ${score}/100. This view does not retain the exact observed span, so it does not infer an event rate.`;
  }
  if (key === 'reputation') {
    if (context.reputationInput !== null) {
      return `The case enrichment record reports ${Math.round(boundedScore(context.reputationInput))}/100; the stored Reputation factor is ${score}/100.`;
    }
    return `The deterministic breakdown stores Reputation at ${score}/100; no provider-level reputation input is retained in this view${score === 0 ? ', which does not by itself prove the indicator safe' : ''}.`;
  }
  if (key === 'diversity') {
    return context.ruleTypeCount !== null
      ? `The case records ${context.ruleTypeCount} distinct rule type${context.ruleTypeCount === 1 ? '' : 's'}; its stored Diversity factor is ${score}/100.`
      : `The deterministic breakdown stores Diversity at ${score}/100; the contributing rule-type list is not retained in this view.`;
  }
  const entity = context.entityValue
    ? `${context.entityType ? `${humanizeToken(context.entityType)} ` : ''}${context.entityValue}`
    : 'the affected entity';
  return `For ${entity}, the deterministic breakdown stores Asset criticality at ${score}/100; the configured policy entry itself is not exposed here.`;
}

/**
 * Five recorded deterministic risk inputs. Each label is a real focusable Tooltip
 * trigger: hover and keyboard focus explain both the engine meaning and the exact
 * case fact we possess. The rows never infer a missing event span/provider/policy.
 */
const RiskFactorProfile: React.FC<{ factors: RiskFactor[] }> = ({ factors }) => {
  if (!factors.length) return null;
  return (
    <TooltipProvider delayDuration={0}>
      <div
        className="pt-1"
        role="group"
        aria-label="Recorded risk factors"
      >
        <div className="mb-2">
          <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
            Recorded risk factors
          </span>
        </div>
        <div
          data-testid="risk-factor-grid"
          className="grid min-w-0 grid-cols-[max-content_minmax(2.5rem,1fr)_2rem] items-center gap-x-2 gap-y-2"
        >
          {factors.map((factor) => {
            const value = boundedScore(factor.value);
            const rounded = Math.round(value);
            return (
              <React.Fragment key={factor.key}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Explain ${factor.label} risk factor, recorded ${rounded} out of 100`}
                      className="inline-flex items-center gap-1 whitespace-nowrap text-left text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {factor.label}
                      <Info className="h-3 w-3 shrink-0" aria-hidden />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-xs space-y-2 p-3">
                    <p className="font-semibold text-popover-foreground">
                      What {factor.label.toLowerCase()} measures
                    </p>
                    <p>{factor.definition}</p>
                    <p className="border-t border-border pt-2">
                      <span className="font-semibold text-popover-foreground">This case: </span>
                      {factor.caseReason}
                    </p>
                  </TooltipContent>
                </Tooltip>
                <div
                  role="progressbar"
                  aria-label={`${factor.label} risk factor: ${rounded} out of 100`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={rounded}
                  className="h-1.5 min-w-0 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    aria-hidden="true"
                    className={cn('h-full rounded-full', riskFactorBarColor(value))}
                    style={{ width: `${value}%` }}
                  />
                </div>
                <span className="text-right font-mono text-2xs tabular-nums text-foreground">
                  {rounded}
                </span>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
};

/* ----------------------------------------------- anomaly baseline (advisory) */

/**
 * Advisory anomaly-baseline panel (#4). When the case has a cluster signature AND the
 * baseline has recorded stats for it, this embeds the ready-made `BaselineSignatureCard`.
 * Fully additive + FAIL-QUIET: no signature, a disabled baseline, an unseen signature
 * (`found=false`), or a fetch error all render NOTHING. READ-ONLY / advisory (#3/#4).
 * `signature` is source-derived and the card renders it as a plain text node only (#9).
 */
const BaselineAdvisory: React.FC<{ c: Case; flat?: boolean }> = ({ c, flat = false }) => {
  const signature =
    typeof c.cluster_signature === 'string' ? c.cluster_signature.trim() : '';
  const [data, setData] = React.useState<BaselineSignature | null>(null);

  React.useEffect(() => {
    if (!signature) {
      setData(null);
      return;
    }
    let cancelled = false;
    void baselineApi
      .signature(signature)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [signature]);

  if (!signature || !data || !data.found) return null;

  return (
    <PanelCard
      data-overview-surface={flat ? 'flat-section' : undefined}
      className={cn(flat && EMBEDDED_FLAT_SECTION)}
    >
      <BaselineSignatureCard data={data} embedded />
    </PanelCard>
  );
};

/* --------------------------------------------------------------- component -- */

export const OverviewPanel: React.FC<{
  c: Case;
  fpPolicy: FpPolicy;
  triage: TriageChips | null;
  triageLoading: boolean;
  rationale?: CaseRationale | null;
  rationaleLoading?: boolean;
  rationaleError?: unknown;
  onRetryRationale?: () => void;
  onOpenInvestigation?: () => void;
  onNavigate?: Navigate;
  presentation?: CasePanelPresentation;
}> = ({
  c,
  fpPolicy,
  triage,
  triageLoading,
  rationale = null,
  rationaleLoading = false,
  rationaleError,
  onRetryRationale,
  onOpenInvestigation,
  onNavigate,
  presentation = 'default',
}) => {
  const isCaseManager = presentation === 'case-manager';
  const trigger = c.trigger_reason as
    | {
        sentence?: string;
        observed_count?: number;
        rule_values?: unknown[];
        entity?: string;
      }
    | undefined;
  const triggerSentence = trigger?.sentence;
  const allEvidence = c.evidence || [];
  const ruledOut = allEvidence.filter((e) => isRuledOut(e.summary));
  const evidence = allEvidence.filter((e) => !isRuledOut(e.summary));
  const mitre = c.mitre || [];
  const ruleIds = (c.rule_ids || []).filter((r) => typeof r === 'string' && r.trim());
  const appVersion = typeof c.app_version === 'string' ? c.app_version.trim() : '';
  const buildSha = typeof c.build_sha === 'string' ? c.build_sha.trim() : '';
  const buildLabel =
    appVersion || buildSha
      ? `${appVersion ? `v${appVersion}` : 'version unavailable'} · ${
          buildSha
            ? buildSha === 'unknown'
              ? 'SHA unknown'
              : buildSha.slice(0, 12)
            : 'SHA unavailable'
        }`
      : '';

  const caseEnrichment =
    c.enrichment && typeof c.enrichment === 'object'
      ? (c.enrichment as Record<string, unknown>)
      : null;
  const entityType = c.entity?.type || c.entity_type || null;
  const entityValue = c.entity?.value || '';

  const relatedCount = (Array.isArray(c.related_case_ids) ? c.related_case_ids : []).filter(
    (rid) => typeof rid === 'string' && rid && rid !== c.case_id,
  ).length;

  // ---- source-reported severity vs. our derived risk (task 6) --------------- //
  const sevSource = triage?.severity?.source ?? c.severity_source;
  const sevBandRaw = triage?.severity?.band ?? c.severity_band;
  const sourceSevBand = severityBand(sevBandRaw ?? null); // normalized band | null
  const isSourceAsserted = sevSource === 'source_asserted';
  const sevLabel = sourceSevBand ? titleBand(sourceSevBand) : '';

  const riskVal =
    typeof triage?.risk?.value === 'number' ? triage.risk.value : c.risk_score;
  const ourRiskBand: ScoreBand | null = typeof riskVal === 'number' ? scoreBand(riskVal) : null;
  const riskLabel = ourRiskBand ? titleBand(ourRiskBand) : '';
  const confidencePercent =
    typeof c.confidence === 'number'
      ? boundedScore(c.confidence <= 1 ? c.confidence * 100 : c.confidence)
      : null;

  const caseRiskBreakdown =
    c.risk_breakdown && typeof c.risk_breakdown === 'object'
      ? (c.risk_breakdown as Record<string, unknown>)
      : null;
  const recordedRiskBreakdown = triage?.risk?.breakdown ?? caseRiskBreakdown;
  const memberEventCount = c.member_event_keys?.length || c.member_event_ids?.length || 0;
  const observedCount =
    typeof trigger?.observed_count === 'number' && Number.isFinite(trigger.observed_count)
      ? Math.max(0, Math.round(trigger.observed_count))
      : null;
  const eventCount = memberEventCount > 0 ? memberEventCount : observedCount;
  const triggerRuleValues = Array.isArray(trigger?.rule_values)
    ? trigger.rule_values.filter((value): value is string => typeof value === 'string' && !!value)
    : [];
  const distinctRuleCount = new Set(triggerRuleValues.length ? triggerRuleValues : ruleIds).size;
  const reputationInput =
    typeof caseEnrichment?.reputation_score === 'number' &&
    Number.isFinite(caseEnrichment.reputation_score)
      ? caseEnrichment.reputation_score
      : null;
  const factorContext: RiskFactorContext = {
    eventCount,
    ruleTypeCount: distinctRuleCount > 0 ? distinctRuleCount : null,
    reputationInput,
    entityType,
    entityValue: entityValue || trigger?.entity || '',
  };
  const riskFactors: RiskFactor[] = recordedRiskBreakdown
    ? RISK_FACTOR_META.flatMap(({ key, label, definition }) => {
        const raw = recordedRiskBreakdown[key];
        return typeof raw === 'number' && Number.isFinite(raw)
          ? [
              {
                key,
                label,
                value: raw,
                definition,
                caseReason: riskFactorCaseReason(key, raw, factorContext),
              },
            ]
          : [];
      })
    : [];

  // The delta cue — the source asserted a severity AND it disagrees with our risk band.
  // `info` only exists on the 5-band severity ladder, never on the 4-band risk ladder, so
  // an 'info' source severity would ALWAYS "disagree" with any risk band — exclude it.
  const showSeverityDelta =
    isSourceAsserted &&
    !!sourceSevBand &&
    sourceSevBand !== 'info' &&
    !!ourRiskBand &&
    sourceSevBand !== ourRiskBand;

  const sourceFactsPresent = Boolean(
    (isSourceAsserted && sevBandRaw) || ruleIds.length || c.source_name || triggerSentence,
  );

  // Verdict/status headline for the brief.
  const vHead = verdictHeadline(c.verdict);
  const headline = decisionHeadline(c.verdict, c.status);
  const summarySentence = firstSentence(c.summary);

  // The brief chip row values (triage-preferred, case-fallback).
  const impactLevel = triage?.impact?.band ?? c.impact_band;
  const priorityLevel = triage?.priority?.level ?? triage?.priority?.default ?? c.priority_level;
  const briefChips: Array<{ label: string; value: string }> = [
    { label: 'Verdict', value: c.verdict ? humanizeToken(c.verdict) : DASH },
    { label: 'Confidence', value: fmtPercent(c.confidence) },
    { label: 'Risk', value: typeof riskVal === 'number' ? `${Math.round(riskVal)}/100` : DASH },
    { label: 'Impact', value: chipLabel(impactLevel) },
    { label: 'Priority', value: chipLabel(priorityLevel) },
    { label: 'Result', value: c.status ? humanizeToken(c.status) : DASH },
  ];

  const autoClose = autoCloseSummary(fpPolicy, c);

  // Primary-entity scope (Internal / External) — best-effort, omitted when unknown.
  const entityScope: 'Internal' | 'External' | null = (() => {
    if (!entityValue) return null;
    if (entityType === 'host' || entityType === 'user') return 'Internal';
    if (entityType === 'ip') return isPrivateIp(entityValue) ? 'Internal' : 'External';
    return null;
  })();

  // Enrichment KV rows for the PRIMARY ENTITY card (known scalar keys only).
  const ENTITY_ENRICH_KEYS: Array<{ key: string; label: string }> = [
    { key: 'reputation_score', label: 'Reputation' },
    { key: 'country', label: 'Country' },
    { key: 'asn', label: 'ASN' },
    { key: 'org', label: 'Org' },
    { key: 'first_seen', label: 'First seen' },
    { key: 'last_seen', label: 'Last seen' },
  ];
  const entityEnrichRows: Array<{ k: string; v: string }> = [];
  if (caseEnrichment) {
    for (const { key, label } of ENTITY_ENRICH_KEYS) {
      const v = caseEnrichment[key];
      if (v === null || v === undefined || typeof v === 'object') continue;
      entityEnrichRows.push({ k: label, v: String(v) });
    }
  }

  // Mini attack story — derived from case fields (no stages fetch on the Overview).
  const storySteps: Array<{ label: string; detail: string; done: boolean; icon: React.ComponentType<{ className?: string }> }> = [
    {
      icon: Database,
      label: 'Detection rule fired',
      detail: ruleIds[0] || c.source_name || 'Alert received from the source',
      done: Boolean(ruleIds.length || triggerSentence || c.source_name),
    },
    {
      icon: Target,
      label: 'Agent searched the logs',
      detail: allEvidence.length
        ? `${allEvidence.length} finding${allEvidence.length === 1 ? '' : 's'} gathered`
        : 'No log evidence recorded',
      done: allEvidence.length > 0,
    },
    {
      icon: Globe,
      label: 'Reputation & intel checked',
      detail: mitre.length
        ? `${mitre.length} MITRE technique${mitre.length === 1 ? '' : 's'} mapped`
        : ruledOut.length
          ? 'Indicators checked & cleared'
          : 'No intel matches recorded',
      done: mitre.length > 0 || ruledOut.length > 0,
    },
    {
      icon: ShieldCheck,
      label: 'Case-manager routed',
      detail: `${c.status ? humanizeToken(c.status) : 'Routed'}${c.decision_by ? ` · ${humanizeToken(c.decision_by)}` : ''}`,
      done: Boolean(c.status || c.decision_by),
    },
  ];

  // Entity-relationship flow: entity → rule → surface.
  const relationshipFlow = [
    { label: entityType ? humanizeToken(entityType) : 'Entity', value: entityValue || DASH },
    { label: 'Detection', value: ruleIds[0] || 'Rule' },
    { label: 'Surface', value: c.source_name || c.source_surface || 'Log surface' },
  ];

  // Evidence checklist rows (positive findings + ruled-out/clean checks).
  const checklistRows: Array<{
    check: string;
    result: 'found' | 'clear';
    evidence?: string;
    impact: string;
  }> = [
    ...evidence.map((ev, i) => ({
      check: ev.summary ? firstSentence(ev.summary) : `Evidence ${i + 1}`,
      result: 'found' as const,
      evidence: ev.query,
      impact: 'Raises severity',
    })),
    ...ruledOut.map((ev, i) => ({
      check: ev.summary ? firstSentence(ev.summary) : `Check ${i + 1}`,
      result: 'clear' as const,
      evidence: ev.query,
      impact: 'Lowers severity',
    })),
  ];

  // Reproduce-investigation queries (read-only ES/log searches + reproduce query).
  const reproduceQueries = evidence.filter((e) => e.query);
  const hasReproduce = reproduceQueries.length > 0 || Boolean(c.reproduce_query);

  return (
    <div
      className={cn(
        isCaseManager ? cn('space-y-4', CASE_MANAGER_PANEL_PADDING) : 'space-y-6 p-6',
      )}
      data-case-panel={isCaseManager ? 'overview' : undefined}
      data-presentation={isCaseManager ? 'case-manager' : undefined}
    >
      {/* ============================================== 1. DECISION BRIEF */}
      <PanelCard
        data-testid={isCaseManager ? 'case-manager-decision-summary' : undefined}
        data-overview-surface={isCaseManager ? 'flat-summary' : undefined}
        className={cn(
          isCaseManager
            ? 'relative overflow-hidden rounded-none border-0 bg-transparent px-0 py-1 shadow-none'
            : 'relative overflow-hidden border-l-2',
          !isCaseManager && {
            'border-l-critical/50': vHead.tone === 'critical',
            'border-l-high/50': vHead.tone === 'high',
            'border-l-medium/50': vHead.tone === 'medium',
            'border-l-low/50': vHead.tone === 'low',
            'border-l-info/50': vHead.tone === 'info',
          },
        )}
      >
        {isCaseManager ? (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]">
            <div className="min-w-0">
              {/* Verdict headline — our own controlled copy. */}
              <h2 className="text-3xl font-semibold leading-tight tracking-tight text-foreground">
                {headline}
              </h2>
              {summarySentence ? (
                /* UNTRUSTED summary — plain text. */
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {summarySentence}
                </p>
              ) : null}

              {/* The route, disposition, and escalation each appear exactly once. */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <StatusBadge status={c.status} />
                <DispositionBadge disposition={c.disposition ?? null} />
                {typeof c.escalation_level === 'number' &&
                c.escalation_level > 0 &&
                String(c.status || '').toLowerCase() !== 'escalated' ? (
                  <Badge variant="critical" className="gap-1">
                    <Bell className="h-3 w-3" />
                    Escalated
                  </Badge>
                ) : null}
                <AutoClosedBadge
                  status={c.status}
                  decisionBy={c.decision_by}
                  objectionWindowExpiresAt={c.objection_window_expires_at}
                  showObjection
                />
              </div>

              {/* Advisory ordering fields remain visible without repeating route/risk. */}
              <div className="mt-5 grid max-w-sm grid-cols-2 gap-5">
                <BriefChip label="Impact" value={chipLabel(impactLevel)} />
                <BriefChip label="Priority" value={chipLabel(priorityLevel)} />
              </div>

              {/* The action is prominent without introducing another bordered card. */}
              <div className="mt-5 border-l-2 border-primary/40 py-1 pl-4">
                <div className="mb-2 flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" aria-hidden />
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">
                    Recommended action
                  </h3>
                </div>
                {/* UNTRUSTED — plain text. */}
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                  {c.recommended_action || DASH}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Use the case action controls to close or escalate — the deterministic close /
                  escalate decision is always made by code, never by this panel.
                </p>
                {autoClose ? (
                  <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>{autoClose.line}</span>
                  </div>
                ) : null}
              </div>
            </div>

            <aside
              aria-label="Case signal profile"
              className="space-y-4 border-t border-border/60 pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0"
            >
              <div className="flex items-center gap-2">
                <Gauge className="h-4 w-4 text-primary" aria-hidden />
                <h3 className="text-sm font-semibold tracking-tight text-foreground">
                  Signal profile
                </h3>
              </div>
              {typeof riskVal === 'number' && ourRiskBand ? (
                <SignalMeter
                  label="Risk score"
                  value={riskVal}
                  display={`${Math.round(boundedScore(riskVal))}/100`}
                  tone={ourRiskBand}
                  description="Deterministic case input"
                />
              ) : null}
              {confidencePercent !== null ? (
                <SignalMeter
                  label="Confidence"
                  value={confidencePercent}
                  display={`${Math.round(confidencePercent)}%`}
                  tone="primary"
                  description="Agent assessment"
                />
              ) : null}
              <RiskFactorProfile factors={riskFactors} />
              {typeof riskVal !== 'number' && confidencePercent === null && !riskFactors.length ? (
                <p className="text-sm text-muted-foreground">No scored signals recorded.</p>
              ) : null}
            </aside>
          </div>
        ) : (
          <>
            <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
              Decision brief
            </span>
            {/* Verdict headline — our own controlled copy. */}
            <h2 className="mt-1 text-2xl font-bold leading-tight tracking-tight text-foreground">
              {headline}
            </h2>
            {summarySentence ? (
              /* UNTRUSTED summary — plain text. */
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {summarySentence}
              </p>
            ) : null}

            {/* compact chip row */}
            {triageLoading && !triage ? (
              <Skeleton className="mt-4 h-10 w-full max-w-xl" />
            ) : (
              <div className="mt-4 flex flex-wrap items-stretch gap-x-6 gap-y-3">
                {briefChips.map((chip) => (
                  <BriefChip key={chip.label} label={chip.label} value={chip.value} />
                ))}
              </div>
            )}

            {/* status / disposition / escalation strip */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <StatusBadge status={c.status} />
              <DispositionBadge disposition={c.disposition ?? null} />
              {typeof c.escalation_level === 'number' &&
              c.escalation_level > 0 &&
              String(c.status || '').toLowerCase() !== 'escalated' ? (
                <Badge variant="critical" className="gap-1">
                  <Bell className="h-3 w-3" />
                  Escalated
                </Badge>
              ) : null}
            </div>

            {/* recommended action sub-panel */}
            <div className="mt-4 rounded-lg border border-border bg-muted/30 p-4">
              <div className="mb-2 flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
                <h3 className="text-sm font-semibold tracking-tight text-foreground">
                  Recommended action
                </h3>
              </div>
              {/* UNTRUSTED — plain text. */}
              <p className="whitespace-pre-wrap text-sm text-foreground/90">
                {c.recommended_action || DASH}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Use the case action controls to close or escalate — the deterministic close /
                escalate decision is always made by code, never by this panel.
              </p>
              {autoClose ? (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>{autoClose.line}</span>
                </div>
              ) : null}
            </div>
          </>
        )}
      </PanelCard>

      {isCaseManager ? (
        <InvestigationInputs
          rationale={rationale}
          loading={rationaleLoading}
          error={rationaleError}
          onRetry={onRetryRationale}
          onReview={onOpenInvestigation}
        />
      ) : null}

      {/* ============================================== 2. PROVENANCE ROW */}
      <div
        className={cn('space-y-4', isCaseManager && EMBEDDED_MAJOR_SECTION)}
        data-case-manager-section={isCaseManager ? 'provenance' : undefined}
      >
        <SectionLabel testId="overview-section-label" quiet={isCaseManager}>
          Provenance
        </SectionLabel>

        {/* delta cue — source severity vs. our risk band, only when they disagree. */}
        {showSeverityDelta ? (
          <div
            data-testid="source-assessment-delta"
            className={cn(
              'flex flex-wrap items-center gap-x-2 gap-y-1 text-sm',
              isCaseManager
                ? 'rounded-sm bg-primary/5 px-3 py-2'
                : 'rounded-md border border-primary/30 bg-primary/5 px-3 py-2',
            )}
          >
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <Database className="h-3.5 w-3.5 text-info-text" aria-hidden />
              Source severity: <span className="font-semibold">{sevLabel}</span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="inline-flex items-center gap-1.5 text-foreground">
              We assess: <span className="font-semibold">{riskLabel} risk</span>
            </span>
          </div>
        ) : null}

        <div className={cn('grid lg:grid-cols-3', isCaseManager ? 'gap-6 xl:gap-8' : 'gap-4')}>
          {/* SOURCE SAYS */}
          <ProvenanceColumn
            title="Source says"
            kind="source"
            icon={Database}
            compact={isCaseManager}
          >
            {sourceFactsPresent ? (
              <>
                {isSourceAsserted && sevBandRaw ? (
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                        Reported severity
                      </span>
                      <SeverityBadge severity={sevBandRaw} />
                      <ProvenanceTag kind={severityProvenance(sevSource)} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      The source rated this alert {sevLabel} severity.
                    </p>
                  </div>
                ) : null}
                {ruleIds.length ? (
                  <div className="space-y-1.5">
                    <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                      Detection rule{ruleIds.length === 1 ? '' : 's'}
                    </span>
                    <div className="flex min-w-0 flex-wrap gap-1.5">
                      {/* UNTRUSTED rule ids — plain text nodes, mono. Long rule names
                          must wrap inside the chip, never force the card wider
                          (`whitespace-normal break-all` overrides the Badge's
                          default `whitespace-nowrap` — both are in tailwind-merge's
                          `whitespace` class group so the override wins). `min-w-0`
                          must live on the Badge ITSELF — that's the flex item whose
                          automatic min-width needs zeroing; a space-less/hyphen-less
                          id (e.g. "demo_rdp_bruteforce" or a long
                          Trojan_Generic_..._Detected style id) has no soft-wrap
                          points, so `break-words` (overflow-wrap) never kicks in and
                          the item keeps overflowing — `break-all` (word-break) DOES
                          reduce min-content size per spec and matches this file's
                          own convention for other UNTRUSTED long strings (see the
                          InlineCode `break-all` usage above). */}
                      {ruleIds.map((r, i) => (
                        <Badge
                          key={`${r}-${i}`}
                          variant="outline"
                          className="min-w-0 max-w-full whitespace-normal break-all font-mono"
                        >
                          {r}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
                {c.source_name ? <MetaItem label="Source" value={c.source_name} /> : null}
                {triggerSentence ? (
                  <div className="space-y-1">
                    <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                      Why it fired
                    </span>
                    {/* UNTRUSTED — plain text. */}
                    <p className="text-sm leading-relaxed text-foreground/90">{triggerSentence}</p>
                  </div>
                ) : null}
              </>
            ) : (
              <EmptyState icon={Database} compact title="No source-provided facts" />
            )}
          </ProvenanceColumn>

          {/* AGENT FOUND */}
          <ProvenanceColumn
            title="Agent found"
            kind="ai"
            icon={Bot}
            compact={isCaseManager}
          >
            {!isCaseManager ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="inline-flex items-center gap-1.5">
                  <VerdictBadge verdict={c.verdict} />
                  <ProvenanceTag kind="ai" />
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <ConfidenceBadge
                    confidence={c.confidence}
                    {...confidenceCalibration(fpPolicy, c.verdict)}
                  />
                  <ProvenanceTag kind="ai" />
                </span>
              </div>
            ) : null}
            <ul className="space-y-2 text-sm">
              {evidence.length ? (
                <li>
                  <AgentFindingMetric
                    icon={CheckCircle2}
                    tone="text-info-text"
                    label={
                      <>
                        {evidence.length} matching finding{evidence.length === 1 ? '' : 's'} in the logs
                      </>
                    }
                    detail={
                      <>
                        <p className="font-semibold">Persisted findings for this case</p>
                        <ul className="space-y-1">
                          {evidence.map((item, index) => (
                            <li key={`${item.summary}-${index}`}>
                              <span className="font-mono text-muted-foreground">{index + 1}.</span>{' '}
                              <span>{item.summary || 'Finding recorded without a summary.'}</span>
                              {item.event_ids?.length ? (
                                <span className="text-muted-foreground">
                                  {' '}· {item.event_ids.length} supporting event{item.event_ids.length === 1 ? '' : 's'}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </>
                    }
                  />
                </li>
              ) : null}
              {ruledOut.length ? (
                <li>
                  <AgentFindingMetric
                    icon={CheckCircle2}
                    tone="text-success"
                    label={
                      <>
                        {ruledOut.length} check{ruledOut.length === 1 ? '' : 's'} came back clean — no
                        additional activity
                      </>
                    }
                    detail={
                      <>
                        <p className="font-semibold">Checks recorded as clean</p>
                        <ul className="space-y-1">
                          {ruledOut.map((item, index) => (
                            <li key={`${item.summary}-${index}`}>
                              <span className="font-mono text-muted-foreground">{index + 1}.</span>{' '}
                              <span>{item.summary || 'Clean check recorded without a summary.'}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    }
                  />
                </li>
              ) : null}
              {relatedCount ? (
                <li>
                  <AgentFindingMetric
                    icon={Link2}
                    label={
                      <>{relatedCount} prior analogous case{relatedCount === 1 ? '' : 's'}</>
                    }
                    detail={
                      <>
                        <p className="font-semibold">Related case IDs</p>
                        <p className="break-all font-mono text-muted-foreground">
                          {(c.related_case_ids || []).filter((rid) => rid && rid !== c.case_id).join(', ')}
                        </p>
                        <p className="text-muted-foreground">
                          These are persisted cross-source relationships, not merged or duplicated cases.
                        </p>
                      </>
                    }
                  />
                </li>
              ) : null}
              {mitre.length ? (
                <li>
                  <AgentFindingMetric
                    icon={Shield}
                    label={
                      <>
                        {mitre.length} MITRE technique{mitre.length === 1 ? '' : 's'} mapped — full detail
                        on the Threat context tab
                      </>
                    }
                    detail={
                      <>
                        <p className="font-semibold">Mapped technique IDs</p>
                        <p className="break-words font-mono text-muted-foreground">{mitre.join(', ')}</p>
                        <p className="text-muted-foreground">
                          Open Threat context for names, tactics, reputation, and the clustering path.
                        </p>
                      </>
                    }
                  />
                </li>
              ) : null}
              {!evidence.length && !ruledOut.length && !relatedCount && !mitre.length ? (
                <li className="text-muted-foreground">
                  No additional findings were recorded by the investigation.
                </li>
              ) : null}
            </ul>
          </ProvenanceColumn>

          {/* CODE DECIDED */}
          <ProvenanceColumn
            title="Code decided"
            kind="code"
            icon={ShieldCheck}
            compact={isCaseManager}
          >
            {isCaseManager ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-muted/25 px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <Lock className="h-3.5 w-3.5 text-success" aria-hidden />
                    Deterministic decision authority
                  </span>
                  <Badge variant="success" className="font-mono">
                    case_manager
                  </Badge>
                </div>
                <dl className="space-y-2.5 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      Authority
                    </dt>
                    <dd className="text-right text-foreground">
                      {/* UNTRUSTED decider token — plain text. */}
                      {c.decision_by ? humanizeToken(c.decision_by) : 'Deterministic code'}
                    </dd>
                  </div>
                  {autoClose ? (
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                        Auto-close
                      </dt>
                      <dd className="text-right text-xs text-foreground/90">{autoClose.tag}</dd>
                    </div>
                  ) : null}
                </dl>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  The close / escalate call is made by deterministic code against the
                  operator-configured policy — never by raw model output.
                </p>
                {c.objection_window_expires_at &&
                !isAutoClosedByAI(c.status, c.decision_by) ? (
                  <p className="text-xs text-muted-foreground">
                    Objection window open until {formatTimestamp(c.objection_window_expires_at)}.
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <dl className="space-y-2.5 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      Risk score
                    </dt>
                    <dd className="font-mono text-foreground tabular-nums">
                      {typeof riskVal === 'number' ? `${Math.round(riskVal)}/100` : DASH}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      Final route
                    </dt>
                    <dd>
                      <StatusBadge status={c.status} />
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      Authority
                    </dt>
                    <dd className="text-right text-foreground">
                      {/* UNTRUSTED decider token — plain text. */}
                      {c.decision_by ? humanizeToken(c.decision_by) : 'Deterministic code'}
                    </dd>
                  </div>
                  {autoClose ? (
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                        Auto-close
                      </dt>
                      <dd className="text-right text-xs text-foreground/90">{autoClose.tag}</dd>
                    </div>
                  ) : null}
                </dl>
                <p className="text-xs text-muted-foreground">
                  The close / escalate call is made by deterministic code against the
                  operator-configured policy — never by raw model output.
                </p>
              </>
            )}
          </ProvenanceColumn>
        </div>

        {/* The default sheet retains the pinned deterministic decision card. The embedded
            workspace has already consolidated those same case-field projections into the
            CODE DECIDED lane above, so rendering the card there would repeat verdict,
            confidence, risk, and result. Exact policy clause + trace remain on Investigation. */}
        {!isCaseManager ? <DecisionCard c={c} rationale={null} timeline={null} /> : null}
      </div>

      {/* ============================================== 3. ENTITY ROW */}
      <div
        className={cn('space-y-4', isCaseManager && EMBEDDED_MAJOR_SECTION)}
        data-case-manager-section={isCaseManager ? 'entity-story' : undefined}
      >
        <SectionLabel testId="overview-section-label" quiet={isCaseManager}>
          Entity &amp; story
        </SectionLabel>
        <div className={cn('grid lg:grid-cols-3', isCaseManager ? 'gap-6 xl:gap-8' : 'gap-4')}>
          {/* PRIMARY ENTITY */}
          <PanelCard
            data-overview-surface={isCaseManager ? 'flat-column' : undefined}
            className={cn(isCaseManager && EMBEDDED_FLAT_COLUMN)}
          >
            <SectionHeading icon={Crosshair}>Primary entity</SectionHeading>
            {entityValue ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  {/* UNTRUSTED entity value — inside an InlineCode fence. */}
                  <InlineCode className="break-all">{entityValue}</InlineCode>
                  {entityScope ? (
                    <Badge variant={entityScope === 'External' ? 'high' : 'outline'}>
                      {entityScope}
                    </Badge>
                  ) : null}
                  <Badge variant="outline">
                    {entityType ? humanizeToken(entityType) : 'Entity'}
                  </Badge>
                </div>
                {entityEnrichRows.length ? (
                  <dl className={cn(!isCaseManager && 'divide-y divide-border')}>
                    {entityEnrichRows.map((row, i) => (
                      <div
                        key={`${row.k}-${i}`}
                        className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                      >
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                          {row.k}
                        </dt>
                        {/* UNTRUSTED enrichment value — plain text, mono. */}
                        <dd className="min-w-0 truncate text-right font-mono text-sm text-foreground">
                          {row.v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <CopyChip value={entityValue} label="Copy indicator" />
                </div>
              </div>
            ) : (
              <EmptyState icon={Crosshair} compact title="No primary entity recorded" />
            )}
          </PanelCard>

          {/* MINI ATTACK STORY */}
          <PanelCard
            data-overview-surface={isCaseManager ? 'flat-column' : undefined}
            className={cn(isCaseManager && EMBEDDED_FLAT_COLUMN)}
          >
            <SectionHeading icon={Activity}>Attack story</SectionHeading>
            <ol className="relative space-y-4 border-l border-border pl-5">
              {storySteps.map((step, i) => {
                const StepIcon = step.icon;
                return (
                  <li key={i} className="relative">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute -left-[1.65rem] top-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-card',
                        step.done ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <StepIcon className="h-3 w-3" />
                    </span>
                    <p className="text-sm font-medium text-foreground">{step.label}</p>
                    {/* UNTRUSTED detail (rule id / source / status) — plain text. */}
                    <p className="text-xs text-muted-foreground">{step.detail}</p>
                  </li>
                );
              })}
            </ol>
          </PanelCard>

          {/* ENTITY RELATIONSHIP */}
          <PanelCard
            data-overview-surface={isCaseManager ? 'flat-column' : undefined}
            className={cn(isCaseManager && EMBEDDED_FLAT_COLUMN)}
          >
            <SectionHeading icon={GitBranch}>Entity relationship</SectionHeading>
            <div className="flex flex-col gap-2">
              {relationshipFlow.map((node, i) => (
                <React.Fragment key={node.label}>
                  <div
                    className={cn(
                      'rounded-md px-3 py-2',
                      isCaseManager ? 'bg-muted/25' : 'border border-border bg-muted/30',
                    )}
                  >
                    <div className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                      {node.label}
                    </div>
                    {/* UNTRUSTED value — plain text, mono, wrapping. */}
                    <div className="mt-0.5 break-all font-mono text-sm text-foreground">
                      {node.value}
                    </div>
                  </div>
                  {i < relationshipFlow.length - 1 ? (
                    <ArrowRight
                      className="mx-auto h-4 w-4 rotate-90 text-muted-foreground"
                      aria-hidden
                    />
                  ) : null}
                </React.Fragment>
              ))}
            </div>
          </PanelCard>
        </div>
      </div>

      {/* anomaly baseline (advisory, #4) — fail-quiet, renders nothing when absent. */}
      <BaselineAdvisory c={c} flat={isCaseManager} />

      {/* ============================================== 4. EVIDENCE */}
      <div
        className={cn('space-y-4', isCaseManager && EMBEDDED_MAJOR_SECTION)}
        data-case-manager-section={isCaseManager ? 'evidence' : undefined}
      >
        <SectionLabel testId="overview-section-label" quiet={isCaseManager}>
          Evidence
        </SectionLabel>
        <div className={cn('grid lg:grid-cols-3', isCaseManager ? 'gap-6 xl:gap-8' : 'gap-4')}>
          {/* EVIDENCE CHECKLIST */}
          <PanelCard
            data-overview-surface={isCaseManager ? 'flat-column' : undefined}
            className={cn('lg:col-span-2', isCaseManager && EMBEDDED_FLAT_COLUMN)}
          >
            <SectionHeading icon={Search}>Evidence checklist</SectionHeading>
            {checklistRows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th
                        scope="col"
                        className="pb-2 pr-3 text-2xs font-semibold uppercase tracking-widest text-muted-foreground"
                      >
                        Check
                      </th>
                      <th
                        scope="col"
                        className="pb-2 pr-3 text-2xs font-semibold uppercase tracking-widest text-muted-foreground"
                      >
                        Result
                      </th>
                      <th
                        scope="col"
                        className="pb-2 pr-3 text-2xs font-semibold uppercase tracking-widest text-muted-foreground"
                      >
                        Evidence
                      </th>
                      <th
                        scope="col"
                        className="pb-2 text-2xs font-semibold uppercase tracking-widest text-muted-foreground"
                      >
                        Confidence impact
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {checklistRows.map((row, i) => (
                      <tr key={i} className="align-top">
                        {/* UNTRUSTED check subject — plain text. */}
                        <td className="max-w-[16rem] py-2.5 pr-3 text-foreground/90">{row.check}</td>
                        <td className="py-2.5 pr-3">
                          <Badge variant={row.result === 'found' ? 'high' : 'success'}>
                            {row.result === 'found' ? 'Found' : 'Clear'}
                          </Badge>
                        </td>
                        <td className="py-2.5 pr-3">
                          {row.evidence ? (
                            /* UNTRUSTED query — inside an InlineCode fence. */
                            <InlineCode className="break-all text-xs">{row.evidence}</InlineCode>
                          ) : (
                            <span className="text-muted-foreground">{DASH}</span>
                          )}
                        </td>
                        <td className="py-2.5 text-xs text-muted-foreground">{row.impact}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                icon={Search}
                compact
                title="No evidence recorded"
                description="No positive findings or ruled-out checks were captured for this case."
              />
            )}
          </PanelCard>

          {/* REPRODUCE INVESTIGATION */}
          <PanelCard
            data-overview-surface={isCaseManager ? 'flat-column' : undefined}
            className={cn(isCaseManager && EMBEDDED_FLAT_COLUMN)}
          >
            <SectionHeading icon={Target}>Reproduce investigation</SectionHeading>
            {hasReproduce ? (
              <div className="space-y-3">
                {reproduceQueries.map((e, i) => (
                  <div key={i} className="space-y-1.5">
                    <Badge variant="outline" className="font-mono">
                      Search query
                    </Badge>
                    {/* UNTRUSTED query — inside a CodeBlock fence, copyable. */}
                    <CodeBlock value={e.query} copyable wrap maxHeightClassName="max-h-40" />
                  </div>
                ))}
                {c.reproduce_query ? (
                  <div className="space-y-1.5">
                    <Badge variant="outline" className="font-mono">
                      Reproduce query
                    </Badge>
                    <CodeBlock
                      value={c.reproduce_query}
                      caption="read-only"
                      copyable
                      wrap
                      maxHeightClassName="max-h-40"
                    />
                  </div>
                ) : null}
              </div>
            ) : (
              <EmptyState icon={Target} compact title="No reproducible query recorded" />
            )}
          </PanelCard>
        </div>
      </div>

      {/* ============================================== 5. COLLAPSIBLES */}
      {relatedCount || c.source_breakdown || c.cross_source_cluster_id ? (
        <CollapsibleSection label="Related cases" icon={GitBranch}>
          <RelatedCrossSource c={c} onNavigate={onNavigate} flat={isCaseManager} />
        </CollapsibleSection>
      ) : null}

      <CollapsibleSection label="Provenance & audit" icon={History}>
        {/* threshold automation (F10) */}
        <AutomationApplied c={c} flat={isCaseManager} />
        {/* status timeline (F8) */}
        <StatusTimeline
          history={c.status_history}
          statusReason={c.status_reason}
          flat={isCaseManager}
        />
        {/* run/cost meta — OUR processing metadata. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
          {c.created_at ? <span>Created {formatTimestamp(c.created_at)}</span> : null}
          {c.updated_at ? <span>Processed {formatTimestamp(c.updated_at)}</span> : null}
          <span
            title={
              buildLabel
                ? `Creation build ${appVersion || 'unavailable'} · ${buildSha || 'unavailable'}`
                : undefined
            }
          >
            {buildLabel
              ? `Creation build ${buildLabel}`
              : 'Creation build provenance unavailable'}
          </span>
          {/* UNTRUSTED profile (playbook id / persona) — plain text. */}
          {c.playbook_id ? <span>Playbook {c.playbook_id}</span> : null}
          {c.agent_persona && c.agent_persona !== 'generalist' ? (
            <span>Profile {humanizeToken(c.agent_persona)}</span>
          ) : null}
          <span>Investigation cost {fmtMoney(c.token_cost)}</span>
          {c.decision_by ? <span>Decided by {humanizeToken(c.decision_by)}</span> : null}
        </div>
      </CollapsibleSection>

      {c.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Investigation error</AlertTitle>
          {/* UNTRUSTED — plain text. */}
          <AlertDescription className="whitespace-pre-wrap">{c.error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
};

export default OverviewPanel;
