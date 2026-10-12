/**
 * Overview — the remembered Deeper analytics choice survives leaving the page and coming
 * back in the SAME session (Round 12 review).
 *
 * The page remounts on every visit and reconciles its open/closed state from the prefs
 * provider's `misc` snapshot. A save that bypassed the provider left that snapshot on the
 * value loaded at app start, so the next visit undid the analyst's choice (and rewrote the
 * local mirror). This spec mounts the REAL <PrefsProvider>, toggles, unmounts and remounts
 * the Overview inside it, and asserts the choice holds both ways.
 *
 * Offline: the api and the posture fetch are mocked; nothing here can reach #3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchPostureMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn() }));
vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock };
});

const { effectiveMock, putUserMock, listCasesMock, getMetricsMock } = vi.hoisted(() => ({
  effectiveMock: vi.fn(),
  putUserMock: vi.fn(),
  listCasesMock: vi.fn(),
  getMetricsMock: vi.fn(),
}));

vi.mock('@/lib/api', async () => ({
  ApiError: (await vi.importActual<typeof import('@/lib/api')>('@/lib/api')).ApiError,
  api: {
    listCases: listCasesMock,
    getMetrics: getMetricsMock,
    usageSummary: vi.fn().mockResolvedValue({ total_cost: 0, total_tokens: 0, call_count: 0, currency: 'USD' }),
    prefs: { effective: effectiveMock, putUser: putUserMock },
  },
}));

import Overview from '../pages/Overview';
import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import type { Case, EffectivePrefs, Metrics } from '@/lib/types';

const NOW = Date.now();
const CASES = [
  {
    case_id: 'c-1', case_number: 'CASE-1', status: 'open', risk_score: 80, severity_band: 'high',
    title: 'Impossible travel', created_at: new Date(NOW - 60_000).toISOString(),
    updated_at: new Date(NOW - 30_000).toISOString(),
  },
] as unknown as Case[];

const METRICS = {
  total_cases: 1, open_cases: 1, needs_human_cases: 0, closed_cases: 0,
  by_status: { open: 1 }, by_verdict: { none: 1 }, persona_usage: {}, playbook_usage: {},
  cases_per_day: [], burndown: [], timing_trend: [], cost: {},
} as unknown as Metrics;

const effective = (open: boolean): EffectivePrefs =>
  ({
    terminology: {}, theme_mode: 'system', saved_views: [], pinned_view_ids: [], tables: {},
    last_list_state: {}, misc: { overview_deeper_open: open },
    org: { terminology: {}, default_theme: 'system', default_saved_views: [], default_pinned_view_ids: [] },
  }) as unknown as EffectivePrefs;

/** The provider stays mounted across the Overview's unmount/remount, as in the app. */
function Shell({ show }: { show: boolean }) {
  return (
    <ThemeProvider>
      <PrefsProvider>{show ? <Overview onNavigate={vi.fn()} /> : <p>Cases page</p>}</PrefsProvider>
    </ThemeProvider>
  );
}

async function deeperTrigger() {
  await screen.findByTestId('page-hero');
  return screen.findByRole('button', { name: /Deeper analytics/i });
}

describe('Overview — the Deeper analytics choice across a same-session remount', () => {
  beforeEach(() => {
    localStorage.removeItem('soc.overview.deeperOpen');
    fetchPostureMock.mockReset().mockRejectedValue(new Error('no posture in this spec'));
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: 1, window_total_exact: true });
    getMetricsMock.mockReset().mockResolvedValue(METRICS);
    putUserMock.mockReset().mockResolvedValue({});
  });

  it('keeps a CLOSE made on this visit when the server copy loaded at start said open', async () => {
    effectiveMock.mockReset().mockResolvedValue(effective(true));
    const { rerender } = render(<Shell show />);
    const trigger = await deeperTrigger();
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(putUserMock).toHaveBeenLastCalledWith({ misc: { overview_deeper_open: false } });

    // Leave the Overview and come back, with the provider (and its snapshot) still mounted.
    rerender(<Shell show={false} />);
    expect(screen.getByText('Cases page')).toBeInTheDocument();
    rerender(<Shell show />);
    const again = await deeperTrigger();
    // Give the remounted page's reconcile effect its chance to (wrongly) reopen.
    await waitFor(() => expect(again).toHaveAttribute('aria-expanded', 'false'));
    await new Promise((r) => setTimeout(r, 50));
    expect(again).toHaveAttribute('aria-expanded', 'false');
    expect(localStorage.getItem('soc.overview.deeperOpen')).toBe('0');
  });

  it('keeps an OPEN made on this visit when the server copy loaded at start said closed', async () => {
    effectiveMock.mockReset().mockResolvedValue(effective(false));
    const { rerender } = render(<Shell show />);
    const trigger = await deeperTrigger();
    await waitFor(() => expect(effectiveMock).toHaveBeenCalled());
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    rerender(<Shell show={false} />);
    rerender(<Shell show />);
    const again = await deeperTrigger();
    await new Promise((r) => setTimeout(r, 50));
    expect(again).toHaveAttribute('aria-expanded', 'true');
    expect(localStorage.getItem('soc.overview.deeperOpen')).toBe('1');
  });
});
