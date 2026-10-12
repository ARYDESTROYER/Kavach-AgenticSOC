/**
 * material-recipes — the class strings of the Console's ONE translucent material
 * (ui-standard "Materials", SYNTHESIS-ux §1.4), re-exported by `ui-recipes.ts`.
 *
 * Its own module so it stays OUT of the entry chunk: only lazy page chunks wear the
 * material (the top bar is `GlassSurface`), so these strings load with the first page
 * that needs them. Same rules as `ui-recipes.ts`: token-only, plain strings, composable
 * with `cn()`. This file and `ui-recipes.ts` are the only places a blur may be spelled
 * (`material-gate.test.ts`).
 */

/**
 * materialBar — the ONE translucent material, regular thickness: floating chrome only
 * (sticky page / control / filter bars, the sticky case header). Never behind data.
 *
 * Fill opacity is 0.97, with or without `backdrop-filter` support. The fill alone has
 * to hide what scrolls beneath, because the blur cannot be relied on: in Chromium the
 * backdrop blur does not reach routed content (measured on the Overview at 768 and 1920,
 * on first load and after navigation; one cause is the `both`-filled entrance fade on
 * the route wrapper, which leaves a finished opacity effect on an ancestor), so the bar
 * was its fill and nothing else. At 0.80 that let chart labels and card text read
 * straight through (Round 12 screenshot tour), and 0.95 still left bold labels legible
 * to a careful eye (about 1.1:1). At 0.97 text beneath is a wash of colour, about 1.06:1
 * against the bar in both themes; where an engine does blur, the material keeps its
 * frosted tint. The fill also lifts 12px secondary text on the bar well clear of AA.
 * The `material-surface` marker carries the scroll-edge fade
 * (`data-scrolled="true"`, see `useScrollEdge`) and every fallback in theme.css:
 * solid under prefers-reduced-transparency / `data-transparency="reduced"`, solid
 * with a defined border under prefers-contrast: more, and solid when nested inside
 * another material (no translucent-on-translucent stacking).
 *
 * On a material, small text uses `text-foreground` or `text-secondary-foreground`
 * at `font-medium`; colour lives on solid chips, never on the translucent layer.
 */
export const materialBar =
  'material-surface bg-background/[0.97] ' +
  'supports-[backdrop-filter]:backdrop-blur-xl supports-[backdrop-filter]:backdrop-saturate-150';

/**
 * materialThick — the same material, thicker, for LARGE floating panes (a sheet
 * header that content scrolls under, a palette over a live page). Bigger surfaces
 * read as thicker: more fill (0.98) and a stronger blur. Same marker, same fallbacks —
 * which paint `--material-solid` (`--popover` here; `--background` when unset, as on
 * `materialBar`), so a solid thick pane keeps the colour of the pane it belongs to.
 */
export const materialThick =
  'material-surface [--material-solid:var(--popover)] bg-popover/[0.98] ' +
  'supports-[backdrop-filter]:backdrop-blur-2xl supports-[backdrop-filter]:backdrop-saturate-150';
