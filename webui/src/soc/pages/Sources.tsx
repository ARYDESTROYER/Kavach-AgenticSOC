/**
 * Sources: the systems the agent reads security events from (Round 14 console grammar,
 * SPEC §4.9.4 and the C7 option 1 "Sources" sheet).
 *
 * The Overview's page grammar: a plain header ("Sources", a help tip, the source count
 * and Refresh beside the title, "Add source" on the right), one KPI strip on a panel
 * (ingest coverage), then one "Connected sources" panel holding the filter bar (search,
 * Enabled, Kind and Type, removable chips) and a dense sortable DataTable that bleeds to
 * the panel edge. The Name column takes the spare width and every other column shrinks
 * to its content; there is no pager while the list fits one page. Rows carry a Status
 * dot (coloured only for an exception), Last event, an inline Enabled switch and a row
 * menu (Browse logs, Make primary, Edit, Remove); bulk select offers Enable, Disable and
 * Remove. Status and Last event are honestly derived from the read-only
 * GET /api/sources/health signal (durable poll cursor for PULL sources, live-tail buffer
 * depth for PUSH receivers). In Demo Mode the sources are fixed, and the header says so
 * in words instead of showing a disabled button.
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
  X,
  MoreHorizontal,
  KeyRound,
  Check,
  ShieldCheck,
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
import { properName } from '@/lib/proper-names';
import { cn } from '@/lib/cn';
import { toast } from 'sonner';

import { Panel, StatusDot, type StatusTone } from '@/design-system';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { FilterBar, type FilterChip } from '@/soc/components/FilterBar';
import { KpiStrip } from '@/soc/components/KpiStrip';
import { KpiTile } from '@/soc/components/KpiTile';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SourceEditor } from '@/soc/components/SourceEditor';
import { SourceLogsSheet } from '@/soc/components/SourceLogsSheet';
import { headingOf, useReturnFocus } from '@/soc/hooks/useReturnFocus';
import { categoryMeta } from '@/soc/components/ConnectorPicker';
import { Can, useCan } from '@/soc/components/Can';
import { HelpTip } from '@/soc/components/HelpTip';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';

/* --------------------------------------------------------------- helpers --- */

/** Stable id for the Sources table's per-user column state (Wave 7). */
const SOURCES_TABLE_ID = 'sources';

/** A column that shrinks to its content (the Name column takes the spare width). */
const FIT_COLUMN = 'w-px whitespace-nowrap';

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
/** The page's explanation, shown in the header help tip (C8: no description line). */
const PAGE_HELP = 'Connect and manage the systems the agent reads security events from.';
/** Said in words in the header while Demo Mode owns the source list (no disabled button). */
const DEMO_FIXED_NOTE = 'Sources are fixed in Demo mode';

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
  return s.display_name || meta?.display_name || properName(s.source_type);
}

/** A loose-config string value (Groups etc.), or '' when absent/non-string. */
function looseString(cfg: SourceInstance['config'], key: string): string {
  const v = cfg?.[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** Source-native wire format when declared; otherwise the generic ingest direction. */
function sourceProtocol(s: SourceInstance): string {
  return looseString(s.config, 'protocol') || properName(s.ingest_mode);
}

/** A loose-config boolean (Coalescing / Internal), or undefined when absent. */
function looseBool(cfg: SourceInstance['config'], key: string): boolean | undefined {
  const v = cfg?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

type StatusKind = 'disabled' | 'ok' | 'idle' | 'silent' | 'error';

/**
 * The dot tone per status: the healthy states stay quiet (a neutral dot and muted text),
 * so only a silent or broken source stands out. The status is always in the words too.
 */
const STATUS_TONE: Record<StatusKind, StatusTone> = {
  ok: 'neutral',
  idle: 'neutral',
  disabled: 'neutral',
  silent: 'warning',
  error: 'critical',
};
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
  // The editor, the logs sheet and the confirmations open from state (a row menu item or a
  // button outside their root), so each remembers its opener and hands focus back to it
  // on close (SPEC §3.3). A row menu item resolves to the row's "Actions for" button.
  const editorOpener = useReturnFocus();
  const logsOpener = useReturnFocus();
  const deleteOpener = useReturnFocus();
  const primaryOpener = useReturnFocus();
  const bulkRemoveOpener = useReturnFocus();
  const clearSelectionFocus = useReturnFocus();
  // The sources panel. A removal reloads the list after its confirmation has closed and
  // takes the row's "Actions for" button with it: focus then moves to the next row's
  // button, else the panel's heading, never to the page body.
  const listRef = React.useRef<HTMLElement>(null);
  const rowActionsFallback = React.useMemo(
    () => ({
      peers: () => listRef.current?.querySelectorAll('[data-source-row-actions]') ?? [],
      empty: () => headingOf(listRef.current),
    }),
    [],
  );
  const openEditor = (next: NonNullable<EditorState>) => {
    editorOpener.remember();
    setEditor(next);
  };

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
      deleteOpener.expectRemoval();
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
    (s: SourceInstance) => connectorFor(s)?.display_name || properName(s.source_type),
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
    // Clearing the selection hides the bulk bar, and its Remove button with it.
    bulkRemoveOpener.expectRemoval();
    setSelected([]);
    setPendingBulkRemove(false);
    await load();
    setBulkBusy(false);
  }, [selectedSources, load, bulkRemoveOpener]);

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

  // The Demo note sits beside the module title once; a row is marked only when the list
  // mixes Demo sources with real ones, where the row itself is the fact a reader needs.
  const demoRows = sources.some((s) => s.demo === true);
  const mixedDemo = demoRows && sources.some((s) => s.demo !== true);

  const columns: DataTableColumn<SourceInstance>[] = [
    {
      id: 'id',
      header: 'ID',
      menuLabel: 'ID',
      kind: 'id',
      className: FIT_COLUMN,
      headerClassName: FIT_COLUMN,
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
      // The one flexible column: it takes the spare width (C7: every other column
      // shrinks to its content).
      className: 'w-full',
      headerClassName: 'w-full',
      text: (s) => sourceLabel(s, connectorFor(s)),
      cell: (s) => {
        const meta = connectorFor(s);
        const name = sourceLabel(s, meta);
        const secretCount = s.configured_secrets?.length || 0;
        const subline = [typeLabel(s), properName(s.ingest_mode)]
          .filter((v) => v && v !== DASH)
          .join(' · ');
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {canManage && !s.demo ? (
                <button
                  type="button"
                  onClick={() => openEditor({ mode: 'edit', source: s })}
                  className="max-w-[28rem] truncate rounded-sm text-sm font-semibold text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title={name}
                >
                  {name}
                </button>
              ) : (
                <span className="max-w-[28rem] truncate text-sm font-semibold text-foreground" title={name}>
                  {name}
                </span>
              )}
              {s.is_primary ? <Badge variant="default">Primary</Badge> : null}
              {s.demo && mixedDemo ? (
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
      className: FIT_COLUMN,
      headerClassName: FIT_COLUMN,
      text: (s) => typeLabel(s),
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
            <span className="text-sm text-foreground">{typeLabel(s)}</span>
          </span>
        );
      },
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      className: FIT_COLUMN,
      headerClassName: FIT_COLUMN,
      text: (s) => sourceStatus(s, health[s.id]).label,
      cell: (s) => {
        const h = health[s.id];
        const st = sourceStatus(s, h);
        // A connector error string is source-controlled data: plain text only (#9).
        const title =
          st.kind === 'disabled'
            ? 'Source is disabled'
            : st.kind === 'error'
              ? h?.last_poll_error
                ? `Last poll failed: ${h.last_poll_error}`
                : 'The last poll attempt failed'
              : st.kind === 'silent'
                ? 'Enabled but no recent events: the source may have stopped reporting'
                : st.kind === 'ok'
                  ? `Active${h?.kind ? ` · ${humanizeToken(h.kind)} source` : ''}`
                  : 'Enabled, no events observed yet';
        return (
          <StatusDot tone={STATUS_TONE[st.kind]} title={title} data-testid={`source-status-${s.id}`}>
            {st.label}
          </StatusDot>
        );
      },
    },
    {
      id: 'enabled',
      header: 'Enabled',
      className: FIT_COLUMN,
      headerClassName: FIT_COLUMN,
      text: (s) => (s.enabled !== false ? 'Enabled' : 'Disabled'),
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
      header: 'Last event',
      sortable: true,
      kind: 'time',
      className: FIT_COLUMN,
      headerClassName: FIT_COLUMN,
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
      className: FIT_COLUMN,
      headerClassName: FIT_COLUMN,
      cell: (s) => <span className="text-sm text-foreground">{sourceProtocol(s)}</span>,
    },
    {
      id: 'groups',
      header: 'Groups',
      className: FIT_COLUMN,
      headerClassName: FIT_COLUMN,
      cell: (s) => {
        const g = looseString(s.config, 'group') || looseString(s.config, 'groups');
        return g ? (
          <span className="block max-w-[12rem] truncate text-sm text-foreground" title={g}>
            {g}
          </span>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        );
      },
    },
    {
      id: 'created_at',
      header: 'Created',
      sortable: true,
      kind: 'time',
      className: FIT_COLUMN,
      headerClassName: FIT_COLUMN,
      cell: (s) => (
        <span className="whitespace-nowrap text-sm text-muted-foreground">
          {formatTimestamp(s.created_at)}
        </span>
      ),
    },
    {
      id: 'coalescing',
      header: 'Coalescing',
      className: FIT_COLUMN,
      headerClassName: FIT_COLUMN,
      cell: (s) => <BoolCell value={looseBool(s.config, 'coalescing')} />,
    },
    {
      id: 'store_payload',
      // Labelled "Browsable" (not the QRadar term "Store Payload"): this reflects the
      // server's browse capability honestly — a browse-capable source can be queried for
      // its recent events; it is NOT a claim that raw payloads are retained. Same single
      // `can_browse` definition as the row action; absent (older backend) → —.
      header: 'Browsable',
      className: FIT_COLUMN,
      headerClassName: FIT_COLUMN,
      cell: (s) => <BoolCell value={s.can_browse} />,
    },
    {
      id: 'internal',
      header: 'Internal',
      className: FIT_COLUMN,
      headerClassName: FIT_COLUMN,
      cell: (s) => <BoolCell value={looseBool(s.config, 'internal')} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      className: FIT_COLUMN,
      headerClassName: FIT_COLUMN,
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
                data-source-row-actions=""
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {canBrowse(s) ? (
                <>
                  <DropdownMenuItem
                    onSelect={() => {
                      logsOpener.remember();
                      setLogsSource(s);
                    }}
                  >
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
                    <DropdownMenuItem
                      onSelect={() => {
                        primaryOpener.remember();
                        setPendingPrimary(s);
                      }}
                    >
                      <Star className="size-4" aria-hidden /> Make primary
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={() => openEditor({ mode: 'edit', source: s })}>
                    <Pencil className="size-4" aria-hidden /> Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* Neutral at rest, red only on hover and keyboard focus and in the
                      confirm dialog (the RowActions rule, SPEC §4.9.2). */}
                  <DropdownMenuItem
                    onSelect={() => {
                      deleteOpener.remember(undefined, rowActionsFallback);
                      setPendingDelete(s);
                    }}
                    className="focus:bg-critical/10 focus:text-critical-text [&:focus>svg]:text-critical-text"
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
  // No pager while the list fits one page (C7): the footer would only restate the count.
  const singlePage = filteredSorted.length <= pageSize;

  const typeName = (value: string) => typeOptions.find((t) => t.value === value)?.label ?? properName(value);
  const chips: FilterChip[] = [
    ...(filters.enabled !== 'any'
      ? [{ id: 'enabled', label: `Enabled: ${filters.enabled === 'enabled' ? 'Yes' : 'No'}`, onRemove: () => setFilter('enabled', 'any') }]
      : []),
    ...(filters.kind !== 'any'
      ? [{ id: 'kind', label: `Kind: ${filters.kind === 'pull' ? 'Pull' : 'Push'}`, onRemove: () => setFilter('kind', 'any') }]
      : []),
    ...(filters.type !== ANY
      ? [{ id: 'type', label: `Type: ${typeName(filters.type)}`, onRemove: () => setFilter('type', ANY) }]
      : []),
  ];

  const addSourceButton = (
    <Button onClick={() => openEditor({ mode: 'add' })}>
      <Plus className="mr-1.5 size-4" aria-hidden /> Add source
    </Button>
  );

  return (
    <PageContainer variant="wide">
      <PageHeader
        title="Sources"
        help={PAGE_HELP}
        controls={
          !firstRun && !error ? (
            <>
              <span className="text-sm tabular-nums text-muted-foreground" data-testid="sources-total">
                {loading && sources.length === 0
                  ? 'Loading'
                  : `${fmtNumber(sources.length)} ${sources.length === 1 ? 'source' : 'sources'}`}
              </span>
              <RefreshButton onClick={() => void load()} refreshing={loading} label="Refresh sources" display="icon" />
            </>
          ) : undefined
        }
        actions={
          !firstRun ? (
            <Can resource="sources" action="manage">
              {demoManaged ? (
                // A reason anyone can read, not a disabled button whose reason only a
                // pointer hover could reach.
                <span className="text-sm text-muted-foreground" data-testid="sources-demo-fixed">
                  {DEMO_FIXED_NOTE}
                </span>
              ) : (
                addSourceButton
              )}
            </Can>
          ) : null
        }
      />

      {error ? (
        <LoadError error={error} title="Could not load sources" onRetry={() => void load()} />
      ) : null}

      {/* Ingest coverage: the "am I seeing everything?" rollup (server truth). */}
      {!error && sources.length > 0 ? (
        <CoverageStrip
          total={coverageStats.total}
          enabled={coverageStats.enabled}
          silent={coverageStats.silent}
          eventsPerMin={coverageStats.eventsPerMin}
          alertsTriaged={coverageStats.alertsTriaged}
        />
      ) : null}

      {error ? null : firstRun ? (
        // The same ref as the list panel: removing the last source lands focus here.
        <Panel as="div" ref={listRef}>
          <EmptyState
            icon={Plug}
            title="Connect your first source"
            description="The agent triages security events from the systems you connect: a SIEM or log store (Elasticsearch, OpenSearch, Wazuh) or a push receiver (webhook, syslog, a queue, an object store). Pick a connector and the form walks you through it, with a help tip on every field."
            action={
              <Can
                resource="sources"
                action="manage"
                fallback={
                  <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Link2 className="h-3.5 w-3.5" aria-hidden />
                    Ask a SOC administrator to connect a source.
                  </p>
                }
              >
                {demoManaged ? (
                  <p className="text-sm text-muted-foreground">{DEMO_FIXED_NOTE}</p>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    {addSourceButton}
                    <HelpTip
                      label="How adding a source works"
                      text="Choose a connector (for example Elasticsearch) and fill its form; each field has a help tip. Set the index patterns the agent reads and how clusters correlate, then test and save. For Elasticsearch, create a read-only scoped API key, never the elastic superuser or kibana_system."
                    />
                  </span>
                )}
              </Can>
            }
          />
        </Panel>
      ) : (
        <Panel
          ref={listRef}
          title="Connected sources"
          padding="none"
          count={
            activeFilters > 0
              ? `${fmtNumber(filteredSorted.length)} of ${fmtNumber(sources.length)} shown`
              : undefined
          }
          caption={
            demoRows ? (
              <Badge
                variant="warning"
                className="px-1.5 py-0 text-xs font-medium"
                title="Demo data: these sources are synthetic, not from a real environment"
              >
                Demo
              </Badge>
            ) : undefined
          }
          actions={
            <ColumnsMenu columns={columnMenuItems} state={effectiveColumnState} onChange={handleColumnState} />
          }
          data-testid="sources-panel"
        >
          <div className="px-4 pb-3 xl:px-5 3xl:px-6">
            <FilterBar
              aria-label="Source filters"
              search={{
                value: filters.search,
                onChange: (value) => setFilter('search', value),
                label: 'Search sources',
                placeholder: 'Search name, type or ID',
              }}
              filters={[
                {
                  id: 'enabled',
                  label: 'Enabled',
                  active: filters.enabled !== 'any',
                  control: ({ placement }) => (
                    <Select
                      value={filters.enabled}
                      onValueChange={(v) => setFilter('enabled', v as SourceFilters['enabled'])}
                    >
                      <SelectTrigger aria-label="Enabled" className={placement === 'bar' ? 'h-8 w-36' : 'h-9 w-full'}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Any state</SelectItem>
                        <SelectItem value="enabled">Enabled</SelectItem>
                        <SelectItem value="disabled">Disabled</SelectItem>
                      </SelectContent>
                    </Select>
                  ),
                },
                {
                  id: 'kind',
                  label: 'Kind',
                  active: filters.kind !== 'any',
                  control: ({ placement }) => (
                    <Select value={filters.kind} onValueChange={(v) => setFilter('kind', v as SourceFilters['kind'])}>
                      <SelectTrigger aria-label="Kind" className={placement === 'bar' ? 'h-8 w-32' : 'h-9 w-full'}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Any kind</SelectItem>
                        <SelectItem value="pull">Pull</SelectItem>
                        <SelectItem value="push">Push</SelectItem>
                      </SelectContent>
                    </Select>
                  ),
                },
                {
                  id: 'type',
                  label: 'Type',
                  active: filters.type !== ANY,
                  control: ({ placement }) => (
                    <Select value={filters.type} onValueChange={(v) => setFilter('type', v)}>
                      <SelectTrigger aria-label="Type" className={placement === 'bar' ? 'h-8 w-40' : 'h-9 w-full'}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ANY}>All types</SelectItem>
                        {typeOptions.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ),
                },
              ]}
              chips={chips}
              activeCount={activeFilters}
              onClearAll={activeFilters > 0 ? clearFilters : undefined}
            />
          </div>

          {/* Bulk-action strip, on the panel inset above the table it acts on. */}
          {selectedSources.length > 0 ? (
            <div
              role="region"
              aria-label="Bulk actions"
              className="flex flex-wrap items-center gap-2 border-t border-border/70 px-4 py-2 xl:px-5 3xl:px-6"
            >
              <span role="status" aria-live="polite" className="text-sm font-medium text-foreground">
                {selectedSources.length} selected
              </span>
              <Can resource="sources" action="manage">
                <Button variant="outline" size="sm" onClick={() => void bulkSetEnabled(true)} disabled={bulkBusy}>
                  <Check className="mr-1.5 size-4" aria-hidden /> Enable
                </Button>
                <Button variant="outline" size="sm" onClick={() => void bulkSetEnabled(false)} disabled={bulkBusy}>
                  <X className="mr-1.5 size-4" aria-hidden /> Disable
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  // Neutral at rest; red only on hover, focus and in the confirm dialog.
                  className="hover:text-critical-text focus-visible:text-critical-text"
                  onClick={(event) => {
                    bulkRemoveOpener.remember(event.currentTarget, {
                      empty: () => headingOf(listRef.current),
                    });
                    setPendingBulkRemove(true);
                  }}
                  disabled={bulkBusy}
                >
                  <Trash2 className="mr-1.5 size-4" aria-hidden /> Remove
                </Button>
              </Can>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={(event) => {
                  // Clearing the selection hides the bar with this button in it.
                  clearSelectionFocus.remember(event.currentTarget, {
                    empty: () => headingOf(listRef.current),
                  });
                  clearSelectionFocus.expectRemoval();
                  setSelected([]);
                }}
                disabled={bulkBusy}
              >
                Clear selection
              </Button>
            </div>
          ) : null}

          <DataTable<SourceInstance>
            ariaLabel="Sources"
            surface="panel"
            columns={columns}
            columnState={effectiveColumnState}
            rows={singlePage ? filteredSorted : pageRows}
            getRowId={(s) => s.id}
            sort={sort}
            onSortChange={setSort}
            page={singlePage ? undefined : page}
            pageSize={singlePage ? undefined : pageSize}
            total={singlePage ? undefined : filteredSorted.length}
            onPageChange={singlePage ? undefined : setPage}
            onPageSizeChange={singlePage ? undefined : setPageSize}
            pageSizeOptions={[10, 25, 50, 100]}
            selectable={canManage}
            selected={selected}
            onSelectedChange={setSelected}
            isRowSelectable={(s) => !s.demo}
            getRowSelectionDisabledReason={(s) => (s.demo ? DEMO_MANAGED_REASON : undefined)}
            loading={loading}
            loadingRows={6}
            density="compact"
            empty={
              <EmptyState
                compact
                state="no-results"
                icon={Database}
                title="No sources match these filters"
                description="Clear the search or the filters to see every source."
                action={
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    <X className="mr-1.5 size-4" aria-hidden />
                    Clear filters
                  </Button>
                }
              />
            }
          />
        </Panel>
      )}

      {/* Add / Edit editor (Dialog hosting the dynamic SourceEditor) */}
      <Dialog open={!!editor} onOpenChange={(o) => !o && setEditor(null)}>
        <DialogContent
          className="max-h-[90dvh] max-w-2xl overflow-y-auto"
          onCloseAutoFocus={editorOpener.onCloseAutoFocus}
        >
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === 'edit'
                ? `Edit ${editor.source.display_name || properName(editor.source.source_type)}`
                : 'Add a source'}
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
      <SourceLogsSheet
        source={logsSource}
        onClose={() => setLogsSource(null)}
        onCloseAutoFocus={logsOpener.onCloseAutoFocus}
      />

      {/* Make-primary confirm */}
      <ConfirmDialog
        open={!!pendingPrimary}
        onOpenChange={(o) => !o && setPendingPrimary(null)}
        returnFocusRef={primaryOpener.ref}
        onConfirm={() => pendingPrimary && void setPrimary(pendingPrimary)}
        title="Make this the primary source?"
        description="The agent reads new events from the primary source."
        confirmLabel="Make primary"
      >
        {pendingPrimary ? (
          <p className="text-sm text-muted-foreground">
            Switching to{' '}
            <span className="font-medium text-foreground">
              {pendingPrimary.display_name || properName(pendingPrimary.source_type)}
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
        returnFocusRef={deleteOpener.ref}
        onConfirm={() => pendingDelete && void remove(pendingDelete)}
        destructive
        title="Remove this source?"
        confirmLabel="Remove source"
      >
        {pendingDelete ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {pendingDelete.display_name || properName(pendingDelete.source_type)}
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
        returnFocusRef={bulkRemoveOpener.ref}
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
 * Ingest coverage: the "am I seeing everything?" KPI strip. Four honest aggregate signals
 * over the connected sources: how many are enabled, the live event throughput, how many
 * alerts were triaged in the last day, and how many enabled sources have gone silent
 * (its numeral turns red only above zero, the hero rule). All values are server-derived
 * aggregates or counts rendered as plain text, advisory only (#3), never a secret (#10).
 */
function CoverageStrip({
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
  return (
    <KpiStrip label="Ingest coverage" density="compact" data-testid="coverage-banner">
      <KpiTile
        testId="coverage-sources"
        label="Sources enabled"
        value={`${fmtNumber(enabled)} of ${fmtNumber(total)}`}
        context={enabled === total ? 'all enabled' : `${fmtNumber(total - enabled)} turned off`}
      />
      <KpiTile
        testId="coverage-events"
        label="Events per minute"
        value={fmtNumber(Math.round(eventsPerMin))}
        context="across enabled sources"
      />
      <KpiTile
        testId="coverage-alerts"
        label="Alerts triaged"
        value={alertsTriaged == null ? DASH : fmtNumber(alertsTriaged)}
        context="last 24 hours"
      />
      <KpiTile
        testId="coverage-silent"
        label="Silent sources"
        value={fmtNumber(silent)}
        countTo={silent}
        // A number the operator reloads: shown as it is, never rolled.
        roll={false}
        format={fmtNumber}
        accent="critical"
        context={silent > 0 ? 'need attention' : 'all reporting'}
      />
    </KpiStrip>
  );
}

/** A plain Yes / No / — cell for an optional derived boolean (never fakes data). */
const BoolCell: React.FC<{ value: boolean | undefined }> = ({ value }) => {
  if (value === undefined) return <span className="text-muted-foreground">{DASH}</span>;
  return value ? (
    <Badge variant="success">Yes</Badge>
  ) : (
    <Badge variant="secondary">No</Badge>
  );
};
