/**
 * Types for the shared theme.css parser + WCAG helpers (theme-css.mjs). Hand-written so
 * Vitest specs that measure tokens directly (design-system foundations) type-check.
 */
export type Rgb = [number, number, number];

export const WEBUI_ROOT: string;
export const THEME_CSS_PATH: string;

export interface ParsedThemeCss {
  light: Map<string, string>;
  dark: Map<string, string>;
  rawLight: string;
  rawDark: string;
}

export function parseThemeCss(cssText?: string): ParsedThemeCss;
export function resolveToken(name: string, map: Map<string, string>, seen?: Set<string>): string | null;
export function parseHslTriple(triple: string): { h: number; s: number; l: number } | null;
export function hslToRgb(h: number, s: number, l: number): Rgb;
export function hslTripleToRgb(triple: string): Rgb | null;
export function hexToRgb(hex: string): Rgb | null;
export function relLuminance(rgb: Rgb): number;
export function contrastRatio(rgbA: Rgb, rgbB: Rgb): number;
export function resolveTokenRgb(name: string, map: Map<string, string>): Rgb | null;
