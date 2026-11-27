/**
 * useChatLaneWidth (Round 12 SPEC D12): the viewer's conversation width. Wide by
 * default; the localStorage mirror paints first; the server value
 * (`UserPrefs.misc.chat_lane_width`) wins once prefs hydrate unless the viewer already
 * chose; every choice writes both, best-effort; nothing breaks without storage, a
 * server or a PrefsProvider. The lane vars it feeds are pinned too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const { putUserMock, prefsState } = vi.hoisted(() => ({
  putUserMock: vi.fn(),
  prefsState: {
    value: null as null | { ready: boolean; prefs: { misc: Record<string, unknown> }; patchMisc?: (patch: Record<string, unknown>) => void },
  },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, prefs: { ...actual.api.prefs, putUser: putUserMock } } };
});
vi.mock('@/soc/prefs', () => ({ useOptionalPrefs: () => prefsState.value }));

import { DEFAULT_LANE_WIDTH, LANE_GUTTER, LANE_MAX, laneVars } from '../../message/lane';
import { LANE_WIDTH_PREF_KEY, LANE_WIDTH_STORAGE_KEY, useChatLaneWidth } from '../useChatLaneWidth';

beforeEach(() => {
  putUserMock.mockReset();
  putUserMock.mockResolvedValue({});
  prefsState.value = null;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lane vars', () => {
  it('maps each width to its cap and always sets the container-relative gutter', () => {
    // Full width is the default (Round 12 final review, operator ask 1).
    expect(DEFAULT_LANE_WIDTH).toBe('full');
    expect(LANE_MAX).toEqual({ comfortable: '64rem', wide: '88rem', full: '100%' });
    expect(LANE_GUTTER).toBe('clamp(1rem, 2.5cqi, 2.5rem)');
    expect(laneVars('comfortable')).toEqual({ '--chat-gutter': LANE_GUTTER, '--chat-lane-max': '64rem' });
    expect(laneVars('full')['--chat-lane-max']).toBe('100%');
  });
});

describe('useChatLaneWidth', () => {
  it('defaults to Full width without storage, prefs or a provider', () => {
    const { result } = renderHook(() => useChatLaneWidth());
    expect(result.current.width).toBe('full');
  });

  it('paints the stored choice first and ignores a junk value', () => {
    window.localStorage.setItem(LANE_WIDTH_STORAGE_KEY, 'comfortable');
    expect(renderHook(() => useChatLaneWidth()).result.current.width).toBe('comfortable');
    window.localStorage.setItem(LANE_WIDTH_STORAGE_KEY, 'enormous');
    expect(renderHook(() => useChatLaneWidth()).result.current.width).toBe('full');
  });

  it('keeps a stored Wide or Comfortable choice: only a viewer who never chose gets Full width', () => {
    for (const chosen of ['wide', 'comfortable'] as const) {
      window.localStorage.setItem(LANE_WIDTH_STORAGE_KEY, chosen);
      expect(renderHook(() => useChatLaneWidth()).result.current.width).toBe(chosen);
    }
    // The account's stored choice wins over the default once prefs hydrate.
    window.localStorage.clear();
    prefsState.value = { ready: true, prefs: { misc: { [LANE_WIDTH_PREF_KEY]: 'wide' } } };
    const { result } = renderHook(() => useChatLaneWidth());
    expect(result.current.width).toBe('wide');
    expect(window.localStorage.getItem(LANE_WIDTH_STORAGE_KEY)).toBe('wide');
    // An account that never chose keeps the default and writes nothing.
    window.localStorage.clear();
    prefsState.value = { ready: true, prefs: { misc: {} } };
    expect(renderHook(() => useChatLaneWidth()).result.current.width).toBe('full');
    expect(window.localStorage.getItem(LANE_WIDTH_STORAGE_KEY)).toBeNull();
    expect(putUserMock).not.toHaveBeenCalled();
  });

  it('adopts the server value once prefs hydrate, and mirrors it locally', () => {
    window.localStorage.setItem(LANE_WIDTH_STORAGE_KEY, 'wide');
    prefsState.value = { ready: false, prefs: { misc: {} } };
    const { result, rerender } = renderHook(() => useChatLaneWidth());
    expect(result.current.width).toBe('wide');
    prefsState.value = { ready: true, prefs: { misc: { [LANE_WIDTH_PREF_KEY]: 'comfortable' } } };
    rerender();
    expect(result.current.width).toBe('comfortable');
    expect(window.localStorage.getItem(LANE_WIDTH_STORAGE_KEY)).toBe('comfortable');
  });

  it('keeps a choice made before prefs hydrate, and writes both mirrors', async () => {
    prefsState.value = { ready: false, prefs: { misc: {} } };
    const { result, rerender } = renderHook(() => useChatLaneWidth());
    await act(async () => result.current.setWidth('full'));
    expect(result.current.width).toBe('full');
    expect(window.localStorage.getItem(LANE_WIDTH_STORAGE_KEY)).toBe('full');
    expect(putUserMock).toHaveBeenCalledWith({ misc: { [LANE_WIDTH_PREF_KEY]: 'full' } });
    prefsState.value = { ready: true, prefs: { misc: { [LANE_WIDTH_PREF_KEY]: 'comfortable' } } };
    rerender();
    expect(result.current.width).toBe('full');
  });

  it('writes through the provider when there is one, so its snapshot learns the choice', async () => {
    const patchMisc = vi.fn();
    prefsState.value = { ready: true, prefs: { misc: {} }, patchMisc };
    const { result } = renderHook(() => useChatLaneWidth());
    await act(async () => result.current.setWidth('comfortable'));
    expect(patchMisc).toHaveBeenCalledWith({ [LANE_WIDTH_PREF_KEY]: 'comfortable' });
    // The provider persists it; no second, direct write.
    expect(putUserMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LANE_WIDTH_STORAGE_KEY)).toBe('comfortable');
  });

  it('survives a failing server write and a throwing storage', async () => {
    putUserMock.mockRejectedValue(new Error('offline'));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { result } = renderHook(() => useChatLaneWidth());
    await act(async () => result.current.setWidth('comfortable'));
    expect(result.current.width).toBe('comfortable');
    setItem.mockRestore();
    // An invalid value is refused.
    await act(async () => result.current.setWidth('giant' as never));
    expect(result.current.width).toBe('comfortable');
  });
});
