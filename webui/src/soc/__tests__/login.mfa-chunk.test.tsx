/**
 * The two-factor setup card is its own chunk (Round 16 package FXF, entry budget).
 *
 *  - The sign-in page reaches `MfaSetupCard` only through `import()`, so the first paint
 *    never carries it.
 *  - A chunk that cannot load leaves a plain reload line in the step, never a thrown
 *    error (the sign-in page renders outside every error boundary), and the way back to
 *    sign in still works.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { brandingMock, setupStatusMock, ssoMock, loginMock, enrollSetupMock } = vi.hoisted(() => ({
  brandingMock: vi.fn(),
  setupStatusMock: vi.fn(),
  ssoMock: vi.fn(),
  loginMock: vi.fn(),
  enrollSetupMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
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
    setUnauthorizedHandler: vi.fn(),
    api: {
      getBranding: () => brandingMock(),
      get: ok({}),
      post: ok({}),
      put: ok({}),
      del: ok({}),
      setup: { status: () => setupStatusMock() },
      auth: {
        login: (u: string, p: string) => loginMock(u, p),
        changePassword: ok({}),
        mfa: { setup: ok({}), confirm: ok({}), verify: ok({}), disable: ok({}), enrollSetup: (t: string) => enrollSetupMock(t) },
        sso: { providers: () => ssoMock(), authorize: ok({ auth_url: 'https://idp/' }) },
      },
    },
  };
});

// A stale hashed chunk after a redeploy: the import rejects.
vi.mock('@/soc/components/MfaSetupCard', () => {
  throw new Error('Failed to fetch dynamically imported module: /assets/MfaSetupCard-stale.js');
});

import { ThemeProvider } from '../theme';
import { TooltipProvider } from '@/ui/tooltip';
import Login from '../pages/Login';

const HERE = path.dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  window.localStorage.clear();
  brandingMock.mockReset().mockResolvedValue({ org_name: 'Acme SOC', product_name: 'Triage' });
  setupStatusMock.mockReset().mockResolvedValue({ setup_complete: true, seeded_default: false });
  ssoMock.mockReset().mockResolvedValue({ providers: [] });
  loginMock.mockReset().mockResolvedValue({ requires_mfa: true, mfa_enrollment_required: true, pending_token: 'pend-1' });
  enrollSetupMock.mockReset();
});

describe('Login: the two-factor setup card is a lazy chunk', () => {
  it('reaches the card only through import(), never a static import', () => {
    const text = fs.readFileSync(path.join(HERE, '..', 'pages', 'Login.tsx'), 'utf8');
    expect(text).not.toMatch(/^import\s+(?!type\b)[^;]*['"]@\/soc\/components\/MfaSetupCard['"]/m);
    expect(text).toMatch(/import\(\s*['"]@\/soc\/components\/MfaSetupCard['"]\s*\)/);
  });

  it('shows a reload line when the chunk cannot load, and keeps the way back', async () => {
    render(
      <ThemeProvider>
        <TooltipProvider>
          <Login onAuthenticated={vi.fn()} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const line = await screen.findByText('Two-factor setup could not load. Reload the page to try again.');
    expect(line).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('heading', { level: 1, name: 'Set up two-factor authentication' })).toBeInTheDocument();
    expect(enrollSetupMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
  });
});
