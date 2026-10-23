/**
 * Types for the WCAG contrast gate (gate-contrast.mjs). See DESIGN_STANDARD §6.3.
 * Hand-written so the Vitest CI wiring (design-gates.test.ts) type-checks cleanly.
 */
export interface ContrastResult {
  /** 'light' | 'dark'. */
  theme: string;
  /** Human-readable axis name (e.g. 'critical-text (text)'). */
  name: string;
  /** 'text' | 'text-wash' | 'on-fill' | 'nontext' | 'panel-text' | 'panel-text-wash' | 'panel-nontext' | 'separation'. */
  kind: string;
  /** The bar this axis must clear (4.5 or 3.0; a grouped-panel separation's own floor). */
  bar: number;
  /** Measured ratio (rounded), or null when a token failed to resolve. */
  ratio: number | null;
  /** True when ratio ≥ bar. */
  pass: boolean;
}

export interface ContrastCheckResult {
  ok: boolean;
  results: ContrastResult[];
}

export function checkContrast(): ContrastCheckResult;

/** Semantic axes measured as small text over a 10% same-axis wash. */
export const TEXT_WASH_AXES: string[];
/** Semantic base fills measured as a graphic on the card. */
export const SEMANTIC_FILL_AXES: string[];
/** Text tokens measured on a grouped panel (`--panel`) and on its hovered row. */
export const PANEL_TEXT_AXES: string[];
/** Text tokens measured on the panel's muted step (`--panel-muted`). */
export const PANEL_MUTED_TEXT_AXES: string[];
/** The floor for the panel against the canvas. */
export const PANEL_SEPARATION: number;
/** The floor for the panel's muted step against the panel. */
export const PANEL_MUTED_SEPARATION: number;
/** The floor for the in-panel hover (and the selected wash) against the panel. */
export const PANEL_HOVER_SEPARATION: number;
/** The floor for one notch between neighbouring in-panel states (muted, hover, selected). */
export const PANEL_STEP_SEPARATION: number;
/** The alpha of the KPI tiles' hover wash (`hover:bg-accent/30`). */
export const KPI_HOVER_WASH_ALPHA: number;
