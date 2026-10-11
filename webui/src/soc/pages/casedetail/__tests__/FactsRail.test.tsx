/**
 * FactsRail — the Case Manager's persistent facts column (Round 12, CM-2/CM-6). It is
 * the ONE home for the facts the Overview used to repeat (triage chips, owner, clocks
 * and SLA, source, primary entity, related cases, the record) plus the signal profile.
 * This is the datum-inventory check: every fact the earlier layout showed is still here.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import type { Case } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { caseOutcome } from '@/soc/components/outcome';
import { FactsRail } from '../FactsRail';

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const FULL = {
  case_id: 'case-0f3c2a7e9b1d4c55a1e2',
  case_number: 'CASE-2026-0412',
  title: 'Repeated SSH failures',
  status: 'closed',
  verdict: 'NEEDS_HUMAN',
  confidence: 0.75,
  risk_score: 7,
  severity_band: 'critical',
  severity_source: 'source_asserted',
  impact_band: 'low',
  priority_level: 'p4',
  urgency_band: 'medium',
  assignee: 'aryan',
  decision_by: 'analyst',
  disposition: 'false_positive',
  detected_at: iso(-3 * 3600_000),
  created_at: iso(-2 * 3600_000),
  acknowledged_at: iso(-90 * 60_000),
  updated_at: iso(-60_000),
  source_name: 'IBM QRadar SIEM',
  source_id: 'qradar-01',
  detection_source: 'siem_rule',
  source_surface: 'network',
  origin_surface: 'perimeter',
  entity: { type: 'ip', value: '203.0.113.9' },
  rule_ids: ['ssh_bruteforce'],
  related_case_ids: ['case-a', 'case-b'],
  token_cost: 0.0123,
  app_version: '0.1.13',
  build_sha: 'abcdef0123456789',
  agent_persona: 'network_specialist',
  playbook_id: 'pb-ssh',
  verdict_history: [{ verdict: 'NEEDS_HUMAN', confidence: 0.75, risk_score: 7, ts: iso(-2 * 3600_000) }],
  notifications_sent: [
    { channel_id: 'slack-soc', type: 'slack', trigger: 'needs_human', ok: true, ts: iso(-100 * 60_000) },
  ],
  history: [
    {
      event: 'analyst_action',
      action: 'close',
      analyst: 'aryan',
      ts: iso(-60_000),
      classified_disposition: 'false_positive',
    },
  ],
} as unknown as Case;

function renderRail(c: Case = FULL, extra: Partial<React.ComponentProps<typeof FactsRail>> = {}) {
  return render(
    <TooltipProvider>
      <FactsRail
        c={c}
        outcome={caseOutcome(c)}
        triage={null}
        slaPolicy={null}
        fpPolicy={{ enabled: true, min_confidence: 0.9 }}
        users={[{ username: 'aryan' }]}
        canAssign
        onCaseChange={vi.fn()}
        onShowRelated={vi.fn()}
        {...extra}
      />
    </TooltipProvider>,
  );
}

describe('FactsRail', () => {
  it('carries every fact the earlier Overview and header showed', () => {
    renderRail();
    const rail = screen.getByRole('complementary', { name: 'Case facts' });

    // Outcome: the analyst's call, who/when, and the AI line with the agreement.
    const outcome = within(rail).getByTestId('facts-outcome');
    expect(within(outcome).getByTestId('facts-outcome-headline')).toHaveTextContent('Closed as false positive');
    expect(outcome).toHaveTextContent(/classified by aryan/i);
    expect(outcome).toHaveTextContent('AI verdict: Needs human review (75%) · Resolves the AI hand-off');

    // Signal profile: risk by its own band, the AI confidence against the auto-close bar.
    const profile = within(rail).getByTestId('case-signal-profile');
    expect(within(profile).getByRole('progressbar', { name: 'Risk score: 7/100' })).toBeInTheDocument();
    expect(within(profile).getByText('AI confidence (at assessment)')).toBeInTheDocument();
    expect(profile).toHaveTextContent(/auto-close bar 90%/);

    // Triage chips — one home.
    const triage = within(rail).getByTestId('facts-triage');
    for (const label of ['Severity', 'Impact', 'Priority', 'Urgency']) {
      expect(within(triage).getByText(label)).toBeInTheDocument();
    }
    expect(triage).toHaveTextContent('P4');

    // Ownership, clocks, source.
    expect(within(rail).getByTestId('facts-ownership')).toHaveTextContent('aryan');
    const times = within(rail).getByTestId('facts-times');
    for (const label of ['Detected', 'Opened', 'Acknowledged', 'Updated']) {
      expect(within(times).getByText(label)).toBeInTheDocument();
    }
    const source = within(rail).getByTestId('facts-source');
    for (const text of ['IBM QRadar SIEM', 'qradar-01', 'Siem rule', 'Network', 'Perimeter']) {
      expect(source).toHaveTextContent(text);
    }

    // Primary entity with the entity → rule → surface story ("Seen by … on …").
    const entity = within(rail).getByTestId('facts-entity');
    expect(entity).toHaveTextContent('203.0.113.9');
    expect(entity).toHaveTextContent('Seen by ssh_bruteforce on IBM QRadar SIEM');

    // Related cases jump.
    expect(within(rail).getByTestId('facts-related')).toHaveTextContent('2 related cases');

    // The record: decider, cost, build, profile, playbook, classification + AI history,
    // notifications.
    const record = within(rail).getByTestId('facts-record');
    for (const text of [
      'Decided by',
      'Investigation cost',
      'v0.1.13 · abcdef012345',
      'Network specialist',
      'pb-ssh',
      'Classification history',
      'AI verdict history',
      'Notifications sent (1)',
      'Slack',
    ]) {
      expect(record).toHaveTextContent(text);
    }
  });

  it('offers "Set disposition" only when a human close recorded no outcome', () => {
    const onSetDisposition = vi.fn();
    const undeclared = {
      ...FULL,
      history: [{ event: 'analyst_action', action: 'close', analyst: 'aryan', ts: iso(-60_000) }],
    } as unknown as Case;
    renderRail(undeclared, { onSetDisposition });
    const outcome = screen.getByTestId('facts-outcome');
    expect(outcome).toHaveTextContent('Closed by analyst: outcome not recorded');
    expect(within(outcome).getByRole('button', { name: 'Set disposition' })).toBeInTheDocument();
  });

  it('keeps a triage-recorded disposition visible, labelled as not an analyst call', () => {
    const open = {
      ...FULL,
      status: 'investigating',
      decision_by: 'agent',
      disposition: 'suspicious',
      history: [],
    } as unknown as Case;
    renderRail(open);
    expect(screen.getByTestId('facts-recorded-disposition')).toHaveTextContent(
      'Recorded disposition: Suspicious (not confirmed by an analyst)',
    );
  });

  it('never repeats the disposition line once an analyst classified the case', () => {
    renderRail();
    expect(screen.queryByTestId('facts-recorded-disposition')).toBeNull();
  });
});
