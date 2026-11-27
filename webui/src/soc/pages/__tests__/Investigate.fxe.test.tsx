/**
 * Investigate: the "no events" answer names the widest window a run searched (FXE).
 *
 * A run widens the chosen lookback through 7 and 30 days to a year before it answers
 * that nothing matched, so the answer says "the last 365 days" in words and offers no
 * wider lookback (a wider choice would search the same year again).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { getSettingsMock, investigateMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  investigateMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, getSettings: getSettingsMock, investigate: investigateMock },
  };
});

vi.mock('@/soc/pages/CaseDetail', () => ({ CaseDetail: () => null }));

import { ApiError } from '@/lib/api';
import { TooltipProvider } from '@/ui/tooltip';
import Investigate from '../Investigate';

describe('Investigate: no events', () => {
  beforeEach(() => {
    getSettingsMock.mockReset().mockResolvedValue({ prefs: {} });
    investigateMock.mockReset().mockRejectedValue(
      new ApiError(400, 'No events found for ip 10.20.36.135 in the last 365 days'),
    );
    sessionStorage.clear();
  });

  it('names the widest window searched in words and offers no wider lookback', async () => {
    render(
      <TooltipProvider>
        <Investigate onNavigate={vi.fn()} />
      </TooltipProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText('e.g. 10.0.0.5'), { target: { value: '10.20.36.135' } });
    fireEvent.click(screen.getByRole('button', { name: /run investigation/i }));

    const panel = await screen.findByRole('region', { name: 'No in-scope events' });
    expect(panel).toHaveTextContent('No in-scope events for ip:10.20.36.135');
    expect(panel).toHaveTextContent('Nothing matched in the last 365 days, the widest window a search tries.');
    expect(panel).not.toHaveTextContent(/Last 24 hours|now-/);
    expect(screen.queryByRole('button', { name: /widen lookback/i })).toBeNull();
  });
});
