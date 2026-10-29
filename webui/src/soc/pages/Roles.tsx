/**
 * Roles — RBAC role administration (Round 3 / Feature 6).
 *
 * Lists the six immutable BUILT-IN roles plus any operator-defined CUSTOM roles
 * (resolved matrix from GET /api/roles). An admin can create / clone / edit a custom
 * role in a resource×action matrix editor (<RoleMatrixEditor>), preview the resolved
 * effective grants as a DIFF against the live matrix (POST /api/roles/preview) BEFORE
 * applying, and persist (POST/PUT/DELETE /roles). A simulate panel spot-checks a
 * single role × resource × action (GET /roles/simulate).
 *
 * RBAC: the whole page is gated behind <ProtectedRoute resource="roles" action="manage">.
 * GET /api/account/permissions drives a small capability banner (what the CURRENT user
 * may do here). Every role name / description / action is operator-influenceable and
 * rendered as PLAIN text or in a CodeBlock (#9) — never HTML, never into a prompt.
 *
 * #3 is untouched: RBAC only gates WHO may call a close/escalate endpoint; nothing on
 * this page feeds the deterministic case_manager.decide().
 */
import * as React from 'react';
import {
  ShieldCheck,
  Plus,
  Copy,
  Pencil,
  Trash2,
  RefreshCw,
  Loader2,
  Lock,
  FlaskConical,
  ArrowRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { humanizeToken } from '@/lib/format';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Label } from '@/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
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
import { Card, CardContent } from '@/ui/card';
import { ProtectedRoute, useCan } from '@/soc/components/Can';
import { CodeBlock } from '@/soc/components/CodeBlock';
import {
  RoleMatrixEditor,
  type RoleDraft,
} from '@/soc/components/RoleMatrixEditor';
import {
  rolesApi,
  roleLabel,
  foldRetiredRunbookAlias,
  BUILTIN_ROLES,
  RESOURCE_ORDER,
  RESOURCE_ACTIONS,
  type RolesMatrixResponse,
  type CustomRole,
  type RolePreviewResponse,
  type SimulateResponse,
  type AccountPermissions,
  type GrantMap,
} from './Roles.api';

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/** A row in the roles roster: a built-in role OR a stored custom role. */
interface RoleRow {
  name: string;
  builtin: boolean;
  description: string;
  /** Count of distinct resources the role touches (from the resolved matrix). */
  resourceCount: number;
  custom?: CustomRole;
}

function emptyDraft(): RoleDraft {
  return { name: '', description: '', inherits: [], grants: {}, denies: {} };
}

// Canonical built-in ordering for the roster sort.
const roleLabelOrder: Record<string, true> = {
  super_admin: true,
  soc_manager: true,
  analyst_tier2: true,
  analyst_tier1: true,
  responder: true,
  auditor: true,
};

function cloneMap(m?: GrantMap): GrantMap {
  const out: GrantMap = {};
  for (const [k, v] of Object.entries(m ?? {})) out[k] = [...v];
  return out;
}

/**
 * Build an editor draft for an EXISTING custom role.
 *
 * The full raw definition (`row.custom`) is only cached after an in-session
 * create/update — GET /api/roles returns just the RESOLVED matrix. On a fresh page
 * load `row.custom` is undefined, so seeding an empty draft here would let a save
 * blank the role (silent RBAC data loss). When the raw definition is absent we seed
 * the draft's grants from the resolved matrix row (`matrix[name]`), so a subsequent
 * save re-persists the role's CURRENT effective permissions instead of wiping them.
 * Inheritance/denies flatten into explicit grants — permissions are preserved, never
 * reduced. (A backend change returning raw custom-role definitions would let Edit
 * restore the exact grants/denies/inherits + description — see the handoff.)
 */
export function draftFromRow(row: RoleRow, matrix: Record<string, GrantMap>): RoleDraft {
  const c = row.custom;
  if (c) {
    return {
      name: row.name,
      description: c.description ?? '',
      inherits: [...(c.inherits ?? [])],
      // A stored `playbooks` key reads as its `runbooks` meaning (SPEC §3.7), so the
      // draft never carries a key the editor cannot show.
      grants: foldRetiredRunbookAlias(cloneMap(c.grants)),
      denies: foldRetiredRunbookAlias(cloneMap(c.denies)),
    };
  }
  return {
    name: row.name,
    description: '',
    inherits: [],
    grants: cloneMap(matrix[row.name]),
    denies: {},
  };
}

export default function Roles() {
  return (
    <ProtectedRoute resource="roles" action="manage">
      <RolesInner />
    </ProtectedRoute>
  );
}

export interface RolesInnerProps {
  /** True when this body is hosted beneath the Settings page header. */
  embedded?: boolean;
}

export function RolesInner({ embedded = false }: RolesInnerProps) {
  const canManage = useCan('roles', 'manage');
  const [data, setData] = React.useState<RolesMatrixResponse | null>(null);
  const [customRoles, setCustomRoles] = React.useState<Map<string, CustomRole>>(new Map());
  const [perms, setPerms] = React.useState<AccountPermissions | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [editor, setEditor] = React.useState<{ draft: RoleDraft; mode: 'create' | 'edit' } | null>(
    null,
  );
  const [deleteRow, setDeleteRow] = React.useState<RoleRow | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [matrix, ap] = await Promise.all([
        rolesApi.matrix(),
        rolesApi.accountPermissions().catch(() => null),
      ]);
      setData(matrix);
      if (ap) setPerms(ap);
    } catch (e) {
      // The roster ALWAYS contains the six built-ins, so an empty table means the
      // fetch failed — surface a retryable error, not a misleading "No roles yet."
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // The matrix carries built-ins AND any stored custom roles. We can't tell which
  // rows are custom from the matrix alone, so a custom row is any matrix key that is
  // NOT a built-in role name. We hydrate the full custom-role definition lazily from
  // the editor's preview/save, but we keep a cache so re-editing keeps its grants.
  const rows: RoleRow[] = React.useMemo(() => {
    if (!data) return [];
    const out: RoleRow[] = [];
    for (const name of Object.keys(data.matrix)) {
      const builtin = BUILTIN_ROLES.has(name);
      const grants = data.matrix[name] ?? {};
      out.push({
        name,
        builtin,
        description: builtin ? '' : (customRoles.get(name)?.description ?? ''),
        resourceCount: Object.keys(grants).length,
        custom: builtin ? undefined : customRoles.get(name),
      });
    }
    // Built-ins first (in their canonical order), then custom roles alphabetically.
    const order = (r: RoleRow) =>
      r.builtin ? Object.keys(roleLabelOrder).indexOf(r.name) : 1000;
    out.sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      if (a.builtin && b.builtin) return order(a) - order(b);
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [data, customRoles]);

  const openCreate = () => setEditor({ draft: emptyDraft(), mode: 'create' });

  const openClone = (row: RoleRow) => {
    // Seed a draft from a base role (inherit it) OR an existing custom role's grants.
    if (row.builtin) {
      setEditor({
        draft: { ...emptyDraft(), name: '', inherits: [row.name] },
        mode: 'create',
      });
    } else {
      const base = draftFromRow(row, data?.matrix ?? {});
      setEditor({ draft: { ...base, name: '' }, mode: 'create' });
    }
  };

  const openEdit = (row: RoleRow) => {
    setEditor({ draft: draftFromRow(row, data?.matrix ?? {}), mode: 'edit' });
  };

  const remove = async (row: RoleRow) => {
    setBusy(true);
    try {
      await rolesApi.remove(row.name);
      setCustomRoles((m) => {
        const next = new Map(m);
        next.delete(row.name);
        return next;
      });
      toast.success(`Deleted ${row.name}.`);
      await load();
    } catch (e) {
      toast.error(errMsg(e, 'Could not delete the role.'));
    } finally {
      setBusy(false);
    }
  };

  const onSaved = (role: CustomRole) => {
    setCustomRoles((m) => new Map(m).set(role.name, role));
    setEditor(null);
    void load();
  };

  const columns: DataTableColumn<RoleRow>[] = [
    {
      id: 'name',
      header: 'Role',
      cell: (r) => (
        <div className="flex items-center gap-2">
          {r.builtin ? (
            <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden />
          )}
          <span className="font-medium text-foreground">{roleLabel(r.name)}</span>
          {r.builtin ? (
            <Badge variant="secondary" className="text-2xs">
              Built-in
            </Badge>
          ) : (
            <Badge variant="info" className="text-2xs">
              Custom
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: 'description',
      header: 'Description',
      cell: (r) => (
        <span className="text-sm text-muted-foreground">
          {r.builtin ? 'Platform-defined role' : r.description || '—'}
        </span>
      ),
    },
    {
      id: 'resources',
      header: 'Resources',
      align: 'center',
      cell: (r) => <span className="tabular-nums text-sm text-foreground">{r.resourceCount}</span>,
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => openClone(r)}
            disabled={busy || !canManage}
            aria-label={`Clone ${r.name}`}
            title="Clone into a new custom role"
          >
            <Copy className="h-4 w-4" aria-hidden />
          </Button>
          {!r.builtin && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => openEdit(r)}
                disabled={busy || !canManage}
                aria-label={`Edit ${r.name}`}
                title="Edit"
              >
                <Pencil className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-critical hover:text-critical"
                onClick={() => setDeleteRow(r)}
                disabled={busy || !canManage}
                aria-label={`Delete ${r.name}`}
                title="Delete"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        embedded={embedded}
        icon={ShieldCheck}
        eyebrow="Administration"
        title="Roles & permissions"
        description="Define custom RBAC roles on a resource × action matrix. Built-in roles are immutable."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
              Refresh
            </Button>
            <Button size="sm" onClick={openCreate} disabled={!canManage}>
              <Plus className="h-4 w-4" aria-hidden />
              New custom role
            </Button>
          </div>
        }
      />

      {perms && perms.rbac_enabled ? (
        <Alert>
          <ShieldCheck className="h-4 w-4" aria-hidden />
          <AlertTitle>
            You are signed in as {roleLabel(perms.role)}
            {perms.custom_roles.length ? ` (+ ${perms.custom_roles.length} custom)` : ''}
          </AlertTitle>
          <AlertDescription>
            You hold {Object.keys(perms.permissions).length} resource grants.
            {canManage
              ? ' You can create, edit, and delete custom roles.'
              : ' You can view roles but not modify them.'}
          </AlertDescription>
        </Alert>
      ) : perms && !perms.rbac_enabled ? (
        <Alert variant="warning">
          <AlertTitle>RBAC is disabled</AlertTitle>
          <AlertDescription>
            Every authenticated user is treated as a super admin. Enable RBAC in Security
            settings to enforce these roles.
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <LoadError
          error={error}
          title="Couldn't load roles"
          onRetry={() => void load()}
        />
      ) : (
        <DataTable<RoleRow>
          columns={columns}
          rows={rows}
          getRowId={(r) => r.name}
          loading={loading}
          ariaLabel="RBAC roles"
          empty="No roles yet."
        />
      )}

      <SimulatePanel roles={Object.keys(data?.matrix ?? {})} />

      {editor ? (
        <RoleEditorDialog
          mode={editor.mode}
          initial={editor.draft}
          matrix={data?.matrix ?? {}}
          existingNames={new Set(Object.keys(data?.matrix ?? {}))}
          onClose={() => setEditor(null)}
          onSaved={onSaved}
        />
      ) : null}

      <ConfirmDialog
        open={!!deleteRow}
        onOpenChange={(open) => {
          if (!open) setDeleteRow(null);
        }}
        destructive
        title={deleteRow ? `Delete custom role "${deleteRow.name}"?` : 'Delete custom role?'}
        description="Users still holding it fall back to the default role."
        confirmLabel="Delete"
        onConfirm={() => {
          const r = deleteRow;
          setDeleteRow(null);
          if (r) void remove(r);
        }}
      />
    </div>
  );
}

// --------------------------------------------------------------------------- //
// The create/edit dialog: matrix editor + a live preview diff before apply.
// --------------------------------------------------------------------------- //
function RoleEditorDialog({
  mode,
  initial,
  matrix,
  existingNames,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial: RoleDraft;
  matrix: Record<string, GrantMap>;
  existingNames: Set<string>;
  onClose: () => void;
  onSaved: (role: CustomRole) => void;
}) {
  const [draft, setDraft] = React.useState<RoleDraft>(initial);
  const [preview, setPreview] = React.useState<RolePreviewResponse | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const nameTaken =
    mode === 'create' && draft.name.trim() !== '' && existingNames.has(draft.name.trim());
  const nameIsBuiltin = BUILTIN_ROLES.has(draft.name.trim());
  const canSubmit = draft.name.trim().length > 0 && !nameTaken && !nameIsBuiltin;

  const runPreview = async () => {
    if (!draft.name.trim()) {
      toast.error('Give the role a name first.');
      return;
    }
    setPreviewing(true);
    try {
      const res = await rolesApi.preview({
        name: draft.name.trim(),
        description: draft.description,
        inherits: draft.inherits,
        grants: draft.grants,
        denies: draft.denies,
      });
      setPreview(res);
    } catch (e) {
      toast.error(errMsg(e, 'Preview failed.'));
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        name: draft.name.trim(),
        description: draft.description,
        inherits: draft.inherits,
        grants: draft.grants,
        denies: draft.denies,
      };
      const res =
        mode === 'create' ? await rolesApi.create(body) : await rolesApi.update(body);
      toast.success(`${mode === 'create' ? 'Created' : 'Updated'} ${res.role.name}.`);
      onSaved(res.role);
    } catch (e) {
      toast.error(errMsg(e, 'Could not save the role.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New custom role' : `Edit ${initial.name}`}</DialogTitle>
          <DialogDescription>
            Toggle each cell: not set → grant → deny. Preview the resolved permissions before
            applying.
          </DialogDescription>
        </DialogHeader>

        <RoleMatrixEditor
          draft={draft}
          onChange={(next) => {
            setDraft(next);
            setPreview(null); // a change invalidates the prior preview
          }}
          matrix={matrix}
          disabled={saving}
        />

        {nameTaken ? (
          <Alert variant="warning">
            <AlertDescription>
              A role named <strong>{draft.name.trim()}</strong> already exists. Use the Edit
              action on that row instead.
            </AlertDescription>
          </Alert>
        ) : null}
        {nameIsBuiltin ? (
          <Alert variant="warning">
            <AlertDescription>
              <strong>{draft.name.trim()}</strong> is a built-in role and cannot be redefined.
            </AlertDescription>
          </Alert>
        ) : null}

        {preview ? <PreviewDiff preview={preview} /> : null}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => void runPreview()} disabled={previewing || saving}>
            {previewing ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <ArrowRight className="h-4 w-4" aria-hidden />
            )}
            Preview
          </Button>
          <Button onClick={() => void save()} disabled={!canSubmit || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {mode === 'create' ? 'Create role' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- //
// Preview diff: resolved effective grants + per-resource added/removed actions.
// --------------------------------------------------------------------------- //
export function PreviewDiff({ preview }: { preview: RolePreviewResponse }) {
  const diffEntries = Object.entries(preview.diff);
  const effectiveSummary = RESOURCE_ORDER.filter((r) => preview.effective[r]?.length)
    .map((r) => `${r}: ${preview.effective[r].join(', ')}`)
    .join('\n');

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Resolved permissions</h3>
        {preview.is_new ? (
          <Badge variant="info">New role</Badge>
        ) : (
          <Badge variant="secondary">Existing</Badge>
        )}
      </div>

      {diffEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No change vs the current matrix for this role.
        </p>
      ) : (
        <div className="space-y-1.5" data-testid="preview-diff">
          {diffEntries.map(([resource, diff]) => (
            <div key={resource} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-[8rem] font-medium text-foreground">
                {humanizeToken(resource)}
              </span>
              {diff.added.map((a) => (
                <Badge key={`+${a}`} variant="success">
                  +{a}
                </Badge>
              ))}
              {diff.removed.map((a) => (
                <Badge key={`-${a}`} variant="critical">
                  −{a}
                </Badge>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Effective grants
        </Label>
        <CodeBlock
          value={effectiveSummary || '(no grants)'}
          caption={`${preview.name} · resource: actions`}
          wrap
          maxHeightClassName="max-h-48"
        />
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Simulate panel: a single role × resource × action can() spot-check.
// --------------------------------------------------------------------------- //
function SimulatePanel({
  roles,
}: {
  roles: string[];
}) {
  const [role, setRole] = React.useState('');
  const [resource, setResource] = React.useState('cases');
  const [action, setAction] = React.useState('read');
  const [result, setResult] = React.useState<SimulateResponse | null>(null);
  const [busy, setBusy] = React.useState(false);

  const run = async () => {
    if (!role) {
      toast.error('Pick a role to simulate.');
      return;
    }
    setBusy(true);
    try {
      const res = await rolesApi.simulate(role, resource.trim(), action.trim());
      setResult(res);
    } catch (e) {
      toast.error(errMsg(e, 'Simulation failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md">
      <CardContent className="space-y-4 pt-6">
      <div className="flex items-center gap-2">
        <FlaskConical className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">Permission spot-check</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Resolve whether a role is allowed a single resource × action against the live matrix.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1.5">
          <Label>Role</Label>
          <Select value={role || undefined} onValueChange={setRole}>
            <SelectTrigger aria-label="Role to simulate">
              <SelectValue placeholder="— role —" />
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
        <div className="space-y-1.5">
          <Label>Resource</Label>
          <Select value={resource} onValueChange={(v) => setResource(v)}>
            <SelectTrigger aria-label="Resource">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RESOURCE_ORDER.map((r) => (
                <SelectItem key={r} value={r}>
                  {humanizeToken(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Action</Label>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger aria-label="Action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Offer the resource's FULL action vocabulary (not just what the
                  selected role already grants) so a DENIED action can be simulated
                  too — super_admin resolves to ['*'] and must not collapse to one. */}
              {Array.from(new Set([...(RESOURCE_ACTIONS[resource] ?? []), action]))
                .filter((a) => a !== '*')
                .map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button onClick={() => void run()} disabled={busy} className="w-full">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Simulate
          </Button>
        </div>
      </div>

      {result ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-4 py-3">
          <Badge variant={result.allowed ? 'success' : 'critical'}>
            {result.allowed ? 'Allowed' : 'Denied'}
          </Badge>
          <span className="text-sm text-foreground">
            {roleLabel(result.role)} → {result.resource}:{result.action}
          </span>
          <span className="text-xs text-muted-foreground">
            Actions on {result.resource}: {result.actions.length ? result.actions.join(', ') : '(none)'}
            {!result.known_resource ? ' · unknown resource' : ''}
            {!result.role_exists ? ' · role not found' : ''}
          </span>
        </div>
      ) : null}
      </CardContent>
    </Card>
  );
}
