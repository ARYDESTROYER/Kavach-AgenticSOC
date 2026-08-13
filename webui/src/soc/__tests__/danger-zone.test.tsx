/**
 * DangerZone tests (Round 4, Wave 5, request #7).
 *
 * Verifies the tiered platform-reset UI:
 *   - all three tiers render as super_admin (auth OFF → <Can> transparent);
 *   - each tier's destructive button ARMS only on the EXACT type-to-confirm token
 *     (a near-miss / wrong-tier phrase / trailing junk keeps it disabled; a leading/
 *     trailing-whitespace-trimmed exact match arms it);
 *   - confirming submits one `tiered_reset` durable job with the right scope/phrase;
 *   - the destructive work never runs in the browser.
 *
 * Offline — the shared api client is mocked; no network. The component renders inside
 * the real AuthProvider with `auth.me` reporting auth OFF, so `hasPermission` returns
 * true and the whole surface is visible (the login-off default MUST stay navigable).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const mocks = {
  submit: vi.fn(),
  authMe: vi.fn(),
  toastSuccess: vi.fn(),
};

vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => mocks.toastSuccess(...args) },
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      jobs: { submit: (body: unknown) => mocks.submit(body) },
      auth: { me: () => mocks.authMe() },
      roles: { get: vi.fn().mockResolvedValue({ matrix: {}, rbac_enabled: false }) },
    },
  };
});

import { AuthProvider } from '../auth';
import { DangerZone } from '../components/DangerZone';
import { ApiError } from '@/lib/api';

function renderDangerZone() {
  return render(
    <AuthProvider>
      <DangerZone />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Auth OFF → hasPermission() returns true, so <Can> renders everything.
  mocks.authMe.mockResolvedValue({ auth_enabled: false, authenticated: false, user: null });
  mocks.submit.mockReset();
  mocks.toastSuccess.mockReset();
});

/** Open a tier's confirm dialog by clicking its card button, then return the dialog. */
async function openTier(title: string): Promise<HTMLElement> {
  // Two controls share the tier title (card button + dialog CTA); the card button is
  // present first. Click the first match to open the dialog.
  const buttons = await screen.findAllByRole('button', { name: title });
  fireEvent.click(buttons[0]);
  return screen.getByRole('dialog');
}

describe('DangerZone', () => {
  it('renders all three reset tiers', async () => {
    renderDangerZone();
    await waitFor(() => expect(screen.getByTestId('danger-zone')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Danger zone', level: 2 })).toBeInTheDocument();
    const tiers = screen.getByTestId('danger-zone').querySelectorAll('[data-settings-tier]');
    expect(tiers).toHaveLength(3);
    tiers.forEach((tier) => {
      expect(tier.className).not.toMatch(/rounded|shadow|bg-card|bg-surface/);
    });
    expect(screen.getByRole('button', { name: 'Reset cases & logs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset sources + logs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Factory reset' })).toBeInTheDocument();
  });

  it('arms the destructive button ONLY on the exact confirm token (cases tier)', async () => {
    renderDangerZone();
    await screen.findByTestId('danger-zone');
    const dialog = await openTier('Reset cases & logs');

    const input = within(dialog).getByPlaceholderText('RESET CASES') as HTMLInputElement;
    // The CTA inside the dialog carries the tier title too.
    const confirmBtn = within(dialog).getByRole('button', { name: 'Reset cases & logs' });

    // Disabled by default.
    expect(confirmBtn).toBeDisabled();

    // Wrong phrase → still disabled.
    fireEvent.change(input, { target: { value: 'reset cases' } });
    expect(confirmBtn).toBeDisabled();

    // Right words but the WRONG tier's phrase → still disabled.
    fireEvent.change(input, { target: { value: 'RESET SOURCES' } });
    expect(confirmBtn).toBeDisabled();

    // Trailing junk → still disabled.
    fireEvent.change(input, { target: { value: 'RESET CASES!' } });
    expect(confirmBtn).toBeDisabled();

    // Exact phrase (leading/trailing whitespace is trimmed) → armed.
    fireEvent.change(input, { target: { value: '  RESET CASES  ' } });
    expect(confirmBtn).not.toBeDisabled();
  });

  it('arms each tier only on its OWN token (sources + factory)', async () => {
    renderDangerZone();
    await screen.findByTestId('danger-zone');

    // Sources tier.
    let dialog = await openTier('Reset sources + logs');
    let input = within(dialog).getByPlaceholderText('RESET SOURCES') as HTMLInputElement;
    let cta = within(dialog).getByRole('button', { name: 'Reset sources + logs' });
    fireEvent.change(input, { target: { value: 'RESET CASES' } });
    expect(cta).toBeDisabled();
    fireEvent.change(input, { target: { value: 'RESET SOURCES' } });
    expect(cta).not.toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // Factory tier.
    dialog = await openTier('Factory reset');
    input = within(dialog).getByPlaceholderText('FACTORY RESET') as HTMLInputElement;
    cta = within(dialog).getByRole('button', { name: 'Factory reset' });
    fireEvent.change(input, { target: { value: 'RESET SOURCES' } });
    expect(cta).toBeDisabled();
    fireEvent.change(input, { target: { value: 'FACTORY RESET' } });
    expect(cta).not.toBeDisabled();
  });

  it('submits the correct durable reset job and closes the confirm dialog', async () => {
    mocks.submit.mockResolvedValue({
      job_id: 'job-reset', kind: 'tiered_reset', actor: 'operator',
      created_at: '2026-08-13T00:00:00Z', status: 'queued',
      progress: { done: 0, total: 1, unit: 'reset' }, failures: [], failure_count: 0,
      failures_truncated: 0, request_fingerprint: 'd'.repeat(64), params: {}, cancel_requested: false,
    });
    renderDangerZone();
    await screen.findByTestId('danger-zone');
    const dialog = await openTier('Reset cases & logs');
    const input = within(dialog).getByPlaceholderText('RESET CASES');
    fireEvent.change(input, { target: { value: 'RESET CASES' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset cases & logs' }));

    await waitFor(() =>
      expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'tiered_reset',
        params: { scope: 'cases', confirm: 'RESET CASES' },
      })),
    );
    expect(mocks.submit.mock.calls[0][0].idempotency_key).toMatch(/^tiered_reset-/);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Reset cases & logs job accepted.',
      expect.objectContaining({
        description: expect.stringMatching(/outcome remains in Inbox/i),
        action: expect.objectContaining({ label: 'Open Inbox' }),
      }),
    );
  });

  it('discloses factory privacy semantics and never promises a personal Inbox result', async () => {
    mocks.submit.mockResolvedValue({
      job_id: 'job-factory', kind: 'tiered_reset', actor: 'operator',
      created_at: '2026-08-13T00:00:00Z', status: 'queued',
      progress: { done: 0, total: 1, unit: 'reset' }, failures: [], failure_count: 0,
      failures_truncated: 0, request_fingerprint: 'e'.repeat(64), params: {}, cancel_requested: false,
    });
    renderDangerZone();
    await screen.findByTestId('danger-zone');
    const dialog = await openTier('Factory reset');

    expect(within(dialog).getByText(/Personalisation, historical Jobs, personal Inbox/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/identity-free operational reset receipt/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Personal Inbox history is erased/i)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByPlaceholderText('FACTORY RESET'), {
      target: { value: 'FACTORY RESET' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Factory reset' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Factory reset job accepted.',
      {
        description:
          'The server will quiesce work, clear personal state and retain only a sanitized system receipt.',
      },
    );
  });

  it('surfaces a cancelled step-up re-auth (401) without wiping anything', async () => {
    mocks.submit.mockRejectedValue(new ApiError(401, 'reauth required', { code: 'reauth_required' }));
    renderDangerZone();
    await screen.findByTestId('danger-zone');
    const dialog = await openTier('Reset cases & logs');
    const input = within(dialog).getByPlaceholderText('RESET CASES');
    fireEvent.change(input, { target: { value: 'RESET CASES' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset cases & logs' }));

    await screen.findByText(/Re-authentication was required and not completed/i);
    // No success dialog.
    expect(screen.queryByText('Reset complete')).not.toBeInTheDocument();
  });
});
