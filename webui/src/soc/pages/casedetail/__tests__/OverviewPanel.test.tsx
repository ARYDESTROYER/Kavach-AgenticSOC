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
import { render as testingRender, screen, within } from '@testing-library/react';
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
      label: 'a manually resolved false positive',
      status: 'resolved',
      decisionBy: 'analyst',
      expected: true,
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
        expect(screen.getByText('Auto-closed by AI')).toBeInTheDocument();
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
    expect(
      within(screen.getByTestId('case-manager-decision-summary')).getAllByText('Escalated'),
    ).toHaveLength(1);
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
      'text-3xl',
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
    expect(flatColumns).toHaveLength(8);
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
    expect(screen.getByText('Impact')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Priority')).toBeInTheDocument();
    expect(screen.getByText('P4')).toBeInTheDocument();
    expect(
      screen.getByText(/close \/ escalate call is made by deterministic code/i),
    ).toBeInTheDocument();

    // Risk and confidence are each presented once instead of being echoed in three cards.
    expect(screen.getAllByText('40/100')).toHaveLength(1);
    expect(screen.getAllByText('90%')).toHaveLength(1);
  });

  it('keeps the larger embedded decision heading neutral across verdict outcomes', () => {
    const { unmount } = renderCaseManager({
      ...CASE,
      verdict: 'false_positive',
      status: 'resolved',
    } as unknown as Case);
    expect(screen.getByRole('heading', { level: 2 })).toHaveClass(
      'text-3xl',
      'text-foreground',
    );
    expect(screen.getByRole('heading', { level: 2 })).not.toHaveClass('text-info-text');
    unmount();

    renderCaseManager({ ...CASE, verdict: 'needs_human', status: 'needs_human' } as unknown as Case);
    expect(screen.getByRole('heading', { level: 2 })).toHaveClass(
      'text-3xl',
      'text-foreground',
    );
    expect(screen.getByRole('heading', { level: 2 })).not.toHaveClass('text-warning-text');
  });

  it('renders honest, text-equivalent risk and confidence visuals from existing case data', () => {
    renderCaseManager();
    const profile = screen.getByRole('complementary', { name: 'Case signal profile' });
    expect(profile).toHaveClass('border-t', 'xl:border-l', 'xl:border-t-0');
    expect(profile).not.toHaveClass('bg-muted/20', 'rounded-sm');

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
    renderCaseManager();
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
    renderCaseManager({
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
    expect(chip).toHaveClass('break-all');
  });

  it('still renders a short detection-rule id as a normal single-line chip (no regression)', () => {
    renderOverview({ ...CASE, rule_ids: ['T1078.004'] } as unknown as Case);
    const chip = getRuleChip('T1078.004');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveClass('whitespace-normal');
  });

  it('wraps a SPACE-LESS/hyphen-less long rule id (no soft-wrap points) via min-w-0 + break-all, not just break-words', () => {
    // `break-words` (overflow-wrap) only wraps at existing soft-wrap opportunities
    // (spaces/hyphens); an id like this has none, so overflow-wrap never kicks in
    // and the flex item's automatic min-content width keeps forcing the card
    // wider UNLESS the item itself also has `min-w-0` and uses `break-all`
    // (word-break), which forces a break anywhere and actually reduces the
    // item's min-content contribution per spec.
    const longId = 'Trojan_Generic_Suspicious_PowerShell_EncodedCommand_Execution_Detected';
    renderOverview({ ...CASE, rule_ids: [longId] } as unknown as Case);
    const chip = getRuleChip(longId);
    expect(chip).toHaveClass('min-w-0');
    expect(chip).toHaveClass('break-all');
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
