/**
 * Round 14 FX7e fix: the step-up dialog, driven end to end through the real api
 * client. A gated request opens the dialog; a wrong password at POST /api/auth/reauth
 * answers `401 {code:'reauth_required', reason:'bad_password'}` with no message, and
 * the dialog says the password is not correct (never the step-up label "Sign in again
 * to continue.", which tells someone already signing in to sign in). The right
 * password then retries the gated request exactly once.
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { request } from '@/lib/api';
import { ReauthDialog } from '../ReauthDialog';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReauthDialog with the real api client', () => {
  it('a wrong password says so, and the right one retries the gated request once', async () => {
    const fetchMock = vi.fn()
      // The gated request: the session is valid but the action needs a fresh sign-in.
      .mockResolvedValueOnce(jsonResponse(401, { detail: { code: 'reauth_required', reason: 'stale_authn' } }))
      // The wrong password.
      .mockResolvedValueOnce(jsonResponse(401, { detail: { code: 'reauth_required', reason: 'bad_password' } }))
      // The right password, then the retried request.
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(200, { saved: true }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ReauthDialog active />);

    let gated!: Promise<unknown>;
    await act(async () => {
      gated = request('PUT', 'settings', { body: { a: 1 } });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your identity' });
    expect(dialog).toHaveAccessibleDescription('Sign in again to confirm this change.');

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/reauth');
    expect(await screen.findByRole('alert')).toHaveTextContent('That password is not correct. Try again.');
    expect(screen.queryByText('Sign in again to continue.')).toBeNull();

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'right-password' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    await expect(gated).resolves.toEqual({ saved: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][0]).toBe('/api/settings');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
