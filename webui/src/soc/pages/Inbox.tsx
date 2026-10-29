/**
 * Inbox — the operator's in-app NOTIFICATION CENTER (Group 6 / Feature 8 / Round 3).
 *
 * A full page (route id `inbox`) over the per-user inbox served by
 * `backend/app/api/routes_inapp.py`. It is SELF-SCOPED server-side — a user only ever
 * sees their own inbox. Capabilities:
 *
 *   - a list of notifications, NEWEST first, with an "Unread only" filter + paging,
 *   - per-item mark-read + dismiss, plus mark-ALL-read and a per-category grouping
 *     toggle (group by category vs. a flat chronological feed),
 *   - a deep-link to the referenced case (in-app navigate, never the backend `url`),
 *   - a slide-over with the per-user NotificationPrefs (delivery routing matrix).
 *
 * Security: every `title`/`body`/`category` is UNTRUSTED, render-escaped plain data
 * (#9) — rendered as PLAIN TEXT, never markup, and the backend-supplied `url` is
 * NEVER used as an href (we route via the in-app `case_id`). No secrets (#10). The
 * inbox is advisory — it never feeds `decide()` (#3).
 */
import * as React from 'react';
import {
  ArrowRight,
  CheckCheck,
  Download,
  Inbox as InboxIcon,
  LoaderCircle,
  Settings2,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { useNavigateOptional, type Navigate } from '@/soc/router';
import { humanizeAge, humanizeToken } from '@/lib/format';
import { errorMessage } from '@/lib/errorMessage';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/useEventStream';
import { cn } from '@/lib/cn';
import { LoadingState, Panel, PANEL_GAP } from '@/design-system';
import {
  inboxApi,
  CATEGORY_META,
  NOTIFICATION_CATEGORIES,
  type InboxItem,
} from '@/soc/pages/Inbox.api';

import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SegmentedControl } from '@/soc/components/SegmentedControl';

import { Button } from '@/ui/button';
import { Badge, type BadgeProps } from '@/ui/badge';
import { Progress } from '@/ui/progress';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';

import { NotificationPrefs } from '@/soc/components/NotificationPrefs';
import {
  downloadJobArtifactById,
  isActiveJobStatus,
  JOBS_CHANGED_EVENT,
  jobDestinationForKind,
  jobDestinationFromUrl,
} from '@/soc/jobs/jobs';

/* ---------------------------------------------------------------- constants - */

const PAGE_SIZE = 50;
const POLL_MS = 15_000;
const POLL_MS_LIVE = 60_000;

type GroupMode = 'category' | 'feed';

/* ----------------------------------------------------------------- helpers -- */

function isUnread(item: InboxItem): boolean {
  return item.state === 'unseen' || item.state === 'seen';
}

/** Friendly label for a category (known → curated; unknown → humanised token). */
function categoryLabel(cat: string): string {
  return CATEGORY_META[cat]?.label ?? humanizeToken(cat);
}

/** A semantic badge variant for one severity (UNTRUSTED → mapped, never raw class). */
function severityVariant(sev?: string | null): BadgeProps['variant'] {
  switch ((sev || '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
    case 'moderate':
      return 'medium';
    case 'low':
      return 'low';
    case 'info':
    case 'informational':
      return 'info';
    default:
      return 'secondary';
  }
}

/** A category → badge variant (stable, calm; falls back to outline). */
function categoryVariant(cat: string): BadgeProps['variant'] {
  switch (cat) {
    case 'case_escalated':
      return 'high';
    case 'case_resolved':
      return 'success';
    case 'approval':
      return 'warning';
    case 'mention':
    case 'assignment':
      return 'info';
    default:
      return 'secondary';
  }
}

function jobStatusVariant(status?: string | null): BadgeProps['variant'] {
  switch (status) {
    case 'succeeded':
      return 'success';
    case 'partial':
      return 'warning';
    case 'failed':
      return 'critical';
    case 'cancelled':
      return 'secondary';
    default:
      return 'info';
  }
}

/* ------------------------------------------------------------- item row ----- */

const InboxRow: React.FC<{
  item: InboxItem;
  busy: boolean;
  onMarkRead: (item: InboxItem) => void;
  onDismiss: (item: InboxItem) => void;
  onOpenCase: (caseId: string) => void;
  onOpenResult: (item: InboxItem) => void;
  onCancelJob: (item: InboxItem) => void;
  onDownloadJob: (item: InboxItem) => void;
}> = ({
  item,
  busy,
  onMarkRead,
  onDismiss,
  onOpenCase,
  onOpenResult,
  onCancelJob,
  onDownloadJob,
}) => {
  const unread = isUnread(item);
  const relatedLlmBatch = item.ref?.kind === 'llm_batch' || item.result?.kind === 'llm_batch';
  const activeJob = Boolean(item.job_id && isActiveJobStatus(item.job_status));
  const resultDestination =
    jobDestinationFromUrl(item.url) ?? jobDestinationForKind(item.result?.kind);
  const done = Math.max(0, Number(item.progress?.done || 0));
  const total = Math.max(0, Number(item.progress?.total || 0));
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <li
      className={cn(
        'flex items-start gap-3 px-4 py-3.5 transition-colors',
        unread ? 'bg-primary/[0.04]' : 'bg-transparent',
      )}
    >
      {/* unread dot */}
      <span className="mt-1.5 flex w-2 shrink-0 justify-center" aria-hidden>
        {unread ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={categoryVariant(item.category)}>{categoryLabel(item.category)}</Badge>
          {item.severity ? (
            <Badge variant={severityVariant(item.severity)}>
              {/* UNTRUSTED severity → humanised plain text */}
              {humanizeToken(item.severity)}
            </Badge>
          ) : null}
          {item.job_id && item.job_status ? (
            <Badge variant={jobStatusVariant(item.job_status)}>
              {humanizeToken(item.job_status)}
            </Badge>
          ) : null}
          {unread ? <span className="text-xs font-medium text-primary">New</span> : null}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {humanizeAge(item.created_at)}
          </span>
        </div>

        {/* UNTRUSTED title/body → PLAIN TEXT, never markup (#9) */}
        <p
          className={cn(
            'break-words text-sm',
            unread ? 'font-semibold text-foreground' : 'font-medium text-foreground',
          )}
        >
          {item.title || '(no title)'}
        </p>
        {item.body ? (
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {item.body}
          </p>
        ) : null}

        {item.job_id && item.progress ? (
          <div
            className="space-y-1.5 pt-1"
            role={activeJob ? 'status' : undefined}
            aria-label={`${done} of ${total} ${item.progress.unit} complete`}
          >
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                {activeJob ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden /> : null}
                {relatedLlmBatch
                  ? activeJob
                    ? 'Related LLM Batch running'
                    : 'Related LLM Batch complete'
                  : activeJob
                    ? 'Running in the background'
                    : 'Background job complete'}
              </span>
              <span className="tabular-nums">
                {done.toLocaleString()} / {total.toLocaleString()} {item.progress.unit}
              </span>
            </div>
            <Progress value={percent} className="h-1.5" />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {item.case_id ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => onOpenCase(item.case_id as string)}
            >
              Open case
              <ArrowRight className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          {item.job_id && !activeJob && resultDestination ? (
            <Button variant="outline" size="sm" className="h-7" onClick={() => onOpenResult(item)}>
              View result
              <ArrowRight className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          {item.job_id && item.result?.artifact_id ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              disabled={busy}
              onClick={() => onDownloadJob(item)}
            >
              <Download className="size-3.5" aria-hidden />
              Download
            </Button>
          ) : null}
          {item.job_id && activeJob && !relatedLlmBatch ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              disabled={busy || item.job_status === 'cancelled'}
              onClick={() => onCancelJob(item)}
            >
              <Square className="size-3.5" aria-hidden />
              Cancel
            </Button>
          ) : null}
          {unread ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              disabled={busy}
              onClick={() => onMarkRead(item)}
            >
              <CheckCheck className="size-3.5" aria-hidden />
              Mark read
            </Button>
          ) : null}
          {!activeJob ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-muted-foreground hover:text-critical"
              disabled={busy}
              onClick={() => onDismiss(item)}
            >
              <Trash2 className="size-3.5" aria-hidden />
              Dismiss
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
};

/* ------------------------------------------------------------- group block -- */

/** One category of the "By category" view: a panel titled by the category. */
const GroupBlock: React.FC<{
  label: string;
  count: number;
  unread: number;
  children: React.ReactNode;
}> = ({ label, count, unread, children }) => (
  <Panel title={label} count={count} caption={unread > 0 ? `${unread} unread` : undefined} padding="none">
    <ul className="divide-y divide-border/70 border-t border-border/70">{children}</ul>
  </Panel>
);

/* -------------------------------------------------------------------- page -- */

export interface InboxProps {
  onNavigate?: Navigate;
}

export default function Inbox({ onNavigate }: InboxProps = {}) {
  // Coupling-A: prop wins (test); else resolve navigate from the router context.
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const [items, setItems] = React.useState<InboxItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const unreadOnlyRef = React.useRef(false);
  const [groupMode, setGroupMode] = React.useState<GroupMode>('feed');
  const [prefsOpen, setPrefsOpen] = React.useState(false);
  // ids with an in-flight per-row action (mark-read / dismiss) — disables their buttons.
  const [busyIds, setBusyIds] = React.useState<Set<string>>(() => new Set());

  // Monotonic request id + mounted flag: only the newest in-flight `load` may write
  // state, so a slow earlier response (e.g. after a fast Unread↔All toggle) — or a
  // resolve after unmount — can never clobber the current view with stale items.
  const seqRef = React.useRef(0);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = React.useCallback(
    async (opts?: { unread?: boolean }) => {
      const unread = opts?.unread ?? unreadOnlyRef.current;
      const seq = ++seqRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await inboxApi.list({ unread_only: unread, limit: PAGE_SIZE, offset: 0 });
        if (!mountedRef.current || seq !== seqRef.current) return; // superseded / unmounted
        setItems(res.items ?? []);
        setTotal(res.total ?? (res.items?.length ?? 0));
      } catch (e) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        setError(e);
      } finally {
        if (mountedRef.current && seq === seqRef.current) setLoading(false);
      }
    },
    [],
  );

  const onInboxEvent = React.useCallback(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void load();
  }, [load]);
  const { live } = useEventStream(['notifications', 'inbox', 'jobs'], {
    enabled: true,
    onEvent: onInboxEvent,
  });

  React.useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    };
    tick();
    const interval = window.setInterval(tick, live ? POLL_MS_LIVE : POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    const onJobsChanged = () => tick();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(JOBS_CHANGED_EVENT, onJobsChanged);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(JOBS_CHANGED_EVENT, onJobsChanged);
    };
  }, [live, load]);

  const setUnreadFilter = React.useCallback(
    (next: boolean) => {
      unreadOnlyRef.current = next;
      setUnreadOnly(next);
      void load({ unread: next });
    },
    [load],
  );

  const loadMore = React.useCallback(async () => {
    setLoadingMore(true);
    try {
      const res = await inboxApi.list({
        unread_only: unreadOnly,
        limit: PAGE_SIZE,
        offset: items.length,
      });
      setItems((prev) => [...prev, ...(res.items ?? [])]);
      setTotal(res.total ?? total);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not load more.'));
    } finally {
      setLoadingMore(false);
    }
  }, [items.length, unreadOnly, total]);

  const withBusy = React.useCallback(async (id: string, fn: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await fn();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const markRead = React.useCallback(
    (item: InboxItem) =>
      withBusy(item.id, async () => {
        try {
          const res = await inboxApi.markRead(item.id);
          if (!res.ok) {
            toast.error(res.detail || 'Could not mark read.');
            return;
          }
          // In the unread-only view a read item drops out; otherwise it stays + dims.
          setItems((prev) =>
            unreadOnly
              ? prev.filter((n) => n.id !== item.id)
              : prev.map((n) => (n.id === item.id ? { ...n, state: 'read' } : n)),
          );
          if (unreadOnly) setTotal((t) => Math.max(0, t - 1));
        } catch (e) {
          toast.error(errorMessage(e, 'Could not mark read.'));
        }
      }),
    [unreadOnly, withBusy],
  );

  const dismiss = React.useCallback(
    (item: InboxItem) =>
      withBusy(item.id, async () => {
        try {
          const res = await inboxApi.dismiss(item.id);
          if (!res.ok) {
            toast.error('Could not dismiss.');
            return;
          }
          setItems((prev) => prev.filter((n) => n.id !== item.id));
          setTotal((t) => Math.max(0, t - 1));
        } catch (e) {
          toast.error(errorMessage(e, 'Could not dismiss.'));
        }
      }),
    [withBusy],
  );

  const markAllRead = React.useCallback(async () => {
    try {
      const res = await inboxApi.markAllRead();
      toast.success(
        res.marked > 0
          ? `Marked ${res.marked} notification${res.marked === 1 ? '' : 's'} read.`
          : 'Nothing to mark.',
      );
      // Reflect locally without a full reload (drop in unread-only; dim otherwise).
      setItems((prev) =>
        unreadOnly ? [] : prev.map((n) => (isUnread(n) ? { ...n, state: 'read' } : n)),
      );
      if (unreadOnly) setTotal(0);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not mark all read.'));
    }
  }, [unreadOnly]);

  const openCase = React.useCallback(
    (caseId: string) => {
      navigate('cases', { caseId });
    },
    [navigate],
  );

  const openResult = React.useCallback(
    (item: InboxItem) => {
      const destination =
        jobDestinationFromUrl(item.url) ?? jobDestinationForKind(item.result?.kind);
      if (!destination) return;
      navigate(destination.page, destination.opts);
    },
    [navigate],
  );

  const cancelJob = React.useCallback(
    (item: InboxItem) => {
      if (!item.job_id) return;
      void withBusy(item.id, async () => {
        try {
          await api.jobs.cancel(item.job_id as string);
          toast.info('Cancellation requested. The job will stop at a safe checkpoint.');
          await load();
        } catch (e) {
          toast.error(errorMessage(e, 'Could not request cancellation.'));
        }
      });
    },
    [load, withBusy],
  );

  const downloadJob = React.useCallback(
    (item: InboxItem) => {
      if (!item.job_id || !item.result?.artifact_id) return;
      void withBusy(item.id, async () => {
        try {
          const filename = await downloadJobArtifactById(item.job_id as string, item.result?.kind);
          toast.success(`Downloaded ${filename}.`);
        } catch (e) {
          toast.error(errorMessage(e, 'Could not download the job artifact.'));
        }
      });
    },
    [withBusy],
  );

  /* ---- derived counts + grouping ---- */
  const unreadCount = React.useMemo(() => items.filter(isUnread).length, [items]);
  const hasMore = items.length < total;

  // If clearing (dismiss / mark-read) empties the loaded page while the server still
  // has more, pull the next page instead of falsely showing "your inbox is empty".
  // `autoLoadedRef` guards against a refetch loop if the server ever reports more
  // (`total`) but returns an empty page — we auto-load once, then wait for real items.
  const autoLoadedRef = React.useRef(false);
  React.useEffect(() => {
    if (loading || loadingMore) return;
    if (items.length === 0 && hasMore && !autoLoadedRef.current) {
      autoLoadedRef.current = true;
      void load();
    } else if (items.length > 0) {
      autoLoadedRef.current = false;
    }
  }, [loading, loadingMore, items.length, hasMore, load]);

  const grouped = React.useMemo(() => {
    const byCat = new Map<string, InboxItem[]>();
    for (const it of items) {
      const arr = byCat.get(it.category) ?? [];
      arr.push(it);
      byCat.set(it.category, arr);
    }
    // Deterministic order: known categories first (catalog order), then any extras.
    const order = [
      ...NOTIFICATION_CATEGORIES.filter((c) => byCat.has(c)),
      ...Array.from(byCat.keys()).filter((c) => !NOTIFICATION_CATEGORIES.includes(c)),
    ];
    return order.map((cat) => ({ cat, items: byCat.get(cat) ?? [] }));
  }, [items]);

  // The list's own view controls sit in its panel's title row (Round 14, C7); the page
  // header keeps the count, Refresh and the one page action (Preferences).
  const viewControls = (
    <div role="group" aria-label="Inbox controls" className="flex flex-wrap items-center gap-2">
      <SegmentedControl<'all' | 'unread'>
        aria-label="Show"
        size="sm"
        value={unreadOnly ? 'unread' : 'all'}
        onValueChange={(value) => setUnreadFilter(value === 'unread')}
        options={[
          { value: 'all', label: 'All' },
          { value: 'unread', label: 'Unread' },
        ]}
      />
      <SegmentedControl<GroupMode>
        aria-label="Group inbox"
        size="sm"
        value={groupMode}
        onValueChange={setGroupMode}
        options={[
          { value: 'feed', label: 'Feed' },
          { value: 'category', label: 'By category' },
        ]}
      />
      <Button variant="outline" size="sm" onClick={() => void markAllRead()} disabled={total === 0}>
        <CheckCheck className="size-4" aria-hidden />
        Mark all read
      </Button>
    </div>
  );

  const rows = (list: InboxItem[]) =>
    list.map((item) => (
      <InboxRow
        key={item.id}
        item={item}
        busy={busyIds.has(item.id)}
        onMarkRead={markRead}
        onDismiss={dismiss}
        onOpenCase={openCase}
        onOpenResult={openResult}
        onCancelJob={cancelJob}
        onDownloadJob={downloadJob}
      />
    ));

  return (
    <PageContainer variant="wide">
      <PageHeader
        title="Inbox"
        help="Your in-app notifications about case events, mentions, assignments, approvals and background jobs, shown as plain text. Choose other delivery channels in Preferences."
        controls={
          <>
            <span className="text-sm tabular-nums text-muted-foreground" data-testid="inbox-count">
              {`${unreadCount.toLocaleString()} unread · ${total.toLocaleString()} total`}
            </span>
            <RefreshButton display="icon" label="Refresh inbox" onClick={() => void load()} refreshing={loading} />
          </>
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => setPrefsOpen(true)}>
            <Settings2 className="size-4" aria-hidden />
            Preferences
          </Button>
        }
      />

      {error ? (
        <LoadError
          error={error}
          title="Could not load your inbox"
          fallback="Request failed."
          onRetry={() => void load()}
        />
      ) : null}

      {/* The blocking loader only appears on the FIRST load (no items yet). Refresh and
          filter reloads keep the current list on screen (stale-while-revalidate), with the
          header Refresh's own spinner signalling the in-flight fetch. */}
      {error && items.length === 0 ? null : loading && items.length === 0 ? (
        <LoadingState
          label="Loading inbox"
          description="Preparing notifications, assignments, and approvals."
          layout="page"
          shape="rows"
          shapeRows={5}
        />
      ) : groupMode === 'category' && items.length > 0 ? (
        <div className={cn('flex flex-col', PANEL_GAP)}>
          <div className="flex justify-end">{viewControls}</div>
          {grouped.map(({ cat, items: groupItems }) => (
            <GroupBlock
              key={cat}
              label={categoryLabel(cat)}
              count={groupItems.length}
              unread={groupItems.filter(isUnread).length}
            >
              {rows(groupItems)}
            </GroupBlock>
          ))}
        </div>
      ) : (
        <Panel title="Notifications" padding="none" actions={viewControls} data-testid="inbox-panel">
          {items.length === 0 && !hasMore ? (
            <div className="px-4 pb-4 xl:px-5 3xl:px-6">
              <EmptyState
                compact
                icon={InboxIcon}
                title={unreadOnly ? 'No unread notifications' : 'Your inbox is empty'}
                description={
                  unreadOnly
                    ? 'You are all caught up. Choose All to see read notifications.'
                    : 'Notifications about cases, mentions, assignments and approvals will appear here.'
                }
                action={
                  unreadOnly ? (
                    <Button variant="outline" size="sm" onClick={() => setUnreadFilter(false)}>
                      <X className="size-4" aria-hidden />
                      Show all
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : items.length === 0 ? (
            // Page cleared but more exist server-side: the effect above is fetching them.
            <p className="flex items-center justify-center gap-2 px-4 pb-6 pt-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
              Loading more…
            </p>
          ) : (
            <ul className="divide-y divide-border/70 border-t border-border/70">{rows(items)}</ul>
          )}
        </Panel>
      )}

      {/* paging + footer counts */}
      {!loading && items.length > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Showing {items.length.toLocaleString()} of {total.toLocaleString()} · {unreadCount.toLocaleString()} unread on
            this page
          </p>
          {hasMore ? (
            <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
              Load more
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* preferences slide-over */}
      <Sheet open={prefsOpen} onOpenChange={setPrefsOpen}>
        {/* Header (with the built-in close X) stays pinned; only the inner body
            scrolls — never overflow-y-auto on SheetContent itself or the absolute X
            scrolls away (#19). */}
        <SheetContent side="right" size="lg" className="flex flex-col">
          <SheetHeader>
            <SheetTitle>Notification preferences</SheetTitle>
            <SheetDescription>
              Choose how each kind of notification reaches you across channels.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <NotificationPrefs />
          </div>
        </SheetContent>
      </Sheet>
    </PageContainer>
  );
}
