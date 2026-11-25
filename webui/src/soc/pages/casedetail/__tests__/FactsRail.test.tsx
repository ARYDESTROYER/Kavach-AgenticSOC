/**
 * FactsRail: the case inspector (Round 12, CM-2/CM-6; Round 15, D8.4; Round 16, SPEC
 * §4.4 WP03). It is the ONE home for the facts the tabs used to repeat (triage chips,
 * clocks and SLA, tags and campaign, source, primary entity, related cases, the record)
 * plus the signal profile, in six collapsible hairline-divided sections whose open state
 * is kept per viewer; Record starts closed. The owner's one editable home is the header.
 * This is the datum-inventory check: every fact the earlier layout showed is still here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { Case } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { caseOutcome } from '@/soc/components/outcome';
import { FactsRail, INSPECTOR_SECTIONS_KEY } from '../FactsRail';

// The records kit is WP14's: the stubs are mounted here, and their props pinned.
const recordProps = vi.hoisted(() => ({ usage: null as null | Record<string, unknown>, sheet: null as null | Record<string, unknown>, awaiting: 0 }));
vi.mock('../records/CaseUsageButton', () => ({
  CaseUsageButton: (props: Record<string, unknown>) => {
    recordProps.usage = props;
    return <span>{`$${Number(props.totalCost).toFixed(4)}`}</span>;
  },
}));
vi.mock('../records/AllFieldsSheet', () => ({
  AllFieldsSheet: (props: Record<string, unknown>) => {
    recordProps.sheet = props;
    return props.open ? <div role="dialog" aria-label="All fields" /> : null;
  },
}));
vi.mock('../records/AwaitingReason', () => ({
  AwaitingReason: () => {
    recordProps.awaiting += 1;
    return <p data-testid="awaiting-reason-stub" />;
  },
}));

beforeEach(() => {
  window.localStorage.clear();
  recordProps.usage = null;
  recordProps.sheet = null;
  recordProps.awaiting = 0;
});

/** Record starts closed: open it. */
function openRecord() {
  fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  return screen.getByTestId('facts-record');
}

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
        policy={{ enabled: true, min_confidence: 0.9 }}
        canViewCost
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
    const rail = screen.getByRole('region', { name: 'Case facts' });

    // Outcome: the analyst's call, who/when, and the AI line with the agreement.
    const outcome = within(rail).getByTestId('facts-outcome');
    expect(within(outcome).getByTestId('facts-outcome-headline')).toHaveTextContent('Closed as false positive');
    expect(outcome).toHaveTextContent(/classified by aryan/i);
    expect(outcome).toHaveTextContent('AI verdict: Needs human review (75%) · Resolves the AI hand-off');

    // Who decided, in the Outcome section (D8.4).
    expect(outcome).toHaveTextContent('Decided byAnalyst');

    // Signal: risk by its own band (the factors one click away), then the triage bands.
    const signal = within(rail).getByTestId('facts-signal');
    const profile = within(signal).getByTestId('case-signal-profile');
    expect(within(profile).getByRole('progressbar', { name: 'Risk score: 7/100' })).toBeInTheDocument();
    const triage = within(signal).getByTestId('facts-triage');
    expect(within(triage).getByText('Severity')).toBeInTheDocument();
    // One compact line of priority, impact and urgency.
    expect(within(signal).getByTestId('facts-priority-line')).toHaveTextContent('Priority P4 · Impact Low · Urgency Medium');

    // Tags, with the owner NOT repeated here (its one home is the header).
    expect(within(rail).getByTestId('facts-tags')).toHaveTextContent('No tags');
    expect(within(rail).queryByTestId('facts-ownership')).toBeNull();
    expect(within(rail).queryByRole('combobox')).toBeNull();

    // Clocks, source.
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

    // Related cases: a link to Evidence, in Source and entity.
    expect(within(source).getByTestId('facts-related')).toHaveTextContent('2 related cases');

    // The record (closed until opened): cost, build, profile, the procedure of a case
    // investigated before Round 14 (its stored id under a Console-authored label),
    // classification + AI history, notifications.
    const record = openRecord();
    for (const text of [
      'CASE-2026-0412',
      'Investigation cost',
      'v0.1.13 · abcdef012345',
      'Network specialist',
      'Runbook (before Round 14)',
      'pb-ssh',
      'Classification history',
      'AI verdict history',
      'Notifications sent (1)',
      'Slack',
    ]) {
      expect(record).toHaveTextContent(text);
    }
  });

  it('leaves the investigation cost out without cost:view, and when the server withholds it', () => {
    renderRail(FULL, { canViewCost: false });
    const record = openRecord();
    expect(record).toHaveTextContent('Creation build');
    expect(record).not.toHaveTextContent('Investigation cost');
    expect(record).not.toHaveTextContent('$0.0123');
    cleanup();

    // The server answers `token_cost: null` for a viewer without the grant: no empty-value row.
    renderRail({ ...FULL, token_cost: null } as unknown as Case);
    // The open state is kept per viewer: Record stays open for the next case.
    expect(screen.getByTestId('facts-record')).not.toHaveTextContent('Investigation cost');
    cleanup();

    renderRail();
    expect(screen.getByTestId('facts-record')).toHaveTextContent('Investigation cost$0.0123');
    // The cost is the usage button (WP14's per-call rows), for this case.
    expect(recordProps.usage).toEqual({ caseId: FULL.case_id, totalCost: 0.0123 });
  });

  it('shows the immutable case-creation build or an honest unavailable state (moved from the Overview)', () => {
    renderRail({ ...FULL, app_version: '0.1.13', build_sha: 'abcdef1234567890' } as unknown as Case);
    expect(openRecord()).toHaveTextContent('Creation buildv0.1.13 · abcdef123456');
    cleanup();
    renderRail({ ...FULL, app_version: undefined, build_sha: undefined } as unknown as Case);
    expect(screen.getByTestId('facts-record')).toHaveTextContent('Creation buildUnavailable');
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

  it('has six sections, each a plain heading that folds it, with Record closed (Round 16)', () => {
    renderRail(FULL);
    const rail = screen.getByRole('region', { name: 'Case facts' });
    const headings = within(rail).getAllByRole('heading', { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'Outcome',
      'Signal',
      'Times',
      'Source and entity',
      'Tags and campaign',
      'Record',
    ]);
    for (const heading of headings) {
      // The heading is its disclosure: the words first, then only the chevron.
      const toggle = within(heading).getByRole('button');
      expect(toggle.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(heading.querySelectorAll('svg')).toHaveLength(1);
    }
    const expanded = headings.map((heading) => within(heading).getByRole('button').getAttribute('aria-expanded'));
    expect(expanded).toEqual(['true', 'true', 'true', 'true', 'true', 'false']);
    // The runbook phases and the related-cases section left the inspector.
    expect(within(rail).queryByTestId('facts-runbook')).toBeNull();
  });

  it('keeps each section open or closed for the viewer, and survives blocked storage', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Times' }));
    expect(screen.getByRole('button', { name: 'Times' })).toHaveAttribute('aria-expanded', 'false');
    expect(JSON.parse(window.localStorage.getItem(INSPECTOR_SECTIONS_KEY) ?? '{}')).toEqual({ times: false });
    cleanup();
    renderRail();
    expect(screen.getByRole('button', { name: 'Times' })).toHaveAttribute('aria-expanded', 'false');
    cleanup();

    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderRail();
      expect(screen.getByRole('button', { name: 'Times' })).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(screen.getByRole('button', { name: 'Record' }));
      expect(screen.getByRole('button', { name: 'Record' })).toHaveAttribute('aria-expanded', 'true');
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('mounts the hold-reason fact in Outcome and "View all fields" in Record', () => {
    renderRail();
    expect(within(screen.getByTestId('facts-outcome')).getByTestId('awaiting-reason-stub')).toBeInTheDocument();
    const record = openRecord();
    expect(recordProps.sheet).toMatchObject({ caseId: FULL.case_id, open: false });
    fireEvent.click(within(record).getByRole('button', { name: 'View all fields' }));
    expect(recordProps.sheet).toMatchObject({ caseId: FULL.case_id, open: true });
    expect(screen.getByRole('dialog', { name: 'All fields' })).toBeInTheDocument();
  });

  it('opens the Evidence list from the related-cases link', () => {
    const onShowRelated = vi.fn();
    renderRail(FULL, { onShowRelated });
    fireEvent.click(screen.getByTestId('facts-related'));
    expect(onShowRelated).toHaveBeenCalledTimes(1);
  });

  it('reads the AI confidence against the auto-close bar while no person has settled the case', () => {
    const open = {
      ...FULL,
      status: 'investigating',
      verdict: 'FALSE_POSITIVE',
      confidence: 0.82,
      decision_by: 'agent',
      history: [],
    } as unknown as Case;
    renderRail(open);
    const outcome = screen.getByTestId('facts-outcome');
    expect(outcome).toHaveTextContent('AI verdict: False positive (82%)');
    expect(screen.getByTestId('facts-auto-close-bar')).toHaveTextContent('Auto-close bar 90%');
    cleanup();

    // Once an analyst classified the case, the bar no longer reads against it.
    renderRail();
    expect(screen.queryByTestId('facts-auto-close-bar')).toBeNull();
    cleanup();

    // Nor once the case ended on its own: today's bar is not the one it was closed against.
    renderRail({ ...open, status: 'closed' } as unknown as Case);
    expect(screen.getByTestId('facts-outcome')).toHaveTextContent('AI verdict: False positive (82%)');
    expect(screen.queryByTestId('facts-auto-close-bar')).toBeNull();
  });

  it('keeps the risk factors one click away behind a disclosure', () => {
    renderRail({ ...FULL, risk_breakdown: { volume: 40, velocity: 10 } } as unknown as Case);
    const toggle = screen.getByRole('button', { name: 'Show risk factors' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('risk-factor-grid')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide risk factors' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('risk-factor-grid')).toBeInTheDocument();
  });

  it('carries the tags, the campaign, the case number with Ask AI and the Sample mark', () => {
    const demo = { ...FULL, tags: ['demo', 'vpn'] } as unknown as Case;
    renderRail(demo, {
      campaign: { id: 'camp-1', name: 'Password spray wave', case_count: 3 } as never,
      canTag: true,
    });
    const tags = screen.getByTestId('facts-tags');
    expect(within(tags).getByRole('list', { name: 'Tags' })).toHaveTextContent('vpn');
    expect(within(tags).getByRole('button', { name: 'Edit tags' })).toBeInTheDocument();
    expect(screen.getByTestId('facts-campaign')).toHaveTextContent('Part of campaign: Password spray wave');
    expect(openRecord()).toHaveTextContent('SAMPLE');
  });

  it('adds the closed time from the status trail for a case that ended', () => {
    renderRail({
      ...FULL,
      status_history: [{ from_status: 'investigating', to_status: 'closed', by: 'aryan', at: iso(-30 * 60_000) }],
    } as unknown as Case);
    expect(within(screen.getByTestId('facts-times')).getByText('Closed')).toBeInTheDocument();
  });
});

describe('FactsRail: the auto-close review in Outcome (Round 15, D8.4; WP7)', () => {
  const AGENT = {
    ...FULL,
    decision_by: 'agent',
    verdict: 'FALSE_POSITIVE',
    confidence: 0.93,
    history: [{ event: 'decision', status: 'closed', decision_by: 'agent', ts: iso(-3 * 3600_000) }],
    feedback: [],
  } as unknown as Case;
  const state = (over: Record<string, unknown> = {}) =>
    ({ case_id: AGENT.case_id, agent_closed: true, state: 'pending', can_record: true, ...over }) as never;

  it('names who reviewed it and when, and lets the headline carry the agreement', () => {
    const reviewed = {
      ...AGENT,
      feedback: [{ ts: iso(-3600_000), analyst: 't2', assessment: 'disagree', actual_outcome: 'true_positive', origin: 'auto_close_review' }],
      history: [
        ...(AGENT.history as unknown[]),
        { event: 'auto_close_review', review_id: 'acr-1', feedback_ts: iso(-3600_000), analyst: 't2', agrees: false, classification: 'true_positive' },
      ],
    } as unknown as Case;
    renderRail(reviewed, { review: { state: state({ state: 'completed', can_record: false }), bandShown: false } });
    expect(screen.getByTestId('facts-outcome-headline')).toHaveTextContent('Review disagreed: true positive');
    expect(screen.getByTestId('facts-review')).toHaveTextContent(/^Auto-close review by t2 · /);
    // "Overrides the AI" is not repeated beside the AI line: the headline says it.
    expect(screen.getByTestId('facts-outcome')).not.toHaveTextContent('Overrides the AI');
  });

  it('says a sample is waiting only when no band says so, and that an expired one went unreviewed', () => {
    renderRail(AGENT, { review: { state: state(), bandShown: true } });
    expect(screen.queryByTestId('facts-review')).toBeNull();
    cleanup();
    renderRail(AGENT, { review: { state: state(), bandShown: false } });
    expect(screen.getByTestId('facts-review')).toHaveTextContent(
      'Picked at random for auto-close review. Waiting for a person.',
    );
    cleanup();
    renderRail(AGENT, { review: { state: state({ state: 'expired', expires_at: iso(-86_400_000) }), bandShown: false } });
    expect(screen.getByTestId('facts-review')).toHaveTextContent(
      /^Picked at random for auto-close review\. The review expired .+ ago\.$/,
    );
  });

  it('says nothing for an unsampled close or a reopened sample', () => {
    renderRail(AGENT, { review: { state: state({ state: 'none' }), bandShown: false } });
    expect(screen.queryByTestId('facts-review')).toBeNull();
    cleanup();
    renderRail(AGENT, { review: { state: state({ agent_closed: false, can_record: false }), bandShown: false } });
    expect(screen.queryByTestId('facts-review')).toBeNull();
  });
});
