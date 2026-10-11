/**
 * useChatLaneWidth — the viewer's conversation width (Round 12 SPEC D12): Comfortable
 * (64rem), Wide (88rem, the default) or Full width (no cap).
 *
 * A presentation preference, stored like the nav collapse (`useNavPrefs`): the
 * localStorage mirror paints first (no flash), then — once the effective prefs have
 * hydrated — the server value in `UserPrefs.misc.chat_lane_width` wins, so the choice
 * follows the viewer across devices, unless the viewer changed it in the meantime. Every
 * change writes both, best-effort: everything works without storage or a server.
 */
import * as React from 'react';

import { api } from '@/lib/api';
import { useOptionalPrefs } from '@/soc/prefs';
import { DEFAULT_LANE_WIDTH, isLaneWidth, type ChatLaneWidth } from '../message/lane';

export const LANE_WIDTH_STORAGE_KEY = 'soc.chat.laneWidth';
/** `UserPrefs.misc` key of the server mirror. */
export const LANE_WIDTH_PREF_KEY = 'chat_lane_width';

function readStored(): ChatLaneWidth | null {
  try {
    const value = window.localStorage?.getItem(LANE_WIDTH_STORAGE_KEY) ?? null;
    return isLaneWidth(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStored(value: ChatLaneWidth): void {
  try {
    window.localStorage?.setItem(LANE_WIDTH_STORAGE_KEY, value);
  } catch {
    /* A presentation preference only. */
  }
}

export interface ChatLaneWidthPreference {
  width: ChatLaneWidth;
  setWidth: (width: ChatLaneWidth) => void;
}

export function useChatLaneWidth(): ChatLaneWidthPreference {
  const prefs = useOptionalPrefs();
  const [width, setWidthState] = React.useState<ChatLaneWidth>(() => readStored() ?? DEFAULT_LANE_WIDTH);
  const touchedRef = React.useRef(false);
  const reconciledRef = React.useRef(false);

  const ready = prefs?.ready ?? false;
  const misc = prefs?.prefs.misc;
  React.useEffect(() => {
    if (!ready || reconciledRef.current) return;
    reconciledRef.current = true;
    const stored = misc && typeof misc === 'object' ? (misc as Record<string, unknown>)[LANE_WIDTH_PREF_KEY] : undefined;
    if (touchedRef.current || !isLaneWidth(stored)) return;
    setWidthState(stored);
    writeStored(stored);
  }, [ready, misc]);

  const setWidth = React.useCallback((next: ChatLaneWidth) => {
    if (!isLaneWidth(next)) return;
    touchedRef.current = true;
    setWidthState(next);
    writeStored(next);
    void api.prefs.putUser({ misc: { [LANE_WIDTH_PREF_KEY]: next } }).catch(() => {
      /* best-effort: the local choice already applies */
    });
  }, []);

  return { width, setWidth };
}
