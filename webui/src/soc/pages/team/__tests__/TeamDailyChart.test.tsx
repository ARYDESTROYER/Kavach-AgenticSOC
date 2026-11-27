/**
 * Round 15 Team activity chart (SPEC D3.11): seven kinds on six distinct ramp colours
 * plus the neutral grey, and a one-day range drawn as a bar of at most 48px rather than
 * a slab across the card.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { categorical } from '@/soc/components/palette';
import type { TeamChartKind, TeamDay } from '@/lib/types-team';

import { TEAM_BAR_MAX_PX, TeamDailyChart, kindColor } from '../TeamDailyChart';

const KINDS: TeamChartKind[] = ['closed', 'acknowledged', 'commented', 'reviewed', 'escalated', 'reopened', 'other'];

describe('TeamDailyChart', () => {
  it('gives every kind its own colour and never uses --chart-6 beside acknowledged', () => {
    const colours = KINDS.map(kindColor);
    expect(new Set(colours).size).toBe(KINDS.length);
    // --chart-6 nearly matches --chart-2 (acknowledged) in the light theme.
    expect(kindColor('acknowledged')).toBe(categorical(1));
    expect(colours).not.toContain(categorical(5));
    expect(kindColor('reopened')).toBe(categorical(6));
  });

  it('draws a one-day range as a bar no wider than the cap', () => {
    const days: TeamDay<TeamChartKind>[] = [
      {
        date: '2026-11-24',
        counts: { closed: 4, acknowledged: 2, commented: 0, reviewed: 1, escalated: 0, reopened: 1, other: 0 },
      },
    ];
    render(<TeamDailyChart days={days} />);
    const chart = screen.getByTestId('team-daily-chart');
    const bars = Array.from(chart.querySelectorAll('.recharts-bar-rectangle path'));
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      const width = Number(bar.getAttribute('width'));
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThanOrEqual(TEAM_BAR_MAX_PX);
    }
  });
});
