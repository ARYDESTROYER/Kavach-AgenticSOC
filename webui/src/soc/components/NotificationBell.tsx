/**
 * NotificationBell — the top-bar in-app notification indicator (Round-3 Stage 2).
 *
 * A self-contained bell button that:
 *   - polls GET /api/notifications/inbox/unread-count on an interval and shows a
 *     dot + numeric unread badge (capped "9+") when there are unseen items;
 *   - opens a Radix Popover dropdown listing the most recent inbox items
 *     (GET /api/notifications/inbox), each rendered as PLAIN text;
 *   - offers "Mark all read" (POST …/read-all) and a "View all" link that routes to
 *     the in-app Inbox page (PageId 'inbox') — NOT to any item's source-controlled
 *     `url` (#9: never follow attacker-influenceable hrefs);
 *   - pins the shell-derived Agent-health degradations above the inbox list (Round-12),
 *     replacing the Cyber Defence Center's dashboard warning strip. The bell does NOT
 *     fetch them: the shell owns the hook and passes the result down, so the bell stays
 *     provider-free and no new backend call or permission is introduced.
 *
 * SECURITY (#9): item `title`/`body`/`category`/`severity` originate from
 * cases/sources/operator text and are UNTRUSTED — they are rendered as plain text,
 * never as markup, and no value is ever placed in an `href`/`src`.
 *
 * ACCESSIBILITY: the trigger is a labelled button announcing the unread count via
 * `aria-label`; the badge is `aria-hidden` (the label carries the count). The poll
 * pauses on `document.hidden` to avoid background churn.
 *
 * LIVE (Wave 4): polling is isolated in `useUnreadCount`, which additively layers the
 * `useEventStream` SSE hook on top. When realtime is enabled the bell refreshes its
 * unread count the moment an `inapp` frame arrives and SLOWS its poll (it does not
 * stop it) while the stream is healthy; when realtime is disabled the endpoint 204s
 * and the bell keeps polling at the normal cadence — today's behaviour, unchanged.
 */
import * as React from 'react';
import { useEventStream } from '@/lib/useEventStream';
import {
  Bell,
  CheckCheck,
  Inbox as InboxIcon,
  AlertTriangle,
  ArrowRight,
  LoaderCircle,
} from 'lucide-react';
import { Button } from '@/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { ScrollArea } from '@/ui/scroll-area';
import { Separator } from '@/ui/separator';
import { Progress } from '@/ui/progress';
import { cn } from '@/lib/cn';
import { humanizeAge, humanizeToken } from '@/lib/format';
import { ApiError } from '@/lib/api';
import { LoadingState } from '@/design-system';
import { semanticIcon, type SeverityKey } from './palette';
// TYPE-ONLY (elided at build): importing the VALUE side of health-diagnostics-state would
// drag `useCan` -> `useAuth` into the bell, and the bell is rendered provider-free by its
// own specs. The shell owns the hook; the bell only receives its result.
import type { HealthDegradation } from './health-diagnostics-state';
import type { Navigate } from '../router';

/** Stable empty default so a bell with no degradations never re-renders on identity. */
const EMPTY_DEGRADATIONS: HealthDegradation[] = [];
import { isActiveJobStatus, JOBS_CHANGED_EVENT } from '../jobs/jobs';
import {
  fetchActiveJobCount,
  fetchInbox,
  fetchUnreadCount,
  markAllRead,
  type InboxItem,
} from './NotificationBell.api';

/** Poll cadence for the unread count (ms). The dropdown refetches on open. */
const POLL_MS = 30000;
/**
 * Slow-poll cadence (ms) used as a SAFETY NET while a live SSE stream is healthy —
 * frames drive the refresh, but we still re-sync occasionally in case a frame was
 * dropped from the bus's bounded ring. Polling is never fully stopped (graceful
 * degradation if the stream silently dies between heartbeats).
 */
const POLL_MS_LIVE = 120000;
/** How many recent items the dropdown shows. */
const RECENT_LIMIT = 8;
/**
 * SSE topics the bell listens on: in-app notifications (`notifications`/`inapp` from
 * the dispatcher) and case-mention nudges (`inbox`/`inapp` from collaboration). Both
 * deliver the `inapp` event channel; any frame on either topic triggers a re-sync.
 */
const BELL_TOPICS = ['notifications', 'inbox', 'jobs'];

/**
 * Poll the unread count. Pauses while the tab is hidden; refetches immediately when
 * it becomes visible again. A 401/auth-off backend simply yields 0 (the bell stays
 * quiet) — never throws into the shell.
 *
 * Live layer (additive): subscribes to the `inapp` SSE channel via `useEventStream`.
 * When the stream is healthy (`live`) the bell refreshes on every frame and drops to
 * a slow safety-net poll; when realtime is disabled/unavailable it polls normally.
 */
function useUnreadCount(onNudge?: () => void): {
  unread: number;
  activeJobs: number;
  refresh: () => void;
} {
  const [unread, setUnread] = React.useState(0);
  const [activeJobs, setActiveJobs] = React.useState(0);
  const seqRef = React.useRef(0);
  const refresh = React.useCallback(() => {
    const seq = ++seqRef.current;
    void Promise.allSettled([fetchUnreadCount(), fetchActiveJobCount()]).then(
      ([unreadResult, activeResult]) => {
        if (seq !== seqRef.current) return;
        if (unreadResult.status === 'fulfilled') {
          setUnread(Math.max(0, unreadResult.value.unread | 0));
        } else if (unreadResult.reason instanceof ApiError) {
          setUnread(0);
        }
        if (activeResult.status === 'fulfilled') {
          setActiveJobs(Math.max(0, activeResult.value | 0));
        } else if (activeResult.reason instanceof ApiError) {
          setActiveJobs(0);
        }
      },
    );
  }, []);

  // Live updates: a fresh `inapp` frame means the unread count likely changed; refetch
  // the authoritative count (the frame is only a nudge — #9: we never render its body).
  const onEvent = React.useCallback(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    refresh();
    onNudge?.();
  }, [onNudge, refresh]);
  const { live } = useEventStream(BELL_TOPICS, { enabled: true, onEvent });

  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      if (!alive || (typeof document !== 'undefined' && document.hidden)) return;
      refresh();
    };
    tick();
    // Slow the poll to a safety-net cadence while a live stream drives refreshes.
    const t = window.setInterval(tick, live ? POLL_MS_LIVE : POLL_MS);
    const onVis = () => {
      if (typeof document !== 'undefined' && !document.hidden) tick();
    };
    document.addEventListener?.('visibilitychange', onVis);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener?.('visibilitychange', onVis);
    };
  }, [refresh, live]);

  return { unread, activeJobs, refresh };
}

/** Compact "9+" formatting for the numeric badge. */
function badgeText(n: number): string {
  if (n <= 0) return '';
  return n > 9 ? '9+' : String(n);
}

/**
 * Severity token → dot colour, keyed to the SEVERITY axis authority (palette
 * `SEVERITY_COLOR`) so a MEDIUM dot is gold (`bg-medium`), never brand-blue — and a
 * LOW dot (`bg-low`) is distinct from an untyped one. The classes are FULL literals
 * (not `bg-${…}`) so Tailwind's JIT scanner emits them. UNTRUSTED token, enum-matched.
 */
export const SEVERITY_DOT: Record<SeverityKey, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
};

export function severityDot(sev?: string | null): string {
  const key = (sev || '').toLowerCase();
  return SEVERITY_DOT[key as SeverityKey] ?? 'bg-muted-foreground/50';
}

/**
 * Severity token → AA standalone text color for the beside-color severity GLYPH
 * (mirrors SEVERITY_DOT). The `-text` variants are the theme-tuned AA colors on a
 * card surface, so the icon reads in both light and dark. Rendering the
 * `SEMANTIC_ICON` shape (not just a colored dot) is the WCAG 1.4.1 redundancy —
 * severity is no longer conveyed by color alone (colorblind-safe), and an sr-only
 * label announces it to assistive tech.
 */
export const SEVERITY_TEXT: Record<SeverityKey, string> = {
  critical: 'text-critical-text',
  high: 'text-high-text',
  medium: 'text-medium-text',
  low: 'text-low-text',
  info: 'text-info-text',
};

/** One row in the bell dropdown. All text is UNTRUSTED → rendered PLAIN. */
const InboxRow: React.FC<{ item: InboxItem }> = ({ item }) => {
  const unread = item.state === 'unseen' || item.state === 'seen';
  const activeJob = Boolean(item.job_id && isActiveJobStatus(item.job_status));
  const done = Math.max(0, Number(item.progress?.done || 0));
  const total = Math.max(0, Number(item.progress?.total || 0));
  const progress = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  // Severity: not color-only (WCAG 1.4.1). For a known severity we render the shared
  // SEMANTIC_ICON glyph (shape = colorblind-safe redundancy) tinted by the AA `-text`
  // token, plus an sr-only label so AT announces it; unknown severities keep the dot.
  const sevKey = (item.severity || '').toLowerCase();
  const sevColor = SEVERITY_TEXT[sevKey as SeverityKey];
  const SevIcon = sevColor ? semanticIcon(item.severity) : undefined;
  return (
    <li
      className={cn(
        'flex gap-2.5 rounded-md px-2 py-2 text-sm',
        unread ? 'bg-primary/[0.04]' : '',
      )}
    >
      {SevIcon ? (
        <>
          <SevIcon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', sevColor)} aria-hidden />
          <span className="sr-only">{sevKey} severity</span>
        </>
      ) : (
        <span
          className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', severityDot(item.severity))}
          aria-hidden
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          {/* UNTRUSTED title → plain text. */}
          <span className={cn('min-w-0 break-words', unread ? 'font-medium' : '')}>
            {item.title || 'Notification'}
          </span>
          <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
            {humanizeAge(item.created_at)}
          </span>
        </span>
        {/* UNTRUSTED body → plain text, clamped. */}
        {item.body ? (
          <span className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">
            {item.body}
          </span>
        ) : null}
        {item.job_id && item.progress ? (
          <span
            className="mt-1.5 block space-y-1"
            role={activeJob ? 'status' : undefined}
            aria-label={`${done} of ${total} ${item.progress.unit} complete`}
          >
            <span className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                {activeJob ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : null}
                {humanizeToken(item.job_status || 'completed')}
              </span>
              <span className="tabular-nums">{done.toLocaleString()} / {total.toLocaleString()}</span>
            </span>
            <Progress value={progress} className="h-1" />
          </span>
        ) : null}
      </span>
    </li>
  );
};

/**
 * One Agent-health degradation, rendered as a pinned row above the inbox.
 *
 * Shape-not-colour (see SEVERITY_TEXT above): the warning triangle plus an sr-only
 * severity word carry the state, so the row never depends on the tint alone. The
 * backend-supplied `label`/`detail` are UNTRUSTED (#9) and are rendered as PLAIN text
 * nodes — never into an `href`/`src`.
 */
const HealthRow: React.FC<{ signal: HealthDegradation }> = ({ signal }) => (
  <li className="flex min-w-0 items-start gap-2" data-testid={`health-degradation-${signal.id}`}>
    <AlertTriangle
      className={cn(
        'mt-0.5 size-3.5 shrink-0',
        signal.severity === 'critical' ? 'text-critical-text' : 'text-warning-text',
      )}
      aria-hidden
    />
    <span className="sr-only">{signal.severity === 'critical' ? 'Critical' : 'Warning'}: </span>
    <span className="min-w-0 flex-1">
      <span className="block text-xs font-medium text-foreground">{signal.label}</span>
      {signal.detail ? (
        <span className="mt-0.5 block text-2xs text-muted-foreground">{signal.detail}</span>
      ) : null}
    </span>
  </li>
);

export interface NotificationBellProps {
  /** Navigate to a page (the bell routes to the Inbox page id). */
  onNavigate: Navigate;
  className?: string;
  /**
   * Client-derived Agent-health degradations, hoisted into the SHELL so the bell stays
   * provider-free (it is rendered in isolation by its own specs, where `useAuth` — and
   * therefore the RBAC self-gate inside `useHealthDiagnosticsData` — would throw).
   * Degradations only: an unknown/unmeasured signal must never reach the badge.
   */
  healthDegradations?: HealthDegradation[];
}

/**
 * The mounted-once top-bar bell. Owns its own poll + dropdown state. Safe when auth
 * is off / the inbox is unavailable: it shows a clean, empty, quiet bell.
 *
 * AGENT HEALTH (Round-12): the Cyber Defence Center's degradation strip moved here, so a
 * healthy deployment spends ZERO dashboard pixels on it and a degraded one is visible from
 * every route rather than only from Overview. The section is PINNED outside the inbox
 * `ScrollArea` so a degradation can never scroll away behind the notification list, and the
 * trigger's `aria-label` carries the state because the badges are `aria-hidden`.
 */
export function NotificationBell({
  onNavigate,
  className,
  healthDegradations = EMPTY_DEGRADATIONS,
}: NotificationBellProps) {
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<InboxItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const recentSeqRef = React.useRef(0);

  const loadRecent = React.useCallback(() => {
    if (!open) return;
    const seq = ++recentSeqRef.current;
    setLoading(true);
    setFailed(false);
    void fetchInbox(RECENT_LIMIT)
      .then((r) => {
        if (seq !== recentSeqRef.current) return;
        setItems(Array.isArray(r.items) ? r.items : []);
      })
      .catch(() => {
        if (seq !== recentSeqRef.current) return;
        setFailed(true);
      })
      .finally(() => {
        if (seq !== recentSeqRef.current) return;
        setLoading(false);
      });
  }, [open]);

  const { unread, activeJobs, refresh } = useUnreadCount(loadRecent);

  React.useEffect(() => {
    if (open) loadRecent();
    else {
      recentSeqRef.current += 1;
      setLoading(false);
    }
  }, [loadRecent, open]);
  React.useEffect(() => () => {
    recentSeqRef.current += 1;
  }, []);
  React.useEffect(() => {
    const onJobsChanged = () => {
      refresh();
      loadRecent();
    };
    window.addEventListener(JOBS_CHANGED_EVENT, onJobsChanged);
    return () => window.removeEventListener(JOBS_CHANGED_EVENT, onJobsChanged);
  }, [loadRecent, refresh]);

  const onMarkAll = React.useCallback(() => {
    // Optimistic: clear the unread styling immediately, then persist + re-sync.
    setItems((prev) => prev.map((i) => ({ ...i, state: 'read' as const })));
    void markAllRead()
      .catch(() => undefined)
      .finally(() => refresh());
  }, [refresh]);

  const goInbox = React.useCallback(() => {
    setOpen(false);
    onNavigate('inbox');
  }, [onNavigate]);

  const goEffectiveness = React.useCallback(() => {
    setOpen(false);
    onNavigate('metrics', { tab: 'effectiveness' });
  }, [onNavigate]);

  const badge = badgeText(unread);
  const degraded = healthDegradations.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('relative h-8 w-8', className)}
          // Every badge below is `aria-hidden` (the label carries the state), so the
          // health marker MUST be spelled out here too — otherwise a screen-reader user
          // gets nothing at all for a safety state (WCAG 4.1.2).
          aria-label={
            `Notifications, ${unread > 0 ? `${unread} unread` : 'none unread'}, ${activeJobs} active job${activeJobs === 1 ? '' : 's'}${degraded ? ', agent health needs attention' : ''}`
          }
        >
          <Bell className="h-4 w-4" aria-hidden />
          {unread > 0 ? (
            <span
              className={cn(
                'absolute -right-0.5 -top-0.5 flex min-w-[15px] items-center justify-center rounded-full',
                'border border-surface bg-critical px-[3px] text-[9px] font-semibold leading-none text-critical-foreground',
                'h-[15px]',
              )}
              aria-hidden
            >
              {badge}
            </span>
          ) : null}
          {activeJobs > 0 ? (
            <span
              className="absolute -bottom-0.5 -left-0.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full border border-surface bg-info px-[3px] text-2xs font-semibold leading-none text-info-foreground"
              title={`${activeJobs} active background job${activeJobs === 1 ? '' : 's'}`}
              aria-hidden
            >
              {badgeText(activeJobs)}
            </span>
          ) : null}
          {/* Third trigger marker (unread = top-right, jobs = bottom-left, health =
              bottom-right). Same chip geometry as the jobs badge, warning tint, and a
              GLYPH rather than a count: the number of degraded signals is not a quantity
              an operator acts on. `aria-hidden` like its siblings — the trigger's
              `aria-label` above carries the state. */}
          {degraded ? (
            <span
              className="absolute -bottom-0.5 -right-0.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full border border-surface bg-warning px-[3px] text-2xs font-semibold leading-none text-warning-foreground"
              data-testid="notification-bell-health-marker"
              aria-hidden
            >
              <AlertTriangle className="size-2.5" />
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" sideOffset={8}>
        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Bell className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            Notifications
          </p>
          <button
            type="button"
            onClick={onMarkAll}
            disabled={unread === 0}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground',
              'transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            <CheckCheck className="h-3.5 w-3.5" aria-hidden />
            Mark all read
          </button>
        </div>
        <Separator />

        {/* PINNED — a sibling of the inbox scroller, never a child of it, so a degradation
            can never scroll away behind the notification list. The window is FIXED at 24h
            because the shell (unlike the old dashboard host) has no time range of its own,
            and the auto-close verdict this reads IS window-scoped — so the header states
            the window rather than implying the operator's current one. */}
        {degraded ? (
          <section
            aria-labelledby="notification-bell-health-title"
            data-testid="health-degradation-section"
            className="shrink-0 border-b border-warning/30 bg-warning/5 px-3 py-2"
          >
            <h3
              id="notification-bell-health-title"
              className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-warning-text"
            >
              <AlertTriangle className="size-3" aria-hidden />
              Agent health · last 24 hours
            </h3>
            <ul className="mt-1.5 space-y-1.5">
              {healthDegradations.map((signal) => (
                <HealthRow key={signal.id} signal={signal} />
              ))}
            </ul>
            {/* The one canonical drill-through, kept verbatim from the retired dashboard
                strip; it additionally closes the popover, as every other bell action does. */}
            <button
              type="button"
              onClick={goEffectiveness}
              className="mt-1.5 inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-warning-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              View effectiveness
              <ArrowRight className="size-3.5" aria-hidden />
            </button>
          </section>
        ) : null}

        <ScrollArea className="max-h-80">
          <div className="p-1.5">
            {loading ? (
              <LoadingState
                label="Loading notifications"
                layout="inline"
                className="w-full px-2 py-6"
              />
            ) : failed ? (
              <p className="flex items-center justify-center gap-1.5 px-2 py-6 text-center text-xs text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                Couldn’t load notifications
              </p>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 px-2 py-8 text-center">
                <InboxIcon className="h-6 w-6 text-muted-foreground/60" aria-hidden />
                <p className="text-xs text-muted-foreground">You’re all caught up</p>
              </div>
            ) : (
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <InboxRow key={item.id} item={item} />
                ))}
              </ul>
            )}
          </div>
        </ScrollArea>

        <Separator />
        <button
          type="button"
          onClick={goInbox}
          className={cn(
            'flex w-full items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-primary',
            'transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'rounded-b-lg',
          )}
        >
          <InboxIcon className="h-3.5 w-3.5" aria-hidden />
          View all notifications
        </button>
      </PopoverContent>
    </Popover>
  );
}

export default NotificationBell;
