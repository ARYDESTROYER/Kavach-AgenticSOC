/**
 * Investigate: the look-back seed reads the settings only for a viewer who may read them
 * (Round 16, SPEC §4.4 WP03). A refusal of `GET /api/settings` writes an Access denied
 * audit row each time, so a person with no `settings:read` grant never sends it and keeps
 * the default look-back. With the grant (or with no auth provider, which reads like auth
 * off), the saved `prefs.investigate_lookback` still seeds the form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { getSettingsMock, grants } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  grants: { current: null as Set<string> | null },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, getSettings: getSettingsMock } };
});

vi.mock('@/soc/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/auth')>();
  return {
    ...actual,
    useOptionalAuth: () =>
      grants.current === null
        ? null
        : { hasPermission: (resource: string, action: string) => grants.current!.has(`${resource}:${action}`) },
  };
});

vi.mock('@/soc/pages/CaseDetail', () => ({ CaseDetail: () => null }));

import { TooltipProvider } from '@/ui/tooltip';
import Investigate from '../Investigate';

function renderPage() {
  return render(
    <TooltipProvider>
      <Investigate onNavigate={vi.fn()} />
    </TooltipProvider>,
  );
}

const lookbackTrigger = () => screen.getAllByRole('combobox').find((el) => /Last \d+ (hours|days)/.test(el.textContent ?? ''));

beforeEach(() => {
  getSettingsMock.mockReset();
  getSettingsMock.mockResolvedValue({ prefs: { investigate_lookback: 'now-7d' } });
  sessionStorage.clear();
});
afterEach(() => {
  grants.current = null;
  sessionStorage.clear();
});

describe('Investigate look-back seed', () => {
  it('never reads the settings without settings:read, and keeps the default look-back', async () => {
    grants.current = new Set(['cases:read', 'investigate:run']);
    renderPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getSettingsMock).not.toHaveBeenCalled();
    expect(lookbackTrigger()).toHaveTextContent('Last 24 hours');
  });

  it('seeds the look-back from the saved preference with settings:read', async () => {
    grants.current = new Set(['settings:read']);
    renderPage();
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lookbackTrigger()).toHaveTextContent('Last 7 days'));
  });

  it('reads like auth off with no auth provider', async () => {
    renderPage();
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lookbackTrigger()).toHaveTextContent('Last 7 days'));
  });
});
