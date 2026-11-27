/**
 * The sign-out signal (Round 14): lazy modules that keep memory for the person signed in
 * to this tab (the Analytics range, for one) forget it when that person leaves.
 *
 * `AuthProvider` (`soc/auth.tsx`) calls {@link notifySignedOut} when the signed-in person
 * leaves this tab: a deliberate sign-out, a session the server reports ended, or another
 * person signed in to the same browser. A lazy module subscribes once, at load, with
 * {@link onSignedOut}. Entry-safe and dependency-free: the provider ships at first paint.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Run `listener` whenever the person signed in to this tab leaves; returns an unsubscribe. */
export function onSignedOut(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tell every subscriber that the signed-in person left. A failing listener never blocks the rest. */
export function notifySignedOut(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      /* forgetting is best effort; the sign-out itself has already happened */
    }
  }
}
