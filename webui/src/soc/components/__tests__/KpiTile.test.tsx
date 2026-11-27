/**
 * KpiTile — delta correctness (BUG #2, DESIGN_STANDARD §5.3).
 *
 * The fix: COLOR encodes the judgement (did the metric improve?), the ARROW encodes
 * the true direction of change (never flipped), and the a11y label announces BOTH.
 * "Open alerts +30%" must read as a REGRESSION (critical), not green-because-positive.
 *
 * jsdom has no paint engine, so we assert the load-bearing DOM facts: the delta
 * color class, which lucide arrow rendered, and the accessible label.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { KpiTile } from '../KpiTile';

/** The delta chip is the span carrying the accessible "changed …" aria-label. */
function deltaChip(container: HTMLElement) {
  return container.querySelector('[aria-label^="changed"]') as HTMLElement | null;
}
/** Which lucide arrow rendered inside the delta chip ('up' | 'down' | null). */
function arrowDir(chip: HTMLElement | null): 'up' | 'down' | null {
  if (!chip) return null;
  const svg = chip.querySelector('svg');
  const cls = svg?.getAttribute('class') || '';
  if (/arrow-up-right/.test(cls)) return 'up';
  if (/arrow-down-right/.test(cls)) return 'down';
  return null;
}

describe('KpiTile delta (bug #2 — color=judgement, arrow=direction)', () => {
  // THE required new spec: goodDirection='down' + delta=-12% → GREEN + DOWN arrow.
  it("goodDirection='down' with delta -12% renders GREEN with a DOWN arrow", () => {
    const { container } = render(
      <KpiTile
        label="MTTA"
        value="12m"
        goodDirection="down"
        delta={{ value: -12, label: '-12%' }}
      />,
    );
    const chip = deltaChip(container);
    expect(chip).not.toBeNull();
    // Lower-is-better metric fell → improvement → success (green).
    expect(chip!.className).toContain('text-success');
    expect(chip!.className).not.toContain('text-critical');
    // Arrow reflects the TRUE direction (value went down), never flipped by judgement.
    expect(arrowDir(chip)).toBe('down');
    // a11y announces both the direction and the judgement (not color-only).
    expect(chip!.getAttribute('aria-label')).toBe('changed down by -12%, improved');
  });

  it("goodDirection='up' (default) with a positive delta is GREEN + UP arrow", () => {
    const { container } = render(
      <KpiTile label="Agreement" value="92%" delta={{ value: 8, label: '+8%' }} />,
    );
    const chip = deltaChip(container);
    expect(chip!.className).toContain('text-success');
    expect(arrowDir(chip)).toBe('up');
  });

  it("goodDirection='up' with a NEGATIVE delta is CRITICAL + DOWN arrow", () => {
    const { container } = render(
      <KpiTile label="Coverage" value="40%" goodDirection="up" delta={{ value: -5, label: '-5%' }} />,
    );
    const chip = deltaChip(container);
    expect(chip!.className).toContain('text-critical');
    expect(arrowDir(chip)).toBe('down');
  });

  it("goodDirection='down' with a POSITIVE delta (worse) is CRITICAL + UP arrow", () => {
    const { container } = render(
      <KpiTile
        label="Open alerts"
        value="130"
        goodDirection="down"
        delta={{ value: 30, label: '+30%' }}
      />,
    );
    const chip = deltaChip(container);
    // Rising on a lower-is-better metric is a regression — never green.
    expect(chip!.className).toContain('text-critical');
    expect(chip!.className).not.toContain('text-success');
    expect(arrowDir(chip)).toBe('up');
    expect(chip!.getAttribute('aria-label')).toBe('changed up by +30%, worse');
  });

  it("goodDirection='none' colors the delta muted (no judgement) but keeps a true arrow", () => {
    const { container } = render(
      <KpiTile label="Volume" value="1.2k" goodDirection="none" delta={{ value: -3, label: '-3%' }} />,
    );
    const chip = deltaChip(container);
    expect(chip!.className).toContain('text-muted-foreground');
    expect(chip!.className).not.toContain('text-success');
    expect(chip!.className).not.toContain('text-critical');
    expect(arrowDir(chip)).toBe('down');
    expect(chip!.getAttribute('aria-label')).toBe('changed down by -3%');
  });

  it('default goodDirection is "up" (no regression for existing call sites)', () => {
    // No goodDirection passed + positive delta → green (old positive-is-good behavior).
    const { container } = render(<KpiTile label="Resolved" value="88" delta={{ value: 4 }} />);
    const chip = deltaChip(container);
    expect(chip!.className).toContain('text-success');
    expect(arrowDir(chip)).toBe('up');
  });

  it("variant='bar' renders a left accent bar and stable test anchor (framed chrome)", () => {
    const { container } = render(
      <KpiTile variant="bar" chrome="framed" label="MTTR" value="1h 4m" accent="high" />,
    );
    const tile = container.querySelector('[data-testid="kpi-mttr"]');
    expect(tile).not.toBeNull();
    // The bar edge is an aria-hidden span with the accent bg + left placement.
    const edge = tile!.querySelector('span[aria-hidden].bg-high');
    expect(edge).not.toBeNull();
    expect(edge!.className).toContain('left-0');
  });

  it("variant='bar' on the strip chrome (the Round 14 page default) draws no accent edge", () => {
    const { container } = render(<KpiTile variant="bar" label="MTTR" value="1h 4m" accent="high" />);
    const tile = container.querySelector('[data-testid="kpi-mttr"]');
    expect(tile).not.toBeNull();
    expect(tile!.querySelector('span[aria-hidden].bg-high')).toBeNull();
    expect(tile!.className).not.toMatch(/\bborder\b/);
  });
});
