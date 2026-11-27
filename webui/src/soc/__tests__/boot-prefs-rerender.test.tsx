/**
 * A preference change does not re-render the routed page (WP16): Boot reads the
 * preferences context to stamp the What's new marker when a fresh install's setup
 * completes, so it re-renders on a theme switch, a saved view or a marker, but the page
 * under it is kept while its route stays.
 */
import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pageRenders: 0,
  bump: null as null | (() => void),
  patchMisc: vi.fn(),
  setupComplete: true,
  rerunWizard: null as null | (() => void),
}));

vi.mock('@/lib/api', () => ({
  api: { setupStatus: () => Promise.resolve({ setup_complete: h.setupComplete, seeded_default: false }) },
}));

vi.mock('../auth', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    authEnabled: false,
    isAuthenticated: true,
    mustChangePassword: false,
    loadError: false,
    username: '',
    loading: false,
    refresh: () => Promise.resolve(),
    logout: () => Promise.resolve(),
  }),
  useUnauthorizedRedirect: () => undefined,
}));

// A preferences context whose value changes on demand, like the real provider's.
vi.mock('../prefs', async () => {
  const R = await import('react');
  const Ctx = R.createContext<unknown>(null);
  function PrefsProvider({ children }: { children: React.ReactNode }) {
    const [n, setN] = R.useState(0);
    h.bump = () => setN((x) => x + 1);
    const value = R.useMemo(() => ({ n, patchMisc: h.patchMisc }), [n]);
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  }
  const usePrefs = () => R.useContext(Ctx);
  return { PrefsProvider, usePrefs, useOptionalPrefs: usePrefs };
});

vi.mock('../demo', () => ({ DemoProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('../components/ReauthDialog', () => ({ ReauthDialog: () => null }));
vi.mock('../whats-new/WhatsNewGate', async (orig) => ({
  ...(await orig<typeof import('../whats-new/WhatsNewGate')>()),
  WHATS_NEW_LATEST: '0.2.0',
  WhatsNewGate: () => null,
}));
vi.mock('../pages/Login', () => ({ default: () => <p>Login</p> }));
vi.mock('../pages/Wizard', () => ({
  default: ({ onComplete }: { onComplete: () => void }) => (
    <button type="button" onClick={onComplete}>
      Finish setup
    </button>
  ),
}));

function CountingPage({ onRerunWizard }: { onRerunWizard: () => void }) {
  h.pageRenders += 1;
  h.rerunWizard = onRerunWizard;
  return <p>Routed page</p>;
}
vi.mock('../registry', async (orig) => ({
  ...(await orig<typeof import('../registry')>()),
  renderRoute: (_page: string, ctx: { onRerunWizard: () => void }) => <CountingPage onRerunWizard={ctx.onRerunWizard} />,
}));

import { App } from '../App';

beforeEach(() => {
  h.pageRenders = 0;
  h.bump = null;
  h.patchMisc.mockReset();
  h.setupComplete = true;
  h.rerunWizard = null;
});

describe('Boot and the preferences context', () => {
  it('does not re-render the routed page when a preference changes', async () => {
    render(<App />);
    expect(await screen.findByText('Routed page')).toBeInTheDocument();
    const before = h.pageRenders;
    act(() => h.bump?.());
    act(() => h.bump?.());
    expect(h.pageRenders).toBe(before);
  });

  it('still stamps What s new seen when a fresh install finishes setup, and not on a re-run', async () => {
    h.setupComplete = false;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Finish setup' }));
    expect(h.patchMisc).toHaveBeenCalledWith({ whats_new_seen: '0.2.0' });
    expect(await screen.findByText('Routed page')).toBeInTheDocument();

    h.patchMisc.mockReset();
    act(() => h.rerunWizard?.());
    await user.click(await screen.findByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(screen.getByText('Routed page')).toBeInTheDocument());
    expect(h.patchMisc).not.toHaveBeenCalled();
  });
});
