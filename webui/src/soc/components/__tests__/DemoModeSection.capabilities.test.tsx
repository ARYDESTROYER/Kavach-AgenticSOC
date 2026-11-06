/**
 * Demo overhaul — the ACTIVE-state summary shows a "Capabilities live" row so the
 * operator can see the demo's tuning / campaigns / HITL / RAG features are working.
 *
 * We drive `useDemo()` (mocked, mutable) into an ACTIVE state carrying the new
 * capability counts and assert each tile renders its value. Keeps the new `DemoStatus`
 * fields OPTIONAL so the render/guard tests elsewhere stay untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { DemoStatus } from '@/lib/types';
import { DASH } from '@/lib/format';

const FULL: DemoStatus = {
  mode: 'live',
  active: true,
  run_id: 'demorun-abc',
  seed: 1337,
  history_days: 14,
  case_count: 42,
  sources: ['demo-splunk', 'demo-qradar', 'demo-wazuh', 'demo-syslog'],
  proposals_open: 2,
  campaigns_found: 1,
  tuning_events: 3,
  rag_chunks: 128,
  source_activity: [
    {
      source_id: 'demo-splunk', display_name: 'Splunk Enterprise',
      protocol: 'HEC / HTTPS', healthy: true, events_total: 120, alerts_total: 2,
    },
  ],
};

// A mutable holder so a test can swap the status the mocked useDemo() returns.
const h = vi.hoisted(() => ({ status: {} as DemoStatus }));
vi.mock('@/soc/demo', () => ({
  useDemo: () => ({ status: h.status, active: true, loading: false, refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DemoModeSection } from '../DemoModeSection';
import { TooltipProvider } from '@/ui/tooltip';

const renderDemo = () =>
  render(
    <TooltipProvider>
      <DemoModeSection />
    </TooltipProvider>,
  );

/** The SummaryTile value is the sibling <p> right after the label <p>. */
function tileValue(label: string): string {
  const labelEl = screen.getByText(label);
  return labelEl.nextElementSibling?.textContent ?? '';
}

describe('DemoModeSection capabilities (demo overhaul)', () => {
  beforeEach(() => {
    h.status = { ...FULL };
  });

  it('renders the "Capabilities live" tiles with their counts when active', () => {
    renderDemo();
    expect(screen.getByText('Capabilities live')).toBeInTheDocument();
    expect(tileValue('HITL approvals')).toBe('2');
    expect(tileValue('Campaigns')).toBe('1');
    expect(tileValue('Tuning observations')).toBe('3');
    expect(tileValue('RAG corpus')).toBe('128 chunks');
  });

  it('reports the four native demo sources in the active summary', () => {
    renderDemo();
    expect(tileValue('Sources')).toBe('4');
  });

  it('shows truthful native source activity counters', () => {
    renderDemo();
    expect(screen.getByText('Native source activity')).toBeInTheDocument();
    expect(screen.getByText('Splunk Enterprise')).toBeInTheDocument();
    expect(screen.getByText('HEC / HTTPS')).toBeInTheDocument();
    expect(screen.getByText('120 events · 2 native alerts')).toBeInTheDocument();
  });

  it('falls back to a dash for an absent capability count', () => {
    // A stale/partial status without the capability fields must not crash — tiles dash.
    h.status = { mode: 'seeded', active: true, seed: 1, case_count: 5 };
    renderDemo();
    expect(tileValue('HITL approvals')).toBe(DASH);
    expect(tileValue('RAG corpus')).toBe(DASH);
  });
});

describe('DemoModeSection copy and semantics (Round 14)', () => {
  beforeEach(() => {
    h.status = { ...FULL, source_activity: [...FULL.source_activity!, { source_id: 'demo-wazuh', display_name: 'Wazuh', healthy: false }] };
  });

  it('shows a degraded source in words beside its dot, and a healthy one calmly', () => {
    renderDemo();
    // Status never by colour alone: the exception is visible text, its dot decorative.
    const degraded = screen.getByText('Degraded');
    expect(degraded).toBeVisible();
    const status = degraded.closest('[data-status-tone]') as HTMLElement;
    expect(status).toHaveAttribute('data-status-tone', 'critical');
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull();
    // A healthy source carries no status at all (the healthy default reads calm).
    expect(screen.queryByText('Healthy')).toBeNull();
    expect(screen.queryByRole('img', { name: /healthy|degraded/i })).toBeNull();
  });

  it('prints each source count with thousands separators', () => {
    h.status = {
      ...FULL,
      source_activity: [
        {
          source_id: 'demo-splunk', display_name: 'Splunk Enterprise', protocol: 'HEC / HTTPS',
          healthy: true, events_total: 12345, alerts_total: 1200, system_detections_total: 4567,
        },
      ],
    };
    renderDemo();
    expect(screen.getByText(/12,345 events · 1,200 native alerts · 4,567 Agentic SOC detections/)).toBeInTheDocument();
  });

  it('uses sentence-case labels, never tracked capitals', () => {
    renderDemo();
    for (const label of ['Capabilities live', 'Native source activity']) {
      const el = screen.getByText(label);
      expect(el.className).not.toMatch(/\buppercase\b|\btracking-/);
    }
  });

  it('writes no dash as punctuation in its own copy (only the missing-value dash)', () => {
    renderDemo();
    const text = (document.body.textContent ?? '').replaceAll(DASH, '');
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
