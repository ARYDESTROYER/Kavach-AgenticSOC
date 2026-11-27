/**
 * SHAPE checker: the KPI drill-down's facet options must be DERIVED, never enumerated.
 *
 * Vendor-agnosticism (§4) is not a style preference on this surface — it is what makes
 * the panel deployable against an estate whose lifecycle or severity vocabulary is not
 * the one this repository happens to ship. A menu built from a literal list is a menu
 * that is silently wrong for the first deployment that renames a band.
 *
 * It is a checker rather than an assertion for the reason the repo's other gates are:
 * the rule is about SOURCE TEXT, not about behaviour, so it has to read the file. It
 * follows the pattern `design-gates.test.ts` established — a pure, dependency-free
 * function that returns `{ ok, problems, checked }` and is asserted from inside the
 * normal `vitest run`.
 *
 * It also covers a real blind spot: the repository's grep guard walks `src/**\/*.tsx`
 * ONLY, so nothing under it inspects a `.ts` module, and nothing at all inspects a file
 * for a vocabulary literal.
 *
 * Every vocabulary it checks against is EXTRACTED from the product's own source, never
 * restated here — a checker that hard-coded the band names would be the exact defect it
 * exists to prevent, one level up.
 */
import fs from 'node:fs';
import path from 'node:path';

/** `webui/` — this file lives at `webui/src/soc/__tests__/`. */
export const WEBUI_ROOT = path.resolve(__dirname, '..', '..', '..');

const PANEL = path.join(WEBUI_ROOT, 'src', 'soc', 'components', 'KpiDrilldownPanel.tsx');
const BADGES = path.join(WEBUI_ROOT, 'src', 'soc', 'components', 'badges.tsx');
const PALETTE = path.join(WEBUI_ROOT, 'src', 'soc', 'components', 'palette.ts');

export interface FacetShapeResult {
  ok: boolean;
  problems: string[];
  /** What was actually inspected, so a sweep that matched nothing cannot pass quietly. */
  checked: {
    panelBytes: number;
    severityBands: string[];
    statusTokens: string[];
  };
}

/** Members of `export const SEVERITY_BAND_ORDER = [...]` in badges.tsx. */
function readSeverityLadder(source: string): string[] {
  const block = /SEVERITY_BAND_ORDER\s*:[^=]*=\s*\[([^\]]*)\]/.exec(source);
  if (!block) return [];
  return Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
}

/** Keys of `export const STATUS_COLOR = { ... }` in palette.ts. */
function readStatusVocabulary(source: string): string[] {
  const block = /STATUS_COLOR\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(source);
  if (!block) return [];
  return Array.from(block[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)).map((m) => m[1]);
}

/** Strip block and line comments so PROSE about a vocabulary is not read as a literal. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export function checkDrilldownFacetShape(): FacetShapeResult {
  const problems: string[] = [];
  const panelRaw = fs.readFileSync(PANEL, 'utf8');
  const panel = stripComments(panelRaw);
  const severityBands = readSeverityLadder(fs.readFileSync(BADGES, 'utf8'));
  const statusTokens = readStatusVocabulary(fs.readFileSync(PALETTE, 'utf8'));

  // A vocabulary that failed to extract would make every rule below vacuous.
  if (severityBands.length < 2) {
    problems.push('could not extract SEVERITY_BAND_ORDER from badges.tsx');
  }
  if (statusTokens.length < 2) {
    problems.push('could not extract STATUS_COLOR keys from palette.ts');
  }

  // The band menu must be built by iterating the product's ONE ladder.
  if (!/SEVERITY_BAND_ORDER/.test(panel)) {
    problems.push(
      'the panel does not reference SEVERITY_BAND_ORDER, so its severity menu cannot be ' +
        'derived from the product ladder',
    );
  }

  // No vocabulary member may appear as a string literal anywhere in the panel: that is
  // what "derived" means, and it is checkable without knowing how the menu is built.
  for (const band of severityBands) {
    if (new RegExp(`['"\`]${band}['"\`]`).test(panel)) {
      problems.push(`severity band '${band}' is written as a literal in KpiDrilldownPanel.tsx`);
    }
  }
  for (const token of statusTokens) {
    if (new RegExp(`['"\`]${token}['"\`]`).test(panel)) {
      problems.push(`case status '${token}' is written as a literal in KpiDrilldownPanel.tsx`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    checked: { panelBytes: panelRaw.length, severityBands, statusTokens },
  };
}
