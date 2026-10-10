/**
 * "Reduce transparency" — the in-app override for browsers that never report
 * `prefers-reduced-transparency` (Safari; Firefox without a flag). SYNTHESIS-ux §1.7.
 *
 * theme.css styles `:root[data-transparency='reduced']` (foundations.test.ts pins those
 * rules). This file pins the plumbing that SETS the attribute, end to end:
 *   1. the helper applies, clears and mirrors the choice, and ignores junk;
 *   2. the blocking pre-paint script in index.html stamps it before first paint;
 *   3. the per-user value hydrated by PrefsProvider wins over this device's mirror, and an
 *      absent value leaves the mirror alone.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import {
  applyTransparencyPreference,
  TRANSPARENCY_PREF_KEY,
  TRANSPARENCY_STORAGE_KEY,
} from '../transparency';

const effective = vi.fn();

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
    api: {
      prefs: {
        effective: () => effective(),
        putUser: vi.fn().mockResolvedValue({}),
        tables: { put: vi.fn() },
      },
      views: { create: vi.fn(), clone: vi.fn(), remove: vi.fn() },
      getBranding: vi.fn().mockResolvedValue({}),
    },
  };
});

import { ThemeProvider } from '@/soc/theme';
import { PrefsProvider } from '@/soc/prefs';

const root = document.documentElement;

function reset() {
  delete root.dataset.transparency;
  window.localStorage.clear();
}

beforeEach(reset);
afterEach(reset);

describe('applyTransparencyPreference', () => {
  it('"reduced" stamps the override on <html> and mirrors it on the device', () => {
    applyTransparencyPreference('reduced');
    expect(root.getAttribute('data-transparency')).toBe('reduced');
    expect(window.localStorage.getItem(TRANSPARENCY_STORAGE_KEY)).toBe('reduced');
  });

  it('"system" removes the override (the media query decides again) and mirrors that', () => {
    applyTransparencyPreference('reduced');
    applyTransparencyPreference('system');
    expect(root.hasAttribute('data-transparency')).toBe(false);
    expect(window.localStorage.getItem(TRANSPARENCY_STORAGE_KEY)).toBe('system');
  });

  it.each([undefined, null, '', 'on', 'REDUCED', 1, true, {}])(
    'ignores %p (an absent or corrupt stored value never changes what is in force)',
    (junk) => {
      applyTransparencyPreference('reduced');
      applyTransparencyPreference(junk);
      expect(root.getAttribute('data-transparency')).toBe('reduced');
      expect(window.localStorage.getItem(TRANSPARENCY_STORAGE_KEY)).toBe('reduced');
    },
  );

  it('still applies when storage is unavailable', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(() => applyTransparencyPreference('reduced')).not.toThrow();
      expect(root.getAttribute('data-transparency')).toBe('reduced');
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('the pre-paint stamp in index.html', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'index.html'), 'utf8');
  // The one inline (non-module) script in <head>.
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

  it('is the inline blocking script and reads the same storage key as the helper', () => {
    expect(inline).toContain(`'${TRANSPARENCY_STORAGE_KEY}'`);
  });

  it('stamps data-transparency="reduced" before first paint when the device chose "On"', () => {
    window.localStorage.setItem(TRANSPARENCY_STORAGE_KEY, 'reduced');
    new Function(inline)();
    expect(root.getAttribute('data-transparency')).toBe('reduced');
  });

  it('leaves the attribute off for "System", an unset or a corrupt value', () => {
    for (const value of ['system', null, 'on']) {
      reset();
      if (value !== null) window.localStorage.setItem(TRANSPARENCY_STORAGE_KEY, value);
      new Function(inline)();
      expect(root.hasAttribute('data-transparency')).toBe(false);
    }
  });
});

describe('PrefsProvider applies the per-user choice on hydration', () => {
  const base = {
    terminology: {},
    theme_mode: 'system',
    saved_views: [],
    pinned_view_ids: [],
    tables: {},
    last_list_state: {},
    org: { terminology: {}, default_theme: 'system', default_saved_views: [], default_pinned_view_ids: [] },
  };
  const mount = () =>
    render(
      <ThemeProvider>
        <PrefsProvider>
          <span>app</span>
        </PrefsProvider>
      </ThemeProvider>,
    );

  it('a stored "reduced" turns the override on, on a device that never chose it', async () => {
    effective.mockResolvedValue({ ...base, misc: { [TRANSPARENCY_PREF_KEY]: 'reduced' } });
    mount();
    await waitFor(() => expect(root.getAttribute('data-transparency')).toBe('reduced'));
    expect(window.localStorage.getItem(TRANSPARENCY_STORAGE_KEY)).toBe('reduced');
  });

  it('a stored "system" wins over this device\'s stale "On" mirror', async () => {
    applyTransparencyPreference('reduced');
    effective.mockResolvedValue({ ...base, misc: { [TRANSPARENCY_PREF_KEY]: 'system' } });
    mount();
    await waitFor(() => expect(root.hasAttribute('data-transparency')).toBe(false));
    expect(window.localStorage.getItem(TRANSPARENCY_STORAGE_KEY)).toBe('system');
  });

  it('no stored value leaves this device\'s choice in force', async () => {
    applyTransparencyPreference('reduced');
    effective.mockResolvedValue({ ...base, misc: {} });
    mount();
    await waitFor(() => expect(effective).toHaveBeenCalled());
    // Let the hydration settle, then confirm nothing was cleared.
    await new Promise((r) => setTimeout(r, 0));
    expect(root.getAttribute('data-transparency')).toBe('reduced');
  });
});
