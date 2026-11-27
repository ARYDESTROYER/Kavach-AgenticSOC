/**
 * Baseline page — R6 config-editor coverage.
 *
 * Focus: the policy form must NOT render its DEFAULT values while the persisted
 * config is still loading (that flashes a misleading "disabled" state, then snaps to
 * the saved values). It shows the shared loading state until the GET resolves, matching the warm-up
 * section directly above it.
 *
 * The stats fetch + config client + auth are mocked (no network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

const { fetchStatsMock, getConfigMock, putConfigMock } = vi.hoisted(() => ({
  fetchStatsMock: vi.fn(),
  getConfigMock: vi.fn(),
  putConfigMock: vi.fn(),
}));

vi.mock('@/soc/Baseline.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../Baseline.api')>();
  return { ...actual, fetchBaselineStats: fetchStatsMock };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, baseline: { getConfig: getConfigMock, putConfig: putConfigMock } },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'tester', authEnabled: false, hasPermission: () => true }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import { BaselineInner } from '../Baseline';
import type { BaselineConfig } from '@/lib/types';

function renderPage() {
  return render(
    <TooltipProvider>
      <BaselineInner />
    </TooltipProvider>,
  );
}

const SAVED_CONFIG: BaselineConfig = {
  enabled: true,
  half_life_days: 30,
  warmup_multiplier: 3,
  modified_z_threshold: 3.5,
  tdigest_compression: 100,
  seasonality: 'hour_of_week',
};

describe('Baseline config editor loading state', () => {
  beforeEach(() => {
    fetchStatsMock.mockReset();
    getConfigMock.mockReset();
    fetchStatsMock.mockResolvedValue(null);
  });

  it('does not show the default-valued policy form while the persisted config loads', async () => {
    // Keep the config GET pending so the editor stays in its loading state.
    let resolveCfg: (v: { config: BaselineConfig }) => void = () => {};
    getConfigMock.mockReturnValue(
      new Promise<{ config: BaselineConfig }>((res) => {
        resolveCfg = res;
      }),
    );

    renderPage();

    expect(
      await screen.findByRole('status', { name: 'Loading baseline policy' }),
    ).toBeInTheDocument();

    // While the config load is in flight the form (and its Enable switch) must be
    // absent — the operator never sees the DEFAULT (disabled) form as if it were saved.
    expect(
      screen.queryByRole('switch', { name: /enable anomaly baseline/i }),
    ).toBeNull();

    // Resolve with a persisted config that has the detector ENABLED.
    resolveCfg({ config: SAVED_CONFIG });

    const toggle = await screen.findByRole('switch', { name: /enable anomaly baseline/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('uses the shared blocking state while the first baseline snapshot loads', async () => {
    fetchStatsMock.mockReturnValue(new Promise(() => {}));
    getConfigMock.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(
      await screen.findByRole('status', { name: 'Loading anomaly baseline' }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(
      screen.queryByRole('status', { name: 'Loading baseline policy' }),
    ).toBeNull();
  });
});

describe('Baseline warm-up empty-state (#41)', () => {
  beforeEach(() => {
    fetchStatsMock.mockReset();
    getConfigMock.mockReset();
    // No baseline data → the warm-up empty-state renders. The config resolves (disabled)
    // so the page settles out of loading.
    fetchStatsMock.mockResolvedValue(null);
    getConfigMock.mockResolvedValue({ config: { ...SAVED_CONFIG, enabled: false } });
  });

  it('states the enable + events-feed dependency (not an auto warm-up) and links to sources', async () => {
    renderPage();
    // The old copy ("warms up as EVENT-feed detection runs") implied auto warm-up; the
    // reworded copy spells out BOTH dependencies so an empty gauge does not read as broken.
    expect(await screen.findByText(/only warms up once it is enabled/i)).toBeInTheDocument();
    expect(screen.getByText(/events-role feed with detection/i)).toBeInTheDocument();
    // And offers a concrete next step: connect the missing half (an events source).
    expect(
      screen.getByRole('button', { name: /connect an events source/i }),
    ).toBeInTheDocument();
    // The stale "warms up as EVENT-feed detection runs" phrasing is gone.
    expect(screen.queryByText(/warms up as EVENT-feed detection runs/i)).toBeNull();
  });
});

describe('Baseline on the Round 14 console grammar (BL1 to BL4)', () => {
  const STATS = {
    enabled: true,
    signature_count: 7,
    total_buckets: 21,
    warm_buckets: 14,
    warmup_target: 504,
    seasonality: 'hour_of_week',
    half_life_days: 14,
    modified_z_threshold: 3.5,
    sketch_version: 1,
    signatures: [],
  };

  beforeEach(() => {
    fetchStatsMock.mockReset();
    getConfigMock.mockReset();
    fetchStatsMock.mockResolvedValue(STATS);
    getConfigMock.mockResolvedValue({ config: SAVED_CONFIG });
  });

  it('heads the page with the title "Baseline", a help tip and an icon Refresh only', async () => {
    renderPage();
    const heading = await screen.findByRole('heading', { level: 1, name: 'Baseline' });
    expect(heading).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Baseline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh baseline' })).toBeInTheDocument();
    // No breadcrumb, no description line, no "Anomaly baseline" title.
    expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).toBeNull();
    expect(screen.queryByText(/Per-entity streaming baselines that improve/)).toBeNull();
  });

  it('shows the counts as a KpiStrip and the overall warm-up in a panel, seasonality as text', async () => {
    renderPage();
    const strip = await screen.findByRole('group', { name: 'Baseline summary' });
    expect(strip).toHaveAttribute('data-kpi-strip', 'compact');
    expect(strip.querySelectorAll('svg')).toHaveLength(0);
    expect(within(strip).queryByText('Seasonality')).toBeNull();
    const warmup = screen.getByRole('region', { name: 'Overall warm-up' });
    expect(within(warmup).getByText('14 of 21 buckets warm')).toBeInTheDocument();
    expect(within(warmup).getByTestId('baseline-context')).toHaveTextContent(
      'Seasonality Hour of week · deviation bar z ≥ 3.5 · half-life 14 days · sketch version 1',
    );
  });

  it('puts the policy in one panel with no advisory callout, and the z threshold shown once', async () => {
    renderPage();
    const policy = await screen.findByRole('region', { name: 'Baseline policy' });
    await within(policy).findByRole('switch', { name: /enable anomaly baseline/i });
    expect(within(policy).queryByText('The baseline is advisory')).toBeNull();
    expect(within(policy).queryByRole('alert')).toBeNull();
    const z = within(policy).getByRole('spinbutton', { name: /Modified-z threshold/ });
    expect(z).toHaveValue('3.5');
    // The slider readout is gone: the value is in the field only.
    expect(within(policy).queryByRole('slider')).toBeNull();
    expect(within(policy).getByRole('spinbutton', { name: /Half-life/ })).toBeInTheDocument();
  });

  it('states the backend default truthfully: on by default (config.BaselineConfig.enabled = True)', async () => {
    renderPage();
    const policy = await screen.findByRole('region', { name: 'Baseline policy' });
    expect(
      within(policy).getByText('On by default. An off detector emits no candidates and changes nothing.'),
    ).toBeInTheDocument();
    expect(policy.textContent ?? '').not.toMatch(/Off by default/);
  });

  it('falls back to the backend default (on) when the stored policy omits the switch', async () => {
    const { enabled: _omitted, ...withoutSwitch } = SAVED_CONFIG;
    void _omitted;
    getConfigMock.mockResolvedValue({ config: withoutSwitch });
    renderPage();
    const policy = await screen.findByRole('region', { name: 'Baseline policy' });
    const toggle = await within(policy).findByRole('switch', { name: /enable anomaly baseline/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('carries the advisory boundary in the help tip, and its copy has no em dash', async () => {
    renderPage();
    await screen.findByRole('region', { name: 'Baseline policy' });
    fireEvent.click(screen.getByRole('button', { name: 'About Baseline' }));
    expect(
      await screen.findAllByText(/never closes, escalates or decides a case/),
    ).not.toHaveLength(0);
    expect(document.body.textContent ?? '').not.toContain('—');
  });

  it('names a stats failure plainly and offers a retry', async () => {
    fetchStatsMock.mockReset();
    fetchStatsMock.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText('Could not load the baseline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
