/**
 * The command palette is a lazy chunk (Round 12 WP-GEN-A): AppShell mounts it on the
 * first open (Cmd/Ctrl-K or a search opener), and a chunk that fails to load (a stale
 * hashed file after an update, going offline) never breaks the shell: the palette closes,
 * a toast offers a reload (never "try again" alone: a module the palette imports that
 * failed stays failed until a reload), and focus returns to the opener. The idle warm
 * only prefetches; it never imports the chunk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>();
  return { ...actual, toast: Object.assign(vi.fn(), actual.toast, { error: toastError }) };
});
// The palette chunk cannot be fetched (each import runs the factory again, so this
// counts imports).
const paletteImports = vi.hoisted(() => ({ count: 0 }));
vi.mock('../components/CommandPalette', () => {
  paletteImports.count += 1;
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

const RELOAD_TOAST = 'Search could not load. Reload the page to use search.';

describe('AppShell lazy command palette', () => {
  beforeEach(() => {
    toastError.mockReset();
    window.localStorage.clear();
  });

  it('the idle warm and hovering or focusing an opener never import the palette', async () => {
    const idle = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    vi.stubGlobal('requestIdleCallback', idle);
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    try {
      const before = paletteImports.count;
      renderShell();
      const opener = await screen.findByRole('button', { name: 'Search cases, sources, and actions' });
      await waitFor(() => expect(idle).toHaveBeenCalled());
      fireEvent.pointerEnter(opener);
      fireEvent.focus(opener);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      // A warm through import() would put a failed fetch in the page's module map for
      // good (and the palette shares chunks with Chat and Settings): it only prefetches.
      expect(paletteImports.count).toBe(before);
      expect(toastError).not.toHaveBeenCalled();
      // Unbuilt (tests), the build-written chunk list is absent, so nothing is prefetched.
      expect(document.head.querySelector('link[rel="prefetch"]')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('closes, offers a reload and returns focus when the palette chunk cannot load', async () => {
    renderShell();
    const opener = await screen.findByRole('button', { name: 'Search cases, sources, and actions' });
    fireEvent.click(opener);
    await waitFor(
      () => expect(toastError).toHaveBeenCalledWith(
        RELOAD_TOAST,
        expect.objectContaining({ id: 'command-palette-load', action: expect.objectContaining({ label: 'Reload' }) }),
      ),
      { timeout: 5_000 },
    );
    // Never "try again" alone: the shell cannot clear a failed module from the page.
    expect(toastError.mock.calls.every(([message]) => !/try again/i.test(String(message)))).toBe(true);
    expect(screen.queryByPlaceholderText(/search cases, sources, settings/i)).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
    // The shell is intact: routed content still renders and Ctrl+K tries to load again
    // (a failure is not remembered), replacing the one toast instead of adding another.
    expect(screen.getByText('routed content')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    const ids = toastError.mock.calls.map((call) => (call[1] as { id?: string } | undefined)?.id);
    expect(ids).toEqual(['command-palette-load', 'command-palette-load']);
    expect(screen.queryByPlaceholderText(/search cases, sources, settings/i)).toBeNull();
  });
});
