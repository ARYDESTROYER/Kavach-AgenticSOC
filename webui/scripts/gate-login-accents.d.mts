/**
 * Types for the login-accent contrast gate (gate-login-accents.mjs).
 * Hand-written so the Vitest CI wiring (design-gates.test.ts) type-checks cleanly.
 */

/** WCAG AA bar for normal-size text (4.5). */
export const TEXT_BAR: number;

export interface LoginAccentResult {
  /** Human-readable identity of the composite that was measured. */
  name: string;
  /** 'light' | 'dark' — which theme's tint opacity / pill state was applied. */
  theme?: string;
  /** The bar this composite had to clear. */
  bar?: number;
  /** Measured ratio, or null when a token could not be resolved. */
  ratio?: number | null;
  pass: boolean;
  /** Populated only when a token is missing outright. */
  detail?: string;
}

export interface LoginAccentLayers {
  /** Peak opacity the sweep keyframe reaches. */
  sweepPeak: number;
  /** Alpha of the sweep gradient's core stop. */
  sweepCoreAlpha: number;
  /** Declared opacity of the overlay tint, per theme. */
  tintLight: number;
  tintDark: number;
}

export interface LoginAccentCheck {
  ok: boolean;
  results: LoginAccentResult[];
  /** What the compositing model actually used; absent on an early hard failure. */
  layers?: LoginAccentLayers;
}

/** [r, g, b] with each channel in 0..1 — the scale `theme-css.mjs` uses. */
export type Rgb = number[];

export interface GradientStop {
  rgb: Rgb;
  /** Declared stop position as a 0..1 fraction, or null when it was omitted. */
  pos: number | null;
  /** The stop's source text (`#rrggbb` or `rgb(...)`). */
  raw: string;
}

export interface GradientGeometry {
  angleDeg: number;
  widthRem: number;
  heightRem: number;
}

export function checkLoginAccents(): LoginAccentCheck;
export function gradientStops(value: string): GradientStop[];
export function sampleGradient(stops: GradientStop[], t: number): Rgb;
export function gradientPositionAt(f: number, geometry: GradientGeometry): number;
export function over(bottom: Rgb, top: Rgb, alpha: number): Rgb;
export function overlayBlend(bottom: Rgb, top: Rgb): Rgb;
