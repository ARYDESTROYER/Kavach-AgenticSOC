/**
 * Round 16 WP11I: the WP10 backend shapes and the WP11 leftovers on the WP03 case page.
 *
 * * The server's SLA reading is read whole: `breached` and `running`, not only `state`. A
 *   closed case with a late response and an on-time resolution reads its late response
 *   (the SLA metrics count it as a breach), never "SLA met"; a stopped breached clock is
 *   late by its elapsed time over the target, never measured to now; the "due in" line
 *   floors the time left (B32 never returns); a clock the server marks as never due reads
 *   "not due".
 * * D9: with the priority matrix off the inspector says "No priority", never the matrix's
 *   default level.
 * * D8: the inspector's policy line states both auto-close conditions with their numbers.
 * * Every number in the meta strip and the inspector opens its explanation: the SLA (also
 *   the Console's own reading), the SLA's priority, the AI verdict and confidence, the
 *   policy line and the time to detect; Enter opens the panel, Escape closes it and focus
 *   returns to the trigger.
 * * The WP10 shapes are read defensively: a failed run (`run_failed`) shows no policy as
 *   if it decided, a re-derived span (`gate_source`) never passes a stray gate off as
 *   recorded, today's internal network range (`asset_cidr`) reaches the risk explanation,
 *   and partial risk inputs (or `inputs_status: not_recorded`) read "not recorded".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const h = vi.hoisted(() => ({ getCaseStages: vi.fn(), getTimeline: vi.fn(), apiGet: vi.fn() }));
vi.mock('@/soc/pages/CaseDetail.api', () => ({ getCaseStages: h.getCaseStages, getTimeline: h.getTimeline }));
vi.mock('@/lib/api', () => ({ api: { get: h.apiGet, caseAssign: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
// The records kit is WP14's: stubbed here, as in the FactsRail suite.
vi.mock('../records/CaseUsageButton', () => ({ CaseUsageButton: () => null }));
vi.mock('../records/AllFieldsSheet', () => ({ AllFieldsSheet: () => null }));
vi.mock('../records/AwaitingReason', () => ({ AwaitingReason: () => null }));

import contract from '@/lib/explain/explain.contract.json';
import { explainDecision, readDecision, FAILED_RUN_SENTENCE } from '@/lib/explain/decision';
import { explainRiskScore } from '@/lib/explain/risk';
import type { SlaReadingWire } from '@/lib/explain/sla';
import type { Case, RiskBreakdown, RiskInputs, SlaPolicy } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { caseOutcome } from '@/soc/components/outcome';
import type { TimelineResponse, TraceSpan, TriageChips } from '@/soc/pages/CaseDetail.api';

import { CaseHeaderMeta } from '../CaseHeaderMeta';
import { DecisionCard } from '../DecisionCard';
import { FactsRail, autoCloseBarLine } from '../FactsRail';
import { caseRiskFactors } from '../SignalProfile';
import { caseSlaReading, slaFromServer, triageAssetCidr, triageSla } from '../triageReads';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const at = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60_000).toISOString();

beforeEach(() => {
  window.localStorage.clear();
  h.getCaseStages.mockReset();
  h.getTimeline.mockReset();
  h.apiGet.mockReset();
});

/** The triage read of a closed P2 case: response 3h late, resolution inside its target. */
const LATE_RESPONSE_CLOSED = {
  sla: {
    clock: 'resolution',
    start_at: at(-600),
    anchor: 'acknowledged',
    responded_at: at(-300),
    target_minutes: 1440,
    due_at: at(840),
    elapsed_minutes: 480,
    state: 'met',
    priority: 'P2',
    priority_source: 'case_record',
    running: false,
    breached: true,
    clocks: {
      response: {
        target_minutes: 120,
        start_at: at(-600),
        due_at: at(-480),
        stopped_at: at(-300),
        stop_source: 'acknowledged_at',
        elapsed_minutes: 300,
        running: false,
        state: 'breached',
      },
      resolution: {
        target_minutes: 1440,
        start_at: at(-600),
        due_at: at(840),
        stopped_at: at(-120),
        stop_source: 'status_history',
        elapsed_minutes: 480,
        running: false,
        state: 'ok',
      },
    },
  },
};

describe("the server's SLA reading, read whole", () => {
  it('a closed case with a late response and an on-time resolution reads the late response, never "SLA met"', () => {
    const reading = slaFromServer(triageSla(LATE_RESPONSE_CLOSED), NOW);
    expect(reading?.text).toBe('Response overdue by 3h');
    expect(reading?.state).toBe('breached');
    expect(reading?.priority).toBe('P2');
    // The explanation states the clock the phrase states.
    expect(reading?.wire?.clock).toBe('response');
  });

  it('a stopped breached clock is late by its elapsed time over the target, never measured to now', () => {
    const stopped: SlaReadingWire = {
      clock: 'response',
      start_at: at(-6000),
      anchor: 'acknowledged',
      responded_at: at(-5700),
      target_minutes: 120,
      due_at: at(-5880),
      elapsed_minutes: 300,
      state: 'breached',
      priority: 'P2',
      priority_source: 'case_record',
      running: false,
      breached: true,
    };
    // Due 98 hours ago; answered 3 hours late. The line says 3h, not 4d.
    expect(slaFromServer(stopped, NOW)?.text).toBe('Response overdue by 3h');
  });

  it('the "due in" line floors the time left (B32 never returns)', () => {
    const running: SlaReadingWire = {
      clock: 'response',
      start_at: at(-26),
      anchor: 'created',
      responded_at: null,
      target_minutes: 120,
      due_at: at(94),
      elapsed_minutes: 26,
      state: 'ok',
      priority: 'P3',
      priority_source: 'priority_matrix',
      running: true,
      breached: false,
    };
    expect(slaFromServer(running, NOW)?.text).toBe('Response due in 1h');
  });

  it('a clock the server marks as never due reads "not due", never a countdown of its own', () => {
    const neverDue: SlaReadingWire = {
      clock: 'response',
      start_at: at(-26),
      anchor: 'created',
      responded_at: null,
      target_minutes: 9_000_000_000,
      due_at: null,
      elapsed_minutes: 26,
      state: 'ok',
      priority: 'P4',
      priority_source: 'case_record',
      running: true,
      breached: false,
    };
    const policy = {
      enabled: true,
      business_hours_only: false,
      targets: { P4: { response_minutes: 9_000_000_000, resolve_minutes: 0 } },
    } as unknown as SlaPolicy;
    const c = { case_id: 'c', priority_level: 'P4', status: 'open', created_at: at(-26) } as unknown as Case;
    expect(caseSlaReading(c, policy, neverDue, NOW)?.text).toBe('Response not due');
  });

  it('the inspector of a closed case states the late response the SLA metrics count', () => {
    const closed = {
      case_id: 'case-late',
      status: 'closed',
      verdict: 'TRUE_POSITIVE',
      confidence: 0.9,
      risk_score: 60,
      decision_by: 'analyst',
      disposition: 'true_positive',
      priority_level: 'P2',
      created_at: at(-600),
      updated_at: at(-120),
    } as unknown as Case;
    render(
      <TooltipProvider>
        <FactsRail
          c={closed}
          outcome={caseOutcome(closed)}
          triage={null}
          serverSla={triageSla(LATE_RESPONSE_CLOSED)}
          canViewCost={false}
          onCaseChange={vi.fn()}
        />
      </TooltipProvider>,
    );
    const sla = screen.getByTestId('facts-sla');
    expect(sla).toHaveTextContent('Response overdue by 3h');
    expect(sla).toHaveAttribute('data-sla-state', 'breached');
  });
});

/** Triage chips with the priority matrix off (`level: null` on purpose). */
const MATRIX_OFF = {
  risk: { value: 81, band: 'critical', breakdown: {}, inputs: {} },
  severity: { band: 'high', value: 60, raw: null, source: 'derived', inputs: {} },
  impact: { band: 'low', value: 0, criticality: 0, entity: '203.0.113.9', inputs: {} },
  priority: {
    level: null,
    enabled: false,
    impact: 'low',
    matched: true,
    default: 'P3',
    urgency: { band: 'high', value: 81, escalated: false },
    inputs: { matrix_enabled: false },
  },
} as unknown as TriageChips;

const OPEN_FP = {
  case_id: 'case-fp',
  status: 'needs_human',
  verdict: 'FALSE_POSITIVE',
  confidence: 0.97,
  risk_score: 45,
  decision_by: 'agent',
  created_at: at(-30),
  updated_at: at(-5),
  first_seen_millis: NOW - 34 * 60_000,
  history: [],
} as unknown as Case;

const POLICY = { enabled: true, min_confidence: 0.85, max_risk_score: 30 };

function renderRail(c: Case = OPEN_FP, extra: Partial<React.ComponentProps<typeof FactsRail>> = {}) {
  return render(
    <TooltipProvider>
      <FactsRail
        c={c}
        outcome={caseOutcome(c)}
        triage={MATRIX_OFF}
        policy={POLICY}
        canViewCost={false}
        onCaseChange={vi.fn()}
        {...extra}
      />
    </TooltipProvider>,
  );
}

describe('D9: no priority while the matrix is off', () => {
  it('says "No priority", never the default P3', () => {
    renderRail();
    const line = screen.getByTestId('facts-priority-line');
    expect(line).toHaveTextContent('No priority');
    expect(line).not.toHaveTextContent('P3');
  });
});

describe('D8: the policy line states both auto-close conditions', () => {
  it('confidence met and risk not met routes to a person, with both numbers', () => {
    expect(autoCloseBarLine(POLICY, 'FALSE_POSITIVE', 0.97, 45)).toBe(
      "Today's policy routes it to a person: confidence 97% >= 85% (met); risk 45 <= 30 (not met).",
    );
    expect(autoCloseBarLine(POLICY, 'FALSE_POSITIVE', 0.97, 20)).toBe(
      "Today's policy closes it automatically: confidence 97% >= 85% (met) and risk 20 <= 30 (met).",
    );
    expect(autoCloseBarLine({ ...POLICY, enabled: false }, 'FALSE_POSITIVE', 0.97, 20)).toBe(
      "Today's policy routes it to a person: auto-close is off for false positives.",
    );
    // A needs-human verdict has no bar: code fixes it.
    expect(autoCloseBarLine({ enabled: false }, 'NEEDS_HUMAN', 0.7, 20)).toBeNull();
  });

  it('the inspector shows the line, and it opens the comparison', async () => {
    const user = userEvent.setup();
    renderRail();
    const line = screen.getByTestId('facts-auto-close-bar');
    expect(line).toHaveTextContent('confidence 97% >= 85% (met); risk 45 <= 30 (not met)');
    await user.click(within(line).getByRole('button'));
    const panel = await screen.findByTestId('explain-panel');
    expect(panel).toHaveTextContent("Today's auto-close policy");
    expect(panel).toHaveTextContent('Maximum risk30');
  });
});

describe('every number in the inspector and the meta strip opens its explanation', () => {
  it('the AI verdict line, the policy line and the time to detect are triggers', () => {
    renderRail();
    const outcome = screen.getByTestId('facts-outcome');
    expect(within(outcome).getByRole('button', { name: /AI verdict: False positive \(97%\)/ })).toBeInTheDocument();
    expect(within(screen.getByTestId('facts-auto-close-bar')).getByRole('button')).toBeInTheDocument();
    const times = screen.getByTestId('facts-times');
    expect(within(times).getByRole('button', { name: /^4m\s*, explain$/ })).toBeInTheDocument();
  });

  it("the meta strip's SLA, from the Console's own reading too, and its priority open their explanations", async () => {
    const user = userEvent.setup();
    const policy = {
      enabled: true,
      business_hours_only: false,
      targets: { P3: { response_minutes: 120, resolve_minutes: 1440 } },
    } as unknown as SlaPolicy;
    const c = { ...OPEN_FP, priority_level: 'P3', created_at: new Date(Date.now() - 26 * 60_000).toISOString() } as Case;
    const matrixOn = {
      ...MATRIX_OFF,
      priority: { ...MATRIX_OFF.priority, level: 'P3', enabled: true, inputs: { matrix_enabled: true } },
    } as unknown as TriageChips;
    render(
      <TooltipProvider>
        <CaseHeaderMeta
          c={c}
          outcome={caseOutcome(c)}
          users={[]}
          canAssign={false}
          slaPolicy={policy}
          serverSla={null}
          triage={matrixOn}
          onCaseChange={vi.fn()}
          ownerOpen={false}
          onOwnerOpenChange={vi.fn()}
        />
      </TooltipProvider>,
    );
    const sla = screen.getByTestId('case-detail-sla');
    const slaTrigger = within(sla).getByRole('button', { name: /^Response due in 1h\s*, explain$/ });
    expect(within(sla).getByRole('button', { name: /^P3\s*, explain$/ })).toBeInTheDocument();

    // Keyboard: Enter opens the panel, Escape closes it, focus returns to the trigger.
    slaTrigger.focus();
    await user.keyboard('{Enter}');
    const panel = await screen.findByTestId('explain-panel');
    expect(panel).toHaveTextContent('Response SLA');
    expect(panel).toHaveTextContent('Computed in the Console from the SLA policy');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('explain-panel')).toBeNull());
    expect(slaTrigger).toHaveFocus();
  });
});

describe('the WP10 decision payload, read defensively', () => {
  const failedPayload = {
    source: 'recorded',
    decision_status: 'needs_human',
    decision_by: 'system',
    escalate: false,
    ts: '2026-11-25T10:00:00Z',
    gate: null,
    gate_source: null,
    run_failed: true,
    current_policy: null,
    policy_changed: null,
    policy_clause: {
      verdict_class: 'false_positive',
      auto_closable: true,
      enabled: true,
      min_confidence: 0.85,
      max_risk_score: 30,
    },
  };

  it('a failed run reads as the failure, never as a policy comparison', () => {
    const reading = readDecision(failedPayload);
    expect(reading?.runFailed).toBe(true);
    const c = { case_id: 'c', verdict: 'FALSE_POSITIVE', confidence: 0.97, risk_score: 20, status: 'needs_human' } as unknown as Case;
    const exp = explainDecision(c, failedPayload);
    expect(exp?.summary).toBe(FAILED_RUN_SENTENCE);
    expect(exp?.summary).not.toMatch(/closes it automatically|confidence/);
  });

  it('the decision card says the run failed and shows no clause as if it decided', () => {
    const span: TraceSpan = {
      step_index: 3,
      kind: 'decision',
      name: 'case_manager',
      ts: '2026-11-25T10:00:00Z',
      latency_ms: null,
      cost: 0,
      tokens: 0,
      trusted: true,
      summary: FAILED_RUN_SENTENCE,
      payload_ref: failedPayload,
    };
    const timeline: TimelineResponse = { case_id: 'c', total: 1, totals: { cost: 0, tokens: 0 }, spans: [span] };
    const c = { case_id: 'c', verdict: 'FALSE_POSITIVE', confidence: 0.97, risk_score: 20, status: 'needs_human' } as unknown as Case;
    render(<DecisionCard c={c} rationale={null} timeline={timeline} />);
    expect(screen.getByTestId('decision-run-failed')).toHaveTextContent(FAILED_RUN_SENTENCE);
    expect(screen.queryByTestId('decision-clause')).toBeNull();
    expect(screen.queryByTestId('decision-conditions')).toBeNull();
  });

  it('a re-derived span never passes a stray gate off as recorded', () => {
    const reading = readDecision({
      source: 'rederived_current_policy',
      gate_source: 'rederived_current_policy',
      gate: { verdict: 'FALSE_POSITIVE', min_confidence: 0.5, max_risk_score: 90, class_enabled: true },
    });
    expect(reading?.gate).toBeNull();
    expect(reading?.gateSource).toBe('rederived_current_policy');
  });
});

const WORKED = contract.risk.vectors[0];
const BREAKDOWN: RiskBreakdown = { ...WORKED.expected.breakdown, inputs: WORKED.expected.inputs as unknown as RiskInputs };

describe("today's internal network range and the risk inputs, read defensively", () => {
  it('reads asset_cidr only in its object shape', () => {
    expect(
      triageAssetCidr({ asset_cidr: { cidr: '10.0.0.0/8', criticality: 75, label: 'current configuration', matches_recorded: true } }),
    ).toEqual({ cidr: '10.0.0.0/8', criticality: 75, matchesRecorded: true });
    expect(triageAssetCidr({ asset_cidr: '10.0.0.0/8' })).toBeNull();
    expect(triageAssetCidr({ asset_cidr: { criticality: 75 } })).toBeNull();
    expect(triageAssetCidr({})).toBeNull();
  });

  it('the risk explanation names the range as today\'s configuration, and a changed criticality', () => {
    const exp = explainRiskScore({
      score: 81.11,
      breakdown: BREAKDOWN,
      assetRange: { cidr: '10.0.0.0/8', criticality: 90, matchesRecorded: false },
    });
    const row = exp?.inputs.find((input) => input.key === 'asset_cidr');
    expect(row?.value).toBe('10.0.0.0/8, criticality 90 (current configuration)');
    expect(row?.source).toBe("Today's settings");
    expect(exp?.caveats.join(' ')).toContain("Today's range gives criticality 90, not the 60 recorded at scoring");
  });

  it('partial risk inputs read "not recorded", never "undefined events" or a crash', () => {
    const c = {
      case_id: 'c',
      risk_score: 40,
      risk_breakdown: { volume: 40, velocity: 10, reputation: 0, diversity: 20, asset_criticality: 0, inputs: {} },
    } as unknown as Case;
    const factors = caseRiskFactors(c, null);
    expect(factors).toHaveLength(5);
    const volume = factors.find((f) => f.key === 'volume');
    expect(volume?.caseReason).toContain('was not recorded');
    expect(factors.map((f) => f.caseReason).join(' ')).not.toContain('undefined');
  });

  it('a partial inputs object still reads today\'s reconstruction on first open', async () => {
    const user = userEvent.setup();
    h.getCaseStages.mockResolvedValue({ case_id: 'c', total: 0, stages: [] });
    const { RiskExplain } = await import('../explain/RiskExplain');
    render(
      <RiskExplain caseId="c" score={40} breakdown={{ volume: 40, velocity: 10, reputation: 0, diversity: 20, asset_criticality: 0, inputs: {} as unknown as RiskInputs }}>
        <span>Risk 40</span>
      </RiskExplain>,
    );
    await user.click(screen.getByRole('button', { name: /Risk 40/ }));
    await waitFor(() => expect(h.getCaseStages).toHaveBeenCalledWith('c'));
  });
});
