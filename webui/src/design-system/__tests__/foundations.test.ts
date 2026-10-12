/**
 * Round 12 design foundations (SPEC D16, SYNTHESIS-ux §1) — the source-level contract.
 *
 * These read `tailwind.config.js` and `styles/theme.css` as TEXT (the gates do the same;
 * nothing here imports the build) and pin the decisions that a later edit could quietly
 * undo:
 *   1. tracking is size-specific and follows Inter's dynamic-metrics curve;
 *   2. radii are concentric, all anchored to the one brandable `--radius`;
 *   3. the spring vocabulary has CSS tokens and a critically damped curve;
 *   4. reduced motion keeps a cross-fade; reduced transparency and increased contrast
 *      make every material solid; the in-app transparency override exists;
 *   5. MEASURED: under `prefers-contrast: more` borders — INCLUDING the alpha hairline
 *      variants (`border-border/60`, `/70`, `/80`) — clear 3:1 on the card and the page
 *      background, secondary text clears 7:1 and is never weaker than muted text, in
 *      both themes; and the login identity canvas, which re-declares its own neutrals,
 *      gets the same treatment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  THEME_CSS_PATH,
  WEBUI_ROOT,
  contrastRatio,
  hexToRgb,
  hslTripleToRgb,
  parseThemeCss,
  resolveToken,
  resolveTokenRgb,
  type Rgb,
} from '../../../scripts/lib/theme-css.mjs';

const css = fs.readFileSync(THEME_CSS_PATH, 'utf8');
const tailwind = fs.readFileSync(path.join(WEBUI_ROOT, 'tailwind.config.js'), 'utf8');

/** Inter's published curve: tracking(em) = −0.0223 + 0.185·e^(−0.1745·px). */
const interTracking = (px: number) => -0.0223 + 0.185 * Math.exp(-0.1745 * px);

/** The `{ … }` body of the block that follows `header` (brace-balanced). */
function blockAfter(source: string, header: string): string {
  const at = source.indexOf(header);
  expect(at, `missing block: ${header}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block: ${header}`);
}

/** Declarations of the FIRST `selector {` rule inside a block body. */
function declsOf(body: string, selector: string): Map<string, string> {
  const inner = blockAfter(body, `${selector} {`);
  const map = new Map<string, string>();
  for (const m of inner.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
    map.set(m[1], m[2].replace(/\s*!important\s*$/, '').trim());
  }
  return map;
}

describe('typography: size-specific tracking (Inter dynamic metrics)', () => {
  const steps: Array<[string, number]> = [
    ['2xs', 11],
    ['xs', 12],
    ['sm', 13],
    ['base', 14],
    ['md', 15],
    ['lg', 16],
    ['xl', 18],
    ['2xl', 20],
    ['3xl', 24],
    ['4xl', 30],
    ['display', 32],
  ];

  it.each(steps)('the %s step (%ipx) carries the curve value', (key, px) => {
    const re = new RegExp(`(?:'${key}'|\\b${key}):\\s*\\['([\\d.]+)rem',\\s*\\{[^}]*letterSpacing:\\s*'(-?[\\d.]+)em'`);
    const m = re.exec(tailwind);
    expect(m, `fontSize.${key} must declare letterSpacing`).not.toBeNull();
    expect(Number(m![1]) * 16).toBeCloseTo(px, 5);
    // Rounded to 1/1000 em in the config; ≤ 0.0015em off the curve.
    expect(Math.abs(Number(m![2]) - interTracking(px))).toBeLessThan(0.0015);
  });

  it('tightens as text grows and is slightly positive only at 11px', () => {
    const values = steps.map(([key]) => {
      const m = new RegExp(`(?:'${key}'|\\b${key}):\\s*\\[[^\\]]*letterSpacing:\\s*'(-?[\\d.]+)em'`).exec(tailwind);
      return Number(m![1]);
    });
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
    expect(values[0]).toBeGreaterThan(0);
    expect(values[1]).toBe(0);
  });

  it('gives unsized body text the 14px value', () => {
    expect(blockAfter(css, '  body {')).toMatch(/letter-spacing:\s*-0\.006em/);
  });

  it('sizes the fluid hero numeral from its tile (container units), never the viewport', () => {
    // MEASURED Inter tabular figures at weight 600: a digit and `≥` are 0.626em, a comma
    // 0.248em. The widest string each rung must hold, as a multiple of the font size.
    const widest = { '': 3.9, '-md': 4.7, '-sm': 6.2 } as const;
    for (const [suffix, ems] of Object.entries(widest)) {
      const rule = blockAfter(css, `.kpi-numeral-fluid${suffix} {`);
      expect(rule).not.toMatch(/\d(?:vw|vh|vi|svw|dvw|lvw)\b/);
      const m = /font-size:\s*clamp\(([\d.]+)rem,\s*([\d.]+)cqi,\s*([\d.]+)rem\)/.exec(rule);
      expect(m, `.kpi-numeral-fluid${suffix} clamp`).not.toBeNull();
      // The preferred size fits its band inside the row it is sized from.
      expect(Number(m![2]) * ems).toBeLessThanOrEqual(100);
      // A plain fallback precedes the clamp (an engine without container units).
      expect(rule.indexOf('font-size')).toBeLessThan(rule.indexOf('clamp('));
    }
    expect(blockAfter(css, '.kpi-numeral-fluid {')).toMatch(/clamp\(1\.5rem,\s*25cqi,\s*2\.75rem\)/);
  });
});

describe('radii: one concentric scale on --radius', () => {
  /** The config's `borderRadius.<step>` expression (a CSS length string). */
  const radiusExpr = (step: string): string => {
    const block = /borderRadius:\s*\{([\s\S]*?)\n\s*\},/.exec(tailwind);
    expect(block, 'borderRadius block').not.toBeNull();
    const m = new RegExp(`\\b${step}:\\s*'([^']+)'`).exec(block![1]);
    expect(m, `borderRadius.${step}`).not.toBeNull();
    return m![1];
  };
  /**
   * Evaluate a radius step for a given `--radius` in px, as the browser computes it:
   * `calc()` sums and differences of px lengths and `min()`, and a negative result clamps
   * to 0 (a used border-radius is never negative). A deliberately tiny evaluator, so the
   * test reads the config's real expressions instead of a hand-copied table.
   */
  const radiusPx = (step: string, radius: number): number => {
    let expr = radiusExpr(step).replace(/var\(--radius\)/g, `${radius}px`);
    const sum = (body: string): number =>
      body
        .split(/\s+(?=[+-]\s)/)
        .reduce((acc, term) => {
          const m = /^([+-])?\s*(-?[\d.]+)px$/.exec(term.trim());
          expect(m, `unsupported radius term "${term}" in ${radiusExpr(step)}`).not.toBeNull();
          return acc + (m![1] === '-' ? -1 : 1) * Number(m![2]);
        }, 0);
    // Innermost first: min(a, b) → its value, then calc(…) → its sum.
    for (let guard = 0; /(min|calc)\(/.test(expr) && guard < 10; guard++) {
      expr = expr
        .replace(/min\(([^()]+),([^()]+)\)/g, (_m, a: string, b: string) => `${Math.min(sum(a), sum(b))}px`)
        .replace(/calc\(([^()]+)\)/g, (_m, body: string) => `${sum(body)}px`);
    }
    return Math.max(0, sum(expr));
  };

  it('derives sm/md/lg/xl from --radius (6 · 8 · 10 · 14 at the default)', () => {
    const { light } = parseThemeCss();
    expect(light.get('--radius')).toBe('0.625rem');
    expect(['sm', 'md', 'lg', 'xl'].map((step) => radiusPx(step, 10))).toEqual([6, 8, 10, 14]);
    // Every step is anchored to the one brandable token.
    for (const step of ['sm', 'md', 'lg', 'xl']) expect(radiusExpr(step)).toContain('var(--radius)');
  });

  it('squares EVERY step under the "Square" brand preset (--radius: 0rem)', () => {
    // A dialog or sheet must not keep 4px corners when the operator chose square ones.
    expect(['sm', 'md', 'lg', 'xl'].map((step) => radiusPx(step, 0))).toEqual([0, 0, 0, 0]);
  });

  it('stays concentric (strictly increasing) at the other brand anchors', () => {
    for (const radius of [6, 16]) {
      const steps = ['sm', 'md', 'lg', 'xl'].map((step) => radiusPx(step, radius));
      for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    }
  });

  it('gives toasts the 10px menu radius from CSS (no inline style in the entry bundle)', () => {
    // sonner reads its corner from `--border-radius`, declared at zero specificity.
    const base = blockAfter(css, '@layer base {');
    expect(base).toMatch(/\[data-sonner-toaster\]\s*\{\s*--border-radius:\s*var\(--radius\);/);
    const sonner = fs.readFileSync(path.join(WEBUI_ROOT, 'src', 'ui', 'sonner.tsx'), 'utf8');
    expect(sonner).not.toMatch(/'--border-radius'/);
  });
});

describe('motion: one spring vocabulary in CSS', () => {
  it('declares the UI/pane/press durations and a spring curve token', () => {
    const { light } = parseThemeCss();
    expect(light.get('--motion-ui')).toBe('300ms');
    expect(light.get('--motion-pane')).toBe('350ms');
    expect(light.get('--motion-press')).toBe('100ms');
    expect(light.get('--motion-ease-spring')).toBeTruthy();
    expect(tailwind).toMatch(/spring:\s*'var\(--motion-ease-spring/);
  });

  it('upgrades the curve to a critically damped linear() only where supported', () => {
    const body = blockAfter(css, '@supports (transition-timing-function: linear(0, 1))');
    const curve = /--motion-ease-spring:\s*linear\(([^)]*)\)/.exec(body);
    expect(curve).not.toBeNull();
    const points = curve![1].split(',').map((p) => Number(p.trim()));
    expect(points[0]).toBe(0);
    expect(points[points.length - 1]).toBe(1);
    // Critically damped: monotonic, never overshoots 1.
    for (let i = 1; i < points.length; i++) expect(points[i]).toBeGreaterThanOrEqual(points[i - 1]);
    expect(Math.max(...points)).toBeLessThanOrEqual(1);
  });

  it('scales every Radix popper from its trigger with ONE base rule', () => {
    // Menus, popovers, hover cards, tooltips and popper selects: the wrapper carries the
    // anchor-relative origin; the content (its direct child) zooms from it. In the base
    // layer, so a consumer's own `origin-*` utility still wins.
    const base = blockAfter(css, '@layer base {');
    expect(base).toMatch(
      /\[data-radix-popper-content-wrapper\] > \*\s*\{\s*transform-origin:\s*var\(--radix-popper-transform-origin\);/,
    );
  });

  it('makes press feedback a 100ms transition', () => {
    expect(blockAfter(css, '  .press-scale {')).toMatch(/transform var\(--motion-press, 100ms\) ease-out/);
  });

  it('turns overlay enter/exit into an opacity-only cross-fade under reduced motion', () => {
    const blocks = css.split('@media (prefers-reduced-motion: reduce)').slice(1);
    const overlay = blocks.find((b) => b.includes("[class*='animate-in']"));
    expect(overlay).toBeDefined();
    // Radix overlays carry VARIANT classes (`data-[state=open]:animate-in`), never a bare
    // `.animate-in`, and wear the enter and exit classes together — so the selectors
    // match by substring and choose the keyframe by the live data-state.
    expect(overlay).toMatch(
      /\[class\*='animate-in'\]:not\(\[data-state='closed'\]\)\s*\{\s*animation-name:\s*console-reduced-enter !important/,
    );
    expect(overlay).toMatch(
      /\[data-state='closed'\]\[class\*='animate-out'\]\s*\{\s*animation-name:\s*console-reduced-exit !important/,
    );
    expect(overlay).toMatch(/animation-duration:\s*150ms !important/);
    // The swapped keyframes animate opacity ONLY, so an element's resting transform
    // (a dialog's −50% centring) is never replaced mid-fade.
    for (const name of ['console-reduced-enter', 'console-reduced-exit']) {
      const kf = blockAfter(css, `@keyframes ${name}`);
      expect(kf).toContain('opacity: 0');
      expect(kf).not.toContain('transform');
    }
  });
});

describe('materials: solid fallbacks', () => {
  it('paints every solid fallback with the recipe\'s own opaque token (thick → popover)', () => {
    // Four fallbacks: nested material, reduced transparency, the in-app override and
    // increased contrast. None may hard-code --background: a thick pane is --popover.
    const fills = [...css.matchAll(/\.material-surface[^{]*\{[^}]*background-color:\s*([^;]+);/g)].map((m) => m[1]);
    expect(fills.length).toBeGreaterThanOrEqual(4);
    for (const fill of fills) {
      expect(fill).toMatch(/^hsl\(var\(--material-solid, var\(--background\)\)\) !important$/);
    }
  });

  it("fades the scroll edge in the recipe's own colour, not the page background", () => {
    // A thick pane (`--popover`) over card content would otherwise trail a darker
    // page-coloured band below itself.
    const fade = blockAfter(css, ".material-surface[data-scrolled='true']::after {");
    const gradient = fade.match(/background:\s*linear-gradient\(([\s\S]*?)\);/)?.[1] ?? '';
    const stops = [...gradient.matchAll(/hsl\(([^/]*?)\s*\/\s*([\d.]+)\)/g)];
    expect(stops).toHaveLength(2);
    for (const [, colour] of stops) expect(colour).toBe('var(--material-solid, var(--background))');
    expect(gradient).not.toMatch(/hsl\(var\(--background\)/);
  });

  it('paints the material solid under reduced transparency', () => {
    const blocks = css.split('@media (prefers-reduced-transparency: reduce)').slice(1);
    expect(blocks.some((b) => /\.material-surface\s*\{[^}]*backdrop-filter:\s*none/.test(b))).toBe(true);
  });

  it('honours the in-app data-transparency="reduced" override', () => {
    expect(css).toMatch(/:root\[data-transparency='reduced'\] \.material-surface\s*\{[^}]*background-color/);
    expect(css).toMatch(/:root\[data-transparency='reduced'\] \.glass-surface/);
  });

  it('never stacks a material on another material or the glass top bar', () => {
    expect(css).toMatch(/\.material-surface \.material-surface,\s*\.glass-surface \.material-surface\s*\{/);
  });

  it('sets no position on the material marker (it would race the sticky utility)', () => {
    expect(css).not.toMatch(/\.material-surface\s*\{\s*position/);
  });
});

/**
 * The material hides what scrolls beneath it with its FILL, not its blur (Round 12
 * screenshot tour: at a 0.80 fill, chart labels and card text read straight through the
 * sticky Overview header at 768 and 1920). In Chromium the backdrop blur does not reach
 * routed content (lib/material-recipes.ts), so the fill is the whole defence.
 *
 * MEASURED: foreground text sitting on the card or the canvas, seen through the bar, may
 * differ from its own surface by at most ~1.07:1 — a wash of colour, not a word (0.95
 * left bold labels legible to a careful eye at ~1.1:1). Checked
 * for the sticky material (`materialBar`), the glass top bar in both themes, and the
 * optional 'command' material pack (allowed slightly more translucency, still no text).
 */
describe('materials: text scrolled beneath never reads (measured)', () => {
  const { light, dark } = parseThemeCss();
  const themes = { light, dark: new Map<string, string>([...light, ...dark]) };
  const recipes = fs.readFileSync(path.join(WEBUI_ROOT, 'src', 'lib', 'material-recipes.ts'), 'utf8');
  const themeTokens = fs.readFileSync(path.join(WEBUI_ROOT, 'src', 'soc', 'theme-tokens.ts'), 'utf8');

  const barFill = /export const materialBar =[\s\S]*?\bbg-background\/(?:(\d+)\b|\[(0?\.\d+)\])/.exec(recipes);
  const barAlpha = barFill?.[1] !== undefined ? Number(barFill[1]) / 100 : Number(barFill?.[2]);
  const commandGlass = Number(/command:\s*\{[\s\S]*?'--glass-opacity':\s*'([\d.]+)'/.exec(themeTokens)?.[1]);

  /** `top` at `alpha` over an opaque `under` (sRGB, source-over, as browsers paint). */
  const over = (top: Rgb, alpha: number, under: Rgb): Rgb =>
    top.map((c, i) => alpha * c + (1 - alpha) * under[i]) as Rgb;

  /** How far body text beneath a fill of `fill` at `alpha` still stands out, worst surface. */
  const ghost = (fill: Rgb, alpha: number, map: Map<string, string>) => {
    const text = resolveTokenRgb('--foreground', map)!;
    return Math.max(
      ...(['--card', '--canvas'] as const).map((surface) => {
        const ground = resolveTokenRgb(surface, map)!;
        return contrastRatio(over(fill, alpha, text), over(fill, alpha, ground));
      }),
    );
  };

  it('reads the fills it measures (a parse failure must not pass silently)', () => {
    expect(barAlpha).toBeGreaterThanOrEqual(0.97);
    expect(commandGlass).toBeGreaterThan(0);
    for (const map of Object.values(themes)) {
      expect(Number(resolveToken('--glass-opacity', map))).toBeGreaterThan(0);
    }
  });

  it.each(Object.entries(themes))('%s: the sticky material leaves text beneath unreadable', (_name, map) => {
    expect(ghost(resolveTokenRgb('--background', map)!, barAlpha, map)).toBeLessThanOrEqual(1.07);
  });

  it.each(Object.entries(themes))('%s: the glass top bar leaves text beneath unreadable', (_name, map) => {
    const alpha = Number(resolveToken('--glass-opacity', map));
    expect(ghost(resolveTokenRgb('--glass-tint', map)!, alpha, map)).toBeLessThanOrEqual(1.07);
  });

  it.each(Object.entries(themes))('%s: the command pack glass stays below a readable ghost', (_name, map) => {
    expect(ghost(resolveTokenRgb('--glass-tint', map)!, commandGlass, map)).toBeLessThanOrEqual(1.15);
  });

  it('starts the scroll-edge fade at the bar\'s own fill (no seam, no lighter band)', () => {
    const fade = blockAfter(css, ".material-surface[data-scrolled='true']::after {");
    const first = /hsl\([^/]*\/\s*([\d.]+)\)/.exec(fade)?.[1];
    expect(Number(first)).toBe(barAlpha);
  });
});

describe('prefers-contrast: more — measured', () => {
  const body = blockAfter(css, '@media (prefers-contrast: more)');
  const { light, dark } = parseThemeCss();
  const merged = (base: Map<string, string>, over: Map<string, string>) =>
    new Map<string, string>([...base, ...over]);
  const themes = {
    light: merged(light, declsOf(body, ':root')),
    dark: merged(dark, declsOf(body, '.dark')),
  };

  it.each(Object.entries(themes))('%s: borders become ≥3:1 structural lines', (_name, map) => {
    const ratio = contrastRatio(resolveTokenRgb('--border', map)!, resolveTokenRgb('--card', map)!);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  it.each(Object.entries(themes))('%s: secondary text clears AA by a wider margin', (name, map) => {
    const card = resolveTokenRgb('--card', map)!;
    const boosted = contrastRatio(resolveTokenRgb('--muted-foreground', map)!, card);
    const base = contrastRatio(
      resolveTokenRgb('--muted-foreground', name === 'light' ? light : dark)!,
      card,
    );
    expect(boosted).toBeGreaterThanOrEqual(7);
    expect(boosted).toBeGreaterThan(base);
  });

  /** Source-over compositing of `fg` at `alpha` onto an opaque `bg` (sRGB 0..1, as browsers paint). */
  const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb =>
    fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]) as Rgb;

  it('declares the hairline colour with the alpha floor (the only way alpha variants can rise)', () => {
    expect(tailwind).toMatch(
      /border:\s*'hsl\(var\(--border\) \/ max\(<alpha-value>, var\(--border-alpha-floor, 0\)\)\)'/,
    );
    // Nothing outside increased contrast sets the floor: by default every alpha
    // variant keeps exactly the opacity its author wrote.
    const outside = css.replace(body, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(outside).not.toMatch(/--border-alpha-floor\s*:/);
  });

  it.each(Object.entries(themes))(
    '%s: the alpha hairline variants (/40 … /80) are ≥3:1 on the card AND the page background',
    (_name, map) => {
      const floor = Number(map.get('--border-alpha-floor') ?? 0);
      expect(floor).toBe(1);
      const border = resolveTokenRgb('--border', map)!;
      for (const surface of ['--card', '--background']) {
        const bg = resolveTokenRgb(surface, map)!;
        for (const alpha of [0.4, 0.6, 0.7, 0.8]) {
          // What the browser paints for `border-border/<alpha>`: max(alpha, floor).
          const painted = over(border, Math.max(alpha, floor), bg);
          expect(contrastRatio(painted, bg), `${surface} /${alpha * 100}`).toBeGreaterThanOrEqual(3);
        }
      }
    },
  );

  it.each(Object.entries(themes))('%s: secondary text is never weaker than muted text', (_name, map) => {
    const card = resolveTokenRgb('--card', map)!;
    const secondary = contrastRatio(resolveTokenRgb('--secondary-foreground', map)!, card);
    const muted = contrastRatio(resolveTokenRgb('--muted-foreground', map)!, card);
    expect(secondary).toBeGreaterThanOrEqual(7);
    expect(secondary).toBeGreaterThanOrEqual(muted);
  });

  describe('the login identity canvas (it re-declares its own neutrals)', () => {
    /** Every declaration of a top-level rule body (custom properties only). */
    const props = (source: string, selector: string): Map<string, string> => {
      const re = new RegExp(`(^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm');
      const m = re.exec(source);
      expect(m, `missing rule ${selector}`).not.toBeNull();
      return declsOf(source.slice(m!.index), selector);
    };
    /** An opaque colour token: an `H S% L%` triple or a `#rrggbb` hex. */
    const opaque = (value: string): Rgb => {
      const rgb = value.startsWith('#') ? hexToRgb(value) : hslTripleToRgb(value);
      expect(rgb, value).not.toBeNull();
      return rgb!;
    };
    /** `rgb(R G B / A%)` → its colour and alpha. */
    const translucent = (value: string): { rgb: Rgb; alpha: number } => {
      const m = /^rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)%\)$/.exec(value);
      expect(m, value).not.toBeNull();
      return { rgb: [Number(m![1]) / 255, Number(m![2]) / 255, Number(m![3]) / 255], alpha: Number(m![4]) / 100 };
    };

    const base = {
      light: props(css, '.login-auth-canvas'),
      dark: props(css, '.dark .login-auth-canvas'),
    };
    const boosted = {
      light: new Map([...base.light, ...declsOf(body, '.login-auth-canvas')]),
      dark: new Map([...base.dark, ...declsOf(body, '.dark .login-auth-canvas')]),
    };

    it.each(['light', 'dark'] as const)('%s: borders and the input edge clear 3:1, text clears 7:1', (theme) => {
      const map = boosted[theme];
      const slab = opaque(map.get('--login-slab')!);
      const canvas = opaque(map.get('--login-canvas')!);
      for (const bg of [slab, canvas]) {
        for (const token of ['--border', '--border-strong', '--input']) {
          expect(contrastRatio(opaque(map.get(token)!), bg), token).toBeGreaterThanOrEqual(3);
        }
        for (const token of ['--muted-foreground', '--login-text-subtle']) {
          expect(contrastRatio(opaque(map.get(token)!), bg), token).toBeGreaterThanOrEqual(7);
        }
        expect(contrastRatio(opaque(map.get('--login-text-muted')!), bg)).toBeGreaterThanOrEqual(4.5);
      }
      // The field's unfocused edge, painted over the field's own fill on the slab.
      const fill = map.get('--login-input')!;
      const fillRgb = fill.startsWith('rgb(')
        ? over(translucent(fill).rgb, translucent(fill).alpha, slab)
        : opaque(fill);
      const edge = translucent(map.get('--login-input-border')!);
      expect(contrastRatio(over(edge.rgb, edge.alpha, fillRgb), fillRgb)).toBeGreaterThanOrEqual(3);
    });

    it.each(['light', 'dark'] as const)('%s: every boosted value is stronger than the default', (theme) => {
      const before = base[theme];
      const after = boosted[theme];
      const slab = opaque(before.get('--login-slab')!);
      for (const token of ['--border', '--input', '--muted-foreground', '--login-text-subtle', '--login-text-muted']) {
        expect(
          contrastRatio(opaque(after.get(token)!), slab),
          token,
        ).toBeGreaterThan(contrastRatio(opaque(before.get(token)!), slab));
      }
      for (const token of ['--login-input-border', '--login-guide']) {
        expect(translucent(after.get(token)!).alpha, token).toBeGreaterThan(
          translucent(before.get(token)!).alpha,
        );
      }
    });
  });

  it('turns the materials solid with a defined bottom rule and no scroll-edge fade', () => {
    expect(body).toMatch(/\.glass-surface,\s*\.material-surface\s*\{[^}]*border-bottom:\s*1px solid hsl\(var\(--border-strong\)\)/);
    expect(body).toMatch(/\.material-surface::after\s*\{[^}]*display:\s*none/);
  });
});
