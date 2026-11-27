/**
 * A KPI change against a dated previous period (Round 12 polish, screenshot tour 2
 * shot 09). The previous period of "last 90 days (since 15 Jul 2026)" is named "previous
 * 90 days (16 Apr to 14 Jul 2026)"; on a narrow tile the words wrapped inside a date
 * ("(16" / "Apr to 14 Jul 2026)"). Each date is now held together, so the words wrap
 * between dates, and they still read and are announced exactly as the server wrote them.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { KpiTile, keepDatesTogether } from '../KpiTile';

const NBSP = ' ';

describe('keepDatesTogether', () => {
  it('joins a day to its month and a month to its year, nothing else', () => {
    expect(keepDatesTogether('vs previous 90 days (16 Apr to 14 Jul 2026)')).toBe(
      `vs previous 90 days (16${NBSP}Apr to 14${NBSP}Jul${NBSP}2026)`,
    );
    expect(keepDatesTogether('vs previous 6 months (Nov 2025 to Apr 2026)')).toBe(
      `vs previous 6 months (Nov${NBSP}2025 to Apr${NBSP}2026)`,
    );
    // Words without a date, and numbers that are not days, are left as they are.
    expect(keepDatesTogether('vs previous 24 hours')).toBe('vs previous 24 hours');
    expect(keepDatesTogether('vs previous window')).toBe('vs previous window');
  });
});

describe('KpiTile comparison words with dates', () => {
  it('wrap between dates and read the same', () => {
    const period = 'vs previous 90 days (16 Apr to 14 Jul 2026)';
    const { container } = render(
      <KpiTile
        label="Cases"
        value="83"
        variant="strip"
        density="compact"
        goodDirection="none"
        delta={{ value: 83, label: '+83', period }}
      />,
    );
    const words = container.querySelector('[data-kpi-delta-period]') as HTMLElement;
    expect(words.textContent).toBe(keepDatesTogether(period));
    expect(words.textContent).not.toContain('16 Apr');                   // never "(16" / "Apr"
    expect(words).toHaveTextContent(period);                             // reads the same
    expect(words).not.toHaveClass('whitespace-nowrap');                  // still wraps, between dates
    const chip = container.querySelector('[role="img"][aria-label]') as HTMLElement;
    expect(chip.getAttribute('aria-label')).toBe(`changed up by +83 ${period}`);
  });
});
