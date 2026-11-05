/**
 * Signed-out reads (Round 14 closing fix qa1-08, SPEC §8.3 "page errors must be none").
 *
 * The Demo status (`demo.tsx`) and the preference cascade (`prefs.tsx`) need a session.
 * Their providers sit inside `AuthProvider`, so they also mount on the sign-in page, where
 * every read answered 401 and the browser logged each one as a console error (four per
 * sign-in page, two of them every 20 s afterwards from the Demo poll). These tests pin the
 * contract: no read without a session, one read as soon as there is one, a clean start for
 * each new person, and nothing from an ended session landing after it.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  me: vi.fn(),
  roles: vi.fn(),
  logout: vi.fn(),
  demoStatus: vi.fn(),
  effective: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: () => h.me(), logout: () => h.logout() },
      roles: { get: () => h.roles() },
      demo: { status: () => h.demoStatus() },
      prefs: { effective: () => h.effective(), putUser: vi.fn().mockResolvedValue({}), tables: { put: vi.fn() } },
      views: { create: vi.fn(), clone: vi.fn(), remove: vi.fn() },
      getBranding: vi.fn().mockResolvedValue({}),
    },
  };
});

import { AuthProvider, useAuth } from '../auth';
import { DemoProvider, useDemo } from '../demo';
import { PrefsProvider, usePrefs } from '../prefs';
import { ThemeProvider, useTheme } from '../theme';

const SIGNED_OUT = { auth_enabled: true, authenticated: false, user: null };
const signedIn = (username: string) => ({
  auth_enabled: true,
  authenticated: true,
  user: { username, role: 'analyst', must_change_password: false },
});
const AUTH_OFF = { auth_enabled: false, authenticated: false, user: null };

const DEMO_ON = { mode: 'seeded' as const, active: true, run_id: 'demo-1' };
const effectiveFor = (label: string, theme_mode = 'system') => ({
  terminology: { case: label },
  theme_mode,
  saved_views: [],
  pinned_view_ids: [],
  tables: {},
  last_list_state: {},
  misc: {},
  org: { terminology: {}, default_theme: 'system', default_saved_views: [], default_pinned_view_ids: [] },
});

let auth: ReturnType<typeof useAuth> | null = null;
let prefsCtx: ReturnType<typeof usePrefs> | null = null;

function Probe() {
  auth = useAuth();
  const demo = useDemo();
  const prefs = usePrefs();
  prefsCtx = prefs;
  const { theme } = useTheme();
  return (
    <dl>
      <dd data-testid="demo">{`${demo.active ? 'active' : 'off'} ${demo.confirmed ? 'confirmed' : 'stand-in'}`}</dd>
      <dd data-testid="demo-loading">{demo.loading ? 'loading' : 'settled'}</dd>
      <dd data-testid="prefs">{`${prefs.ready ? 'ready' : 'not-ready'} ${prefs.t('case')}`}</dd>
      <dd data-testid="theme-mode">{prefs.themeMode}</dd>
      <dd data-testid="theme-applied">{theme}</dd>
    </dl>
  );
}

function renderConsole() {
  return render(
    <ThemeProvider>
      <AuthProvider>
        <PrefsProvider>
          <DemoProvider>
            <Probe />
          </DemoProvider>
        </PrefsProvider>
      </AuthProvider>
    </ThemeProvider>,
  );
}

const flush = () => act(async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  auth = null;
  prefsCtx = null;
  window.localStorage.clear();
  h.me.mockReset();
  h.roles.mockReset().mockResolvedValue({ matrix: {}, rbac_enabled: false });
  h.logout.mockReset().mockResolvedValue({});
  h.demoStatus.mockReset().mockResolvedValue(DEMO_ON);
  h.effective.mockReset().mockImplementation(() => Promise.resolve(effectiveFor('incident')));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the sign-in page sends no read it knows will answer 401', () => {
  it('reads neither the Demo status nor the preferences while nobody is signed in', async () => {
    h.me.mockResolvedValue(SIGNED_OUT);
    renderConsole();
    await waitFor(() => expect(auth?.loading).toBe(false));
    await flush();
    expect(auth?.isAuthenticated).toBe(false);
    expect(h.demoStatus).not.toHaveBeenCalled();
    expect(h.effective).not.toHaveBeenCalled();
    expect(screen.getByTestId('demo').textContent).toBe('off stand-in');
    expect(screen.getByTestId('demo-loading').textContent).toBe('loading');
    expect(screen.getByTestId('prefs').textContent).toBe('not-ready case');
  });

  it('reads nothing while GET /api/auth/me is still pending', async () => {
    const me = deferred<typeof SIGNED_OUT>();
    h.me.mockReturnValue(me.promise);
    renderConsole();
    await flush();
    expect(auth?.loading).toBe(true);
    expect(h.demoStatus).not.toHaveBeenCalled();
    expect(h.effective).not.toHaveBeenCalled();
    await act(async () => me.resolve(SIGNED_OUT));
    await flush();
    expect(h.demoStatus).not.toHaveBeenCalled();
    expect(h.effective).not.toHaveBeenCalled();
  });

  it('reads nothing when GET /api/auth/me fails (the console shows its retry screen)', async () => {
    h.me.mockRejectedValue(new Error('backend down'));
    renderConsole();
    await waitFor(() => expect(auth?.loadError).toBe(true));
    await flush();
    expect(h.demoStatus).not.toHaveBeenCalled();
    expect(h.effective).not.toHaveBeenCalled();
  });

  it('does not poll the Demo status while signed out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    h.me.mockResolvedValue(SIGNED_OUT);
    renderConsole();
    // waitFor polls on a (faked) interval, so settle the sign-in state by flushing instead.
    await flush();
    expect(auth?.loading).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flush();
    expect(h.demoStatus).not.toHaveBeenCalled();
  });

  it('sends nothing when a consumer asks for a refresh while signed out', async () => {
    h.me.mockResolvedValue(SIGNED_OUT);
    let demo: ReturnType<typeof useDemo> | null = null;
    let prefs: ReturnType<typeof usePrefs> | null = null;
    function Refresher() {
      demo = useDemo();
      prefs = usePrefs();
      return null;
    }
    render(
      <ThemeProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <Refresher />
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(demo).not.toBeNull());
    await flush();
    await act(async () => {
      await expect(demo!.refresh()).resolves.toMatchObject({ mode: 'off', active: false });
      await prefs!.refresh();
    });
    expect(h.demoStatus).not.toHaveBeenCalled();
    expect(h.effective).not.toHaveBeenCalled();
  });
});

describe('signing in and out', () => {
  it('reads both once, as soon as someone signs in', async () => {
    h.me.mockResolvedValue(SIGNED_OUT);
    renderConsole();
    await waitFor(() => expect(auth?.loading).toBe(false));
    h.me.mockResolvedValue(signedIn('alice'));
    await act(async () => {
      await auth!.refresh();
    });
    await waitFor(() => expect(screen.getByTestId('prefs').textContent).toBe('ready incident'));
    await waitFor(() => expect(screen.getByTestId('demo').textContent).toBe('active confirmed'));
    expect(h.demoStatus).toHaveBeenCalledTimes(1);
    expect(h.effective).toHaveBeenCalledTimes(1);
  });

  it('polls the Demo status every 20 s while signed in, and stops at sign-out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    h.me.mockResolvedValue(signedIn('alice'));
    renderConsole();
    await flush();
    expect(h.demoStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(h.demoStatus).toHaveBeenCalledTimes(2);
    await act(async () => {
      await auth!.logout();
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(h.demoStatus).toHaveBeenCalledTimes(2);
  });

  it('returns to the empty, not-ready values at sign-out', async () => {
    h.me.mockResolvedValue(signedIn('alice'));
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('prefs').textContent).toBe('ready incident'));
    await waitFor(() => expect(screen.getByTestId('demo').textContent).toBe('active confirmed'));
    await act(async () => {
      await auth!.logout();
    });
    expect(screen.getByTestId('prefs').textContent).toBe('not-ready case');
    expect(screen.getByTestId('demo').textContent).toBe('off stand-in');
  });

  it('keeps the colour mode in effect at sign-out, in the context and in the theme', async () => {
    h.me.mockResolvedValue(signedIn('alice'));
    h.effective.mockImplementation(() => Promise.resolve(effectiveFor('incident', 'dark')));
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('prefs').textContent).toBe('ready incident'));
    expect(screen.getByTestId('theme-mode').textContent).toBe('dark');
    expect(screen.getByTestId('theme-applied').textContent).toBe('dark');
    await act(async () => {
      await auth!.logout();
    });
    expect(screen.getByTestId('prefs').textContent).toBe('not-ready case');
    // The empty cascade's 'system' never replaces the mode the page is showing.
    expect(screen.getByTestId('theme-mode').textContent).toBe('dark');
    expect(screen.getByTestId('theme-applied').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('settles on the defaults when the cascade read fails or has no body, never resetting the colour mode', async () => {
    window.localStorage.setItem('soc.theme', 'dark');
    h.me.mockResolvedValue(signedIn('alice'));
    h.effective.mockRejectedValueOnce(new Error('502'));
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('prefs').textContent).toBe('ready case'));
    expect(screen.getByTestId('theme-applied').textContent).toBe('dark');
    // A reply without a body is no answer either: the defaults, not a switch to 'system'.
    h.effective.mockResolvedValueOnce(undefined);
    await act(async () => {
      await prefsCtx!.refresh();
    });
    expect(screen.getByTestId('prefs').textContent).toBe('ready case');
    expect(screen.getByTestId('theme-applied').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('settles the Demo status on a failed read: loading ends, the OFF stand-in stays unconfirmed', async () => {
    h.me.mockResolvedValue(signedIn('alice'));
    h.demoStatus.mockRejectedValueOnce(new Error('503'));
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('demo-loading').textContent).toBe('settled'));
    expect(screen.getByTestId('demo').textContent).toBe('off stand-in');
  });

  it('drops a reply that was in flight when the session ended', async () => {
    h.me.mockResolvedValue(signedIn('alice'));
    const late = deferred<ReturnType<typeof effectiveFor>>();
    const lateDemo = deferred<typeof DEMO_ON>();
    h.effective.mockReturnValueOnce(late.promise);
    h.demoStatus.mockReturnValueOnce(lateDemo.promise);
    renderConsole();
    await waitFor(() => expect(h.effective).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.demoStatus).toHaveBeenCalledTimes(1));
    await act(async () => {
      await auth!.logout();
    });
    await act(async () => {
      late.resolve(effectiveFor('alice-only'));
      lateDemo.resolve(DEMO_ON);
    });
    await flush();
    expect(screen.getByTestId('prefs').textContent).toBe('not-ready case');
    expect(screen.getByTestId('demo').textContent).toBe('off stand-in');
  });

  it('reads again for the next person, who never sees the last one\'s preferences', async () => {
    h.me.mockResolvedValue(signedIn('alice'));
    h.effective.mockImplementation(() => Promise.resolve(effectiveFor('alice-term')));
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('prefs').textContent).toBe('ready alice-term'));
    const bob = deferred<ReturnType<typeof effectiveFor>>();
    h.effective.mockImplementation(() => bob.promise);
    h.me.mockResolvedValue(signedIn('bob'));
    await act(async () => {
      await auth!.refresh();
    });
    expect(screen.getByTestId('prefs').textContent).toBe('not-ready case');
    await act(async () => bob.resolve(effectiveFor('bob-term')));
    await waitFor(() => expect(screen.getByTestId('prefs').textContent).toBe('ready bob-term'));
    expect(h.effective).toHaveBeenCalledTimes(2);
  });

  it('shows the next person the unconfirmed Demo stand-in until their own status read lands', async () => {
    h.me.mockResolvedValue(signedIn('alice'));
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('demo').textContent).toBe('active confirmed'));
    const bobStatus = deferred<typeof DEMO_ON>();
    h.demoStatus.mockImplementation(() => bobStatus.promise);
    h.me.mockResolvedValue(signedIn('bob'));
    // Another person signs in to this tab directly: no signed-out state in between.
    await act(async () => {
      await auth!.refresh();
    });
    expect(screen.getByTestId('demo').textContent).toBe('off stand-in');
    expect(screen.getByTestId('demo-loading').textContent).toBe('loading');
    await act(async () => bobStatus.resolve({ ...DEMO_ON, run_id: 'demo-2' }));
    await waitFor(() => expect(screen.getByTestId('demo').textContent).toBe('active confirmed'));
    expect(screen.getByTestId('demo-loading').textContent).toBe('settled');
    expect(h.demoStatus).toHaveBeenCalledTimes(2);
  });
});

describe('profiles without a sign-in', () => {
  it('reads both once /auth/me reports auth is off', async () => {
    h.me.mockResolvedValue(AUTH_OFF);
    renderConsole();
    await waitFor(() => expect(screen.getByTestId('prefs').textContent).toBe('ready incident'));
    await waitFor(() => expect(screen.getByTestId('demo').textContent).toBe('active confirmed'));
    expect(h.demoStatus).toHaveBeenCalledTimes(1);
    expect(h.effective).toHaveBeenCalledTimes(1);
  });

  it('reads as before when the providers render outside an AuthProvider', async () => {
    function Bare() {
      const demo = useDemo();
      const prefs = usePrefs();
      return <span data-testid="bare">{`${demo.active ? 'active' : 'off'} ${prefs.ready ? 'ready' : 'not-ready'}`}</span>;
    }
    render(
      <ThemeProvider>
        <PrefsProvider>
          <DemoProvider>
            <Bare />
          </DemoProvider>
        </PrefsProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('bare').textContent).toBe('active ready'));
    expect(h.me).not.toHaveBeenCalled();
  });
});
