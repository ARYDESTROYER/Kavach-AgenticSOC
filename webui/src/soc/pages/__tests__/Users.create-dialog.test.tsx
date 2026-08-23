/**
 * Round 11 — the redesigned Add-user dialog + MFA visibility on the Users table.
 *
 * Covers:
 *   - the full create payload: profile/contact fields, the `mfa_required` mandate,
 *     and creation-time `custom_roles` (the options-object client signature);
 *   - LIVE role-permission visibility: the read-only per-resource summary tracks the
 *     selected role (incl. the full-access shape for super_admin);
 *   - client-LENIENT email handling (the server is the validation authority);
 *   - inline fine-graining: "Adjust permissions…" creates a custom role seeded with
 *     `inherits:[selectedBaseRole]` and auto-attaches it;
 *   - the table's MFA column: enrolled → On, mandated-but-unenrolled → Required.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { usersListMock, usersCreateMock, usersUpdateMock, rolesGetMock, rolesCreateMock } =
  vi.hoisted(() => ({
    usersListMock: vi.fn(),
    usersCreateMock: vi.fn(),
    usersUpdateMock: vi.fn(),
    rolesGetMock: vi.fn(),
    rolesCreateMock: vi.fn(),
  }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      users: {
        list: usersListMock,
        create: usersCreateMock,
        update: usersUpdateMock,
        remove: vi.fn(),
      },
      roles: { get: rolesGetMock },
    },
  };
});

vi.mock('../Roles.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Roles.api')>();
  return { ...actual, rolesApi: { ...actual.rolesApi, create: rolesCreateMock } };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: 'admin',
    authEnabled: true,
    hasPermission: () => true,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { toast } from 'sonner';
import { TooltipProvider } from '@/ui/tooltip';
import Users from '../Users';
import { RESOURCE_ACTIONS } from '../Roles.api';
import type { User } from '@/lib/types';

const USERS = [
  {
    username: 'alice',
    role: 'analyst_tier1',
    active: true,
    created_at: '2026-06-01T00:00:00Z',
    last_login_at: null,
    must_change_password: false,
    mfa_enabled: true,
    mfa_required: false,
    display_name: 'Alice A',
    email: 'alice@example.com',
  },
  {
    username: 'bob',
    role: 'responder',
    active: true,
    created_at: '2026-06-01T00:00:00Z',
    last_login_at: null,
    must_change_password: false,
    mfa_enabled: false,
    mfa_required: true,
  },
  {
    username: 'erin',
    role: 'auditor',
    active: true,
    created_at: '2026-06-01T00:00:00Z',
    last_login_at: null,
    must_change_password: false,
    mfa_enabled: true,
    mfa_required: true,
  },
  {
    username: 'frank',
    role: 'auditor',
    active: true,
    created_at: '2026-06-01T00:00:00Z',
    last_login_at: null,
    must_change_password: false,
    mfa_enabled: false,
    mfa_required: false,
  },
] as unknown as User[];

const MATRIX = {
  // The super_admin shape the backend resolves: wildcard on every resource.
  super_admin: Object.fromEntries(Object.keys(RESOURCE_ACTIONS).map((r) => [r, ['*']])),
  soc_manager: { cases: ['read', 'write', 'close'], sources: ['read', 'manage'] },
  analyst_tier1: { cases: ['read', 'comment'], playbooks: ['read', 'run'] },
  tier1_plus: { cases: ['*'] },
};

function renderUsers() {
  return render(
    <TooltipProvider>
      <Users />
    </TooltipProvider>,
  );
}

async function openAddDialog() {
  renderUsers();
  await screen.findByText('alice');
  fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
  return within(await screen.findByRole('dialog', { name: 'Add user' }));
}

describe('Users — Add-user dialog (Round 11)', () => {
  beforeEach(() => {
    usersListMock.mockReset();
    usersCreateMock.mockReset();
    usersUpdateMock.mockReset();
    rolesGetMock.mockReset();
    rolesCreateMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    usersListMock.mockResolvedValue({ users: USERS });
    rolesGetMock.mockResolvedValue({
      roles: ['super_admin', 'soc_manager', 'analyst_tier1'],
      default_role: 'analyst_tier1',
      rbac_enabled: true,
      matrix: MATRIX,
    });
    usersCreateMock.mockResolvedValue({ ok: true, user: {} });
  });

  it('submits the full create payload — profile, mandate, and custom roles', async () => {
    const dialog = await openAddDialog();

    fireEvent.change(dialog.getByLabelText(/^username/i), { target: { value: ' carol ' } });
    fireEvent.change(dialog.getByLabelText(/full name/i), { target: { value: 'Carol Danvers' } });
    fireEvent.change(dialog.getByLabelText(/email/i), { target: { value: 'carol@example.com' } });
    fireEvent.change(dialog.getByLabelText(/mobile number/i), { target: { value: '+91 98765 43210' } });
    fireEvent.change(dialog.getByLabelText('Temporary password'), {
      target: { value: 'Str0ngTemp!1' },
    });
    // Mandate MFA for the new account.
    fireEvent.click(dialog.getByRole('switch', { name: /require multi-factor/i }));
    // Attach an existing custom role at creation.
    const chip = dialog.getByRole('button', { name: 'tier1_plus' });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(usersCreateMock).toHaveBeenCalledWith({
        username: 'carol',
        password: 'Str0ngTemp!1',
        role: 'analyst_tier1',
        display_name: 'Carol Danvers',
        email: 'carol@example.com',
        phone: '+91 98765 43210',
        mfa_required: true,
        custom_roles: ['tier1_plus'],
      }),
    );
  });

  it('shows a LIVE permission summary that follows the selected role', async () => {
    const dialog = await openAddDialog();

    // Default role: Analyst — Tier 1. The summary shows its exploded grants.
    const summary = dialog.getByTestId('role-permission-summary');
    expect(within(summary).getByText('Analyst — Tier 1 grants')).toBeInTheDocument();
    expect(within(summary).getByText('comment')).toBeInTheDocument();
    expect(within(summary).getByText('run')).toBeInTheDocument();
    expect(within(summary).queryByText('close')).not.toBeInTheDocument();

    // Switch to SOC manager → the summary updates without any refetch.
    fireEvent.click(dialog.getByRole('combobox', { name: 'Role' }));
    fireEvent.click(await screen.findByRole('option', { name: 'SOC manager' }));
    await waitFor(() =>
      expect(within(dialog.getByTestId('role-permission-summary')).getByText('SOC manager grants')).toBeInTheDocument(),
    );
    expect(within(dialog.getByTestId('role-permission-summary')).getByText('close')).toBeInTheDocument();

    // Super admin resolves to the full-wildcard row → one honest full-access line.
    fireEvent.click(dialog.getByRole('combobox', { name: 'Role' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Super admin' }));
    expect(
      await dialog.findByText(/full administrative access — every action on every resource/i),
    ).toBeInTheDocument();
  });

  it('stays lenient about email format client-side — the server is the authority', async () => {
    const dialog = await openAddDialog();

    fireEvent.change(dialog.getByLabelText(/^username/i), { target: { value: 'dave' } });
    fireEvent.change(dialog.getByLabelText(/email/i), { target: { value: 'not-an-email' } });
    fireEvent.change(dialog.getByLabelText('Temporary password'), {
      target: { value: 'Str0ngTemp!1' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));

    // No client-side email gate: the request goes out and any 400 surfaces as a toast.
    await waitFor(() =>
      expect(usersCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'dave', email: 'not-an-email' }),
      ),
    );
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('creates a custom role inline (seeded from the base role) and auto-attaches it', async () => {
    rolesCreateMock.mockResolvedValue({
      ok: true,
      role: {
        name: 'tier1_custom',
        description: '',
        inherits: ['analyst_tier1'],
        grants: {},
        denies: {},
      },
    });
    const dialog = await openAddDialog();

    fireEvent.click(dialog.getByRole('button', { name: /adjust permissions/i }));
    const editor = within(await screen.findByRole('dialog', { name: 'Adjust permissions' }));

    // Seeded to START from the selected base role.
    expect(editor.getByRole('button', { name: 'Analyst — Tier 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.change(editor.getByLabelText('Role name'), { target: { value: 'tier1_custom' } });
    fireEvent.click(editor.getByRole('button', { name: /create role & attach/i }));

    await waitFor(() =>
      expect(rolesCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'tier1_custom', inherits: ['analyst_tier1'] }),
      ),
    );
    // Back in the add-user dialog the new role is offered AND already attached.
    const addDialog = within(await screen.findByRole('dialog', { name: 'Add user' }));
    await waitFor(() =>
      expect(addDialog.getByRole('button', { name: 'tier1_custom' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  it('surfaces MFA state as VISIBLE text — On, On · required, Required, and Off', async () => {
    renderUsers();
    await screen.findByText('alice');
    // alice: enrolled, no mandate → plain "On".
    expect(screen.getByText('On')).toBeInTheDocument();
    // erin: enrolled AND mandated — the mandate is visible text, not a
    // title-attribute tooltip (mouse-only).
    expect(screen.getByText('On · required')).toBeInTheDocument();
    // bob: mandated-but-unenrolled keeps the warning.
    expect(screen.getByText('Required')).toBeInTheDocument();
    // frank: unenrolled, no mandate → a visible muted "Off" (never a bare dash).
    expect(screen.getByText('Off')).toBeInTheDocument();
    // Full name / email render as plain secondary text (#9 — never markup).
    expect(screen.getByText('Alice A · alice@example.com')).toBeInTheDocument();
  });

  it('edits the MFA mandate both ways from the edit-user dialog', async () => {
    usersUpdateMock.mockResolvedValue({ ok: true, user: {} });
    renderUsers();
    await screen.findByText('alice');

    fireEvent.click(screen.getByRole('button', { name: 'Edit bob' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit user' }));

    // Seeded from the row: bob is mandated → the switch starts ON; toggling it OFF
    // clears the mandate (both directions ride PUT /users/{u} mfa_required).
    const sw = dialog.getByRole('switch', { name: /require multi-factor/i });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(usersUpdateMock).toHaveBeenCalledWith(
        'bob',
        expect.objectContaining({ mfa_required: false }),
      ),
    );
  });
});
