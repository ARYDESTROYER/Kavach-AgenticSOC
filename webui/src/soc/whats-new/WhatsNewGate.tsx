/**
 * The entry-chunk gate for the What's new welcome (Round 16 SPEC D7, §3.1: at most 450 B).
 *
 * Mounted by `App.tsx` beside the re-authentication dialog, so only once the shell shows:
 * never over sign-in, setup, a forced password change or the wizard. It compares the
 * person's marker (`misc.whats_new_seen`) with the newest update id this build ships
 * (`__AGENTIC_SOC_WHATS_NEW_LATEST__`, a few bytes). Only when they differ, the
 * preferences were actually read (`loaded`, not merely settled) and the personal switch
 * is on does it load the lazy host, through the What's new page chunk (one chunk for the
 * page and the welcome; the route thunk is shared with the registry). A failed load
 * renders nothing and the welcome waits for the next page load; it is not retried here,
 * since a retry would cost entry bytes for a dialog nobody has to see. Everything else
 * (the short wait after the shell paints, this browser's fallback copy of the marker, the
 * wait while a record is open or another dialog is up, the notes) lives in the lazy host.
 */
import * as React from 'react';

import { usePrefs } from '../prefs';

/** The newest release-notes update id bundled with this build. */
export const WHATS_NEW_LATEST = __AGENTIC_SOC_WHATS_NEW_LATEST__;

/** The What's new chunk: the Communication page and the welcome host. */
export const loadWhatsNew = () => import('../pages/WhatsNew');

// A failed load resolves to a component that renders nothing, so nothing throws. (Not
// React.Fragment: a lazy component must be a function or a component object, and React
// cannot mount a Symbol it was handed.)
const Host = React.lazy<React.ComponentType>(() =>
  loadWhatsNew().then(
    (module) => ({ default: module.WhatsNewHost }),
    () => ({ default: () => null }),
  ),
);

export function WhatsNewGate(): React.ReactElement | null {
  const { prefs, loaded } = usePrefs();
  const misc = prefs.misc || {};
  return loaded && misc.whats_new_auto !== false && misc.whats_new_seen !== WHATS_NEW_LATEST ? (
    <React.Suspense fallback={null}>
      <Host />
    </React.Suspense>
  ) : null;
}
