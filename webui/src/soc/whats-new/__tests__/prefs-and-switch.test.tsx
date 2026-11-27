/**
 * The preferences pieces What's new reads (Round 16 SPEC §4.4 WP07, [wn] F3, R3, R6):
 * `loaded` is true only after the cascade was actually read (a failed read, or a later
 * failed refresh, is not "never seen"); `patchMisc` resolves whether the server saved;
 * and the personal switch "Show What's new after updates" in Settings, Appearance.
 */
import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  effective: vi.fn(),
  putUser: vi.fn(),
  authMe: vi.fn(),
}));

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
        putUser: (patch: unknown) => mocks.putUser(patch),
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

import type { EffectivePrefs } from '@/lib/types';
import { AuthProvider } from '../../auth';
import { CustomizationSection } from '../../components/CustomizationSection';
import { PrefsProvider, usePrefs, type PrefsContextValue } from '../../prefs';
import { ThemeProvider } from '../../theme';

const EFFECTIVE: EffectivePrefs = {
  terminology: {},
  theme_mode: 'system',
  saved_views: [],
  pinned_view_ids: [],
  tables: {},
  last_list_state: {},
  misc: { whats_new_seen: '0.2.0.2026-11-25' },
  org: { terminology: {}, default_theme: 'system', default_saved_views: [], default_pinned_view_ids: [] },
};

let latest: PrefsContextValue | null = null;
function Probe() {
  latest = usePrefs();
  return null;
}

function renderWith(children: React.ReactNode) {
  return render(
    <ThemeProvider>
      <AuthProvider>
        <PrefsProvider>{children}</PrefsProvider>
      </AuthProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  latest = null;
  mocks.effective.mockReset();
  mocks.putUser.mockReset();
  mocks.authMe.mockReset();
  mocks.authMe.mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
  mocks.putUser.mockResolvedValue({});
  window.localStorage.clear();
});

describe('PrefsProvider loaded', () => {
  it('is true once the cascade was read', async () => {
    mocks.effective.mockResolvedValue({ ...EFFECTIVE });
    renderWith(<Probe />);
    await waitFor(() => expect(latest?.loaded).toBe(true));
    expect(latest?.ready).toBe(true);
    expect(latest?.prefs.misc?.whats_new_seen).toBe('0.2.0.2026-11-25');
  });

  it('stays false after a failed read, while ready turns true', async () => {
    mocks.effective.mockRejectedValue(new Error('down'));
    renderWith(<Probe />);
    await waitFor(() => expect(latest?.ready).toBe(true));
    expect(latest?.loaded).toBe(false);
    expect(latest?.prefs.misc?.whats_new_seen).toBeUndefined();
  });

  it('turns false again when a later refresh fails (the copy in hand is not a read)', async () => {
    mocks.effective.mockResolvedValueOnce({ ...EFFECTIVE }).mockRejectedValueOnce(new Error('down'));
    renderWith(<Probe />);
    await waitFor(() => expect(latest?.loaded).toBe(true));
    await act(async () => {
      await latest?.refresh();
    });
    expect(latest?.loaded).toBe(false);
    expect(latest?.ready).toBe(true);
  });
});

describe('patchMisc', () => {
  it('resolves true when the server saved the patch and false when it did not, never rejecting', async () => {
    mocks.effective.mockResolvedValue({ ...EFFECTIVE });
    renderWith(<Probe />);
    await waitFor(() => expect(latest?.loaded).toBe(true));
    let saved: boolean | undefined;
    await act(async () => {
      saved = await latest?.patchMisc({ whats_new_seen: '0.2.0.2026-12' });
    });
    expect(saved).toBe(true);
    expect(mocks.putUser).toHaveBeenCalledWith({ misc: { whats_new_seen: '0.2.0.2026-12' } });
    expect(latest?.prefs.misc?.whats_new_seen).toBe('0.2.0.2026-12');
    mocks.putUser.mockRejectedValueOnce(new Error('503'));
    await act(async () => {
      saved = await latest?.patchMisc({ whats_new_seen: '0.2.0.2026-12' });
    });
    expect(saved).toBe(false);
    await act(async () => {
      saved = await latest?.patchMisc({});
    });
    expect(saved).toBe(false);
  });
});

describe("Settings, Appearance: Show What's new after updates", () => {
  it('is on by default, says what it does and saves the choice to the account', async () => {
    mocks.effective.mockResolvedValue({ ...EFFECTIVE });
    renderWith(<CustomizationSection />);
    const toggle = await screen.findByRole('switch', { name: "Show What's new after updates" });
    await waitFor(() => expect(mocks.effective).toHaveBeenCalled());
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/After an update, a short welcome shows once/);
    await userEvent.click(toggle);
    expect(mocks.putUser).toHaveBeenCalledWith({ misc: { whats_new_auto: false } });
    expect(toggle).not.toBeChecked();
  });

  it('shows off when the account turned it off', async () => {
    mocks.effective.mockResolvedValue({ ...EFFECTIVE, misc: { whats_new_auto: false } });
    renderWith(<CustomizationSection />);
    const toggle = await screen.findByRole('switch', { name: "Show What's new after updates" });
    await waitFor(() => expect(toggle).not.toBeChecked());
  });
});
