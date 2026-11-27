/**
 * The Round 14 console grammar rules in `theme.css` (SPEC §3.1, §3.3, §4.9.2; defect F2).
 *
 * jsdom does not apply this stylesheet, so the rules are pinned as text, with their
 * specificity computed: the body's proportional figures (Inter's tabular forms widened the
 * hyphen, "Auto - tuning"), the focus-ring offset painted in the panel colour inside a
 * panel (no canvas halo, whatever variant wrote the offset class), the underline tab list's
 * inset hairline, and the page rhythm `PageContainer` owns (type specificity: above
 * Preflight's element resets, below any class). The measured gaps and colours are
 * live-harness checks (SPEC §8.3).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(__dirname, '../../styles/theme.css'), 'utf8');

/**
 * The specificity (a, b, c) of one selector, enough for the selectors in this file:
 * `:where()` counts nothing, `:not()` and `:is()` count their argument, an id is `a`, a
 * class, an attribute or a pseudo-class is `b`, a type is `c`.
 */
/** An identifier, escapes included (`focus-visible\:ring-offset-background` is one class). */
const IDENT = /^(?:[\w-]|\\.)+/;

function specificity(selector: string): [number, number, number] {
  let a = 0;
  let b = 0;
  let c = 0;
  let i = 0;
  const group = (from: number): [string, number] => {
    let depth = 1;
    let j = from;
    while (j < selector.length && depth > 0) {
      if (selector[j] === '(') depth += 1;
      else if (selector[j] === ')') depth -= 1;
      j += 1;
    }
    return [selector.slice(from, j - 1), j];
  };
  while (i < selector.length) {
    const rest = selector.slice(i);
    const fn = rest.match(/^:(where|not|is)\(/);
    if (fn) {
      const [inner, end] = group(i + fn[0].length);
      if (fn[1] !== 'where') {
        const [ia, ib, ic] = specificity(inner);
        a += ia;
        b += ib;
        c += ic;
      }
      i = end;
    } else if (rest[0] === '[') {
      b += 1;
      i = selector.indexOf(']', i) + 1;
    } else if (rest[0] === '.' || rest[0] === ':') {
      b += 1;
      i += 1 + (rest.slice(1).match(IDENT)?.[0].length ?? 0);
    } else if (rest[0] === '#') {
      a += 1;
      i += 1 + (rest.slice(1).match(IDENT)?.[0].length ?? 0);
    } else if (/^[a-z]/i.test(rest)) {
      c += 1;
      i += rest.match(IDENT)![0].length;
    } else {
      i += 1;
    }
  }
  return [a, b, c];
}

const compare = (x: [number, number, number], y: [number, number, number]) =>
  x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `rule ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('body figures (F2)', () => {
  it('sets proportional figures on the body, never tabular', () => {
    // Declarations only: the rule's comment explains why tabular figures left the body.
    const body = (css.match(/\n {2}body \{([^}]*)\}/)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(body).toContain('font-variant-numeric: proportional-nums');
    expect(body).not.toContain('tabular-nums');
  });
});

describe('focus rings on a panel (SPEC §3.3)', () => {
  const ring = ".surface-panel [class*='ring-offset-background'][class*='ring-offset-background']";

  it('paints the ring offset in the panel colour inside .surface-panel', () => {
    const body = ruleBody(ring);
    expect(body).toContain('--tw-ring-offset-color: hsl(var(--panel))');
  });

  it('outranks the utility in every single-variant form, wherever Tailwind emits it', () => {
    expect(specificity('.focus-visible\\:ring-offset-background:focus-visible')).toEqual([0, 2, 0]);
    // Tailwind writes variants at the end of the stylesheet, after this rule, so order
    // cannot decide: specificity must. The base utility and each variant form:
    const utilities = [
      '.ring-offset-background',
      '.focus-visible\\:ring-offset-background:focus-visible',
      '.focus\\:ring-offset-background:focus',
      '.focus-within\\:ring-offset-background:focus-within',
      ".data-\\[state\\=open\\]\\:ring-offset-background[data-state='open']",
    ];
    expect(specificity(ring)).toEqual([0, 3, 0]);
    for (const utility of utilities) expect(compare(specificity(ring), specificity(utility)), utility).toBeGreaterThan(0);
  });

  it('is unlayered and after the Tailwind utilities', () => {
    const rule = css.indexOf(ring);
    expect(rule).toBeGreaterThan(css.indexOf('@tailwind utilities;'));
    // Not inside an @layer block: the last @layer opened before it is closed before it.
    const lastLayer = css.lastIndexOf('@layer', rule);
    const between = css.slice(lastLayer, rule);
    const opens = (between.match(/\{/g) ?? []).length;
    const closes = (between.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});

describe('underline tabs (ui/tabs.tsx)', () => {
  const list = "[role='tablist'][data-variant='underline']";

  it('insets the hairline by the 6px of focus room, so it starts and ends on the column', () => {
    const body = ruleBody(list);
    expect(body).toMatch(/border-image: linear-gradient\(\s*to right,\s*transparent 0\.375rem,/);
    expect(body).toContain('transparent calc(100% - 0.375rem)');
    expect(body).toMatch(/\)\s*0 0 1 0;/);
    // The same hairline colour and contrast floor as the panel's inset rules.
    expect(body).toContain('hsl(var(--border) / max(0.7, var(--border-alpha-floor, 0)))');
  });

  it('falls back to the plain border in forced colours', () => {
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*\[role='tablist'\]\[data-variant='underline'\] \{\s*border-image: none;/,
    );
  });
});

describe('page rhythm (PageContainer, SPEC §4.9.2)', () => {
  const scope = ':where(.page-rhythm:not(.flex, .grid, .inline-flex, .inline-grid))';
  const siblingSelector = `${scope} > :where(:not([hidden]) ~ :not([hidden])):not(template)`;
  const headerSelector = `${scope} > :where([data-page-header='page'] + :not([hidden])):not(template)`;

  it('spaces modules by one panel gutter: 16px, 20px from 1280px, 24px from 1920px', () => {
    const sibling = siblingSelector;
    const blocks = css.split(sibling).slice(1).map((rest) => rest.slice(0, rest.indexOf('}')));
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain('margin-top: 1rem');
    expect(blocks[1]).toContain('margin-top: 1.25rem');
    expect(blocks[2]).toContain('margin-top: 1.5rem');
    expect(css).toMatch(/@media \(min-width: 1280px\) \{\s*:where\(\.page-rhythm/);
    expect(css).toMatch(/@media \(min-width: 1920px\) \{\s*:where\(\.page-rhythm/);
  });

  it('puts the first module 24px under the page header, after the gutter rules so it wins', () => {
    const at = css.indexOf(headerSelector);
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf('}', at))).toContain('margin-top: 1.5rem');
    expect(at).toBeGreaterThan(css.lastIndexOf(siblingSelector));
    // Equal specificity with the gutter rule, so order decides (the header rule is last).
    expect(specificity(headerSelector)).toEqual(specificity(siblingSelector));
  });

  it('has type specificity: it beats Preflight element resets by order, and loses to any class', () => {
    const lines = css.split('\n').filter((line) => line.includes('.page-rhythm') && line.includes('{'));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      const selector = line.trim().replace(/\s*\{$/, '');
      expect(selector.endsWith(':not(template)'), selector).toBe(true);
      expect(specificity(selector), selector).toEqual([0, 0, 1]);
    }
    // Preflight's `p, h1, ... { margin: 0 }` is (0,0,1) and comes first (`@tailwind base`).
    expect(compare(specificity(siblingSelector), specificity('p'))).toBe(0);
    expect(css.indexOf(siblingSelector)).toBeGreaterThan(css.indexOf('@tailwind base;'));
    // Every class beats it: a page's own space-y, a child's margin utility.
    for (const utility of ['.space-y-6 > :not([hidden]) ~ :not([hidden])', '.mt-8', '.md\\:mt-0']) {
      expect(compare(specificity(siblingSelector), specificity(utility)), utility).toBeLessThan(0);
    }
  });
});

describe('copy', () => {
  it('adds no colour token, no blur and no resting shadow in the Round 14 block', () => {
    const start = css.indexOf('Round 14: one console grammar');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('/* ---- Printing a console page'));
    expect(block).not.toMatch(/--[a-z-]+:\s*\d+ \d+% \d/);
    expect(block).not.toMatch(/backdrop-filter|box-shadow/);
    expect(block).not.toMatch(/[–—]/);
  });
});
