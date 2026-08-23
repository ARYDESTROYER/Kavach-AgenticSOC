/**
 * Users & roles — admin-only multi-user administration (Wave 1).
 *
 * A table of accounts with: add (dialog), change role (inline Select), enable/
 * disable (Switch), reset password (dialog), and delete. Every mutation is gated by
 * `<Can resource="users" action="manage">`; the whole page is wrapped in a
 * ProtectedRoute so a non-admin who deep-links here sees the Unauthorized view.
 *
 * The backend enforces the same permission server-side AND refuses to disable /
 * demote / delete the last active super_admin (409) — those errors surface as
 * inline toasts. Usernames are operator-entered → rendered as plain text.
 */
import * as React from 'react';
import {
  Users as UsersIcon,
  UserPlus,
  KeyRound,
  Trash2,
  RefreshCw,
  Loader2,
  ShieldCheck,
  Pencil,
  SlidersHorizontal,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import type { RolesResponse, User } from '@/lib/types';
import { rolesApi, BUILTIN_ROLES, type CustomRole, type GrantMap } from './Roles.api';
import { RolePermissionSummary } from '@/soc/components/RolePermissionSummary';
import { RoleMatrixEditor, type RoleDraft } from '@/soc/components/RoleMatrixEditor';
import { humanizeAge } from '@/lib/format';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { PageHeader } from '@/soc/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { LoadError } from '@/soc/components/LoadError';
import { Can, ProtectedRoute } from '@/soc/components/Can';
import { useAuth } from '@/soc/auth';

/** Human-readable role labels (UI copy; falls back to the raw value). */
const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super admin',
  soc_manager: 'SOC manager',
  analyst_tier2: 'Analyst — Tier 2',
  analyst_tier1: 'Analyst — Tier 1',
  responder: 'Responder',
  auditor: 'Auditor',
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

interface UsersPageProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onNavigate?: (page: any, opts?: any) => void;
}

export default function Users(_props: UsersPageProps) {
  return (
    <ProtectedRoute resource="users" action="manage">
      <UsersInner />
    </ProtectedRoute>
  );
}

/**
 * The Users-&-roles body, without the page wrapper. Exported so Settings can embed
 * it (under the Administration group) while the standalone /users route keeps using
 * the default export below during cutover. The Administration section in Settings
 * already gates this behind `users:manage`, so embedding does NOT add a second
 * ProtectedRoute (back-compat: auth-off shows everything).
 */
export interface UsersInnerProps {
  /** True when this body is hosted beneath the Settings page header. */
  embedded?: boolean;
}

export function UsersInner({ embedded = false }: UsersInnerProps) {
  const { username: me } = useAuth();
  const [users, setUsers] = React.useState<User[]>([]);
  const [roles, setRoles] = React.useState<string[]>([]);
  // Custom (non built-in) role names from the resolved matrix — offered when
  // assigning a user a base role + custom_roles[] (Round 3 / Feature 6).
  const [customRoleNames, setCustomRoleNames] = React.useState<string[]>([]);
  // The FULL resolved role → resource → [actions] matrix (Round 11): threaded into
  // the create dialog so an admin SEES what each role grants before choosing it.
  const [matrix, setMatrix] = React.useState<Record<string, GrantMap>>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [resetFor, setResetFor] = React.useState<User | null>(null);
  const [rolesFor, setRolesFor] = React.useState<User | null>(null);
  const [editFor, setEditFor] = React.useState<User | null>(null);
  const [deleteFor, setDeleteFor] = React.useState<User | null>(null);
  const [busyUser, setBusyUser] = React.useState<string | null>(null);

  const load = React.useCallback(async (opts?: { background?: boolean }) => {
    // Inline mutations (role/active/delete) reload in the BACKGROUND: keep the current
    // rows on screen (the per-row `busyUser` state signals progress) instead of tearing
    // the whole table down to skeleton rows for a single-row change.
    if (!opts?.background) setLoading(true);
    setError(null);
    try {
      const [u, r] = await Promise.all([api.users.list(), api.roles.get()]);
      setUsers(u.users);
      const matrixRes = r as RolesResponse;
      setRoles(matrixRes.roles);
      setMatrix(matrixRes.matrix ?? {});
      setCustomRoleNames(
        Object.keys(matrixRes.matrix ?? {}).filter((n) => !BUILTIN_ROLES.has(n)),
      );
    } catch (e) {
      // A failed load must read as an error, not a genuine "No users yet." table.
      setError(e);
    } finally {
      if (!opts?.background) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const changeRole = async (user: User, role: string) => {
    if (role === user.role) return;
    setBusyUser(user.username);
    try {
      await api.users.update(user.username, { role });
      toast.success(`Role updated for ${user.username}.`);
      await load({ background: true });
    } catch (e) {
      toast.error(errMsg(e, 'Could not change role.'));
    } finally {
      setBusyUser(null);
    }
  };

  const toggleActive = async (user: User, active: boolean) => {
    setBusyUser(user.username);
    try {
      await api.users.update(user.username, { active });
      toast.success(active ? `${user.username} enabled.` : `${user.username} disabled.`);
      await load({ background: true });
    } catch (e) {
      toast.error(errMsg(e, 'Could not update the account.'));
    } finally {
      setBusyUser(null);
    }
  };

  const remove = async (user: User) => {
    setBusyUser(user.username);
    try {
      await api.users.remove(user.username);
      toast.success(`Deleted ${user.username}.`);
      await load({ background: true });
    } catch (e) {
      toast.error(errMsg(e, 'Could not delete the user.'));
    } finally {
      setBusyUser(null);
    }
  };

  const columns: DataTableColumn<User>[] = [
    {
      id: 'username',
      header: 'Username',
      sortable: false,
      cell: (u) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{u.username}</span>
            {u.username === me ? (
              <Badge variant="secondary" className="text-2xs">
                You
              </Badge>
            ) : null}
            {u.must_change_password ? (
              <Badge variant="warning" className="text-2xs">
                Must reset
              </Badge>
            ) : null}
          </div>
          {/* Full name + email are operator-entered → PLAIN text only (#9). */}
          {u.display_name || u.email ? (
            <span className="text-xs text-muted-foreground">
              {u.display_name || ''}
              {u.display_name && u.email ? ' · ' : ''}
              {u.email || ''}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      cell: (u) => (
        <Can resource="users" action="manage" fallback={<span>{roleLabel(u.role)}</span>}>
          <Select
            value={u.role}
            onValueChange={(v) => void changeRole(u, v)}
            disabled={busyUser === u.username}
          >
            <SelectTrigger className="h-8 w-[11rem]" aria-label={`Role for ${u.username}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r} value={r}>
                  {roleLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Can>
      ),
    },
    {
      id: 'active',
      header: 'Active',
      align: 'center',
      cell: (u) => (
        <Switch
          checked={u.active}
          onCheckedChange={(v) => void toggleActive(u, v)}
          disabled={busyUser === u.username}
          aria-label={`${u.active ? 'Disable' : 'Enable'} ${u.username}`}
        />
      ),
    },
    {
      id: 'mfa',
      header: 'MFA',
      align: 'center',
      // The mandate is conveyed as VISIBLE text (the title tooltips below are
      // mouse-only supplements, never the sole carrier of the requirement).
      cell: (u) =>
        u.mfa_enabled ? (
          <Badge
            variant="success"
            className="text-2xs"
            title={u.mfa_required ? 'Two-factor enrolled · required by admin' : 'Two-factor enrolled'}
          >
            {u.mfa_required ? 'On · required' : 'On'}
          </Badge>
        ) : u.mfa_required ? (
          <Badge
            variant="warning"
            className="text-2xs"
            title="Two-factor required — they must set up an authenticator at their next sign-in"
          >
            Required
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground" title="Two-factor not enrolled">
            Off
          </span>
        ),
    },
    {
      id: 'last_login_at',
      header: 'Last sign-in',
      cell: (u) => (
        <span className="text-sm text-muted-foreground">
          {u.last_login_at ? humanizeAge(u.last_login_at) : 'Never'}
        </span>
      ),
    },
    {
      id: 'created_at',
      header: 'Created',
      cell: (u) => <span className="text-sm text-muted-foreground">{humanizeAge(u.created_at)}</span>,
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (u) => (
        <div className="flex items-center justify-end gap-1">
          {customRoleNames.length > 0 ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setRolesFor(u)}
              disabled={busyUser === u.username}
              aria-label={`Manage roles for ${u.username}`}
              title="Assign custom roles"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setEditFor(u)}
            disabled={busyUser === u.username}
            aria-label={`Edit ${u.username}`}
            title="Edit profile & MFA requirement"
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setResetFor(u)}
            disabled={busyUser === u.username}
            aria-label={`Reset password for ${u.username}`}
            title="Reset password"
          >
            <KeyRound className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-critical hover:text-critical"
            onClick={() => setDeleteFor(u)}
            disabled={busyUser === u.username}
            aria-label={`Delete ${u.username}`}
            title="Delete user"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        embedded={embedded}
        icon={UsersIcon}
        eyebrow="Administration"
        title={embedded ? 'Users' : 'Users & roles'}
        description="Manage SOC operator accounts and their role-based access."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
              Refresh
            </Button>
            <Can resource="users" action="manage">
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <UserPlus className="h-4 w-4" aria-hidden />
                Add user
              </Button>
            </Can>
          </div>
        }
      />

      {error ? (
        <LoadError
          error={error}
          title="Couldn't load users"
          onRetry={() => void load()}
        />
      ) : (
        <DataTable<User>
          columns={columns}
          rows={users}
          getRowId={(u) => u.username}
          loading={loading}
          ariaLabel="User accounts"
          empty="No users yet."
        />
      )}

      <AddUserDialog
        open={addOpen}
        roles={roles}
        matrix={matrix}
        customRoleNames={customRoleNames}
        defaultRole={roles.includes('analyst_tier1') ? 'analyst_tier1' : roles[0] ?? 'analyst_tier1'}
        onOpenChange={setAddOpen}
        onCreated={() => {
          setAddOpen(false);
          void load();
        }}
        onRolesChanged={() => void load({ background: true })}
      />

      <EditUserDialog
        user={editFor}
        onOpenChange={(open) => {
          if (!open) setEditFor(null);
        }}
        onDone={() => {
          setEditFor(null);
          void load({ background: true });
        }}
      />

      <ResetPasswordDialog
        user={resetFor}
        onOpenChange={(open) => {
          if (!open) setResetFor(null);
        }}
        onDone={() => {
          setResetFor(null);
          void load();
        }}
      />

      <AssignRolesDialog
        user={rolesFor}
        roles={roles}
        customRoleNames={customRoleNames}
        onOpenChange={(open) => {
          if (!open) setRolesFor(null);
        }}
        onDone={() => {
          setRolesFor(null);
          void load();
        }}
      />

      <ConfirmDialog
        open={!!deleteFor}
        onOpenChange={(open) => {
          if (!open) setDeleteFor(null);
        }}
        destructive
        title={deleteFor ? `Delete user "${deleteFor.username}"?` : 'Delete user?'}
        description="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          const u = deleteFor;
          setDeleteFor(null);
          if (u) void remove(u);
        }}
      />
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Assign-roles dialog (base role + custom_roles[]) — Round 3 / Feature 6.
// --------------------------------------------------------------------------- //
/** Read a user's currently-assigned custom roles from its typed prefs bag
 * (defensive: the wire value is free-form JSON, so the array check stays). */
function userCustomRoles(user: User | null): string[] {
  const raw: unknown = user?.prefs?.custom_roles;
  return Array.isArray(raw) ? raw.map((x) => String(x)) : [];
}

function AssignRolesDialog({
  user,
  roles,
  customRoleNames,
  onOpenChange,
  onDone,
}: {
  user: User | null;
  roles: string[];
  customRoleNames: string[];
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [baseRole, setBaseRole] = React.useState('');
  const [assigned, setAssigned] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (user) {
      setBaseRole(typeof user.role === 'string' ? user.role : String(user.role));
      setAssigned(new Set(userCustomRoles(user)));
    }
  }, [user]);

  const toggle = (name: string) => {
    setAssigned((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const submit = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await rolesApi.assignUserRoles(user.username, {
        role: baseRole,
        custom_roles: Array.from(assigned),
      });
      toast.success(`Roles updated for ${user.username}.`);
      onDone();
    } catch (e) {
      // The server surfaces the last-admin lockout guard (409) — show its message.
      toast.error(errMsg(e, 'Could not update roles.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign roles</DialogTitle>
          <DialogDescription>
            Set the base role and any custom roles{user ? ` for ${user.username}` : ''}. The
            server prevents removing the last user who can manage users.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="assign-base-role">Base role</Label>
            <Select value={baseRole} onValueChange={setBaseRole} disabled={busy}>
              <SelectTrigger id="assign-base-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {roleLabel(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2" role="group" aria-labelledby="assign-custom-roles-label">
            {/* A group label (not a bare <label>, which would associate with nothing) so
                the toggle-chip set below has an accessible name. */}
            <span
              id="assign-custom-roles-label"
              className="text-sm font-medium leading-none text-foreground"
            >
              Custom roles
            </span>
            {customRoleNames.length === 0 ? (
              <p className="text-sm text-muted-foreground">No custom roles defined yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {customRoleNames.map((name) => {
                  const on = assigned.has(name);
                  return (
                    <Button
                      key={name}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => toggle(name)}
                      aria-pressed={on}
                      className={
                        on
                          ? 'h-auto rounded-md border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary'
                          : 'h-auto rounded-md border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground'
                      }
                    >
                      {name}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !baseRole}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <ShieldCheck className="h-4 w-4" aria-hidden />
            )}
            Save roles
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- //
// Add-user dialog (Round 11): profile/contact fields, an MFA mandate, LIVE
// role-permission visibility, and creation-time fine-graining via custom roles.
// --------------------------------------------------------------------------- //
function AddUserDialog({
  open,
  roles,
  matrix,
  customRoleNames,
  defaultRole,
  onOpenChange,
  onCreated,
  onRolesChanged,
}: {
  open: boolean;
  roles: string[];
  /** The FULL resolved matrix (role → resource → [actions]) from GET /api/roles. */
  matrix: Record<string, GrantMap>;
  customRoleNames: string[];
  defaultRole: string;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
  /** A custom role was created inline — let the parent refresh its role lists. */
  onRolesChanged?: () => void;
}) {
  const [username, setUsername] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [role, setRole] = React.useState(defaultRole);
  const [mfaRequired, setMfaRequired] = React.useState(false);
  // Custom roles toggled ON for this new user + any created inline this session.
  const [assigned, setAssigned] = React.useState<Set<string>>(new Set());
  const [inlineRoles, setInlineRoles] = React.useState<CustomRole[]>([]);
  const [roleEditorOpen, setRoleEditorOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setUsername('');
      setDisplayName('');
      setEmail('');
      setPhone('');
      setPassword('');
      setRole(defaultRole);
      setMfaRequired(false);
      setAssigned(new Set());
      setInlineRoles([]);
      setRoleEditorOpen(false);
    }
  }, [open, defaultRole]);

  // The offerable custom roles: everything the matrix already knows + anything
  // created inline this session (dedup; the parent reload catches up in background).
  const availableCustomRoles = React.useMemo(() => {
    const seen = new Set(customRoleNames);
    const extras = inlineRoles.map((r) => r.name).filter((n) => !seen.has(n));
    return [...customRoleNames, ...extras];
  }, [customRoleNames, inlineRoles]);

  // Inline-created roles are not in the parent-fetched matrix yet — overlay their
  // RESOLVED preview rows so the summary/editor baseline stays truthful.
  const effectiveMatrix = React.useMemo(() => {
    if (inlineRoles.length === 0) return matrix;
    const next = { ...matrix };
    for (const r of inlineRoles) if (!next[r.name]) next[r.name] = r.grants;
    return next;
  }, [matrix, inlineRoles]);

  const toggleCustomRole = (name: string) => {
    setAssigned((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const submit = async () => {
    // Client-side we only mirror the cheap password-length gate; email/phone stay
    // LENIENT here — the server is the validation authority (400s surface as toasts).
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      await api.users.create({
        username: username.trim(),
        password,
        role,
        display_name: displayName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        mfa_required: mfaRequired,
        ...(assigned.size ? { custom_roles: Array.from(assigned) } : {}),
      });
      toast.success(`Created ${username.trim()}. They must reset the password on first sign-in.`);
      onCreated();
    } catch (e) {
      toast.error(errMsg(e, 'Could not create the user.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>
            The new account must change its password on first sign-in.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5 py-1">
          {/* ---- Identity + contact ---------------------------------------- */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-user-name">Username</Label>
              <Input
                id="new-user-name"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                disabled={busy}
                /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-fullname">
                Full name <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="new-user-fullname"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="off"
                placeholder="e.g. Alex Morgan"
                maxLength={200}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-email">
                Email <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="new-user-email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
                placeholder="alex@example.com"
                maxLength={200}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-phone">
                Mobile number <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="new-user-phone"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="off"
                placeholder="+91 98765 43210"
                maxLength={200}
                disabled={busy}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-pass">Temporary password</Label>
            <Input
              id="new-user-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              At least 8 characters. They&apos;ll be asked to replace it at first sign-in.
            </p>
          </div>

          {/* ---- Access: role + LIVE permission visibility + fine-graining --- */}
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Access
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-role">Role</Label>
              <Select value={role} onValueChange={setRole} disabled={busy}>
                <SelectTrigger id="new-user-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r} value={r}>
                      {roleLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Updates live as the role changes, so the admin SEES what the role
                grants before creating the account. */}
            <RolePermissionSummary roleName={role} matrix={effectiveMatrix} />
            <div className="space-y-2" role="group" aria-labelledby="new-user-custom-roles-label">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  id="new-user-custom-roles-label"
                  className="text-sm font-medium leading-none text-foreground"
                >
                  Fine-tune with custom roles
                </span>
                {/* Custom roles ARE the per-user override mechanism: this seeds a new
                    role from the selected base role in the full matrix editor.
                    (POST /api/roles is fresh-auth-gated — the global re-auth dialog
                    handles the step-up transparently.) */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs"
                  onClick={() => setRoleEditorOpen(true)}
                  disabled={busy}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                  Adjust permissions…
                </Button>
              </div>
              {availableCustomRoles.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Attach custom roles to add or deny specific permissions on top of the
                  base role. None exist yet — &ldquo;Adjust permissions…&rdquo; creates one.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {availableCustomRoles.map((name) => {
                    const on = assigned.has(name);
                    return (
                      <Button
                        key={name}
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => toggleCustomRole(name)}
                        aria-pressed={on}
                        className={
                          on
                            ? 'h-auto rounded-md border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary'
                            : 'h-auto rounded-md border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground'
                        }
                      >
                        {name}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ---- Security: the MFA mandate ---------------------------------- */}
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Security
            </p>
            <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface p-3">
              <div className="space-y-0.5">
                <Label htmlFor="new-user-mfa">Require multi-factor authentication</Label>
                <p className="text-xs text-muted-foreground">
                  They must set up an authenticator at their next sign-in.
                </p>
              </div>
              <Switch
                id="new-user-mfa"
                checked={mfaRequired}
                onCheckedChange={setMfaRequired}
                disabled={busy}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !username.trim() || !password}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>

      <InlineCustomRoleDialog
        open={roleEditorOpen}
        baseRole={role}
        matrix={effectiveMatrix}
        onOpenChange={setRoleEditorOpen}
        onCreated={(created) => {
          setInlineRoles((prev) => [...prev.filter((r) => r.name !== created.name), created]);
          setAssigned((prev) => new Set(prev).add(created.name));
          setRoleEditorOpen(false);
          onRolesChanged?.();
        }}
      />
    </Dialog>
  );
}

// --------------------------------------------------------------------------- //
// Inline custom-role creation from the add-user dialog ("Adjust permissions…").
// Seeds the existing RoleMatrixEditor with `inherits: [baseRole]` so the new role
// STARTS as the selected role and the admin adds/denies from there. Persisting via
// POST /api/roles is fresh-auth-gated; the api client's global re-auth dialog
// handles the 401 `reauth_required` step-up + one retry transparently.
// --------------------------------------------------------------------------- //
function InlineCustomRoleDialog({
  open,
  baseRole,
  matrix,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  baseRole: string;
  matrix: Record<string, GrantMap>;
  onOpenChange: (v: boolean) => void;
  onCreated: (role: CustomRole) => void;
}) {
  const [draft, setDraft] = React.useState<RoleDraft>({
    name: '',
    description: '',
    inherits: [],
    grants: {},
    denies: {},
  });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setDraft({
        name: '',
        description: '',
        // Start FROM the selected base role (only builtins are offerable as base).
        inherits: BUILTIN_ROLES.has(baseRole) ? [baseRole] : [],
        grants: {},
        denies: {},
      });
    }
  }, [open, baseRole]);

  const nameTaken = draft.name.trim() !== '' && !!matrix[draft.name.trim()];
  const nameIsBuiltin = BUILTIN_ROLES.has(draft.name.trim());
  const canSubmit = draft.name.trim().length > 0 && !nameTaken && !nameIsBuiltin;

  const save = async () => {
    setSaving(true);
    try {
      const res = await rolesApi.create({
        name: draft.name.trim(),
        description: draft.description,
        inherits: draft.inherits,
        grants: draft.grants,
        denies: draft.denies,
      });
      // Truthful wording: the role is durably created NOW, but it is only
      // pre-selected in the not-yet-submitted Add-user form — attachment happens
      // when (and only if) the user is actually created.
      toast.success(`Created custom role ${res.role.name} — it will be attached when the user is created.`);
      onCreated(res.role);
    } catch (e) {
      // A declined/failed re-auth step-up surfaces here too — keep the dialog open.
      toast.error(errMsg(e, 'Could not create the custom role.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Adjust permissions</DialogTitle>
          <DialogDescription>
            Creates a reusable custom role starting from {roleLabel(baseRole)} — toggle
            each cell: not set → grant → deny. It is pre-selected here and attached
            when the user is created.
          </DialogDescription>
        </DialogHeader>

        <RoleMatrixEditor draft={draft} onChange={setDraft} matrix={matrix} disabled={saving} />

        {nameTaken ? (
          <p className="text-sm text-warning-text">
            A role named {draft.name.trim()} already exists — manage it from Roles &amp;
            permissions, or pick another name.
          </p>
        ) : null}
        {nameIsBuiltin ? (
          <p className="text-sm text-warning-text">
            {draft.name.trim()} is a built-in role and cannot be redefined.
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSubmit || saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <ShieldCheck className="h-4 w-4" aria-hidden />
            )}
            Create role &amp; attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- //
// Edit-user dialog (Round 11): admin-editable profile/contact fields + the MFA
// mandate (toggle BOTH ways — distinct from mfa_enabled, which stays self-service).
// --------------------------------------------------------------------------- //
function EditUserDialog({
  user,
  onOpenChange,
  onDone,
}: {
  user: User | null;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [displayName, setDisplayName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [mfaRequired, setMfaRequired] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (user) {
      setDisplayName(user.display_name ?? '');
      setEmail(user.email ?? '');
      setPhone(user.phone ?? '');
      setMfaRequired(Boolean(user.mfa_required));
    }
  }, [user]);

  const submit = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await api.users.update(user.username, {
        display_name: displayName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        mfa_required: mfaRequired,
      });
      toast.success(`Updated ${user.username}.`);
      onDone();
    } catch (e) {
      toast.error(errMsg(e, 'Could not update the user.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit user</DialogTitle>
          <DialogDescription>
            Update profile details and the two-factor requirement
            {user ? ` for ${user.username}` : ''}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="edit-user-fullname">Full name</Label>
            <Input
              id="edit-user-fullname"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="off"
              maxLength={200}
              disabled={busy}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-user-email">Email</Label>
              <Input
                id="edit-user-email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
                maxLength={200}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-user-phone">Mobile number</Label>
              <Input
                id="edit-user-phone"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="off"
                maxLength={200}
                disabled={busy}
              />
            </div>
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface p-3">
            <div className="space-y-0.5">
              <Label htmlFor="edit-user-mfa">Require multi-factor authentication</Label>
              <p className="text-xs text-muted-foreground">
                {user?.mfa_enabled
                  ? 'Already enrolled. Turning this off keeps their authenticator; it only removes the requirement.'
                  : 'They must set up an authenticator at their next sign-in.'}
              </p>
            </div>
            <Switch
              id="edit-user-mfa"
              checked={mfaRequired}
              onCheckedChange={setMfaRequired}
              disabled={busy}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Pencil className="h-4 w-4" aria-hidden />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- //
// Reset-password dialog
// --------------------------------------------------------------------------- //
function ResetPasswordDialog({
  user,
  onOpenChange,
  onDone,
}: {
  user: User | null;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (user) setPassword('');
  }, [user]);

  const submit = async () => {
    if (!user) return;
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      await api.users.update(user.username, { password });
      toast.success(`Password reset for ${user.username}.`);
      onDone();
    } catch (e) {
      toast.error(errMsg(e, 'Could not reset the password.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Set a new temporary password{user ? ` for ${user.username}` : ''}. They must change it on
            next sign-in.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-1">
          <Label htmlFor="reset-pass">New password</Label>
          <Input
            id="reset-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !password}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <KeyRound className="h-4 w-4" aria-hidden />}
            Reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
