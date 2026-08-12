/**
 * Audit log viewer (Round-2 W7c) — a read-only window onto the append-only audit
 * (#2). Reads GET /api/audit (filterable, bounded, NEWEST first) and renders the
 * records in a dense table with a filter bar (actor / action / surface / case id /
 * search) and a deep-link to the related case.
 *
 * The whole page is gated by the `audit:view` grant (admin / auditor / soc_manager
 * by default) via <ProtectedRoute>; the rail item is likewise RBAC-hidden. There is
 * NO write/update/delete affordance here — the audit index is immutable (#2).
 *
 * SECURITY (#9): every audit field is system/operator/LOG-derived and is rendered
 * as PLAIN text. `result_summary`, `query_text`, `prompt_excerpt` and
 * `tool_output_summary` can carry fenced UNTRUSTED log excerpts, so they render via
 * <InlineCode>/<CodeBlock> only — never as markup.
 */
import * as React from 'react';
import {
  ScrollText,
  Search,
  X,
  ArrowUpRight,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { AuditRecord, AuditQuery } from '@/lib/types';
import { humanizeAge, humanizeToken, formatTimestamp, DASH } from '@/lib/format';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Badge } from '@/ui/badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';

import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { InlineCode } from '@/soc/components/CodeBlock';
import { ProtectedRoute } from '@/soc/components/Can';
import type { Navigate } from '@/soc/router';
import { useRoute } from '@/soc/router';

const LIST_LIMIT = 200;

/** Sentinel for "any" in the single-select filters (Radix Select forbids ""). */
const ANY = '__any__';

type TimeRange = 'all' | '24h' | '7d' | '30d';

const TIME_RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
};

/** The one-line, UNTRUSTED-safe summary for a row (whatever the backend recorded). */
function rowSummary(r: AuditRecord): string {
  return (
    (r.result_summary || r.tool_output_summary || r.query_text || r.prompt_excerpt || '') ?? ''
  );
}

/**
 * The known audit `action_type` vocabulary (mirror of backend `ActionType`). The
 * Action facet is populated from THIS stable set (unioned with whatever appears in
 * the loaded window) rather than only the server-filtered results, so every action
 * stays selectable and switching filters is a single hop — a rare/older action, or
 * the currently-selected one, is never dropped from the dropdown.
 */
const KNOWN_ACTIONS: readonly string[] = [
  'prompt', 'es_query', 'tool_call', 'verdict', 'decision', 'error', 'poll', 'scan',
  'feedback', 'collab', 'status', 'context', 'proposal', 'automation', 'notification',
  'user_mgmt', 'auth', 'access_denied', 'thread_post', 'reaction', 'task_update',
  'inapp_notify', 'tuning', 'reset',
];

/** Debounce a rapidly-changing value (free-text filters) before it drives a fetch. */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export interface AuditProps {
  onNavigate?: Navigate;
}

function AuditViewer({ onNavigate }: AuditProps) {
  const route = useRoute();
  const navigate = onNavigate ?? route.navigate;

  const [records, setRecords] = React.useState<AuditRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  // Server-side filters (re-fetch) vs client-side search (over the loaded window).
  const [actor, setActor] = React.useState('');
  const [action, setAction] = React.useState(ANY);
  const [surface, setSurface] = React.useState(ANY);
  const [caseId, setCaseId] = React.useState('');
  const [timeRange, setTimeRange] = React.useState<TimeRange>('all');
  const [search, setSearch] = React.useState('');

  // Debounce the free-text filters so typing does not fire a GET /api/audit per
  // keystroke; the Select filters (action/surface/time) stay immediate.
  const actorQuery = useDebouncedValue(actor, 300);
  const caseIdQuery = useDebouncedValue(caseId, 300);
  // Monotonic request id — apply a response only if it is still the latest, so an
  // out-of-order (broader) response cannot clobber a newer (narrower) one.
  const seqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const now = Date.now();
      const params: AuditQuery = { limit: LIST_LIMIT };
      if (actorQuery.trim()) params.actor = actorQuery.trim();
      if (action !== ANY) params.action = action;
      if (surface !== ANY) params.surface = surface;
      if (caseIdQuery.trim()) params.case_id = caseIdQuery.trim();
      if (timeRange !== 'all') {
        params.from = new Date(now - TIME_RANGE_MS[timeRange]).toISOString();
      }
      const res = await api.audit.list(params);
      if (seq !== seqRef.current) return; // superseded by a newer request
      setRecords(res.records ?? []);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [actorQuery, action, surface, caseIdQuery, timeRange]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // A drill-through (e.g. "view case audit") can seed a case-id filter.
  const routeCaseId = route.opts?.caseId;
  React.useEffect(() => {
    if (routeCaseId) setCaseId(routeCaseId);
  }, [routeCaseId]);

  // Surface facets ACCUMULATE across loads (grow-only) so selecting a surface — which
  // narrows the server result to just that surface — never collapses the dropdown to
  // a single option or hides the control while its filter is still active.
  const [seenSurfaces, setSeenSurfaces] = React.useState<Set<string>>(() => new Set());
  React.useEffect(() => {
    setSeenSurfaces((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const r of records) {
        if (r.surface) {
          const s = String(r.surface);
          if (!next.has(s)) {
            next.add(s);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [records]);
  const surfaces = React.useMemo(
    () => Array.from(seenSurfaces).sort((a, b) => a.localeCompare(b)),
    [seenSurfaces],
  );

  // Action facets come from the STABLE known vocabulary (unioned with any observed),
  // so every action stays selectable regardless of the current server filter.
  const actions = React.useMemo(() => {
    const s = new Set<string>(KNOWN_ACTIONS);
    for (const r of records) if (r.action_type) s.add(String(r.action_type));
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [records]);

  // Client-side search narrows the loaded window across actor/summary/case/etc.
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return records;
    return records.filter((r) => {
      const hay = [
        r.actor,
        r.action_type,
        r.surface,
        r.case_id,
        r.app_version,
        r.build_sha,
        r.model,
        r.tool_name,
        rowSummary(r),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [records, search]);

  const clearAll = React.useCallback(() => {
    setActor('');
    setAction(ANY);
    setSurface(ANY);
    setCaseId('');
    setTimeRange('all');
    setSearch('');
  }, []);

  const anyActive =
    !!actor.trim() ||
    action !== ANY ||
    surface !== ANY ||
    !!caseId.trim() ||
    timeRange !== 'all' ||
    !!search.trim();

  const columns: DataTableColumn<AuditRecord>[] = [
    {
      id: 'ts',
      header: 'Time',
      width: '9rem',
      cell: (r) => (
        <span
          className="whitespace-nowrap text-sm text-muted-foreground"
          title={formatTimestamp(r.ts)}
        >
          {humanizeAge(r.ts)}
        </span>
      ),
    },
    {
      id: 'action',
      header: 'Action',
      width: '9rem',
      cell: (r) =>
        r.action_type ? (
          <Badge variant="outline" className="font-normal">
            {humanizeToken(String(r.action_type))}
          </Badge>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        ),
    },
    {
      id: 'actor',
      header: 'Actor',
      width: '10rem',
      cell: (r) =>
        r.actor ? (
          <span className="text-sm text-foreground">{String(r.actor)}</span>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        ),
    },
    {
      id: 'surface',
      header: 'Surface',
      width: '8rem',
      cell: (r) =>
        r.surface ? (
          <span className="text-sm text-muted-foreground">
            {humanizeToken(String(r.surface))}
          </span>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        ),
    },
    {
      id: 'build',
      header: 'Build',
      width: '11rem',
      cell: (r) => {
        const version = typeof r.app_version === 'string' ? r.app_version.trim() : '';
        const sha = typeof r.build_sha === 'string' ? r.build_sha.trim() : '';
        if (!version && !sha) {
          return <span className="text-muted-foreground">Unavailable</span>;
        }
        const label = `${version ? `v${version}` : 'version unavailable'} · ${
          sha ? (sha === 'unknown' ? 'SHA unknown' : sha.slice(0, 10)) : 'SHA unavailable'
        }`;
        return (
          <InlineCode title={`${version || 'unavailable'} · ${sha || 'unavailable'}`}>
            {label}
          </InlineCode>
        );
      },
    },
    {
      id: 'case',
      header: 'Case',
      width: '9rem',
      cell: (r) =>
        r.case_id ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigate('cases', { caseId: String(r.case_id) });
            }}
            className="inline-flex items-center gap-1 rounded-sm font-mono text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="max-w-[7rem] truncate">{String(r.case_id)}</span>
            <ArrowUpRight className="size-3 shrink-0" aria-hidden />
          </button>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        ),
    },
    {
      id: 'summary',
      header: 'Detail',
      cell: (r) => {
        const s = rowSummary(r);
        return s ? (
          <InlineCode className="block max-w-[34rem] truncate">{s}</InlineCode>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Platform"
        title="Audit log"
        description="Read-only, append-only record of every agent and analyst action."
        icon={ScrollText}
        actions={
          <RefreshButton onClick={() => void load()} refreshing={loading} />
        }
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-y border-border/70 bg-surface/40 p-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search actor, detail, case, tool, build…"
            aria-label="Search audit records"
            className="pl-9"
          />
        </div>

        <Input
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="Actor"
          aria-label="Filter by actor"
          className="w-[10rem]"
        />

        <Select value={action} onValueChange={setAction}>
          <SelectTrigger className="w-[11rem]" aria-label="Filter by action">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All actions</SelectItem>
            {actions.map((a) => (
              <SelectItem key={a} value={a}>
                {humanizeToken(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {surfaces.length > 0 || surface !== ANY ? (
          <Select value={surface} onValueChange={setSurface}>
            <SelectTrigger className="w-[10rem]" aria-label="Filter by surface">
              <SelectValue placeholder="Surface" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All surfaces</SelectItem>
              {surfaces.map((s) => (
                <SelectItem key={s} value={s}>
                  {humanizeToken(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <Input
          value={caseId}
          onChange={(e) => setCaseId(e.target.value)}
          placeholder="Case ID"
          aria-label="Filter by case id"
          className="w-[11rem] font-mono text-xs"
        />

        <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
          <SelectTrigger className="w-[9.5rem]" aria-label="Filter by time">
            <SelectValue placeholder="Any time" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any time</SelectItem>
            <SelectItem value="24h">Last 24 hours</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
          </SelectContent>
        </Select>

        <Button variant="ghost" size="sm" onClick={clearAll} disabled={!anyActive}>
          <X className="mr-1.5 size-4" aria-hidden />
          Clear
        </Button>

        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
          Showing <strong className="text-foreground">{filtered.length}</strong> of{' '}
          {records.length}
        </span>
      </div>

      {error ? (
        <LoadError
          error={error}
          title="Could not load the audit log"
          fallback="An unexpected error occurred."
          onRetry={() => void load()}
        />
      ) : null}

      <DataTable<AuditRecord>
        ariaLabel="Audit log"
        columns={columns}
        rows={filtered}
        getRowId={(r, i) => `${r.ts ?? ''}-${r.action_type ?? ''}-${r.case_id ?? ''}-${i}`}
        loading={loading}
        loadingRows={10}
        density="compact"
        empty={
          <EmptyState
            compact
            icon={ScrollText}
            title={anyActive ? 'No records match your filters' : 'No audit records'}
            description={
              anyActive
                ? 'No audit records match the current filters. Clear or widen them to see more.'
                : 'Agent and analyst actions will appear here as they happen.'
            }
            action={
              anyActive ? (
                <Button variant="outline" size="sm" onClick={clearAll}>
                  <X className="mr-1.5 size-4" aria-hidden />
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        }
      />
    </div>
  );
}

/** Page-level guard: only `audit:view` principals can see the audit log. */
export default function Audit({ onNavigate }: AuditProps) {
  return (
    <ProtectedRoute resource="audit" action="view">
      <PageContainer variant="wide">
        <AuditViewer onNavigate={onNavigate} />
      </PageContainer>
    </ProtectedRoute>
  );
}
