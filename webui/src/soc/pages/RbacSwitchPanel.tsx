/**
 * The role-based access switch on Roles & permissions (Round 15 SPEC D1.1, D1.4).
 *
 * One "Role-based access" group at the top of the section: the state ("On", or "Off:
 * every signed-in account is treated as Super admin"), the active accounts per role when
 * the caller may see them, and one button that turns it on or off after a confirmation.
 * The change is `PUT /api/rbac` (a verified Super admin with a strict fresh sign-in;
 * the shared sign-in-again dialog opens when the server asks for one). On success the
 * Console re-reads the session (`auth.refresh()`), so every RBAC-aware surface (the
 * Security posture row, the Remember-me note, navigation) follows at once, and the
 * section re-reads its roles.
 *
 * The button is disabled, with the reason as visible text, when the server names a
 * blocker (sign-in off, not a Super admin, read-only settings). The server stays the
 * authority: a refusal it answers is shown as a toast. Role names are rendered as text.
 */
import * as React from 'react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api';
import { rbacApi } from '@/lib/api-rbac';
import type { RbacBlocker, RbacStatus } from '@/lib/types-rbac';
import { LoadingGlyph, StatusDot } from '@/design-system';
import { Button } from '@/ui/button';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { useAuth } from '@/soc/auth';

import { BUILTIN_ROLES, roleLabel } from './Roles.api';
import { SettingRow, SettingsGroup } from './settings/primitives';

/** The visible reason for each blocker (the server's own wording for sign-in off). */
export const RBAC_BLOCKER_TEXT: Record<RbacBlocker, string> = {
  auth_off: 'Turn on sign-in first. Role-based access has no effect while sign-in is off.',
  not_super_admin: 'Only a Super admin can turn role-based access on or off.',
  read_only_settings: 'Settings are in read-only mode.',
};

export const RBAC_STATE_ON = 'On';
export const RBAC_STATE_OFF = 'Off: every signed-in account is treated as Super admin';

const BUILTIN_ORDER = ['super_admin', 'soc_manager', 'analyst_tier2', 'analyst_tier1', 'responder', 'auditor'];

/** "Active accounts: Super admin (1), Analyst Tier 1 (3)." in role order, or null. */
export function roleCountsCaption(counts: Record<string, number> | null | undefined): string | null {
  if (!counts) return null;
  const names = Object.keys(counts).filter((name) => (counts[name] ?? 0) > 0);
  if (!names.length) return null;
  const rank = (name: string) => {
    const index = BUILTIN_ORDER.indexOf(name);
    return index < 0 ? BUILTIN_ORDER.length : index;
  };
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const parts = names.map(
    (name) => `${BUILTIN_ROLES.has(name) ? roleLabel(name) : name} (${(counts[name] ?? 0).toLocaleString()})`,
  );
  return `Active accounts: ${parts.join(', ')}.`;
}

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

export interface RbacSwitchPanelProps {
  /** Called after the state changed (the section re-reads its roles). */
  onChanged?: () => void;
}

export function RbacSwitchPanel({ onChanged }: RbacSwitchPanelProps) {
  const { refresh } = useAuth();
  const [status, setStatus] = React.useState<RbacStatus | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [confirm, setConfirm] = React.useState<'on' | 'off' | null>(null);
  const [busy, setBusy] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);

  const load = React.useCallback(async () => {
    setLoadFailed(false);
    try {
      setStatus(await rbacApi.status());
    } catch {
      setLoadFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const apply = async (enabled: boolean) => {
    setBusy(true);
    try {
      const result = await rbacApi.set(enabled);
      setStatus(result);
      // Re-read the session and its grants: the posture row, the Remember-me note and
      // navigation follow the new state without a reload.
      await refresh();
      onChanged?.();
      toast.success(enabled ? 'Role-based access is on.' : 'Role-based access is off.');
    } catch (error) {
      toast.error(message(error, 'Could not change role-based access.'));
      void load();
    } finally {
      setBusy(false);
    }
  };

  const enabled = Boolean(status?.enabled);
  const blockers = Array.isArray(status?.blockers) ? status.blockers : [];
  const reason = blockers.length ? RBAC_BLOCKER_TEXT[blockers[0]] ?? null : null;
  const caption = roleCountsCaption(status?.role_counts);
  const canChange = Boolean(status) && !reason && status?.can_change !== false;

  return (
    <SettingsGroup
      id="rbac-switch"
      title="Role-based access"
      caption={caption ?? undefined}
      action={
        loadFailed ? (
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        ) : (
          <Button
            ref={buttonRef}
            variant="outline"
            size="sm"
            disabled={!canChange || busy}
            onClick={() => setConfirm(enabled ? 'off' : 'on')}
            data-rbac-switch=""
          >
            {busy ? <LoadingGlyph size="sm" className="size-4" aria-hidden /> : null}
            {enabled ? 'Turn off role-based access' : 'Turn on role-based access'}
          </Button>
        )
      }
    >
      <SettingRow
        variant="status"
        label="Enforcement"
        help={
          loadFailed ? (
            'Couldn’t read the current state.'
          ) : reason ? (
            <span data-rbac-blocker="">{reason}</span>
          ) : (
            'Each role sees and does only what its permissions allow.'
          )
        }
        status={
          status ? (
            // `wrap`: on a phone the Off sentence is wider than the row, and a truncated
            // security state has no hover to show the rest.
            <StatusDot wrap tone={enabled ? 'neutral' : 'warning'} data-rbac-state={enabled ? 'on' : 'off'}>
              {enabled ? RBAC_STATE_ON : RBAC_STATE_OFF}
            </StatusDot>
          ) : loadFailed ? null : (
            <span className="text-sm text-muted-foreground">Checking</span>
          )
        }
      />

      <ConfirmDialog
        open={confirm === 'on'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        returnFocusRef={buttonRef}
        title="Turn on role-based access?"
        richDescription
        description={
          <ul className="list-disc space-y-1 pl-5">
            <li>Every account gets its role’s permissions on its next request.</li>
            <li>A background job started by an account that loses a permission stops at its next item.</li>
            <li>An open live stream keeps its topics until it reconnects.</li>
            <li>Whether an account can use Remember me follows its role.</li>
            <li>You stay Super admin.</li>
          </ul>
        }
        confirmLabel="Turn on"
        onConfirm={() => {
          setConfirm(null);
          void apply(true);
        }}
      />

      <ConfirmDialog
        open={confirm === 'off'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        returnFocusRef={buttonRef}
        destructive
        title="Turn off role-based access?"
        description="Every signed-in account will be treated as Super admin, whatever its role."
        confirmLabel="Turn off"
        onConfirm={() => {
          setConfirm(null);
          void apply(false);
        }}
      />
    </SettingsGroup>
  );
}
