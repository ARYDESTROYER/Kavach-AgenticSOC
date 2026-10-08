/**
 * Series colour + glyph resolution for answer-block charts.
 *
 * Colour is an ENUM lookup, never a block string (G2): a series' `semantic` key (already
 * validated against the palette axes by the parser) picks its axis token; otherwise the
 * series takes the categorical Okabe-Ito slot of its POSITION (`--chart-1..7`), and an
 * "Other" fold takes the reserved neutral `--chart-8`. The server orders series by
 * descending total, so a colour stays bound to its entity across re-renders, and a
 * legend toggle never repaints the survivors (colours are resolved before filtering).
 */
import type { LucideIcon } from 'lucide-react';

import {
  CATEGORICAL,
  SEMANTIC_ICON,
  SEVERITY_COLOR,
  STATUS_COLOR,
  VERDICT_COLOR,
  categorical,
  token,
} from '@/soc/components/palette';

import type { ChartBlock, SemanticKey } from '../schema';
import { SEMANTIC_KEYS } from '../schema';

export interface SeriesStyle {
  key: string;
  label: string;
  color: string;
  icon?: LucideIcon;
}

const AXIS_TOKEN: Record<string, string> = { ...STATUS_COLOR, ...VERDICT_COLOR, ...SEVERITY_COLOR };

/** The mark colour for a validated semantic key (surface-coloured keys get a neutral ink). */
export function semanticMarkColor(key: SemanticKey): string {
  const name = AXIS_TOKEN[key];
  // `muted` is a SURFACE token: as a mark it would vanish into the card. Neutral keys
  // (new, duplicate, undetermined) draw in the muted ink instead.
  if (!name || name === 'muted') return token('muted-foreground');
  return token(name);
}

/** A string that is exactly one of the semantic keys (case-insensitive), else undefined. */
export function asSemantic(label: string): SemanticKey | undefined {
  const k = label.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (SEMANTIC_KEYS as readonly string[]).includes(k) ? (k as SemanticKey) : undefined;
}

const OTHER_RE = /^other(\s*\(\d[\d,]*\))?$/i;

/** Colour + glyph per series, by position (stable) unless semantic. */
export function seriesStyles(block: ChartBlock): SeriesStyle[] {
  return block.series.map((s, i) => {
    if (s.semantic) {
      return { key: s.key, label: s.label, color: semanticMarkColor(s.semantic), icon: SEMANTIC_ICON[s.semantic] };
    }
    if (s.key === 'other' || OTHER_RE.test(s.label)) {
      return { key: s.key, label: s.label, color: token('chart-8') };
    }
    return { key: s.key, label: s.label, color: i < CATEGORICAL.length - 1 ? categorical(i) : token('chart-8') };
  });
}

/**
 * Per-CATEGORY colours for a single-series chart whose categories are ALL semantic keys
 * (a severity or verdict mix): the bar/segment wears its own axis colour + glyph. Any
 * other single-series categories share the series colour (or, for a donut, take the
 * categorical slots), so colour never claims a meaning the label does not have.
 */
export function categoryStyles(block: ChartBlock, forPartToWhole: boolean): SeriesStyle[] | null {
  if (block.series.length !== 1) return null;
  const keys = block.x.values.map(asSemantic);
  if (keys.every((k): k is SemanticKey => k !== undefined)) {
    return block.x.values.map((label, i) => ({
      key: `x${i}`,
      label,
      color: semanticMarkColor(keys[i] as SemanticKey),
      icon: SEMANTIC_ICON[keys[i] as SemanticKey],
    }));
  }
  if (!forPartToWhole) return null;
  return block.x.values.map((label, i) => ({
    key: `x${i}`,
    label,
    color: OTHER_RE.test(label) ? token('chart-8') : i < CATEGORICAL.length - 1 ? categorical(i) : token('chart-8'),
  }));
}
