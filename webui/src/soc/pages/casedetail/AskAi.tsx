/**
 * The case detail's "Ask AI" chip (Round 12 WP-ASK), loaded on demand.
 *
 * `AskAiChip` (and its question templates) must not become a statically shared chunk:
 * every route that reaches the case detail would then name it in its preload list, and
 * those lists live in the entry chunk, which sits at its size ceiling. So the facts
 * rail, the header, the Overview and the Threat context import only this wrapper, which
 * is itself part of the case detail chunk. The chip's load starts when this module loads
 * and the chip renders once it has arrived (quiet until hover anyway); if it cannot load,
 * there is simply no chip. Hosts write the `group/ask` row class literally for the same
 * reason.
 *
 * From inside a case the chip opens the Workspace chat on a NEW conversation, never this
 * case's own chat thread (#5). It hands the chat page a typed reference, never free text.
 */
import * as React from 'react';

import type { AskAiChipProps } from '@/soc/components/AskAiChip';
import { useAuth } from '@/soc/auth';
import { useRoute } from '@/soc/router';

type AskAiChipModule = typeof import('@/soc/components/AskAiChip');
let askAiChipModule: AskAiChipModule | null = null;
const askAiChipLoad: Promise<AskAiChipModule | null> = import('@/soc/components/AskAiChip').then(
  (loaded) => (askAiChipModule = loaded),
  () => null,
);

/**
 * A shell context, or null outside it. `useAuth` / `useRoute` read their context before
 * they throw, so hook order is stable; the hook is looked up inside the guard too (a test
 * double of the module may not export it).
 */
function useOptionalContext<T>(pick: () => () => T): T | null {
  try {
    return pick()();
  } catch {
    return null;
  }
}

export function AskAi(props: AskAiChipProps) {
  const auth = useOptionalContext(() => useAuth);
  const route = useOptionalContext(() => useRoute);
  const [loaded, setLoaded] = React.useState(askAiChipModule);
  React.useEffect(() => {
    if (loaded) return undefined;
    let live = true;
    void askAiChipLoad.then((next) => {
      if (live && next) setLoaded(next);
    });
    return () => {
      live = false;
    };
  }, [loaded]);
  return loaded ? (
    <loaded.AskAiChip {...props} navigate={route?.navigate} hasPermission={auth?.hasPermission} />
  ) : null;
}
