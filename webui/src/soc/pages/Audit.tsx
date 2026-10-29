/**
 * The Audit log (Round 14 SPEC §4.5, operator choice C1 A): a read-only, server-paged
 * view of the append-only audit trail (#2) that a person can open, filter and export.
 *
 * - Header (C8): the title, a help tip, the time range and Refresh beside the title, and
 *   the Export menu on the right (hidden without `audit:export`).
 * - Control band: the scope (People and settings by default, D4), the server-side search
 *   (`/` focuses it), the Event, Actor, Outcome and More filters menus, the active filters
 *   as chips with Clear all, and the quick views.
 * - Scope line: "Showing 1 to 50 of 1,284 events · last 7 days · times in UTC · newest
 *   first" ("at least" when the store can only bound the total), the retention, and in
 *   Demo Mode which rows are demo data (D11).
 * - The list, on one full-bleed panel: 50 rows a page, "Load more" at the foot, J and K to
 *   walk it; Agent activity folds each investigation into one row.
 * - The inspector: a 560 px sheet, non-modal from 1280 px (the list stays live), modal
 *   below, full screen on a phone.
 *
 * The URL carries the view (`#/audit?scope=people&from=now-7d&q=...&record=<id>`; empty
 * keys are omitted); a filter change is a navigation, so Back returns to the previous
 * view. Opening and paging records replaces the hash instead, so J and K never flood the
 * history. Every value renders as plain text (#9); stored data is shown verbatim.
 */
import * as React from 'react';
import { Keyboard, ScrollText } from 'lucide-react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { getAuditRecord, listAuditPage } from '@/lib/api-audit';
import type { AuditPage, AuditRecord, AuditRetention } from '@/lib/types-audit';
import { Callout, LoadingState, Panel } from '@/design-system';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/ui/dialog';

import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { ProtectedRoute, Unauthorized, useCan } from '@/soc/components/Can';
import { TimeRangePicker } from '@/soc/components/TimeRangePicker';
import { AuditControlBand, AuditCustomRange, filterChips, loadedActors, type LocalPatch, type ViewPatch } from '@/soc/components/audit/AuditFilters';
import { AuditExportDialog, AuditExportMenu } from '@/soc/components/audit/AuditExport';
import { AuditInspector, INSPECTOR_TITLE_ID, type RelatedKind } from '@/soc/components/audit/AuditInspector';
import { AuditTable, type AuditTableLayout, type OpenVia } from '@/soc/components/audit/AuditTable';
import {
  AUDIT_RANGES,
  EMPTY_LOCAL_FILTERS,
  TIMEZONE_STORAGE_KEY,
  activeFilterCount,
  buildListItems,
  caseLabelsOf,
  clearedView,
  formatMinute,
  isoSecond,
  notAppliedPair,
  optsFromView,
  pageQuery,
  rangeLabel,
  rangePhrase,
  readKey,
  timeOf,
  viewFromOpts,
  type AuditExportFileFormat,
  type AuditLocalFilters,
  type AuditTimeZone,
  type AuditView,
} from '@/soc/components/audit/audit-model';
import { useDemo } from '@/soc/demo';
import { useMediaQuery } from '@/soc/hooks/useMediaQuery';
import { pageHash, useRoute, type Navigate } from '@/soc/router';

const PAGE_HELP = 'Every action by people, the AI agent and the system, kept append-only. Open a row to see the full record.';
const EXPIRED_COPY = 'The list was refreshed because it had been open a long time.';

const SHORTCUTS: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: '↑ ↓', action: 'Move between events' },
  { keys: 'J  K', action: 'Move to the next or previous event and open it' },
  { keys: 'Enter', action: 'Open the event' },
  { keys: 'Home  End', action: 'First or last loaded event' },
  { keys: 'Esc', action: 'Close the record' },
  { keys: '/', action: 'Search the audit log' },
  { keys: '?', action: 'Show these shortcuts' },
];

/** The wider range the "no events" state offers. */
const WIDER_RANGE: Readonly<Record<string, string>> = {
  'now-1h': 'now-24h',
  'now-24h': 'now-7d',
  'now-7d': 'now-30d',
  'now-30d': 'now-90d',
};

function readZone(): AuditTimeZone {
  try {
    return window.localStorage.getItem(TIMEZONE_STORAGE_KEY) === 'local' ? 'local' : 'utc';
  } catch {
    return 'utc';
  }
}

function writeZone(zone: AuditTimeZone) {
  try {
    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, zone);
  } catch {
    /* private window or blocked storage: the choice lasts while the page is open */
  }
}

function replaceHash(hash: string) {
  try {
    window.history.replaceState(window.history.state, '', hash);
  } catch {
    /* a sandboxed frame may refuse; the in-memory selection is already right */
  }
}

/** The error code of a coded API error (`{detail: {code}}`). */
function errorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const detail = (error.body as { detail?: unknown } | undefined)?.detail;
  return detail && typeof detail === 'object' && typeof (detail as { code?: unknown }).code === 'string'
    ? ((detail as { code: string }).code)
    : null;
}

function retentionText(retention: AuditRetention | null): string | null {
  if (!retention || retention.volatile) return null;
  const { hot_days: hot, warm_days: warm } = retention;
  if (hot && warm) return `Kept ${hot.toLocaleString()} days hot, then ${warm.toLocaleString()} days warm`;
  if (hot) return `Kept ${hot.toLocaleString()} days hot`;
  return null;
}

/** Is the key press a shortcut the page may act on (not typing, not in a menu or another dialog)? */
function shortcutTarget(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (!target || typeof target.closest !== 'function') return true;
  if (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]')) return false;
  if (target.closest('[role="menu"], [role="listbox"], [role="combobox"], [data-radix-popper-content-wrapper]')) return false;
  const dialog = target.closest('[role="dialog"]');
  if (dialog && !dialog.hasAttribute('data-audit-inspector')) return false;
  return true;
}

interface ListState {
  records: AuditRecord[];
  nextCursor: string | null;
  total: number;
  relation: 'eq' | 'gte';
  runTotals: Record<string, number>;
  retention: AuditRetention | null;
  /** The load these rows came from (the read plus its Refresh count). */
  key: string | null;
  /** The read these rows answer (view, in-memory filters, order and Demo identity), whatever the Refresh count. */
  readId: string | null;
}

const EMPTY_LIST: ListState = {
  records: [],
  nextCursor: null,
  total: 0,
  relation: 'eq',
  runTotals: {},
  retention: null,
  key: null,
  readId: null,
};

interface FetchedRecord {
  id: string;
  record: AuditRecord | null;
  notFound: boolean;
  /** The read failed for another reason (the inspector offers Retry). */
  failed: boolean;
  loading: boolean;
}

/** The "no events" title, in the scope's own words ("No agent activity in the last 7 days."). */
function noEventsTitle(scope: AuditView['scope'], when: string): string {
  if (scope === 'agent') return `No agent activity ${when}.`;
  if (scope === 'people') return `No people and settings events ${when}.`;
  return `No audit events ${when}.`;
}

export interface AuditProps {
  onNavigate?: Navigate;
}

function AuditLog({ onNavigate }: AuditProps) {
  const route = useRoute();
  const navigate = onNavigate ?? route.navigate;
  const routeOpts = route.page === 'audit' ? route.opts : undefined;
  const view = React.useMemo(() => viewFromOpts(routeOpts), [routeOpts]);
  const urlRecord = typeof routeOpts?.record === 'string' ? routeOpts.record : null;

  const [local, setLocal] = React.useState<AuditLocalFilters>(EMPTY_LOCAL_FILTERS);
  const [order, setOrder] = React.useState<'desc' | 'asc'>('desc');
  const [zone, setZone] = React.useState<AuditTimeZone>(readZone);
  const [list, setList] = React.useState<ListState>(EMPTY_LIST);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [nonce, setNonce] = React.useState(0);
  const [openRuns, setOpenRuns] = React.useState<ReadonlySet<string>>(() => new Set());
  const [liveMessage, setLiveMessage] = React.useState('');
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  // `?` opens the shortcuts from wherever focus is; Esc hands it back there.
  const shortcutsReturnRef = React.useRef<HTMLElement | null>(null);
  const exportTriggerRef = React.useRef<HTMLButtonElement>(null);
  const [exportFormat, setExportFormat] = React.useState<AuditExportFileFormat>('csv');
  const [exportOpen, setExportOpen] = React.useState(false);

  const phone = useMediaQuery('(max-width: 639.98px)');
  const wide = useMediaQuery('(min-width: 1280px)');
  const layout: AuditTableLayout = phone ? 'phone' : wide ? 'wide' : 'medium';
  const canExport = useCan('audit', 'export');
  const canFullExport = useCan('data_export', 'export');
  const canOpenCase = useCan('cases', 'read');
  const canOpenSource = useCan('sources', 'read');
  const demo = useDemo();

  // The record shown: a J/K or a click overrides the URL until the route changes.
  const [localRecord, setLocalRecord] = React.useState<string | null | undefined>(undefined);
  React.useEffect(() => setLocalRecord(undefined), [routeOpts]);
  const selectedId = localRecord !== undefined ? localRecord : urlRecord;
  const focusTitleRef = React.useRef(false);
  const lastShownRef = React.useRef<string | null>(null);
  if (selectedId) lastShownRef.current = selectedId;

  const searchRef = React.useRef<HTMLInputElement>(null);
  const rowEls = React.useRef(new Map<string, HTMLElement>());
  const registerRow = React.useCallback((id: string, el: HTMLElement | null) => {
    if (el) rowEls.current.set(id, el);
    else rowEls.current.delete(id);
  }, []);

  // Demo identity: entering, leaving or resetting Demo Mode reads afresh (the server
  // answers a cursor from another Demo run with 409, D11). Only a confirmed identity
  // replaced by another counts: the first answer of `/api/demo/status` is no change (the
  // read already reflects the server's Demo state), and the unconfirmed stand-in of a
  // failed status read is never a change either.
  const confirmedDemo = demo.confirmed === false ? null : demo.active ? `demo:${demo.status.run_id ?? ''}` : 'off';
  const demoRef = React.useRef<string | null>(null);
  const demoEpochRef = React.useRef(0);
  if (confirmedDemo !== null) {
    if (demoRef.current !== null && confirmedDemo !== demoRef.current) demoEpochRef.current += 1;
    demoRef.current = confirmedDemo;
  }
  const demoEpoch = demoEpochRef.current;

  // `readId` names the rows a read answers; `key` adds the Refresh count, so a Refresh
  // reads again while the rows of the same read stay on screen (and stay there, under
  // the error, when that read fails, SPEC §4.5.7).
  const readId = `${readKey(view, local, order)}|${demoEpoch}`;
  const key = `${readId}|${nonce}`;
  const readIdRef = React.useRef(readId);
  readIdRef.current = readId;
  // The load whose rows are on screen, set when they land (not at render), and whether a
  // read of the list is in flight (its rows will replace them): a page of Load more
  // lands only on the rows its cursor came from.
  const shownLoadRef = React.useRef<string | null>(null);
  const readingRef = React.useRef(true);
  const pagingRef = React.useRef(false);

  /* ------------------------------------------------------------------ loading -- */

  React.useEffect(() => {
    const controller = new AbortController();
    readingRef.current = true;
    setLoading(true);
    setError(null);
    setOpenRuns(new Set());
    void (async () => {
      try {
        const page: AuditPage = await listAuditPage(pageQuery(view, local, order), controller.signal);
        if (controller.signal.aborted) return;
        shownLoadRef.current = key;
        setList({
          records: page.records ?? [],
          nextCursor: page.next_cursor ?? null,
          total: page.total ?? 0,
          relation: page.total_relation ?? 'eq',
          runTotals: page.run_totals ?? {},
          retention: page.retention ?? null,
          key,
          readId,
        });
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e);
      } finally {
        if (!controller.signal.aborted) {
          readingRef.current = false;
          setLoading(false);
        }
      }
    })();
    return () => controller.abort();
    // `key` names every input of the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The next page of the rows on screen. Paging continues from them while they answer
  // this read, also under the error of a Refresh that failed (their cursor still holds),
  // and never while a read is in flight, whose rows replace them; the controls say so by
  // being disabled (`canPage`). A page that returns after a newer load never lands.
  const loadMore = React.useCallback(async (): Promise<boolean> => {
    const cursor = list.nextCursor;
    const forLoad = list.key;
    if (!cursor || !forLoad || pagingRef.current || readingRef.current) return false;
    if (list.readId !== readIdRef.current || shownLoadRef.current !== forLoad) return false;
    const stillShown = () => !readingRef.current && shownLoadRef.current === forLoad;
    pagingRef.current = true;
    setLoadingMore(true);
    try {
      const page = await listAuditPage(pageQuery(view, local, order, cursor));
      if (!stillShown()) return false;
      const records = page.records ?? [];
      setList((prev) =>
        prev.key !== forLoad || prev.nextCursor !== cursor
          ? prev
          : {
              ...prev,
              records: [...prev.records, ...records],
              nextCursor: page.next_cursor ?? null,
              total: page.total ?? prev.total,
              relation: page.total_relation ?? prev.relation,
              runTotals: { ...prev.runTotals, ...(page.run_totals ?? {}) },
              retention: page.retention ?? prev.retention,
            },
      );
      return records.length > 0;
    } catch (e) {
      if (!stillShown()) return false;
      if (errorCode(e) === 'audit_cursor_expired') {
        const detail = (e as ApiError).body as { detail?: { message?: unknown } } | undefined;
        const message = typeof detail?.detail?.message === 'string' && detail.detail.message.trim() ? detail.detail.message : EXPIRED_COPY;
        toast.info(message);
        setNonce((n) => n + 1);
      } else {
        toast.error('More events could not be loaded.', { description: e instanceof Error ? e.message : undefined });
      }
      return false;
    } finally {
      pagingRef.current = false;
      setLoadingMore(false);
    }
  }, [list.nextCursor, list.key, list.readId, view, local, order]);

  /* ---------------------------------------------------------------- the view -- */

  const applyView = React.useCallback(
    (patch: ViewPatch, localPatch?: LocalPatch) => {
      if (localPatch) setLocal((prev) => ({ ...prev, ...localPatch }));
      const keys = Object.keys(patch) as Array<keyof AuditView>;
      if (keys.length === 0 || keys.every((k) => patch[k] === view[k])) return;
      navigate('audit', optsFromView({ ...view, ...patch }));
    },
    [navigate, view],
  );

  const clearAll = React.useCallback(() => {
    setLocal(EMPTY_LOCAL_FILTERS);
    navigate('audit', optsFromView(clearedView(view)));
  }, [navigate, view]);

  const changeZone = (next: AuditTimeZone) => {
    setZone(next);
    writeZone(next);
  };

  /* --------------------------------------------------------------- the records -- */

  const rowsReady = list.key === key;
  // The rows on screen answer this read (perhaps from before a Refresh that is loading
  // or that failed); otherwise they belong to the previous view.
  const sameRead = list.readId === readId;
  // Load more (the foot button, an investigation's row, Next and J past the last row)
  // runs while the rows answer this read and no read is in flight.
  const canPage = Boolean(list.nextCursor) && sameRead && !loading;
  // While a new read loads, the rows of the last one stay (dimmed), as on a refresh.
  const records = list.records;
  const items = React.useMemo(
    () => buildListItems(records, view.scope, list.runTotals, openRuns),
    [records, view.scope, list.runTotals, openRuns],
  );
  /** The records J and K walk, in list order (an investigation's steps when it is open). */
  const walk = React.useMemo(() => items.flatMap((i) => (i.kind === 'row' ? [i.record] : [])), [items]);
  const selectedIndex = selectedId ? walk.findIndex((r) => r.record_id === selectedId) : -1;
  const listed = selectedIndex >= 0 ? walk[selectedIndex] : records.find((r) => r.record_id === selectedId) ?? null;

  // A deep link to a record the loaded rows do not hold: read it on its own, with the
  // page's filters so the open joins the list read's view row (D8). A read that is
  // aborted (a Refresh, a Demo change, the list taking over) leaves no placeholder
  // behind, so the next pass reads again instead of waiting on it for good.
  const [fetched, setFetched] = React.useState<FetchedRecord | null>(null);
  const [recordRetry, setRecordRetry] = React.useState(0);
  React.useEffect(() => {
    if (!selectedId || listed || loading) return undefined;
    if (fetched?.id === selectedId && !fetched.loading) return undefined;
    const id = selectedId;
    const controller = new AbortController();
    setFetched({ id, record: null, notFound: false, failed: false, loading: true });
    const { cursor: _cursor, order: _order, limit: _limit, ...filters } = pageQuery(view, local, order);
    void getAuditRecord(id, filters, controller.signal)
      .then((record) => {
        if (!controller.signal.aborted) setFetched({ id, record, notFound: false, failed: false, loading: false });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        const missing = errorCode(e) === 'audit_record_not_found' || (e instanceof ApiError && e.status === 404);
        setFetched({ id, record: null, notFound: missing, failed: !missing, loading: false });
        if (!missing) toast.error('The record could not be loaded.', { description: e instanceof Error ? e.message : undefined });
      });
    return () => {
      controller.abort();
      setFetched((f) => (f && f.id === id && f.loading ? null : f));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, listed, loading, recordRetry]);

  const fetchedHere = fetched && fetched.id === selectedId ? fetched : null;
  const shown = listed ?? fetchedHere?.record ?? null;
  const inspectorOpen = Boolean(selectedId);
  const retryRecord = React.useCallback(() => {
    setFetched(null);
    setRecordRetry((n) => n + 1);
  }, []);

  const select = React.useCallback(
    (id: string | null) => {
      setLocalRecord(id);
      replaceHash(pageHash('audit', optsFromView(view, id)));
    },
    [view],
  );

  const openRecord = React.useCallback(
    (record: AuditRecord, via: OpenVia) => {
      focusTitleRef.current = via !== 'key';
      select(record.record_id);
      if (via !== 'key' && inspectorOpen && !phone) {
        // The sheet is already open: hand focus to its title (a click or Enter).
        window.requestAnimationFrame(() => document.getElementById(INSPECTOR_TITLE_ID)?.focus());
      }
    },
    [select, inspectorOpen, phone],
  );

  // J and K from the inspector (or the page): the next or previous record, loading the
  // next page at the end of the list. When that page lands (`settled`) without a record
  // the walk can reach (its rows folded into an investigation already listed), the step
  // ends there, so the next J asks for the page after it.
  const pendingStepRef = React.useRef<{ settled: boolean } | null>(null);
  const [stepTick, setStepTick] = React.useState(0);
  const step = React.useCallback(
    (dir: 1 | -1) => {
      if (!walk.length) return;
      const at = selectedIndex;
      const next = walk[at < 0 ? (dir === 1 ? 0 : walk.length - 1) : at + dir];
      if (next) {
        focusTitleRef.current = false;
        select(next.record_id);
        return;
      }
      if (dir === 1 && canPage && !pendingStepRef.current) {
        const pending = { settled: false };
        pendingStepRef.current = pending;
        void loadMore().then((added) => {
          if (pendingStepRef.current !== pending) return;
          if (!added) {
            pendingStepRef.current = null;
            return;
          }
          pending.settled = true;
          setStepTick((t) => t + 1);
        });
      }
    },
    [walk, selectedIndex, select, canPage, loadMore],
  );
  React.useEffect(() => {
    const pending = pendingStepRef.current;
    if (!pending) return;
    const next = walk[selectedIndex + 1];
    if (!next) {
      if (pending.settled) pendingStepRef.current = null;
      return;
    }
    pendingStepRef.current = null;
    select(next.record_id);
  }, [walk, selectedIndex, select, stepTick]);

  const close = React.useCallback(() => select(null), [select]);

  // A record named inside the inspector (the failure row of a write that was not
  // applied): show it and hand focus to the title, as a click on its row would.
  const showRecord = React.useCallback(
    (id: string) => {
      focusTitleRef.current = true;
      select(id);
      window.requestAnimationFrame(() => document.getElementById(INSPECTOR_TITLE_ID)?.focus());
    },
    [select],
  );
  // A Related link is a fresh question about the record: the in-memory filters (actor
  // kind, source, surface) would narrow it silently, so they go with it.
  const followRelated = React.useCallback(() => setLocal(EMPTY_LOCAL_FILTERS), []);

  // A polite announcement for each record shown ("Role changed, 25 Oct 15:09, record 3 of 50").
  React.useEffect(() => {
    if (!shown) return;
    const ms = timeOf(shown.ts);
    const where = selectedIndex >= 0 ? `, record ${selectedIndex + 1} of ${walk.length}` : '';
    setLiveMessage(`${shown.event_label}${ms !== null ? `, ${formatMinute(ms, zone)}` : ''}${where}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.record_id]);

  const onInspectorCloseAutoFocus = React.useCallback(
    (event: Event) => {
      event.preventDefault();
      const id = lastShownRef.current;
      const record = id ? records.find((r) => r.record_id === id) : null;
      const target =
        (id && rowEls.current.get(id)) ||
        (record?.run_id ? rowEls.current.get(`group:${record.run_id}`) : null) ||
        searchRef.current;
      target?.focus();
    },
    [records],
  );

  const relatedOpts = React.useCallback(
    (kind: RelatedKind) => {
      const r = shown;
      if (!r) return null;
      const ms = timeOf(r.ts);
      if (kind === 'actor-window' && ms !== null && r.actor) {
        return optsFromView({
          ...clearedView(view),
          scope: 'all',
          actor: r.actor,
          from: isoSecond(ms - 15 * 60_000),
          to: isoSecond(ms + 15 * 60_000 + 1000),
        });
      }
      if (kind === 'target' && r.target?.id && /^[\w.:-]{1,128}$/.test(r.target.id)) {
        return optsFromView({ ...clearedView(view), scope: 'all', target: r.target.id });
      }
      if (kind === 'case' && r.case_id && /^[\w.:-]{1,128}$/.test(r.case_id)) {
        return optsFromView({ ...clearedView(view), scope: 'all', caseId: r.case_id });
      }
      if (kind === 'session-sign-in' && ms !== null && r.actor) {
        return optsFromView({
          ...clearedView(view),
          scope: 'people',
          actor: r.actor,
          event: 'auth.login',
          from: isoSecond(ms - 30 * 86_400_000),
          to: isoSecond(ms + 1000),
        });
      }
      return null;
    },
    [shown, view],
  );

  /* ---------------------------------------------------------------- shortcuts -- */

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!shortcutTarget(event)) return;
      const target = event.target as HTMLElement | null;
      const inList = Boolean(target?.closest?.('[data-audit-list]'));
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === '?') {
        event.preventDefault();
        const active = document.activeElement;
        shortcutsReturnRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
        setShortcutsOpen(true);
      } else if ((event.key === 'j' || event.key === 'J' || event.key === 'k' || event.key === 'K') && inspectorOpen && !inList) {
        event.preventDefault();
        step(event.key.toLowerCase() === 'j' ? 1 : -1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inspectorOpen, step]);

  /* -------------------------------------------------------------------- render -- */

  const filters = activeFilterCount(view, local);
  const caseLabels = React.useMemo(() => caseLabelsOf(records), [records]);
  const chips = filterChips(view, local, caseLabels);
  const loadedCount = records.length;
  const retention = retentionText(list.retention);
  const nowMs = Date.now();
  const firstLoad = loading && list.key === null;
  const stale = loading && !firstLoad;
  const wider = !view.to ? WIDER_RANGE[view.from] : undefined;

  const exportReason = demo.active
    ? 'Audit exports are not available in Demo Mode.'
    : error
      ? 'The audit log could not be loaded.'
      : !rowsReady || firstLoad
        ? 'The audit log is still loading.'
        : list.total === 0
          ? 'Nothing to export in this view'
          : null;

  const scopeLine = sameRead && !error && list.total > 0 ? (
    <div
      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm text-muted-foreground"
      data-testid="audit-scope-line"
    >
      <p className="tabular-nums">
        Showing <span className="text-foreground">1 to {loadedCount.toLocaleString()}</span> of{' '}
        <span className="font-medium text-foreground">
          {list.relation === 'gte' ? `at least ${list.total.toLocaleString()}` : list.total.toLocaleString()}
        </span>{' '}
        {list.total === 1 && list.relation === 'eq' ? 'event' : 'events'} · {rangePhrase(view, nowMs)} · times in{' '}
        {zone === 'utc' ? 'UTC' : 'local time'} · {order === 'desc' ? 'newest first' : 'oldest first'}
      </p>
      {retention ? <p className="text-xs">{retention}</p> : null}
    </div>
  ) : null;

  const headerControls = (
    <div className="flex flex-wrap items-center gap-2">
      <TimeRangePicker
        size="sm"
        value={{ from: view.from, to: view.to ?? 'now', label: rangeLabel(view, nowMs) }}
        presets={AUDIT_RANGES}
        onChange={(range) => applyView({ from: range.from, to: range.to === 'now' ? null : range.to })}
      />
      <AuditCustomRange view={view} onApply={(range) => applyView({ from: range.from, to: range.to })} />
      <RefreshButton
        display="icon"
        label="Refresh the audit log"
        refreshing={loading}
        onClick={() => setNonce((n) => n + 1)}
      />
    </div>
  );

  const headerActions = (
    <div className="flex items-center gap-2">
      {canExport ? (
        <AuditExportMenu
          ref={exportTriggerRef}
          disabledReason={exportReason}
          showFullExport={canFullExport}
          onPick={(format) => {
            setExportFormat(format);
            setExportOpen(true);
          }}
          onOpenFullExport={() => navigate('settings', { section: 'data_export' })}
        />
      ) : null}
      {/* A Radix trigger, so Esc hands focus back to it; `?` opens the same dialog. */}
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Keyboard shortcuts"
            aria-keyshortcuts="?"
            onClick={() => {
              shortcutsReturnRef.current = null;
            }}
          >
            <Keyboard className="size-4" aria-hidden />
          </Button>
        </DialogTrigger>
        <DialogContent
          className="max-w-lg"
          onCloseAutoFocus={(event) => {
            const back = shortcutsReturnRef.current;
            shortcutsReturnRef.current = null;
            if (back && back.isConnected) {
              event.preventDefault();
              back.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>Shortcuts work when focus is not in a text field, a menu or a dialog.</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            {SHORTCUTS.map((row) => (
              <React.Fragment key={row.keys}>
                <dt className="font-mono text-xs text-foreground">{row.keys}</dt>
                <dd className="text-muted-foreground">{row.action}</dd>
              </React.Fragment>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </div>
  );

  const loadError = error ? (
    <LoadError
      error={error}
      title="The audit log could not be loaded."
      fallback="Try again in a moment."
      onRetry={() => setNonce((n) => n + 1)}
    />
  ) : null;

  let body: React.ReactNode;
  if (firstLoad) {
    body = <LoadingState label="Loading the audit log" layout="table" shape="rows" shapeRows={8} />;
  } else if (error && !sameRead) {
    // The rows on screen belong to another view: never show them under this one.
    body = loadError;
  } else if (sameRead && list.total === 0 && records.length === 0) {
    const when = view.to ? 'in this time range' : `in the ${rangePhrase(view, nowMs)}`;
    body = (
      <>
        {loadError}
        <Panel as="div" className="py-10">
          {filters > 0 ? (
            <EmptyState
              compact
              state="no-results"
              icon={ScrollText}
              title="No events match these filters."
              action={
                <Button variant="outline" size="sm" onClick={clearAll}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              compact
              state="no-data"
              icon={ScrollText}
              title={noEventsTitle(view.scope, when)}
              action={
                wider || view.scope !== 'all' ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    {wider ? (
                      <Button variant="outline" size="sm" onClick={() => applyView({ from: wider, to: null })}>
                        Show the {AUDIT_RANGES.find((r) => r.from === wider)?.label.toLowerCase() ?? 'wider range'}
                      </Button>
                    ) : null}
                    {view.scope !== 'all' ? (
                      <Button variant="outline" size="sm" onClick={() => applyView({ scope: 'all' })}>
                        Show all scopes
                      </Button>
                    ) : null}
                  </div>
                ) : undefined
              }
            />
          )}
        </Panel>
      </>
    );
  } else {
    body = (
      <>
        {loadError}
        <Panel as="div" padding="none" aria-busy={stale || undefined} className={cn(stale && 'opacity-70')}>
          <AuditTable
            items={items}
            layout={layout}
            zone={zone}
            onZoneChange={changeZone}
            order={order}
            onOrderChange={setOrder}
            selectedId={selectedId}
            onOpen={openRecord}
            onToggleGroup={(runId) =>
              setOpenRuns((prev) => {
                const next = new Set(prev);
                if (next.has(runId)) next.delete(runId);
                else next.add(runId);
                return next;
              })
            }
            hasMore={Boolean(list.nextCursor)}
            canLoadMore={canPage}
            onLoadMore={loadMore}
            canOpenCase={canOpenCase}
            registerRow={registerRow}
          />
        </Panel>
        {list.nextCursor ? (
          <div className="flex flex-col items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore || !canPage}>
              {loadingMore ? 'Loading' : 'Load more'}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  // A fragment: the header, the band, the notes, the scope line, the panel and Load more
  // are direct children of PageContainer, which owns the page rhythm (SPEC §4.9.2).
  return (
    <>
      <PageHeader title="Audit log" help={PAGE_HELP} controls={headerControls} actions={headerActions} />

      <AuditControlBand
        view={view}
        local={local}
        phone={phone}
        onChange={applyView}
        onClearAll={clearAll}
        knownActors={loadedActors(records)}
        caseLabels={caseLabels}
        searchRef={searchRef}
      />

      {list.retention?.volatile ? (
        <Callout intent="warning">This deployment keeps the audit log in memory; it is lost on restart.</Callout>
      ) : null}
      {demo.active ? (
        <p className="text-sm text-muted-foreground" data-testid="audit-demo-note">
          Demo Mode: agent activity is demo data; sign-ins and settings changes are real.
        </p>
      ) : null}
      {scopeLine}

      {body}

      <AuditInspector
        open={inspectorOpen}
        modal={!wide}
        phone={phone}
        record={shown}
        loading={Boolean(selectedId && !shown && !(fetchedHere && !fetchedHere.loading))}
        notFound={Boolean(selectedId && !shown && fetchedHere?.notFound)}
        failed={Boolean(selectedId && !shown && fetchedHere?.failed)}
        onRetry={retryRecord}
        position={selectedIndex >= 0 ? { index: selectedIndex + 1, count: walk.length } : null}
        notAppliedBy={shown ? notAppliedPair(shown, records, order) : null}
        onShowRecord={showRecord}
        onFollowRelated={followRelated}
        focusTitleOnOpen={focusTitleRef.current}
        canPrev={selectedIndex > 0}
        canNext={selectedIndex >= 0 && (selectedIndex < walk.length - 1 || canPage)}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onClose={close}
        onCloseAutoFocus={onInspectorCloseAutoFocus}
        shareHref={
          selectedId ? `${window.location.origin}${window.location.pathname}${pageHash('audit', optsFromView(view, selectedId))}` : ''
        }
        relatedOpts={relatedOpts}
        canOpenCase={canOpenCase}
        canOpenSource={canOpenSource}
        announce={setLiveMessage}
      />

      {canExport ? (
        <AuditExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          format={exportFormat}
          onFormatChange={setExportFormat}
          view={view}
          local={local}
          filterWords={chips.map((c) => c.label)}
          onOpenJobs={() => navigate('batchjobs')}
          returnFocusRef={exportTriggerRef}
        />
      ) : null}

      <div aria-live="polite" role="status" className="sr-only" data-testid="audit-live">
        {liveMessage}
      </div>
    </>
  );
}

/** Page-level guard: only `audit:view` principals can read the audit log. */
export default function Audit({ onNavigate }: AuditProps) {
  return (
    <ProtectedRoute resource="audit" action="view" fallback={<Unauthorized message="You do not have access to the audit log." />}>
      <PageContainer variant="wide">
        <AuditLog onNavigate={onNavigate} />
      </PageContainer>
    </ProtectedRoute>
  );
}
