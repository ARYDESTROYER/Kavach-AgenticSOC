/**
 * Round 11 — MfaSetupCard `pendingToken` mode (mandated MFA enrollment DURING login).
 *
 * With a pending token there is NO session yet, so the card must:
 *   - AUTO-start enrollment via the PUBLIC /auth/mfa/enroll-setup (never /mfa/setup),
 *     rendering the secret + otpauth URI + recovery codes at the setup step;
 *   - confirm via /auth/mfa/enroll-confirm and treat success as a COMPLETED LOGIN
 *     (`onComplete` receives the verify-shaped LoginResult);
 *   - hide the mid-flow Cancel affordance (the parent owns the only exits);
 *   - surface an expired/invalid pending token (401) via `onPendingExpired`, while a
 *     wrong TOTP code stays an inline retryable error;
 *   - gate the submit behind an explicit "I have saved my recovery codes" ack: a
 *     successful confirm IS the login and destroys the only copy of the codes.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { setupMock, confirmMock, enrollSetupMock, enrollConfirmMock } = vi.hoisted(() => ({
  setupMock: vi.fn(),
  confirmMock: vi.fn(),
  enrollSetupMock: vi.fn(),
  enrollConfirmMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    api: {
      auth: {
        mfa: {
          setup: setupMock,
          confirm: confirmMock,
          enrollSetup: enrollSetupMock,
          enrollConfirm: enrollConfirmMock,
          disable: vi.fn(),
        },
      },
    },
  };
});
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(true) }));

import { MfaSetupCard } from '../MfaSetupCard';
import { ApiError } from '@/lib/api';

const SETUP_PAYLOAD = {
  secret: 'PENDSECRET23456789',
  otpauth_uri: 'otpauth://totp/Acme%20SOC:bob?secret=PENDSECRET23456789',
  recovery_codes: ['aaaa-1111', 'bbbb-2222'],
};

describe('MfaSetupCard — pendingToken (login-phase mandated enrollment)', () => {
  beforeEach(() => {
    setupMock.mockReset();
    confirmMock.mockReset();
    enrollSetupMock.mockReset();
    enrollConfirmMock.mockReset();
    enrollSetupMock.mockResolvedValue({ ...SETUP_PAYLOAD });
  });

  it('auto-starts via enroll-setup (never the session endpoint) and shows recovery codes', async () => {
    render(<MfaSetupCard enabled={false} frameless pendingToken="pend-7" />);

    // Auto-start: no "Enable two-factor" click needed; rerouted to the enroll route.
    await waitFor(() => expect(enrollSetupMock).toHaveBeenCalledWith('pend-7'));
    expect(setupMock).not.toHaveBeenCalled();

    // Secret + URI + recovery codes render at the setup step (shown ONLY here).
    expect(await screen.findByText('PENDSECRET23456789')).toBeInTheDocument();
    expect(screen.getByText(/otpauth:\/\/totp\/Acme%20SOC:bob/)).toBeInTheDocument();
    expect(screen.getByText('aaaa-1111')).toBeInTheDocument();
    expect(screen.getByText('bbbb-2222')).toBeInTheDocument();

    // The confirm button reads as a login completion, and there is NO mid-flow
    // Cancel (there is no session to fall back into — the parent owns the exits).
    expect(screen.getByRole('button', { name: 'Verify & sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('confirms via enroll-confirm and hands the LoginResult to onComplete', async () => {
    const loginResult = {
      token: 't-1',
      user: { username: 'bob', role: 'analyst_tier1', must_change_password: false, mfa_enabled: true },
    };
    enrollConfirmMock.mockResolvedValue(loginResult);
    const onComplete = vi.fn();
    const onChanged = vi.fn();

    render(
      <MfaSetupCard
        enabled={false}
        frameless
        pendingToken="pend-7"
        onComplete={onComplete}
        onChanged={onChanged}
      />,
    );
    await screen.findByText('PENDSECRET23456789');

    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '654321' },
    });
    // The saved-recovery-codes ack is required before the login-completing confirm.
    fireEvent.click(screen.getByLabelText(/saved my recovery codes/i));
    fireEvent.click(screen.getByRole('button', { name: 'Verify & sign in' }));

    await waitFor(() => expect(enrollConfirmMock).toHaveBeenCalledWith('pend-7', '654321'));
    expect(confirmMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(loginResult));
    // The login-phase completion path is onComplete, not the session-mode callback.
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('gates "Verify & sign in" on the saved-recovery-codes acknowledgment', async () => {
    enrollConfirmMock.mockResolvedValue({ token: 't-1', user: { username: 'bob' } });
    render(<MfaSetupCard enabled={false} frameless pendingToken="pend-7" />);
    await screen.findByText('PENDSECRET23456789');

    // Code alone is NOT enough: success would immediately destroy the only copy
    // of the recovery codes, so the explicit ack must be ticked too.
    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '654321' },
    });
    const submit = screen.getByRole('button', { name: 'Verify & sign in' });
    expect(submit).toBeDisabled();

    const ack = screen.getByLabelText(/saved my recovery codes/i);
    fireEvent.click(ack);
    expect(screen.getByRole('button', { name: 'Verify & sign in' })).toBeEnabled();

    // Un-ticking re-disables — the gate is the checkbox, not a one-shot flag.
    fireEvent.click(ack);
    expect(screen.getByRole('button', { name: 'Verify & sign in' })).toBeDisabled();
  });

  it('suppresses the confirm-input autoFocus in pendingToken mode (reading order starts at the setup steps)', async () => {
    render(<MfaSetupCard enabled={false} frameless pendingToken="pend-7" />);
    await screen.findByText('PENDSECRET23456789');
    // The parent (login) owns focus on its mode heading; the code input must not
    // yank focus past the QR/secret/recovery-codes steps when the payload lands.
    expect(screen.getByLabelText(/enter the 6-digit code/i)).not.toHaveFocus();
  });

  it('reports an expired pending token at setup via onPendingExpired', async () => {
    enrollSetupMock.mockRejectedValue(new ApiError(401, 'invalid or expired pending session'));
    const onPendingExpired = vi.fn();

    render(
      <MfaSetupCard enabled={false} frameless pendingToken="pend-7" onPendingExpired={onPendingExpired} />,
    );

    await waitFor(() => expect(onPendingExpired).toHaveBeenCalled());
  });

  it('keeps a wrong code retryable (inline error, NOT onPendingExpired)', async () => {
    enrollConfirmMock.mockRejectedValue(new ApiError(401, 'invalid code'));
    const onPendingExpired = vi.fn();
    const onComplete = vi.fn();

    render(
      <MfaSetupCard
        enabled={false}
        frameless
        pendingToken="pend-7"
        onComplete={onComplete}
        onPendingExpired={onPendingExpired}
      />,
    );
    await screen.findByText('PENDSECRET23456789');

    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByLabelText(/saved my recovery codes/i));
    fireEvent.click(screen.getByRole('button', { name: 'Verify & sign in' }));

    expect(await screen.findByText('invalid code')).toBeInTheDocument();
    expect(onPendingExpired).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    // The form is still there for another attempt while the pending token lives.
    expect(screen.getByRole('button', { name: 'Verify & sign in' })).toBeInTheDocument();
  });

  it('treats a dead pending token at confirm as expiry (message names the pending session)', async () => {
    enrollConfirmMock.mockRejectedValue(new ApiError(401, 'invalid or expired pending session'));
    const onPendingExpired = vi.fn();

    render(
      <MfaSetupCard enabled={false} frameless pendingToken="pend-7" onPendingExpired={onPendingExpired} />,
    );
    await screen.findByText('PENDSECRET23456789');

    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '654321' },
    });
    fireEvent.click(screen.getByLabelText(/saved my recovery codes/i));
    fireEvent.click(screen.getByRole('button', { name: 'Verify & sign in' }));

    await waitFor(() => expect(onPendingExpired).toHaveBeenCalled());
  });

  it('does not auto-start or reroute WITHOUT a pending token (session mode unchanged)', async () => {
    setupMock.mockResolvedValue({ ...SETUP_PAYLOAD });
    render(<MfaSetupCard enabled={false} frameless />);
    // No auto-start: the explicit action button renders and nothing was called.
    expect(screen.getByRole('button', { name: /enable two-factor/i })).toBeInTheDocument();
    expect(setupMock).not.toHaveBeenCalled();
    expect(enrollSetupMock).not.toHaveBeenCalled();

    // Session-authed enrollment keeps its existing flow: no saved-codes ack gate
    // (Cancel + re-setup remain available), and the code alone enables the submit.
    fireEvent.click(screen.getByRole('button', { name: /enable two-factor/i }));
    await screen.findByText('PENDSECRET23456789');
    expect(screen.queryByLabelText(/saved my recovery codes/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '654321' },
    });
    expect(screen.getByRole('button', { name: 'Verify & enable' })).toBeEnabled();
  });
});
