/**
 * OverviewPanel — the task 7c redesign (clean, scannable case briefing).
 *
 * The overview reads top-to-bottom as: a DECISION BRIEF hero (verdict headline +
 * summary + chip row + recommended action + auto-close note), a 3-column PROVENANCE
 * row (SOURCE SAYS / AGENT FOUND / CODE DECIDED), an ENTITY row (primary entity / attack
 * story / relationship), an
 * EVIDENCE row (checklist + reproduce), and collapsibles (related / provenance & audit).
 *
 * Provenance stays obvious: SIEM facts, AI judgement, and deterministic code are told
 * apart by <ProvenanceTag>. Every case-derived value renders as plain text / CodeBlock
 * (#9); the panel never decides or mutates the case (#3). The default sheet keeps its
 * pinned DecisionCard; Case Manager consolidates the same projection into CODE DECIDED.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render as testingRender, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { TooltipProvider } from '@/ui/tooltip';

expect.extend(toHaveNoViolations);

vi.mock('@/lib/api', () => ({
  api: {
    listCases: vi.fn().mockResolvedValue({ cases: [] }),
    get: vi.fn().mockResolvedValue({ found: false }),
  },
}));

import { OverviewPanel, riskFactorBarColor } from '../OverviewPanel';
import { SignalProfile } from '../SignalProfile';
import type { Case } from '@/lib/types';

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

function renderOverview(c: Case) {
  return render(<OverviewPanel c={c} fpPolicy={null} triage={null} triageLoading={false} />);
}

function renderSignalProfile(c: Case = CASE) {
  return render(<SignalProfile c={c} triage={null} />);
}

function renderCaseManager(c: Case = CASE) {
  return render(
    <OverviewPanel
      c={c}
      fpPolicy={null}
      triage={null}
      triageLoading={false}
      presentation="case-manager"
    />,
  );
}

describe('OverviewPanel — decision brief (task 7c)', () => {
  it('leads with a verdict headline, one-sentence summary, and the recommended action', () => {
    renderOverview(CASE);
    expect(screen.getByText('Decision brief')).toBeInTheDocument();
    // Verdict → a calm human headline (true_positive → "Likely a true positive").
    expect(screen.getByText('Likely a true positive')).toBeInTheDocument();
    // One-sentence summary (first sentence only).
    expect(screen.getByText(/Repeated failed logons from 10\.0\.0\.5\./)).toBeInTheDocument();
    // Recommended action text is surfaced.
    expect(screen.getByText('Recommended action')).toBeInTheDocument();
    expect(
      screen.getByText(/Reset the affected credentials and monitor for re-use\./),
    ).toBeInTheDocument();
  });

  it('shows the compact chip row (risk N/100, confidence %)', () => {
    renderOverview(CASE);
    // Risk chip "40/100" appears in the brief (also mirrored by the DecisionCard).
    expect(screen.getAllByText('40/100').length).toBeGreaterThanOrEqual(1);
    // Confidence "90%" is surfaced.
    expect(screen.getAllByText('90%').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the auto-close note (a quiet inline note, never a role="alert")', () => {
    render(
      <OverviewPanel
        c={{ ...CASE, verdict: 'false_positive' } as unknown as Case}
        fpPolicy={{ enabled: false, min_confidence: 0.8 }}
        triage={null}
        triageLoading={false}
      />,
    );
    expect(screen.getByText('False-positive auto-close is disabled')).toBeInTheDocument();
    expect(screen.queryByText(/Auto-close policy/)).toBeNull();
    expect(screen.queryByText(/this case was held/i)).toBeNull();
    // No error alert (c.error unset) — the auto-close note is not an <Alert>.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['true_positive', 'needs_human'])(
    'does not show a disabled false-positive policy note for a %s verdict',
    (verdict) => {
      render(
        <OverviewPanel
          c={{ ...CASE, verdict } as unknown as Case}
          fpPolicy={{ enabled: false, min_confidence: 0.8 }}
          triage={null}
          triageLoading={false}
        />,
      );
      expect(screen.queryByText('False-positive auto-close is disabled')).toBeNull();
    },
  );

  it.each([
    {
      label: 'an active false positive',
      status: 'open',
      decisionBy: 'agent',
      expected: true,
    },
    {
      label: 'a needs-human case',
      status: 'needs_human',
      decisionBy: 'system',
      expected: true,
    },
    {
      // Round 12 (D15): once a PERSON resolved it, the auto-close policy is irrelevant to
      // this case, so its note is hidden rather than implying the policy was in play.
      label: 'a manually resolved false positive',
      status: 'resolved',
      decisionBy: 'analyst',
      expected: false,
    },
    {
      label: 'an AI-resolved false positive',
      status: 'resolved',
      decisionBy: 'agent',
      expected: false,
    },
    {
      label: 'an AI-closed false positive',
      status: 'closed',
      decisionBy: 'agent',
      expected: false,
    },
  ])(
    'shows the disabled-policy note only when applicable for $label',
    ({ status, decisionBy, expected }) => {
      render(
        <OverviewPanel
          c={{
            ...CASE,
            verdict: 'false_positive',
            status,
            decision_by: decisionBy,
          } as unknown as Case}
          fpPolicy={{ enabled: false, min_confidence: 0.8 }}
          triage={null}
          triageLoading={false}
        />,
      );

      const note = screen.queryByText('False-positive auto-close is disabled');
      if (expected) expect(note).toBeInTheDocument();
      else {
        expect(note).toBeNull();
        if (decisionBy === 'agent') expect(screen.getByText('Auto-closed by AI')).toBeInTheDocument();
        else expect(screen.queryByText('Auto-closed by AI')).toBeNull();
      }
    },
  );

  it('does not repeat an identical needs-human verdict and lifecycle status', () => {
    renderOverview({ ...CASE, verdict: 'needs_human', status: 'needs_human' } as unknown as Case);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Needs human review$/);
    expect(screen.queryByText('Needs human review — needs human review')).toBeNull();
  });

  it('keeps a distinct lifecycle result in the decision headline', () => {
    renderOverview({ ...CASE, verdict: 'true_positive', status: 'escalated' } as unknown as Case);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /^Likely a true positive — escalated$/,
    );
  });

  it('renders the legacy escalation flag only as Escalated, never as a numbered tier', () => {
    renderOverview({ ...CASE, status: 'open', escalation_level: 3 } as unknown as Case);
    expect(screen.getByText('Escalated')).toBeInTheDocument();
    expect(screen.queryByText(/escalation\s+L3|tier[- ]?3/i)).toBeNull();
  });

  it('does not repeat Escalated when lifecycle status already communicates it', () => {
    renderCaseManager({
      ...CASE,
      status: 'escalated',
      escalation_level: 3,
    } as unknown as Case);
    // Round 12: the sticky header meta row carries the status; the outcome band names it
    // at most once (here only inside the headline, "… — escalated").
    expect(
      within(screen.getByTestId('case-manager-decision-summary')).queryAllByText('Escalated').length,
    ).toBeLessThanOrEqual(1);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/escalated$/);
  });
});

describe('OverviewPanel — provenance row (source vs. agent vs. code)', () => {
  it('renders the three provenance columns, each with its provenance tag', () => {
    renderOverview(CASE);
    expect(screen.getByText('Source says')).toBeInTheDocument();
    expect(screen.getByText('Agent found')).toBeInTheDocument();
    expect(screen.getByText('Code decided')).toBeInTheDocument();
    // SOURCE header = 1 SIEM tag; AGENT header + verdict + confidence = 3 AI tags;
    // CODE header = 1 Code tag. (No source-asserted severity in the base case.)
    expect(screen.getAllByText('SIEM')).toHaveLength(1);
    expect(screen.getAllByText('AI')).toHaveLength(3);
    expect(screen.getAllByText('Code')).toHaveLength(1);
  });

  it('surfaces a source-asserted severity with its SIEM tag under "Source says"', () => {
    renderOverview({
      ...CASE,
      severity_band: 'high',
      severity_source: 'source_asserted',
    } as unknown as Case);
    expect(screen.getByText(/The source rated this alert High severity\./)).toBeInTheDocument();
    // Header SIEM tag + the per-severity SIEM tag = two.
    expect(screen.getAllByText('SIEM')).toHaveLength(2);
  });

  it('shows the delta cue when the source severity and our risk band DISAGREE', () => {
    // Source says High; risk 40 lands in the Medium band → they disagree.
    renderOverview({
      ...CASE,
      risk_score: 40,
      severity_band: 'high',
      severity_source: 'source_asserted',
    } as unknown as Case);
    const delta = screen.getByTestId('source-assessment-delta');
    expect(delta.textContent).toContain('High');
    expect(delta.textContent).toContain('Medium');
  });

  it('hides the delta cue when the source severity and our risk band AGREE', () => {
    // Source says High; risk 50 also lands in the High band → no delta.
    renderOverview({
      ...CASE,
      risk_score: 50,
      severity_band: 'high',
      severity_source: 'source_asserted',
    } as unknown as Case);
    expect(screen.queryByTestId('source-assessment-delta')).toBeNull();
  });

  it('never shows the delta cue OR a "Reported severity" row for a DERIVED severity', () => {
    renderOverview({
      ...CASE,
      risk_score: 40,
      severity_band: 'high',
      severity_source: 'derived',
    } as unknown as Case);
    expect(screen.queryByTestId('source-assessment-delta')).toBeNull();
    expect(screen.queryByText('Reported severity')).toBeNull();
  });

  it('shows the "Auto-closed by AI" marker (on the pinned DecisionCard) only when the AI closed it (#11)', () => {
    // Open case decided by the pipeline → NOT auto-closed → no marker.
    renderOverview(CASE);
    expect(screen.queryByText('Auto-closed by AI')).toBeNull();

    // Terminal status + decision_by === 'agent' → the AI auto-closed it.
    renderOverview({ ...CASE, status: 'closed', decision_by: 'agent' } as unknown as Case);
    expect(screen.getByText('Auto-closed by AI')).toBeInTheDocument();
  });
});

describe('OverviewPanel — embedded Case Manager composition', () => {
  it('consolidates the repeated decision projection into one compact brief and authority lane', () => {
    const { container } = renderCaseManager({
      ...CASE,
      verdict: 'TRUE_POSITIVE',
      status: 'escalated',
      impact_band: 'low',
      priority_level: 'p4',
      disposition: 'undetermined',
      decision_by: 'system',
    } as unknown as Case);

    const panel = container.querySelector(
      '[data-case-panel="overview"][data-presentation="case-manager"]',
    );
    expect(panel).toBeInTheDocument();
    expect(screen.queryByTestId('decision-card')).toBeNull();
    expect(within(panel as HTMLElement).queryByText('Decision brief')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 })).toHaveClass(
      'text-lg',
      'text-foreground',
    );

    // The embedded workspace follows the dashboard's single-canvas composition:
    // one flat summary, whitespace-led lanes, and one hairline between major sections.
    expect(screen.getByTestId('case-manager-decision-summary')).toHaveClass(
      'rounded-none',
      'border-0',
      'bg-transparent',
      'px-0',
      'py-1',
    );
    expect(screen.getByTestId('case-manager-decision-summary')).not.toHaveClass('border-b');
    expect(screen.getByTestId('case-manager-decision-summary')).not.toHaveClass('border-l-2');
    const majorSections = panel?.querySelectorAll('[data-case-manager-section]');
    expect(majorSections).toHaveLength(3);
    majorSections?.forEach((section) => {
      expect(section).toHaveClass('border-t', 'border-border/60', 'pt-6');
    });
    const flatColumns = panel?.querySelectorAll('[data-overview-surface="flat-column"]');
    // Round 12: the Entity-relationship column's facts moved to the rail's Primary entity
    // block ("Seen by <rule> on <surface>"), leaving seven flat columns.
    expect(flatColumns).toHaveLength(7);
    flatColumns?.forEach((column) => {
      expect(column).toHaveClass('rounded-none', 'border-0', 'bg-transparent', 'p-0');
    });

    // Case Manager labels are type-led; they do not each grow another horizontal rule.
    within(panel as HTMLElement)
      .getAllByTestId('overview-section-label')
      .forEach((label) => {
        expect(label.parentElement?.querySelector(':scope > span[aria-hidden="true"]')).toBeNull();
      });

    // All unique facts from the removed duplicate card remain in the compact lanes.
    expect(screen.getByText('Deterministic decision authority')).toBeInTheDocument();
    expect(screen.getByText('case_manager')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
    // The authority sentence is said ONCE, in the outcome band (it used to repeat in four
    // places: recommended action, Code decided, the inputs footnote and the decision band).
    expect(screen.getByTestId('overview-authority')).toHaveTextContent(
      /close or escalate decision is made by deterministic code/i,
    );
    expect(screen.getAllByText(/made by deterministic code/i)).toHaveLength(1);

    // Round 12 (CM-6): impact, priority, risk and confidence each have ONE home — the
    // facts rail (see FactsRail.test.tsx) — so the Overview no longer repeats them.
    expect(within(panel as HTMLElement).queryByText('Impact')).toBeNull();
    expect(within(panel as HTMLElement).queryByText('Priority')).toBeNull();
    expect(within(panel as HTMLElement).queryByTestId('case-signal-profile')).toBeNull();
  });

  it('keeps the embedded decision heading neutral, and below the case title, across verdict outcomes', () => {
    const { unmount } = renderCaseManager({
      ...CASE,
      verdict: 'false_positive',
      status: 'resolved',
    } as unknown as Case);
    expect(screen.getByRole('heading', { level: 2 })).toHaveClass(
      'text-lg',
      'text-foreground',
    );
    expect(screen.getByRole('heading', { level: 2 })).not.toHaveClass('text-info-text');
    unmount();

    renderCaseManager({ ...CASE, verdict: 'needs_human', status: 'needs_human' } as unknown as Case);
    expect(screen.getByRole('heading', { level: 2 })).toHaveClass(
      'text-lg',
      'text-foreground',
    );
    expect(screen.getByRole('heading', { level: 2 })).not.toHaveClass('text-warning-text');
  });

  // Round 12 (CM-6): the signal profile moved from the Overview aside to the facts rail,
  // where it is the ONE home for risk and confidence. These pin the same behaviour there.
  it('renders honest, text-equivalent risk and confidence visuals from existing case data', () => {
    renderSignalProfile();
    const profile = screen.getByRole('region', { name: 'Case signal profile' });
    expect(profile).toHaveAttribute('data-testid', 'case-signal-profile');

    const risk = within(profile).getByRole('progressbar', { name: 'Risk score: 40/100' });
    expect(risk).toHaveAttribute('aria-valuenow', '40');
    const confidence = within(profile).getByRole('progressbar', { name: 'Confidence: 90%' });
    expect(confidence).toHaveAttribute('aria-valuenow', '90');

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
    expect(within(profile).queryByText('0–100 each')).toBeNull();

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
    expect(tooltip).toHaveTextContent('clamped 0–100 enrichment reputation signal');
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

    await user.tab();
    expect(screen.getByRole('button', { name: /Explain Volume risk factor/i })).toHaveFocus();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('log-normalized against a 50-event reference');
    expect(tooltip).toHaveTextContent('case records 2 correlated events');
    expect(tooltip).toHaveTextContent('stored Volume factor is 40/100');
  });

  it('keeps the legacy default presentation and its pinned DecisionCard unchanged', () => {
    const { container } = renderOverview(CASE);
    expect(screen.getByTestId('decision-card')).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Case signal profile' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2 })).toHaveClass(
      'text-2xl',
      'text-foreground',
    );
    expect(screen.queryByTestId('case-manager-decision-summary')).toBeNull();
    expect(container.querySelector('[data-overview-surface]')).toBeNull();
  });

  it('labels the embedded overview in sentence case, without tracked capitals', () => {
    const { container } = renderCaseManager({
      ...CASE,
      entity: { type: 'ip', value: '10.0.0.5' },
      severity_band: 'high',
      severity_source: 'source_asserted',
      rule_ids: ['demo_rule'],
      source_name: 'IBM QRadar SIEM',
      trigger_reason: { sentence: 'Five failed logons in a minute.' },
      enrichment: { country: 'US', asn: 'AS64500' },
      decision_by: 'system',
    } as unknown as Case);
    const panel = container.querySelector(
      '[data-case-panel="overview"][data-presentation="case-manager"]',
    ) as HTMLElement;

    // No element in the Case Manager overview uses CSS capitals or wide tracking.
    const tracked = Array.from(panel.querySelectorAll('*')).filter((el) =>
      /(^|\s)(uppercase|tracking-wide|tracking-wider|tracking-widest|tracking-\[[^\]]*\])(\s|$)/.test(
        el.getAttribute('class') || '',
      ),
    );
    expect(tracked).toEqual([]);

    // Section and column titles read in the foreground; field labels are quiet captions.
    within(panel)
      .getAllByTestId('overview-section-label')
      .forEach((label) => expect(label).toHaveClass('text-sm', 'font-semibold', 'text-foreground'));
    for (const title of ['Source says', 'Agent found', 'Code decided']) {
      expect(within(panel).getByRole('heading', { level: 3, name: title })).toHaveClass(
        'text-sm',
        'font-semibold',
        'text-foreground',
      );
    }
    // Impact, priority, the risk factors and the risk/confidence meters now live once in
    // the facts rail (Round 12, CM-6); the overview keeps its own labels sentence case.
    for (const label of [
      'Reported severity',
      'Detection rule',
      'Why it fired',
      'Source',
      'Authority',
      'Country',
      'ASN',
    ]) {
      expect(within(panel).getByText(label)).toHaveClass(
        'text-xs',
        'font-medium',
        'text-muted-foreground',
      );
    }

    // A product/source NAME reads in the sans face; true identifiers stay mono.
    for (const name of within(panel).getAllByText('IBM QRadar SIEM')) {
      expect(name).not.toHaveClass('font-mono');
    }
    expect(within(panel).getByText('US')).not.toHaveClass('font-mono');
    expect(within(panel).getByText('AS64500')).toHaveClass('font-mono');
    // An acronym entity type is not humanized into "Ip".
    expect(within(panel).queryByText('Ip')).toBeNull();
    expect(within(panel).getAllByText('IP').length).toBeGreaterThanOrEqual(1);
  });

  it('has no automated accessibility violations in the embedded overview', async () => {
    const { container } = renderCaseManager({
      ...CASE,
      entity: { type: 'ip', value: '10.0.0.5' },
      severity_band: 'high',
      severity_source: 'source_asserted',
      mitre: ['T1110'],
    } as unknown as Case);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('OverviewPanel — detection-rule chip wraps instead of overflowing (bug #2)', () => {
  // The same rule-id string is also echoed (read-only) in the mini attack-story
  // step and the entity-relationship "Detection" value, so `getByText` alone is
  // ambiguous — disambiguate to the actual chip via its `max-w-full` class,
  // which is unique to the Badge fixed here (see OverviewPanel.tsx, the
  // rule-id Badge in the "Detection rule(s)" block).
  function getRuleChip(text: string) {
    const matches = screen.getAllByText(text);
    const chip = matches.find((el) => el.className.includes('max-w-full'));
    expect(chip).toBeDefined();
    return chip as HTMLElement;
  }

  it('renders a long detection-rule name WITHOUT forcing whitespace-nowrap (it must wrap)', () => {
    renderOverview({
      ...CASE,
      rule_ids: ['Moodle: Grading Interface Access from Non-Campus or Foreign IP'],
    } as unknown as Case);
    const chip = getRuleChip('Moodle: Grading Interface Access from Non-Campus or Foreign IP');
    // The Badge's default `whitespace-nowrap` must be overridden — this is the
    // exact regression bug #2 fixes (a long rule name overflowing the card).
    expect(chip).not.toHaveClass('whitespace-nowrap');
    expect(chip).toHaveClass('whitespace-normal');
    // Breaks at spaces first; never `break-all`, which split readable names mid-word.
    expect(chip).toHaveClass('[overflow-wrap:anywhere]');
    expect(chip).not.toHaveClass('break-all');
  });

  it('still renders a short detection-rule id as a normal single-line chip (no regression)', () => {
    renderOverview({ ...CASE, rule_ids: ['T1078.004'] } as unknown as Case);
    const chip = getRuleChip('T1078.004');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveClass('whitespace-normal');
  });

  it('wraps a SPACE-LESS/hyphen-less long rule id (no soft-wrap points) via min-w-0 + overflow-wrap:anywhere, not just break-words', () => {
    // `break-words` (overflow-wrap: break-word) only wraps at existing soft-wrap
    // opportunities (spaces/hyphens) and never lowers min-content, so an id like this
    // keeps forcing the card wider UNLESS the item itself also has `min-w-0` and uses
    // `overflow-wrap: anywhere`, which may break inside the word AND reduces the item's
    // min-content contribution per spec — without `break-all`'s mid-word splits of
    // names that do have spaces.
    const longId = 'Trojan_Generic_Suspicious_PowerShell_EncodedCommand_Execution_Detected';
    renderOverview({ ...CASE, rule_ids: [longId] } as unknown as Case);
    const chip = getRuleChip(longId);
    expect(chip).toHaveClass('min-w-0');
    expect(chip).toHaveClass('[overflow-wrap:anywhere]');
    expect(chip).not.toHaveClass('whitespace-nowrap');
    expect(chip).not.toHaveClass('break-words');
  });

  it('wraps multiple long rule ids independently', () => {
    renderOverview({
      ...CASE,
      rule_ids: [
        'Moodle: Grading Interface Access from Non-Campus or Foreign IP',
        'Excessive Failed Logon Attempts Against a Single Account from Multiple Source IPs',
      ],
    } as unknown as Case);
    expect(
      getRuleChip('Moodle: Grading Interface Access from Non-Campus or Foreign IP'),
    ).not.toHaveClass('whitespace-nowrap');
    expect(
      getRuleChip(
        'Excessive Failed Logon Attempts Against a Single Account from Multiple Source IPs',
      ),
    ).not.toHaveClass('whitespace-nowrap');
  });
});

describe('OverviewPanel — entity, story, evidence, reproduce (task 7c)', () => {
  it('renders the primary entity, attack story, and entity-relationship cards', () => {
    renderOverview({
      ...CASE,
      entity: { type: 'ip', value: '10.0.0.5' },
    } as unknown as Case);
    expect(screen.getByText('Primary entity')).toBeInTheDocument();
    // The entity value renders inside an InlineCode fence (#9) + the relationship flow.
    expect(screen.getAllByText('10.0.0.5').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Attack story')).toBeInTheDocument();
    expect(screen.getByText('Agent searched the logs')).toBeInTheDocument();
    expect(screen.getByText('Entity relationship')).toBeInTheDocument();
  });

  it('renders the evidence checklist + a reproduce panel labelled "Search query" (not "Command Line")', () => {
    renderOverview(CASE);
    expect(screen.getByText('Evidence checklist')).toBeInTheDocument();
    // One positive finding row → a "Found" result.
    expect(screen.getByText('Found')).toBeInTheDocument();
    // The read-only query is a SEARCH query, never a shell "Command Line".
    expect(screen.getByText('Reproduce investigation')).toBeInTheDocument();
    expect(screen.getByText('Search query')).toBeInTheDocument();
    expect(screen.queryByText('Command Line')).toBeNull();
  });

  it('folds the lower-value sections into a "Provenance & audit" disclosure', () => {
    renderOverview(CASE);
    expect(screen.getByText('Provenance & audit')).toBeInTheDocument();
    // No cross-source linkage → the "Related cases" disclosure is not rendered.
    expect(screen.queryByText('Related cases')).toBeNull();
  });

  it('shows the immutable case-creation build or an honest unavailable state', async () => {
    const { rerender } = renderOverview({
      ...CASE,
      app_version: '0.1.13',
      build_sha: 'abcdef1234567890',
    } as unknown as Case);
    await userEvent.click(screen.getByRole('button', { name: /Provenance & audit/i }));
    expect(screen.getByText('Creation build v0.1.13 · abcdef123456')).toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <OverviewPanel c={CASE} fpPolicy={null} triage={null} triageLoading={false} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Creation build provenance unavailable')).toBeInTheDocument();
  });
});

describe('OverviewPanel — MITRE summary', () => {
  it('surfaces a compact MITRE finding that points at the Threat context tab', () => {
    renderOverview({ ...CASE, mitre: ['T1110', 'T1078'] } as unknown as Case);
    // "2 MITRE techniques mapped" appears in BOTH the agent-found bullet and the mini
    // attack-story step — so match all, then pin the tab pointer (unique to the bullet).
    expect(screen.getAllByText(/2 MITRE techniques mapped/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Threat context tab/i)).toBeInTheDocument();
  });
});

describe('riskFactorBarColor (#29 — shares the ONE palette scoreBand ladder 74/48/22)', () => {
  it('maps a factor score to the same band cut-points as every risk-coloured element', () => {
    expect(riskFactorBarColor(10)).toBe('bg-low'); // <22
    expect(riskFactorBarColor(25)).toBe('bg-medium'); // >=22
    expect(riskFactorBarColor(50)).toBe('bg-high'); // >=48
    expect(riskFactorBarColor(80)).toBe('bg-critical'); // >=74
  });
});

describe('OverviewPanel — the case outcome (Round 12, D15)', () => {
  const closedAsFp = {
    ...CASE,
    verdict: 'NEEDS_HUMAN',
    confidence: 0.75,
    status: 'closed',
    decision_by: 'analyst',
    disposition: 'false_positive',
    recommended_action: 'Benign baseline activity; no action required.',
    history: [
      {
        event: 'analyst_action',
        action: 'close',
        analyst: 'aryan',
        ts: '2026-10-09T10:00:00Z',
        classified_disposition: 'false_positive',
      },
    ],
  } as unknown as Case;

  it('the analyst bug: a NEEDS_HUMAN case closed as FP leads with the analyst outcome', () => {
    renderCaseManager(closedAsFp);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent(/^Closed as false positive$/);
    expect(heading).not.toHaveTextContent(/needs human/i);
    expect(screen.getByTestId('overview-ai-line')).toHaveTextContent('AI verdict: Needs human review (75%)');
    // "Code decided" becomes "Analyst resolved" — the code did not close this case.
    expect(screen.getByRole('heading', { level: 3, name: 'Analyst resolved' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: 'Code decided' })).toBeNull();
    expect(screen.getByTestId('overview-authority')).toHaveTextContent(/closed by an analyst/i);
    // The authority sentence is said ONCE; the lane keeps the facts behind it.
    expect(screen.getAllByText(/the deterministic policy did not close this case/i)).toHaveLength(1);
    const lane = screen.getByTestId('overview-analyst-lane');
    expect(within(lane).getByText('False positive')).toBeInTheDocument();
    expect(within(lane).getByText('aryan')).toBeInTheDocument();
    expect(within(lane).getByText('Not applied')).toBeInTheDocument();
    // The AI's triage recommendation is kept but demoted, never the next step.
    expect(screen.queryByRole('heading', { name: 'Recommended action' })).toBeNull();
    expect(screen.getByTestId('overview-triage-recommendation')).toHaveTextContent(
      'AI recommendation at triage',
    );
    // No auto-close note on a human close.
    expect(screen.queryByText(/auto-close/i)).toBeNull();
  });

  it('an undeclared analyst close says the outcome was not recorded', () => {
    renderCaseManager({
      ...closedAsFp,
      verdict: 'TRUE_POSITIVE',
      disposition: 'true_positive',
      history: [{ event: 'analyst_action', action: 'close', analyst: 'aryan', ts: '2026-10-09T10:00:00Z' }],
    } as unknown as Case);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /^Closed by analyst: outcome not recorded$/,
    );
  });

  it('offers an inline Set disposition beside an unrecorded human close, and only there', () => {
    const onSetDisposition = vi.fn();
    const unrecorded = {
      ...closedAsFp,
      verdict: 'TRUE_POSITIVE',
      disposition: 'true_positive',
      history: [{ event: 'analyst_action', action: 'close', analyst: 'aryan', ts: '2026-10-09T10:00:00Z' }],
    } as unknown as Case;
    const { unmount } = render(
      <OverviewPanel
        c={unrecorded}
        fpPolicy={null}
        triage={null}
        triageLoading={false}
        presentation="case-manager"
        onSetDisposition={onSetDisposition}
      />,
    );
    const button = screen.getByTestId('overview-set-disposition');
    fireEvent.click(button);
    expect(onSetDisposition).toHaveBeenCalledWith(button);
    unmount();
    // A classified close needs no prompt.
    render(
      <OverviewPanel
        c={closedAsFp}
        fpPolicy={null}
        triage={null}
        triageLoading={false}
        presentation="case-manager"
        onSetDisposition={onSetDisposition}
      />,
    );
    expect(screen.queryByTestId('overview-set-disposition')).toBeNull();
  });

  it('a resolved case with no recorded outcome offers Set disposition and says resolved', () => {
    const onSetDisposition = vi.fn();
    const resolvedUnrecorded = {
      ...closedAsFp,
      status: 'resolved',
      verdict: 'TRUE_POSITIVE',
      disposition: 'undetermined',
      history: [{ event: 'analyst_action', action: 'resolve', analyst: 'aryan', ts: '2026-10-09T10:00:00Z' }],
    } as unknown as Case;
    render(
      <OverviewPanel
        c={resolvedUnrecorded}
        fpPolicy={null}
        triage={null}
        triageLoading={false}
        presentation="case-manager"
        onSetDisposition={onSetDisposition}
      />,
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Resolved by analyst: outcome not recorded$/);
    const button = screen.getByTestId('overview-set-disposition');
    expect(button.parentElement).toHaveTextContent('No disposition was recorded when this case was resolved.');
    fireEvent.click(button);
    expect(onSetDisposition).toHaveBeenCalledWith(button);
  });

  it('an AI auto-close keeps the code lane and says so', () => {
    renderCaseManager({ ...CASE, verdict: 'FALSE_POSITIVE', status: 'closed', decision_by: 'agent' } as unknown as Case);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Auto-closed as false positive$/);
    expect(screen.getByRole('heading', { level: 3, name: 'Code decided' })).toBeInTheDocument();
  });

  it('an analyst-policy close is attributed to the policy, not to a person', () => {
    renderCaseManager({ ...CASE, verdict: 'NONE', status: 'closed', decision_by: 'analyst_policy' } as unknown as Case);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /^Closed by analyst policy \(declared benign\)$/,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Analyst policy' })).toBeInTheDocument();
    expect(screen.getByTestId('overview-authority')).toHaveTextContent(/operator rule/i);
  });
});
