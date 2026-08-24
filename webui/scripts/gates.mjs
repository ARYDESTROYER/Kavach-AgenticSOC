#!/usr/bin/env node
/**
 * Round-5 W0-E E4 — the ONE design-gate runner (`npm run gates`).
 *
 * Runs all five gate checks in-process and reports a single pass/fail:
 *   1. token-existence — every ALLOWED_TOKENS + palette token() name in theme.css (both themes)
 *   2. contrast        — WCAG AA (4.5:1 text / 3:1 non-text) across the semantic axes, both themes
 *   3. grep: text-size — no NEW arbitrary `text-[<number>…]` in .tsx (baselined)
 *   4. grep: raw hex   — no NEW raw `#rrggbb` in .tsx (baselined)
 *   5. CVD             — --chart-* ramp resolves + stays separable under the 3 dichromacies
 *   6. login accents   — the identity CTA/pill gradients keep AA text contrast in every
 *                        paint state (they use raw gradients, so gate 2 cannot see them)
 *
 * The contrast + token-existence checkers ALSO run inside Vitest (design-gates.test.ts)
 * so CI enforces them even if `npm run gates` is not wired into a given pipeline. This
 * standalone runner is the human/CI convenience entry point.
 */
import { checkTokenExistence } from './gate-tokens.mjs';
import { checkContrast } from './gate-contrast.mjs';
import { checkGrepGuards } from './lib/grep-guard.mjs';
import { checkCvd } from './gate-cvd.mjs';
import { checkLoginAccents } from './gate-login-accents.mjs';

let failed = 0;

function report(name, ok, detail) {
  if (ok) {
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.error(`✗ ${name}`);
    if (detail) console.error(detail);
  }
}

// 1. token existence
{
  const { ok, problems, checked } = checkTokenExistence();
  report(
    `token-existence (${checked} tokens)`,
    ok,
    problems.map((p) => `    ${p.token} missing in ${p.missing.join(', ')} (from ${p.source})`).join('\n'),
  );
}
// 2. contrast
{
  const { ok, results } = checkContrast();
  const fails = results.filter((r) => !r.pass);
  report(
    `contrast (${results.length} axes, both themes)`,
    ok,
    fails.map((r) => `    [${r.theme}] ${r.name} need ≥${r.bar}:1, got ${r.ratio ?? 'unresolved'}`).join('\n'),
  );
}
// 3 + 4. grep guards
{
  const { ok, violations } = checkGrepGuards();
  const byPattern = (p) => violations.filter((v) => v.pattern === p);
  const t = byPattern('arbitrary-text-size');
  const h = byPattern('raw-hex-color');
  report(
    'grep: no NEW arbitrary text-[…] size in .tsx',
    t.length === 0,
    t.map((v) => `    ${v.file}: baseline ${v.baseline} → ${v.current}`).join('\n'),
  );
  report(
    'grep: no NEW raw #rrggbb hex in .tsx',
    h.length === 0,
    h.map((v) => `    ${v.file}: baseline ${v.baseline} → ${v.current}`).join('\n'),
  );
  void ok;
}
// 5. CVD
{
  const { ok, problems } = checkCvd();
  report(
    'CVD: --chart-* ramp separable (3 dichromacies, both themes)',
    ok,
    problems.map((p) => `    [${p.theme}] ${p.sim}: ${p.a} vs ${p.b} (ΔE ${p.de})`).join('\n'),
  );
}
// 6. login identity accents
{
  const { ok, results } = checkLoginAccents();
  const fails = results.filter((r) => !r.pass);
  report(
    `login accents (${results.length} composites, both themes)`,
    ok,
    fails
      .map((r) => `    ${r.name}: need ≥${r.bar}:1, got ${r.ratio ?? 'unresolved'}`)
      .join('\n'),
  );
}

if (failed) {
  console.error(`\n${failed} design gate(s) failed.`);
  process.exit(1);
}
console.log('\nAll design gates passed.');
process.exit(0);
