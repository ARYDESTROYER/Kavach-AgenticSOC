/**
 * ThreatContextPanel — asset-context guard (Round-6 finding #19).
 *
 * `criticality` is a top-level asset field rendered separately from `attributes`, so an
 * asset that carries ONLY a criticality must still render the asset card (not the empty
 * state that would silently drop the classification).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { ThreatContextPanel } from '../ThreatContextPanel';
import type { Case, ThreatContextPanel as ThreatContextPanelData } from '@/lib/types';

expect.extend(toHaveNoViolations);

const CASE = { case_id: 'c1', verdict: 'true_positive', risk_score: 50 } as unknown as Case;

/** Mirrors GET /cases/{id}/threat-context — including its live score/sources shape. */
const BACKEND_REAL_PANEL = {
  case_id: 'c1',
  summary: 'The IAM role was assumed from a known Tor exit node.',
  ioc_reputation: [
    {
      indicator: '198.51.100.45',
      type: 'ip',
      score: 100,
      is_malicious: true,
      country: 'US',
      cached: false,
      sources: { AbuseIPDB: { score: 100 } },
    },
  ],
  mitre_techniques: [
    { id: 'T1078', name: 'Valid Accounts', tactics: ['initial_access'] },
    { id: 'T1530', name: 'Data from Cloud Storage Object', tactics: ['collection'] },
    { id: 'T1090', name: 'Proxy', tactics: ['command_and_control'] },
  ],
  asset_context: {
    entity: 'ip:198.51.100.45',
    criticality: 4,
    is_internal: false,
    networks: [],
  },
  generated_at: '2026-07-20T10:46:00Z',
  clustering: {
    available: true,
    cluster_id: 'b8d8524f531bac1234567890',
    input_count: 3,
    input_refs: ['alert-19d7d077fa2b', 'alert-cb98f03bc0ea', 'alert-41ea9e6cae0b'],
    source_count: 1,
    source_breakdown: { 'demo-splunk': 3 },
    correlation: {
      mode: 'threshold',
      threshold: 3,
      window_seconds: 300,
      group_by: 'ip',
      observed_count: 3,
      matched_rule: 'LP-ES-RISK-1001',
      reason: '3 matching alerts for the same IP within 5 minutes.',
    },
    opened_case: {
      case_id: 'c1',
      display_id: 'CASE-000001',
      status: 'escalated',
      verdict: 'true_positive',
    },
    related_cases: [{ case_id: 'c-prior', relationship: 'same_entity_history' }],
    limitations: 'Alert references are redacted stable identifiers; raw alert payloads are not returned.',
  },
} as unknown as ThreatContextPanelData;

describe('ThreatContextPanel — asset context', () => {
  it('renders a criticality-only asset instead of the empty state (#19)', () => {
    const panel = { asset_context: { criticality: 'high' } } as unknown as ThreatContextPanelData;
    render(
      <ThreatContextPanel c={CASE} panel={panel} loading={false} error={null} onRetry={vi.fn()} />,
    );
    // The Criticality row renders...
    expect(screen.getByText('Criticality')).toBeInTheDocument();
    // ...and the "No asset context" empty state is NOT shown for this card.
    expect(screen.queryByText('No asset context')).toBeNull();
  });

  it('still shows the empty state when the asset is genuinely bare', () => {
    const panel = { asset_context: {} } as unknown as ThreatContextPanelData;
    render(
      <ThreatContextPanel c={CASE} panel={panel} loading={false} error={null} onRetry={vi.fn()} />,
    );
    expect(screen.getByText('No asset context')).toBeInTheDocument();
  });
});

describe('ThreatContextPanel — MITRE technique links (#32)', () => {
  it('gives each technique link a distinct, purposeful accessible name', () => {
    const panel = {
      mitre_techniques: [
        { id: 'T1110', name: 'Brute Force' },
        { id: 'T1078', name: 'Valid Accounts' },
      ],
    } as unknown as ThreatContextPanelData;
    render(
      <ThreatContextPanel c={CASE} panel={panel} loading={false} error={null} onRetry={vi.fn()} />,
    );
    // Not several identical "MITRE" links — each names its technique id.
    expect(
      screen.getByRole('link', { name: /Open MITRE ATT&CK T1110 in a new tab/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Open MITRE ATT&CK T1078 in a new tab/i }),
    ).toBeInTheDocument();
  });
});

describe('ThreatContextPanel — Related cases + Evidence dedup (Round-7 D1b)', () => {
  it('does not render Related cases or Evidence sections (they live on the Overview tab)', () => {
    const panel = {
      summary: 'suspicious brute force burst',
      related_cases: [{ case_id: 'c2', title: 'Prior brute force' }],
      evidence: [{ summary: 'evidence blob', query: 'event.action:login' }],
    } as unknown as ThreatContextPanelData;
    render(
      <ThreatContextPanel c={CASE} panel={panel} loading={false} error={null} onRetry={vi.fn()} />,
    );
    // The duplicated sections are gone from this tab...
    expect(screen.queryByText('Related cases')).toBeNull();
    expect(screen.queryByText('Evidence')).toBeNull();
    expect(screen.queryByText('Prior brute force')).toBeNull();
    // ...but the threat summary still renders, so the panel isn't treated as empty.
    expect(screen.getByText('suspicious brute force burst')).toBeInTheDocument();
    expect(screen.queryByText(/produced no sections/i)).toBeNull();
  });
});

describe('ThreatContextPanel — error state (#33)', () => {
  it('renders the shared LoadError (coerced message + Retry) instead of a hand-rolled Alert', () => {
    const onRetry = vi.fn();
    render(
      <ThreatContextPanel
        c={CASE}
        panel={null}
        loading={false}
        error={new Error('threat feed down')}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText('Could not load threat context')).toBeInTheDocument();
    expect(screen.getByText('threat feed down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('ThreatContextPanel — Case Manager presentation', () => {
  it('leads with the MITRE and IOC cards while honoring backend-real score/sources and numeric asset fields', () => {
    // Round 12 (CM-8): flat, divider-led sections (no card-in-card); every field kept.
    const { container } = render(
      <ThreatContextPanel
        c={CASE}
        panel={BACKEND_REAL_PANEL}
        loading={false}
        error={null}
        onRetry={vi.fn()}
        presentation="case-manager"
      />,
    );

    const panel = container.querySelector(
      '[data-case-panel="threat-context"][data-presentation="case-manager"]',
    );
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass('divide-y');
    const mitre = screen.getByTestId('threat-mitre');
    expect(within(mitre).getByRole('heading', { name: /MITRE ATT&CK techniques/i })).toBeInTheDocument();
    const ioc = screen.getByTestId('threat-ioc');
    expect(within(ioc).getByRole('heading', { name: 'Indicator reputation' })).toBeInTheDocument();
    // No nested cards: the technique and indicator lists are divider-led rows.
    for (const section of [mitre, ioc]) {
      expect(section.querySelector('.rounded-\\[8px\\], .rounded-\\[4px\\], .rounded-md.border')).toBeNull();
    }
    // MITRE leads the IOC section in reading order.
    expect(mitre.compareDocumentPosition(ioc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(within(mitre).getByText('T1078')).toBeInTheDocument();
    expect(within(mitre).getByText('Valid Accounts')).toBeInTheDocument();
    expect(within(mitre).getByText('T1530')).toBeInTheDocument();
    expect(within(mitre).getByText('Data from Cloud Storage Object')).toBeInTheDocument();
    expect(within(mitre).getByText('T1090')).toBeInTheDocument();
    expect(within(mitre).getByText('Proxy')).toBeInTheDocument();

    expect(within(ioc).getByText('198.51.100.45')).toBeInTheDocument();
    expect(within(ioc).getByText('AbuseIPDB')).toBeInTheDocument();
    expect(within(ioc).getByText('100%')).toBeInTheDocument();
    expect(within(ioc).getByText('Malicious')).toBeInTheDocument();

    const criticalityRow = screen.getByText('Criticality').parentElement;
    expect(criticalityRow).not.toBeNull();
    expect(within(criticalityRow as HTMLElement).getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Internal asset')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'How this case was clustered' })).toBeInTheDocument();
    expect(screen.getByText('3 matched signals')).toBeInTheDocument();
    expect(screen.getByText('cluster-b8d8524f531b')).toBeInTheDocument();
    expect(screen.getByText('CASE-000001')).toBeInTheDocument();
    expect(screen.queryByText(/raw-1/i)).toBeNull();
  });

  it('has no axe violations with populated backend-real threat context', async () => {
    const { container } = render(
      <ThreatContextPanel
        c={CASE}
        panel={BACKEND_REAL_PANEL}
        loading={false}
        error={null}
        onRetry={vi.fn()}
        presentation="case-manager"
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
