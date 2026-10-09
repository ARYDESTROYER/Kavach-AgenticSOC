/**
 * MfaSetupCard — the lazily loaded QR encoder fails soft.
 *
 * The QR code is a lazy chunk, and the card renders on the eager Login page, which sits
 * outside every error boundary. A rejected chunk import (a stale hashed file after a
 * redeploy or supervised update, a proxy, going offline) must not unmount the tree:
 * the card shows its "QR unavailable" box and the secret, URI, recovery codes and the
 * confirm form stay usable.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { setupMock, enrollSetupMock } = vi.hoisted(() => ({
  setupMock: vi.fn(),
  enrollSetupMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    auth: {
      mfa: {
        setup: setupMock,
        confirm: vi.fn(),
        enrollSetup: enrollSetupMock,
        enrollConfirm: vi.fn(),
        disable: vi.fn(),
      },
    },
  },
}));
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(true) }));
// The chunk fetch fails: the dynamic import of the encoder rejects.
vi.mock('../QRCode', () => {
  throw new Error('Failed to fetch dynamically imported module: /assets/QRCode-stale.js');
});

import { MfaSetupCard } from '../MfaSetupCard';

const SETUP_PAYLOAD = {
  secret: 'CHUNKSECRET234567',
  otpauth_uri: 'otpauth://totp/Agentic%20SOC:ann?secret=CHUNKSECRET234567',
  recovery_codes: ['cccc-3333', 'dddd-4444'],
};

describe('MfaSetupCard — QR chunk load failure', () => {
  beforeEach(() => {
    setupMock.mockReset();
    enrollSetupMock.mockReset();
    setupMock.mockResolvedValue({ ...SETUP_PAYLOAD });
    enrollSetupMock.mockResolvedValue({ ...SETUP_PAYLOAD });
  });

  it('login-phase enrolment keeps the manual path when the QR chunk is rejected', async () => {
    render(<MfaSetupCard enabled={false} frameless pendingToken="pend-9" />);

    expect(
      await screen.findByText('QR unavailable — enter the secret manually below.'),
    ).toBeInTheDocument();
    expect(screen.getByText('CHUNKSECRET234567')).toBeInTheDocument();
    expect(screen.getByText(/otpauth:\/\/totp\/Agentic%20SOC:ann/)).toBeInTheDocument();
    expect(screen.getByText('cccc-3333')).toBeInTheDocument();
    expect(screen.getByLabelText(/enter the 6-digit code/i)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /qr code/i })).toBeNull();
  });

  it('session enrolment (Security page) shows the same fallback', async () => {
    render(<MfaSetupCard enabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /enable two-factor/i }));

    await waitFor(() => expect(setupMock).toHaveBeenCalled());
    expect(
      await screen.findByText('QR unavailable — enter the secret manually below.'),
    ).toBeInTheDocument();
    expect(screen.getByText('CHUNKSECRET234567')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify & enable/i })).toBeInTheDocument();
  });
});
