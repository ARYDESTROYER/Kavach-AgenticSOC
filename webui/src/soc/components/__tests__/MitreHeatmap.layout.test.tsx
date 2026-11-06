/**
 * MitreHeatmap layout (Round 14 closing acceptance, qa1-04; SPEC §4.4.4 "The heatmap fits
 * all tactics"):
 *
 *   - the tactic columns share the width equally and shrink to their own content before
 *     the grid scrolls (no `min-w-max`, which sized each column to its widest tactic name
 *     and pushed Exfiltration out of a 721 px panel at 1440 px; and no fixed 96 px floor,
 *     which pushed the seventh tactic out of chat's 672 px reading column); a long tactic
 *     name wraps at its spaces instead of being cut;
 *   - a technique id is never cut: beside a four-digit count, the count wraps under it;
 *   - where more tactics than fit still scroll sideways, the scroller is a named region in
 *     the Tab order (WCAG 2.1.1), and it is a plain wrapper, out of the Tab order, when
 *     everything fits; in both states the visible grid is hidden from assistive technology
 *     and the screen-reader table, one row per tactic, is the one accessible reading;
 *   - the screen-reader table stays inside its visually hidden clipping box.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { MITRE_COLUMN_TRACK, MitreHeatmap, type MitreTacticColumn } from '../MitreHeatmap';

const TACTICS = ['Initial Access', 'Execution', 'Persistence', 'Privilege Escalation', 'Defense Evasion', 'Credential Access', 'Exfiltration'];
const COLUMNS: MitreTacticColumn[] = TACTICS.map((label, i) => ({
  tactic: `TA00${String(i + 1).padStart(2, '0')}`,
  label,
  cells: [{ technique: `T10${50 + i}`, value: i + 1 }],
}));

/** Measure the scroller as a browser would at a given content and panel width. */
function measure(scrollWidth: number, clientWidth: number) {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth);
}

afterEach(() => vi.restoreAllMocks());

describe('MitreHeatmap layout', () => {
  it('lets every column shrink to its own content before anything scrolls, and wraps long tactic names', () => {
    const { container } = render(<MitreHeatmap columns={COLUMNS} ariaLabel="Techniques seen in cases" />);
    const grid = container.querySelector('[data-mitre-grid]') as HTMLElement;
    // Equal shares of the width, each never narrower than its own content: the grid
    // scrolls only when the content itself cannot fit (no fixed pixel floor).
    expect(MITRE_COLUMN_TRACK).toBe('minmax(min-content, 1fr)');
    expect(grid.style.gridTemplateColumns).toBe('repeat(7, minmax(min-content, 1fr))');
    expect(grid.className).not.toMatch(/\bmin-w-max\b/);
    expect(grid.className).toMatch(/\bw-full\b/);
    const headers = Array.from(container.querySelectorAll('[data-mitre-header]'));
    expect(headers.map((h) => h.textContent)).toEqual(TACTICS);
    for (const h of headers) {
      expect(h.className).not.toMatch(/\btruncate\b/);
      expect(h.className).toMatch(/\bbreak-words\b/);
      // The header holds its column open to 4.5rem, so "T1078 7" never wraps in a scroll.
      expect(h.className).toMatch(/\bmin-w-\[4\.5rem\]/);
      expect(h).toHaveAttribute('title', h.textContent ?? '');
    }
  });

  it('is a plain wrapper, out of the Tab order, when every tactic fits', () => {
    measure(721, 721);
    const { container } = render(<MitreHeatmap columns={COLUMNS} ariaLabel="Techniques seen in cases" />);
    const scroller = container.querySelector('[data-mitre-scroll]') as HTMLElement;
    expect(scroller).toHaveAttribute('data-mitre-scroll', 'fit');
    expect(scroller).toHaveAttribute('role', 'presentation');
    expect(scroller).not.toHaveAttribute('tabindex');
    expect(scroller).not.toHaveAttribute('aria-label');
  });

  it('becomes a named, focusable region when the tactics still scroll sideways', () => {
    measure(1396, 615);
    const { container } = render(<MitreHeatmap columns={[...COLUMNS, ...COLUMNS.map((c) => ({ ...c, tactic: `${c.tactic}-b` }))]} ariaLabel="Techniques seen in cases" />);
    const scroller = container.querySelector('[data-mitre-scroll]') as HTMLElement;
    expect(scroller).toHaveAttribute('data-mitre-scroll', 'overflow');
    expect(scroller).toHaveAttribute('role', 'region');
    expect(scroller).toHaveAttribute('tabindex', '0');
    expect(scroller).toHaveAttribute('aria-label', 'Techniques seen in cases, scrolls sideways');
    act(() => scroller.focus());
    expect(document.activeElement).toBe(scroller);
    // The visible focus treatment is the shared focus ring.
    expect(scroller.className).toMatch(/focus-visible:/);
  });

  it('never cuts a technique id: beside a four-digit count, the count wraps under it', () => {
    const { container } = render(
      <MitreHeatmap
        columns={[{ tactic: 'TA0004', label: 'Privilege Escalation', cells: [{ technique: 'T1078.003', value: 12345 }] }]}
      />,
    );
    const id = container.querySelector('[data-mitre-technique]') as HTMLElement;
    expect(id).toHaveTextContent('T1078.003');
    expect(id.className).not.toMatch(/\btruncate\b/);
    const chip = container.querySelector('[data-mitre-chip]') as HTMLElement;
    expect(chip.className).toMatch(/\bflex-wrap\b/);
    expect(chip).toHaveTextContent('12,345');
    // The cell grows with a wrapped chip instead of clipping it at a fixed height.
    const cell = chip.parentElement as HTMLElement;
    expect(cell.className).toMatch(/\bmin-h-9\b/);
    expect(cell.className).not.toMatch(/(^|\s)h-9(\s|$)/);
    expect(cell).toHaveAttribute('title', 'T1078.003: 12345');
  });

  it('hides the visible grid from assistive technology; the table is the one reading', () => {
    measure(1396, 615);
    const { container } = render(<MitreHeatmap columns={[...COLUMNS, ...COLUMNS.map((c) => ({ ...c, tactic: `${c.tactic}-b` }))]} ariaLabel="Techniques seen in cases" />);
    const grid = container.querySelector('[data-mitre-grid]') as HTMLElement;
    expect(grid).toHaveAttribute('aria-hidden', 'true');
    // The focusable region exposes only its name: everything inside it is hidden.
    const region = screen.getByRole('region', { name: 'Techniques seen in cases, scrolls sideways' });
    for (const el of Array.from(region.querySelectorAll('*'))) expect(el.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(region.querySelector('a, button, input, [tabindex]')).toBeNull();
    // The table outside it reads each tactic as a row with its own techniques.
    const table = screen.getByRole('table', { name: 'Techniques seen in cases' });
    expect(region.contains(table)).toBe(false);
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toContain('Exfiltration');
    // In the fit state the grid stays hidden too (it is not read twice).
    vi.restoreAllMocks();
    measure(721, 721);
    const fit = render(<MitreHeatmap columns={COLUMNS} ariaLabel="Fit" />);
    expect(fit.container.querySelector('[data-mitre-grid]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the screen-reader table inside its visually hidden clipping box', () => {
    const { container } = render(<MitreHeatmap columns={COLUMNS} />);
    const box = container.querySelector('[data-mitre-table]') as HTMLElement;
    expect(box).toHaveClass('sr-only');
    const table = box.querySelector('table');
    expect(table).not.toBeNull();
    expect(table).toHaveClass('sr-only');
    // The table is not inside the scroller (a wide table there would widen the scroll area).
    expect(container.querySelector('[data-mitre-scroll] table')).toBeNull();
  });
});
