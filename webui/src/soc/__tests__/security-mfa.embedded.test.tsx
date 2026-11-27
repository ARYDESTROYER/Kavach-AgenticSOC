/**
 * SecurityMfaInner has two presentation contexts: the Security route and the Settings
 * section. Round 14 (SPEC §4.9.6, D28): inside Settings it is one `SettingsSection`
 * ("Security & two-factor") with one group holding ONE row that states the state and
 * carries the action ("Two-factor authentication · Off · Turn on"); on the Security route
 * the same group sits under the page's own header. The row's action opens the enrollment
 * (or turn-off) flow under it; Cancel or a finished change closes the flow and returns
 * focus to the action. Enrollment behaviour is identical in both contexts.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const refresh = vi.fn().mockResolvedValue(undefined);
const SETUP_PAYLOAD = {
  secret: 'ROWSECRET234567AB',
  otpauth_uri: 'otpauth://totp/Agentic%20SOC:alice?secret=ROWSECRET234567AB',
  recovery_codes: ['gggg-7777', 'hhhh-8888'],
};

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    authEnabled: true,
    isAuthenticated: true,
    username: 'alice',
    refresh,
  }),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    auth: {
      me: vi.fn().mockResolvedValue({ user: { username: 'alice', mfa_enabled: false } }),
      mfa: {
        setup: vi.fn(),
        confirm: vi.fn(),
        disable: vi.fn(),
      },
    },
  },
}));

vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(true) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from '@/lib/api';
import { toast } from 'sonner';
import { SecurityMfaInner } from '../pages/Security';

const TURN_ON = 'Turn on two-factor authentication';
const TURN_OFF = 'Turn off two-factor authentication';

beforeEach(() => {
  vi.mocked(api.auth.me).mockReset();
  vi.mocked(api.auth.me).mockResolvedValue({ user: { username: 'alice', mfa_enabled: false } } as never);
  vi.mocked(api.auth.mfa.setup).mockReset();
  vi.mocked(api.auth.mfa.setup).mockResolvedValue({ ...SETUP_PAYLOAD } as never);
  vi.mocked(api.auth.mfa.disable).mockReset();
  refresh.mockClear();
  vi.mocked(toast.success).mockClear();
});

describe('SecurityMfaInner presentation', () => {
  it('renders the group under the Security page header outside Settings', async () => {
    render(
      <main>
        <h1>Security</h1>
        <SecurityMfaInner />
      </main>,
    );
    await screen.findByRole('button', { name: TURN_ON });
    expect(screen.getByTestId('two-factor-surface')).toHaveAttribute('data-surface', 'standalone');
    // No section title of its own: the page header names the page.
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Authenticator app', level: 3 })).toBeInTheDocument();
    expect(screen.getByText('Two-factor authentication')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('is one Settings section with a section title and a status row inside Settings', async () => {
    render(
      <main>
        <h1>Settings</h1>
        <SecurityMfaInner embedded />
      </main>,
    );
    await screen.findByRole('button', { name: TURN_ON });
    const surface = screen.getByTestId('two-factor-surface');
    expect(surface).toHaveAttribute('data-surface', 'embedded');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Security & two-factor', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Authenticator app', level: 3 })).toBeInTheDocument();
    // "Two-factor authentication · Off": the state in words, never a floating pill.
    const row = screen.getByText('Two-factor authentication').closest('[data-setting-row="status"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('Off');
    expect(screen.queryByText('Disabled')).not.toBeInTheDocument();
  });

  it('shows a retryable failure instead of presenting an unverified disabled state', async () => {
    vi.mocked(api.auth.me).mockRejectedValueOnce(new Error('profile unavailable'));

    render(<SecurityMfaInner embedded />);

    expect(
      await screen.findByText('Could not load two-factor settings'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Off')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: TURN_ON })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: TURN_ON })).toBeInTheDocument();
  });
});

describe('Two-factor as one row (SPEC §4.9.6)', () => {
  it('shows one row, "Two-factor authentication · Off · Turn on", and nothing else at rest', async () => {
    render(<SecurityMfaInner embedded />);
    const action = await screen.findByRole('button', { name: TURN_ON });
    expect(action).toHaveTextContent(/^Turn on$/);
    const surface = screen.getByTestId('two-factor-surface');
    const rows = surface.querySelectorAll('[data-setting-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-setting-row', 'status');
    expect(rows[0]).toHaveTextContent('Two-factor authentication');
    expect(rows[0]).toHaveTextContent('Off');
    expect(rows[0]).toContainElement(action);
    // The card's own trigger never shows: the row owns the action.
    expect(screen.queryByRole('button', { name: 'Turn on two-factor' })).toBeNull();
    expect(api.auth.mfa.setup).not.toHaveBeenCalled();
    expect(document.body.textContent ?? '').not.toMatch(/[\u2013\u2014]/);
  });

  it('opens enrollment from the row, and Cancel closes it with focus back on the action', async () => {
    render(<SecurityMfaInner embedded />);
    fireEvent.click(await screen.findByRole('button', { name: TURN_ON }));
    expect(api.auth.mfa.setup).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('ROWSECRET234567AB')).toBeInTheDocument();
    // While the flow is open the row has no second action.
    expect(screen.queryByRole('button', { name: TURN_ON })).toBeNull();
    const block = screen.getByTestId('two-factor-surface').querySelector('[data-setting-row="block"]') as HTMLElement;
    expect(within(block).getByLabelText(/enter the 6-digit code/i)).toBeInTheDocument();

    fireEvent.click(within(block).getByRole('button', { name: 'Cancel' }));
    const action = await screen.findByRole('button', { name: TURN_ON });
    await waitFor(() => expect(document.activeElement).toBe(action));
    expect(screen.queryByText('ROWSECRET234567AB')).toBeNull();
  });

  it('names the new state on the action that takes focus back as soon as the flow closes', async () => {
    vi.mocked(api.auth.mfa.confirm).mockResolvedValue({ ok: true } as never);
    // Hold the session refresh so the re-read has not happened yet: the server still
    // reports two-factor off when the flow closes.
    let finishRefresh: () => void = () => undefined;
    refresh.mockImplementationOnce(() => new Promise<void>((resolve) => (finishRefresh = resolve)));
    render(<SecurityMfaInner embedded />);
    fireEvent.click(await screen.findByRole('button', { name: TURN_ON }));
    await screen.findByText('ROWSECRET234567AB');
    // Focus starts at the first step, not the code field at the bottom.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByText('1. Scan with your authenticator app')),
    );
    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and turn on' }));

    // The first render after the flow closes already says On and offers Turn off.
    const action = await screen.findByRole('button', { name: TURN_OFF });
    await waitFor(() => expect(document.activeElement).toBe(action));
    expect(screen.queryByRole('button', { name: TURN_ON })).toBeNull();
    const row = screen.getByTestId('two-factor-surface').querySelector('[data-setting-row="status"]');
    expect(row).toHaveTextContent('On');
    expect(api.auth.mfa.confirm).toHaveBeenCalledWith('123456');

    // The quiet re-read then reconciles with the server.
    vi.mocked(api.auth.me).mockResolvedValue({ user: { username: 'alice', mfa_enabled: true } } as never);
    await act(async () => finishRefresh());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Two-factor settings updated.'));
    expect(screen.getByRole('button', { name: TURN_OFF })).toBe(action);
  });

  it('turns two-factor off from the row and returns to one row that says On or Off', async () => {
    vi.mocked(api.auth.me).mockResolvedValue({ user: { username: 'alice', mfa_enabled: true } } as never);
    vi.mocked(api.auth.mfa.disable).mockResolvedValue({ ok: true } as never);
    render(<SecurityMfaInner embedded />);
    const action = await screen.findByRole('button', { name: TURN_OFF });
    expect(action).toHaveTextContent(/^Turn off$/);
    expect(screen.getByTestId('two-factor-surface').querySelector('[data-setting-row="status"]')).toHaveTextContent('On');

    fireEvent.click(action);
    const code = screen.getByLabelText('Enter a current code to turn off two-factor');
    await waitFor(() => expect(document.activeElement).toBe(code));
    vi.mocked(api.auth.me).mockResolvedValue({ user: { username: 'alice', mfa_enabled: false } } as never);
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /turn off two-factor/i }));

    const turnOn = await screen.findByRole('button', { name: TURN_ON });
    await waitFor(() => expect(document.activeElement).toBe(turnOn));
    expect(api.auth.mfa.disable).toHaveBeenCalledWith('123456');
    expect(refresh).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Two-factor settings updated.');
    // The row re-read the state without unmounting into a loading placeholder.
    expect(screen.getByTestId('two-factor-surface').querySelectorAll('[data-setting-row]')).toHaveLength(1);
  });
});
