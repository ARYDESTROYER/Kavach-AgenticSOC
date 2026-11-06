/**
 * Sessions and activity: the signed-in user's own sessions and recent activity.
 *
 * (Round-2 Wave 3; Round 14 renders it as the "Sessions & activity" Settings section.)
 *
 * Two tabs:
 *   1. "Sessions": a table of the user's active sessions. The current session is pinned
 *      to the top with a "This device" badge; each row has a neutral "Sign out" action
 *      (confirmed in a dialog, where the red button lives) and the section's actions hold
 *      "Sign out all other sessions".
 *   2. "Activity": recent audit events for this user (GET /api/account/activity).
 *
 * Every session and activity value is request-derived (User-Agent, IP, geo) and is
 * therefore untrusted: it renders as plain text only (#9). No secret or token is ever
 * present (#10). When auth is off there are no sessions, and a note says so.
 *
 * Round 12 (Remember me): a remembered session carries a compact "Remembered" badge
 * (its end time in the tooltip), every row shows in an "Expires" column when the server
 * will end it (the live policy, computed by the backend: the earlier of the inactivity
 * deadline and the hard limit), a session that already ended under the live policy reads
 * "Ended (inactive)" or "Ended (time limit)" and is never shown as remembered, and
 * "Forget this device" clears the username this browser keeps for the sign-in page (it
 * does not sign anyone out).
 */
import * as React from 'react';
import { LogOut } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import type { ActivityEvent, Session } from '@/lib/types';
import { cn } from '@/lib/cn';
import { humanizeAge, humanizeUntil, formatTimestamp, humanizeToken, DASH } from '@/lib/format';
import { focusRing } from '@/lib/ui-recipes';
import { useAuth } from '@/soc/auth';
import {
  clearRememberedSessionEnd,
  forgetDevice,
  readRememberedUsername,
} from '@/soc/components/auth/rememberMe';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { Callout, LoadingGlyph, Panel } from '@/design-system';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/tabs';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/ui/alert-dialog';
import { SettingsPageSection } from '@/soc/pages/settings/primitives';
import { SECTION_META_BY_ID } from '@/soc/pages/settings/settings-sections-meta';

/** The section's help tip: the registry's `sessions` help, the one source. */
const SESSIONS_HELP = SECTION_META_BY_ID.sessions?.help;

/**
 * The row action's accessible name: the verb and the session a person recognises (its
 * device, place, whether it is this device, and whose it is), never the internal id.
 * Exported for tests.
 */
export function sessionActionLabel(
  verb: string,
  s: Pick<Session, 'ua_browser' | 'ua_os' | 'ua_raw' | 'location' | 'ip_city' | 'ip_country' | 'current' | 'username'>,
  showUser = false,
): string {
  const place = sessionLocation(s);
  return `${verb} ${sessionDevice(s)}${place ? `, ${place}` : ''}${s.current ? ' (this device)' : ''}${
    showUser && s.username ? ` for ${s.username}` : ''
  }`;
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/** A "City, Country" label from the discrete fields (or the pre-composed one). */
export function sessionLocation(s: Pick<Session, 'location' | 'ip_city' | 'ip_country'>): string {
  if (s.location && s.location.trim()) return s.location.trim();
  const parts = [s.ip_city, s.ip_country].map((p) => (p ?? '').trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : '';
}

/** "Oct 11, 10:00": the compact local end time used in the Remembered badge. */
export function sessionUntilLabel(iso?: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/**
 * Whether a session can no longer be used: revoked, or ended under the live policy
 * (the backend's `active: false`, e.g. after a period of inactivity).
 */
export function sessionEnded(s: Pick<Session, 'revoked' | 'active'>): boolean {
  return Boolean(s.revoked) || s.active === false;
}

/** The plain label for a session that ended on its own (not revoked). */
export function sessionEndedLabel(s: Pick<Session, 'ended_reason'>): string {
  switch (s.ended_reason) {
    case 'idle_expired':
      return 'Ended (inactive)';
    case 'absolute_expired':
      return 'Ended (time limit)';
    default:
      return 'Ended';
  }
}

/**
 * True when a live session ends sooner through inactivity than through its hard
 * limit: `expires_at` (the earlier of the two) then moves later with each use, up
 * to `effective_absolute_expires_at`.
 */
function idleEndsFirst(s: Pick<Session, 'expires_at' | 'effective_absolute_expires_at'>): boolean {
  const end = Date.parse(s.expires_at ?? '');
  const latest = Date.parse(s.effective_absolute_expires_at ?? '');
  return !Number.isNaN(end) && !Number.isNaN(latest) && latest - end > 60_000;
}

/** The tooltip for the "Expires" cell of a live session. */
export function sessionExpiresTitle(
  s: Pick<Session, 'expires_at' | 'effective_absolute_expires_at'>,
): string {
  if (idleEndsFirst(s)) {
    return `${formatTimestamp(s.expires_at)} if it isn't used again, ${formatTimestamp(
      s.effective_absolute_expires_at,
    )} at the latest`;
  }
  return formatTimestamp(s.expires_at);
}

/** The tooltip for the "Remembered" badge of a live session. */
export function sessionRememberedTitle(
  s: Pick<Session, 'expires_at' | 'effective_absolute_expires_at'>,
): string | undefined {
  const end = sessionUntilLabel(s.expires_at);
  if (!end) return undefined;
  if (idleEndsFirst(s)) {
    const latest = sessionUntilLabel(s.effective_absolute_expires_at);
    return `Remembered until ${end} if it isn't used again, ${latest} at the latest`;
  }
  return `Remembered until ${end}`;
}

/** A "Browser on OS" device label from the parsed UA fields. */
export function sessionDevice(s: Pick<Session, 'ua_browser' | 'ua_os' | 'ua_raw'>): string {
  const browser = (s.ua_browser ?? '').trim();
  const os = (s.ua_os ?? '').trim();
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  const raw = (s.ua_raw ?? '').trim();
  return raw || 'Unknown device';
}

// --------------------------------------------------------------------------- //
// The reusable session table (also consumed by the Admin console).
// --------------------------------------------------------------------------- //
export interface SessionsTableProps {
  sessions: Session[];
  loading: boolean;
  /** Per-row revoke; the row passes its session so callers can branch on owner. */
  onRevoke: (session: Session) => void;
  busySid: string | null;
  /** Show the owning username column (admin console). */
  showUser?: boolean;
  /** The row action's verb (default "Sign out"). */
  revokeLabel?: string;
  ariaLabel?: string;
}

/** Plain-text session table; the current session sorts to the top and is badged. */
export function SessionsTable({
  sessions,
  loading,
  onRevoke,
  busySid,
  showUser = false,
  revokeLabel = 'Sign out',
  ariaLabel = 'Sessions',
}: SessionsTableProps) {
  const ordered = React.useMemo(() => {
    // Current first, then most-recently-active.
    return [...sessions].sort((a, b) => {
      if (a.current && !b.current) return -1;
      if (b.current && !a.current) return 1;
      const at = Date.parse(a.last_active_at ?? a.created_at ?? '') || 0;
      const bt = Date.parse(b.last_active_at ?? b.created_at ?? '') || 0;
      return bt - at;
    });
  }, [sessions]);

  const columns: DataTableColumn<Session>[] = [
    ...(showUser
      ? [
          {
            id: 'username',
            header: 'User',
            cell: (s: Session) => (
              <span className="font-medium text-foreground">{s.username || DASH}</span>
            ),
          } as DataTableColumn<Session>,
        ]
      : []),
    {
      id: 'device',
      header: 'Device',
      cell: (s) => (
        <div className="min-w-0">
          {/* Badges wrap under the device name when the column is narrow, so the table
              keeps its actions in view at laptop widths. */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="min-w-0 max-w-full truncate text-sm text-foreground">{sessionDevice(s)}</span>
            {s.current ? (
              <Badge variant="success" className="text-2xs">
                This device
              </Badge>
            ) : null}
            {s.revoked ? (
              <Badge variant="secondary" className="text-2xs">
                Revoked
              </Badge>
            ) : null}
          </div>
          {s.client_type || (s.remember && !sessionEnded(s)) ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
              {s.client_type ? (
                <span className="text-xs text-muted-foreground">
                  {humanizeToken(String(s.client_type))}
                </span>
              ) : null}
              {s.remember && !sessionEnded(s) ? (
                // Compact so the table keeps its actions in view; the end time is in the
                // Expires column and the tooltip. Never on an ended session.
                <Badge
                  variant="outline"
                  className="text-2xs"
                  data-session-remembered
                  title={sessionRememberedTitle(s)}
                >
                  Remembered
                </Badge>
              ) : null}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'location',
      header: 'Location',
      cell: (s) => {
        const loc = sessionLocation(s);
        return (
          <div className="min-w-0">
            <span className="block truncate text-sm text-foreground">{loc || DASH}</span>
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {s.ip || DASH}
            </span>
          </div>
        );
      },
    },
    {
      id: 'last_active',
      header: 'Last active',
      cell: (s) => (
        <span className="text-sm text-muted-foreground" title={formatTimestamp(s.last_active_at)}>
          {humanizeAge(s.last_active_at)}
        </span>
      ),
    },
    {
      id: 'created',
      header: 'Signed in',
      cell: (s) => (
        <span className="text-sm text-muted-foreground" title={formatTimestamp(s.created_at)}>
          {humanizeAge(s.created_at)}
        </span>
      ),
    },
    {
      id: 'expires',
      header: 'Expires',
      cell: (s) =>
        s.revoked ? (
          <span className="text-sm text-muted-foreground">{DASH}</span>
        ) : s.active === false ? (
          // Ended under the live policy (e.g. inactivity): never a future time.
          <span
            className="whitespace-nowrap text-sm text-muted-foreground"
            title={s.expires_at ? `Ended ${formatTimestamp(s.expires_at)}` : undefined}
            data-session-ended
          >
            {sessionEndedLabel(s)}
          </span>
        ) : !s.expires_at ? (
          <span className="text-sm text-muted-foreground">{DASH}</span>
        ) : (
          <span
            className="whitespace-nowrap text-sm text-muted-foreground"
            title={sessionExpiresTitle(s)}
            data-session-expires
          >
            {humanizeUntil(s.expires_at)}
          </span>
        ),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (s) => (
        // Neutral at rest; red only on hover and keyboard focus. The dialog that follows
        // holds the red button (ui-standard, destructive actions).
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 text-muted-foreground hover:bg-critical/10 hover:text-critical-text focus-visible:text-critical-text',
            focusRing,
          )}
          onClick={() => onRevoke(s)}
          disabled={busySid === s.sid || s.revoked}
          aria-busy={busySid === s.sid || undefined}
          aria-label={sessionActionLabel(revokeLabel, s, showUser)}
          title={revokeLabel}
        >
          {busySid === s.sid ? (
            <LoadingGlyph size="sm" className="size-4" aria-hidden />
          ) : (
            <LogOut className="size-4" aria-hidden />
          )}
          {/* In a narrow table the action keeps its icon (named by aria-label and the
              tooltip) so every column, the action included, stays in view. */}
          <span className="hidden @[52rem]/sessions:inline" data-session-action-label>
            {revokeLabel}
          </span>
        </Button>
      ),
    },
  ];

  // The table bleeds to the edge of the panel its caller draws (Round 14, C9 option A).
  return (
    <div className="@container/sessions" data-sessions-table>
      <DataTable<Session>
        columns={columns}
        rows={ordered}
        getRowId={(s) => s.sid}
        loading={loading}
        surface="panel"
        ariaLabel={ariaLabel}
        empty="No active sessions."
      />
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Activity tab
// --------------------------------------------------------------------------- //
function ActivityList({ events, loading }: { events: ActivityEvent[]; loading: boolean }) {
  const columns: DataTableColumn<ActivityEvent>[] = [
    {
      id: 'action',
      header: 'Event',
      cell: (e) => (
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {e.action ? humanizeToken(String(e.action)) : 'Event'}
          </span>
          {e.detail ? (
            <span className="block truncate text-xs text-muted-foreground">{e.detail}</span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'location',
      header: 'Where',
      cell: (e) => {
        const loc = sessionLocation(e);
        const dev = sessionDevice(e);
        return (
          <div className="min-w-0">
            <span className="block truncate text-sm text-foreground">{loc || DASH}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {dev === 'Unknown device' ? (e.ip || DASH) : dev}
            </span>
          </div>
        );
      },
    },
    {
      id: 'ts',
      header: 'When',
      align: 'right',
      cell: (e) => (
        <span className="text-sm text-muted-foreground" title={formatTimestamp(e.ts)}>
          {humanizeAge(e.ts)}
        </span>
      ),
    },
  ];
  return (
    <DataTable<ActivityEvent>
      columns={columns}
      rows={events}
      getRowId={(e, i) => e.id ?? `${e.ts ?? ''}-${i}`}
      loading={loading}
      surface="panel"
      ariaLabel="Recent account activity"
      empty="No recent activity."
    />
  );
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //
export interface SessionsPageProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onNavigate?: (page: any, opts?: any) => void;
}

export default function Sessions(_props: SessionsPageProps) {
  return <SessionsInner />;
}

/**
 * The "Sessions & activity" body. Exported so Settings can embed it as a section. No
 * `<Can>` gate: every signed-in user manages their own sessions (the backend scopes the
 * listing to the caller).
 */
export interface SessionsInnerProps {
  /** True when this body is hosted beneath the Settings page header. */
  embedded?: boolean;
}

export function SessionsInner({ embedded = false }: SessionsInnerProps) {
  const { authEnabled, isAuthenticated } = useAuth();
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [activity, setActivity] = React.useState<ActivityEvent[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [activityLoading, setActivityLoading] = React.useState(true);
  const [busySid, setBusySid] = React.useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<Session | null>(null);
  const [revokeOthersOpen, setRevokeOthersOpen] = React.useState(false);
  const [busyOthers, setBusyOthers] = React.useState(false);
  // The sign-in page's remembered username lives only in this browser.
  const [deviceRemembers, setDeviceRemembers] = React.useState(() =>
    Boolean(readRememberedUsername()),
  );

  const loadSessions = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.sessions.list();
      setSessions(res.sessions ?? []);
    } catch (e) {
      toast.error(errMsg(e, 'Could not load sessions.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadActivity = React.useCallback(async () => {
    setActivityLoading(true);
    try {
      const res = await api.account_activity();
      setActivity(res.events ?? []);
    } catch (e) {
      // Activity is best-effort; a failure shouldn't break the page.
      toast.error(errMsg(e, 'Could not load activity.'));
      setActivity([]);
    } finally {
      setActivityLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadSessions();
    void loadActivity();
  }, [loadSessions, loadActivity]);

  const otherCount = sessions.filter((s) => !s.current && !s.revoked).length;
  // Only signed-in with auth on shows the session tabs; in the other two states the body
  // is a note, so Refresh and the sign-out actions (which would fire pointless or
  // unauthorised calls) are hidden to match.
  const active = authEnabled && isAuthenticated;

  const doRevoke = async (s: Session) => {
    setBusySid(s.sid);
    try {
      await api.sessions.revoke(s.sid);
      // Signing out this device is deliberate, not an expiry, so no automatic sign-out
      // notice follows on the next sign-in page.
      if (s.current) clearRememberedSessionEnd();
      toast.success(s.current ? 'Signed out this device.' : 'Session signed out.');
      await loadSessions();
    } catch (e) {
      toast.error(errMsg(e, 'Could not sign out the session.'));
    } finally {
      setBusySid(null);
    }
  };

  const doRevokeOthers = async () => {
    setBusyOthers(true);
    try {
      const res = await api.sessions.revokeOthers();
      toast.success(
        typeof res.revoked === 'number'
          ? `Signed out ${res.revoked} other session${res.revoked === 1 ? '' : 's'}.`
          : 'Signed out all other sessions.',
      );
      await loadSessions();
    } catch (e) {
      toast.error(errMsg(e, 'Could not sign out other sessions.'));
    } finally {
      setBusyOthers(false);
    }
  };

  const refreshing = loading || activityLoading;

  return (
    <SettingsPageSection
      embedded={embedded}
      title="Sessions & activity"
      help={SESSIONS_HELP}
      width="full"
      actions={
        active ? (
          // Wraps on narrow screens so no action is ever pushed off-screen.
          <div className="flex flex-wrap items-center justify-end gap-2" data-sessions-actions>
            {deviceRemembers ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  forgetDevice();
                  setDeviceRemembers(false);
                  toast.success("This device won't remember your username anymore.");
                }}
                title="Stop showing your username on this browser's sign-in page. You stay signed in."
              >
                Forget this device
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRevokeOthersOpen(true)}
              disabled={loading || otherCount === 0}
            >
              Sign out all other sessions
            </Button>
            <RefreshButton
              refreshing={refreshing}
              onClick={() => {
                void loadSessions();
                void loadActivity();
              }}
            />
          </div>
        ) : undefined
      }
    >
      {authEnabled && !isAuthenticated ? (
        <Callout intent="warning" title="Not signed in">
          Sign in to manage your sessions.
        </Callout>
      ) : !authEnabled ? (
        <Callout intent="warning" title="Sign-in is off">
          Authentication is disabled, so there are no sessions to manage. Turn on sign-in on
          the backend to track signed-in devices.
        </Callout>
      ) : (
        <Tabs defaultValue="sessions" className="space-y-4">
          <TabsList variant="underline" aria-label="Sessions and activity">
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="sessions">
            <Panel as="div" padding="none" data-sessions-panel="sessions">
              <SessionsTable
                sessions={sessions}
                loading={loading}
                busySid={busySid}
                onRevoke={(s) => setRevokeTarget(s)}
                ariaLabel="Your sessions"
              />
            </Panel>
          </TabsContent>

          <TabsContent value="activity">
            <Panel as="div" padding="none" data-sessions-panel="activity">
              <ActivityList events={activity} loading={activityLoading} />
            </Panel>
          </TabsContent>
        </Tabs>
      )}

      {/* Per-session sign-out confirm */}
      <AlertDialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {revokeTarget?.current ? 'Sign out this device?' : 'Sign out this session?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget?.current
                ? 'You will be signed out of this device and returned to the sign-in page.'
                : 'The chosen device is signed out now and will need to sign in again.'}
              {revokeTarget ? (
                <span className="mt-2 block text-xs text-muted-foreground">
                  {sessionDevice(revokeTarget)}
                  {sessionLocation(revokeTarget) ? ` · ${sessionLocation(revokeTarget)}` : ''}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const t = revokeTarget;
                setRevokeTarget(null);
                if (t) void doRevoke(t);
              }}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Sign-out-others confirm */}
      <AlertDialog open={revokeOthersOpen} onOpenChange={setRevokeOthersOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out all other sessions?</AlertDialogTitle>
            <AlertDialogDescription>
              Every session except this device is signed out now. Use this if you think your
              account was used from a device you don&apos;t recognise.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyOthers}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void doRevokeOthers()}
              disabled={busyOthers}
            >
              Sign out others
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPageSection>
  );
}
