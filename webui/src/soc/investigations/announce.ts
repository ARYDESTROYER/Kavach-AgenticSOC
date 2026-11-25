/**
 * Polite announcements for AI runs (Round 16 SPEC §4.5 WP09): at most one every 10 s.
 * A change that arrives sooner waits for the 10 s mark and then says the latest state,
 * so the last word (a finished run) is never lost. Through the app's one live region
 * (`useAnnouncer`); plain text only (#9).
 */
import * as React from 'react';

import { useAnnouncer } from '@/soc/components/announcer';

export const ANNOUNCE_EVERY_MS = 10_000;

export function useThrottledAnnouncement(message: string, everyMs = ANNOUNCE_EVERY_MS): void {
  const announce = useAnnouncer();
  const last = React.useRef(-Infinity);
  const said = React.useRef('');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!message || message === said.current) return undefined;
    const speak = () => {
      timer.current = null;
      last.current = Date.now();
      said.current = message;
      announce(message, 'polite');
    };
    const wait = last.current + everyMs - Date.now();
    if (wait <= 0) speak();
    else timer.current = setTimeout(speak, wait);
    return undefined;
  }, [message, everyMs, announce]);

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
}
