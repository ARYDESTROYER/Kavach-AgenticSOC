/**
 * Round-5 W0-E E4 — GATE 3/4 core: baselined grep guards.
 *
 * Two hard design rules (DESIGN_STANDARD §2.6, §12.3/§12.4):
 *   - no NEW arbitrary `text-[<number>…]` font size in `.tsx` (route through the scale)
 *   - no NEW raw `#rrggbb` hex color in `.tsx` (route through a token)
 *
 * 45+ / 102 pre-existing occurrences are inventoried in `grep-baseline.json` (per-file
 * counts). The guard fails ONLY when a file's current count EXCEEDS its baseline, or a
 * file NOT in the baseline gains any occurrence — so existing code is grandfathered and
 * only NEW additions break the build. As the Codemod wave removes occurrences, counts
 * only ever go DOWN (a shrink is always allowed); regenerate the baseline to ratchet
 * the ceiling down (`node scripts/gate-grep.mjs --update`).
 *
 * Dependency-free: walks `src/**\/*.tsx` with `fs`, counts regex matches per file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WEBUI_ROOT } from './theme-css.mjs';

export const SRC_DIR = path.join(WEBUI_ROOT, 'src');
export const BASELINE_PATH = path.join(WEBUI_ROOT, 'scripts', 'grep-baseline.json');

/**
 * The two guarded patterns. `text-\[<number>` matches an arbitrary numeric font size
 * (`text-[13px]`, `text-[0.8rem]`) but NOT calc/var arbitrary values or non-size
 * arbitraries. The hex pattern matches a 6-digit `#rrggbb` word-bounded on BOTH sides so
 * it does not fire mid-token: a colour literal starts a token (`'#aabbcc'`,
 * `bg-[#aabbcc]`, `fill="#aabbcc"`), while an identifier that merely contains `#` and six
 * hex digits (the case reference `INC#000042`) is not a colour. Both are matched
 * per-line-occurrence (global).
 */
export const PATTERNS = {
  'arbitrary-text-size': /text-\[[0-9]/g,
  'raw-hex-color': /(?<![A-Za-z0-9_])#[0-9a-fA-F]{6}\b/g,
};

/** Recursively collect `.tsx` files under `dir`, returned as repo-relative posix paths. */
export function collectTsx(dir = SRC_DIR) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'dist') continue;
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith('.tsx')) {
        out.push(path.relative(WEBUI_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Count matches of every pattern in every `.tsx` file → { pattern: { relPath: count } }. */
export function countAll() {
  const files = collectTsx();
  const counts = {};
  for (const key of Object.keys(PATTERNS)) counts[key] = {};
  for (const rel of files) {
    const text = fs.readFileSync(path.join(WEBUI_ROOT, rel), 'utf8');
    for (const [key, re] of Object.entries(PATTERNS)) {
      const n = (text.match(re) || []).length;
      if (n > 0) counts[key][rel] = n;
    }
  }
  return counts;
}

/** Load the committed baseline (empty structure if absent). */
export function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    const empty = {};
    for (const key of Object.keys(PATTERNS)) empty[key] = {};
    return empty;
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

/**
 * Compare current counts against the baseline. A violation is any file whose current
 * count EXCEEDS its baseline (new file → baseline 0). Shrinks are always OK.
 * @returns {{ ok: boolean, violations: {pattern,file,baseline,current}[] }}
 */
export function checkGrepGuards() {
  const baseline = loadBaseline();
  const current = countAll();
  const violations = [];
  for (const key of Object.keys(PATTERNS)) {
    const base = baseline[key] || {};
    const cur = current[key] || {};
    for (const [file, n] of Object.entries(cur)) {
      const allowed = base[file] || 0;
      if (n > allowed) violations.push({ pattern: key, file, baseline: allowed, current: n });
    }
  }
  return { ok: violations.length === 0, violations, current };
}
