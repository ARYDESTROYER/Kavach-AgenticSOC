/**
 * Cases — the analyst triage surface (new command-center UI).
 *
 * Lists recent cases (GET /api/cases, single capped fetch) in a dense DataTable
 * with a filter bar (search + Status/Severity/Assignee selects), client-side
 * sort, pagination, row-selection with a bulk-action bar, and an honest "N of M"
 * count. Opening a row performs a short, announced handoff into Case Manager with
 * that exact case selected; Case Manager is the canonical detail workspace.
 *
 * All narrowing is CLIENT-SIDE over the loaded list. Filter state SELF-HEALS: any
 * selected facet value that no longer exists after a reload is dropped so the list
 * can never silently empty behind an un-clearable filter.
 *
 * SECURITY: every case-derived value (title, entity, IPs, rules, tags, assignee,
 * source, model keys) is UNTRUSTED — rendered as plain text or via <InlineCode>,
 * never as markup.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import {
  Briefcase,
  RefreshCw,
  SortAsc,
  SortDesc,
  Search,
  X,
  XCircle,
  Check,
  UserPlus,
  Clock,
  AlertTriangle,
  AlertOctagon,
  Square,
  Circle,
  HelpCircle,
  CheckCircle2,
  Link2,
  Tag as TagIcon,
  SlidersHorizontal,
  CircleSlash,
  LoaderCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type { BackgroundJobKind, Case, CaseActionInput, SavedView } from '@/lib/types';
import { Can, useCan } from '@/soc/components/Can';
import { humanizeAge, humanizeToken, DASH } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Input } from '@/ui/input';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/ui/popover';

import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { ControlBar } from '@/soc/components/ControlBar';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import {
  DataTable,
  type DataTableColumn,
  type SortState,
  type SortDir,
  type ColumnState,
} from '@/soc/components/DataTable';
import { ColumnsMenu, type ColumnMenuItem } from '@/soc/components/ColumnsMenu';
import { SavedViewsBar } from '@/soc/components/SavedViewsBar';
import { usePrefs } from '@/soc/prefs';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { InlineCode } from '@/soc/components/CodeBlock';
import { CaseHoverCard } from '@/soc/components/CaseHoverCard';
import { StartDemoButton } from '@/soc/components/StartDemoButton';
import { LoadingBar } from '@/soc/components/LoadingBar';
import { DemoBadge, isDemoCase } from '@/soc/components/DemoBadge';
import {
  StatusBadge,
  VerdictBadge,
  DispositionBadge,
  RiskBadge,
  SeverityBadge,
  ConfidenceBadge,
  CategoryBadge,
  UrgencyPill,
  AutoClosedBadge,
  severityBand,
  SEVERITY_BAND_ORDER,
} from '@/soc/components/badges';
import { ProvenanceTag, severityProvenance } from '@/soc/components/ProvenanceTag';

import type { Navigate } from '@/soc/router';
import { useRoute } from '@/soc/router';
import {
  announceJobAccepted,
  retainJobSubmissionIntent,
  type JobSubmissionIntent,
} from '@/soc/jobs/jobs';
// motion.dev (lazy — Cases is a lazy page chunk, off the eager first-paint graph): the
// bulk-action bar's slide-out EXIT (today it just vanishes). Cases mounts its OWN
// MotionProvider so the portaled bar animates even on a deep link.
import { motion, AnimatePresence, MotionProvider, HOUSE_SPRING } from '@/soc/components/motion';

/* --------------------------------------------------------------- helpers --- */

const LIST_LIMIT = 200;
const CASE_MANAGER_HANDOFF_MS = 500;

/** Stable id for the Cases table's per-user column state (Wave 7). */
const CASES_TABLE_ID = 'cases';
/** The surface scope saved views on this page belong to. */
const CASES_VIEW_SCOPE = 'cases';

/**
 * Columns hidden by DEFAULT — but ONLY when the user has never customized this table
 * (no stored ColumnState). Round-7 #8 collapses the overlapping "how bad / how sure"
 * secondary signals (disposition, category, urgency) and the per-case count columns
 * (alerts, playbooks, enrichments) behind the Columns menu, so the list opens clean on
 * the dominant Case ID · Title · Status · Severity · Confidence · Verdict · Risk ·
 * Entity · Updated set. Fully reversible via <ColumnsMenu>; the instant the user toggles
 * any column their explicit stored state wins verbatim (this default no longer applies).
 */
const CASES_DEFAULT_HIDDEN = [
  'disposition',
  'alerts',
  'playbooks',
  'enrichments',
  'category',
  'urgency',
] as const;

/** Sentinel for "any" in the single-select filters (Radix Select forbids ""). */
const ANY = '__any__';
/** Virtual status facet for every non-terminal lifecycle state. */
const ACTIVE = '__active__';
/** Virtual facet for work the agent explicitly handed to an analyst. */
const NEEDS_HUMAN = '__needs_human__';
/**
 * Virtual status facet for the TERMINAL lifecycle set — the exact complement of
 * `ACTIVE`, taken off the SAME `TERMINAL_STATUSES` below so the two can never disagree.
 *
 * It exists because terminal is TWO statuses and this filter applies exactly one: a
 * `status: 'closed'` deep link from the Resolved / Closed KPI silently dropped every
 * RESOLVED case from a tile that counts both, which is why that tile used to have to
 * settle for the posture view instead of a list.
 */
const TERMINAL = '__terminal__';
/** Sentinel facet value for cases with no originating source recorded. */
const UNASSIGNED = '__unassigned__';
const TERMINAL_STATUSES = new Set(['closed', 'resolved']);
type NoiseOutcomeFilter = 'auto_cleared' | 'escalated' | 'closed';
const NOISE_OUTCOMES = new Set<NoiseOutcomeFilter>(['auto_cleared', 'escalated', 'closed']);

/** Mirrors the advisory Noise Reduction tally exactly; never affects case decisions. */
function isAutoClearedNoiseCase(c: Case): boolean {
  return (
    TERMINAL_STATUSES.has((c.status || '').toLowerCase()) &&
    (c.decision_by || '').toLowerCase() === 'agent' &&
    (c.verdict || '').toUpperCase() === 'FALSE_POSITIVE'
  );
}

function isHumanClosedNoiseCase(c: Case): boolean {
  return (
    TERMINAL_STATUSES.has((c.status || '').toLowerCase()) &&
    (c.decision_by || '').toLowerCase() === 'analyst'
  );
}

export function matchesNoiseOutcome(c: Case, outcome: NoiseOutcomeFilter): boolean {
  if (outcome === 'auto_cleared') return isAutoClearedNoiseCase(c);
  if (outcome === 'closed') return isHumanClosedNoiseCase(c);
  // The funnel's Escalated cohort is every case not auto-cleared by the agent.
  return !isAutoClearedNoiseCase(c);
}

function isActiveCase(c: Case): boolean {
  return !TERMINAL_STATUSES.has((c.status || '').toLowerCase());
}

/** The exact complement of {@link isActiveCase} — one status set, two facets. */
function isTerminalCase(c: Case): boolean {
  return TERMINAL_STATUSES.has((c.status || '').toLowerCase());
}

function needsHumanCase(c: Case): boolean {
  return (
    (c.status || '').toLowerCase() === 'needs_human' ||
    (c.verdict || '').toUpperCase() === 'NEEDS_HUMAN'
  );
}

type TimeRange = 'all' | '1h' | '24h' | '7d' | '30d';

/** All rule ids/names on a case (handles rule_ids[] and a scalar `rule`). */
function caseRules(c: Case): string[] {
  const out: string[] = [];
  if (Array.isArray(c.rule_ids)) out.push(...c.rule_ids.filter(Boolean).map(String));
  const scalar = (c as Record<string, unknown>).rule;
  if (typeof scalar === 'string' && scalar.trim()) out.push(scalar.trim());
  return out;
}

/** Count of related alerts/events on a case (best-effort over loose fields). */
function alertCount(c: Case): number {
  if (Array.isArray(c.member_event_keys) && c.member_event_keys.length) {
    return c.member_event_keys.length;
  }
  if (Array.isArray(c.member_event_ids)) return c.member_event_ids.length;
  if (Array.isArray(c.evidence)) {
    return c.evidence.reduce(
      (n, e) => n + (Array.isArray(e.event_ids) ? e.event_ids.length : 0),
      0,
    );
  }
  return 0;
}

/** Count of playbooks attached to a case (0 or 1 in the current model). */
function playbookCount(c: Case): number {
  return c.playbook_id ? 1 : 0;
}

/** Count of enrichment artefacts surfaced on a case (evidence entries proxy). */
function enrichmentCount(c: Case): number {
  return Array.isArray(c.evidence) ? c.evidence.length : 0;
}

/** Category label for a case (entity_type → first rule → undefined). */
function caseCategory(c: Case): string | undefined {
  const et = (c.entity_type || c.entity?.type || '').trim();
  if (et) return et;
  return undefined;
}

/**
 * The case's SEVERITY band (string), preferring the backend advisory `severity_band`
 * (the 5-band ladder critical/high/medium/low/info; WHO graded it is carried
 * separately in `severity_source`), else derived from the deterministic `risk_score`
 * via the ONE `severityBand` ladder authority (badges.tsx). Returns null when neither
 * is available. The filter, the sort comparator, and the visible <SeverityBadge> all
 * share this ONE band so they can never disagree (a risk 50 can't render "High" but
 * filter as "Medium"). The `risk_score` fallback is load-bearing — the #38 severity
 * drill-through + `cases-severity-drill.round6` depend on it.
 */
function caseSeverityBand(c: Case) {
  const explicit = severityBand(c.severity_band);
  if (explicit) return explicit;
  return severityBand(typeof c.risk_score === 'number' ? c.risk_score : null);
}

const TIME_RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '1h': 3600 * 1000,
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
};

/** Convert a dashboard metrics window into the exact representable Cases horizon. */
export function timeRangeFromWindowHours(hours: number | undefined): TimeRange | undefined {
  if (hours === 1) return '1h';
  if (hours === 24) return '24h';
  if (hours === 7 * 24) return '7d';
  if (hours === 30 * 24) return '30d';
  return undefined;
}

/* ----------------------------------------------------------------- filters - */

interface CaseFilters {
  search: string;
  status: string; // ANY | a status value
  disposition: string; // ANY | a disposition value
  severity: string; // ANY | 'critical'|'high'|'medium'|'low'|'info'
  noiseOutcome: string; // ANY | exact Noise Reduction outcome cohort
  assignee: string; // ANY | UNASSIGNED | a name
  timeRange: TimeRange;
  /** Show only cases linked across sources (F6 — related_case_ids / cross-source group). */
  relatedOnly: boolean;
}

const EMPTY_FILTERS: CaseFilters = {
  search: '',
  status: ANY,
  disposition: ANY,
  severity: ANY,
  noiseOutcome: ANY,
  assignee: ANY,
  timeRange: 'all',
  relatedOnly: false,
};

/** Whether a case participates in a cross-source group (F6). */
function isCrossSourceLinked(c: Case): boolean {
  const ids = c.related_case_ids;
  return (Array.isArray(ids) && ids.length > 0) || !!c.cross_source_cluster_id;
}

interface Facets {
  statuses: string[];
  dispositions: string[];
  assignees: string[];
}

const sortedUniq = (vals: Iterable<string>): string[] =>
  Array.from(new Set(vals)).sort((a, b) => a.localeCompare(b));

function buildFacets(cases: Case[]): Facets {
  const statuses = new Set<string>();
  const dispositions = new Set<string>();
  const assignees = new Set<string>();
  for (const c of cases) {
    if (c.status) statuses.add(c.status);
    if (typeof c.disposition === 'string' && c.disposition) dispositions.add(c.disposition);
    const a = (c.assignee || '').trim();
    if (a) assignees.add(a);
  }
  return {
    statuses: sortedUniq(statuses),
    dispositions: sortedUniq(dispositions),
    assignees: sortedUniq(assignees),
  };
}

/**
 * Every VIRTUAL status facet. `healFilters` allow-lists this set, so adding a sentinel
 * here is the ONE edit that keeps it surviving a reload — the failure mode is silent
 * (the list just shows everything), so the set lives beside the heal that consumes it.
 */
const STATUS_SENTINELS: ReadonlySet<string> = new Set([ACTIVE, NEEDS_HUMAN, TERMINAL]);

/** Drop a single-select facet value no longer present (self-healing). */
function healFilters(f: CaseFilters, facets: Facets): CaseFilters {
  let next = f;
  // The VIRTUAL facets are not case statuses, so they will never appear in
  // `facets.statuses`. Every sentinel therefore has to be allow-listed here or the
  // heal pass silently resets it to ANY on the first load after a drill-through —
  // showing the operator EVERY case under a facet chip that still reads "Terminal".
  if (
    f.status !== ANY &&
    !STATUS_SENTINELS.has(f.status) &&
    !facets.statuses.includes(f.status)
  ) {
    next = { ...next, status: ANY };
  }
  if (f.disposition !== ANY && !facets.dispositions.includes(f.disposition)) {
    next = { ...next, disposition: ANY };
  }
  if (
    f.assignee !== ANY &&
    f.assignee !== UNASSIGNED &&
    !facets.assignees.includes(f.assignee)
  ) {
    next = { ...next, assignee: ANY };
  }
  return next;
}

function applyFilters(cases: Case[], f: CaseFilters): Case[] {
  const q = f.search.trim().toLowerCase();
  const now = Date.now();
  const horizon = f.timeRange === 'all' ? 0 : now - TIME_RANGE_MS[f.timeRange];

  return cases.filter((c) => {
    if (f.status === ACTIVE) {
      if (!isActiveCase(c)) return false;
    } else if (f.status === TERMINAL) {
      if (!isTerminalCase(c)) return false;
    } else if (f.status === NEEDS_HUMAN) {
      if (!needsHumanCase(c)) return false;
    } else if (f.status !== ANY && (c.status || '') !== f.status) {
      return false;
    }
    if (f.disposition !== ANY && (c.disposition || '') !== f.disposition) return false;
    if (
      f.noiseOutcome !== ANY &&
      NOISE_OUTCOMES.has(f.noiseOutcome as NoiseOutcomeFilter) &&
      !matchesNoiseOutcome(c, f.noiseOutcome as NoiseOutcomeFilter)
    ) {
      return false;
    }
    if (f.relatedOnly && !isCrossSourceLinked(c)) return false;

    if (f.severity !== ANY) {
      if (caseSeverityBand(c) !== f.severity) return false;
    }

    if (f.assignee !== ANY) {
      const assignee = (c.assignee || '').trim();
      if (f.assignee === UNASSIGNED) {
        if (assignee) return false;
      } else if (assignee !== f.assignee) {
        return false;
      }
    }

    if (horizon) {
      const ts = Date.parse(c.created_at || c.updated_at || '');
      if (Number.isNaN(ts) || ts < horizon) return false;
    }

    if (q) {
      const hay = [
        c.title,
        c.case_id,
        c.summary,
        c.entity?.value,
        c.entity?.type,
        ...caseRules(c),
        ...(Array.isArray(c.tags) ? c.tags : []),
        c.assignee,
        c.source_name,
        c.cluster_signature,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function countActiveFilters(f: CaseFilters): number {
  return (
    (f.search.trim() ? 1 : 0) +
    (f.status !== ANY ? 1 : 0) +
    (f.disposition !== ANY ? 1 : 0) +
    (f.severity !== ANY ? 1 : 0) +
    (f.noiseOutcome !== ANY ? 1 : 0) +
    (f.assignee !== ANY ? 1 : 0) +
    (f.timeRange !== 'all' ? 1 : 0) +
    (f.relatedOnly ? 1 : 0)
  );
}

/* --------------------------------------------------- saved-view (de)serialize */

/** Serialize the current filters into a saved-view `filters` bag (Wave 7). */
function filtersToView(f: CaseFilters): Record<string, unknown> {
  return {
    search: f.search,
    status: f.status,
    disposition: f.disposition,
    severity: f.severity,
    noiseOutcome: f.noiseOutcome,
    assignee: f.assignee,
    timeRange: f.timeRange,
    relatedOnly: f.relatedOnly,
  };
}

/** Hydrate filters from a saved-view `filters` bag, tolerating missing/extra keys. */
function viewToFilters(raw: Record<string, unknown> | undefined): CaseFilters {
  const r = raw ?? {};
  const str = (v: unknown, fallback: string) =>
    typeof v === 'string' && v ? v : fallback;
  const tr = str(r.timeRange, 'all');
  const noiseOutcome = str(r.noiseOutcome, ANY);
  return {
    search: typeof r.search === 'string' ? r.search : '',
    status: str(r.status, ANY),
    disposition: str(r.disposition, ANY),
    severity: str(r.severity, ANY),
    noiseOutcome:
      noiseOutcome === ANY || NOISE_OUTCOMES.has(noiseOutcome as NoiseOutcomeFilter)
        ? noiseOutcome
        : ANY,
    assignee: str(r.assignee, ANY),
    timeRange: (['all', '1h', '24h', '7d', '30d'].includes(tr) ? tr : 'all') as TimeRange,
    relatedOnly: r.relatedOnly === true,
  };
}

/** Serialize a SortState into a saved-view `sort` token (e.g. '-updated_at'). */
function sortToToken(s: SortState): string {
  return `${s.dir === 'desc' ? '-' : ''}${s.id}`;
}

/** Parse a saved-view `sort` token back into a SortState (defaults sensibly). */
function tokenToSort(token: string | undefined): SortState {
  const t = (token || '').trim();
  if (!t) return { id: 'updated_at', dir: 'desc' };
  const dir: SortDir = t.startsWith('-') ? 'desc' : 'asc';
  return { id: t.replace(/^-/, ''), dir };
}

/* ------------------------------------------------------------------- sort -- */

type SortId =
  | 'case_id'
  | 'title'
  | 'status'
  | 'assignee'
  | 'disposition'
  | 'category'
  | 'severity'
  | 'confidence'
  | 'updated_at';

const sortComparators: Record<SortId, (a: Case, b: Case) => number> = {
  case_id: (a, b) =>
    (a.case_number || a.case_id).localeCompare(b.case_number || b.case_id),
  title: (a, b) => (a.title || a.case_id).localeCompare(b.title || b.case_id),
  status: (a, b) => (a.status || '').localeCompare(b.status || ''),
  // Unassigned sorts last (the high sentinel char) ascending.
  assignee: (a, b) =>
    ((a.assignee || '').trim() || '￿').localeCompare((b.assignee || '').trim() || '￿'),
  disposition: (a, b) =>
    (a.disposition || '￿').localeCompare(b.disposition || '￿'),
  category: (a, b) => (caseCategory(a) || '￿').localeCompare(caseCategory(b) || '￿'),
  severity: (a, b) =>
    SEVERITY_BAND_ORDER.indexOf(caseSeverityBand(a) ?? 'info') -
    SEVERITY_BAND_ORDER.indexOf(caseSeverityBand(b) ?? 'info'),
  confidence: (a, b) => (a.confidence ?? -1) - (b.confidence ?? -1),
  updated_at: (a, b) =>
    (a.updated_at || a.created_at || '').localeCompare(b.updated_at || b.created_at || ''),
};

/* -------------------------------------------------------------------- page - */

export interface CasesProps {
  onNavigate?: Navigate;
  /** Seed the status filter on mount (e.g. from a drill-through). */
  initialStatus?: string;
  /** Seed the exact assignee facet from a completed bulk-assignment job. */
  initialAssignee?: string;
  /** Seed the searchable tag token from a completed bulk-tag job. */
  initialTag?: string;
  /**
   * Seed the severity filter on mount from a severity drill-through (Round-6 #38 —
   * Overview's Critical/High KPI + open-by-severity rows). One of the coarse bands
   * `critical | high | medium | low | info`; any other value is ignored.
   */
  initialSeverity?: string;
  /** Seed the exact Noise Reduction outcome cohort from the dashboard flow. */
  initialNoiseOutcome?: NoiseOutcomeFilter;
  /** Seed the selected dashboard metrics window (hours) into the Cases horizon. */
  initialWindowHours?: number;
}

/** Severity-band values the Cases severity filter (and the #38 drill-through) accepts. */
const SEVERITY_FILTER_VALUES = new Set(['critical', 'high', 'medium', 'low', 'info']);

/**
 * Severity/status tone for the inline icon in the flat summary strip. Every value
 * routes through a semantic token (no raw hex — design gate).
 */
type SummaryTone =
  | 'primary'
  | 'info'
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'
  | 'success';

const SUMMARY_TONE: Record<SummaryTone, string> = {
  primary: 'text-primary',
  info: 'text-info-text',
  // Terminal work is a lifecycle OUTCOME, not a severity: it takes the status axis's
  // AA-tuned standalone companion rather than borrowing a severity band's colour.
  success: 'text-success-text',
  critical: 'text-critical-text',
  high: 'text-high-text',
  medium: 'text-medium-text',
  low: 'text-low-text',
};

/**
 * A compact at-a-glance count tile for the summary strip — the Cortex-XSIAM / Prisma
 * "incident count band". A semantic inline icon, small-caps label, and big tabular
 * count share one continuous surface. Clickable tiles TOGGLE the matching facet
 * filter (`aria-pressed` reflects the active state). The icon + bar are the beside-color
 * redundant channel (§6.1, WCAG 1.4.1) and are decorative (`aria-hidden`); the label +
 * count carry the meaning. Every value is plain text (UNTRUSTED-safe, #9).
 */
const SummaryTile: React.FC<{
  label: string;
  count: number;
  icon: LucideIcon;
  tone: SummaryTone;
  active?: boolean;
  onClick?: () => void;
  /** Hover title clarifying the count's basis (e.g. "Among N loaded cases"). */
  title?: string;
  testId?: string;
}> = ({ label, count, icon: Icon, tone, active = false, onClick, title, testId }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    title={title}
    data-testid={testId}
    className={cn(
      'group relative flex items-center gap-2.5 border-l border-border/70 bg-background px-3 py-3 text-left first:border-l-0',
      'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      active
        ? 'bg-accent/40'
        : 'hover:bg-accent/25',
    )}
  >
    <span
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center',
        SUMMARY_TONE[tone],
      )}
    >
      <Icon className="size-4" aria-hidden />
    </span>
    <span className="min-w-0">
      <span className="block truncate text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="block text-lg font-semibold leading-tight tabular-nums text-foreground">
        {count.toLocaleString()}
      </span>
    </span>
  </button>
);

const CountLink: React.FC<{ count: number; onClick?: () => void }> = ({ count, onClick }) => {
  const enabled = count > 0 && !!onClick;
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={
        enabled
          ? (e) => {
              e.stopPropagation();
              onClick?.();
            }
          : undefined
      }
      className={cn(
        'inline-flex items-center gap-1 rounded-sm text-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        enabled
          ? 'text-primary hover:underline'
          : 'cursor-default text-muted-foreground',
      )}
    >
      View ({count})
    </button>
  );
};

interface CaseManagerHandoffTarget {
  caseId: string;
  label: string;
}

const CaseManagerHandoff: React.FC<{ target: CaseManagerHandoffTarget | null }> = ({ target }) => {
  if (!target || typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/88 px-6 backdrop-blur-[2px]"
      data-testid="case-manager-handoff"
      aria-busy="true"
    >
      <section
        role="status"
        aria-live="assertive"
        aria-atomic="true"
        className="w-full max-w-sm border border-border bg-background p-5 shadow-elev2"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[4px] border border-primary/35 bg-primary/10 text-primary">
            <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">
              Taking you to Case Manager…
            </h2>
            <p className="mt-1 truncate font-mono text-2xs text-muted-foreground">
              Opening {target.label}
            </p>
          </div>
        </div>
        <LoadingBar
          size="sm"
          label="Opening selected case in Case Manager"
          className="mt-4 rounded-none"
        />
      </section>
    </div>,
    document.body,
  );
};

export default function Cases({
  onNavigate,
  initialStatus: initialStatusProp,
  initialAssignee: initialAssigneeProp,
  initialTag: initialTagProp,
  initialSeverity: initialSeverityProp,
  initialNoiseOutcome: initialNoiseOutcomeProp,
  initialWindowHours: initialWindowHoursProp,
}: CasesProps) {
  const route = useRoute();
  const navigate = onNavigate ?? route.navigate;
  const initialStatus = initialStatusProp ?? route.opts?.status;
  const initialAssignee = initialAssigneeProp ?? route.opts?.assignee;
  const initialTag = initialTagProp ?? route.opts?.tag;
  // Only honour a recognised band so a stray value can never silently empty the list
  // behind an un-representable severity filter.
  const initialSeverityRaw = initialSeverityProp ?? route.opts?.severity;
  const initialSeverity =
    initialSeverityRaw && SEVERITY_FILTER_VALUES.has(initialSeverityRaw)
      ? initialSeverityRaw
      : undefined;
  const initialNoiseOutcomeRaw = initialNoiseOutcomeProp ?? route.opts?.noiseOutcome;
  const initialNoiseOutcome =
    initialNoiseOutcomeRaw && NOISE_OUTCOMES.has(initialNoiseOutcomeRaw)
      ? initialNoiseOutcomeRaw
      : undefined;
  const initialWindowHours = initialWindowHoursProp ?? route.opts?.window;
  const initialTimeRange = timeRangeFromWindowHours(initialWindowHours);

  // Pervasive customization (Wave 7): terminology labels + saved views + per-table
  // column state, all keyed to the caller (the 'default' bucket when auth is off).
  const { t, tableColumns, updateTableColumns } = usePrefs();
  // `tableColumns` returns undefined when the user has never customized this table.
  // In that (only) case we open with the curated default-hidden set (#8); any stored
  // state — the moment they toggle a column via <ColumnsMenu> — is respected verbatim.
  const storedColumnState = tableColumns(CASES_TABLE_ID);
  const effectiveColumnState: ColumnState =
    storedColumnState ?? { hidden: [...CASES_DEFAULT_HIDDEN] };
  const [activeViewId, setActiveViewId] = React.useState<string | null>(null);

  // The per-row Close affordance mirrors the bulk bar's RBAC gate: hide it entirely
  // unless the operator holds cases:close, so a cases:write-only analyst never sees a
  // control that would 403 (consistent with the <Can resource="cases" action="close">
  // wrap on the bulk buttons).
  const canClose = useCan('cases', 'close');

  const [cases, setCases] = React.useState<Case[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const [filters, setFilters] = React.useState<CaseFilters>(() => {
    let f = EMPTY_FILTERS;
    if (initialStatus) f = { ...f, status: initialStatus };
    if (initialAssignee) f = { ...f, assignee: initialAssignee };
    if (initialTag) f = { ...f, search: initialTag };
    if (initialSeverity) f = { ...f, severity: initialSeverity };
    if (initialNoiseOutcome) f = { ...f, noiseOutcome: initialNoiseOutcome };
    if (initialTimeRange) f = { ...f, timeRange: initialTimeRange };
    return f;
  });
  const [sort, setSort] = React.useState<SortState>({ id: 'updated_at', dir: 'desc' });
  const [pageSize, setPageSize] = React.useState(50);
  const [page, setPage] = React.useState(1);

  const [handoffTarget, setHandoffTarget] = React.useState<CaseManagerHandoffTarget | null>(null);
  const handoffTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);

  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkError, setBulkError] = React.useState<string | null>(null);

  // Bulk reinvestigate — a separate confirm gate because (unlike tag/assign/status)
  // it spends real LLM tokens per case and can change verdict/status (mirrors the
  // single-case Reinvestigate popover's cost warning in CaseDetail.tsx).
  const [reinvestConfirmOpen, setReinvestConfirmOpen] = React.useState(false);

  // The one-click row "Close" is a reversible lifecycle move — gate it behind a plain
  // ConfirmDialog. The close still posts through the SAME analyst action endpoint
  // (server-side decide()), never a client-side status write (#3).
  const [closeTarget, setCloseTarget] = React.useState<Case | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listCases({ limit: LIST_LIMIT });
      setCases(res.cases);
      setTotal(res.total);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // A drill-through can change `initialStatus` while mounted; reseed the filter.
  React.useEffect(() => {
    if (initialStatus) setFilters((f) => ({ ...f, status: initialStatus }));
  }, [initialStatus]);

  // Completed bulk assignment/tag jobs deep-link back to their affected cohort. The
  // assignee remains an exact facet; tags reuse the visible text search, whose haystack
  // already includes Case.tags, so the destination is inspectable and easy to clear.
  React.useEffect(() => {
    if (initialAssignee) setFilters((f) => ({ ...f, assignee: initialAssignee }));
  }, [initialAssignee]);

  React.useEffect(() => {
    if (initialTag) setFilters((f) => ({ ...f, search: initialTag }));
  }, [initialTag]);

  // A severity drill-through (Overview Critical/High KPI + open-by-severity rows, #38)
  // can change `initialSeverity` while mounted; reseed the severity facet. Additive —
  // no-op when absent, and pre-validated to a known band above.
  React.useEffect(() => {
    if (initialSeverity) setFilters((f) => ({ ...f, severity: initialSeverity }));
  }, [initialSeverity]);

  React.useEffect(() => {
    if (initialNoiseOutcome) {
      setFilters((f) => ({ ...f, noiseOutcome: initialNoiseOutcome }));
    }
  }, [initialNoiseOutcome]);

  React.useEffect(() => {
    if (initialTimeRange) setFilters((f) => ({ ...f, timeRange: initialTimeRange }));
  }, [initialTimeRange]);

  const openInCaseManager = React.useCallback(
    (caseId: string, label?: string) => {
      if (handoffTimerRef.current) clearTimeout(handoffTimerRef.current);
      setHandoffTarget({ caseId, label: label || caseId });
      handoffTimerRef.current = setTimeout(() => {
        handoffTimerRef.current = null;
        setHandoffTarget(null);
        navigate('case_manager', { caseId });
      }, CASE_MANAGER_HANDOFF_MS);
    },
    [navigate],
  );

  React.useEffect(
    () => () => {
      if (handoffTimerRef.current) clearTimeout(handoffTimerRef.current);
    },
    [],
  );

  // A legacy Cases deep link hands off to the canonical Case Manager workspace.
  const routeCaseId = route.opts?.caseId;
  React.useEffect(() => {
    if (route.page === 'cases' && routeCaseId) openInCaseManager(routeCaseId);
  }, [openInCaseManager, route.page, routeCaseId]);

  const facets = React.useMemo(() => buildFacets(cases), [cases]);

  // Self-heal selected facet values when the loaded rows change.
  React.useEffect(() => {
    // Do not erase a deep-linked assignee while the first case page is still loading
    // and the facet catalog is necessarily empty.
    if (!loading) setFilters((f) => healFilters(f, facets));
  }, [facets, loading]);

  const filtered = React.useMemo(() => applyFilters(cases, filters), [cases, filters]);

  const filteredSorted = React.useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const cmp = sortComparators[sort.id as SortId] ?? sortComparators.updated_at;
    return [...filtered].sort((a, b) => cmp(a, b) * dir);
  }, [filtered, sort]);

  // Reset to page 1 whenever the filtered set or page size changes.
  React.useEffect(() => {
    setPage(1);
  }, [filters, pageSize]);

  const pageCount = Math.max(1, Math.ceil(filteredSorted.length / pageSize));
  React.useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const pageRows = React.useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredSorted.slice(start, start + pageSize);
  }, [filteredSorted, page, pageSize]);

  // Header pill counts over the full LOADED set (`cases`), NOT the filtered view, so
  // (a) they stay a stable triage snapshot that doesn't collapse to 0 when a status
  // filter is applied, and (b) their basis matches the "N loaded" the Total pill shows
  // when truncated — never read as a fraction of the server total.
  const counts = React.useMemo(() => {
    let active = 0;
    let terminal = 0;
    let needsHuman = 0;
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const c of cases) {
      if (isActiveCase(c)) active += 1;
      else terminal += 1;
      if (needsHumanCase(c)) needsHuman += 1;
      const band = caseSeverityBand(c);
      if (band && band in bySeverity) bySeverity[band as keyof typeof bySeverity] += 1;
    }
    return { active, terminal, needsHuman, bySeverity };
  }, [cases]);

  const truncated = total > cases.length;
  // Tooltip clarifying that the Active/Needs-human/severity pills count the LOADED set.
  const loadedScopeTitle = truncated
    ? `Among the ${cases.length.toLocaleString()} loaded cases (of ${total.toLocaleString()})`
    : `Among ${cases.length.toLocaleString()} case${cases.length === 1 ? '' : 's'}`;

  // Drop any selection no longer visible so the bulk bar can't act on hidden rows.
  React.useEffect(() => {
    setSelected((sel) => {
      if (!sel.length) return sel;
      const visible = new Set(filteredSorted.map((c) => c.case_id));
      const next = sel.filter((id) => visible.has(id));
      return next.length === sel.length ? sel : next;
    });
  }, [filteredSorted]);

  const selectedCases = React.useMemo(() => {
    const set = new Set(selected);
    return filteredSorted.filter((c) => set.has(c.case_id));
  }, [selected, filteredSorted]);
  const jobSubmissionIntentRef = React.useRef<JobSubmissionIntent | null>(null);

  /** Submit one immutable Cases selection to the server-owned Jobs subsystem. */
  const submitCaseJob = React.useCallback(
    async (
      kind: BackgroundJobKind,
      additionalParams: Record<string, unknown>,
      activity: string,
    ) => {
      const ids = selectedCases.map((item) => item.case_id).sort((a, b) => a.localeCompare(b));
      if (!ids.length || bulkBusy) return;
      const params = { case_ids: ids, ...additionalParams };
      const intent = retainJobSubmissionIntent(jobSubmissionIntentRef.current, kind, params);
      jobSubmissionIntentRef.current = intent;
      setBulkBusy(true);
      setBulkError(null);
      try {
        const job = await api.jobs.submit({
          kind,
          idempotency_key: intent.idempotencyKey,
          params,
        });
        jobSubmissionIntentRef.current = null;
        const acceptedIds = new Set(ids);
        setSelected((current) => current.filter((id) => !acceptedIds.has(id)));
        announceJobAccepted(job);
        toast.success(`${ids.length} case${ids.length === 1 ? '' : 's'} ${activity}.`, {
          description: 'The server-owned job continues after navigation or reload. Track it in Inbox.',
          action: { label: 'Open Inbox', onClick: () => navigate('inbox') },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not start the background job.';
        setBulkError(msg);
        toast.error(msg);
      } finally {
        setBulkBusy(false);
      }
    },
    [bulkBusy, navigate, selectedCases],
  );

  const runBulk = React.useCallback(
    (input: CaseActionInput, activity = 'are being updated') =>
      submitCaseJob('case_lifecycle', { ...input }, activity),
    [submitCaseJob],
  );

  // Perform the confirmed row-close. Posts the SAME `close` analyst action as the
  // bulk bar / CaseDetail close dialog — the backend's decide() adjudicates (#3).
  const confirmClose = React.useCallback(async () => {
    const target = closeTarget;
    if (!target) return;
    try {
      await api.caseActionExec(target.case_id, {
        action: 'close',
        resolution: 'Closed by analyst',
      });
      await load();
    } catch {
      setBulkError(`Could not close ${target.case_id}.`);
    }
  }, [closeTarget, load]);

  const setFilter = <K extends keyof CaseFilters>(key: K, value: CaseFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const anyActive = countActiveFilters(filters) > 0;
  const oldestFirst = sort.id === 'updated_at' && sort.dir === 'asc';

  /* ------------------------------------------------- saved views (Wave 7) -- */
  // Apply a saved view's stored filter/sort onto the page (null → defaults).
  const applySavedView = React.useCallback(
    (view: SavedView | null) => {
      if (!view) {
        setFilters(EMPTY_FILTERS);
        setSort({ id: 'updated_at', dir: 'desc' });
        setActiveViewId(null);
        return;
      }
      setFilters(viewToFilters(view.filters));
      setSort(tokenToSort(view.sort));
      setActiveViewId(view.id);
    },
    [],
  );

  // Capture the page's CURRENT config for the "Save view" affordance.
  const captureCurrent = React.useCallback(
    () => ({ filters: filtersToView(filters), sort: sortToToken(sort), columns: null }),
    [filters, sort],
  );

  // Clear all filters AND any applied saved view (the "Clear" affordances).
  const clearAll = React.useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setActiveViewId(null);
  }, []);

  // Persist a new column state (the table re-applies it via `columnState`).
  const handleColumnState = React.useCallback(
    (next: ColumnState) => {
      void updateTableColumns(CASES_TABLE_ID, next);
    },
    [updateTableColumns],
  );

  /* ----------------------------------------------------------- columns ---- */
  const columns: DataTableColumn<Case>[] = [
    {
      id: 'case_id',
      header: 'Case ID',
      sortable: true,
      width: '9.5rem',
      lockVisible: true,
      cell: (c) => (
        <div className="flex items-center gap-1.5">
          <CaseHoverCard case={c}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openInCaseManager(c.case_id, c.case_number || c.case_id);
              }}
              className="rounded-[3px] font-mono text-xs font-semibold uppercase tracking-wide text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {c.case_number || c.case_id}
            </button>
          </CaseHoverCard>
          <DemoBadge show={isDemoCase(c)} iconless className="px-1 py-0 text-2xs" />
        </div>
      ),
    },
    {
      id: 'title',
      header: 'Title',
      sortable: true,
      cell: (c) => (
        <CaseHoverCard case={c}>
          <span className="block max-w-[26rem] cursor-pointer truncate font-semibold text-foreground">
            {c.title || c.case_id}
          </span>
        </CaseHoverCard>
      ),
    },
    {
      // Lifecycle status, plus a self-hiding "Auto-closed by AI" badge stacked beneath
      // it when the deterministic close was recorded to the `agent` actor (Round-7 #11).
      // AutoClosedBadge renders null for analyst/system/open cases, so the common cell is
      // just the StatusBadge; the CLOSE itself is still decide()'s call (#3) — this badge
      // is a read-only presentation of who the recorded decider was.
      id: 'status',
      header: 'Status',
      sortable: true,
      width: '10.5rem',
      cell: (c) => (
        // Fixed min-height so a row is the SAME height whether or not the optional
        // AutoClosedBadge renders — keeps compact rows uniform and the rowAccent inset
        // bar even down the margin (Round-8 #2). `justify-center` keeps the StatusBadge
        // vertically centred in the reserved space.
        <div className="flex min-h-[2.25rem] flex-col items-start justify-center gap-1">
          <StatusBadge status={c.status} className="rounded-[3px] px-1.5 text-2xs" />
          <AutoClosedBadge
            status={c.status}
            decisionBy={c.decision_by}
            objectionWindowExpiresAt={c.objection_window_expires_at}
          />
        </div>
      ),
    },
    {
      // Owner cell — a compact monogram chip + the assignee name, or a muted
      // "Unassigned". The name is case-derived (UNTRUSTED) so it renders as plain
      // text; the monogram is a single derived character, decorative (`aria-hidden`).
      id: 'assignee',
      header: 'Assignee',
      sortable: true,
      width: '9.5rem',
      cell: (c) => {
        const name = (c.assignee || '').trim();
        if (!name) {
          return <span className="text-sm text-muted-foreground">Unassigned</span>;
        }
        return (
          <span className="flex items-center gap-1.5 text-sm text-foreground">
            <span
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-2xs font-semibold uppercase text-muted-foreground"
              aria-hidden
            >
              {name.charAt(0)}
            </span>
            <span className="max-w-[7rem] truncate">{name}</span>
          </span>
        );
      },
    },
    {
      id: 'disposition',
      header: 'Disposition',
      sortable: true,
      width: '8rem',
      cell: (c) => <DispositionBadge disposition={c.disposition ?? null} />,
    },
    {
      id: 'alerts',
      header: 'Alerts',
      align: 'left',
      width: '6.5rem',
      cell: (c) => (
        <CountLink
          count={alertCount(c)}
          onClick={
            alertCount(c) > 0
              ? () => openInCaseManager(c.case_id, c.case_number || c.case_id)
              : undefined
          }
        />
      ),
    },
    {
      id: 'playbooks',
      header: 'Playbooks',
      align: 'left',
      width: '6.5rem',
      cell: (c) => (
        <CountLink
          count={playbookCount(c)}
          onClick={
            playbookCount(c) > 0
              ? () => openInCaseManager(c.case_id, c.case_number || c.case_id)
              : undefined
          }
        />
      ),
    },
    {
      id: 'enrichments',
      header: 'Enrichments',
      align: 'left',
      width: '7rem',
      cell: (c) => (
        <CountLink
          count={enrichmentCount(c)}
          onClick={
            enrichmentCount(c) > 0
              ? () => openInCaseManager(c.case_id, c.case_number || c.case_id)
              : undefined
          }
        />
      ),
    },
    {
      id: 'category',
      header: 'Category',
      sortable: true,
      width: '7rem',
      cell: (c) => <CategoryBadge category={caseCategory(c)} />,
    },
    {
      // Severity's provenance FLIPS per row (SIEM-asserted vs code-derived), so the
      // ProvenanceTag lives PER-CELL beside the badge — NOT at the column header like the
      // constant-provenance columns below (Round-7 #9b, DECISIONS §A.5/§A.10).
      id: 'severity',
      header: 'Severity',
      sortable: true,
      width: '9rem',
      cell: (c) => {
        const band = caseSeverityBand(c);
        return (
          <div className="flex items-center gap-1.5">
            <SeverityBadge severity={band} className="rounded-[3px] px-1.5 text-2xs" />
            {band ? (
              <ProvenanceTag
                kind={severityProvenance(c.severity_source)}
                variant="icon"
              />
            ) : null}
          </div>
        );
      },
    },
    {
      id: 'confidence',
      header: 'Confidence',
      sortable: true,
      width: '7rem',
      // The confidence score is an AI (LLM) judgement — constant provenance for the
      // whole column, declared once at the header.
      provenance: 'ai',
      cell: (c) => <ConfidenceBadge confidence={c.confidence} />,
    },
    {
      id: 'verdict',
      header: 'Verdict',
      width: '8rem',
      // The verdict is an AI (LLM) judgement — constant column provenance.
      provenance: 'ai',
      cell: (c) => <VerdictBadge verdict={c.verdict} />,
    },
    {
      id: 'risk',
      header: 'Risk',
      width: '6rem',
      // Risk is the DETERMINISTIC risk_score — constant column provenance.
      provenance: 'code',
      cell: (c) => <RiskBadge score={c.risk_score} />,
    },
    {
      id: 'urgency',
      header: 'Urgency',
      width: '6rem',
      cell: (c) => (
        <UrgencyPill
          createdAt={c.created_at}
          riskScore={c.risk_score}
          status={c.status}
          band={c.urgency_band}
        />
      ),
    },
    {
      id: 'entity',
      header: 'Entity',
      width: '11rem',
      cell: (c) =>
        c.entity ? (
          <span className="text-sm text-foreground">
            <span className="text-muted-foreground">{c.entity.type}:</span>{' '}
            <InlineCode>{c.entity.value}</InlineCode>
          </span>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        ),
    },
    {
      id: 'updated_at',
      header: 'Updated',
      sortable: true,
      width: '7rem',
      cell: (c) => (
        <span className="whitespace-nowrap text-sm text-muted-foreground">
          {humanizeAge(c.updated_at || c.created_at)}
        </span>
      ),
    },
    // Actions column — only present when the operator can close (RBAC-mirrored). A
    // case Close is a REVERSIBLE lifecycle move (it can be reopened), so it uses a
    // close glyph (XCircle) + neutral tone, NOT the Trash/delete grammar that implies
    // data loss (DESIGN_STANDARD reserves Trash for real deletes).
    ...(canClose
      ? ([
          {
            id: 'actions',
            header: 'Actions',
            align: 'right',
            width: '5rem',
            cell: (c: Case) => (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                aria-label={`Close case ${c.case_id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setCloseTarget(c);
                }}
              >
                <XCircle className="size-4" aria-hidden />
              </Button>
            ),
          },
        ] as DataTableColumn<Case>[])
      : []),
  ];

  // Column-menu descriptors (plain-text labels; the actions column is hideable but
  // the locked case_id column always shows). Derived from the columns above so the
  // menu and the table never drift.
  const columnMenuItems: ColumnMenuItem[] = columns.map((c) => ({
    id: c.id,
    label: typeof c.header === 'string' ? c.header : c.id,
    lockVisible: c.lockVisible,
  }));

  /* ------------------------------------------------------------- render ---- */
  return (
    <MotionProvider>
    <PageContainer
      variant="fluid"
      // Reserve bottom space whenever the fixed bulk bar is showing so it never
      // covers the last table rows/pager (#3). Keyed to the SAME selection state
      // the bar's own visibility gate reads, so the padding and the bar are always
      // in lockstep (no stale gutter after the selection clears).
      className={cn('space-y-6', selectedCases.length > 0 && 'pb-28')}
    >
      <PageHeader
        variant="dense"
        breadcrumb={[{ label: 'Triage' }, { label: t('cases', 'Cases') }]}
        title={t('cases', 'Cases')}
        icon={Briefcase}
        meta={
          // A single quiet total badge beside the title (the at-a-glance triage
          // breakdown now lives in the summary strip below). When only a subset is
          // loaded it reads "N / M" so the loaded basis is explicit (never a misread).
          <span
            data-testid="cases-count-total"
            title={
              truncated
                ? `${cases.length.toLocaleString()} of ${total.toLocaleString()} cases loaded`
                : undefined
            }
            className="inline-flex items-center rounded-[4px] border border-border bg-surface px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
          >
            {truncated
              ? `${cases.length.toLocaleString()} / ${total.toLocaleString()}`
              : `${total.toLocaleString()} total`}
          </span>
        }
      />

      <ControlBar
        title="Case queue"
        meta={oldestFirst ? 'Oldest activity first' : 'Newest activity first'}
        label="Case queue controls"
        controls={
          <>
            {/* A true two-way sort toggle on updated_at — the visible label reflects
                the CURRENT order, and clicking always flips it, so there is always a
                way back to newest (the old control only ever set asc). */}
            <Button
              variant={oldestFirst ? 'default' : 'outline'}
              size="sm"
              className="h-8 rounded-[4px] text-xs"
              aria-pressed={oldestFirst}
              aria-label={`Sort by updated time, currently ${oldestFirst ? 'oldest' : 'newest'} first`}
              onClick={() =>
                setSort({ id: 'updated_at', dir: oldestFirst ? 'desc' : 'asc' })
              }
            >
              {oldestFirst ? (
                <SortDesc className="mr-1.5 size-4" aria-hidden />
              ) : (
                <SortAsc className="mr-1.5 size-4" aria-hidden />
              )}
              {oldestFirst ? 'Oldest first' : 'Newest first'}
            </Button>
            <RefreshButton
              className="h-8 rounded-[4px] text-xs"
              onClick={() => void load()}
              refreshing={loading}
            />
          </>
        }
      />

      {/* Summary strip — the Cortex-XSIAM / Prisma "incident count band": at-a-glance
          triage buckets over the LOADED set. Each tile toggles the matching facet
          filter (severity band or lifecycle status); the icon + left accent bar are the
          non-color redundant channel (§6.1). Counts are a stable snapshot of the loaded
          set (they don't collapse when a filter is applied), matching what clicking each
          tile narrows the list to. */}
      <div
        className={cn(
          'grid grid-cols-2 border-y border-border/70 sm:grid-cols-3 xl:grid-cols-7',
          /*
           * Column dividers, stated ONCE PER MUTUALLY-EXCLUSIVE COLUMN COUNT.
           *
           * The rule is simple — a hairline between neighbours, never at the start of a
           * wrapped row — but expressing it as overlapping breakpoint layers made it a
           * SPECIFICITY TIE decided by Tailwind's emission order: `[&>*:nth-child(odd)]`
           * and `[&>*:nth-child(3n+1)]` are both (0,2,0), and `border-l-0` is emitted
           * before `border-l`, so at 3 columns the odd rule re-lit cells 1 and 7 (the
           * row starts) while the stale 3n+1 rule leaked upward and killed cell 4's
           * divider at 7 columns. Adding a seventh tile turned that latent tie into a
           * visible hairline hanging off the third row.
           *
           * So each range now owns exactly two rules — an ENABLE at (0,1,0) and a
           * ROW-START RESET at (0,2,0) — and the ranges cannot overlap. The reset wins
           * on specificity alone, so the result no longer depends on emission order,
           * and `Nn+1` is always the range's own `grid-cols-N`. `route-visual-standard`
           * derives and enforces exactly this from the column counts above.
           */
          'max-sm:[&>*]:border-l max-sm:[&>*:nth-child(2n+1)]:border-l-0',
          'sm:max-xl:[&>*]:border-l sm:max-xl:[&>*:nth-child(3n+1)]:border-l-0',
          'xl:[&>*]:border-l xl:[&>*:nth-child(7n+1)]:border-l-0',
          (loading || Boolean(error)) && cases.length === 0 && 'hidden',
        )}
      >
        <SummaryTile
          label="Active"
          count={counts.active}
          icon={Briefcase}
          tone="info"
          active={filters.status === ACTIVE}
          onClick={() => setFilter('status', filters.status === ACTIVE ? ANY : ACTIVE)}
          title={loadedScopeTitle}
          testId="cases-summary-open"
        />
        <SummaryTile
          label="Terminal"
          count={counts.terminal}
          icon={CheckCircle2}
          tone="success"
          active={filters.status === TERMINAL}
          onClick={() => setFilter('status', filters.status === TERMINAL ? ANY : TERMINAL)}
          title={loadedScopeTitle}
          testId="cases-summary-terminal"
        />
        <SummaryTile
          label="Needs human"
          count={counts.needsHuman}
          icon={HelpCircle}
          tone="primary"
          active={filters.status === NEEDS_HUMAN}
          onClick={() =>
            setFilter('status', filters.status === NEEDS_HUMAN ? ANY : NEEDS_HUMAN)
          }
          title={loadedScopeTitle}
          testId="cases-summary-needs-human"
        />
        <SummaryTile
          label="Critical"
          count={counts.bySeverity.critical}
          icon={AlertOctagon}
          tone="critical"
          active={filters.severity === 'critical'}
          onClick={() =>
            setFilter('severity', filters.severity === 'critical' ? ANY : 'critical')
          }
          title={loadedScopeTitle}
          testId="cases-summary-critical"
        />
        <SummaryTile
          label="High"
          count={counts.bySeverity.high}
          icon={AlertTriangle}
          tone="high"
          active={filters.severity === 'high'}
          onClick={() => setFilter('severity', filters.severity === 'high' ? ANY : 'high')}
          title={loadedScopeTitle}
          testId="cases-summary-high"
        />
        <SummaryTile
          label="Medium"
          count={counts.bySeverity.medium}
          icon={Square}
          tone="medium"
          active={filters.severity === 'medium'}
          onClick={() =>
            setFilter('severity', filters.severity === 'medium' ? ANY : 'medium')
          }
          title={loadedScopeTitle}
          testId="cases-summary-medium"
        />
        <SummaryTile
          label="Low"
          count={counts.bySeverity.low}
          icon={Circle}
          tone="low"
          active={filters.severity === 'low'}
          onClick={() => setFilter('severity', filters.severity === 'low' ? ANY : 'low')}
          title={loadedScopeTitle}
          testId="cases-summary-low"
        />
      </div>

      {/* One flat responsive filter band. Standard laptop widths resolve to a
          three-column grid instead of squeezing every operator control into a
          single row; ultrawide screens regain the compact one-line layout. */}
      <section
        aria-label="Case filters"
        data-testid="cases-filter-band"
        className={cn(
          'space-y-2.5 border-y border-border/70 py-3',
          (loading || Boolean(error)) && cases.length === 0 && 'hidden',
        )}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:flex 2xl:flex-wrap 2xl:items-center">
          <div className="relative min-w-0 sm:col-span-2 lg:col-span-3 2xl:min-w-[18rem] 2xl:flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={filters.search}
              onChange={(e) => setFilter('search', e.target.value)}
              placeholder="Search cases — ID, title, entity, rule, tags…"
              aria-label="Search cases"
              className="h-8 rounded-[4px] pl-9 text-xs"
            />
          </div>

          <Select value={filters.status} onValueChange={(v) => setFilter('status', v)}>
            <SelectTrigger className="h-8 w-full rounded-[4px] text-xs 2xl:w-[11rem]" aria-label="Filter by status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All statuses</SelectItem>
              <SelectItem value={ACTIVE}>Active cases</SelectItem>
              <SelectItem value={TERMINAL}>Terminal (resolved or closed)</SelectItem>
              <SelectItem value={NEEDS_HUMAN}>Needs human</SelectItem>
              {facets.statuses.filter((s) => s !== 'needs_human').map((s) => (
                <SelectItem key={s} value={s}>
                  {s === 'needs_human' ? 'Open · awaiting analyst' : humanizeToken(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={filters.noiseOutcome}
            onValueChange={(v) => setFilter('noiseOutcome', v)}
          >
            <SelectTrigger
              className="h-8 w-full rounded-[4px] text-xs 2xl:w-[12rem]"
              aria-label="Filter by noise-reduction outcome"
            >
              <SelectValue placeholder="Flow outcome" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All flow outcomes</SelectItem>
              <SelectItem value="auto_cleared">Auto-cleared by AI</SelectItem>
              <SelectItem value="escalated">Escalated to analyst</SelectItem>
              <SelectItem value="closed">Closed by human</SelectItem>
            </SelectContent>
          </Select>

          {facets.dispositions.length ? (
            <Select
              value={filters.disposition}
              onValueChange={(v) => setFilter('disposition', v)}
            >
              <SelectTrigger className="h-8 w-full rounded-[4px] text-xs 2xl:w-[11rem]" aria-label="Filter by disposition">
                <SelectValue placeholder="Disposition" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All dispositions</SelectItem>
                {facets.dispositions.map((d) => (
                  <SelectItem key={d} value={d}>
                    {humanizeToken(d)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          <Select value={filters.severity} onValueChange={(v) => setFilter('severity', v)}>
            <SelectTrigger className="h-8 w-full rounded-[4px] text-xs 2xl:w-[10rem]" aria-label="Filter by severity">
              <SelectValue placeholder="Severity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All severities</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="info">Info</SelectItem>
            </SelectContent>
          </Select>

          <Select value={filters.assignee} onValueChange={(v) => setFilter('assignee', v)}>
            <SelectTrigger className="h-8 w-full rounded-[4px] text-xs 2xl:w-[11rem]" aria-label="Filter by assignee">
              <SelectValue placeholder="Assignee" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All assignees</SelectItem>
              <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
              {facets.assignees.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 w-full justify-start rounded-[4px] text-xs 2xl:w-auto">
                <Clock className="mr-1.5 size-4" aria-hidden />
                {filters.timeRange === 'all'
                  ? 'Any time'
                  : `Last ${filters.timeRange}`}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56" align="start">
              <div className="space-y-1">
                <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
                  Created within
                </p>
                {(
                  [
                    ['all', 'Any time'],
                    ['1h', 'Last 1 hour'],
                    ['24h', 'Last 24 hours'],
                    ['7d', 'Last 7 days'],
                    ['30d', 'Last 30 days'],
                  ] as Array<[TimeRange, string]>
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setFilter('timeRange', val)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors',
                      'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      filters.timeRange === val
                        ? 'bg-accent font-medium text-foreground'
                        : 'text-muted-foreground',
                    )}
                  >
                    {label}
                    {filters.timeRange === val ? <Check className="size-4" aria-hidden /> : null}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Button
            variant={filters.relatedOnly ? 'default' : 'outline'}
            size="sm"
            className="h-8 w-full justify-start rounded-[4px] text-xs 2xl:w-auto"
            onClick={() => setFilter('relatedOnly', !filters.relatedOnly)}
            aria-pressed={filters.relatedOnly}
            title="Show only cases linked across sources"
          >
            <Link2 className="mr-1.5 size-4" aria-hidden />
            Cross-source
          </Button>

          {anyActive ? (
            <Button variant="ghost" size="sm" className="h-8 w-full justify-start rounded-[4px] text-xs 2xl:w-auto" onClick={clearAll}>
              <X className="mr-1.5 size-4" aria-hidden />
              Clear
            </Button>
          ) : null}
        </div>

        {/* Tier 2 — view switcher, the result count, and column customization, set off
            from the filter controls by a hairline divider so the band reads calm. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-2.5">
          <SavedViewsBar
            scope={CASES_VIEW_SCOPE}
            activeViewId={activeViewId}
            onApply={applySavedView}
            getCurrent={captureCurrent}
          />

          <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
            Showing <strong className="tabular-nums text-foreground">{filteredSorted.length}</strong>{' '}
            of <span className="tabular-nums">{cases.length}</span>
            {total > cases.length ? ` (of ${total.toLocaleString()} total)` : ''}
          </span>

          <ColumnsMenu
            columns={columnMenuItems}
            state={effectiveColumnState}
            onChange={handleColumnState}
          />
        </div>
      </section>

      {/* Truncation note */}
      {truncated ? (
        <Alert>
          <AlertTitle>
            Showing the first {cases.length.toLocaleString()} of {total.toLocaleString()} cases
          </AlertTitle>
          <AlertDescription>
            Only the most recent {cases.length.toLocaleString()} cases are loaded for fast
            client-side filtering. Narrow the time range or use search to find older cases.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Bulk error */}
      {bulkError ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertTitle>Some actions failed</AlertTitle>
          <AlertDescription>{bulkError}</AlertDescription>
        </Alert>
      ) : null}

      {/* Load error */}
      {error ? (
        <LoadError error={error} title="Could not load cases" onRetry={() => void load()} />
      ) : null}

      {/* Table */}
      {error && cases.length === 0 ? null : <DataTable<Case>
        ariaLabel="Cases"
        className="rounded-[4px] bg-background shadow-none"
        columns={columns}
        columnState={effectiveColumnState}
        rows={pageRows}
        getRowId={(c) => c.case_id}
        // 3px left-edge severity band per row (#8) — scan severity down the margin
        // without a dedicated column; shares the ONE band ladder with the filter/sort.
        rowAccent={(c) => caseSeverityBand(c)}
        // NOTE: no `sticky` header here. DataTable's card is `overflow-hidden` and the
        // inner Table wrapper is `overflow-auto`, so a sticky <thead> would pin against
        // a never-scrolling ancestor and read as a broken, cut-off header row (Round-8
        // #2). A plain non-sticky header is clean and correct at this list length.
        sort={sort}
        onSortChange={setSort}
        page={page}
        pageSize={pageSize}
        total={filteredSorted.length}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        pageSizeOptions={[25, 50, 100]}
        selectable
        selected={selected}
        onSelectedChange={setSelected}
        onRowClick={(c) => openInCaseManager(c.case_id, c.case_number || c.case_id)}
        // The named Case ID button is already the keyboard equivalent of the
        // pointer-clickable row; do not add a second trailing open affordance next
        // to the lifecycle Actions column.
        showRowAction={false}
        loading={loading}
        loadingRows={8}
        density="compact"
        empty={
          <EmptyState
            compact
            icon={Briefcase}
            title={cases.length === 0 ? 'No cases yet' : 'No cases match your filters'}
            description={
              cases.length === 0
                ? 'Run an investigation or enable background scans to start triaging.'
                : 'No loaded cases match the current filters. Clear them to see all cases.'
            }
            action={
              cases.length > 0 ? (
                <Button variant="outline" size="sm" onClick={clearAll}>
                  <X className="mr-1.5 size-4" aria-hidden />
                  Clear filters
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={() => navigate('sources')}>
                    Connect a source
                  </Button>
                  <StartDemoButton onStarted={load} />
                </>
              )
            }
          />
        }
      />}

      {/* Bulk action bar */}
      <BulkActionBar
        count={selectedCases.length}
        busy={bulkBusy}
        onAcknowledge={() => void runBulk({ action: 'acknowledge' }, 'are being acknowledged')}
        onClose={() => void runBulk({ action: 'close', resolution: 'Bulk-closed by analyst' }, 'are being closed')}
        onResolve={(reason) =>
          void runBulk({ action: 'resolve', reason: reason || 'Bulk-resolved by analyst' }, 'are being resolved')
        }
        onAssign={(assignee) =>
          void submitCaseJob('case_assign', { assignee }, `are being assigned to ${assignee}`)
        }
        onAddTag={(tag) =>
          void submitCaseJob('case_tag', { tag }, `are being tagged ${tag}`)
        }
        onSetStatus={(status) => void runBulk({ action: 'set_status', status }, `are being set to ${status}`)}
        onSetDisposition={(disposition) =>
          void runBulk({ action: 'set_disposition', disposition }, `are being classified as ${disposition}`)
        }
        onReinvestigate={() => setReinvestConfirmOpen(true)}
        onClear={() => setSelected([])}
      />

      <CaseManagerHandoff target={handoffTarget} />

      {/* One-click row-close confirmation. Close is a REVERSIBLE lifecycle move, so
          this is a plain (non-destructive) confirm — it still posts through the
          analyst `close` action (server-side decide(), #3). */}
      <ConfirmDialog
        open={closeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setCloseTarget(null);
        }}
        title="Close this case?"
        description={
          closeTarget
            ? `Case ${closeTarget.case_number || closeTarget.case_id} will be closed. This is an analyst action; the resolution is adjudicated server-side.`
            : undefined
        }
        confirmLabel="Close case"
        onConfirm={() => {
          void confirmClose();
        }}
      />

      {/* Bulk reinvestigate confirmation — spends LLM tokens per case (#6) and can
          change verdict/status, so gate it like the single-case Reinvestigate popover's
          cost warning (CaseDetail.tsx) rather than firing on one click. Not destructive
          (it's cost-incurring, not data-destroying), so overlay/Escape dismiss stays on. */}
      <ConfirmDialog
        open={reinvestConfirmOpen}
        onOpenChange={setReinvestConfirmOpen}
        title={`Reinvestigate ${selectedCases.length} case${selectedCases.length === 1 ? '' : 's'}?`}
        description="Each case re-runs the full AI investigation pipeline and may change its verdict, confidence, and status. This spends LLM tokens per case. The server-owned job continues after navigation or reload."
        confirmLabel="Reinvestigate"
        onConfirm={() => {
          setReinvestConfirmOpen(false);
          void submitCaseJob('case_reinvestigate', {}, 'are being reinvestigated');
        }}
      />
    </PageContainer>
    </MotionProvider>
  );
}

/* ------------------------------------------------------------- bulk bar ---- */

/** Lifecycle statuses an analyst may bulk-set (close goes through the dedicated
 * close/resolve actions, never set_status — the backend enforces this too). */
const BULK_STATUSES: Array<{ value: string; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'escalated', label: 'Escalated' },
];

/** Dispositions an analyst may bulk-set. */
const BULK_DISPOSITIONS: Array<{ value: string; label: string }> = [
  { value: 'true_positive', label: 'True positive' },
  { value: 'false_positive', label: 'False positive' },
  { value: 'benign', label: 'Benign' },
  { value: 'suspicious', label: 'Suspicious' },
  { value: 'duplicate', label: 'Duplicate' },
];

const BulkActionBar: React.FC<{
  count: number;
  busy: boolean;
  onAcknowledge: () => void;
  onClose: () => void;
  onResolve: (reason: string) => void;
  onAssign: (assignee: string) => void;
  onAddTag: (tag: string) => void;
  onSetStatus: (status: string) => void;
  onSetDisposition: (disposition: string) => void;
  onReinvestigate: () => void;
  onClear: () => void;
}> = ({
  count,
  busy,
  onAcknowledge,
  onClose,
  onResolve,
  onAssign,
  onAddTag,
  onSetStatus,
  onSetDisposition,
  onReinvestigate,
  onClear,
}) => {
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [assignee, setAssignee] = React.useState('');
  const [tagOpen, setTagOpen] = React.useState(false);
  const [tag, setTag] = React.useState('');

  React.useEffect(() => {
    if (count === 0) {
      setAssignOpen(false);
      setAssignee('');
      setTagOpen(false);
      setTag('');
    }
  }, [count]);

  // Render via a portal to <body> so the `position: fixed` bar anchors to the VIEWPORT.
  // The page is wrapped in <PageContainer> which sets `@container`
  // (container-type: inline-size); per CSS containment that makes the container a
  // containing block for fixed descendants, so an in-tree fixed bar would dock ~20px
  // above the (tall) page content instead of floating at the bottom of the screen — the
  // well-known container-query gotcha. Portaling out escapes that containing block.
  //
  // motion.dev: the bar springs UP on select and slides back DOWN + fades on deselect
  // (an `AnimatePresence` EXIT — today it just vanishes). motion owns the FULL transform,
  // so `x: '-50%'` REPLACES the old `-translate-x-1/2` centering class (otherwise the
  // enter/exit `y` tween would wipe the horizontal centre). Under reduced motion the
  // transform is applied but not animated (bar stays centred; only opacity cross-fades).
  // AnimatePresence caches the exiting element with its last props, so the frozen bar
  // shows the last selected count during the slide-out — never a "0 selected" flash.
  const bar = (
    <motion.div
      key="bulk-bar"
      role="region"
      aria-label="Bulk actions"
      initial={{ opacity: 0, x: '-50%', y: 16 }}
      animate={{ opacity: 1, x: '-50%', y: 0 }}
      exit={{ opacity: 0, x: '-50%', y: 16 }}
      transition={HOUSE_SPRING}
      // `w-max` lets the pill hug its content up to the max-w-[94vw] ceiling, so the
      // Card's `overflow-x-auto` (below) actually engages once the controls exceed the
      // viewport instead of the wrapper silently stretching.
      className="fixed bottom-5 left-1/2 z-50 w-max max-w-[94vw]"
    >
      <Card
        elevation="none"
        // Single scrollable row, never a wrapped second line (#3): flex-nowrap +
        // overflow-x-auto scroll the controls horizontally when narrow; [&>*]:shrink-0
        // keeps every direct child at its natural width so flex-shrink can't squeeze
        // them before the row starts scrolling.
        className="flex flex-nowrap items-center gap-2 overflow-x-auto px-3 py-2.5 shadow-elev2 [&>*]:shrink-0"
      >
        <span className="inline-flex items-center rounded-md bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
          {count} selected
        </span>

        {/* cases:write tier — primary CTA of the bar: the single most common bulk
            action, so it gets the filled/primary treatment (matches the "N selected"
            badge) instead of `secondary`, whose fill token is identical to `muted`
            (theme.css `--secondary` === `--muted` === `--surface-sunken`, all
            `--slate-3`) and read as a disabled/washed-out control next to the bordered
            `outline` buttons beside it. */}
        <Button size="sm" variant="default" onClick={onAcknowledge} disabled={busy}>
          <Check className="mr-1.5 size-4" aria-hidden />
          Acknowledge
        </Button>

        {/* Assign owner — a pure owner set (cases:assign), NOT an escalation. To move
            status use "Set status → Escalated" below. */}
        <Popover open={assignOpen} onOpenChange={setAssignOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" disabled={busy}>
              <UserPlus className="mr-1.5 size-4" aria-hidden />
              Assign
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-60" side="top">
            <div className="space-y-2">
              <label
                htmlFor="bulk-assignee"
                className="block text-xs font-medium text-muted-foreground"
              >
                Assign to
              </label>
              <Input
                id="bulk-assignee"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="Analyst or team"
                aria-label="Owner for bulk assignment"
              />
              <Button
                size="sm"
                className="w-full"
                disabled={!assignee.trim() || busy}
                onClick={() => {
                  onAssign(assignee.trim());
                  setAssignOpen(false);
                }}
              >
                Assign {count}
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        {/* Add tag (cases:write) */}
        <Popover open={tagOpen} onOpenChange={setTagOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" disabled={busy}>
              <TagIcon className="mr-1.5 size-4" aria-hidden />
              Add tag
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-60" side="top">
            <div className="space-y-2">
              <label
                htmlFor="bulk-tag"
                className="block text-xs font-medium text-muted-foreground"
              >
                Tag to add
              </label>
              <Input
                id="bulk-tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="e.g. needs-review"
                aria-label="Tag to add to selected cases"
              />
              <Button
                size="sm"
                className="w-full"
                disabled={!tag.trim() || busy}
                onClick={() => {
                  onAddTag(tag.trim());
                  setTagOpen(false);
                }}
              >
                Tag {count}
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        {/* Set status (cases:write) */}
        <Select value="" onValueChange={(v) => v && onSetStatus(v)} disabled={busy}>
          <SelectTrigger className="h-8 w-[9.5rem]" aria-label="Set status for selected cases">
            <span className="inline-flex items-center text-sm">
              <SlidersHorizontal className="mr-1.5 size-4" aria-hidden />
              Set status
            </span>
          </SelectTrigger>
          <SelectContent>
            {BULK_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Set disposition (cases:write) */}
        <Select value="" onValueChange={(v) => v && onSetDisposition(v)} disabled={busy}>
          <SelectTrigger
            className="h-8 w-[10.5rem]"
            aria-label="Set disposition for selected cases"
          >
            <span className="inline-flex items-center text-sm">
              <CircleSlash className="mr-1.5 size-4" aria-hidden />
              Set disposition
            </span>
          </SelectTrigger>
          <SelectContent>
            {BULK_DISPOSITIONS.map((d) => (
              <SelectItem key={d.value} value={d.value}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Reinvestigate (cases:write-equivalent today — NOT wrapped in <Can>, matching
            the single-case Reinvestigate button in CaseDetail, which is also ungated
            pending the tracked RBAC follow-up). Gated behind a ConfirmDialog by the
            caller since it spends LLM tokens per case (#6). */}
        <Button size="sm" variant="outline" onClick={onReinvestigate} disabled={busy}>
          {busy ? (
            <RefreshCw className="mr-1.5 size-4 animate-spin" aria-hidden />
          ) : (
            <Zap className="mr-1.5 size-4" aria-hidden />
          )}
          Reinvestigate
        </Button>

        {/* Close / resolve — cases:close. Hidden unless granted (RBAC-mirrored). */}
        <Can resource="cases" action="close">
          <Button size="sm" variant="outline" onClick={() => onResolve('')} disabled={busy}>
            <Check className="mr-1.5 size-4" aria-hidden />
            Resolve
          </Button>
          <Button size="sm" variant="destructive" onClick={onClose} disabled={busy}>
            <X className="mr-1.5 size-4" aria-hidden />
            Close
          </Button>
        </Can>

        <Button size="sm" variant="ghost" onClick={onClear} disabled={busy}>
          Clear
        </Button>
      </Card>
    </motion.div>
  );

  // AnimatePresence stays mounted across count → 0 so the bar can play its exit; the
  // `count > 0` gate (not an early `return null`) is what triggers the enter/exit.
  const presence = <AnimatePresence>{count > 0 ? bar : null}</AnimatePresence>;
  return typeof document === 'undefined' ? presence : createPortal(presence, document.body);
};
