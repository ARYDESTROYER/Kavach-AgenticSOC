/**
 * Cases: the analyst triage list.
 *
 * Lists recent cases (GET /api/cases, single capped fetch) in the Overview's grammar
 * (Round 14, SPEC §4.9, operator choices C7 1 and C8 1): the page header carries the
 * title, a help tip, the count and Refresh; one KPI strip splits the loaded cases by state
 * and then by severity (each tile filters the list); the "Case queue" panel holds one
 * filter bar and the table, which bleeds to the panel edge. Below 768px the table becomes
 * Case Manager's list rows and the filters move into one "Filters" sheet. Opening a row
 * performs a short, announced handoff into Case Manager with that exact case selected;
 * Case Manager is the canonical detail workspace.
 *
 * All narrowing is CLIENT-SIDE over the loaded list, except the Rule filter, which the
 * server applies. Filter state SELF-HEALS: any selected facet value that no longer exists
 * after a reload is dropped so the list can never silently empty behind an un-clearable
 * filter.
 *
 * SECURITY: every case-derived value (title, entity, IPs, rules, tags, assignee,
 * source, model keys) is UNTRUSTED: rendered as plain text or via <InlineCode>,
 * never as markup.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  Briefcase,
  X,
  XCircle,
  Check,
  UserPlus,
  Link2,
  Tag as TagIcon,
  SlidersHorizontal,
  CircleSlash,
  LoaderCircle,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type { BackgroundJobKind, Case, CaseActionInput, SavedView } from '@/lib/types';
import { Can, useCan } from '@/soc/components/Can';
import { humanizeAge, humanizeToken, DASH } from '@/lib/format';
import { caseTagError } from '@/lib/tags';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Card } from '@/ui/card';
import { Input } from '@/ui/input';
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

import { Callout, Panel } from '@/design-system';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { KpiStrip } from '@/soc/components/KpiStrip';
import { KpiTile } from '@/soc/components/KpiTile';
import {
  FilterBar,
  type FilterBarControlContext,
  type FilterBarFilter,
  type FilterChip,
} from '@/soc/components/FilterBar';
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
import { useIsMobile } from '@/soc/hooks/useMediaQuery';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { InlineCode } from '@/soc/components/CodeBlock';
import type { AskAiChipProps } from '@/soc/components/AskAiChip';
import { useAuth } from '@/soc/auth';
import { CaseHoverCard } from '@/soc/components/CaseHoverCard';
import { StartDemoButton } from '@/soc/components/StartDemoButton';
import { useDemo } from '@/soc/demo';
import { LoadingBar } from '@/soc/components/LoadingBar';
import { isDemoCase } from '@/soc/components/DemoBadge';
import { OwnerMonogram } from '@/soc/components/OwnerMonogram';
import {
  StatusBadge,
  VerdictBadge,
  DispositionBadge,
  OutcomeBadge,
  RiskBadge,
  SeverityBadge,
  ConfidenceBadge,
  CategoryBadge,
  UrgencyPill,
  severityBand,
  SEVERITY_BAND_ORDER,
} from '@/soc/components/badges';
import { severityProvenance } from '@/soc/components/ProvenanceTag';
import { caseOutcome } from '@/soc/components/outcome';
import { statusLabel as statusBadgeLabel } from '@/soc/components/semantic-labels';
import {
  BulkCloseDialog,
  type BulkCloseInput,
  type BulkTerminalAction,
} from './casedetail/BulkCloseDialog';

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

/**
 * Round 12 WP-ASK: the "Ask AI" chip, loaded on demand so it never becomes a shared
 * chunk every route's preload list (in the entry chunk) must name (see AskAiChip.tsx,
 * "Loading"). The load starts when this module loads; the chip renders once it has
 * arrived, and never if it cannot load (the chip is optional, so it fails soft).
 */
type AskAiChipModule = typeof import('@/soc/components/AskAiChip');
let askAiChipModule: AskAiChipModule | null = null;
const askAiChipLoad: Promise<AskAiChipModule | null> = import('@/soc/components/AskAiChip').then(
  (loaded) => (askAiChipModule = loaded),
  () => null,
);
/**
 * A shell context, or null outside it. `useAuth` / `useRoute` read their context before
 * they throw, so hook order is stable; the hook is looked up inside the guard too (a test
 * double of the module may not export it).
 */
function useOptionalContext<T>(pick: () => () => T): T | null {
  try {
    return pick()();
  } catch {
    return null;
  }
}
function AskAiChip(props: AskAiChipProps) {
  const auth = useOptionalContext(() => useAuth);
  const route = useOptionalContext(() => useRoute);
  const [loaded, setLoaded] = React.useState(askAiChipModule);
  React.useEffect(() => {
    if (loaded) return undefined;
    let live = true;
    void askAiChipLoad.then((next) => {
      if (live && next) setLoaded(next);
    });
    return () => {
      live = false;
    };
  }, [loaded]);
  return loaded ? (
    <loaded.AskAiChip {...props} navigate={route?.navigate} hasPermission={auth?.hasPermission} />
  ) : null;
}

/** Stable id for the Cases table's per-user column state (Wave 7). */
const CASES_TABLE_ID = 'cases';
/** The surface scope saved views on this page belong to. */
const CASES_VIEW_SCOPE = 'cases';

/**
 * Columns hidden by DEFAULT, but ONLY when the user has never customized this table (no
 * stored ColumnState). Round 14 (SPEC §4.9.4, C7): the list opens on the columns a triage
 * pass reads (case, title, severity, status, outcome, assignee, updated); the secondary
 * signals and the per-case counts wait one click away in the Columns menu. The Outcome
 * column (id `disposition`, kept so stored column states still address it) stays visible
 * by default: an analyst's classification is the case's outcome of record (Round 12
 * D15). Fully reversible via <ColumnsMenu>; the instant the user toggles any column their
 * explicit stored state wins verbatim (this default no longer applies).
 */
const CASES_DEFAULT_HIDDEN = [
  'confidence',
  'verdict',
  'risk',
  'entity',
  'category',
  'urgency',
  'alerts',
  'enrichments',
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

/**
 * Work the agent handed to an analyst that is STILL open. Round 12 (SPEC D15): a case an
 * analyst already closed or resolved is no longer waiting for a human, whatever the AI
 * verdict said, so the "Needs human" tile and filter count ACTIVE cases only.
 */
function needsHumanCase(c: Case): boolean {
  return (
    isActiveCase(c) &&
    ((c.status || '').toLowerCase() === 'needs_human' ||
      (c.verdict || '').toUpperCase() === 'NEEDS_HUMAN')
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

/**
 * Where a case's severity came from, for the severity chip's tooltip (Round 14: the row
 * carries no provenance glyph; ProvenanceTag's source/code split, in words).
 */
function severitySourceTitle(c: Pick<Case, 'severity_source'>): string {
  return severityProvenance(c.severity_source) === 'source'
    ? 'Severity reported by the source'
    : 'Severity derived from the risk score';
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
  /**
   * Round 14 (SPEC §4.6.6): only cases from exactly this detection rule ('' = any rule).
   * The list is then read from the server with `rule`, so every case of the rule is
   * counted, not only those among the newest loaded.
   */
  rule: string;
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
  rule: '',
};

/** A rule filter value: the exact rule, 1 to 256 characters, no control or format characters. */
const RULE_FILTER_RE = /^[^\p{C}\u2028\u2029]{1,256}$/u;

/** A usable rule filter value, kept exactly (never trimmed: it is matched as written). */
function ruleFilterValue(value: unknown): string {
  return typeof value === 'string' && RULE_FILTER_RE.test(value) && value.trim() ? value : '';
}

/** The most rule names the Rule filter offers (the rules of the cases loaded so far). */
const RULE_OPTION_LIMIT = 200;
/** The Rule filter's "All rules" choice; a rule is chosen by its index (never collides with a value). */
const ALL_RULES = 'all';

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

/**
 * The values the Status, Disposition and Assignee controls offer (Round 14): the facets of
 * the cases loaded now, those of the last read across every rule (`catalog`, so choosing a
 * rule never takes away a value the person could pick before), and each value chosen now,
 * so a control always shows its own filter even when no loaded case carries it.
 */
function facetOptions(facets: Facets, catalog: Facets | null, f: CaseFilters): Facets {
  const merged = (now: string[], before: string[] | undefined, chosen: string | null) =>
    sortedUniq([...now, ...(before ?? []), ...(chosen ? [chosen] : [])]);
  return {
    statuses: merged(
      facets.statuses,
      catalog?.statuses,
      f.status !== ANY && !STATUS_SENTINELS.has(f.status) ? f.status : null,
    ),
    dispositions: merged(facets.dispositions, catalog?.dispositions, f.disposition !== ANY ? f.disposition : null),
    assignees: merged(
      facets.assignees,
      catalog?.assignees,
      f.assignee !== ANY && f.assignee !== UNASSIGNED ? f.assignee : null,
    ),
  };
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
    // Exact, as the server filtered it: one of the case's rule values, byte for byte.
    if (f.rule && !caseRules(c).includes(f.rule)) return false;

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

/**
 * The Rule filter (Round 14, SPEC §4.6.6): "All rules", or exactly one rule. It offers the
 * rules of the cases loaded so far plus the one a link chose. Rule values are untrusted
 * source text (#9): plain text in mono, never markup; an option is chosen by its index,
 * so no rule value can collide with "All rules".
 */
function RuleFilterSelect({
  value,
  options,
  onChange,
  triggerClassName,
}: {
  value: string;
  options: string[];
  onChange: (rule: string) => void;
  /** The trigger's width: fixed in the filter bar, the full width in a menu or sheet. */
  triggerClassName?: string;
}) {
  const rules = React.useMemo(
    () => (value && !options.includes(value) ? [value, ...options] : options),
    [value, options],
  );
  const selected = value ? rules.indexOf(value) : -1;
  return (
    <Select
      value={selected >= 0 ? `r:${selected}` : ALL_RULES}
      onValueChange={(v) => {
        if (v === ALL_RULES) onChange('');
        else {
          const rule = rules[Number(v.slice(2))];
          if (rule !== undefined) onChange(rule);
        }
      }}
    >
      <SelectTrigger
        className={cn('h-8 min-w-0 text-sm', triggerClassName ?? 'w-full')}
        aria-label="Filter by rule"
        title={value || undefined}
      >
        <SelectValue placeholder="Rule" />
      </SelectTrigger>
      <SelectContent className="max-w-[min(32rem,90vw)]">
        <SelectItem value={ALL_RULES}>All rules</SelectItem>
        {rules.map((rule, index) => (
          <SelectItem key={rule} value={`r:${index}`}>
            <span className="block truncate font-mono">{rule}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
    rule: f.rule,
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
    rule: ruleFilterValue(r.rule),
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
  /**
   * Round 14 (SPEC §4.6.6): seed the Rule filter (the rule sheet's "Show the N cases", a
   * `#/cases?rule=` link). The exact rule value; an invalid one is ignored.
   */
  initialRule?: string;
}

/** Severity-band values the Cases severity filter (and the #38 drill-through) accepts. */
const SEVERITY_FILTER_VALUES = new Set(['critical', 'high', 'medium', 'low', 'info']);

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
        className="w-full max-w-sm rounded-lg border border-border bg-background p-5 shadow-elev2"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-primary/35 bg-primary/10 text-primary">
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
  initialRule: initialRuleProp,
}: CasesProps) {
  const route = useRoute();
  // Bulk changes run as durable jobs, which the server refuses in Demo Mode.
  const { active: demoActive } = useDemo();
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
  const initialRule = ruleFilterValue(initialRuleProp ?? route.opts?.rule) || undefined;

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
    if (initialRule) f = { ...f, rule: initialRule };
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
  // The controls that opened the (state-driven) close dialogs: focus returns there, not
  // to <body>, when the dialog closes.
  const closeOpenerRef = React.useRef<HTMLElement | null>(null);
  const bulkTerminalOpenerRef = React.useRef<HTMLElement | null>(null);
  const captureBulkOpener = () => {
    const active = document.activeElement;
    bulkTerminalOpenerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  };
  // Round 12 (SPEC D15): every bulk Close / Resolve captures the analyst's disposition.
  const [bulkTerminal, setBulkTerminal] = React.useState<BulkTerminalAction | null>(null);
  // Round 14 (D34): the close dialogs read the runbook progress of the cases they close,
  // so they can say how many have required steps open and take one reason for them.
  const closeTargetIds = React.useMemo(() => (closeTarget ? [closeTarget.case_id] : undefined), [closeTarget]);

  // Below 768px the list is Case Manager's rows and the filters one sheet (SPEC §4.9.4).
  const isMobile = useIsMobile();
  const [phoneLimit, setPhoneLimit] = React.useState(PHONE_PAGE);

  // Exact server totals for the lifecycle tiles when only the newest LIST_LIMIT cases are
  // loaded (Round 12): the loaded slice is the NEWEST cases, which in a busy deployment are
  // mostly closed, so counting it read "Active 1 · Needs human 0" while hundreds waited.
  const [serverCounts, setServerCounts] = React.useState<{
    active: number | null;
    terminal: number | null;
    needsHuman: number | null;
  } | null>(null);

  // The Rule filter is applied by the server (every case of the rule, not only the newest
  // loaded); the other filters narrow the loaded list here.
  const serverRule = filters.rule;
  // The rules the Rule filter offers: every rule seen on the cases loaded so far.
  const [ruleOptions, setRuleOptions] = React.useState<string[]>([]);
  const loadSeq = React.useRef(0);
  // The rule the lifecycle tiles' server totals were read for ('' = every rule). A changed
  // rule clears them at once, so the tiles never show another rule's figures (or every
  // case's) while the new reads run.
  const countsRule = React.useRef('');
  // The rule the loaded list was read for ('' = every rule): the badge, the tiles and the
  // empty state say what the figures cover from it, never from a read still in flight.
  const [loadedRule, setLoadedRule] = React.useState('');
  // The Status, Disposition and Assignee values of the last read across every rule. A
  // rule's own read is narrower, so the controls keep offering these while one is chosen.
  const [catalogFacets, setCatalogFacets] = React.useState<Facets | null>(null);
  const load = React.useCallback(async () => {
    const seq = ++loadSeq.current;
    if (countsRule.current !== serverRule) {
      countsRule.current = serverRule;
      setServerCounts(null);
    }
    setLoading(true);
    setError(null);
    const ruleQuery = serverRule ? { rule: serverRule } : {};
    try {
      const res = await api.listCases({ limit: LIST_LIMIT, ...ruleQuery });
      // A newer read (another rule chosen meanwhile) wins.
      if (seq !== loadSeq.current) return;
      setCases(res.cases);
      setTotal(res.total);
      setLoadedRule(serverRule);
      if (!serverRule) setCatalogFacets(buildFacets(res.cases));
      setRuleOptions((prev) => {
        const seen = new Set(prev);
        for (const c of res.cases) for (const r of caseRules(c)) if (ruleFilterValue(r)) seen.add(r);
        return seen.size === prev.length ? prev : sortedUniq(seen).slice(0, RULE_OPTION_LIMIT);
      });
      if (res.total > res.cases.length) {
        // Best effort, never blocking the list: a failed count falls back to the
        // loaded-slice count, labelled as such. Needs human is the SAME rule as
        // `needsHumanCase` — an active case whose status OR AI verdict is needs_human —
        // counted with STRUCTURED filters (exact status + exact verdict), never the free
        // text search, whose haystack also matches titles, summaries, entity values and
        // assignees. The union is |status| + |active ∧ verdict| − |status ∧ verdict|
        // (a needs_human status is always active), so each case counts once.
        const count = (query: Record<string, string | number>) =>
          api.listCases({ ...query, ...ruleQuery, limit: 1 }).then((r) => (typeof r.total === 'number' ? r.total : null), () => null);
        void Promise.all([
          count({ status_group: 'active' }),
          count({ status_group: 'terminal' }),
          count({ status: 'needs_human' }),
          count({ status_group: 'active', verdict: 'NEEDS_HUMAN' }),
          count({ status: 'needs_human', verdict: 'NEEDS_HUMAN' }),
        ]).then(([active, terminal, byStatus, byVerdict, both]) => {
          // A newer read (another rule chosen, or a refresh) owns the tiles now.
          if (seq !== loadSeq.current) return;
          const needsHuman =
            byStatus !== null && byVerdict !== null && both !== null
              ? Math.max(0, byStatus + byVerdict - both)
              : null;
          setServerCounts({ active, terminal, needsHuman });
        });
      } else {
        setServerCounts(null);
      }
    } catch (e) {
      if (seq === loadSeq.current) setError(e);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [serverRule]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // A rule drill (the rule sheet's "Show the N cases") can change `initialRule` while mounted.
  React.useEffect(() => {
    if (initialRule) setFilters((f) => ({ ...f, rule: initialRule }));
  }, [initialRule]);

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
  // What the facet controls offer: never fewer values because a rule is chosen, and
  // always the value each one filters by.
  const controlFacets = React.useMemo(
    () => facetOptions(facets, loadedRule ? catalogFacets : null, filters),
    [facets, loadedRule, catalogFacets, filters],
  );

  // Self-heal selected facet values when the loaded rows change.
  React.useEffect(() => {
    // Do not erase a deep-linked assignee while the first case page is still loading
    // and the facet catalog is necessarily empty. Heal only against a read across every
    // rule (Round 14): a rule's own read holds only that rule's cases, so a value none of
    // them carries is a filter with no results there, never a value to throw away (the
    // person's Assignee, say, comes back with its cases when the rule is cleared).
    if (!loading && !loadedRule) setFilters((f) => healFilters(f, facets));
  }, [facets, loading, loadedRule]);

  const filtered = React.useMemo(() => applyFilters(cases, filters), [cases, filters]);

  const filteredSorted = React.useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const cmp = sortComparators[sort.id as SortId] ?? sortComparators.updated_at;
    return [...filtered].sort((a, b) => cmp(a, b) * dir);
  }, [filtered, sort]);

  // Reset to page 1 (and the phone list to its first page) whenever the filtered set or
  // the page size changes.
  React.useEffect(() => {
    setPage(1);
    setPhoneLimit(PHONE_PAGE);
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
  // when truncated, never read as a fraction of the server total. The one exception is
  // the Rule filter (Round 14): the server reads only that rule's cases, so every figure
  // covers them, and the badge, tooltips and empty state say "from this rule".
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
  // " from the rule <value>" when the loaded list is one rule's cases (plain text, #9).
  const ruleScope = loadedRule ? ` from the rule ${loadedRule}` : '';
  // Tooltip clarifying that the Active/Needs-human/severity pills count the LOADED set.
  const loadedScopeTitle = truncated
    ? `Among the ${cases.length.toLocaleString()} loaded cases${ruleScope} (of ${total.toLocaleString()})`
    : `Among ${cases.length.toLocaleString()} case${cases.length === 1 ? '' : 's'}${ruleScope}`;
  // A truncated list: the lifecycle tiles show the exact server total (with how many of
  // them the loaded list can show); the severity tiles count the loaded slice and say so.
  const loadedNote = truncated ? `of ${cases.length.toLocaleString()} loaded` : undefined;
  const lifecycleTile = (
    loadedCount: number,
    server: number | null | undefined,
    noun: readonly [singular: string, plural: string],
  ) =>
    truncated && typeof server === 'number'
      ? {
          count: server,
          note: `${loadedCount.toLocaleString()} loaded`,
          title:
            `${server.toLocaleString()} ${server === 1 ? noun[0] : noun[1]}${ruleScope} in total; ` +
            `${loadedCount.toLocaleString()} of them ${loadedCount === 1 ? 'is' : 'are'} among the ` +
            `${cases.length.toLocaleString()} loaded cases this list filters`,
        }
      : { count: loadedCount, note: loadedNote, title: loadedScopeTitle };
  const activeTile = lifecycleTile(counts.active, serverCounts?.active, ['active case', 'active cases']);
  const terminalTile = lifecycleTile(counts.terminal, serverCounts?.terminal, [
    'resolved or closed case',
    'resolved or closed cases',
  ]);
  const needsHumanTile = lifecycleTile(counts.needsHuman, serverCounts?.needsHuman, [
    'active case awaiting an analyst',
    'active cases awaiting an analyst',
  ]);

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
  // The selection the bulk close dialog covers (it reads their runbook progress).
  const bulkTerminalIds = React.useMemo(
    () => (bulkTerminal ? selectedCases.map((c) => c.case_id).sort((a, b) => a.localeCompare(b)) : undefined),
    [bulkTerminal, selectedCases],
  );
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
  const confirmClose = React.useCallback(
    async (input: BulkCloseInput) => {
      const target = closeTarget;
      if (!target) return;
      setCloseTarget(null);
      try {
        // Round 12 (SPEC D15): the one-click row close records the outcome the analyst
        // chose, declared, exactly like the case's own Close dialog (G1).
        await api.caseActionExec(target.case_id, {
          action: 'close',
          disposition: input.disposition,
          disposition_declared: true,
          resolution: input.resolution || 'Closed by analyst',
          ...(input.note ? { note: input.note } : {}),
          // Round 14 (D34): the reason for closing with required runbook steps open,
          // audited with the close. A close by hand never waits for the steps.
          ...(input.open_steps_reason ? { open_steps_reason: input.open_steps_reason } : {}),
        });
        await load();
      } catch {
        setBulkError(`Could not close ${target.case_number || target.case_id}.`);
      }
    },
    [closeTarget, load],
  );

  const setFilter = <K extends keyof CaseFilters>(key: K, value: CaseFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));


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
  // Round 14 (SPEC §4.9.4, C7): the columns a triage pass reads come first, in reading
  // order, and the title takes the spare width (never under 280px); the secondary signals
  // follow, hidden by default (CASES_DEFAULT_HIDDEN). No provenance glyph and no severity
  // stripe in the row: the chip's tooltip says where severity came from.
  const columns: DataTableColumn<Case>[] = [
    {
      id: 'case_id',
      header: 'Case ID',
      sortable: true,
      // 120px (SPEC §4.9.4): an 88px content box that holds "CASE-000048" (79px).
      width: '7.5rem',
      kind: 'id',
      lockVisible: true,
      // The id button truncates itself, so the cell skips the shared one-line clip: the
      // Ask AI chip below reaches into the cell's trailing padding and must not be cut.
      wrap: true,
      text: (c) => c.case_number || c.case_id,
      cell: (c) => (
        // Ask AI shows at the end of the id on hover or focus of the cell, instead of
        // reserving its width in every row (C7). It sits in the cell's trailing padding,
        // flush with the cell's edge, and the id never runs under it (the button stops 8px
        // short of the content box): the case number is the row's open target, and a
        // click on it must never start a chat instead.
        <div className="group/ask relative flex min-w-0 items-center" data-testid="case-id-cell">
          <CaseHoverCard case={c}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openInCaseManager(c.case_id, c.case_number || c.case_id);
              }}
              className="max-w-[calc(100%-0.5rem)] truncate rounded-sm font-mono text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {c.case_number || c.case_id}
            </button>
          </CaseHoverCard>
          {/* Round 12 WP-ASK: a new Workspace chat that asks the server's question about this case;
              a case number in a custom format the question cannot name falls back to the id. */}
          <AskAiChip
            kind="case"
            value={c.case_number || c.case_id}
            fallbackValue={c.case_id}
            className="absolute -right-4 top-1/2 -translate-y-1/2"
          />
        </div>
      ),
    },
    {
      id: 'title',
      header: 'Title',
      sortable: true,
      minWidth: 280,
      text: (c) => c.title || c.case_id,
      cell: (c) => (
        <CaseHoverCard case={c}>
          <span className="block min-w-0 cursor-pointer truncate font-medium text-foreground">
            {c.title || c.case_id}
          </span>
        </CaseHoverCard>
      ),
    },
    {
      // Severity's provenance changes per row (reported by the source, or derived from the
      // risk score); the chip's tooltip says which, instead of a glyph in every row.
      id: 'severity',
      header: 'Severity',
      sortable: true,
      width: '6.5rem',
      text: (c) => humanizeToken(caseSeverityBand(c) ?? '') || 'Not graded',
      cell: (c) => {
        const band = caseSeverityBand(c);
        return (
          <span
            className="inline-flex"
            title={band ? severitySourceTitle(c) : undefined}
            data-severity-source={band ? severityProvenance(c.severity_source) : undefined}
          >
            <SeverityBadge severity={band} className="px-1.5 text-2xs" />
            {/* The same fact for assistive technology (a title alone is mouse-only). */}
            {band ? <span className="sr-only">{`, ${severitySourceTitle(c).toLowerCase()}`}</span> : null}
          </span>
        );
      },
    },
    {
      // One status badge per row: who closed the case is the Outcome column's job.
      id: 'status',
      header: 'Status',
      sortable: true,
      // Wide enough for the longest common label, "Open · awaiting analyst" (the F8 name
      // of needs_human). With the widths below, every default column fits at 1440px beside
      // a 280px title; narrower windows scroll the table with its edge fade.
      width: '11.75rem',
      text: (c) => (c.status ? statusBadgeLabel(c.status) : 'Unknown'),
      cell: (c) => (
        <StatusBadge
          status={c.status}
          className={cn(
            'px-1.5 text-2xs',
            // Every status in the tinted style: Investigating was a solid fill.
            (c.status || '').toLowerCase() === 'investigating' && 'border-info/30 bg-info/10 text-info-text',
          )}
        />
      ),
    },
    {
      // Round 12 (SPEC D15): the OUTCOME of record. Once an analyst classified the case
      // it shows their disposition; an AI auto-close says so; until then the recorded
      // disposition is shown as what it is, the value triage mapped from the AI verdict
      // (said in its tooltip), never presented as a person's call.
      id: 'disposition',
      header: 'Outcome',
      sortable: true,
      width: '9.25rem',
      // The cut text's tooltip is the whole outcome ("Auto-closed as false positive").
      text: (c) => caseOutcome(c).headline,
      cell: (c) => {
        const outcome = caseOutcome(c);
        if (outcome.source === 'agent_auto') {
          // A table cell says "Auto-closed" (the short label the Case Manager queue uses);
          // the verdict it closed on is in the tooltip, so the badge fits its column.
          return (
            <Badge
              variant="info"
              data-testid="case-outcome"
              data-outcome-source="agent_auto"
              title={outcome.headline}
            >
              <Bot className="size-3 shrink-0" aria-hidden />
              {outcome.shortLabel}
              <span className="sr-only">{`, ${outcome.headline.toLowerCase()}`}</span>
            </Badge>
          );
        }
        if (outcome.source !== 'pending') return <OutcomeBadge outcome={outcome} />;
        return (
          <span
            className="inline-flex items-center gap-1"
            data-outcome-source="pending"
            title="Mapped from the AI verdict; no analyst has classified this case yet"
          >
            <DispositionBadge disposition={c.disposition ?? null} />
          </span>
        );
      },
    },
    {
      // Owner cell: the shared owner monogram and the assignee name, or a muted
      // "Unassigned". The name is case-derived (UNTRUSTED) so it renders as plain text; the
      // monogram is decorative here (the name beside it is the text).
      id: 'assignee',
      header: 'Assignee',
      sortable: true,
      width: '7.5rem',
      text: (c) => (c.assignee || '').trim() || 'Unassigned',
      cell: (c) => {
        const name = (c.assignee || '').trim();
        if (!name) {
          return <span className="text-sm text-muted-foreground">Unassigned</span>;
        }
        return (
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            <OwnerMonogram name={name} decorative />
            <span className="min-w-0 truncate">{name}</span>
          </span>
        );
      },
    },
    {
      id: 'updated_at',
      header: 'Updated',
      sortable: true,
      width: '5.5rem',
      kind: 'time',
      cell: (c) => (
        <span className="text-sm text-muted-foreground">{humanizeAge(c.updated_at || c.created_at)}</span>
      ),
    },
    {
      id: 'confidence',
      header: 'Confidence',
      sortable: true,
      width: '7rem',
      // The confidence score is an AI (LLM) judgement: constant provenance for the whole
      // column, declared once at the header.
      provenance: 'ai',
      cell: (c) => <ConfidenceBadge confidence={c.confidence} />,
    },
    {
      id: 'verdict',
      header: 'Verdict',
      width: '8.5rem',
      // The verdict is an AI (LLM) judgement: constant column provenance.
      provenance: 'ai',
      cell: (c) => <VerdictBadge verdict={c.verdict} />,
    },
    {
      id: 'risk',
      header: 'Risk',
      width: '6rem',
      // Risk is the DETERMINISTIC risk_score: constant column provenance.
      provenance: 'code',
      cell: (c) => <RiskBadge score={c.risk_score} />,
    },
    {
      id: 'entity',
      header: 'Entity',
      width: '12rem',
      text: (c) => (c.entity ? `${c.entity.type}: ${c.entity.value}` : DASH),
      cell: (c) => {
        if (!c.entity) return <span className="text-muted-foreground">{DASH}</span>;
        return (
          // The value stays on one line (a long one truncates, whole in its title) so the
          // cell is never squeezed into a letter-per-line column; the Ask AI chip shows
          // beside it on hover or focus of the cell.
          <div className="group/ask flex min-w-0 items-center gap-1.5">
            <span className="flex min-w-0 items-center gap-1 whitespace-nowrap text-sm text-foreground">
              <span className="text-muted-foreground">{c.entity.type}:</span>
              <InlineCode className="min-w-0 truncate break-normal" title={c.entity.value}>
                {c.entity.value}
              </InlineCode>
            </span>
            <AskAiChip type={c.entity.type} value={c.entity.value} />
          </div>
        );
      },
    },
    {
      id: 'category',
      header: 'Category',
      sortable: true,
      width: '7rem',
      cell: (c) => <CategoryBadge category={caseCategory(c)} />,
    },
    {
      id: 'urgency',
      header: 'Urgency',
      width: '6.5rem',
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
      id: 'enrichments',
      header: 'Enrichments',
      align: 'left',
      width: '7.5rem',
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
    // Actions column, only present when the operator can close (RBAC-mirrored). A case
    // Close is a REVERSIBLE lifecycle move (it can be reopened), so it uses a close glyph
    // (XCircle) and the neutral tone, NOT the Trash/delete grammar that implies data loss.
    // A closed or resolved case has nothing to close, so its cell is empty.
    ...(canClose
      ? ([
          {
            id: 'actions',
            header: <span className="sr-only">Actions</span>,
            menuLabel: 'Actions',
            align: 'right',
            // The 28px button plus the cell's 16px padding on each side.
            width: '4rem',
            cell: (c: Case) =>
              isTerminalCase(c) ? null : (
                <Button
                  variant="ghost"
                  size="icon"
                  // `-my-1`: the 28px target stays out of the row's flow, so an Active row
                  // keeps the compact height (about 38px) of a row without the button.
                  className="-my-1 size-7 text-muted-foreground hover:text-foreground"
                  aria-label={`Close ${c.case_number || c.case_id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeOpenerRef.current = e.currentTarget;
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

  // Column-menu descriptors (plain-text labels; the actions column is hideable but the
  // locked case_id column always shows). Derived from the columns above so the menu and
  // the table never drift.
  const columnMenuItems: ColumnMenuItem[] = columns.map((c) => ({
    id: c.id,
    label: c.menuLabel ?? (typeof c.header === 'string' ? c.header : c.id),
    lockVisible: c.lockVisible,
  }));

  /* -------------------------------------------------------- page chrome ---- */
  // ONE count per page, in the header (C7): every case in the store, or the newest slice
  // that was loaded. "N of M shown" joins it on the queue panel only while a filter narrows
  // the list. Plain text (the rule is untrusted, #9, and only said as "this rule" here).
  const caseNoun = (n: number) => (n === 1 ? 'case' : 'cases');
  const headerCount = truncated
    ? `Newest ${cases.length.toLocaleString()} of ${total.toLocaleString()} ${caseNoun(total)}${loadedRule ? ' from this rule' : ''}`
    : `${total.toLocaleString()} ${caseNoun(total)}${loadedRule ? ' from this rule' : ''} · all time`;
  const headerCountTitle = truncated
    ? `${cases.length.toLocaleString()} of ${total.toLocaleString()} cases${ruleScope} loaded`
    : loadedRule
      ? `${total.toLocaleString()} ${caseNoun(total)}${ruleScope}`
      : undefined;
  const narrowed = filteredSorted.length !== cases.length;
  const demoRows = cases.some(isDemoCase);
  const pageEmpty = (loading || Boolean(error)) && cases.length === 0;

  // The strip's context lines: a share of the loaded cases ("19% of 77"), or, for a
  // truncated list, what the loaded slice can show.
  const shareOf = (n: number) =>
    cases.length > 0 ? `${Math.round((n / cases.length) * 100)}% of ${cases.length.toLocaleString()}` : undefined;
  const lifecycleTiles = [
    {
      id: 'open',
      label: 'Active',
      tile: activeTile,
      facet: ACTIVE,
      context: activeTile.note ?? shareOf(activeTile.count),
    },
    {
      id: 'terminal',
      label: 'Resolved or closed',
      tile: terminalTile,
      facet: TERMINAL,
      context: terminalTile.note ?? shareOf(terminalTile.count),
    },
    {
      id: 'needs-human',
      label: 'Needs human',
      tile: needsHumanTile,
      facet: NEEDS_HUMAN,
      context: needsHumanTile.note ?? 'awaiting an analyst',
    },
  ] as const;
  const severityTiles = (['critical', 'high', 'medium', 'low'] as const).map((band) => ({
    band,
    label: humanizeToken(band),
    count: counts.bySeverity[band],
    context: loadedNote ?? shareOf(counts.bySeverity[band]),
  }));

  // One filter bar (SPEC §4.9.2): the search, three primary filters, and the rest behind
  // "More filters" (on a phone, all of them in one "Filters" sheet). Each control names
  // itself; a filter that holds a value shows as a removable chip.
  const barWidth = (placement: FilterBarControlContext['placement'], width: string) =>
    placement === 'bar' ? width : 'w-full';
  const statusLabel = (value: string) =>
    value === ACTIVE
      ? 'Active cases'
      : value === TERMINAL
        ? 'Resolved or closed'
        : value === NEEDS_HUMAN
          ? 'Needs human'
          : value === 'needs_human'
            ? 'Open, awaiting an analyst'
            : humanizeToken(value);
  const timeRangeLabel: Record<TimeRange, string> = {
    all: 'Any time',
    '1h': 'Last 1 hour',
    '24h': 'Last 24 hours',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
  };
  const noiseOutcomeLabel: Record<NoiseOutcomeFilter, string> = {
    auto_cleared: 'Auto-cleared by AI',
    escalated: 'Escalated to analyst',
    closed: 'Closed by human',
  };
  const filterControls: FilterBarFilter[] = [
    {
      id: 'status',
      label: 'Status',
      active: filters.status !== ANY,
      control: ({ placement }) => (
        <Select value={filters.status} onValueChange={(v) => setFilter('status', v)}>
          <SelectTrigger className={cn('h-8 text-sm', barWidth(placement, 'w-[10.5rem]'))} aria-label="Filter by status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All statuses</SelectItem>
            <SelectItem value={ACTIVE}>Active cases</SelectItem>
            <SelectItem value={TERMINAL}>Resolved or closed</SelectItem>
            <SelectItem value={NEEDS_HUMAN}>Needs human</SelectItem>
            {controlFacets.statuses.filter((s) => s !== 'needs_human').map((s) => (
              <SelectItem key={s} value={s}>
                {humanizeToken(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      id: 'severity',
      label: 'Severity',
      active: filters.severity !== ANY,
      control: ({ placement }) => (
        <Select value={filters.severity} onValueChange={(v) => setFilter('severity', v)}>
          <SelectTrigger className={cn('h-8 text-sm', barWidth(placement, 'w-[9rem]'))} aria-label="Filter by severity">
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
      ),
    },
    {
      id: 'assignee',
      label: 'Assignee',
      active: filters.assignee !== ANY,
      control: ({ placement }) => (
        <Select value={filters.assignee} onValueChange={(v) => setFilter('assignee', v)}>
          <SelectTrigger className={cn('h-8 text-sm', barWidth(placement, 'w-[9.5rem]'))} aria-label="Filter by assignee">
            <SelectValue placeholder="Assignee" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All assignees</SelectItem>
            <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
            {controlFacets.assignees.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      id: 'rule',
      label: 'Rule',
      active: Boolean(filters.rule),
      control: ({ placement }) => (
        <RuleFilterSelect
          value={filters.rule}
          options={ruleOptions}
          onChange={(rule) => setFilter('rule', rule)}
          triggerClassName={barWidth(placement, 'w-[13rem]')}
        />
      ),
    },
    ...(controlFacets.dispositions.length
      ? [
          {
            id: 'disposition',
            label: 'Outcome',
            active: filters.disposition !== ANY,
            control: ({ placement }: FilterBarControlContext) => (
              <Select value={filters.disposition} onValueChange={(v) => setFilter('disposition', v)}>
                <SelectTrigger
                  className={cn('h-8 text-sm', barWidth(placement, 'w-[11rem]'))}
                  aria-label="Filter by disposition"
                >
                  <SelectValue placeholder="Outcome" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All outcomes</SelectItem>
                  {controlFacets.dispositions.map((d) => (
                    <SelectItem key={d} value={d}>
                      {humanizeToken(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ),
          } satisfies FilterBarFilter,
        ]
      : []),
    {
      id: 'noiseOutcome',
      label: 'Flow outcome',
      active: filters.noiseOutcome !== ANY,
      control: ({ placement }) => (
        <Select value={filters.noiseOutcome} onValueChange={(v) => setFilter('noiseOutcome', v)}>
          <SelectTrigger
            className={cn('h-8 text-sm', barWidth(placement, 'w-[12rem]'))}
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
      ),
    },
    {
      id: 'timeRange',
      label: 'Created within',
      active: filters.timeRange !== 'all',
      control: ({ placement }) => (
        <Select value={filters.timeRange} onValueChange={(v) => setFilter('timeRange', v as TimeRange)}>
          <SelectTrigger className={cn('h-8 text-sm', barWidth(placement, 'w-[10rem]'))} aria-label="Created within">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(timeRangeLabel) as TimeRange[]).map((value) => (
              <SelectItem key={value} value={value}>
                {timeRangeLabel[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      id: 'relatedOnly',
      label: 'Linked across sources',
      active: filters.relatedOnly,
      control: ({ placement }) => (
        <Button
          variant={filters.relatedOnly ? 'default' : 'outline'}
          size="sm"
          className={cn('h-8 justify-start gap-1.5', barWidth(placement, 'w-auto'))}
          onClick={() => setFilter('relatedOnly', !filters.relatedOnly)}
          aria-pressed={filters.relatedOnly}
        >
          <Link2 aria-hidden />
          Only cases linked across sources
        </Button>
      ),
    },
    // Saved views ride in the phone sheet (the panel's title row holds them from 768px).
    ...(isMobile
      ? [
          {
            id: 'savedView',
            label: 'Saved view',
            control: (
              <SavedViewsBar
                scope={CASES_VIEW_SCOPE}
                activeViewId={activeViewId}
                onApply={applySavedView}
                getCurrent={captureCurrent}
              />
            ),
          } satisfies FilterBarFilter,
        ]
      : []),
  ];
  const filterChips: FilterChip[] = [
    ...(filters.status !== ANY
      ? [{ id: 'status', label: `Status: ${statusLabel(filters.status)}`, onRemove: () => setFilter('status', ANY) }]
      : []),
    ...(filters.severity !== ANY
      ? [{ id: 'severity', label: `Severity: ${humanizeToken(filters.severity)}`, onRemove: () => setFilter('severity', ANY) }]
      : []),
    ...(filters.assignee !== ANY
      ? [
          {
            id: 'assignee',
            label: `Assignee: ${filters.assignee === UNASSIGNED ? 'Unassigned' : filters.assignee}`,
            onRemove: () => setFilter('assignee', ANY),
          },
        ]
      : []),
    ...(filters.rule ? [{ id: 'rule', label: `Rule: ${filters.rule}`, onRemove: () => setFilter('rule', '') }] : []),
    ...(filters.disposition !== ANY
      ? [{ id: 'disposition', label: `Outcome: ${humanizeToken(filters.disposition)}`, onRemove: () => setFilter('disposition', ANY) }]
      : []),
    ...(filters.noiseOutcome !== ANY && NOISE_OUTCOMES.has(filters.noiseOutcome as NoiseOutcomeFilter)
      ? [
          {
            id: 'noiseOutcome',
            label: `Flow outcome: ${noiseOutcomeLabel[filters.noiseOutcome as NoiseOutcomeFilter]}`,
            onRemove: () => setFilter('noiseOutcome', ANY),
          },
        ]
      : []),
    ...(filters.timeRange !== 'all'
      ? [{ id: 'timeRange', label: `Created: ${timeRangeLabel[filters.timeRange].toLowerCase()}`, onRemove: () => setFilter('timeRange', 'all') }]
      : []),
    ...(filters.relatedOnly
      ? [{ id: 'relatedOnly', label: 'Linked across sources', onRemove: () => setFilter('relatedOnly', false) }]
      : []),
  ];

  // Phones: Case Manager's list rows instead of a table in which only the id and a cut
  // title showed (ui-audit X16). The list grows by one page at a time.
  const phoneRows = filteredSorted.slice(0, phoneLimit);
  const phoneMore = filteredSorted.length - phoneRows.length;

  const emptyNode = (
    <EmptyState
      compact
      icon={Briefcase}
      // A rule that matches nothing is a filter with no results, not an empty console.
      title={cases.length === 0 ? (loadedRule ? 'No cases from this rule' : 'No cases yet') : 'No cases match your filters'}
      description={
        cases.length === 0
          ? loadedRule
            ? 'No case in the store came from this rule. Choose All rules to see every case.'
            : 'Run an investigation or enable background scans to start triaging.'
          : 'No loaded cases match the current filters. Clear them to see all cases.'
      }
      action={
        cases.length === 0 && loadedRule ? (
          <Button variant="outline" size="sm" onClick={() => setFilter('rule', '')}>
            <X className="mr-1.5 size-4" aria-hidden />
            All rules
          </Button>
        ) : cases.length > 0 ? (
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
  );

  /* ------------------------------------------------------------- render ---- */
  return (
    <MotionProvider>
    <PageContainer
      variant="fluid"
      // Reserve bottom space whenever the fixed bulk bar is showing so it never covers the
      // last table rows or the pager. Keyed to the SAME selection state the bar's own
      // visibility gate reads, so the padding and the bar are always in lockstep.
      className={cn(selectedCases.length > 0 && 'pb-28')}
    >
      <PageHeader
        title={t('cases', 'Cases')}
        help="Every case the agent opened, newest activity first. The tiles filter the list; open a case to work it in Case Manager."
        controls={
          <>
            <span
              data-testid="cases-count-total"
              title={headerCountTitle}
              className="text-sm tabular-nums text-muted-foreground"
            >
              {headerCount}
            </span>
            <RefreshButton
              display="icon"
              label="Refresh cases"
              onClick={() => void load()}
              refreshing={loading}
            />
          </>
        }
      />

      {/* The KPI strip: the loaded cases split by state, then (after the strong rule) by
          severity. Each tile toggles the matching filter. Counts are a stable snapshot of
          the loaded set (they do not collapse when a filter is applied); a truncated list
          shows exact server totals on the state tiles and says what the loaded slice can
          show. The hover title states the basis in full. */}
      {pageEmpty ? null : (
        // On a phone the strip is two columns of compact tiles, and the strong rule between
        // state and severity is left out: there Critical starts no row, so the rule would
        // stand between two tiles of one row.
        <KpiStrip label="Case summary" density={isMobile ? 'compact' : 'comfortable'} data-testid="cases-summary-strip">
          {lifecycleTiles.map(({ id, label, tile, facet, context }) => (
            <div key={id} className="grid min-w-0" title={tile.title} data-testid={`cases-summary-${id}`}>
              <KpiTile
                label={label}
                value={tile.count.toLocaleString()}
                countTo={tile.count}
                format={(n) => n.toLocaleString()}
                context={context}
                testId={`cases-summary-${id}`}
                pressed={filters.status === facet}
                onClick={() => setFilter('status', filters.status === facet ? ANY : facet)}
              />
            </div>
          ))}
          {severityTiles.map(({ band, label, count, context }) => (
            <div key={band} className="grid min-w-0" title={loadedScopeTitle} data-testid={`cases-summary-${band}`}>
              <KpiTile
                label={label}
                value={count.toLocaleString()}
                countTo={count}
                format={(n) => n.toLocaleString()}
                context={context}
                accent={band === 'critical' ? 'critical' : undefined}
                breakBefore={band === 'critical' && !isMobile}
                testId={`cases-summary-${band}`}
                pressed={filters.severity === band}
                onClick={() => setFilter('severity', filters.severity === band ? ANY : band)}
              />
            </div>
          ))}
        </KpiStrip>
      )}

      {/* A truncated list: filters and tiles act on the loaded cases only. */}
      {truncated ? (
        <Callout
          intent="warning"
          title={`Showing the newest ${cases.length.toLocaleString()} of ${total.toLocaleString()} cases${loadedRule ? ' from this rule' : ''}`}
        >
          Filters work on the loaded cases. Search, or narrow the time range, to find older ones.
        </Callout>
      ) : null}

      {bulkError ? (
        <Callout intent="error" title="Some actions failed">
          {bulkError}
        </Callout>
      ) : null}

      {error ? (
        <LoadError error={error} title="Could not load cases" onRetry={() => void load()} />
      ) : null}

      {error && cases.length === 0 ? null : (
        <Panel
          title="Case queue"
          padding="none"
          count={narrowed ? `${filteredSorted.length.toLocaleString()} of ${cases.length.toLocaleString()} shown` : undefined}
          caption={
            demoRows ? (
              <Badge
                variant="warning"
                className="px-1.5 py-0 text-xs font-medium"
                title="Demo data: these cases are synthetic, not from a real environment"
              >
                Demo
              </Badge>
            ) : undefined
          }
          actions={
            isMobile ? undefined : (
              <>
                <SavedViewsBar
                  scope={CASES_VIEW_SCOPE}
                  activeViewId={activeViewId}
                  onApply={applySavedView}
                  getCurrent={captureCurrent}
                />
                <ColumnsMenu columns={columnMenuItems} state={effectiveColumnState} onChange={handleColumnState} />
              </>
            )
          }
          data-testid="cases-queue"
        >
          {pageEmpty ? null : (
            <FilterBar
              aria-label="Case filters"
              data-testid="cases-filter-band"
              className="px-4 pb-3 xl:px-5 3xl:px-6"
              search={{
                value: filters.search,
                onChange: (value) => setFilter('search', value),
                label: 'Search cases',
                placeholder: 'Search by ID, title, entity, rule or tag',
                compactPlaceholder: 'Search cases',
              }}
              filters={filterControls}
              chips={filterChips}
              activeCount={filterChips.length}
              onClearAll={clearAll}
            />
          )}
          {isMobile ? (
            <CasePhoneList
              rows={phoneRows}
              loading={loading}
              empty={emptyNode}
              more={phoneMore}
              onMore={() => setPhoneLimit((n) => n + PHONE_PAGE)}
              onOpen={(c) => openInCaseManager(c.case_id, c.case_number || c.case_id)}
            />
          ) : (
            <DataTable<Case>
              ariaLabel="Cases"
              surface="panel"
              columns={columns}
              columnState={effectiveColumnState}
              rows={pageRows}
              getRowId={(c) => c.case_id}
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
              empty={emptyNode}
            />
          )}
        </Panel>
      )}

      {/* Bulk action bar */}
      <BulkActionBar
        count={selectedCases.length}
        busy={bulkBusy}
        onAcknowledge={() => void runBulk({ action: 'acknowledge' }, 'are being acknowledged')}
        onClose={() => {
          captureBulkOpener();
          setBulkTerminal('close');
        }}
        onResolve={() => {
          captureBulkOpener();
          setBulkTerminal('resolve');
        }}
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
        unavailableReason={
          demoActive ? 'Bulk changes are off in Demo Mode. Open a case to change it.' : null
        }
      />

      <CaseManagerHandoff target={handoffTarget} />

      {/* One-click row-close confirmation. Close is a REVERSIBLE lifecycle move, so this is
          a plain (non-destructive) confirm; it still posts through the analyst `close`
          action (server-side decide(), #3). The dialog reads the case's runbook progress
          and offers the open-steps reason (Round 14, D34). */}
      <BulkCloseDialog
        action={closeTarget !== null ? 'close' : null}
        count={1}
        caseIds={closeTargetIds}
        verdict={closeTarget?.verdict ?? null}
        currentDisposition={closeTarget?.disposition ?? null}
        onCancel={() => setCloseTarget(null)}
        onSubmit={(input) => {
          void confirmClose(input);
        }}
        returnFocusTo={closeOpenerRef}
      />

      {/* Bulk Close / Resolve: the disposition is required on every terminal path, and the
          one shared open-steps reason (when some selected cases have required runbook
          steps open) rides on the job. */}
      <BulkCloseDialog
        action={bulkTerminal}
        count={selectedCases.length}
        caseIds={bulkTerminalIds}
        busy={bulkBusy}
        returnFocusTo={bulkTerminalOpenerRef}
        onCancel={() => setBulkTerminal(null)}
        onSubmit={(input) => {
          setBulkTerminal(null);
          const { action, ...rest } = input;
          void runBulk(
            {
              action,
              ...rest,
              ...(action === 'close' && !rest.resolution ? { resolution: 'Bulk-closed by analyst' } : {}),
              ...(action === 'resolve' && !rest.reason ? { reason: 'Bulk-resolved by analyst' } : {}),
            },
            action === 'close' ? 'are being closed' : 'are being resolved',
          );
        }}
      />

      {/* Bulk reinvestigate confirmation: spends LLM tokens per case (#6) and can change
          verdict and status, so gate it like the single-case Reinvestigate popover's cost
          warning (CaseDetail.tsx) rather than firing on one click. Not destructive, so
          overlay and Escape dismiss stay on. */}
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

/* ---------------------------------------------------------- phone list ---- */

/** How many more cases the phone list shows per "Show more". */
const PHONE_PAGE = 50;

/**
 * The Cases list below 768px: Case Manager's list rows (number, severity and age; the
 * title; the status and the owner), each one 44px or taller and one button that opens
 * the case. Every value is plain text (#9).
 */
function CasePhoneList({
  rows,
  loading,
  empty,
  more,
  onMore,
  onOpen,
}: {
  rows: Case[];
  loading: boolean;
  empty: React.ReactNode;
  more: number;
  onMore: () => void;
  onOpen: (c: Case) => void;
}) {
  if (rows.length === 0) {
    return loading ? (
      <LoadingBar size="sm" label="Loading cases" className="mx-4 mb-4" />
    ) : (
      <div className="px-4 pb-4">{empty}</div>
    );
  }
  return (
    <div data-testid="cases-phone-list">
      <ul className="divide-y divide-border/70 border-t border-border/70" aria-label="Cases">
        {rows.map((c) => {
          const band = caseSeverityBand(c);
          const owner = (c.assignee || '').trim();
          return (
            <li key={c.case_id}>
              <button
                type="button"
                onClick={() => onOpen(c)}
                className="flex min-h-11 w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-xs font-medium text-primary">{c.case_number || c.case_id}</span>
                  <SeverityBadge severity={band} className="px-1.5 text-2xs" />
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                    {humanizeAge(c.updated_at || c.created_at)}
                  </span>
                </span>
                <span className="truncate text-sm font-medium text-foreground">{c.title || c.case_id}</span>
                <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <StatusBadge
                    status={c.status}
                    className={cn(
                      'px-1.5 text-2xs',
                      (c.status || '').toLowerCase() === 'investigating' && 'border-info/30 bg-info/10 text-info-text',
                    )}
                  />
                  <span className="truncate">{owner || 'Unassigned'}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 ? (
        <div className="border-t border-border/70 px-4 py-3">
          <Button variant="outline" size="sm" className="w-full" onClick={onMore}>
            Show more ({more.toLocaleString()} left)
          </Button>
        </div>
      ) : null}
    </div>
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
  /** Why bulk changes cannot run right now (Demo Mode); disables the actions, keeps Clear. */
  unavailableReason?: string | null;
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
  unavailableReason = null,
}) => {
  const locked = busy || Boolean(unavailableReason);
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [assignee, setAssignee] = React.useState('');
  const [tagOpen, setTagOpen] = React.useState(false);
  const [tag, setTag] = React.useState('');
  const tagError = caseTagError(tag);

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
        {unavailableReason ? (
          <span role="note" data-testid="cases-bulk-demo-note" className="text-xs text-muted-foreground">
            {unavailableReason}
          </span>
        ) : null}

        {/* cases:write tier — primary CTA of the bar: the single most common bulk
            action, so it gets the filled/primary treatment (matches the "N selected"
            badge) instead of `secondary`, whose fill token is identical to `muted`
            (theme.css `--secondary` === `--muted` === `--surface-sunken`, all
            `--slate-3`) and read as a disabled/washed-out control next to the bordered
            `outline` buttons beside it. */}
        <Button size="sm" variant="default" onClick={onAcknowledge} disabled={locked}>
          <Check className="mr-1.5 size-4" aria-hidden />
          Acknowledge
        </Button>

        {/* Assign owner — a pure owner set (cases:assign), NOT an escalation. To move
            status use "Set status → Escalated" below. */}
        <Popover open={assignOpen} onOpenChange={setAssignOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" disabled={locked}>
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
            <Button size="sm" variant="outline" disabled={locked}>
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
                aria-invalid={tagError ? true : undefined}
                aria-describedby={tagError ? 'bulk-tag-error' : undefined}
              />
              {/* Refused as it is typed, never cut to fit. */}
              {tagError ? (
                <p id="bulk-tag-error" role="alert" className="text-xs font-medium text-critical-text">
                  {tagError}
                </p>
              ) : null}
              <Button
                size="sm"
                className="w-full"
                disabled={!tag.trim() || Boolean(tagError) || busy}
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
        <Select value="" onValueChange={(v) => v && onSetStatus(v)} disabled={locked}>
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
        <Select value="" onValueChange={(v) => v && onSetDisposition(v)} disabled={locked}>
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
        <Button size="sm" variant="outline" onClick={onReinvestigate} disabled={locked}>
          {busy ? (
            <LoaderCircle className="mr-1.5 size-4 motion-safe:animate-spin" aria-hidden />
          ) : (
            <Zap className="mr-1.5 size-4" aria-hidden />
          )}
          Reinvestigate
        </Button>

        {/* Close / resolve — cases:close. Hidden unless granted (RBAC-mirrored). */}
        <Can resource="cases" action="close">
          <Button size="sm" variant="outline" onClick={() => onResolve('')} disabled={locked}>
            <Check className="mr-1.5 size-4" aria-hidden />
            Resolve
          </Button>
          <Button size="sm" variant="destructive" onClick={onClose} disabled={locked}>
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
