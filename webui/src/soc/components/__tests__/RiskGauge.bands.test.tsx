/**
 * RiskGauge — canonical scoreBand ladder (F1).
 *
 * The gauge previously used a divergent 80/60/35 ladder, so the same score rendered a
 * different band than RiskBadge/posture (which use palette's ONE 74/48/22 `scoreBand`).
 * This pins the gauge to `scoreBand`, so its band label always agrees with the rest of
 * the app.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RiskGauge } from '../RiskGauge';
import { scoreBand } from '../palette';

const LABEL: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

describe('RiskGauge — canonical scoreBand ladder', () => {
  for (const score of [10, 22, 30, 47, 48, 50, 73, 74, 76, 100]) {
    it(`score ${score} → band "${LABEL[scoreBand(score)]}" (matches scoreBand)`, () => {
      const { container } = render(<RiskGauge score={score} />);
      const title = container.querySelector('title')?.textContent || '';
      expect(title).toContain(LABEL[scoreBand(score)]);
    });
  }

  it('score 50 reads High (not Medium) — the old 80/60/35 gauge ladder is gone', () => {
    const { container } = render(<RiskGauge score={50} />);
    expect(container.querySelector('title')?.textContent).toContain('High');
    // The visible non-color band label agrees too.
    expect(container.textContent).toContain('High');
  });

  it('score 76 reads Critical (>= 74), not High', () => {
    const { container } = render(<RiskGauge score={76} />);
    expect(container.querySelector('title')?.textContent).toContain('Critical');
  });

  it('draws the value and band word in the AA text tokens; only the arc and swatch use the fill', () => {
    // Medium's fill is 3.26:1 on a light card (fails 4.5:1 for 12 px text).
    const { getByText, container } = render(<RiskGauge score={30} />);
    const word = getByText('Medium');
    expect(word.className).toContain('text-medium-text');
    expect(word.className).not.toMatch(/(^|\s)text-medium(\s|$)/);
    expect(getByText('30').className).toContain('text-medium-text');
    expect(word.querySelector('svg')!.getAttribute('class')).toContain('text-medium');
    const arc = Array.from(container.querySelectorAll('path')).find((p) => p.getAttribute('stroke-dasharray') != null);
    expect(arc!.getAttribute('class')).toContain('stroke-medium');
  });
});

