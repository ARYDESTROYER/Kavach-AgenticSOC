/**
 * Round-6 auth-login fixes for the self-service Account page.
 *
 *  - finding 4  (a11y): the "2FA on" badge uses the AA-tuned `text-success-text`
 *    token, not the solid `text-success` fill (which fails 4.5:1 as small text).
 *  - finding 15 (a11y): the read-only Username row is an associated <Input> (label
 *    resolves via htmlFor), not an orphan <Label> over a fake-input <div>.
 *  - finding 14 (inconsistency): a stored timezone that isn't in the option list is
 *    surfaced (never silently blanked), mirroring the Locale handling.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const accountGet = vi.fn();

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status = 0, message = '') {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    api: {
      auth: {
        me: ok({ auth_enabled: true, authenticated: true, user: { username: 'alice', role: 'analyst_tier2' } }),
        logout: ok({ ok: true }),
      },
      roles: { get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }) },
      account: { get: () => accountGet(), put: vi.fn().mockResolvedValue({}), avatar: vi.fn().mockResolvedValue({}) },
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AuthProvider } from '../auth';
import { TooltipProvider } from '@/ui/tooltip';
import Account from '../pages/Account';

function renderAccount() {
  return render(
    <AuthProvider>
      <TooltipProvider>
        <Account onNavigate={vi.fn()} />
      </TooltipProvider>
    </AuthProvider>,
  );
}

const BASE = {
  username: 'alice',
  role: 'analyst_tier2',
  display_name: 'Alice',
  alias: '',
  alt_email: '',
  timezone: '',
  locale: '',
  avatar: '',
  env_managed: false,
};

beforeEach(() => {
  accountGet.mockReset();
});

describe('Account — Round-6 fixes', () => {
  it('states two-factor in words with a success dot, never colour alone (finding 4, Round 14)', async () => {
    accountGet.mockResolvedValue({ ...BASE, mfa_enabled: true });
    renderAccount();
    const status = await screen.findByTestId('profile-mfa-status', undefined, { timeout: 5000 });
    expect(status).toHaveTextContent('On');
    expect(status).toHaveAttribute('data-status-tone', 'success');
    // The words carry the state in the foreground ink (AA), the dot only repeats it.
    expect(status).toHaveClass('text-foreground');
    expect(status).not.toHaveClass('text-success');
  });

  it('associates the read-only Username label with a real input (finding 15)', async () => {
    accountGet.mockResolvedValue({ ...BASE, mfa_enabled: false });
    renderAccount();
    const input = (await screen.findByLabelText('Username', undefined, { timeout: 5000 })) as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(input.value).toBe('alice');
    expect(input).toHaveAttribute('readonly');
  });

  it('surfaces a stored off-list timezone so it is never silently lost (finding 14)', async () => {
    // Pin the option list to a small, known set so the stored zone is genuinely
    // off-list (and the Radix portal isn't the full ~400-zone IANA list).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orig = (Intl as any).supportedValuesOf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Intl as any).supportedValuesOf = (k: string) =>
      k === 'timeZone' ? ['UTC', 'Europe/London', 'America/New_York'] : orig?.(k);
    try {
      // 'Asia/Tokyo' is genuinely OFF the pinned 3-zone list, so only the off-list
      // guard can surface it.
      accountGet.mockResolvedValue({ ...BASE, timezone: 'Asia/Tokyo', mfa_enabled: false });
      renderAccount();
      await screen.findByDisplayValue('Alice', undefined, { timeout: 5000 });
      // The trigger reflects the stored value (a surfaced SelectItem) rather than the
      // "System default" placeholder it would show if the value were silently dropped.
      const trigger = await screen.findByRole('combobox', { name: 'Timezone' }, { timeout: 5000 });
      expect(trigger).toHaveTextContent('Asia/Tokyo');
      expect(trigger).not.toHaveTextContent('System default');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Intl as any).supportedValuesOf = orig;
    }
  });
});
