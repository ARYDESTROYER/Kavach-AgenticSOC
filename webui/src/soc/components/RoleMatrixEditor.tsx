/**
 * RoleMatrixEditor — the resource×action grid editor for a CUSTOM RBAC role
 * (Round 3 / Feature 6).
 *
 * A custom role is `{name, description, inherits[], grants{}, denies{}}`. The editor
 * renders one ROW per resource and one CELL per (resource, action) supported by that
 * resource. Each cell is a tri-state toggle:
 *   - neutral   → neither granted nor denied (inherited from base roles applies).
 *   - grant     → ADD this action (resource → [...action]).
 *   - deny      → REMOVE this action (deny wins over any inherited/explicit grant).
 * `inherits[]` (a multi-select over the six built-ins) seeds the role's starting
 * grants; the editor shows the inherited baseline so an operator sees the effect of a
 * grant/deny against it.
 *
 * Everything here is data — names/descriptions/actions are operator-controlled and
 * rendered as PLAIN text (#9). The component is presentational + controlled: it owns
 * no network; the parent (Roles page) persists + previews.
 */
import { Check, Minus, Ban } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Badge } from '@/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/ui/table';
import {
  RESOURCE_ACTIONS,
  RESOURCE_ORDER,
  ROLE_LABELS,
  resourceLabel,
  BUILTIN_ROLES,
  type CustomRole,
  type GrantMap,
} from '@/soc/pages/Roles.api';

/** A draft custom role the editor mutates (same shape, all fields required). */
export type RoleDraft = CustomRole;

export type CellState = 'neutral' | 'grant' | 'deny';

export interface RoleMatrixEditorProps {
  /** The draft being edited (controlled). */
  draft: RoleDraft;
  /** Patch the draft (replace-by-key merge). */
  onChange: (next: RoleDraft) => void;
  /**
   * The full resolved matrix (role → resource → [actions]) for computing the
   * inherited baseline shown behind each cell. Optional; absent → no baseline hints.
   */
  matrix?: Record<string, GrantMap>;
  /** Disable all inputs (e.g. while saving). */
  disabled?: boolean;
}

/** True when `actions` grants `action` (literal or via the "*" wildcard). */
function grants(actions: string[] | undefined, action: string): boolean {
  if (!actions) return false;
  return actions.includes('*') || actions.includes(action);
}

/** The current tri-state for one (resource, action) cell in a draft. */
export function cellState(draft: RoleDraft, resource: string, action: string): CellState {
  if (grants(draft.denies[resource], action)) return 'deny';
  if (grants(draft.grants[resource], action)) return 'grant';
  return 'neutral';
}

/** Cycle neutral → grant → deny → neutral, returning the next draft. */
export function cycleCell(draft: RoleDraft, resource: string, action: string): RoleDraft {
  const state = cellState(draft, resource, action);
  const next: RoleDraft = {
    ...draft,
    grants: { ...draft.grants },
    denies: { ...draft.denies },
  };
  // Remove from both maps first (idempotent), then apply the next state.
  const drop = (map: GrantMap, key: string) => {
    const cur = (map[key] ?? []).filter((a) => a !== action);
    if (cur.length) map[key] = cur;
    else delete map[key];
  };
  drop(next.grants, resource);
  drop(next.denies, resource);
  if (state === 'neutral') {
    next.grants[resource] = [...(next.grants[resource] ?? []), action];
  } else if (state === 'grant') {
    next.denies[resource] = [...(next.denies[resource] ?? []), action];
  }
  // state === 'deny' → already dropped to neutral.
  return next;
}

/** The inherited baseline (does any inherited base role grant this action?). */
function inheritedGrant(
  draft: RoleDraft,
  matrix: Record<string, GrantMap> | undefined,
  resource: string,
  action: string,
): boolean {
  if (!matrix) return false;
  return draft.inherits.some((base) => grants(matrix[base]?.[resource], action));
}

const CELL_META: Record<
  CellState,
  { icon: typeof Check; cls: string; ring: string; label: string }
> = {
  neutral: {
    icon: Minus,
    cls: 'text-muted-foreground/40 hover:text-muted-foreground',
    ring: 'border-border bg-transparent',
    label: 'not set',
  },
  grant: {
    icon: Check,
    cls: 'text-success',
    ring: 'border-success/40 bg-success/10',
    label: 'granted',
  },
  deny: {
    icon: Ban,
    cls: 'text-critical',
    ring: 'border-critical/40 bg-critical/10',
    label: 'denied',
  },
};

export function RoleMatrixEditor({
  draft,
  onChange,
  matrix,
  disabled,
}: RoleMatrixEditorProps) {
  // The widest action set determines the grid columns; resources only render the
  // cells they support, so the others stay empty in the row.
  const maxActions = Math.max(...RESOURCE_ORDER.map((r) => RESOURCE_ACTIONS[r].length));
  const actionCols = Array.from({ length: maxActions }, (_, i) => i);

  const toggleInherit = (base: string) => {
    const has = draft.inherits.includes(base);
    onChange({
      ...draft,
      inherits: has ? draft.inherits.filter((b) => b !== base) : [...draft.inherits, base],
    });
  };

  return (
    <div className="space-y-5">
      {/* --- identity --- */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="role-name">Role name</Label>
          <Input
            id="role-name"
            value={draft.name}
            placeholder="e.g. tier1_plus_approvals"
            disabled={disabled}
            // Bound the operator-supplied identifier; the server cleans it too.
            maxLength={64}
            onChange={(e) =>
              onChange({ ...draft, name: e.target.value.replace(/[^a-zA-Z0-9_.-]/g, '_') })
            }
          />
          <p className="text-xs text-muted-foreground">
            Letters, digits, and <code>_ . -</code>. Cannot match a built-in role.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="role-desc">Description</Label>
          <Input
            id="role-desc"
            value={draft.description}
            placeholder="What this role is for"
            maxLength={200}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
          />
        </div>
      </div>

      {/* --- inherits (base roles to start from) --- */}
      <div className="space-y-2">
        <Label>Inherits from</Label>
        <div className="flex flex-wrap gap-2">
          {Array.from(BUILTIN_ROLES)
            .map((base) => {
              const on = draft.inherits.includes(base);
              return (
                <button
                  key={base}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleInherit(base)}
                  aria-pressed={on}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    on
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border bg-surface text-muted-foreground hover:text-foreground',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  {ROLE_LABELS[base]}
                </button>
              );
            })}
        </div>
        <p className="text-xs text-muted-foreground">
          The role starts with every grant of the selected base roles; your grants ADD
          to that and your denies REMOVE from it (deny wins).
        </p>
      </div>

      {/* --- the resource × action grid --- */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <Table aria-label="Custom role permission matrix">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-44">Resource</TableHead>
                {/* Actions are positional + heterogeneous per resource (cases has 6,
                    users has 1), so a numbered "Action N" header would falsely imply
                    the columns align by action across rows. Each cell self-labels with
                    its own action name; a single spanning header states the truth. */}
                <TableHead className="text-center" colSpan={actionCols.length}>
                  Permissions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {RESOURCE_ORDER.map((resource) => {
                const actions = RESOURCE_ACTIONS[resource];
                return (
                  <TableRow key={resource} className="hover:bg-transparent">
                    <TableCell className="whitespace-nowrap font-medium text-foreground">
                      {resourceLabel(resource)}
                    </TableCell>
                    {actionCols.map((i) => {
                      const action = actions[i];
                      if (!action) {
                        return <TableCell key={i} aria-hidden />;
                      }
                      const state = cellState(draft, resource, action);
                      const inherited =
                        state === 'neutral' &&
                        inheritedGrant(draft, matrix, resource, action);
                      const meta = CELL_META[state];
                      const Icon = meta.icon;
                      return (
                        <TableCell key={i} className="text-center">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                disabled={disabled}
                                onClick={() => onChange(cycleCell(draft, resource, action))}
                                aria-label={`${resource}:${action} — ${meta.label}${
                                  inherited ? ' (inherited)' : ''
                                }`}
                                className={cn(
                                  'mx-auto flex h-7 w-full max-w-[7rem] items-center justify-center gap-1 ' +
                                    'rounded-md border px-2 text-xs font-medium transition-colors',
                                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                  meta.ring,
                                  inherited && 'border-dashed border-info/40',
                                  disabled && 'cursor-not-allowed opacity-60',
                                )}
                              >
                                <Icon className={cn('h-3.5 w-3.5', meta.cls)} aria-hidden />
                                <span className="truncate text-foreground/90">{action}</span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <span>
                                {resource}:{action} — {meta.label}
                                {inherited ? ' · inherited from a base role' : ''}
                              </span>
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* --- legend --- */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 text-success" aria-hidden /> Granted
        </span>
        <span className="flex items-center gap-1.5">
          <Ban className="h-3.5 w-3.5 text-critical" aria-hidden /> Denied (wins)
        </span>
        <span className="flex items-center gap-1.5">
          <Minus className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden /> Not set
        </span>
        <Badge variant="info" className="border-dashed">
          dashed = inherited
        </Badge>
      </div>
    </div>
  );
}

export default RoleMatrixEditor;
