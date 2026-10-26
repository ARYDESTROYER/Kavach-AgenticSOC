/**
 * Overview on paper (Round 12 review): the app-wide `@media print` block in theme.css.
 *
 * The Human vs AI chart measures its box on screen and draws an SVG of that exact size;
 * scripts do not run between the print reflow and the printout. Clipping that SVG to the
 * shorter print box printed a top gridline over a floating partial bar — no time axis, no
 * baseline, no 0 tick — under a caption still naming the window. The print rules must lay
 * the figure out in flow so the box grows to the whole drawn chart, and keep it on one page.
 *
 * jsdom applies no print media, so the CSS text is the contract (the design gates read the
 * same file the same way).
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { THEME_CSS_PATH } from '../../../scripts/lib/theme-css.mjs';

const css = fs.readFileSync(THEME_CSS_PATH, 'utf8');

/** The body of the LAST top-level `@media print { … }` block (the console print rules). */
function consolePrintBlock(text: string): string {
  const start = text.lastIndexOf('@media print {');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('unterminated @media print block');
}

function rule(block: string, selector: string): string {
  const at = block.indexOf(selector);
  expect(at, selector).toBeGreaterThan(-1);
  return block.slice(at, block.indexOf('}', at) + 1);
}

describe('Overview print rules', () => {
  const block = consolePrintBlock(css);

  it('grows the Human vs AI chart box to the drawn chart instead of clipping it', () => {
    const box = rule(block, "#socMain [data-testid='human-vs-ai-chart'] {");
    expect(box).toMatch(/flex:\s*none !important/);
    expect(box).toMatch(/height:\s*auto !important/);
    expect(box).toMatch(/min-height:\s*0 !important/);
    expect(box).toMatch(/overflow-y:\s*visible !important/);
    // `clip`, never `hidden`/`auto`: those make the box a scroll container, which Chrome
    // fragments as one unit and painted over the next band. The old rule clipped both axes.
    expect(box).toMatch(/overflow-x:\s*clip !important/);
    expect(box).not.toMatch(/overflow(-x|-y)?:\s*(hidden|auto|scroll)/);
  });

  it('scales a chart wider than the paper column down to it instead of clipping it', () => {
    // Printed from a 1024px window the on-screen chart is ~900px wide, wider than the A4
    // column; clipped sideways, the newest buckets (where the closes are) were not
    // printed under a header that still counted them (Round 12 final review). The SVG
    // carries a viewBox (CloseAttributionChart), so these two properties scale it.
    const svg = rule(block, "#socMain [data-testid='human-vs-ai-figure'] > svg {");
    expect(svg).toMatch(/max-width:\s*100% !important/);
    expect(svg).toMatch(/height:\s*auto !important/);
    // `max-width`, never `width: 100%`: a narrow xl-column chart must not be enlarged.
    expect(svg).not.toMatch(/(^|[\s;{])width:\s*100%/);
  });

  it('keeps the card on one page inside a plain block row', () => {
    expect(rule(block, "#socMain [data-testid='human-vs-ai'] {")).toMatch(/break-inside:\s*avoid/);
    // Round 14: the flow row has no band title any more, so the print rules target its
    // `data-band` hook, never the heading that used to name it.
    expect(rule(block, "#socMain [data-band='flow'] > div {")).toMatch(/display:\s*block !important/);
    expect(rule(block, "#socMain [data-band='flow'] > div > * + * {")).toMatch(/margin-top:\s*2rem/);
    expect(block).not.toContain('overview-band-flow');
  });

  it('puts the absolutely positioned figure in flow so it gives the box its height', () => {
    const figure = rule(block, "#socMain [data-testid='human-vs-ai-figure'] {");
    expect(figure).toMatch(/position:\s*relative !important/);
    expect(figure).toMatch(/inset:\s*auto !important/);
  });

  it('lays the Latest cases list out in flow on paper and keeps it on one page', () => {
    // On screen the list is absolute over a rem floor; split across a page break, its rows
    // spilled past the box over the Deeper analytics heading.
    expect(rule(block, "#socMain [data-testid='latest-cases-box'] {")).toMatch(
      /min-height:\s*0 !important/,
    );
    expect(rule(block, "#socMain [data-testid='latest-cases-box'] > ul {")).toMatch(
      /position:\s*static !important/,
    );
    // Round 14: the region is named by its heading (`aria-labelledby`), so the print rule
    // reaches it through its `data-testid` hook, never a label attribute it no longer has.
    expect(rule(block, "#socMain [data-testid='latest-cases'] {")).toMatch(
      /break-inside:\s*avoid/,
    );
    expect(block).not.toContain("aria-label='Latest cases'");
  });

  it('still hides the console chrome and releases the shell heights', () => {
    expect(block).toContain("[data-testid='desktop-navigation-frame']");
    expect(block).toContain("aside[aria-label='Primary navigation']");
    expect(rule(block, '#socMain > * {')).toMatch(/overflow:\s*visible !important/);
  });
});
