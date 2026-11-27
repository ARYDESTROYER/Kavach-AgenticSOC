/**
 * Theme-token resolver + branding application (Round 3, design-system layer).
 *
 * This is the ONE place that decides the effective colour mode and that writes
 * runtime CSS custom properties. It is a pure module (no React) so it can be unit
 * tested and reused by both the React ThemeProvider and any non-React caller.
 *
 * NON-NEGOTIABLE #10 / #3 (branding) + #9 (untrusted appearance inputs):
 *   - `applyTokens()` writes ONLY allow-listed `--*` custom properties (see
 *     ALLOWED_TOKENS). An operator/branding payload can NEVER set an arbitrary CSS
 *     property, inject a selector, or smuggle a `url(...)`/`expression(...)` —
 *     every value is sanitised by `sanitizeTokenValue()` before it touches the DOM.
 *   - Nothing here uses dangerouslySetInnerHTML or innerHTML; values are assigned
 *     via `element.style.setProperty(name, value)` which the browser treats as a
 *     single declaration value (no selector/at-rule escape possible).
 *   - `--font-display` is the one font hook; its value is allow-listed to a small
 *     enum of vetted families, never an arbitrary string.
 */

/* ------------------------------------------------------------------------- */
/* Types — a structural view of the backend BrandingConfig round-3 fields.    */
/* These mirror, but do not import from, webui/src/lib/types.ts (kept local so */
/* the design-system layer does not contend on the shared types file).        */
/* ------------------------------------------------------------------------- */

export type ThemeMode = 'light' | 'dark' | 'system';
export type Material = 'quiet' | 'command';

/** A named theme preset the operator can offer (plain data; bounded). */
export interface ThemePreset {
  name?: string;
  material?: Material | string;
  default_theme?: ThemeMode | string;
  theme_tokens?: Record<string, string>;
  /** Optional accent preset key (see ACCENT_PRESETS). */
  accent?: string;
  [key: string]: unknown;
}

/**
 * The subset of the backend `BrandingConfig` (config.py) this resolver consumes.
 * Every field is optional + defaulted so a legacy/empty branding doc resolves to
 * the byte-for-byte pre-wave look (`material: 'quiet'`, no token overrides).
 */
export interface BrandingLike {
  accent_color?: string;
  accent_color2?: string;
  /** Legacy mode field (kept working). */
  theme?: ThemeMode | string;
  /** Round-3 org default colour mode (supersedes `theme`/`dark_mode_default`). */
  default_theme?: ThemeMode | string;
  dark_mode_default?: boolean;
  /** Shell density/contrast surface pack. */
  material?: Material | string;
  /** Bounded design-token override map (css-var → value). */
  theme_tokens?: Record<string, string>;
  /** Operator-curated preset list. */
  presets?: ThemePreset[];
}

/* ------------------------------------------------------------------------- */
/* Allow-list — the ONLY custom properties applyTokens()/applyBranding() write. */
/* ------------------------------------------------------------------------- */

/**
 * The exhaustive set of writable CSS custom properties. Anything not in this set
 * is dropped silently (#10). Mirrors the tokens declared in styles/theme.css.
 */
export const ALLOWED_TOKENS: ReadonlySet<string> = new Set([
  // Core brand + ring
  '--primary',
  '--ring',
  '--accent2',
  // The semantic SOC axes are deliberately NOT operator-writable. Their base,
  // foreground and standalone-text tokens are one measured contrast/CVD system;
  // changing only the fill invalidates that pairing throughout the Console.
  // Canvas / surface tints (backdrop nudges)
  '--canvas-tint',
  '--surface-tint',
  // Radius + density scale
  '--radius',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-xl',
  '--density-unit',
  // Display font hook (value further restricted to FONT_ALLOWLIST)
  '--font-display',
  // Material-pack chrome
  '--glass-tint',
  '--glass-opacity',
  '--glow-strength',
  '--grid-opacity',
]);

/** Allow-listed display font families (vetted for AA legibility + availability). */
const FONT_ALLOWLIST: Record<string, string> = {
  // Lead with the ACTUALLY-bundled family 'Inter Variable' (@fontsource-variable/inter).
  // The static 'Inter' family is NOT self-hosted, so leading with it silently fell back
  // to the OS font — an operator selecting "Inter" then DOWNGRADED the app's typography.
  inter: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', SFMono-Regular, Consolas, Menlo, monospace",
  // Space Grotesk is not self-hosted either; fall back to the bundled Inter Variable
  // (not the OS font) when it isn't locally installed.
  grotesk: "'Space Grotesk', 'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
};

/**
 * Brand colour tokens are consumed as `hsl(var(--token))` throughout the Console.
 * Older branding documents may still carry the hex examples accepted by the wire
 * contract, so normalise those values at the single DOM-write boundary instead of
 * allowing a syntactically safe but unusable `hsl(#rrggbb)` declaration.
 */
const BRAND_COLOR_TOKENS: ReadonlySet<string> = new Set([
  '--primary',
  '--ring',
  '--accent2',
]);

/**
 * Sanitise a single token VALUE before it is written. Rejects anything that could
 * escape a single CSS declaration value: braces, semicolons, `url(`, `expression(`,
 * `@`, comment markers, angle brackets, backslashes, or excessive length. Returns
 * null when the value is unsafe (the caller then skips the token). `--font-display`
 * is special-cased to the FONT_ALLOWLIST. Bare HSL triples / hex / rem numbers all
 * pass. This is defence-in-depth on top of `setProperty` (which already cannot
 * break out of a declaration).
 */
export function sanitizeTokenValue(name: string, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 200) return null;
  // Disallow characters/sequences that could end a declaration or inject CSS.
  if (/[{}<>\\;@]/.test(v)) return null;
  if (/url\s*\(/i.test(v)) return null;
  if (/expression\s*\(/i.test(v)) return null;
  if (v.includes('/*') || v.includes('*/')) return null;
  // The font hook is restricted to the vetted enum (key OR a known full stack).
  if (name === '--font-display') {
    const key = v.toLowerCase();
    if (FONT_ALLOWLIST[key]) return FONT_ALLOWLIST[key];
    // Allow an exact match against a known stack (idempotent re-apply), else drop.
    const known = Object.values(FONT_ALLOWLIST).some((s) => s === v);
    return known ? v : null;
  }
  if (BRAND_COLOR_TOKENS.has(name) && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
    return hexToHslTriplet(v);
  }
  return v;
}

/**
 * Apply a bag of design tokens to a target element's inline style, writing ONLY
 * allow-listed + sanitised properties. Unknown keys and unsafe values are skipped.
 * Returns the list of property names actually written (handy for tests/clearing).
 *
 * @param tokens   css-var → value map (keys may omit/include the leading `--`).
 * @param target   defaults to <html> (document.documentElement).
 */
export function applyTokens(
  tokens: Record<string, string> | null | undefined,
  target?: HTMLElement | null,
): string[] {
  const root = target ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!root || !tokens) return [];
  const written: string[] = [];
  for (const [rawKey, rawVal] of Object.entries(tokens)) {
    const name = rawKey.startsWith('--') ? rawKey : `--${rawKey}`;
    if (!ALLOWED_TOKENS.has(name)) continue;
    const safe = sanitizeTokenValue(name, rawVal);
    if (safe == null) continue;
    root.style.setProperty(name, safe);
    written.push(name);
  }
  return written;
}

/** Remove a set of token properties (e.g. when branding clears them). */
export function clearTokens(names: Iterable<string>, target?: HTMLElement | null): void {
  const root = target ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!root) return;
  for (const name of names) {
    const n = name.startsWith('--') ? name : `--${name}`;
    if (ALLOWED_TOKENS.has(n)) root.style.removeProperty(n);
  }
}

/* ------------------------------------------------------------------------- */
/* Material packs — chrome var deltas. 'quiet' === the pre-wave defaults.      */
/* ------------------------------------------------------------------------- */

/**
 * Material-pack token deltas. The 'quiet' pack is the IDENTITY, so selecting it
 * renders byte-for-byte like the pre-wave UI. Crucially, 'quiet' DOES NOT set
 * `--glass-opacity`: that token has DIFFERENT per-theme defaults in theme.css
 * (0.97 in both today), so force-writing one value inline would override a later
 * per-theme change and subtly change the chrome. By omitting it, 'quiet'
 * lets the stylesheet's per-theme value win (see `applyMaterial`, which actively
 * removes any stale inline override). `--glow-strength`/`--grid-opacity` ARE
 * theme-agnostic (both 0 in either theme), so writing them inline is harmless.
 * The 'command' pack raises the glass/glow/grid chrome vars for a denser
 * command feel WITHOUT touching the colour system (text colours/contrast unchanged).
 */
export const MATERIAL_PACKS: Record<Material, Record<string, string>> = {
  quiet: {
    // NOTE: no '--glass-opacity' here on purpose — see the doc comment above.
    '--glow-strength': '0',
    '--grid-opacity': '0',
  },
  command: {
    // Slightly more translucent chrome + a faint glow + a whisper grid overlay. The glass
    // stays at 0.94: the backdrop blur cannot be relied on over routed content (see
    // lib/material-recipes.ts), so the fill alone keeps text under the top bar from
    // reading through (about 1.13:1). The old 0.64 let card text show at about 2:1.
    '--glass-opacity': '0.94',
    '--glow-strength': '0.45',
    '--grid-opacity': '0.05',
  },
};

/** Resolve a material string to a known pack (defaults to 'quiet'). */
export function resolveMaterial(material?: string | null): Material {
  return material === 'command' ? 'command' : 'quiet';
}

/**
 * Apply a material pack's chrome tokens (allow-listed via applyTokens). The 'quiet'
 * pack first REMOVES any inline `--glass-opacity` so the stylesheet's per-theme
 * default (0.97 in both themes) applies — 'quiet' is then byte-identical to the
 * pre-wave look in BOTH themes. Only 'command' writes an explicit glass opacity.
 */
export function applyMaterial(material: Material, target?: HTMLElement | null): void {
  if (material === 'quiet') clearTokens(['--glass-opacity'], target);
  applyTokens(MATERIAL_PACKS[material], target);
}

/* ------------------------------------------------------------------------- */
/* Accent presets — AA-vetted brand hues (exported for the branding editor).  */
/* ------------------------------------------------------------------------- */

export interface AccentPreset {
  /** Stable key. */
  key: string;
  /** Human label (plain text). */
  label: string;
  /** Primary accent as a `#rrggbb` hex (drives --primary/--ring). */
  hex: string;
  /** Optional secondary accent (drives --accent2 / hero aurora). */
  hex2?: string;
}

/**
 * Named accent presets. Runtime derives the higher-contrast black/white
 * `--primary-foreground` from each effective fill, so the same preset remains AA in
 * both themes. Exported so the branding editor can offer one-click choices.
 */
export const ACCENT_PRESETS: AccentPreset[] = [
  { key: 'azure', label: 'Azure', hex: '#1f6feb', hex2: '#6366f1' },
  { key: 'indigo', label: 'Indigo', hex: '#4f46e5', hex2: '#7c3aed' },
  { key: 'teal', label: 'Teal', hex: '#0d9488', hex2: '#0ea5e9' },
  { key: 'violet', label: 'Violet', hex: '#7c3aed', hex2: '#db2777' },
  { key: 'emerald', label: 'Emerald', hex: '#047857', hex2: '#0d9488' },
  { key: 'crimson', label: 'Crimson', hex: '#be123c', hex2: '#ea580c' },
];

/** Look up an accent preset by key (case-insensitive). */
export function accentPreset(key?: string | null): AccentPreset | undefined {
  if (!key) return undefined;
  const k = key.trim().toLowerCase();
  return ACCENT_PRESETS.find((p) => p.key === k);
}

/* ------------------------------------------------------------------------- */
/* hex → HSL triplet (mirrors theme.tsx's converter; kept here so this module  */
/* is self-contained + testable).                                             */
/* ------------------------------------------------------------------------- */

/** Convert `#rrggbb`/`#rgb` to the `"H S% L%"` triple the tokens expect, or null. */
export function hexToHslTriplet(hex: string): string | null {
  let h = (hex || '').trim();
  if (!h.startsWith('#')) return null;
  h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0;
  let hue = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        hue = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        hue = (b - r) / d + 2;
        break;
      default:
        hue = (r - g) / d + 4;
        break;
    }
    hue /= 6;
  }
  return `${Math.round(hue * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/* ------------------------------------------------------------------------- */
/* Runtime AA guard for the operator accent (W0-A A7 / DESIGN_STANDARD §11).   */
/* A custom accent is shared by both themes, so its trusted foreground must be  */
/* derived from the fill rather than inherited from either theme's default.     */
/* self-contained (mirrors branding.api.ts contrastRatio) so the design-system */
/* layer stays free of the api/types import graph + any circular import.       */
/* ------------------------------------------------------------------------- */

/** Relative luminance per WCAG 2.x for a normalised [r,g,b] in 0..1 (sRGB→linear). */
function relLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** HSL (h 0..360, s/l 0..1) → [r,g,b] each 0..1. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = ((h % 360) + 360) % 360 / 360;
  const t2c = (t: number) => {
    let tc = t;
    if (tc < 0) tc += 1;
    if (tc > 1) tc -= 1;
    if (tc < 1 / 6) return p + (q - p) * 6 * tc;
    if (tc < 1 / 2) return q;
    if (tc < 2 / 3) return p + (q - p) * (2 / 3 - tc) * 6;
    return p;
  };
  return [t2c(hk + 1 / 3), t2c(hk), t2c(hk - 1 / 3)];
}

/** Parse an `"H S% L%"` triplet → {h,s,l} (s/l as 0..1), or null. */
function parseHslTriplet(triplet: string): { h: number; s: number; l: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%\s*$/.exec(triplet);
  if (!m) return null;
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  if (Number.isNaN(h) || Number.isNaN(s) || Number.isNaN(l)) return null;
  return { h, s: Math.max(0, Math.min(1, s)), l: Math.max(0, Math.min(1, l)) };
}

/** WCAG contrast (1..21) of WHITE text on an `"H S% L%"` accent fill, or null. */
function whiteOnHslContrast(triplet: string): number | null {
  const hsl = parseHslTriplet(triplet);
  if (!hsl) return null;
  const [r, g, b] = hslToRgb(hsl.h, hsl.s, hsl.l);
  const lFill = relLuminance(r, g, b);
  const lWhite = 1; // white luminance
  return (Math.max(lFill, lWhite) + 0.05) / (Math.min(lFill, lWhite) + 0.05);
}

export interface AccentPair {
  fill: string;
  foreground: '0 0% 0%' | '0 0% 100%';
  ratio: number;
}

/**
 * Resolve an operator accent (hex or `H S% L%`) to the higher-contrast black/white
 * foreground. Hex values are evaluated before their HSL serialisation so the browser
 * and backend make the same choice even at the narrow black/white crossover. For every
 * valid solid colour one candidate clears WCAG AA; the foreground is INTERNAL.
 */
export function resolveAccentPair(value: string | null): AccentPair | null {
  if (!value) return null;
  let fill = value;
  let rgb: [number, number, number] | null = null;
  const hex = value.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)?.[1];
  if (hex) {
    const expanded = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    rgb = [
      parseInt(expanded.slice(0, 2), 16) / 255,
      parseInt(expanded.slice(2, 4), 16) / 255,
      parseInt(expanded.slice(4, 6), 16) / 255,
    ];
    fill = hexToHslTriplet(value) ?? '';
  } else {
    const hsl = parseHslTriplet(value);
    if (hsl) rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
  }
  if (!rgb || !fill) return null;
  const lFill = relLuminance(...rgb);
  const whiteRatio = 1.05 / (lFill + 0.05);
  const blackRatio = (lFill + 0.05) / 0.05;
  if (whiteRatio >= blackRatio) {
    return { fill, foreground: '0 0% 100%', ratio: whiteRatio };
  }
  return { fill, foreground: '0 0% 0%', ratio: blackRatio };
}

/**
 * AA-guard an operator accent triplet so white-on-accent clears WCAG AA (4.5:1):
 *   - if it already passes, return it unchanged;
 *   - else DARKEN (lower L in 1% steps, ≥ the same hue) until it passes;
 *   - if even a near-black accent (L floor ~12%) cannot reach 3:1, REJECT (null) so
 *     the caller falls back to the AA-vetted stylesheet default.
 * Pure + deterministic; returns the (possibly darkened) `"H S% L%"` triplet or null.
 */
export function guardAccentTriplet(triplet: string | null, minRatio = 4.5): string | null {
  if (!triplet) return null;
  const hsl = parseHslTriplet(triplet);
  if (!hsl) return null;
  const initial = whiteOnHslContrast(triplet);
  if (initial != null && initial >= minRatio) return triplet;
  // Darken toward a floor; recompute at each step.
  for (let l = hsl.l; l >= 0.12; l -= 0.01) {
    const cand = `${Math.round(hsl.h)} ${Math.round(hsl.s * 100)}% ${Math.round(l * 100)}%`;
    const ratio = whiteOnHslContrast(cand);
    if (ratio != null && ratio >= minRatio) return cand;
  }
  // Could not reach AA even near-black: accept a darkened value if it clears the 3:1
  // UI/large-text floor, else reject entirely (use the vetted default).
  const floor = `${Math.round(hsl.h)} ${Math.round(hsl.s * 100)}% 12%`;
  const floorRatio = whiteOnHslContrast(floor);
  return floorRatio != null && floorRatio >= 3 ? floor : null;
}

/* ------------------------------------------------------------------------- */
/* The ONE colour-mode resolver — explicit precedence.                        */
/* ------------------------------------------------------------------------- */

/** True when the OS currently prefers dark (safe in SSR/jsdom). */
export function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Resolve the effective dark flag with EXPLICIT precedence:
 *   1. the user's explicit choice (`'light'`/`'dark'`) — always wins;
 *   2. when the user is on `'system'` (or unset), the org branding default
 *      (`effectiveBrandingTheme(branding)`), if it is `'light'`/`'dark'`;
 *   3. otherwise `prefers-color-scheme`.
 *
 * This keeps the no-branding behaviour identical to before (user pref or OS), and
 * only lets branding act as the default for users who have NOT chosen.
 */
export function resolveDark(
  userMode: ThemeMode | undefined,
  branding?: BrandingLike | null,
): boolean {
  if (userMode === 'dark') return true;
  if (userMode === 'light') return false;
  // userMode is 'system' or undefined → consult branding default, then the OS.
  const orgDefault = branding ? effectiveBrandingTheme(branding) : '';
  if (orgDefault === 'dark') return true;
  if (orgDefault === 'light') return false;
  return prefersDark();
}

/**
 * The org's default colour mode, reconciling the new + legacy branding fields —
 * mirrors the backend `BrandingConfig.effective_theme()`:
 *   - legacy `dark_mode_default: true` forces dark;
 *   - else prefer the explicit `default_theme`, else the legacy `theme`.
 * Returns `'light' | 'dark' | 'system' | ''` ('' = unset / no opinion).
 */
export function effectiveBrandingTheme(branding: BrandingLike): ThemeMode | '' {
  if (branding.dark_mode_default) return 'dark';
  const dt = (branding.default_theme || '') as string;
  if (dt === 'dark' || dt === 'light' || dt === 'system') return dt;
  const legacy = (branding.theme || '') as string;
  if (legacy === 'dark' || legacy === 'light' || legacy === 'system') return legacy;
  return '';
}

/* ------------------------------------------------------------------------- */
/* applyBranding — the full appearance application (accent + material + tokens). */
/* ------------------------------------------------------------------------- */

/**
 * Every token Branding can set, including the trusted derived primary foreground.
 * Clear the complete set before each application so a smaller/newer branding doc
 * cannot leave an old inline colour, font, radius, density or material override.
 */
const BRANDING_MANAGED_TOKENS: ReadonlySet<string> = new Set([
  ...ALLOWED_TOKENS,
  '--primary-foreground',
]);

/**
 * Apply ALL branding-driven appearance to <html> (or `target`), idempotently:
 *   1. accent — `accent_color` → `--primary`/`--ring`; `accent_color2` → `--accent2`;
 *   2. material pack — `material` ('quiet'|'command') → chrome vars;
 *   3. bounded token overrides — `theme_tokens` (allow-listed + sanitised).
 *
 * Order matters: theme_tokens are applied LAST so an explicit operator token wins
 * over the accent/material defaults. Everything routes through `applyTokens()`, so
 * only allow-listed, sanitised properties are ever written (#10/#9). Passing an
 * empty/legacy branding clears overrides → the byte-for-byte quiet default.
 *
 * Returns the resolved material (the shell uses it to toggle the grid overlay).
 */
export function applyBranding(
  branding: BrandingLike | null | undefined,
  target?: HTMLElement | null,
): Material {
  const root = target ?? (typeof document !== 'undefined' ? document.documentElement : null);
  const material = resolveMaterial(branding?.material);
  if (!root) return material;

  // Start from a clean slate for the managed set so toggling OFF a value restores
  // the stylesheet default (rather than leaving a stale inline override).
  for (const name of BRANDING_MANAGED_TOKENS) root.style.removeProperty(name);

  // 1. Accent. Derive one trusted black/white foreground from the effective fill.
  //    The custom fill is inline (shared by Light/Dark), therefore inheriting the
  //    themes' opposite default foregrounds would make one mode fail contrast.
  const rawAccent = branding?.accent_color || null;
  const accentPair = resolveAccentPair(rawAccent);
  if (accentPair) {
    applyTokens({ '--primary': accentPair.fill, '--ring': accentPair.fill }, root);
    root.style.setProperty('--primary-foreground', accentPair.foreground);
  }
  const accent2Triplet = branding?.accent_color2 ? hexToHslTriplet(branding.accent_color2) : null;
  if (accent2Triplet) {
    applyTokens({ '--accent2': accent2Triplet }, root);
  }

  // 2. Material pack chrome.
  applyMaterial(material, root);

  // 3. Operator token overrides (last → highest precedence). A low-level
  //    allow-listed --primary override still receives the same trusted companion.
  if (branding?.theme_tokens) {
    const written = applyTokens(branding.theme_tokens, root);
    if (written.includes('--primary')) {
      const rawPrimary = branding.theme_tokens['--primary'] ?? branding.theme_tokens.primary;
      const finalPrimary = root.style.getPropertyValue('--primary').trim();
      const finalPair = resolveAccentPair(rawPrimary || finalPrimary);
      if (finalPair) root.style.setProperty('--primary-foreground', finalPair.foreground);
    }
  }

  return material;
}
