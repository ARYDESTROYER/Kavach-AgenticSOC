/**
 * OverviewPanel: the Brief tab (Round 16, SPEC D8, §4.4 WP03; the Overview before it).
 *
 * The four-lane answer, above the fold: a one-line review note on a pending sample, the
 * runbook's Next step row, then the lanes Evidence (`source`), AI (`ai`), Decision
 * (`code`, or the person who settled it) and People (`analyst`), each linking to its tab,
 * and the folded six-stage story. The lanes never repeat the header's verdict,
 * confidence, risk, status or owner (the one-home rule). The AI lane is the model's own
 * reasoning (G17); the decision text is the code's and appears only in the Decision lane.
 * Every case-derived value renders as plain text (#9); the panel never decides (#3).
 *
 * The inspector's Signal profile (risk and its factors) is pinned here too, as it was.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render as testingRender, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactElement } from 'react';
import { TooltipProvider } from '@/ui/tooltip';

expect.extend(toHaveNoViolations);

vi.mock('@/lib/api', () => ({
  api: {
    listCases: vi.fn().mockResolvedValue({ cases: [] }),
    get: vi.fn().mockResolvedValue({ found: false }),
  },
}));

import { OverviewPanel, evidenceFacts, lastHumanAction, leadSentences, riskFactorBarColor } from '../OverviewPanel';
import { SignalProfile } from '../SignalProfile';
import { REVIEW_BAND_TEXT } from '../review/review-plan';
import type { Case, CaseRationale } from '@/lib/types';
import type { RunbookRun } from '@/lib/types-runbooks';

function render(ui: ReactElement) {
  return testingRender(<TooltipProvider>{ui}</TooltipProvider>);
}

const CASE = {
  case_id: 'c1',
  status: 'open',
  verdict: 'true_positive',
  risk_score: 40,
  confidence: 0.9,
  recommended_action: 'Reset the affected credentials and monitor for re-use.',
  summary: 'Repeated failed logons from 10.0.0.5. Then a success from a new ASN.',
  rule_ids: ['ssh_bruteforce'],
  source_name: 'IBM QRadar SIEM',
  severity_band: 'high',
  severity_source: 'source_asserted',
  decision_by: 'system',
  mitre: ['T1110'],
  evidence: [{ query: 'event.action:login and source.ip:10.0.0.5', summary: 'auth spike observed' }],
  member_event_keys: ['k1', 'k2', 'k3'],
  entity: { type: 'user', value: 'pnair' },
  trigger_reason: { sentence: '5 failed logins in 2 minutes for one user.' },
  risk_breakdown: {
    volume: 40,
    velocity: 10,
    reputation: 0,
    diversity: 0,
    asset_criticality: 0,
    total: 30,
  },
} as unknown as Case;

const RATIONALE = {
  case_id: 'c1',
  reasoning:
    'Five failed logons then a success from a new ASN. The pattern matches credential stuffing. The account has no travel on file. Recommend a reset.',
  decision_rationale: 'No confident close decision; routing to human (fail-safe).',
} as unknown as CaseRationale;

function renderBrief(c: Case = CASE, extra: Partial<ComponentProps<typeof OverviewPanel>> = {}) {
  return render(<OverviewPanel c={c} rationale={RATIONALE} onOpenTab={vi.fn()} {...extra} />);
}

/** The inspector's Signal profile with its risk factors shown (behind a disclosure, D8.4). */
function renderSignalProfile(c: Case = CASE) {
  const view = render(<SignalProfile c={c} triage={null} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show risk factors' }));
  return view;
}

const RUN = {
  run_id: 'run-1',
  status: 'active',
  title: 'Account compromise',
  version: 3,
  attached_at: '2026-11-01T09:00:00Z',
  snapshot: {
    steps: [
      { id: 's1', phase: 'triage', title: 'Confirm the sign-in', kind: 'check', required: true },
      { id: 's2', phase: 'investigate', title: 'Reputation of the sign-in IP', kind: 'lookup', required: true },
    ],
  },
  steps: { s1: { status: 'done' } },
} as unknown as RunbookRun;

describe('OverviewPanel: the Brief (Round 16, D8)', () => {
  it('reads the four lanes in order, each tagged with its provenance and named', () => {
    renderBrief();
    const lanes = screen.getByTestId('brief-lanes');
    const names = Array.from(lanes.querySelectorAll('[data-lane]')).map((lane) => lane.getAttribute('data-lane'));
    expect(names).toEqual(['source', 'ai', 'code', 'analyst']);
    for (const [testId, kind, name] of [
      ['brief-lane-evidence', 'source', 'Evidence'],
      ['brief-lane-ai', 'ai', 'AI'],
      ['brief-lane-decision', 'code', 'Decision'],
      ['brief-lane-people', 'analyst', 'People'],
    ] as const) {
      const lane = screen.getByTestId(testId);
      expect(lane.querySelector(`[data-provenance="${kind}"]`)).not.toBeNull();
      expect(lane.querySelector('dt')?.lastElementChild).toHaveTextContent(name);
    }
    // The measurement point of the case geometry: the Brief's first block.
    expect(screen.getByTestId('case-tab-first')).toContainElement(lanes);
  });

  it('links each lane to the tab that holds it', () => {
    const onOpenTab = vi.fn();
    renderBrief(CASE, { onOpenTab });
    fireEvent.click(screen.getByRole('button', { name: /Open evidence/ }));
    fireEvent.click(screen.getByRole('button', { name: /Open AI investigation/ }));
    fireEvent.click(screen.getByRole('button', { name: /Open response/ }));
    fireEvent.click(screen.getByRole('button', { name: /Open activity/ }));
    expect(onOpenTab.mock.calls.map(([tab]) => tab)).toEqual(['evidence', 'investigation', 'runbook', 'collab']);
    expect(screen.getByRole('button', { name: /Open evidence/ })).toHaveAttribute('aria-keyshortcuts', 'Alt+2');
  });

  it('repeats none of the header facts: no verdict, confidence, risk, status or owner', () => {
    renderBrief({ ...CASE, assignee: 'lee' } as unknown as Case);
    const lanes = screen.getByTestId('brief-lanes');
    expect(lanes).not.toHaveTextContent('90%');
    expect(lanes).not.toHaveTextContent(/True positive/i);
    expect(lanes).not.toHaveTextContent(/Risk 40|40\/100/);
    expect(lanes).not.toHaveTextContent(/\bOpen\b(?! evidence| AI| response| activity)/);
    expect(lanes).not.toHaveTextContent('lee');
  });

  it('gives the Evidence lane the trigger sentence and one quiet line of facts', () => {
    renderBrief();
    expect(screen.getByTestId('brief-trigger')).toHaveTextContent('5 failed logins in 2 minutes for one user.');
    expect(screen.getByTestId('brief-evidence-facts')).toHaveTextContent('3 events · User pnair · IBM QRadar SIEM');
  });

  it('leads the AI lane with the model reasoning in at most three sentences, never the code text (G17)', () => {
    renderBrief();
    const lane = screen.getByTestId('brief-lane-ai');
    expect(screen.getByTestId('brief-summary')).toHaveTextContent(
      'Five failed logons then a success from a new ASN. The pattern matches credential stuffing. The account has no travel on file.',
    );
    expect(screen.getByTestId('brief-summary')).not.toHaveTextContent('Recommend a reset');
    expect(lane).not.toHaveTextContent('routing to human');
    expect(screen.getByTestId('brief-recommended')).toHaveTextContent(`Recommended: ${CASE.recommended_action}`);
  });

  it('falls back to the summary the investigation wrote, and never to the decision text', () => {
    renderBrief(CASE, { rationale: { case_id: 'c1', reasoning: '', decision_rationale: 'CODE TEXT' } as unknown as CaseRationale });
    expect(screen.getByTestId('brief-summary')).toHaveTextContent('Repeated failed logons from 10.0.0.5. Then a success from a new ASN.');
    expect(screen.getByTestId('brief-lane-ai')).not.toHaveTextContent('CODE TEXT');
  });

  it('says a case the AI did not assess was not assessed, with its system summary', () => {
    renderBrief(
      { ...CASE, verdict: undefined, decision_by: undefined, summary: 'Candidate awaiting analysis: queued for the investigator.' } as unknown as Case,
      { rationale: null },
    );
    const lane = screen.getByTestId('brief-lane-ai');
    expect(lane).toHaveTextContent('The AI did not assess this case.');
    expect(lane).toHaveTextContent('Candidate awaiting analysis');
    // Nothing decided yet: the Decision lane says so.
    expect(screen.getByTestId('brief-decision')).toHaveTextContent('No decision yet. The code decides after the AI');
  });

  it('demotes the recommendation on a case that ended to "AI recommendation at triage"', () => {
    renderBrief({ ...CASE, status: 'closed', decision_by: 'analyst' } as unknown as Case);
    expect(screen.queryByTestId('brief-recommended')).toBeNull();
    expect(screen.getByTestId('brief-triage-recommendation')).toHaveTextContent('AI recommendation at triage');
  });

  it('holds the decision, its numbers, the authority sentence once and two disclosures', () => {
    renderBrief(
      { ...CASE, automation_actions: [{ action: 'tag', detail: 'tag=vpn', rule_id: 'r1' }] } as unknown as Case,
      { policy: { enabled: false, min_confidence: 0.99 } },
    );
    const decision = screen.getByTestId('brief-decision');
    expect(within(decision).getByTestId('decision-line')).toHaveTextContent('No confident close decision; routing to human (fail-safe).');
    expect(within(decision).getByTestId('decision-auto-close')).toHaveTextContent('True-positive auto-close is off, so a person decides.');
    expect(screen.getAllByText('Made by code against the auto-close policy, never by the model.')).toHaveLength(1);
    expect(within(decision).getByRole('button', { name: /Policy inputs/ })).toBeInTheDocument();
    expect(within(decision).getByRole('button', { name: 'Automation applied (1)' })).toBeInTheDocument();
  });

  it('gives the People lane the last human action and the runbook progress', () => {
    renderBrief(
      {
        ...CASE,
        history: [{ event: 'analyst_action', action: 'acknowledge', analyst: 'lee', ts: '2026-11-01T09:30:00Z' }],
      } as unknown as Case,
      {
        runbookProgress: { done: 2, not_applicable: 0, total: 9, required_open: 7, blocked: 0, waiting: 0 },
        messageCount: 3,
      },
    );
    const lane = screen.getByTestId('brief-lane-people');
    expect(screen.getByTestId('brief-last-action')).toHaveTextContent(/^Acknowledged by lee, /);
    expect(lane).toHaveTextContent('Runbook 2 of 9 steps, 7 required open · 3 messages');
  });

  it('shows the next required runbook step as one row that opens it on the Response tab', () => {
    const onOpenRunbook = vi.fn();
    renderBrief(CASE, { runbookRun: RUN, onOpenRunbook });
    const row = screen.getByTestId('brief-next-step');
    expect(row).toHaveTextContent('Next step');
    expect(row).toHaveTextContent('Reputation of the sign-in IP');
    fireEvent.click(within(row).getByRole('button', { name: 'Open' }));
    expect(onOpenRunbook).toHaveBeenCalledWith('s2');
  });

  it('shows no Next step row on a case that ended', () => {
    renderBrief({ ...CASE, status: 'closed' } as unknown as Case, { runbookRun: RUN, onOpenRunbook: vi.fn() });
    expect(screen.queryByTestId('brief-next-step')).toBeNull();
  });

  it('starts with the review note on a pending auto-close sample', () => {
    renderBrief(CASE, { reviewPending: true });
    const note = screen.getByTestId('brief-review-note');
    expect(note).toHaveTextContent(REVIEW_BAND_TEXT);
    expect(screen.getByTestId('case-tab-first').firstElementChild).toBe(note);
  });

  it('folds "How this case was built" and asks for the stages when it opens', () => {
    const onBuildStoryOpenChange = vi.fn();
    const { rerender } = render(
      <OverviewPanel c={CASE} buildStory={<p>Stage story</p>} buildStoryOpen={false} onBuildStoryOpenChange={onBuildStoryOpenChange} />,
    );
    expect(screen.queryByText('Stage story')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'How this case was built' }));
    expect(onBuildStoryOpenChange).toHaveBeenCalledWith(true);
    rerender(
      <TooltipProvider>
        <OverviewPanel c={CASE} buildStory={<p>Stage story</p>} buildStoryOpen onBuildStoryOpenChange={onBuildStoryOpenChange} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Stage story')).toBeInTheDocument();
  });

  it('shows an investigation error as a destructive alert', () => {
    renderBrief({ ...CASE, error: 'The model timed out.' } as unknown as Case);
    expect(screen.getByRole('alert')).toHaveTextContent('The model timed out.');
  });

  it('labels every lane in sentence case, without tracked capitals or cards', () => {
    const { container } = renderBrief();
    expect(container.querySelectorAll('.uppercase, .tracking-tight, .tracking-wide')).toHaveLength(0);
    expect(container.querySelector('.rounded-xl.border, [data-overview-surface]')).toBeNull();
  });

  it('has no automated accessibility violations', async () => {
    const { container } = renderBrief(CASE, { runbookRun: RUN, onOpenRunbook: vi.fn(), buildStory: <p>Stage story</p> });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the Brief facts helpers', () => {
  it('evidenceFacts names the events, the entity, the first and last times and the source', () => {
    expect(
      evidenceFacts({
        case_id: 'x',
        member_event_keys: ['a'],
        entity: { type: 'ip', value: '10.0.0.5' },
        first_seen_millis: Date.parse('2026-11-03T04:21:00Z'),
        last_seen_millis: Date.parse('2026-11-03T04:23:00Z'),
        source_name: 'Splunk ES',
      } as unknown as Case),
    ).toEqual(['1 event', 'IP 10.0.0.5', 'first 04:21 UTC', 'last 04:23 UTC', 'Splunk ES']);
    // Two days: each time carries its date.
    expect(
      evidenceFacts({
        case_id: 'x',
        first_seen_millis: Date.parse('2026-11-03T23:59:00Z'),
        last_seen_millis: Date.parse('2026-11-04T00:01:00Z'),
      } as unknown as Case),
    ).toEqual(['first 2026-11-03 23:59 UTC', 'last 2026-11-04 00:01 UTC']);
  });

  it('lastHumanAction reads the newest person entry, never the agent or the code', () => {
    expect(lastHumanAction({ case_id: 'x', history: [] } as unknown as Case)).toBeNull();
    expect(
      lastHumanAction({
        case_id: 'x',
        history: [
          { event: 'analyst_action', action: 'acknowledge', analyst: 'lee' },
          { event: 'decision', status: 'needs_human', decision_by: 'system' },
        ],
      } as unknown as Case),
    ).toBe('Acknowledged by lee');
  });
});

describe('leadSentences', () => {
  it('keeps at most three sentences and never splits a number', () => {
    expect(leadSentences('One. Two! Three? Four.')).toBe('One. Two! Three?');
    expect(leadSentences('Risk rose to 62.5 points. Then it fell.')).toBe('Risk rose to 62.5 points. Then it fell.');
    expect(leadSentences('No terminal punctuation')).toBe('No terminal punctuation');
    expect(leadSentences('')).toBe('');
  });
});

describe('the inspector Signal profile (pinned with the Brief)', () => {
  it('renders honest, text-equivalent risk visuals from existing case data', () => {
    renderSignalProfile();
    const profile = screen.getByTestId('case-signal-profile');

    const risk = within(profile).getByRole('progressbar', { name: 'Risk score: 40/100' });
    expect(risk).toHaveAttribute('aria-valuenow', '40');
    expect(within(profile).queryByRole('progressbar', { name: /Confidence/ })).toBeNull();

    const volume = within(profile).getByRole('progressbar', {
      name: 'Volume risk factor: 40 out of 100',
    });
    expect(volume).toHaveAttribute('aria-valuenow', '40');
    expect(
      within(profile).getByRole('progressbar', {
        name: 'Velocity risk factor: 10 out of 100',
      }),
    ).toHaveAttribute('aria-valuenow', '10');
    expect(within(profile).getByText('Volume')).toBeInTheDocument();
    expect(within(profile).getByText('Reputation')).toBeInTheDocument();
    expect(within(profile).getAllByText('40').length).toBeGreaterThanOrEqual(1);
    expect(within(profile).queryByText('0\u2013100 each')).toBeNull();

    const factorGrid = within(profile).getByTestId('risk-factor-grid');
    expect(factorGrid).toHaveClass('grid-cols-[max-content_minmax(2.5rem,1fr)_2rem]');
    const factorBars = within(profile).getAllByRole('progressbar', {
      name: /risk factor:/i,
    });
    expect(factorBars).toHaveLength(5);
    for (const factorBar of factorBars) {
      expect(factorBar.parentElement).toBe(factorGrid);
    }

    for (const [label, value] of [
      ['Volume', 40],
      ['Velocity', 10],
      ['Reputation', 0],
      ['Diversity', 0],
      ['Asset criticality', 0],
    ] as const) {
      const trigger = within(profile).getByRole('button', {
        name: `Explain ${label} risk factor, recorded ${value} out of 100`,
      });
      expect(trigger).toHaveClass('whitespace-nowrap');
      expect(trigger).not.toHaveClass('break-words');
    }
  });

  it('explains a factor on hover using the recorded score without inventing provider data', async () => {
    const user = userEvent.setup();
    renderSignalProfile();
    await user.hover(
      screen.getByRole('button', {
        name: 'Explain Reputation risk factor, recorded 0 out of 100',
      }),
    );

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('clamped 0\u2013100 enrichment reputation signal');
    expect(tooltip).toHaveTextContent('deterministic breakdown stores Reputation at 0/100');
    expect(tooltip).toHaveTextContent('no provider-level reputation input is retained');
  });

  it('opens factor help on keyboard focus and names the case data behind the value', async () => {
    const user = userEvent.setup();
    renderSignalProfile({
      ...CASE,
      member_event_keys: undefined,
      member_event_ids: ['event-1', 'event-2'],
    } as unknown as Case);

    // The score's explainer comes first (Round 16 WP11), then the disclosure toggle, then
    // the factors it shows.
    await user.tab();
    expect(screen.getByRole('button', { name: /^40\/100\s?, explain$/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Hide risk factors' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: /Explain Volume risk factor/i })).toHaveFocus();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('log-normalized against a 50-event reference');
    // B13: the case's member count is never paired with the Volume factor; it is its own fact.
    expect(tooltip).toHaveTextContent('stores Volume at 40/100');
    expect(tooltip).toHaveTextContent(
      'The case now holds 2 events; the score was computed from the events in its scoring run.',
    );
    expect(tooltip).not.toHaveTextContent('case records 2 correlated events');
  });
});

describe('riskFactorBarColor (#29: shares the ONE palette scoreBand ladder 74/48/22)', () => {
  it('maps a factor score to the same band cut-points as every risk-coloured element', () => {
    expect(riskFactorBarColor(10)).toBe('bg-low'); // <22
    expect(riskFactorBarColor(25)).toBe('bg-medium'); // >=22
    expect(riskFactorBarColor(50)).toBe('bg-high'); // >=48
    expect(riskFactorBarColor(80)).toBe('bg-critical'); // >=74
  });
});
