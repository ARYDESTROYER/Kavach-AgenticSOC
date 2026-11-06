/**
 * Round 14 FX7e, finding roles-12: the fresh sign-in dialog says what the sign-in is
 * for. An export changes nothing, so its dialog says it exports; a request that names
 * no purpose is a change and says so. The first gated request names the purpose and a
 * request that rides along on the open prompt does not change it. The copy says "sign
 * in again", never "re-authenticate", and claims no "sensitive change" for a read.
 * A wrong password says so (FX7e fix): the server's coded `bad_password` answer must
 * not come back as the dialog's own "sign in again" instruction.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const reauthMock = vi.fn();
let capturedGate: ((purpose?: string) => Promise<boolean>) | null = null;

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status = 0, message = '', body?: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
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

import { ApiError } from '@/lib/api';
import { ReauthDialog } from '../ReauthDialog';

beforeEach(() => {
  reauthMock.mockReset();
  capturedGate = null;
});

/** Open the gate as the api client would on a 401; the result is its parked answer. */
async function openGate(purpose?: string): Promise<{ answer: Promise<boolean> }> {
  expect(capturedGate).toBeTruthy();
  let answer!: Promise<boolean>;
  await act(async () => {
    answer = capturedGate!(purpose);
  });
  return { answer };
}

describe('ReauthDialog purpose wording', () => {
  it('an export says it exports and claims no change', async () => {
    render(<ReauthDialog active />);
    void (await openGate('Sign in again to export audit events.'));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your identity' });
    expect(dialog).toHaveAccessibleDescription('Sign in again to export audit events.');
    expect(dialog.textContent).not.toMatch(/change|re-authenticate|sensitive/i);
  });

  it('a request with no purpose confirms a change', async () => {
    render(<ReauthDialog active />);
    void (await openGate());
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your identity' });
    expect(dialog).toHaveAccessibleDescription('Sign in again to confirm this change.');
    expect(dialog.textContent).not.toMatch(/re-authenticate|sensitive/i);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('the first gated request names the purpose; a request riding along does not change it', async () => {
    render(<ReauthDialog active />);
    const { answer: first } = await openGate('Sign in again to export audit events.');
    const { answer: second } = await openGate();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleDescription('Sign in again to export audit events.');

    reauthMock.mockResolvedValue({ ok: true });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    // The sign-in settles every parked request once it resolves.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the next prompt takes its own purpose, not the last one', async () => {
    render(<ReauthDialog active />);
    const { answer: exportGate } = await openGate('Sign in again to start this export.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(exportGate).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    void (await openGate());
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleDescription('Sign in again to confirm this change.');
  });

  it('a failed sign-in without a server message says so plainly', async () => {
    render(<ReauthDialog active />);
    void (await openGate());
    reauthMock.mockRejectedValue(new Error('boom'));
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(await screen.findByText('Sign-in failed.')).toBeInTheDocument();
  });

  it('a wrong password shows the client sentence and keeps the dialog open to try again', async () => {
    render(<ReauthDialog active />);
    void (await openGate('Sign in again to export audit events.'));
    // The api client words the server's coded `bad_password` answer (the real path is
    // pinned end to end in ReauthDialog.wrong-password.test.tsx).
    reauthMock.mockRejectedValue(
      new ApiError(401, 'That password is not correct. Try again.', {
        detail: { code: 'reauth_required', reason: 'bad_password' },
      }),
    );
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('That password is not correct. Try again.');
    // The dialog stays open on its purpose so the person can try again.
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('Sign in again to export audit events.');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('any other failure keeps the server sentence (an ended session is not a wrong password)', async () => {
    render(<ReauthDialog active />);
    void (await openGate());
    reauthMock.mockRejectedValue(
      new ApiError(401, 'Your session has ended. Sign in again.', {
        detail: { code: 'session_expired', reason: 'idle_expired' },
      }),
    );
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has ended. Sign in again.');
    expect(screen.queryByText(/password is not correct/i)).toBeNull();
  });
});
