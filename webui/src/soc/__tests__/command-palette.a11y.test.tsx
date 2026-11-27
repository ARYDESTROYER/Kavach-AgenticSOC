/**
 * Command palette structure (Round 16 bug hunt B76, WP15F).
 *
 * cmdk renders its list as `role="listbox"` and a separator as `role="separator"`, which a
 * listbox may not own (axe aria-required-children, critical): NVDA and JAWS can count the
 * dividers as options. The shared CommandSeparator is now hidden from assistive technology;
 * the group headings carry the structure. The harness is the one command-palette.test.tsx
 * uses (every provider real, the load-time api calls mocked).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
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
      search: searchMock,
    },
  };
});

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CommandPalette } from '../components/CommandPalette';

async function renderPalette() {
  render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <CommandPalette open onOpenChange={vi.fn()} onNavigate={vi.fn()} />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
  // The lazy chat entries settle inside the test's own waiting, never after it.
  await waitFor(() =>
    expect(document.querySelector('[cmdk-item][data-value="action-search-chats"]')).toBeTruthy(),
  );
}

describe('CommandPalette listbox structure (B76)', () => {
  beforeEach(() => {
    searchMock.mockReset();
    searchMock.mockResolvedValue({ query: '', cases: [], sources: [], nav: [] });
    window.localStorage.clear();
  });

  it('hides the visual separators from the accessibility tree', async () => {
    await renderPalette();
    const separators = Array.from(document.querySelectorAll('[cmdk-separator]'));
    // The empty search shows the palette's dividers.
    expect(separators.length).toBeGreaterThan(0);
    for (const separator of separators) expect(separator).toHaveAttribute('aria-hidden', 'true');
  });

  it('gives the listbox only options and groups (axe aria-required-children)', async () => {
    await renderPalette();
    const listbox = document.querySelector<HTMLElement>('[cmdk-list][role="listbox"]');
    expect(listbox).not.toBeNull();
    const results = await act(() =>
      axe(listbox!, { runOnly: { type: 'rule', values: ['aria-required-children', 'aria-required-parent'] } }),
    );
    expect(results).toHaveNoViolations();
  });
});
