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
  rolesGet: vi.fn(),
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
      roles: { get: () => mocks.rolesGet() },
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
  mocks.rolesGet.mockResolvedValue({ matrix: {}, rbac_enabled: false });
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
    // Round 14 (SE14): the tiers are rows on ONE group panel, divided by hairlines, never
    // three boxed cards.
    const panels = screen.getByTestId('danger-zone').querySelectorAll('[data-settings-panel]');
    expect(panels).toHaveLength(1);
    tiers.forEach((tier) => {
      expect(panels[0].contains(tier)).toBe(true);
      expect(tier.className).not.toMatch(/rounded|shadow|bg-card|bg-surface|border/);
    });
    expect(screen.getByRole('button', { name: 'Reset cases and logs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset sources and logs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Factory reset' })).toBeInTheDocument();
  });

  it('arms the destructive button ONLY on the exact confirm token (cases tier)', async () => {
    renderDangerZone();
    await screen.findByTestId('danger-zone');
    const dialog = await openTier('Reset cases and logs');

    const input = within(dialog).getByPlaceholderText('RESET CASES') as HTMLInputElement;
    // The CTA inside the dialog carries the tier title too.
    const confirmBtn = within(dialog).getByRole('button', { name: 'Reset cases and logs' });

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
    let dialog = await openTier('Reset sources and logs');
    let input = within(dialog).getByPlaceholderText('RESET SOURCES') as HTMLInputElement;
    let cta = within(dialog).getByRole('button', { name: 'Reset sources and logs' });
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
    const dialog = await openTier('Reset cases and logs');
    const input = within(dialog).getByPlaceholderText('RESET CASES');
    fireEvent.change(input, { target: { value: 'RESET CASES' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset cases and logs' }));

    await waitFor(() =>
      expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'tiered_reset',
        params: { scope: 'cases', confirm: 'RESET CASES' },
      })),
    );
    expect(mocks.submit.mock.calls[0][0].idempotency_key).toMatch(/^tiered_reset-/);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Reset cases and logs job accepted.',
      expect.objectContaining({
        description: expect.stringMatching(/outcome remains in Inbox/i),
        action: expect.objectContaining({ label: 'Open Inbox' }),
      }),
    );
  });

  it("returns focus to the tier's button when its dialog is cancelled, closed or accepted (SPEC §3.3)", async () => {
    mocks.submit.mockResolvedValue({
      job_id: 'job-reset', kind: 'tiered_reset', actor: 'operator',
      created_at: '2026-08-13T00:00:00Z', status: 'queued',
      progress: { done: 0, total: 1, unit: 'reset' }, failures: [], failure_count: 0,
      failures_truncated: 0, request_fingerprint: 'd'.repeat(64), params: {}, cancel_requested: false,
    });
    renderDangerZone();
    const zone = await screen.findByTestId('danger-zone');
    const tierButton = within(zone).getByRole('button', { name: 'Reset sources and logs' });

    // Cancel.
    tierButton.focus();
    fireEvent.click(tierButton);
    let dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(tierButton));

    // Escape.
    fireEvent.click(tierButton);
    dialog = screen.getByRole('dialog');
    fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(tierButton));

    // Accepted: the job is queued and the dialog closes.
    fireEvent.click(tierButton);
    dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('RESET SOURCES'), { target: { value: 'RESET SOURCES' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset sources and logs' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(tierButton));
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
    const dialog = await openTier('Reset cases and logs');
    const input = within(dialog).getByPlaceholderText('RESET CASES');
    fireEvent.change(input, { target: { value: 'RESET CASES' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset cases and logs' }));

    await screen.findByText(/Re-authentication was required and not completed/i);
    // No success dialog.
    expect(screen.queryByText('Reset complete')).not.toBeInTheDocument();
  });
  it('uses outline destructive buttons on the page and a solid red button only in the dialog (SE14)', async () => {
    renderDangerZone();
    await screen.findByTestId('danger-zone');
    for (const name of ['Reset cases and logs', 'Reset sources and logs', 'Factory reset']) {
      const pageButton = screen.getByRole('button', { name });
      expect(pageButton.className).toContain('border-critical/60');
      expect(pageButton.className).toContain('text-critical-text');
      expect(pageButton.className).not.toMatch(/(^|\s)bg-critical(\s|$)/);
    }
    const dialog = await openTier('Factory reset');
    const confirm = within(dialog).getByRole('button', { name: 'Factory reset' });
    expect(confirm.className).toMatch(/(^|\s)bg-critical(\s|$)/);
  });

  it('labels the consequence lists in sentence case, without capitals or em dashes', async () => {
    renderDangerZone();
    const zone = await screen.findByTestId('danger-zone');
    expect(within(zone).getAllByText('Clears')).toHaveLength(3);
    expect(within(zone).getAllByText('Keeps')).toHaveLength(3);
    expect(zone.innerHTML).not.toMatch(/uppercase|tracking-wide/);
    expect(zone.textContent ?? '').not.toContain('\u2014');
    expect(zone.textContent ?? '').not.toMatch(/OOBE/);
    const dialog = await openTier('Reset sources and logs');
    expect(dialog.textContent ?? '').not.toContain('\u2014');
    expect(within(dialog).getByText('Clears')).toBeInTheDocument();
  });

  it('renders nothing without the users:manage grant', async () => {
    mocks.authMe.mockResolvedValue({
      auth_enabled: true,
      authenticated: true,
      user: { username: 'viewer', role: 'viewer' },
    });
    mocks.rolesGet.mockResolvedValue({
      rbac_enabled: true,
      matrix: { viewer: { cases: ['read'], settings: ['read'] } },
    });
    renderDangerZone();
    await waitFor(() => expect(mocks.rolesGet).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('danger-zone')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Factory reset' })).toBeNull();
  });
});
