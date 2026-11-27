/**
 * Round-6 auth-login finding 6 — MfaSetupCard `frameless` prop.
 *
 * In the login MFA-enroll step the card is nested inside the login Card (card-in-card
 * + duplicate heading). `frameless` drops MfaSetupCard's OWN card frame + internal
 * title/description/badge so the parent supplies the single frame + heading.
 */
import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { auth: { mfa: { setup: vi.fn(), confirm: vi.fn(), disable: vi.fn() } } },
}));
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(true) }));

import { MfaSetupCard } from '../MfaSetupCard';

describe('MfaSetupCard — frameless', () => {
  it('renders its own "Two-factor authentication" heading by default', () => {
    render(<MfaSetupCard enabled={false} />);
    expect(screen.getByRole('heading', { name: 'Two-factor authentication' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /turn on two-factor/i })).toBeInTheDocument();
  });

  it('drops its internal heading (+ frame) when frameless, keeping the action', () => {
    render(<MfaSetupCard enabled={false} frameless />);
    // No duplicate heading — the parent (login Card) supplies "Secure your account".
    expect(screen.queryByRole('heading', { name: 'Two-factor authentication' })).toBeNull();
    // The enrollment action is still present.
    expect(screen.getByRole('button', { name: /turn on two-factor/i })).toBeInTheDocument();
  });
});
