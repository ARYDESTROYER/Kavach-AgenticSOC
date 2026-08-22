/**
 * RolePermissionSummary — a compact, read-only "what does this role grant?" panel
 * (Round 11 / user-creation visibility).
 *
 * Renders the RESOLVED matrix row for one role (from GET /api/roles) grouped by
 * resource, with granted actions as small chips, so an admin SEES what a role
 * grants before assigning it. Wildcards are exploded client-side against the
 * RESOURCE_ACTIONS mirror (the same vocabulary the RoleMatrixEditor grid uses);
 * a resource the mirror does not know keeps an honest literal "all actions" chip
 * instead of silently disappearing — drift can never hide a grant again.
 *
 * Purely presentational: no network, no mutation. Role/resource/action names are
 * operator-influenceable → rendered as PLAIN text only (#9).
 */
import { ShieldCheck } from 'lucide-react';
import { humanizeToken } from '@/lib/format';
import { RESOURCE_ACTIONS, RESOURCE_ORDER, roleLabel, type GrantMap } from '@/soc/pages/Roles.api';

/** One summarised resource row: the resource plus its concrete granted actions. */
export interface RoleGrantRow {
  resource: string;
  /** Concrete actions (wildcards exploded); `['all actions']` for an unknown-vocabulary wildcard. */
  actions: string[];
}

/** Explode a grant list for one resource: "*" → the resource's full action vocabulary. */
function explodeActions(resource: string, actions: string[]): string[] {
  const literal = actions.filter((a) => a !== '*');
  if (literal.length === actions.length) return literal;
  const vocab = RESOURCE_ACTIONS[resource];
  if (!vocab) return literal.length ? literal : ['all actions'];
  // Union the vocabulary with any literal extras, preserving vocabulary order.
  return [...vocab, ...literal.filter((a) => !vocab.includes(a))];
}

/**
 * Summarise one role's resolved matrix row into ordered per-resource rows
 * (known resources in canonical order first, then unknowns alphabetically).
 * Pure — exported for tests and for any other surface that needs the numbers.
 */
export function summarizeRoleGrants(
  matrix: Record<string, GrantMap> | undefined,
  role: string,
): RoleGrantRow[] {
  const row = matrix?.[role];
  if (!row) return [];
  const known = RESOURCE_ORDER.filter((r) => (row[r] ?? []).length > 0);
  const unknown = Object.keys(row)
    .filter((r) => !RESOURCE_ACTIONS[r] && (row[r] ?? []).length > 0)
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...unknown].map((resource) => ({
    resource,
    actions: explodeActions(resource, row[resource] ?? []),
  }));
}

/** True when the role grants every action on every KNOWN resource (super-admin shape). */
export function isFullAccess(rows: RoleGrantRow[]): boolean {
  if (rows.length === 0) return false;
  const byResource = new Map(rows.map((r) => [r.resource, r.actions]));
  return Object.entries(RESOURCE_ACTIONS).every(([resource, vocab]) => {
    const actions = byResource.get(resource);
    return !!actions && vocab.every((a) => actions.includes(a));
  });
}

export interface RolePermissionSummaryProps {
  /** The role whose resolved grants to summarise. (Named `roleName`, not `role`,
   *  so the prop is never mistaken for the ARIA `role` attribute.) */
  roleName: string;
  /** The RESOLVED matrix from GET /api/roles (role → resource → [actions]). */
  matrix: Record<string, GrantMap> | undefined;
  /** Extra scroll-height class for the row list (default `max-h-44`). */
  maxHeightClassName?: string;
}

export function RolePermissionSummary({
  roleName,
  matrix,
  maxHeightClassName = 'max-h-44',
}: RolePermissionSummaryProps) {
  const rows = summarizeRoleGrants(matrix, roleName);
  const full = isFullAccess(rows);
  const actionCount = rows.reduce((n, r) => n + r.actions.length, 0);

  return (
    <div
      data-testid="role-permission-summary"
      role="region"
      aria-label={`Permissions granted by ${roleLabel(roleName)}`}
      className="rounded-md border border-border bg-surface"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-foreground">
          {roleLabel(roleName)} grants
        </span>
        <span className="text-2xs tabular-nums text-muted-foreground">
          {full
            ? 'full access'
            : `${rows.length} resource${rows.length === 1 ? '' : 's'} · ${actionCount} action${
                actionCount === 1 ? '' : 's'
              }`}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          No permissions granted by this role.
        </p>
      ) : full ? (
        <p className="flex items-center gap-1.5 px-3 py-2.5 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          Full administrative access — every action on every resource.
        </p>
      ) : (
        <ul className={`space-y-1.5 overflow-y-auto px-3 py-2.5 ${maxHeightClassName}`}>
          {rows.map(({ resource, actions }) => (
            <li key={resource} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="min-w-[7rem] text-xs font-medium text-foreground">
                {humanizeToken(resource)}
              </span>
              <span className="flex flex-wrap items-center gap-1">
                {actions.map((a) => (
                  <span
                    key={a}
                    className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-2xs leading-4 text-foreground/90"
                  >
                    {a}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default RolePermissionSummary;
