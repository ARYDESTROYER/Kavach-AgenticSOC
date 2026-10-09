/**
 * KpiTile delta — AA `-text` tokens + neutral zero-delta (F0 / F12 / F11).
 *   - improved/worse deltas use the AA-tuned `text-success-text` / `text-critical-text`
 *     companions (the fill tokens fail 4.5:1 as 12px text in the light theme),
 *   - a zero / "new" delta is NEUTRAL — never a green "improved" or a red "worse",
 *   - the delta chip carries a valid accessible name via role="img".
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { KpiTile } from '../KpiTile';

function chip(c: HTMLElement) {
  return c.querySelector('[role="img"][aria-label]') as HTMLElement | null;
}
function classList(el: HTMLElement | null) {
  return (el?.className || '').split(/\s+/);
}

describe('KpiTile delta — AA tokens + neutral zero', () => {
  it('an improved delta uses the AA-tuned text-success-text (not the bare fill token)', () => {
    const { container } = render(
      <KpiTile label="Agreement" value="92%" delta={{ value: 8, label: '+8%' }} />,
    );
    expect(classList(chip(container))).toContain('text-success-text');
  });

  it('a worse delta uses text-critical-text', () => {
    const { container } = render(
      <KpiTile
        label="Open alerts"
        value="130"
        goodDirection="down"
        delta={{ value: 30, label: '+30%' }}
      />,
    );
    expect(classList(chip(container))).toContain('text-critical-text');
  });

  it('a zero / "new" delta is NEUTRAL (muted) — never a green improvement', () => {
    const { container } = render(
      <KpiTile label="FP rate" value="12%" delta={{ value: 0, label: 'new' }} />,
    );
    const cls = classList(chip(container));
    expect(cls).toContain('text-muted-foreground');
    expect(cls).not.toContain('text-success-text');
    expect(cls).not.toContain('text-critical-text');
    // A no-change delta announces no improved/worse judgement.
    expect(chip(container)!.getAttribute('aria-label')).not.toMatch(/improved|worse/);
  });

  it('a zero delta on a lower-is-better tile is NOT flagged worse', () => {
    const { container } = render(
      <KpiTile label="MTTR" value="1h" goodDirection="down" delta={{ value: 0, label: 'new' }} />,
    );
    const cls = classList(chip(container));
    expect(cls).toContain('text-muted-foreground');
    expect(cls).not.toContain('text-critical-text');
  });

  it('the delta chip exposes a valid accessible name via role="img"', () => {
    const { container } = render(
      <KpiTile label="Coverage" value="40%" delta={{ value: -5, label: '-5%' }} />,
    );
    const c = chip(container);
    expect(c!.getAttribute('role')).toBe('img');
    expect(c!.getAttribute('aria-label')).toMatch(/changed/);
  });

  it('a zero delta shows no arrow and is never announced as a rise', () => {
    const { container } = render(
      <KpiTile
        label="SLA breached"
        value="10"
        variant="strip"
        density="compact"
        goodDirection="down"
        delta={{ value: 0, label: '0 vs previous window' }}
      />,
    );
    const c = chip(container)!;
    expect(c.getAttribute('aria-label')).toBe('unchanged vs previous window');
    expect(c.querySelector('svg')).toBeNull();
    // A word label is spoken as is.
    const { container: fresh } = render(<KpiTile label="FP rate" value="12%" delta={{ value: 0, label: 'new' }} />);
    expect(chip(fresh)!.getAttribute('aria-label')).toBe('new');
  });
});

