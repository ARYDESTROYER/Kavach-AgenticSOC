/**
 * Sessions & Activity — the signed-in user's own sessions + recent activity.
 *
 * (Round-2 Wave 3; Wave 4 folds this into Settings > Account > Security.)
 *
 * Two tabs:
 *   1. "Sessions" — a table of the user's active sessions. The current session is
 *      pinned to the top with a "This device" badge; per-row destructive Revoke
 *      (AlertDialog confirm); a top-right "Sign out all other sessions".
 *   2. "Activity" — recent audit events for this user (GET /api/account/activity).
 *
 * Every session/activity value is request-derived (User-Agent / IP / geo) and is
 * therefore UNTRUSTED — it is rendered as PLAIN text only (#9). No secret/token is
 * ever present (#10). When auth is OFF there are no sessions; we surface a note.
 *
 * Round 12 (Remember me): a remembered session carries a compact "Remembered" badge
 * (its end time in the tooltip), every row shows in an "Expires" column when the
 * server will end it (the live policy, computed by the backend), and "Forget this
 * device" clears the username this browser keeps for the sign-in page (it does not
 * sign anyone out).
 */
import * as React from 'react';
import {
  MonitorSmartphone,
  Laptop,
  RefreshCw,
  LogOut,
  Loader2,
  ShieldOff,
  History,
  Eraser,
} from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import type { ActivityEvent, Session } from '@/lib/types';
import { humanizeAge, humanizeUntil, formatTimestamp, humanizeToken, DASH } from '@/lib/format';
import { useAuth } from '@/soc/auth';
import {
  clearRememberedSessionEnd,
  forgetDevice,
  readRememberedUsername,
} from '@/soc/components/auth/rememberMe';
import { PageHeader } from '@/soc/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription } from '@/ui/alert';
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

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/** A "City, Country" label from the discrete fields (or the pre-composed one). */
export function sessionLocation(s: Pick<Session, 'location' | 'ip_city' | 'ip_country'>): string {
  if (s.location && s.location.trim()) return s.location.trim();
  const parts = [s.ip_city, s.ip_country].map((p) => (p ?? '').trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : '';
}

/** "Oct 11, 10:00" — the compact local end time used in the Remembered badge. */
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
  /** Label for the destructive verb (default "Revoke"; admin uses "Terminate"). */
  revokeLabel?: string;
  ariaLabel?: string;
}

/** Plain-text session table; the current session sorts to the top + is badged. */
export function SessionsTable({
  sessions,
  loading,
  onRevoke,
  busySid,
  showUser = false,
  revokeLabel = 'Revoke',
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
      header: 'Device / Browser',
      cell: (s) => (
        <div className="flex items-center gap-2">
          {s.current ? (
            <Laptop className="h-4 w-4 text-primary" aria-hidden />
          ) : (
            <MonitorSmartphone className="h-4 w-4 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0">
            {/* Badges wrap under the device name when the column is narrow, so the
                table keeps its actions in view at laptop widths. */}
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
            {s.client_type || (s.remember && !s.revoked) ? (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                {s.client_type ? (
                  <span className="text-xs text-muted-foreground">
                    {humanizeToken(String(s.client_type))}
                  </span>
                ) : null}
                {s.remember && !s.revoked ? (
                  // Compact so the table keeps its actions in view; the end time is in
                  // the Expires column and the tooltip.
                  <Badge
                    variant="outline"
                    className="text-2xs"
                    data-session-remembered
                    title={
                      sessionUntilLabel(s.expires_at)
                        ? `Remembered until ${sessionUntilLabel(s.expires_at)}`
                        : undefined
                    }
                  >
                    Remembered
                  </Badge>
                ) : null}
              </div>
            ) : null}
          </div>
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
        s.revoked || !s.expires_at ? (
          <span className="text-sm text-muted-foreground">{DASH}</span>
        ) : (
          <span
            className="whitespace-nowrap text-sm text-muted-foreground"
            title={formatTimestamp(s.expires_at)}
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
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-critical hover:text-critical"
          onClick={() => onRevoke(s)}
          disabled={busySid === s.sid || s.revoked}
          aria-label={`${revokeLabel} session ${s.sid}`}
          title={revokeLabel}
        >
          {busySid === s.sid ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <LogOut className="h-4 w-4" aria-hidden />
          )}
          {/* In a narrow table the action keeps its icon (named by aria-label and
              the tooltip) so every column, the action included, stays in view. */}
          <span className="hidden @[52rem]/sessions:inline" data-session-action-label>
            {revokeLabel}
          </span>
        </Button>
      ),
    },
  ];

  return (
    <div className="@container/sessions" data-sessions-table>
      <DataTable<Session>
        columns={columns}
        rows={ordered}
        getRowId={(s) => s.sid}
        loading={loading}
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
 * The "Sessions & activity" body, without the page wrapper. Exported so Settings can
 * embed it under the Account (Personal) group. No `<Can>` gate: every signed-in user
 * manages their OWN sessions (the backend scopes the listing to the caller).
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
  // Only signed-in + auth-on shows the session tabs; in the other two states the body
  // is an informational Alert, so the Refresh + destructive header actions (which
  // would fire pointless / 401'ing calls) are hidden to match.
  const active = authEnabled && isAuthenticated;

  const doRevoke = async (s: Session) => {
    setBusySid(s.sid);
    try {
      await api.sessions.revoke(s.sid);
      // Signing out THIS device is deliberate, not an expiry (no "signed out after
      // 24 hours" notice later).
      if (s.current) clearRememberedSessionEnd();
      toast.success(s.current ? 'Signed out this device.' : 'Session revoked.');
      await loadSessions();
    } catch (e) {
      toast.error(errMsg(e, 'Could not revoke the session.'));
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

  return (
    <div className="space-y-6">
      <PageHeader
        embedded={embedded}
        icon={MonitorSmartphone}
        eyebrow="Account"
        title="Sessions & activity"
        description="Review where you're signed in and your recent account activity."
        actions={
          active ? (
            // Wraps on narrow screens so no action is ever pushed off-screen.
            <div className="flex flex-wrap items-center justify-end gap-2" data-sessions-actions>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void loadSessions();
                  void loadActivity();
                }}
                disabled={loading}
              >
                <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
                Refresh
              </Button>
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
                  <Eraser className="h-4 w-4" aria-hidden />
                  Forget this device
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                className="text-critical hover:text-critical"
                onClick={() => setRevokeOthersOpen(true)}
                disabled={loading || otherCount === 0}
              >
                <ShieldOff className="h-4 w-4" aria-hidden />
                Sign out all other sessions
              </Button>
            </div>
          ) : undefined
        }
      />

      {authEnabled && !isAuthenticated ? (
        <Alert>
          <AlertDescription>Sign in to manage your sessions.</AlertDescription>
        </Alert>
      ) : !authEnabled ? (
        <Alert>
          <AlertDescription>
            Authentication is disabled, so there are no sessions to manage. Enable auth on the
            backend to track signed-in devices.
          </AlertDescription>
        </Alert>
      ) : (
        <Tabs defaultValue="sessions" className="space-y-4">
          <TabsList>
            <TabsTrigger value="sessions">
              <MonitorSmartphone className="mr-1.5 h-4 w-4" aria-hidden />
              Sessions
            </TabsTrigger>
            <TabsTrigger value="activity">
              <History className="mr-1.5 h-4 w-4" aria-hidden />
              Activity
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sessions">
            <SessionsTable
              sessions={sessions}
              loading={loading}
              busySid={busySid}
              onRevoke={(s) => setRevokeTarget(s)}
              ariaLabel="Your sessions"
            />
          </TabsContent>

          <TabsContent value="activity">
            <ActivityList events={activity} loading={activityLoading} />
          </TabsContent>
        </Tabs>
      )}

      {/* Per-session revoke confirm */}
      <AlertDialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {revokeTarget?.current ? 'Sign out this device?' : 'Revoke this session?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget?.current
                ? 'You will be signed out of this device and returned to the login screen.'
                : 'The chosen device will be signed out immediately and will need to sign in again.'}
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
              {revokeTarget?.current ? 'Sign out' : 'Revoke'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke-others confirm */}
      <AlertDialog open={revokeOthersOpen} onOpenChange={setRevokeOthersOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out all other sessions?</AlertDialogTitle>
            <AlertDialogDescription>
              Every session except this device will be signed out immediately. This is useful if
              you suspect an account has been accessed from a device you don&apos;t recognise.
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
    </div>
  );
}
