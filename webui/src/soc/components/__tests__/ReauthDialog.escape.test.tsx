/**
 * Round-6 auth-login finding 11 — the step-up ReauthDialog must NOT be dismissable
 * via Escape while a re-auth request is in flight (matching the disabled Cancel
 * button). Otherwise settle(false) clears the parked waiters and a request that then
 * succeeds has nothing to retry, so the gated action fails despite a correct password.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const reauthMock = vi.fn();
let capturedGate: ((purpose?: string) => Promise<boolean>) | null = null;

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status = 0, message = '') {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    ApiError,
    setReauthHandler: (fn: ((purpose?: string) => Promise<boolean>) | null) => {
      capturedGate = fn;
    },
    api: { auth: { reauth: (pw: string, code?: string) => reauthMock(pw, code) } },
  };
});

import { ReauthDialog } from '../ReauthDialog';

beforeEach(() => {
  reauthMock.mockReset();
  capturedGate = null;
});

describe('ReauthDialog — Escape guard while busy', () => {
  it('stays open on Escape while a re-auth is in flight', async () => {
    // Keep the request pending so `busy` stays true.
    reauthMock.mockReturnValue(new Promise(() => {}));
    render(<ReauthDialog active />);

    // The dialog registers its gate; open it as the api client would on a 401.
    expect(capturedGate).toBeTruthy();
    await act(async () => {
      void capturedGate!();
    });
    expect(await screen.findByText(/confirm your identity/i)).toBeInTheDocument();

    // Enter a password + submit → the request is in flight (busy).
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Sign in$/i }));
    await waitFor(() => expect(reauthMock).toHaveBeenCalledWith('hunter2', undefined));

    // Escape must be swallowed while busy — the dialog remains open.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' });
    expect(screen.getByText(/confirm your identity/i)).toBeInTheDocument();
  });
});
