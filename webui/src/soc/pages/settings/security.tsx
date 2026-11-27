/**
 * Single sign-on & policy settings section (Round-5 Sett-A decomposition; Round 14
 * grouped panels).
 *
 * A read-only posture group (authentication, role-based access and single sign-on, each
 * a status row; role-based access has a Manage action that opens its switch on Roles &
 * permissions, Round 15), the Team activity switch (Round 15), then the admin session
 * policy and OIDC providers (rendered by the embedded `SecuritySsoInner`), controlled by
 * Settings' single save. The SELF-SERVICE MFA
 * lives separately under Account > Security & two-factor.
 */

import { StatusDot } from '@/design-system';
import type { ConfiguredStatus } from '@/lib/types';
import { Button } from '@/ui/button';

import { useAuth } from '@/soc/auth';
import { useNavigateOptional } from '@/soc/router';
import { SecuritySsoInner } from '@/soc/pages/Security';
import { roleLabel } from '@/soc/pages/Roles.api';

import { SettingRow, SettingsGroup, SettingsSection, type SecProps } from './primitives';
import { TeamActivitySettingsGroup } from './team-activity';

export function OrgSecuritySection({
  prefs,
  persistedPrefs,
  update,
  configured,
}: SecProps & {
  /**
   * The last saved settings. The posture group states what the backend enforces now, so
   * its single sign-on row reads the saved block, never the unsaved draft.
   */
  persistedPrefs?: SecProps['prefs'];
  configured: ConfiguredStatus;
}) {
  const { authEnabled, rbacEnabled, role, hasPermission } = useAuth();
  const navigate = useNavigateOptional();
  // The Roles & permissions section needs roles:manage; without it Manage would open a
  // section the rail does not offer.
  const canManageRoles = hasPermission('roles', 'manage');
  const savedSso =
    ((persistedPrefs ?? prefs).sso as { enabled?: boolean; providers?: unknown[] } | undefined) ?? {};
  const providerCount = Array.isArray(savedSso.providers) ? savedSso.providers.length : 0;

  return (
    <SettingsSection title="Single sign-on & policy">
      <SettingsGroup
        title="Posture"
        caption={role ? `What the backend enforces now. You are signed in as ${roleLabel(String(role))}.` : 'What the backend enforces now.'}
      >
        <SettingRow
          variant="status"
          label="Authentication"
          help="Every request needs a signed-in account."
          status={<StatusDot tone={authEnabled ? 'neutral' : 'warning'}>{authEnabled ? 'Enforced' : 'Off'}</StatusDot>}
        />
        {/* Round 15 (SPEC D1.1): the status stays; Manage opens the one switch, on Roles &
            permissions (a section jump keeps the Settings draft). */}
        <SettingRow
          variant="status"
          label="Role-based access"
          help="Each role sees and does only what its permissions allow."
          status={<StatusDot tone={rbacEnabled ? 'neutral' : 'warning'}>{rbacEnabled ? 'Enforced' : 'Off: everyone is Super admin'}</StatusDot>}
          action={
            canManageRoles ? (
              <Button
                variant="outline"
                size="sm"
                aria-label="Manage role-based access"
                onClick={() => navigate('settings', { section: 'roles' })}
              >
                Manage
              </Button>
            ) : null
          }
        />
        <SettingRow
          variant="status"
          label="Single sign-on"
          status={
            <StatusDot>
              {savedSso.enabled ? `On, ${providerCount} ${providerCount === 1 ? 'provider' : 'providers'}` : 'Off'}
            </StatusDot>
          }
        />
      </SettingsGroup>

      {/* Round 15 (SPEC D3.4): the Team activity page switch, saved with the page. */}
      <TeamActivitySettingsGroup prefs={prefs} update={update} />

      {/* Session policy and OIDC providers, controlled by the Settings save. */}
      <SecuritySsoInner prefs={prefs} update={update} configured={configured} embedded />
    </SettingsSection>
  );
}
