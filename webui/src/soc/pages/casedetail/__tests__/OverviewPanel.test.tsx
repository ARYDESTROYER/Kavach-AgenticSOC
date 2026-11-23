/**
 * OverviewPanel: the Overview tab (Round 15, SPEC D8.3).
 *
 * The case's brief and nothing the header or the facts rail already shows: the AI summary
 * in two or three sentences (the model's reasoning, never the code's decision text, G17)
 * with its recommended action, "What happened" (why the detection fired and the stage
 * timeline that was the Timeline tab, a section a link can scroll to), key entities, the
 * related cases and the anomaly baseline. Every case-derived value renders as plain text or
 * inside an InlineCode fence (#9); the panel never decides or mutates the case (#3).
 *
 * The facts rail's Signal profile (risk and its factors) is pinned here too, as it was.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render as testingRender, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactElement } from 'react';
import { TooltipProvider } from '@/ui/tooltip';

expect.extend(toHaveNoViolations);

const { listCasesMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn().mockResolvedValue({ cases: [] }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    listCases: listCasesMock,
    get: vi.fn().mockResolvedValue({ found: false }),
  },
}));

import { OverviewPanel, leadSentences, riskFactorBarColor } from '../OverviewPanel';
import { SignalProfile } from '../SignalProfile';
import type { Case, CaseRationale } from '@/lib/types';

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
  mitre: ['T1110'],
  evidence: [{ query: 'event.action:login and source.ip:10.0.0.5', summary: 'auth spike observed' }],
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
  decision_rationale: 'verdict=TRUE_POSITIVE status=escalated decision_by=system risk=40',
} as unknown as CaseRationale;

function renderOverview(c: Case = CASE, extra: Partial<ComponentProps<typeof OverviewPanel>> = {}) {
  return render(<OverviewPanel c={c} rationale={RATIONALE} {...extra} />);
}

/** The rail's Signal profile with its risk factors shown (they sit behind a disclosure, D8.4). */
function renderSignalProfile(c: Case = CASE) {
  const view = render(<SignalProfile c={c} triage={null} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show risk factors' }));
  return view;
}

describe('OverviewPanel: the brief (D8.3)', () => {
  it('reads Summary, What happened, Key entities, in that order, after the runbook card', () => {
    const { container } = renderOverview(CASE, {
      runbookCard: <div data-overview-runbook="">Next step</div>,
      whatHappened: <p>Stage story</p>,
    });
    const panel = container.querySelector('[data-case-panel="overview"]') as HTMLElement;
    expect(panel.firstElementChild).toHaveAttribute('data-overview-runbook');
    const headings = within(panel)
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(['Summary', 'What happened', 'Key entities']);
  });

  it('repeats nothing the header or the facts rail shows', () => {
    renderOverview(CASE, { whatHappened: <p>Stage story</p> });
    // No outcome headline, provenance lanes, decision, inputs or evidence tables.
    for (const gone of [
      'Source says',
      'Agent found',
      'Code decided',
      'Investigation inputs',
      'Evidence checklist',
      'Reproduce investigation',
      'Attack story',
      'Provenance & audit',
      'Likely a true positive',
    ]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    // The authority sentence lives once, on Investigation's Decision.
    expect(screen.queryByText(/made by deterministic code/i)).toBeNull();
    // Severity, rules, source, risk and confidence are the rail's.
    expect(screen.queryByText('ssh_bruteforce')).toBeNull();
    expect(screen.queryByText('IBM QRadar SIEM')).toBeNull();
    expect(screen.queryByText('90%')).toBeNull();
    expect(screen.queryByText(/2 MITRE|MITRE technique/)).toBeNull();
  });

  it('leads with the model reasoning in at most three sentences, tagged AI, never the code text (G17)', () => {
    renderOverview();
    const summary = screen.getByTestId('overview-summary');
    expect(within(summary).getByText('AI')).toBeInTheDocument();
    expect(screen.getByTestId('overview-summary-text')).toHaveTextContent(
      'Five failed logons then a success from a new ASN. The pattern matches credential stuffing. The account has no travel on file.',
    );
    expect(screen.getByTestId('overview-summary-text')).not.toHaveTextContent('Recommend a reset');
    expect(summary).not.toHaveTextContent('verdict=TRUE_POSITIVE');
    expect(within(screen.getByTestId('overview-recommended-action')).getByText(CASE.recommended_action as string)).toBeInTheDocument();
  });

  it('falls back to the summary the investigation wrote, and never to the decision text', () => {
    renderOverview(CASE, { rationale: { case_id: 'c1', reasoning: '', decision_rationale: 'CODE TEXT' } as unknown as CaseRationale });
    expect(screen.getByTestId('overview-summary-text')).toHaveTextContent(
      'Repeated failed logons from 10.0.0.5. Then a success from a new ASN.',
    );
    expect(screen.getByTestId('overview-summary')).not.toHaveTextContent('CODE TEXT');
  });

  it('shows a system summary of a case the AI did not assess, without the AI tag', () => {
    renderOverview(
      { ...CASE, verdict: undefined, summary: 'Candidate awaiting analysis: queued for the investigator.' } as unknown as Case,
      { rationale: null },
    );
    const summary = screen.getByTestId('overview-summary');
    expect(screen.getByTestId('overview-summary-text')).toHaveTextContent('Candidate awaiting analysis');
    expect(within(summary).queryByText('AI')).toBeNull();
  });

  it('says the summary and the recommendation once when they are the same sentence', () => {
    renderOverview(
      { ...CASE, summary: 'Reset the affected credentials and monitor for re-use.' } as unknown as Case,
      { rationale: null },
    );
    expect(screen.getByTestId('overview-summary-and-action')).toHaveTextContent('Summary and recommended action');
    expect(screen.queryByTestId('overview-recommended-action')).toBeNull();
  });

  it('demotes the recommendation on a case that ended to "AI recommendation at triage"', () => {
    renderOverview({ ...CASE, status: 'closed', decision_by: 'analyst' } as unknown as Case);
    expect(screen.queryByTestId('overview-recommended-action')).toBeNull();
    expect(screen.getByTestId('overview-triage-recommendation')).toHaveTextContent('AI recommendation at triage');
  });

  it('shows an investigation error as a destructive alert', () => {
    renderOverview({ ...CASE, error: 'The model timed out.' } as unknown as Case);
    expect(screen.getByRole('alert')).toHaveTextContent('The model timed out.');
  });
});

describe('OverviewPanel: What happened (the retired Timeline tab)', () => {
  it('is a section a link can scroll to, with why the detection fired and the stage story', () => {
    renderOverview(
      { ...CASE, trigger_reason: { sentence: '5 failed logins in 2 minutes for one user.' } } as unknown as Case,
      { whatHappened: <p>Stage story</p> },
    );
    const section = screen.getByTestId('overview-what-happened');
    expect(section).toHaveAttribute('data-section', 'what-happened');
    const heading = within(section).getByRole('heading', { name: 'What happened' });
    expect(heading).toHaveAttribute('data-section-title');
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('overview-trigger')).toHaveTextContent('Why it fired: 5 failed logins in 2 minutes for one user.');
    expect(within(section).getByText('Stage story')).toBeInTheDocument();
  });
});

describe('OverviewPanel: key entities', () => {
  it('shows the primary entity with its scope, type, copy and Ask AI, and its enrichment', () => {
    renderOverview({
      ...CASE,
      entity: { type: 'ip', value: '198.51.100.7' },
      enrichment: { country: 'NL', asn: 'AS64500', reputation_score: 87 },
    } as unknown as Case);
    const section = screen.getByTestId('overview-entities');
    expect(within(section).getByText('198.51.100.7')).toBeInTheDocument();
    expect(within(section).getByText('External')).toBeInTheDocument();
    expect(within(section).getByText('IP')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Copy indicator' })).toBeInTheDocument();
    expect(within(section).getByText('NL')).toBeInTheDocument();
    expect(within(section).getByText('AS64500')).toHaveClass('font-mono');
    expect(within(section).getByText('87')).toBeInTheDocument();
  });

  it('says when no primary entity was recorded', () => {
    renderOverview();
    expect(screen.getByText('No primary entity was recorded for this case.')).toBeInTheDocument();
  });
});

describe('OverviewPanel: related cases', () => {
  it('lists related cases in a section the facts rail links to, and never merges them', async () => {
    listCasesMock.mockResolvedValueOnce({ cases: [{ case_id: 'c2', title: 'Same user, other source' }] });
    const onNavigate = vi.fn();
    renderOverview(
      { ...CASE, related_case_ids: ['c2', 'c1'], source_breakdown: { 'demo-splunk': 3 } } as unknown as Case,
      { onNavigate },
    );
    const section = screen.getByTestId('overview-related');
    expect(section).toHaveAttribute('data-section', 'related-cases');
    expect(section).toHaveTextContent(/never merged/i);
    const link = await within(section).findByRole('button', { name: 'Same user, other source' });
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith('case_manager', { caseId: 'c2' });
    expect(within(section).getByText('demo-splunk')).toBeInTheDocument();
  });

  it('is not rendered without cross-source data', () => {
    renderOverview();
    expect(screen.queryByTestId('overview-related')).toBeNull();
  });
});

describe('OverviewPanel: the visual dialect', () => {
  it('labels every section in sentence case, without tracked capitals, cards or icon headings', async () => {
    listCasesMock.mockClear();
    const { container } = renderOverview(
      { ...CASE, entity: { type: 'ip', value: '10.0.0.5' }, related_case_ids: ['c2'] } as unknown as Case,
      { whatHappened: <p>Stage story</p> },
    );
    // Let the related cases' best-effort title read settle inside act.
    await waitFor(() => expect(listCasesMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelectorAll('.uppercase, .tracking-tight, .tracking-wide')).toHaveLength(0);
    for (const heading of screen.getAllByRole('heading', { level: 2 })) {
      expect(heading.querySelector('svg')).toBeNull();
    }
    // No card frame inside the tab (D8.5).
    expect(container.querySelector('.rounded-xl.border, [data-overview-surface]')).toBeNull();
  });

  it('has no automated accessibility violations', async () => {
    const { container } = renderOverview(
      { ...CASE, entity: { type: 'ip', value: '10.0.0.5' }, trigger_reason: { sentence: 'Five failures.' } } as unknown as Case,
      { whatHappened: <p>Stage story</p> },
    );
    expect(await axe(container)).toHaveNoViolations();
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

describe('the facts rail Signal profile (pinned with the Overview)', () => {
  // Round 12 (CM-6): the signal profile moved from the Overview aside to the facts rail,
  // where it is the ONE home for risk; Round 15 (D8.4) reads the AI confidence in the
  // Outcome section's AI line instead (FactsRail.test.tsx). These pin the risk visuals.
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
    // The visible text equivalents make the visuals useful without colour.
    expect(within(profile).getByText('Volume')).toBeInTheDocument();
    expect(within(profile).getByText('Reputation')).toBeInTheDocument();
    expect(within(profile).getAllByText('40').length).toBeGreaterThanOrEqual(1);
    expect(within(profile).queryByText('0\u2013100 each')).toBeNull();

    const factorGrid = within(profile).getByTestId('risk-factor-grid');
    expect(factorGrid).toHaveClass(
      'grid-cols-[max-content_minmax(2.5rem,1fr)_2rem]',
    );
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
    expect(tooltip).toHaveTextContent(
      'deterministic breakdown stores Reputation at 0/100',
    );
    expect(tooltip).toHaveTextContent('no provider-level reputation input is retained');
  });

  it('opens factor help on keyboard focus and names the case data behind the value', async () => {
    const user = userEvent.setup();
    renderSignalProfile({
      ...CASE,
      member_event_ids: ['event-1', 'event-2'],
    } as unknown as Case);

    // The disclosure toggle comes first, then the factors it shows.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Hide risk factors' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: /Explain Volume risk factor/i })).toHaveFocus();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('log-normalized against a 50-event reference');
    expect(tooltip).toHaveTextContent('case records 2 correlated events');
    expect(tooltip).toHaveTextContent('stored Volume factor is 40/100');
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
