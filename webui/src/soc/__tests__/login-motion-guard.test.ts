/**
 * Source guard for the sign-in page's motion (Round 16 WP04, SPEC §3.6 and [login] R2).
 *
 * Reads styles/theme.css as text and holds every `@keyframes login-*` rule to the
 * recorded contract: it sits inside `@media (prefers-reduced-motion: no-preference)`,
 * animates only `opacity` and `transform`, and every animation that uses it runs once
 * (no `infinite`), fills `backwards`, and lasts at most 300ms (600ms for the brand
 * wash). The retired identity canvas (ambient tiles, gradient controls) stays gone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const THEME_CSS = path.resolve(__dirname, '..', '..', 'styles', 'theme.css');
const css = fs.readFileSync(THEME_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the block whose opening brace follows `index`, braces matched. */
function blockAt(source: string, index: number): { body: string; end: number } {
  const open = source.indexOf('{', index);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open + 1, i), end: i };
    }
  }
  throw new Error(`unbalanced block at ${index}`);
}

/** Every block that starts at `pattern` (a header such as `@keyframes login-`). */
function blocks(source: string, pattern: RegExp): Array<{ header: string; body: string; start: number; end: number }> {
  const out: Array<{ header: string; body: string; start: number; end: number }> = [];
  const re = new RegExp(pattern.source, 'g');
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const { body, end } = blockAt(source, m.index);
    out.push({ header: source.slice(m.index, source.indexOf('{', m.index)).trim(), body, start: m.index, end });
  }
  return out;
}

const noPreference = blocks(css, /@media\s*\(prefers-reduced-motion:\s*no-preference\)/);
const keyframes = blocks(css, /@keyframes\s+login-[\w-]+/);

function durationMs(token: string): number | null {
  const m = /^([\d.]+)(ms|s)$/.exec(token);
  if (!m) return null;
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
}

describe('the sign-in page motion contract (theme.css)', () => {
  it('declares its keyframes, and only inside prefers-reduced-motion: no-preference', () => {
    expect(keyframes.length).toBeGreaterThanOrEqual(3);
    for (const k of keyframes) {
      const inside = noPreference.some((m) => k.start > m.start && k.end < m.end);
      expect(inside, k.header).toBe(true);
    }
  });

  it('animates only opacity and transform in every login keyframe', () => {
    for (const k of keyframes) {
      const properties = Array.from(k.body.matchAll(/([a-z-]+)\s*:/g), (m) => m[1]);
      expect(properties.length, k.header).toBeGreaterThan(0);
      for (const property of properties) expect(['opacity', 'transform'], `${k.header}: ${property}`).toContain(property);
    }
  });

  it('runs every login animation once, filled backwards, at most 300ms (the wash 600ms)', () => {
    const names = keyframes.map((k) => k.header.replace(/^@keyframes\s+/, ''));
    const uses = Array.from(css.matchAll(/([^{};]+)\{[^{}]*?animation\s*:\s*([^;]+);/g))
      .map((m) => ({ selector: m[1].trim(), value: m[2].trim() }))
      .filter((u) => names.some((name) => new RegExp(`\\b${name}\\b`).test(u.value)));
    expect(uses.length).toBeGreaterThanOrEqual(names.length);
    for (const { selector, value } of uses) {
      expect(value, selector).not.toMatch(/\binfinite\b/);
      expect(value, selector).toMatch(/\bbackwards\b/);
      expect(value, selector).not.toMatch(/\bboth\b|\bforwards\b/);
      // The first time value is the duration (any second one is a delay).
      const duration = value.split(/\s+/).map(durationMs).find((ms) => ms !== null) ?? null;
      expect(duration, selector).not.toBeNull();
      const limit = /login-canvas::before/.test(selector) ? 600 : 300;
      expect(duration!, selector).toBeLessThanOrEqual(limit);
      // Every use sits inside the no-preference block too.
      const at = css.indexOf(value);
      expect(noPreference.some((m) => at > m.start && at < m.end), selector).toBe(true);
    }
  });

  it('holds the spinners back for 300ms, so a fast load never flashes one', () => {
    const rule = /\.login-delayed-reveal\s*\{[^}]*animation\s*:\s*([^;]+);/.exec(css);
    expect(rule, '.login-delayed-reveal has no animation').not.toBeNull();
    const times = rule![1].trim().split(/\s+/).map(durationMs).filter((ms): ms is number => ms !== null);
    // Duration first, then the delay: the glyph stays hidden (backwards fill) until 300ms.
    expect(times).toHaveLength(2);
    expect(times[1]).toBe(300);
    expect(rule![1]).toMatch(/\bbackwards\b/);
  });

  it('sets no will-change and keeps the retired identity canvas out', () => {
    const signIn = css.slice(css.indexOf('.login-canvas::before'), noPreference.at(-1)!.end);
    expect(signIn).not.toMatch(/will-change/);
    for (const retired of ['.login-auth-canvas', '.login-auth-cell', '.login-shine-button', '.login-theme-pill', '--login-trail']) {
      expect(css, retired).not.toContain(retired);
    }
  });

  it('drops the brand wash under reduced transparency and forced colours', () => {
    const fallback = blocks(css, /@media\s*\(prefers-reduced-transparency:\s*reduce\),\s*\(forced-colors:\s*active\)/);
    expect(fallback.some((b) => /\.login-canvas::before\s*\{\s*display:\s*none/.test(b.body))).toBe(true);
  });
});
