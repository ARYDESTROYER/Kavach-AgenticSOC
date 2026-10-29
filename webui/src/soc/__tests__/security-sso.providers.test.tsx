/**
 * Single sign-on & policy (Round 14 review fixes, SPEC §4.9.2 and §4.9.6).
 *
 * - Every OIDC provider value is a labelled Settings row: each input's accessible name is
 *   its visible label (WCAG 1.3.1 and 2.5.3), never a placeholder.
 * - The client secret uses the shared write-only `SecretField` and saves on its own.
 * - The Posture group states what the backend enforces now: its single sign-on row reads
 *   the saved settings, never the unsaved draft.
 * - Lists are typed key by key: the allowlists are tag fields (a typed comma or space adds
 *   an entry and is never eaten), the group to role map keeps its text exactly as typed and
 *   reports a line it cannot use instead of dropping it.
 * - A failed client-secret write keeps the typed secret so it can be retried.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { setSecretMock } = vi.hoisted(() => ({ setSecretMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      auth: { ...actual.api.auth, sso: { setSecret: setSecretMock } },
      setup: { status: vi.fn().mockResolvedValue({}) },
    },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ authEnabled: true, rbacEnabled: true, role: 'super_admin', hasPermission: () => true }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import type { Preferences } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { OrgSecuritySection } from '@/soc/pages/settings/security';
import { normaliseAllowList, parseGroupRoleMap } from '@/soc/pages/Security';

const PROVIDERS = [
  { id: 'generic-a', type: 'generic', enabled: true, display_name: 'Acme IdP', client_id: 'cid', allowed_domains: [], allowed_tenants: [], group_role_map: {} },
  { id: 'microsoft-b', type: 'microsoft', enabled: true, display_name: '', client_id: '', tenant: 'organizations', allowed_domains: [], allowed_tenants: [], group_role_map: {} },
];

function renderSection(draftSso: unknown, savedSso: unknown) {
  const update = vi.fn();
  render(
    <TooltipProvider>
      <OrgSecuritySection
        prefs={{ sso: draftSso } as unknown as Preferences}
        persistedPrefs={{ sso: savedSso } as unknown as Preferences}
        update={update}
        configured={{}}
      />
    </TooltipProvider>,
  );
  return update;
}

describe('SSO provider editor', () => {
  it('names every provider input by its visible label', () => {
    renderSection({ enabled: true, providers: PROVIDERS }, { enabled: true, providers: PROVIDERS });
    const generic = screen.getByRole('group', { name: 'Acme IdP' });
    for (const label of ['Display name', 'Client ID', 'Discovery URL', 'Client secret', 'Allowed domains', 'Allowed tenants', 'Group claim', 'Group to role map']) {
      const input = within(generic).getByLabelText(label);
      expect(input).toHaveAccessibleName(label);
    }
    expect(within(generic).getByRole('combobox', { name: 'Default role' })).toBeInTheDocument();
    expect(within(generic).getByRole('switch', { name: 'Provider enabled' })).toBeChecked();
    expect(within(generic).getByRole('switch', { name: 'Create an account on first sign-in' })).not.toBeChecked();
    // The Microsoft provider shows its tenant row; neither shows a placeholder-only input.
    const microsoft = screen.getByRole('group', { name: 'Microsoft' });
    expect(within(microsoft).getByLabelText('Tenant')).toHaveValue('organizations');
    for (const input of document.querySelectorAll('input, textarea')) {
      expect(input).toHaveAccessibleName();
    }
  });

  it('writes an edited field into the draft and saves the secret on its own', async () => {
    setSecretMock.mockResolvedValue({ configured: true });
    const update = renderSection({ enabled: true, providers: PROVIDERS }, { enabled: true, providers: PROVIDERS });
    const generic = screen.getByRole('group', { name: 'Acme IdP' });
    fireEvent.change(within(generic).getByLabelText('Group claim'), { target: { value: 'roles' } });
    const patch = update.mock.calls.at(-1)?.[0] as { sso: { providers: Array<{ group_claim: string }> } };
    expect(patch.sso.providers[0].group_claim).toBe('roles');

    const secret = within(generic).getByLabelText('Client secret');
    fireEvent.change(secret, { target: { value: 's3cret' } });
    fireEvent.click(within(generic).getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(setSecretMock).toHaveBeenCalledWith('generic-a', 's3cret'));
    // Stored, so the field empties; the secret never rides the Settings draft.
    await waitFor(() => expect(secret).toHaveValue(''));
    expect(JSON.stringify(update.mock.calls)).not.toContain('s3cret');
  });

  it('keeps the typed client secret when the write fails, so it can be retried', async () => {
    setSecretMock.mockRejectedValueOnce(new Error('The secret store is not reachable.'));
    renderSection({ enabled: true, providers: PROVIDERS }, { enabled: true, providers: PROVIDERS });
    const generic = screen.getByRole('group', { name: 'Acme IdP' });
    const secret = within(generic).getByLabelText('Client secret');
    fireEvent.change(secret, { target: { value: 's3cret' } });
    const save = within(generic).getByRole('button', { name: 'Save secret' });
    fireEvent.click(save);
    await waitFor(() => expect(setSecretMock).toHaveBeenCalledWith('generic-a', 's3cret'));
    await waitFor(() => expect(save).toBeEnabled());
    expect(secret).toHaveValue('s3cret');
  });

  it('states the single sign-on posture from the saved settings, not the draft', () => {
    renderSection({ enabled: true, providers: PROVIDERS }, { enabled: false, providers: [] });
    const posture = screen.getByRole('group', { name: 'Posture' });
    const row = within(posture).getByText('Single sign-on').closest('[data-setting-row]') as HTMLElement;
    expect(row).toHaveTextContent('Off');
    expect(row).not.toHaveTextContent('On, 2 providers');
  });
});

/** The Settings page in miniature: the draft is state, so every edit re-renders the editor. */
function StatefulSection({ initial }: { initial: Preferences }) {
  const [prefs, setPrefs] = React.useState(initial);
  const update = React.useCallback((patch: Partial<Preferences>) => setPrefs((p) => ({ ...p, ...patch })), []);
  return (
    <TooltipProvider>
      <OrgSecuritySection prefs={prefs} persistedPrefs={initial} update={update} configured={{}} />
      <output data-testid="draft">{JSON.stringify(prefs.sso)}</output>
    </TooltipProvider>
  );
}

type DraftProvider = { allowed_domains: string[]; allowed_tenants: string[]; group_role_map: Record<string, string> };

function draftProvider(index = 0): DraftProvider {
  const sso = JSON.parse(screen.getByTestId('draft').textContent ?? '{}') as { providers: DraftProvider[] };
  return sso.providers[index];
}

function mountStateful() {
  const user = userEvent.setup();
  render(<StatefulSection initial={{ sso: { enabled: true, providers: PROVIDERS } } as unknown as Preferences} />);
  return { user, generic: screen.getByRole('group', { name: 'Acme IdP' }) };
}

describe('SSO provider lists, typed key by key', () => {
  it('adds each allowed domain on a typed comma or space, keeping both', async () => {
    const { user, generic } = mountStateful();
    const input = within(generic).getByLabelText('Allowed domains');
    await user.type(input, 'acme.com, sub.acme.com{Enter}');
    expect(draftProvider().allowed_domains).toEqual(['acme.com', 'sub.acme.com']);
    const chips = within(generic).getAllByRole('list')[0];
    expect(within(chips).getByText('acme.com')).toBeInTheDocument();
    expect(within(chips).getByText('sub.acme.com')).toBeInTheDocument();
    // Nothing is left half-typed in the field.
    expect(input).toHaveValue('');
  });

  it('splits a pasted list of tenants into one entry each', async () => {
    const { user, generic } = mountStateful();
    const input = within(generic).getByLabelText('Allowed tenants');
    await user.click(input);
    await user.paste('tenant-a,tenant-b TENANT-A');
    await user.keyboard('{Enter}');
    expect(draftProvider().allowed_tenants).toEqual(['tenant-a', 'tenant-b']);
  });

  it('refuses an email address as an allowed domain and says why', async () => {
    const { user, generic } = mountStateful();
    const input = within(generic).getByLabelText('Allowed domains');
    await user.type(input, 'ana@acme.com{Enter}');
    expect(draftProvider().allowed_domains).toEqual([]);
    expect(within(generic).getByRole('alert')).toHaveTextContent('Enter the domain only, such as acme.com, without a name or @.');
    expect(input).toHaveValue('ana@acme.com');
  });

  it('keeps every typed line of the group to role map and stores both mappings', async () => {
    const { user, generic } = mountStateful();
    const map = within(generic).getByLabelText('Group to role map');
    await user.type(map, 'soc-admins=super_admin{Enter}analysts=analyst_tier2');
    expect(map).toHaveValue('soc-admins=super_admin\nanalysts=analyst_tier2');
    expect(draftProvider().group_role_map).toEqual({ 'soc-admins': 'super_admin', analysts: 'analyst_tier2' });
    // While the person types there is no error; leaving the field finds none either.
    await user.tab();
    expect(within(generic).queryByText(/is not a role|write it as group=role/)).toBeNull();
  });

  it('reports a line it cannot use once focus leaves, and never drops the text', async () => {
    const { user, generic } = mountStateful();
    const map = within(generic).getByLabelText('Group to role map');
    await user.type(map, 'a=super_admin{Enter}b{Enter}c=super_adminb');
    // Mid-edit: the text is exactly as typed and no error interrupts.
    expect(map).toHaveValue('a=super_admin\nb\nc=super_adminb');
    expect(map).not.toHaveAttribute('aria-invalid', 'true');
    await user.tab();
    expect(map).toHaveValue('a=super_admin\nb\nc=super_adminb');
    expect(map).toHaveAttribute('aria-invalid', 'true');
    expect(map).toHaveClass('border-critical');
    expect(map).toHaveAccessibleDescription(
      expect.stringContaining('Line 2: write it as group=role. Line 3: super_adminb is not a role. Those lines are not saved.'),
    );
    // Only the line that reads correctly is stored; the role is never silently changed.
    expect(draftProvider().group_role_map).toEqual({ a: 'super_admin' });
  });

  it('reports a group mapped twice and keeps the first mapping', () => {
    expect(parseGroupRoleMap('soc=auditor\n\nsoc=super_admin')).toEqual({
      map: { soc: 'auditor' },
      problems: ['Line 3: soc is already mapped on line 1.'],
    });
    // A group named like an object key stays data.
    const parsed = parseGroupRoleMap('__proto__=auditor');
    expect(Object.keys(parsed.map)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(parsed.map)).toBe(Object.prototype);
  });

  it('follows the stored map when it changes from outside, such as a discard', () => {
    const provider = (map: Record<string, string>) => ({ ...PROVIDERS[0], group_role_map: map });
    const view = (map: Record<string, string>) => (
      <TooltipProvider>
        <OrgSecuritySection
          prefs={{ sso: { enabled: true, providers: [provider(map)] } } as unknown as Preferences}
          update={vi.fn()}
          configured={{}}
        />
      </TooltipProvider>
    );
    const { rerender } = render(view({ analysts: 'analyst_tier2' }));
    expect(screen.getByLabelText('Group to role map')).toHaveValue('analysts=analyst_tier2');
    rerender(view({ admins: 'super_admin', auditors: 'auditor' }));
    expect(screen.getByLabelText('Group to role map')).toHaveValue('admins=super_admin\nauditors=auditor');
  });

  it('cleans an allowlist: one entry per item, blanks and case-only repeats dropped', () => {
    expect(normaliseAllowList(['Acme.com', ' ', 'sub.acme.com, acme.COM', 'x.io y.io'])).toEqual([
      'Acme.com',
      'sub.acme.com',
      'x.io',
      'y.io',
    ]);
  });
});
