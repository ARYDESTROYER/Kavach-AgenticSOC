/**
 * ui-recipes — the ONE spelling for the class strings that were drifting across
 * the primitive layer (DESIGN_STANDARD §5.1). Import these instead of re-typing
 * the focus ring / floating surface / menu item / modal backdrop by hand so the
 * whole console stays byte-consistent.
 *
 * Rules:
 *  - token-only (no hex, no arbitrary `text-[..]`); every value resolves through
 *    the theme.css design tokens (W0-A).
 *  - composable with `cn()` — pass extra utilities after the recipe.
 *  - a11y: `focusRing` uses `focus-visible` (never bare `focus:`) and an offset so
 *    the ring is visible on any surface; `--ring` is measured ≥3:1 both themes.
 *
 * These are plain strings (not functions) so they inline cleanly into `cn(...)`
 * and into cva base strings.
 */

/**
 * focusRing — the single keyboard-focus treatment. Applied to every interactive
 * primitive (input / textarea / checkbox / switch / radio / slider / select /
 * button / menu triggers). Uses `focus-visible` so pointer clicks don't flash a
 * ring, plus a background-colored offset so the 2px ring reads on any surface.
 */
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/**
 * The shared floating-surface body: the SOLID popover token pair, the concentric 10px
 * radius (`rounded-lg`, items inside a `p-1` inset are 6px) and the Radix open/close
 * fade + zoom. The enter rides the critically damped spring curve (`ease-spring`,
 * `--motion-ui`); the exit stays a short default fade so a closing layer never holds
 * the pointer. Reduced motion turns both into a pure cross-fade (theme.css).
 *
 * Never translucent: a menu opened from a material bar would otherwise stack
 * translucent on translucent (ui-standard "Materials").
 *
 * The surface scales FROM ITS TRIGGER: one base rule in theme.css points every Radix
 * popper's content at `--radix-popper-transform-origin` (the anchor-relative origin
 * Radix publishes on the popper wrapper), so no primitive carries a per-part class.
 */
const floatingSurface =
  'bg-popover text-popover-foreground rounded-lg border border-border ' +
  'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
  'data-[state=open]:duration-ui data-[state=open]:ease-spring ' +
  'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 ' +
  'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95';

/**
 * overlaySurface — the detached-panel surface (Popover / HoverCard). Overlay
 * elevation (`shadow-overlay`), like dialogs and the palette.
 */
export const overlaySurface = `${floatingSurface} shadow-overlay`;

/**
 * menuSurface — the menu surface (DropdownMenu / Select / sub-menus). Identical to
 * `overlaySurface` except for the lighter menu elevation (`shadow-menu`).
 */
export const menuSurface = `${floatingSurface} shadow-menu`;

/**
 * menuItem — the single selectable row inside a menu/command surface. Bridges
 * Radix's `focus:` highlight and cmdk's `data-[selected=true]` so keyboard and
 * mouse selection look identical; `data-[disabled]` dims + blocks pointer events.
 * 6px (`rounded-sm`): concentric inside a 10px surface with a 4px (`p-1`) inset.
 */
export const menuItem =
  'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none ' +
  'focus:bg-accent focus:text-accent-foreground data-[selected=true]:bg-accent ' +
  'data-[selected=true]:text-accent-foreground ' +
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

/**
 * materialBar / materialThick — the ONE translucent material (floating chrome only).
 * Defined in `./material-recipes` and re-exported here so every recipe keeps one import
 * path. They live in their own module because no first-paint component wears the
 * material: this file rides the entry chunk (the menu, dialog and focus recipes are
 * first-paint code), and a definition here would ship to every page load.
 */
export { materialBar, materialThick } from './material-recipes';

/**
 * modalSurface — the one centred modal panel (Dialog and AlertDialog shared it by copy).
 *
 * - 14px (`rounded-xl`): the concentric step above a 10px menu, holding its own 8px
 *   controls; overlay elevation like every detached portal.
 * - `max-h` + internal scroll so a dialog taller than the viewport never clips its title
 *   or footer off-screen.
 * - The enter/exit keyframes REPLACE `transform`, so they carry the same −50%/−50%
 *   centring as the resting panel (`slide-*-1/2`); without it the first frame sits half a
 *   panel down-right of centre and the zoom reads as a diagonal slide.
 * - Enter on the critically damped spring; exit is a short fade so the scrim never holds
 *   the pointer after a close. Reduced motion: an opacity-only cross-fade (theme.css).
 */
export const modalSurface =
  'fixed left-1/2 top-1/2 z-50 grid max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto ' +
  'rounded-xl border border-border bg-card p-6 text-foreground shadow-overlay ' +
  'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
  'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 ' +
  'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 ' +
  'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-1/2 ' +
  'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-1/2 ' +
  'data-[state=open]:duration-ui data-[state=open]:ease-spring data-[state=closed]:duration-base';

/**
 * modalOverlay — the single dialog/alert/sheet backdrop (was triplicated). A
 * dimmed scrim + a faint blur + the standard fade. `z-50` sits under the modal
 * content (also `z-50`) but above the page.
 */
export const modalOverlay =
  'fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] ' +
  'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
  'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0';
