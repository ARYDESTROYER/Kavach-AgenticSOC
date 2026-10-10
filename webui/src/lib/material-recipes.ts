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
 * Fill opacity stays ≥ 0.80 so 12px secondary text keeps AA over the worst realistic
 * content blurred beneath it; without `backdrop-filter` support it is a near-solid
 * 0.85. The `material-surface` marker carries the scroll-edge fade
 * (`data-scrolled="true"`, see `useScrollEdge`) and every fallback in theme.css:
 * solid under prefers-reduced-transparency / `data-transparency="reduced"`, solid
 * with a defined border under prefers-contrast: more, and solid when nested inside
 * another material (no translucent-on-translucent stacking).
 *
 * On a material, small text uses `text-foreground` or `text-secondary-foreground`
 * at `font-medium`; colour lives on solid chips, never on the translucent layer.
 */
export const materialBar =
  'material-surface bg-background/85 supports-[backdrop-filter]:bg-background/80 ' +
  'supports-[backdrop-filter]:backdrop-blur-xl supports-[backdrop-filter]:backdrop-saturate-150';

/**
 * materialThick — the same material, thicker, for LARGE floating panes (a sheet
 * header that content scrolls under, a palette over a live page). Bigger surfaces
 * read as thicker: more fill and a stronger blur. Same marker, same fallbacks — which
 * paint `--material-solid` (`--popover` here; `--background` when unset, as on
 * `materialBar`), so a solid thick pane keeps the colour of the pane it belongs to.
 */
export const materialThick =
  'material-surface [--material-solid:var(--popover)] bg-popover/95 supports-[backdrop-filter]:bg-popover/90 ' +
  'supports-[backdrop-filter]:backdrop-blur-2xl supports-[backdrop-filter]:backdrop-saturate-150';
