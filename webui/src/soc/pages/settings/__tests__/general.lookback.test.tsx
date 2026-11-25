/**
 * Data scope: the investigate lookback is checked inline (B51), with the grammar the
 * server accepts on save: `now-` and a number of seconds, minutes, hours, days or weeks,
 * or a date and time before now. Free text such as "yesterday" would save and then
 * open a zero-width first search window, so it reads as an error here.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences } from '@/lib/types';

import { GeneralSection, lookbackError } from '../general';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, listSources: vi.fn(() => Promise.resolve({ sources: [] })) } };
});

function renderSection(prefs: Partial<Preferences>) {
  return render(
    <TooltipProvider>
      <GeneralSection prefs={prefs as Preferences} update={vi.fn()} onNavigate={vi.fn()} />
    </TooltipProvider>,
  );
}

describe('Investigate lookback inline check', () => {
  it('shows an error for a value the server would refuse', () => {
    renderSection({ investigate_lookback: 'yesterday' });
    const field = screen.getByLabelText(/^Investigate lookback/);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Use a time before now');
  });

  it('accepts a relative window', () => {
    renderSection({ investigate_lookback: 'now-24h' });
    expect(screen.getByLabelText(/^Investigate lookback/)).not.toHaveAttribute('aria-invalid');
  });

  it('follows the server grammar', () => {
    const now = Date.parse('2026-11-25T12:00:00Z');
    expect(lookbackError('now-7d', now)).toBeUndefined();
    expect(lookbackError('now-90m', now)).toBeUndefined();
    expect(lookbackError('2026-11-01T00:00:00Z', now)).toBeUndefined();
    expect(lookbackError(undefined, now)).toBeUndefined();
    for (const bad of ['', 'now', 'now-0h', 'now+1d', 'yesterday', '2027-01-01T00:00:00Z']) {
      expect(lookbackError(bad, now)).toBeDefined();
    }
  });
});
