/**
 * ChatActivityMonitor — the shell's observer for chat turns (Round 12, SPEC D13),
 * mounted beside `JobMonitor`. Entry-safe and tiny: it owns only the lifetime rules
 * (sign-out and a change of user forget every turn) and loads the rest after first
 * paint (`ActivityEffects`: other tabs, the server's running turns, the "Answer ready"
 * toast and announcement, the tab-title prefix).
 */
import * as React from 'react';

import type { Navigate } from '@/soc/router';
import { clearChatActivity } from './store';

const ActivityEffects = React.lazy(() => import('./ActivityEffects'));

let mounted = 0;

export function ChatActivityMonitor({ username, onNavigate }: { username?: string | null; onNavigate: Navigate }) {
  const userRef = React.useRef(username ?? '');

  // Another user in the same shell: nothing of the previous one may show.
  React.useEffect(() => {
    const next = username ?? '';
    if (userRef.current === next) return;
    userRef.current = next;
    clearChatActivity();
  }, [username]);

  // The shell goes away on sign-out (or a session that ended): forget every turn and
  // stop reading them (the server still finishes and saves them). Deferred one tick so
  // a development double mount does not clear a live store.
  React.useEffect(() => {
    mounted += 1;
    return () => {
      mounted -= 1;
      setTimeout(() => {
        if (mounted === 0) clearChatActivity();
      }, 0);
    };
  }, []);

  // The cross-tab and server parts are their own small chunk; nothing waits for it.
  return (
    <React.Suspense fallback={null}>
      <ActivityEffects username={username ?? ''} onNavigate={onNavigate} />
    </React.Suspense>
  );
}
