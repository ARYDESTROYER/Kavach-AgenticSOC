/**
 * Reduce transparency — the in-app override for the Console material.
 *
 * theme.css turns every material solid under `prefers-reduced-transparency: reduce`.
 * Safari never reports that query, and Firefox only behind a flag, so an operator who
 * turned on "Reduce transparency" in macOS would still get translucent, blurred bars.
 * Settings → Appearance therefore offers "Reduce transparency":
 * System (follow the browser's report) or On (always solid). "On" stamps
 * `data-transparency="reduced"` on <html>, which theme.css honours exactly like the
 * media query (`:root[data-transparency='reduced']`).
 *
 * Where the choice lives:
 *   - per user, in `UserPrefs.misc.transparency` (follows the operator across devices);
 *   - mirrored in localStorage `soc.transparency`, which the blocking pre-paint script in
 *     index.html reads so the first frame is already solid (no translucent flash) and
 *     which keeps the choice on this device when the prefs request fails.
 *
 * First-paint code (`prefs.tsx` applies the stored value when the prefs hydrate), so it
 * stays React-free and as small as it can be: a reader of the choice in force asks <html>
 * (`data-transparency`), which the pre-paint stamp and every apply keep current.
 */

/** The two choices. `system` follows `prefers-reduced-transparency` where reported. */
export type TransparencyPreference = 'system' | 'reduced';

/** localStorage mirror (read by the pre-paint script in index.html — keep in sync). */
export const TRANSPARENCY_STORAGE_KEY = 'soc.transparency';

/** `UserPrefs.misc` key holding the per-user choice. */
export const TRANSPARENCY_PREF_KEY = 'transparency';

/**
 * Apply a choice to <html> and mirror it on this device. Anything that is not one of the
 * two known values (an absent or corrupt server field) is ignored, so the device's own
 * mirror stays in force.
 */
export function applyTransparencyPreference(value: unknown): void {
  if (value !== 'reduced' && value !== 'system') return;
  const root = document.documentElement;
  if (value === 'reduced') root.dataset.transparency = value;
  else delete root.dataset.transparency;
  try {
    localStorage.setItem(TRANSPARENCY_STORAGE_KEY, value);
  } catch {
    /* storage unavailable — the attribute above still applies for this page */
  }
}
