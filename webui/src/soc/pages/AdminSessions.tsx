/**
 * Active sessions: every user's sessions (Round-2 Wave 3; Round 14 renders it as the
 * "Active sessions" Settings section).
 *
 * Gated by `users:manage` (the whole page is wrapped in a ProtectedRoute; the backend
 * enforces the same grant and step-up freshness). An administrator can filter by
 * username, sign out a single session (with a "notify the user" checkbox in the
 * confirm), and sign out every session for a user (bumps their token_version so
 * already-issued tokens stop working), also with the notify checkbox.
 *
 * Every session value is request-derived (UA, IP, geo) and renders as plain text (#9).
 * No token or secret is ever returned (#10). Signing out a sensitive scope can trigger
 * the step-up re-auth dialog (handled globally by <ReauthDialog>).
 */
import * as React from 'react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import type { Session } from '@/lib/types';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { LoadingGlyph, Panel } from '@/design-system';
import { FilterBar } from '@/soc/components/FilterBar';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { ProtectedRoute } from '@/soc/components/Can';
import { LoadError } from '@/soc/components/LoadError';
import { SessionsTable, sessionDevice, sessionLocation } from '@/soc/pages/Sessions';
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

/** The section's help tip: the registry's `admin_sessions` help, the one source. */
const ADMIN_SESSIONS_HELP = SECTION_META_BY_ID.admin_sessions?.help;

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

export interface AdminSessionsPageProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onNavigate?: (page: any, opts?: any) => void;
}

export default function AdminSessions(_props: AdminSessionsPageProps) {
  return (
    <ProtectedRoute resource="users" action="manage">
      <AdminSessionsInner />
    </ProtectedRoute>
  );
}

/**
 * The all-users session body. Exported so Settings can embed it as a section (already
 * gated by `users:manage` there); the standalone route uses the default export above.
 */
export interface AdminSessionsInnerProps {
  /** True when this body is hosted beneath the Settings page header. */
  embedded?: boolean;
}

export function AdminSessionsInner({ embedded = false }: AdminSessionsInnerProps) {
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<unknown>(null);
  const [filter, setFilter] = React.useState('');
  const [busySid, setBusySid] = React.useState<string | null>(null);

  // Single sign-out confirm state.
  const [termTarget, setTermTarget] = React.useState<Session | null>(null);
  const [termNotify, setTermNotify] = React.useState(false);

  // Sign out all (per user) confirm state.
  const [revokeAllUser, setRevokeAllUser] = React.useState<string | null>(null);
  const [revokeAllNotify, setRevokeAllNotify] = React.useState(false);
  const [busyAll, setBusyAll] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.admin.sessions.list();
      setSessions(res.sessions ?? []);
    } catch (e) {
      // Track the error so a fetch failure renders a distinct LoadError (with retry)
      // instead of the empty table's authoritative-sounding "No active sessions.".
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => (s.username ?? '').toLowerCase().includes(q));
  }, [sessions, filter]);

  const doTerminate = async (s: Session, notify: boolean) => {
    setBusySid(s.sid);
    try {
      await api.admin.sessions.revoke(s.sid, notify);
      toast.success('Session signed out.');
      await load();
    } catch (e) {
      toast.error(errMsg(e, 'Could not sign out the session.'));
    } finally {
      setBusySid(null);
    }
  };

  const doRevokeAll = async (username: string, notify: boolean) => {
    setBusyAll(true);
    try {
      const res = await api.admin.users.revokeAll(username, notify);
      toast.success(
        typeof res.revoked === 'number'
          ? `Signed out ${res.revoked} session${res.revoked === 1 ? '' : 's'} for ${username}.`
          : `Signed out all sessions for ${username}.`,
      );
      await load();
    } catch (e) {
      toast.error(errMsg(e, 'Could not sign out the user’s sessions.'));
    } finally {
      setBusyAll(false);
    }
  };

  const candidate = filter ? revokeAllCandidate(filtered) : null;

  return (
    <SettingsPageSection
      embedded={embedded}
      title="Active sessions"
      help={ADMIN_SESSIONS_HELP}
      width="full"
      actions={<RefreshButton refreshing={loading} onClick={() => void load()} />}
    >
      {loadError && !loading ? (
        <LoadError
          error={loadError}
          title="Couldn't load sessions"
          fallback="Could not load sessions."
          onRetry={() => void load()}
        />
      ) : (
        // One panel: the user filter on the row inset, the table bleeding to the edge.
        <Panel as="div" padding="none" data-admin-sessions-panel="">
          <div className="px-4 pb-3 pt-4 xl:px-5 3xl:px-6">
            <FilterBar
              aria-label="Session filters"
              search={{
                value: filter,
                onChange: setFilter,
                label: 'Filter by user',
                placeholder: 'Filter by username',
              }}
              end={
                candidate ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setRevokeAllUser(candidate);
                      setRevokeAllNotify(false);
                    }}
                  >
                    Sign out all for {candidate}
                  </Button>
                ) : null
              }
            />
          </div>

          <SessionsTable
            sessions={filtered}
            loading={loading}
            busySid={busySid}
            showUser
            revokeLabel="Sign out"
            ariaLabel="All active sessions"
            onRevoke={(s) => {
              setTermTarget(s);
              setTermNotify(false);
            }}
          />
        </Panel>
      )}

      {/* Single sign-out confirm with notify checkbox */}
      <AlertDialog
        open={!!termTarget}
        onOpenChange={(open) => {
          if (!open) setTermTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out this session?</AlertDialogTitle>
            <AlertDialogDescription>
              {termTarget?.username ? (
                <>
                  This signs out <span className="font-medium text-foreground">{termTarget.username}</span> on the
                  selected device now.
                </>
              ) : (
                'This signs out the selected device now.'
              )}
              {termTarget ? (
                <span className="mt-2 block text-xs text-muted-foreground">
                  {sessionDevice(termTarget)}
                  {sessionLocation(termTarget) ? ` · ${sessionLocation(termTarget)}` : ''}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label htmlFor="term-notify" className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox
              id="term-notify"
              checked={termNotify}
              onCheckedChange={(v) => setTermNotify(v === true)}
              aria-label="Notify the user"
            />
            Notify the user by email
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const t = termTarget;
                const notify = termNotify;
                setTermTarget(null);
                if (t) void doTerminate(t, notify);
              }}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Sign out all (per user) confirm with notify checkbox */}
      <AlertDialog
        open={!!revokeAllUser}
        onOpenChange={(open) => {
          if (!open) setRevokeAllUser(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out all sessions for {revokeAllUser}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every active session for{' '}
              <span className="font-medium text-foreground">{revokeAllUser}</span> is signed out and
              their already-issued tokens stop working. They will need to sign in again everywhere.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label htmlFor="revoke-all-notify" className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox
              id="revoke-all-notify"
              checked={revokeAllNotify}
              onCheckedChange={(v) => setRevokeAllNotify(v === true)}
              aria-label="Notify the user"
            />
            Notify the user by email
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAll}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busyAll}
              onClick={() => {
                const u = revokeAllUser;
                const notify = revokeAllNotify;
                setRevokeAllUser(null);
                if (u) void doRevokeAll(u, notify);
              }}
            >
              {busyAll ? <LoadingGlyph size="sm" className="size-4" aria-hidden /> : null}
              Sign out all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPageSection>
  );
}

/** When the filtered set is exactly one user, offer "Sign out all for X". */
function revokeAllCandidate(sessions: Session[]): string | null {
  const users = new Set(sessions.map((s) => s.username ?? '').filter(Boolean));
  if (users.size === 1) {
    const [only] = Array.from(users);
    return only || null;
  }
  return null;
}
