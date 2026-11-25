/**
 * B25 (Round 16 WP04): the sign-in page never shows text from the `?sso_error=` query.
 *
 * The backend sends a closed set of codes when a single sign-on callback fails (each
 * `_fail("...")` in `sso_callback`, backend/app/api/routes.py). The page maps each code
 * to a fixed sentence and anything else to one generic sentence, so a crafted link
 * such as `/login?sso_error=Call+555` can never put words on the sign-in page. The URL
 * is still cleaned so a refresh does not show the message again.
 */
import * as React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { brandingMock, setupStatusMock, ssoMock } = vi.hoisted(() => ({
  brandingMock: vi.fn(),
  setupStatusMock: vi.fn(),
  ssoMock: vi.fn(),
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
        login: ok({}),
        changePassword: ok({ ok: true }),
        mfa: { setup: ok({}), confirm: ok({}), verify: ok({}), disable: ok({}) },
        sso: { providers: () => ssoMock(), authorize: ok({ auth_url: 'https://idp/' }) },
      },
    },
  };
});

import { ThemeProvider } from '../theme';
import { TooltipProvider } from '@/ui/tooltip';
import Login from '../pages/Login';

const ROUTES_PY = path.resolve(__dirname, '..', '..', '..', '..', 'backend', 'app', 'api', 'routes.py');

/** Every code the SSO callback can redirect with: the `_fail("<code>")` calls. */
function backendSsoErrorCodes(): string[] {
  const source = fs.readFileSync(ROUTES_PY, 'utf8');
  const start = source.indexOf('async def sso_callback');
  expect(start, 'sso_callback not found in routes.py').toBeGreaterThan(-1);
  const next = source.indexOf('\n@router.', start);
  const body = source.slice(start, next === -1 ? undefined : next);
  expect(body).toMatch(/\/login\?sso_error=/);
  return Array.from(new Set(Array.from(body.matchAll(/_fail\("([a-z_]+)"\)/g), (m) => m[1])));
}

function renderAt(search: string) {
  window.history.replaceState({}, '', `/login${search}`);
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <Login onAuthenticated={vi.fn()} />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  brandingMock.mockReset().mockResolvedValue({ org_name: 'Acme SOC' });
  setupStatusMock.mockReset().mockResolvedValue({ setup_complete: true, seeded_default: false });
  ssoMock.mockReset().mockResolvedValue({ providers: [] });
});

describe('Login: single sign-on errors come from a closed list (B25)', () => {
  it('never renders an arbitrary sso_error value, and cleans the URL', async () => {
    renderAt('?sso_error=Your+password+expired.+Call+555+0100+now&next=1');
    await screen.findByLabelText('Username');
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('Call 555');
    expect(text).not.toContain('Your password expired');
    expect(screen.getByText('Single sign-on failed. Try again.')).toBeInTheDocument();
    // The query value is gone from the address bar; other parameters stay.
    await waitFor(() => expect(window.location.search).toBe('?next=1'));
  });

  it('shows a fixed sentence for a known code, never the raw code', async () => {
    renderAt('?sso_error=user_not_provisioned');
    await screen.findByLabelText('Username');
    expect(document.body.textContent ?? '').not.toContain('user_not_provisioned');
    expect(
      screen.getByText('No account exists for this identity yet. Ask an administrator to add you.'),
    ).toBeInTheDocument();
  });

  it('maps every code the backend sends to its own plain sentence', async () => {
    // A runtime specifier, so the two DOM cases above still run on a tree without it.
    const specifier = '../components/auth/ssoErrors';
    const { SSO_ERROR_MESSAGES, SSO_ERROR_FALLBACK, ssoErrorMessage } = (await import(
      /* @vite-ignore */ specifier
    )) as typeof import('../components/auth/ssoErrors');
    const codes = backendSsoErrorCodes();
    expect(codes.length).toBeGreaterThanOrEqual(10);
    for (const code of codes) {
      const sentence = SSO_ERROR_MESSAGES[code];
      expect(sentence, `no sentence for ${code}`).toBeTruthy();
      expect(ssoErrorMessage(code)).toBe(sentence);
      expect(sentence).toMatch(/^[A-Z][^_]*\.$/);
      expect(sentence).not.toMatch(/[\u2013\u2014\u00a0]/);
    }
    // Nothing is listed that the backend never sends.
    expect(Object.keys(SSO_ERROR_MESSAGES).sort()).toEqual([...codes].sort());
    // Anything else, inherited names included, gets the generic sentence.
    for (const other of ['Call 555', 'constructor', 'toString', '__proto__', '']) {
      expect(ssoErrorMessage(other)).toBe(SSO_ERROR_FALLBACK);
    }
    expect(SSO_ERROR_FALLBACK).toBe('Single sign-on failed. Try again.');
    // The sign-in page repeats it for a chunk that fails to load: the two stay equal,
    // and the page reaches the sentences only through a lazy import (no entry bytes).
    const page = fs.readFileSync(path.resolve(__dirname, '..', 'pages', 'Login.tsx'), 'utf8');
    expect(page).toContain(`const SSO_ERROR_FALLBACK = '${SSO_ERROR_FALLBACK}';`);
    expect(page).toMatch(/import\('@\/soc\/components\/auth\/ssoErrors'\)/);
    expect(page).not.toMatch(/from '@\/soc\/components\/auth\/ssoErrors'/);
  });
});
