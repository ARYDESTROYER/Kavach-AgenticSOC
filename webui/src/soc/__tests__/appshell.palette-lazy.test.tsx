/**
 * The command palette is a lazy chunk (Round 12 WP-GEN-A): AppShell mounts it on the
 * first open (Cmd/Ctrl-K or a search opener), and a chunk that fails to load (a stale
 * hashed file after an update, going offline) never breaks the shell: the palette closes,
 * a toast says how to recover, and focus returns to the opener.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>();
  return { ...actual, toast: Object.assign(vi.fn(), actual.toast, { error: toastError }) };
});
// The palette chunk cannot be fetched.
vi.mock('../components/CommandPalette', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {
      status: number;
      body: unknown;
      constructor(status = 0, message = '', body: unknown = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
      }
    },
    api: {
      // Generic verbs used by the NotificationBell inbox helpers.
      get: ok({ unread: 0, items: [] }),
      post: ok({ ok: true }),
      put: ok({}),
      del: ok({}),
      // Provider load-time calls (auth/prefs/theme/demo) + shell health poll.
      auth: { me: ok({ auth_enabled: false, authenticated: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
      getBranding: ok({
        org_name: '', product_name: '', logo_data_url: '', favicon_data_url: '',
        accent_color: '', accent_color2: '', theme: '', login_subtitle: '',
      }),
      prefs: {
        effective: ok({
          terminology: {}, theme_mode: 'dark', saved_views: [], pinned_view_ids: [],
          tables: {}, last_list_state: {}, misc: {},
          org: { terminology: {}, default_theme: 'dark', default_saved_views: [], default_pinned_view_ids: [] },
        }),
        putUser: ok({}),
      },
      demo: { status: ok({ mode: 'off', active: false, run_id: null }), enable: ok({}) },
      health: ok({ es_connected: true, store_type: 'memory', version: 'test' }),
      account: { get: ok({}) },
      // Remote palette search — only fires when the palette is open + a term is typed;
      // provided so a stray call never rejects.
      search: ok({ query: '', cases: [], sources: [], nav: [] }),
    },
  };
});

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { AppShell } from '../AppShell';

function renderShell() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <AppShell page="overview" onNavigate={vi.fn()}>
                  <div>routed content</div>
                </AppShell>
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe('AppShell lazy command palette', () => {
  beforeEach(() => {
    toastError.mockReset();
    window.localStorage.clear();
  });

  it('closes, says how to recover and returns focus when the palette chunk cannot load', async () => {
    renderShell();
    const opener = await screen.findByRole('button', { name: 'Search cases, sources, and actions' });
    // A click (not focus first): focusing the opener also warms the chunk, and Vitest's
    // module mocker never settles a second concurrent import of a module whose mock throws.
    fireEvent.click(opener);
    await waitFor(
      () => expect(toastError).toHaveBeenCalledWith('Search could not load. Reload the page to try again.'),
      { timeout: 5_000 },
    );
    expect(screen.queryByPlaceholderText(/search cases, sources, settings/i)).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
    // The shell is intact: routed content still renders and Ctrl+K does not throw.
    expect(screen.getByText('routed content')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
  });
});
