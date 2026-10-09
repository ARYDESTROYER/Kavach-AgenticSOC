/**
 * usePrefersReducedMotion — SSR-safe, reactive `(prefers-reduced-motion: reduce)`.
 *
 * Round-5 W0-B B5: replaced the inlined one-shot `matchMedia('(prefers-reduced-
 * motion: reduce)')` reads (`components/SettingsGrid.tsx` and the pre-revamp chat panel)
 * with one shared, reactive hook so motion decisions update live if the OS preference
 * flips.
 *
 * Returns `true` when the user has requested reduced motion. Under SSR / jsdom without
 * `matchMedia` it returns `false` (animate-by-default, matching the app's current
 * behaviour), via the single `useMediaQuery` subscription.
 */
import { useMediaQuery } from './useMediaQuery';

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY);
}
