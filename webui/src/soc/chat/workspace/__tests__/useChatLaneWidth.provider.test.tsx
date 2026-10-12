/**
 * useChatLaneWidth under the REAL PrefsProvider (review finding: the Width choice
 * reverted on every return to Chat). The Chat page remounts on each visit and
 * reconciles from the provider's `prefs.misc`; that snapshot must hold the viewer's
 * latest choice, not the copy loaded at app start, and a hydrate that lands after a
 * choice must not bring the older server value back.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

const { effective, putUser } = vi.hoisted(() => ({ effective: vi.fn(), putUser: vi.fn() }));

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
        putUser: (body: unknown) => putUser(body),
        tables: { put: vi.fn() },
      },
      views: { create: vi.fn(), clone: vi.fn(), remove: vi.fn() },
      getBranding: vi.fn().mockResolvedValue({}),
    },
  };
});

import { ThemeProvider } from '@/soc/theme';
import { PrefsProvider } from '@/soc/prefs';
import { LANE_WIDTH_PREF_KEY, LANE_WIDTH_STORAGE_KEY, useChatLaneWidth, type ChatLaneWidthPreference } from '../useChatLaneWidth';

const base = {
  terminology: {},
  theme_mode: 'system',
  saved_views: [],
  pinned_view_ids: [],
  tables: {},
  last_list_state: {},
  org: { terminology: {}, default_theme: 'system', default_saved_views: [], default_pinned_view_ids: [] },
};

let latest: ChatLaneWidthPreference | null = null;

function ChatPage() {
  latest = useChatLaneWidth();
  return <span data-testid="lane-width">{latest.width}</span>;
}

/** The shell keeps one PrefsProvider while the Chat page mounts and unmounts. */
function Shell({ chat }: { chat: boolean }) {
  return (
    <ThemeProvider>
      <PrefsProvider>{chat ? <ChatPage /> : <span>Overview</span>}</PrefsProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  effective.mockReset();
  putUser.mockReset();
  putUser.mockResolvedValue({});
  latest = null;
});

afterEach(() => {
  window.localStorage.clear();
});

describe('useChatLaneWidth with the app PrefsProvider', () => {
  it('keeps the viewer\'s choice after leaving Chat and coming back', async () => {
    effective.mockResolvedValue({ ...base, misc: { [LANE_WIDTH_PREF_KEY]: 'comfortable', density: 'compact' } });
    const { rerender } = render(<Shell chat />);
    await waitFor(() => expect(screen.getByTestId('lane-width')).toHaveTextContent('comfortable'));

    act(() => latest!.setWidth('full'));
    expect(screen.getByTestId('lane-width')).toHaveTextContent('full');
    // One server write, the key alone (the server deep-merges misc).
    expect(putUser).toHaveBeenCalledTimes(1);
    expect(putUser).toHaveBeenCalledWith({ misc: { [LANE_WIDTH_PREF_KEY]: 'full' } });

    // Overview, then Chat again: the page remounts and reconciles from the provider.
    rerender(<Shell chat={false} />);
    expect(screen.queryByTestId('lane-width')).toBeNull();
    rerender(<Shell chat />);
    expect(screen.getByTestId('lane-width')).toHaveTextContent('full');
    expect(window.localStorage.getItem(LANE_WIDTH_STORAGE_KEY)).toBe('full');
    // The provider was hydrated once; the remount did not refetch or rewrite.
    expect(effective).toHaveBeenCalledTimes(1);
    expect(putUser).toHaveBeenCalledTimes(1);
  });

  it('a hydrate that lands after the choice does not bring the older server value back', async () => {
    let resolve: (value: unknown) => void = () => {};
    effective.mockReturnValue(new Promise((r) => (resolve = r)));
    const { rerender } = render(<Shell chat />);
    // Never chosen: Full width, the default.
    expect(screen.getByTestId('lane-width')).toHaveTextContent('full');

    act(() => latest!.setWidth('wide'));
    await act(async () => {
      resolve({ ...base, misc: { [LANE_WIDTH_PREF_KEY]: 'comfortable' } });
    });
    expect(screen.getByTestId('lane-width')).toHaveTextContent('wide');

    rerender(<Shell chat={false} />);
    rerender(<Shell chat />);
    await waitFor(() => expect(screen.getByTestId('lane-width')).toHaveTextContent('wide'));
    expect(window.localStorage.getItem(LANE_WIDTH_STORAGE_KEY)).toBe('wide');
  });

  it('still adopts the server value on a fresh visit when this session never chose', async () => {
    window.localStorage.setItem(LANE_WIDTH_STORAGE_KEY, 'wide');
    effective.mockResolvedValue({ ...base, misc: { [LANE_WIDTH_PREF_KEY]: 'comfortable' } });
    const { rerender } = render(<Shell chat={false} />);
    await waitFor(() => expect(effective).toHaveBeenCalled());
    rerender(<Shell chat />);
    await waitFor(() => expect(screen.getByTestId('lane-width')).toHaveTextContent('comfortable'));
    expect(window.localStorage.getItem(LANE_WIDTH_STORAGE_KEY)).toBe('comfortable');
    expect(putUser).not.toHaveBeenCalled();
  });
});
