/**
 * Log Sources — the QRadar-style "Log Source Management" surface.
 *
 * The systems the agent reads security events from, presented as a dense, sortable
 * DataTable (was a vertical card stack): a toolbar (faceted filter + search + a live
 * "Log Sources (N)" count + a prominent "+ New Log Source" + a Manage-Columns gear),
 * bulk-select with an Enable / Disable / Remove strip, and per-row Status dot, Last
 * Event, an inline Enabled toggle, and a kebab actions menu (Browse logs · Make
 * primary · Edit · Remove). Status + Last Event are honestly derived from the
 * read-only GET /api/sources/health signal (durable poll cursor for PULL sources,
 * live-tail buffer depth for PUSH receivers).
 *
 * Add/Edit open the manifest-driven <SourceEditor> in a Dialog (the same form the
 * wizard uses); Browse opens the <SourceLogsSheet>.
 *
 * Security: connector/source text is operator- or backend-provided and rendered as
 * plain text; secrets are NEVER shown (only `N secret(s)` counts, #10). Log values in
 * the Logs sheet are UNTRUSTED and fenced there. All manage affordances (New / Edit /
 * Remove / the Enabled toggle / Make primary / bulk) are RBAC-gated (`sources:manage`).
 */
import * as React from 'react';
import {
  Database,
  Plus,
  Pencil,
  Trash2,
  Star,
  Telescope,
  Plug,
  Link2,
  Search,
  X,
  Filter,
  MoreHorizontal,
  KeyRound,
  Check,
  Activity,
  ShieldCheck,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';
import type { Navigate } from '@/soc/router';
import { api } from '@/lib/api';
import type {
  ConnectorManifest,
  SourceCoverage,
  SourceHealthRow,
  SourceInstance,
} from '@/lib/types';
import { humanizeToken, humanizeAge, formatTimestamp, fmtNumber, DASH } from '@/lib/format';
import { cn } from '@/lib/cn';
import { toast } from 'sonner';

import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { FilterBar } from '@/soc/components/FilterBar';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SourceEditor } from '@/soc/components/SourceEditor';
import { SourceLogsSheet } from '@/soc/components/SourceLogsSheet';
import { categoryMeta } from '@/soc/components/ConnectorPicker';
import { Can, useCan } from '@/soc/components/Can';
import { HelpTip } from '@/soc/components/HelpTip';
import { IconButton } from '@/soc/components/IconButton';
import {
  DataTable,
  type DataTableColumn,
  type SortState,
  type ColumnState,
} from '@/soc/components/DataTable';
import { ColumnsMenu, type ColumnMenuItem } from '@/soc/components/ColumnsMenu';
import { usePrefs } from '@/soc/prefs';
import { useDemo } from '@/soc/demo';

import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Input } from '@/ui/input';
import { Switch } from '@/ui/switch';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/ui/dropdown-menu';
import { Popover, PopoverTrigger, PopoverContent } from '@/ui/popover';

/* --------------------------------------------------------------- helpers --- */

/** Stable id for the Log Sources table's per-user column state (Wave 7). */
const SOURCES_TABLE_ID = 'sources';

/**
 * Columns hidden by DEFAULT (only until the user customizes this table). The dense
 * default opens on Name · Type · Status · Enabled · Last Event · Protocol · ⋯; the
 * secondary QRadar-fidelity columns (ID, Groups, Creation Date, and the loose
 * Coalescing / Store Payload / Internal booleans) live behind the Manage-Columns gear.
 */
const SOURCES_DEFAULT_HIDDEN = [
  'id',
  'groups',
  'created_at',
  'coalescing',
  'store_payload',
  'internal',
] as const;

/** Sentinel "any" value for the single-value facets. */
const ANY = '__any__';
const DEMO_MANAGED_REASON = 'Managed by Demo Mode';

type SourceSortId = 'name' | 'type' | 'status' | 'last_event' | 'protocol' | 'created_at';

interface SourceFilters {
  search: string;
  enabled: 'any' | 'enabled' | 'disabled';
  kind: 'any' | 'push' | 'pull';
  type: string; // ANY | a source_type
}

const EMPTY_FILTERS: SourceFilters = {
  search: '',
  enabled: 'any',
  kind: 'any',
  type: ANY,
};

/** The display label for a source (never a secret). */
function sourceLabel(s: SourceInstance, meta?: ConnectorManifest): string {
  return s.display_name || meta?.display_name || s.source_type;
}

/** A loose-config string value (Groups etc.), or '' when absent/non-string. */
function looseString(cfg: SourceInstance['config'], key: string): string {
  const v = cfg?.[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** Source-native wire format when declared; otherwise the generic ingest direction. */
function sourceProtocol(s: SourceInstance): string {
  return looseString(s.config, 'protocol') || humanizeToken(s.ingest_mode);
}

/** A loose-config boolean (Coalescing / Internal), or undefined when absent. */
function looseBool(cfg: SourceInstance['config'], key: string): boolean | undefined {
  const v = cfg?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

type StatusKind = 'disabled' | 'ok' | 'idle' | 'silent' | 'error';

/**
 * HONEST status derivation, now anchored on the SERVER truth (coverage-observability
 * A5.2) instead of the old pure-client 24h staleness guess:
 *  - disabled → the source is turned off;
 *  - Error    → the connector's LAST POLL FAILED (`last_poll_ok === false`) — broken,
 *               not merely idle (the exact "silent vs broken" conflation the server fixes);
 *  - Silent   → the backend flagged it SILENT (`silent === true`): enabled but no recent
 *               events past the flat silence threshold (the source may have stopped reporting);
 *  - Active   → a poll succeeded recently, events are flowing, or a PUSH receiver holds buffer;
 *  - Idle     → enabled but nothing observed yet (never polled / no events).
 *
 * The legacy 24h cursor-age heuristic is kept ONLY as the fallback when the server gave no
 * verdict (an older backend without the coverage fields), so behaviour degrades gracefully.
 */
const STATUS_STALE_MS = 24 * 3600 * 1000;
function sourceStatus(s: SourceInstance, h?: SourceHealthRow): { kind: StatusKind; label: string } {
  if (s.enabled === false) return { kind: 'disabled', label: 'Disabled' };
  if (h) {
    // Server truth first — a failed poll is a BROKEN connector, and `silent` is the
    // backend's own flat silence flag. Both beat any cursor-age guess.
    if (h.last_poll_ok === false) return { kind: 'error', label: 'Error' };
    if (h.healthy === false) return { kind: 'error', label: 'Error' };
    if (h.silent === true) return { kind: 'silent', label: 'Silent' };
    if (h.state === 'static') return { kind: 'idle', label: 'Ready' };
    if (h.last_poll_ok === true) return { kind: 'ok', label: 'Active' };
    if ((h.events_per_min ?? 0) > 0) return { kind: 'ok', label: 'Active' };
    if (h.buffer_depth > 0) return { kind: 'ok', label: 'Active' };
    // Legacy fallback (no server verdict): the last-poll cursor age.
    if (h.last_poll_millis > 0) {
      return Date.now() - h.last_poll_millis < STATUS_STALE_MS
        ? { kind: 'ok', label: 'Active' }
        : { kind: 'idle', label: 'Idle' };
    }
  }
  return { kind: 'idle', label: 'Idle' };
}

/** Millis-since-epoch of a source's last observed activity (0 when none). */
function lastEventMillis(h?: SourceHealthRow): number {
  if (!h) return 0;
  // Prefer the server's wall-clock event watermark (A5.2) — it's the honest "last event
  // arrived" for BOTH pull + push, independent of the poll cursor. Fall back to the
  // legacy cursor, then to any live buffer depth.
  if ((h.last_event_millis ?? 0) > 0) return h.last_event_millis as number;
  if (h.last_poll_millis > 0) return h.last_poll_millis;
  // A PUSH receiver has no poll cursor; treat any buffered depth as "recent" so it
  // sorts above never-active sources without inventing a timestamp.
  return h.buffer_depth > 0 ? Date.now() : 0;
}

type EditorState = { mode: 'add' } | { mode: 'edit'; source: SourceInstance } | null;

export interface SourcesProps {
  onNavigate?: Navigate;
}

export default function Sources(_props: SourcesProps) {
  const canManage = useCan('sources', 'manage');
  const { tableColumns, updateTableColumns } = usePrefs();
  const { active: demoActive } = useDemo();

  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [connectors, setConnectors] = React.useState<ConnectorManifest[]>([]);
  const [sources, setSources] = React.useState<SourceInstance[]>([]);
  const [health, setHealth] = React.useState<Record<string, SourceHealthRow>>({});
  const [coverage, setCoverage] = React.useState<SourceCoverage | null>(null);

  const [editor, setEditor] = React.useState<EditorState>(null);
  const [logsSource, setLogsSource] = React.useState<SourceInstance | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<SourceInstance | null>(null);
  const [pendingPrimary, setPendingPrimary] = React.useState<SourceInstance | null>(null);
  const [pendingBulkRemove, setPendingBulkRemove] = React.useState(false);

  const [filters, setFilters] = React.useState<SourceFilters>(EMPTY_FILTERS);
  const [sort, setSort] = React.useState<SortState>({ id: 'last_event', dir: 'desc' });
  const [selected, setSelected] = React.useState<string[]>([]);
  const [pageSize, setPageSize] = React.useState(25);
  const [page, setPage] = React.useState(1);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  // The source overlay is authoritative too: it can resolve one request before the
  // independently-polled DemoContext. Treat either signal as managed-demo state so a
  // real source editor is never briefly writable during hydration.
  const demoManaged = demoActive || sources.some((source) => source.demo === true);

  React.useEffect(() => {
    if (demoManaged) setEditor(null);
  }, [demoManaged]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [conns, src, healthRes, coverageRes] = await Promise.all([
        api.listConnectors(),
        api.listSources(),
        // Best-effort: a health failure (or an older/mocked client) must NEVER fail
        // the page — the list still renders, just without Status/Last-Event detail.
        typeof api.sourcesHealth === 'function'
          ? api.sourcesHealth().catch(() => ({ sources: [] as SourceHealthRow[] }))
          : Promise.resolve({ sources: [] as SourceHealthRow[] }),
        // The aggregate coverage rollup (A5.5). Also best-effort + typeof-guarded so a
        // minimal/older client simply falls back to the client-derived banner numbers.
        typeof api.sourcesCoverage === 'function'
          ? api.sourcesCoverage().catch(() => null)
          : Promise.resolve(null),
      ]);
      setConnectors(conns.connectors);
      setSources(src.sources);
      const map: Record<string, SourceHealthRow> = {};
      for (const row of healthRes.sources) map[row.source_id] = row;
      setHealth(map);
      setCoverage(coverageRes);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const onSaved = async () => {
    setEditor(null);
    toast.success('Source saved');
    await load();
  };

  const setPrimary = async (s: SourceInstance) => {
    if (s.demo) {
      toast.warning(DEMO_MANAGED_REASON);
      setPendingPrimary(null);
      return;
    }
    setBusyId(s.id);
    try {
      await api.upsertSource({
        id: s.id,
        source_type: s.source_type,
        display_name: s.display_name,
        enabled: s.enabled,
        is_primary: true,
        ingest_mode: s.ingest_mode ?? null,
        config: (s.config as Record<string, unknown>) || {},
      });
      toast.success(`${sourceLabel(s)} is now the primary source`);
      await load();
    } catch {
      // Toast-only for action failures — never raise the page-level LoadError banner
      // (which is reserved for the initial list load; its Retry re-fetches the list).
      toast.error('Could not change the primary source');
    } finally {
      setBusyId(null);
      setPendingPrimary(null);
    }
  };

  const remove = async (s: SourceInstance) => {
    if (s.demo) {
      toast.warning(DEMO_MANAGED_REASON);
      setPendingDelete(null);
      return;
    }
    setBusyId(s.id);
    try {
      await api.deleteSource(s.id);
      toast.success('Source removed');
      await load();
    } catch {
      // Toast-only (see setPrimary): action failures never raise the page LoadError.
      toast.error('Could not remove the source');
    } finally {
      setBusyId(null);
      setPendingDelete(null);
    }
  };

  // Inline per-row Enabled toggle. Optimistic local flip, then round-trip the whole
  // source (mirrors the setPrimary upsert shape so no config is dropped). NO backend
  // change — this rides the existing POST /api/sources upsert.
  const toggleEnabled = async (s: SourceInstance, next: boolean) => {
    if (s.demo) {
      toast.warning(DEMO_MANAGED_REASON);
      return;
    }
    setBusyId(s.id);
    setSources((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: next } : x)));
    try {
      await api.upsertSource({
        id: s.id,
        source_type: s.source_type,
        display_name: s.display_name,
        enabled: next,
        is_primary: s.is_primary,
        ingest_mode: s.ingest_mode ?? null,
        config: (s.config as Record<string, unknown>) || {},
      });
      toast.success(`${sourceLabel(s)} ${next ? 'enabled' : 'disabled'}`);
      await load();
    } catch {
      // Revert the optimistic flip and surface a toast.
      setSources((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: s.enabled } : x)));
      toast.error('Could not update the source');
    } finally {
      setBusyId(null);
    }
  };

  /* ----------------------------------------------------------- filtering --- */

  const connectorFor = React.useCallback(
    (s: SourceInstance) => connectors.find((c) => c.source_type === s.source_type),
    [connectors],
  );

  const typeLabel = React.useCallback(
    (s: SourceInstance) => connectorFor(s)?.display_name || humanizeToken(s.source_type),
    [connectorFor],
  );

  // Browse capability is SERVER-AUTHORITATIVE: `GET /api/sources` returns `can_browse`
  // from the same `_source_can_browse` predicate the browse routes gate on (and the
  // Demo-Mode overlay carries it too). Deliberately NOT re-derived from the connector
  // manifest or the health poll — one definition only, so the menu affordance can never
  // disagree with what `GET /api/sources/{id}/logs` will actually do.
  const canBrowse = React.useCallback((s: SourceInstance) => !!s.can_browse, []);

  // Distinct source types present (for the Type facet).
  const typeOptions = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) map.set(s.source_type, typeLabel(s));
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sources, typeLabel]);

  const filtered = React.useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return sources.filter((s) => {
      if (filters.enabled === 'enabled' && s.enabled === false) return false;
      if (filters.enabled === 'disabled' && s.enabled !== false) return false;
      if (filters.type !== ANY && s.source_type !== filters.type) return false;
      if (filters.kind !== 'any') {
        // Runtime health is best-effort. Fall back to the saved ingest mode so a
        // transient/older health endpoint cannot make the Pull/Push facet falsely
        // return zero configured sources.
        const kind = health[s.id]?.kind ?? (s.ingest_mode === 'pull' ? 'pull' : 'push');
        if (kind !== filters.kind) return false;
      }
      if (q) {
        const hay = [s.display_name, s.source_type, s.id, typeLabel(s)]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [sources, filters, health, typeLabel]);

  const filteredSorted = React.useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const cmp = (a: SourceInstance, b: SourceInstance): number => {
      switch (sort.id as SourceSortId) {
        case 'name':
          return sourceLabel(a, connectorFor(a)).localeCompare(sourceLabel(b, connectorFor(b)));
        case 'type':
          return typeLabel(a).localeCompare(typeLabel(b));
        case 'status': {
          // Surface problem states first (error/silent) when sorting ascending.
          const ORDER: Record<StatusKind, number> = {
            error: 0,
            silent: 1,
            ok: 2,
            idle: 3,
            disabled: 4,
          };
          const rank = (s: SourceInstance) => ORDER[sourceStatus(s, health[s.id]).kind] ?? 2;
          return rank(a) - rank(b);
        }
        case 'protocol':
          return sourceProtocol(a).localeCompare(sourceProtocol(b));
        case 'created_at':
          return (a.created_at || '').localeCompare(b.created_at || '');
        case 'last_event':
        default:
          return lastEventMillis(health[a.id]) - lastEventMillis(health[b.id]);
      }
    };
    return [...filtered].sort((a, b) => cmp(a, b) * dir);
  }, [filtered, sort, connectorFor, typeLabel, health]);

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

  // Drop any selection no longer visible so the bulk strip can't act on hidden rows.
  React.useEffect(() => {
    setSelected((sel) => {
      if (!sel.length) return sel;
      const visible = new Set(
        filteredSorted.filter((s) => canManage && !s.demo).map((s) => s.id),
      );
      const next = sel.filter((id) => visible.has(id));
      return next.length === sel.length ? sel : next;
    });
  }, [canManage, filteredSorted]);

  const selectedSources = React.useMemo(() => {
    const set = new Set(selected);
    return filteredSorted.filter((s) => !s.demo && set.has(s.id));
  }, [selected, filteredSorted]);

  // ----- Coverage rollup (the "am I seeing everything?" banner) ------------ //
  // Prefer the server rollup (GET /api/sources/coverage); fall back to deriving the
  // counts client-side from the health rows + source list so the banner still renders
  // against an older/mocked client. `alertsTriaged` is server-only (a case-window count),
  // so it stays null in the fallback (rendered as an em-dash — never a fabricated number).
  const coverageStats = React.useMemo(() => {
    const enabledSources = sources.filter((s) => s.enabled !== false);
    const derivedEventsPerMin = enabledSources.reduce(
      (a, s) => a + (health[s.id]?.events_per_min ?? 0),
      0,
    );
    const derivedSilent = enabledSources.filter((s) => health[s.id]?.silent === true).length;
    return {
      total: coverage?.sources_total ?? sources.length,
      enabled: coverage?.sources_enabled ?? enabledSources.length,
      silent: coverage?.sources_silent ?? derivedSilent,
      eventsPerMin: coverage?.events_per_min ?? derivedEventsPerMin,
      alertsTriaged: coverage?.alerts_triaged_24h ?? null,
    };
  }, [coverage, sources, health]);

  const activeFilters =
    (filters.search.trim() ? 1 : 0) +
    (filters.enabled !== 'any' ? 1 : 0) +
    (filters.kind !== 'any' ? 1 : 0) +
    (filters.type !== ANY ? 1 : 0);

  const setFilter = <K extends keyof SourceFilters>(key: K, value: SourceFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const clearFilters = () => setFilters(EMPTY_FILTERS);

  /* ---------------------------------------------------- bulk operations --- */

  const bulkSetEnabled = React.useCallback(
    async (next: boolean) => {
      const targets = selectedSources;
      if (!targets.length || bulkBusy) return;
      setBulkBusy(true);
      let ok = 0;
      let failed = 0;
      for (const s of targets) {
        try {
          await api.upsertSource({
            id: s.id,
            source_type: s.source_type,
            display_name: s.display_name,
            enabled: next,
            is_primary: s.is_primary,
            ingest_mode: s.ingest_mode ?? null,
            config: (s.config as Record<string, unknown>) || {},
          });
          ok += 1;
        } catch {
          failed += 1;
        }
      }
      if (failed) toast.warning(`${ok} updated, ${failed} failed`);
      else toast.success(`${ok} source${ok === 1 ? '' : 's'} ${next ? 'enabled' : 'disabled'}`);
      setSelected([]);
      await load();
      setBulkBusy(false);
    },
    [selectedSources, bulkBusy, load],
  );

  const bulkRemove = React.useCallback(async () => {
    const targets = selectedSources;
    if (!targets.length) return;
    setBulkBusy(true);
    let ok = 0;
    let failed = 0;
    for (const s of targets) {
      try {
        await api.deleteSource(s.id);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    if (failed) toast.warning(`${ok} removed, ${failed} failed`);
    else toast.success(`${ok} source${ok === 1 ? '' : 's'} removed`);
    setSelected([]);
    setPendingBulkRemove(false);
    await load();
    setBulkBusy(false);
  }, [selectedSources, load]);

  /* ------------------------------------------------------ column state ---- */

  const storedColumnState = tableColumns(SOURCES_TABLE_ID);
  const effectiveColumnState: ColumnState =
    storedColumnState ?? { hidden: [...SOURCES_DEFAULT_HIDDEN] };
  const handleColumnState = React.useCallback(
    (next: ColumnState) => {
      void updateTableColumns(SOURCES_TABLE_ID, next);
    },
    [updateTableColumns],
  );

  /* ------------------------------------------------------------ columns --- */

  const columns: DataTableColumn<SourceInstance>[] = [
    {
      id: 'id',
      header: 'ID',
      menuLabel: 'ID',
      width: '9rem',
      cell: (s) => (
        <span className="block max-w-[9rem] truncate font-mono text-xs text-muted-foreground" title={s.id}>
          {s.id}
        </span>
      ),
    },
    {
      id: 'name',
      header: 'Name',
      sortable: true,
      lockVisible: true,
      cell: (s) => {
        const meta = connectorFor(s);
        const name = sourceLabel(s, meta);
        const secretCount = s.configured_secrets?.length || 0;
        const subline = [humanizeToken(s.source_type), humanizeToken(s.ingest_mode)]
          .filter((v) => v && v !== DASH)
          .join(' · ');
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {canManage && !s.demo ? (
                <button
                  type="button"
                  onClick={() => setEditor({ mode: 'edit', source: s })}
                  className="max-w-[16rem] truncate rounded-sm text-sm font-semibold text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title={name}
                >
                  {name}
                </button>
              ) : (
                <span className="max-w-[16rem] truncate text-sm font-semibold text-foreground" title={name}>
                  {name}
                </span>
              )}
              {s.is_primary ? <Badge variant="default">Primary</Badge> : null}
              {s.demo ? (
                <Badge variant="warning" title={DEMO_MANAGED_REASON}>
                  Demo
                </Badge>
              ) : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {subline}
              {secretCount ? ` · ${secretCount} secret${secretCount === 1 ? '' : 's'}` : ''}
            </p>
          </div>
        );
      },
    },
    {
      id: 'type',
      header: 'Type',
      sortable: true,
      width: '13rem',
      cell: (s) => {
        const meta = connectorFor(s);
        const cat = categoryMeta(meta?.category || s.category);
        const CatIcon = cat.icon;
        return (
          <span className="inline-flex items-center gap-2">
            <span
              className={cn(
                'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-surface',
                cat.tone,
              )}
            >
              <CatIcon className="h-3.5 w-3.5" aria-hidden />
            </span>
            <span className="truncate text-sm text-foreground">{typeLabel(s)}</span>
          </span>
        );
      },
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      width: '8rem',
      cell: (s) => {
        const h = health[s.id];
        const st = sourceStatus(s, h);
        const dotCls =
          st.kind === 'ok'
            ? 'bg-success'
            : st.kind === 'error'
              ? 'bg-critical'
              : st.kind === 'silent'
                ? 'bg-warning'
                : st.kind === 'idle'
                  ? 'bg-muted-foreground/60'
                  : 'bg-muted-foreground/40';
        const textCls =
          st.kind === 'ok'
            ? 'text-success-text'
            : st.kind === 'error'
              ? 'text-critical-text'
              : st.kind === 'silent'
                ? 'text-warning-text'
                : 'text-muted-foreground';
        // A connector error string is source-controlled data → plain text only (#9).
        const title =
          st.kind === 'disabled'
            ? 'Source is disabled'
            : st.kind === 'error'
              ? h?.last_poll_error
                ? `Last poll failed: ${h.last_poll_error}`
                : 'The last poll attempt failed'
              : st.kind === 'silent'
                ? 'Enabled but no recent events — the source may have stopped reporting'
                : st.kind === 'ok'
                  ? `Active${h?.kind ? ` · ${humanizeToken(h.kind)} source` : ''}`
                  : 'Enabled, no events observed yet';
        return (
          <span
            className="inline-flex items-center gap-1.5"
            title={title}
            data-testid={`source-status-${s.id}`}
          >
            <span className={cn('h-2 w-2 shrink-0 rounded-full', dotCls)} aria-hidden />
            <span className={cn('text-sm font-medium', textCls)}>{st.label}</span>
          </span>
        );
      },
    },
    {
      id: 'enabled',
      header: 'Enabled',
      width: '6.5rem',
      cell: (s) => (
        <span className="inline-flex" title={s.demo ? DEMO_MANAGED_REASON : undefined}>
          <Switch
            checked={s.enabled !== false}
            disabled={!canManage || busyId === s.id || s.demo}
            onCheckedChange={(next) => void toggleEnabled(s, next)}
            aria-label={
              s.demo
                ? `${DEMO_MANAGED_REASON}: ${sourceLabel(s, connectorFor(s))}`
                : `Enable ${sourceLabel(s, connectorFor(s))}`
            }
          />
        </span>
      ),
    },
    {
      id: 'last_event',
      header: 'Last Event',
      sortable: true,
      width: '9rem',
      cell: (s) => {
        const h = health[s.id];
        // Prefer the server's wall-clock event watermark (A5.2), then the legacy poll cursor.
        const evMs =
          (h?.last_event_millis ?? 0) > 0
            ? (h!.last_event_millis as number)
            : h && h.last_poll_millis > 0
              ? h.last_poll_millis
              : 0;
        if (evMs > 0) {
          const iso = new Date(evMs).toISOString();
          const ageMs = Date.now() - evMs;
          const staleCls =
            ageMs > 24 * 3600 * 1000
              ? 'text-critical-text'
              : ageMs > 3600 * 1000
                ? 'text-warning-text'
                : 'text-muted-foreground';
          return (
            <span className={cn('whitespace-nowrap text-sm', staleCls)} title={formatTimestamp(iso)}>
              {humanizeAge(iso)}
            </span>
          );
        }
        if (h && h.buffer_depth > 0) {
          return (
            <span className="whitespace-nowrap text-sm text-muted-foreground">
              {h.buffer_depth} buffered
            </span>
          );
        }
        return <span className="text-muted-foreground">{DASH}</span>;
      },
    },
    {
      id: 'protocol',
      header: 'Protocol',
      sortable: true,
      width: '8rem',
      cell: (s) => <span className="text-sm text-foreground">{sourceProtocol(s)}</span>,
    },
    {
      id: 'groups',
      header: 'Groups',
      width: '8rem',
      cell: (s) => {
        const g = looseString(s.config, 'group') || looseString(s.config, 'groups');
        return g ? (
          <span className="truncate text-sm text-foreground" title={g}>
            {g}
          </span>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        );
      },
    },
    {
      id: 'created_at',
      header: 'Creation Date',
      sortable: true,
      width: '11rem',
      cell: (s) => (
        <span className="whitespace-nowrap text-sm text-muted-foreground">
          {formatTimestamp(s.created_at)}
        </span>
      ),
    },
    {
      id: 'coalescing',
      header: 'Coalescing',
      width: '7rem',
      cell: (s) => <BoolCell value={looseBool(s.config, 'coalescing')} />,
    },
    {
      id: 'store_payload',
      // Labelled "Browsable" (not the QRadar term "Store Payload"): this reflects the
      // server's browse capability honestly — a browse-capable source can be queried for
      // its recent events; it is NOT a claim that raw payloads are retained. Same single
      // `can_browse` definition as the row action; absent (older backend) → —.
      header: 'Browsable',
      width: '8rem',
      cell: (s) => <BoolCell value={s.can_browse} />,
    },
    {
      id: 'internal',
      header: 'Internal',
      width: '6.5rem',
      cell: (s) => <BoolCell value={looseBool(s.config, 'internal')} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      width: '4rem',
      lockVisible: true,
      cell: (s) => (
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                aria-label={`Actions for ${sourceLabel(s, connectorFor(s))}`}
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {canBrowse(s) ? (
                <>
                  <DropdownMenuItem onSelect={() => setLogsSource(s)}>
                    <Telescope className="size-4" aria-hidden /> Browse logs
                  </DropdownMenuItem>
                  {(canManage || s.demo) ? <DropdownMenuSeparator /> : null}
                </>
              ) : null}
              {s.demo ? (
                <DropdownMenuItem disabled title={DEMO_MANAGED_REASON}>
                  <ShieldCheck className="size-4" aria-hidden /> {DEMO_MANAGED_REASON}
                </DropdownMenuItem>
              ) : canManage ? (
                <>
                  {!s.is_primary ? (
                    <DropdownMenuItem onSelect={() => setPendingPrimary(s)}>
                      <Star className="size-4" aria-hidden /> Make primary
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={() => setEditor({ mode: 'edit', source: s })}>
                    <Pencil className="size-4" aria-hidden /> Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => setPendingDelete(s)}
                    className="text-critical focus:text-critical"
                  >
                    <Trash2 className="size-4" aria-hidden /> Remove
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  const columnMenuItems: ColumnMenuItem[] = columns.map((c) => ({
    id: c.id,
    label: c.menuLabel ?? (typeof c.header === 'string' ? c.header : c.id),
    lockVisible: c.lockVisible,
  }));

  /* ------------------------------------------------------------- render --- */

  const firstRun = !loading && !error && sources.length === 0;

  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        icon={Database}
        breadcrumb={[{ label: 'Platform' }, { label: 'Log Sources' }]}
        title="Log Sources"
        description="Connect and manage the systems the agent reads security events from."
        actions={
          !firstRun ? (
            <Can resource="sources" action="manage">
              <Button
                onClick={() => setEditor({ mode: 'add' })}
                disabled={demoManaged}
                title={demoManaged ? DEMO_MANAGED_REASON : undefined}
              >
                <Plus className="mr-1.5 size-4" aria-hidden /> New Log Source
              </Button>
            </Can>
          ) : null
        }
      />

      {error ? (
        <LoadError error={error} title="Something went wrong" onRetry={() => void load()} />
      ) : null}

      {/* Coverage banner — the "am I seeing everything?" rollup (server truth). */}
      {!error && sources.length > 0 ? (
        <CoverageBanner
          total={coverageStats.total}
          enabled={coverageStats.enabled}
          silent={coverageStats.silent}
          eventsPerMin={coverageStats.eventsPerMin}
          alertsTriaged={coverageStats.alertsTriaged}
        />
      ) : null}

      {error ? null : firstRun ? (
        <EmptyState
          icon={Plug}
          title="Connect your first log source"
          description="The agent triages security events from the systems you connect — a SIEM/log store (Elasticsearch, OpenSearch, Wazuh) or a push receiver (webhook, syslog, a queue, an object store). Pick a connector and we'll walk you through it, with a (?) guide on every step."
          action={
            <Can
              resource="sources"
              action="manage"
              fallback={
                <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Link2 className="h-3.5 w-3.5" aria-hidden />
                  Ask a SOC administrator to connect a source.
                </p>
              }
            >
              <span className="inline-flex items-center gap-1.5">
                <Button
                  onClick={() => setEditor({ mode: 'add' })}
                  disabled={demoManaged}
                  title={demoManaged ? DEMO_MANAGED_REASON : undefined}
                >
                  <Plus className="h-4 w-4" aria-hidden /> New Log Source
                </Button>
                <HelpTip
                  label="How adding a source works"
                  text="Choose a connector (e.g. Elasticsearch), fill its form — each field has a (?) with setup help — set the index patterns the agent reads and how clusters auto-correlate, then test and save. For Elasticsearch, create a READ-ONLY scoped API key (never the elastic superuser or kibana_system)."
                />
              </span>
            </Can>
          }
        />
      ) : (
        <>
          <FilterBar
            aria-label="Log source filters"
            className="[&>div:first-child]:min-w-0 [&>div:first-child]:flex-1"
            meta={(
              <span data-testid="sources-count">
                Log Sources ({filteredSorted.length})
                {activeFilters > 0 ? ` of ${sources.length} total` : ''}
              </span>
            )}
            end={
              <>
                <RefreshButton onClick={() => void load()} refreshing={loading} />
                <ColumnsMenu
                  columns={columnMenuItems}
                  state={effectiveColumnState}
                  onChange={handleColumnState}
                />
              </>
            }
          >
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" aria-label="Filter log sources">
                  <Filter className="mr-1.5 size-4" aria-hidden />
                  Filter
                  {activeFilters > 0 ? (
                    <span className="ml-1.5 rounded bg-muted px-1.5 text-2xs tabular-nums text-muted-foreground">
                      {activeFilters}
                    </span>
                  ) : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64" align="start">
                <div className="space-y-3">
                  <FacetGroup
                    label="Enabled"
                    value={filters.enabled}
                    options={[
                      ['any', 'All'],
                      ['enabled', 'Enabled'],
                      ['disabled', 'Disabled'],
                    ]}
                    onChange={(v) => setFilter('enabled', v as SourceFilters['enabled'])}
                  />
                  <FacetGroup
                    label="Kind"
                    value={filters.kind}
                    options={[
                      ['any', 'All'],
                      ['pull', 'Pull'],
                      ['push', 'Push'],
                    ]}
                    onChange={(v) => setFilter('kind', v as SourceFilters['kind'])}
                  />
                  {typeOptions.length ? (
                    <FacetGroup
                      label="Type"
                      value={filters.type}
                      options={[
                        [ANY, 'All types'] as [string, string],
                        ...typeOptions.map((t) => [t.value, t.label] as [string, string]),
                      ]}
                      onChange={(v) => setFilter('type', v)}
                    />
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={clearFilters}
                    disabled={activeFilters === 0}
                  >
                    <X className="mr-1.5 size-4" aria-hidden />
                    Clear filters
                  </Button>
                </div>
              </PopoverContent>
            </Popover>

            <div className="relative min-w-[16rem] flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={filters.search}
                onChange={(e) => setFilter('search', e.target.value)}
                placeholder="Search name, type, or ID…"
                aria-label="Search log sources"
                className="pl-9 pr-9"
              />
              {filters.search ? (
                <IconButton
                  label="Clear search"
                  tooltip={false}
                  size="sm"
                  onClick={() => setFilter('search', '')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm [&_svg]:size-4"
                >
                  <X className="size-4" aria-hidden />
                </IconButton>
              ) : null}
            </div>

          </FilterBar>

          {/* Count line / bulk-action strip. */}
          {selectedSources.length > 0 ? (
            <div
              role="region"
              aria-label="Bulk actions"
              className="flex flex-wrap items-center gap-2 border-y border-border/70 py-2"
            >
              <span
                role="status"
                aria-live="polite"
                className="inline-flex items-center rounded-md bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground"
              >
                {selectedSources.length} selected
              </span>
              <Can resource="sources" action="manage">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void bulkSetEnabled(true)}
                  disabled={bulkBusy}
                >
                  <Check className="mr-1.5 size-4" aria-hidden /> Enable
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void bulkSetEnabled(false)}
                  disabled={bulkBusy}
                >
                  <X className="mr-1.5 size-4" aria-hidden /> Disable
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setPendingBulkRemove(true)}
                  disabled={bulkBusy}
                >
                  <Trash2 className="mr-1.5 size-4" aria-hidden /> Remove
                </Button>
              </Can>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => setSelected([])}
                disabled={bulkBusy}
              >
                Clear
              </Button>
            </div>
          ) : null}

          <DataTable<SourceInstance>
            ariaLabel="Log Sources"
            columns={columns}
            columnState={effectiveColumnState}
            rows={pageRows}
            getRowId={(s) => s.id}
            sort={sort}
            onSortChange={setSort}
            page={page}
            pageSize={pageSize}
            total={filteredSorted.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            pageSizeOptions={[10, 25, 50, 100]}
            selectable={canManage}
            selected={selected}
            onSelectedChange={setSelected}
            isRowSelectable={(s) => !s.demo}
            getRowSelectionDisabledReason={(s) =>
              s.demo ? DEMO_MANAGED_REASON : undefined
            }
            loading={loading}
            loadingRows={6}
            density="compact"
            empty={
              <EmptyState
                compact
                icon={Database}
                title="No sources match your filters"
                description="No configured source matches the current search or filters. Clear them to see all sources."
                action={
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    <X className="mr-1.5 size-4" aria-hidden />
                    Clear filters
                  </Button>
                }
              />
            }
          />
        </>
      )}

      {/* Add / Edit editor (Dialog hosting the dynamic SourceEditor) */}
      <Dialog open={!!editor} onOpenChange={(o) => !o && setEditor(null)}>
        <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === 'edit'
                ? `Edit ${editor.source.display_name || editor.source.source_type}`
                : 'Add a log source'}
            </DialogTitle>
            <DialogDescription>
              Configure a system for the agent to read security events from.
            </DialogDescription>
          </DialogHeader>
          {editor ? (
            <SourceEditor
              connectors={connectors}
              existing={editor.mode === 'edit' ? editor.source : undefined}
              onSaved={onSaved}
              onCancel={() => setEditor(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Per-source logs sheet */}
      <SourceLogsSheet source={logsSource} onClose={() => setLogsSource(null)} />

      {/* Make-primary confirm */}
      <ConfirmDialog
        open={!!pendingPrimary}
        onOpenChange={(o) => !o && setPendingPrimary(null)}
        onConfirm={() => pendingPrimary && void setPrimary(pendingPrimary)}
        title="Make this the primary source?"
        description="The agent reads new events from the primary source."
        confirmLabel="Make primary"
      >
        {pendingPrimary ? (
          <p className="text-sm text-muted-foreground">
            Switching to{' '}
            <span className="font-medium text-foreground">
              {pendingPrimary.display_name || pendingPrimary.source_type}
            </span>{' '}
            repoints ingestion to it; the current primary becomes a non-primary source (it is
            not deleted).
          </p>
        ) : null}
      </ConfirmDialog>

      {/* Remove confirm (destructive — role=alertdialog, no overlay/Escape dismissal) */}
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        onConfirm={() => pendingDelete && void remove(pendingDelete)}
        destructive
        title="Remove this source?"
        confirmLabel="Remove source"
      >
        {pendingDelete ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {pendingDelete.display_name || pendingDelete.source_type}
            </span>{' '}
            will be removed and the agent will stop reading events from it. Existing cases are
            kept; its stored secrets are discarded. This cannot be undone.
          </p>
        ) : null}
        {pendingDelete?.configured_secrets?.length ? (
          <Alert variant="warning">
            <KeyRound className="h-4 w-4" aria-hidden />
            <AlertTitle>Stored secrets will be discarded</AlertTitle>
            <AlertDescription>
              {pendingDelete.configured_secrets.length} configured secret
              {pendingDelete.configured_secrets.length === 1 ? '' : 's'} for this source will be
              removed.
            </AlertDescription>
          </Alert>
        ) : null}
      </ConfirmDialog>

      {/* Bulk remove confirm (destructive) */}
      <ConfirmDialog
        open={pendingBulkRemove}
        onOpenChange={(o) => !o && setPendingBulkRemove(false)}
        onConfirm={() => void bulkRemove()}
        destructive
        title={`Remove ${selectedSources.length} source${selectedSources.length === 1 ? '' : 's'}?`}
        confirmLabel="Remove sources"
      >
        <p className="text-sm text-muted-foreground">
          The selected source{selectedSources.length === 1 ? '' : 's'} will be removed and the
          agent will stop reading events from{' '}
          {selectedSources.length === 1 ? 'it' : 'them'}. Existing cases are kept; stored secrets
          are discarded. This cannot be undone.
        </p>
      </ConfirmDialog>
    </PageContainer>
  );
}

/* ------------------------------------------------------------- sub-parts --- */

/**
 * The "am I seeing everything?" coverage banner — the Google SecOps Health-Hub big-number
 * strip. Four honest aggregate signals over the connected sources: how many are reporting,
 * the live event throughput, how many alerts were triaged in the last day, and (loudly, when
 * nonzero) how many sources have gone SILENT. All values are server-derived aggregates /
 * counts rendered as plain text — advisory only (#3), never a secret (#10).
 */
function CoverageBanner({
  total,
  enabled,
  silent,
  eventsPerMin,
  alertsTriaged,
}: {
  total: number;
  enabled: number;
  silent: number;
  eventsPerMin: number;
  alertsTriaged: number | null;
}) {
  const hasSilent = silent > 0;
  return (
    <section
      role="group"
      aria-label="Ingest coverage"
      data-testid="coverage-banner"
      /* One ENABLE + one ROW-START RESET per mutually-exclusive column count (see the
         note on the same strip in `Cases.tsx`): the unscoped odd reset used to outrank
         `sm:[&>*]:border-l` at 4 columns and leave cell 3 with no divider. */
      className="grid grid-cols-2 border-y border-border/70 sm:grid-cols-4 max-sm:[&>*]:border-l max-sm:[&>*:nth-child(2n+1)]:border-l-0 sm:[&>*]:border-l sm:[&>*:nth-child(4n+1)]:border-l-0"
    >
      <CoverageStat
        testId="coverage-sources"
        icon={Database}
        label="Sources"
        value={`${fmtNumber(enabled)} of ${fmtNumber(total)}`}
        sub="enabled"
      />
      <CoverageStat
        testId="coverage-events"
        icon={Activity}
        label="Events / min"
        value={fmtNumber(Math.round(eventsPerMin))}
        sub="across enabled sources"
      />
      <CoverageStat
        testId="coverage-alerts"
        icon={ShieldCheck}
        label="Alerts triaged"
        value={alertsTriaged == null ? DASH : fmtNumber(alertsTriaged)}
        sub="last 24h"
      />
      <CoverageStat
        testId="coverage-silent"
        icon={AlertTriangle}
        label="Silent"
        value={fmtNumber(silent)}
        sub={hasSilent ? 'need attention' : 'all reporting'}
        tone={hasSilent ? 'warning' : 'default'}
      />
    </section>
  );
}

/** One big-number cell inside the {@link CoverageBanner}. */
const CoverageStat: React.FC<{
  testId: string;
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  tone?: 'default' | 'warning';
}> = ({ testId, icon: Icon, label, value, sub, tone = 'default' }) => (
  <div className="flex items-start gap-2.5 border-l border-border/70 px-3 py-3 first:border-l-0" data-testid={testId}>
    <span className={cn('mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center', tone === 'warning' ? 'text-warning-text' : 'text-muted-foreground')}>
      <Icon className="h-4 w-4" aria-hidden />
    </span>
    <div className="min-w-0">
      <div
        className={cn(
          'font-mono text-lg font-semibold leading-none tabular-nums',
          tone === 'warning' ? 'text-warning-text' : 'text-foreground',
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-2xs text-muted-foreground/80">{sub}</div>
    </div>
  </div>
);

/** A plain Yes / No / — cell for an optional derived boolean (never fakes data). */
const BoolCell: React.FC<{ value: boolean | undefined }> = ({ value }) => {
  if (value === undefined) return <span className="text-muted-foreground">{DASH}</span>;
  return value ? (
    <Badge variant="success">Yes</Badge>
  ) : (
    <Badge variant="secondary">No</Badge>
  );
};

/** A labelled single-select facet group (radio-style buttons) inside the filter popover. */
const FacetGroup: React.FC<{
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}> = ({ label, value, options, onChange }) => (
  <div>
    <p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p>
    <div className="flex flex-col gap-0.5" role="group" aria-label={label}>
      {options.map(([val, lbl]) => (
        <button
          key={val}
          type="button"
          aria-pressed={value === val}
          onClick={() => onChange(val)}
          className={cn(
            'flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors',
            'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === val ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          <span className="truncate">{lbl}</span>
          {value === val ? <Check className="size-4 shrink-0" aria-hidden /> : null}
        </button>
      ))}
    </div>
  </div>
);
