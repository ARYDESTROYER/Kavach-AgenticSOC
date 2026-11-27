/**
 * Settings → Appearance → "Reduce transparency" (Round 12, SYNTHESIS-ux
 * §1.7): the in-app override for browsers that never report
 * `prefers-reduced-transparency`. Choosing "On" stamps `data-transparency="reduced"` on
 * <html> (theme.css then paints every material and the top bar solid), mirrors it on the
 * device and saves it to the account; "System" removes it again.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = {
  effective: vi.fn(),
  putUser: vi.fn().mockResolvedValue({}),
  authMe: vi.fn().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null }),
};

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      prefs: {
        effective: () => mocks.effective(),
        getUser: vi.fn(),
        putUser: (p: unknown) => mocks.putUser(p),
        getOrg: vi.fn().mockResolvedValue({}),
        putOrg: vi.fn(),
        tables: { put: vi.fn() },
      },
      views: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), clone: vi.fn() },
      terminology: { get: vi.fn(), put: vi.fn() },
      getBranding: vi.fn().mockResolvedValue({}),
      auth: { me: () => mocks.authMe() },
      roles: { get: vi.fn().mockResolvedValue({ matrix: {}, rbac_enabled: false }) },
    },
  };
});

import { ThemeProvider } from '../../theme';
import { AuthProvider } from '../../auth';
import { PrefsProvider } from '../../prefs';
import { CustomizationSection } from '../CustomizationSection';
import type { EffectivePrefs } from '@/lib/types';

const EMPTY_EFFECTIVE: EffectivePrefs = {
  terminology: {},
  theme_mode: 'system',
  saved_views: [],
  pinned_view_ids: [],
  tables: {},
  last_list_state: {},
  misc: {},
  org: { terminology: {}, default_theme: 'system', default_saved_views: [], default_pinned_view_ids: [] },
};

const root = document.documentElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effective.mockResolvedValue({ ...EMPTY_EFFECTIVE });
  window.localStorage.clear();
  delete root.dataset.transparency;
});
afterEach(() => {
  delete root.dataset.transparency;
  window.localStorage.clear();
});

function renderSection() {
  return render(
    <ThemeProvider>
      <AuthProvider>
        <PrefsProvider>
          <CustomizationSection />
        </PrefsProvider>
      </AuthProvider>
    </ThemeProvider>,
  );
}

describe('CustomizationSection — Reduce transparency', () => {
  it('offers System / On, starting on System, with a plain explanation', async () => {
    renderSection();
    const group = await screen.findByRole('radiogroup', { name: 'Reduce transparency' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['System', 'On']);
    expect(within(group).getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('heading', { name: 'Reduce transparency', level: 3 })).toBeInTheDocument();
    expect(screen.getByText(/Safari\s+and Firefox don’t pass that setting on/)).toBeInTheDocument();
  });

  it('"On" makes the material solid now, on this device and for the account; "System" undoes it', async () => {
    renderSection();
    const group = await screen.findByRole('radiogroup', { name: 'Reduce transparency' });
    // Let the prefs hydrate first, so a late hydration can't be mistaken for the toggle.
    await waitFor(() => expect(mocks.effective).toHaveBeenCalled());

    fireEvent.click(within(group).getByRole('radio', { name: 'On' }));
    expect(root.getAttribute('data-transparency')).toBe('reduced');
    expect(window.localStorage.getItem('soc.transparency')).toBe('reduced');
    expect(within(group).getByRole('radio', { name: 'On' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(mocks.putUser).toHaveBeenLastCalledWith({ misc: { transparency: 'reduced' } }));

    fireEvent.click(within(group).getByRole('radio', { name: 'System' }));
    expect(root.hasAttribute('data-transparency')).toBe(false);
    expect(window.localStorage.getItem('soc.transparency')).toBe('system');
    await waitFor(() => expect(mocks.putUser).toHaveBeenLastCalledWith({ misc: { transparency: 'system' } }));
  });

  it('shows the account\'s stored "On" once the prefs hydrate (another device chose it)', async () => {
    mocks.effective.mockResolvedValue({ ...EMPTY_EFFECTIVE, misc: { transparency: 'reduced' } });
    renderSection();
    const group = await screen.findByRole('radiogroup', { name: 'Reduce transparency' });
    await waitFor(() =>
      expect(within(group).getByRole('radio', { name: 'On' })).toHaveAttribute('aria-checked', 'true'),
    );
    expect(root.getAttribute('data-transparency')).toBe('reduced');
  });

  it('starts from what the page shows (the pre-paint stamp) before the prefs answer', async () => {
    root.dataset.transparency = 'reduced';
    mocks.effective.mockReturnValue(new Promise(() => {})); // never settles
    renderSection();
    const group = await screen.findByRole('radiogroup', { name: 'Reduce transparency' });
    expect(within(group).getByRole('radio', { name: 'On' })).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps the choice on this device when saving to the account fails', async () => {
    mocks.putUser.mockRejectedValueOnce(new Error('offline'));
    renderSection();
    const group = await screen.findByRole('radiogroup', { name: 'Reduce transparency' });
    await waitFor(() => expect(mocks.effective).toHaveBeenCalled());
    fireEvent.click(within(group).getByRole('radio', { name: 'On' }));
    await waitFor(() => expect(mocks.putUser).toHaveBeenCalled());
    expect(root.getAttribute('data-transparency')).toBe('reduced');
    expect(window.localStorage.getItem('soc.transparency')).toBe('reduced');
  });
});
