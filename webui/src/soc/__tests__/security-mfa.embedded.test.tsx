/**
 * SecurityMfaInner has two presentation contexts: the Security route and the Settings
 * section. Round 14 (SPEC §4.9.6, D28): inside Settings it is one `SettingsSection`
 * ("Security & two-factor") with one group whose first row states the state in words
 * ("Two-factor authentication", "Off"); on the Security route the same group sits under
 * the page's own header. Enrollment behaviour is identical in both.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const refresh = vi.fn().mockResolvedValue(undefined);

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
import { SecurityMfaInner } from '../pages/Security';

beforeEach(() => {
  vi.mocked(api.auth.me).mockReset();
  vi.mocked(api.auth.me).mockResolvedValue({ user: { username: 'alice', mfa_enabled: false } } as never);
});

describe('SecurityMfaInner presentation', () => {
  it('renders the group under the Security page header outside Settings', async () => {
    render(
      <main>
        <h1>Security</h1>
        <SecurityMfaInner />
      </main>,
    );
    await screen.findByRole('button', { name: /enable two-factor/i });
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
    await screen.findByRole('button', { name: /enable two-factor/i });
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
    expect(screen.queryByRole('button', { name: /enable two-factor/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /enable two-factor/i })).toBeInTheDocument();
  });
});
