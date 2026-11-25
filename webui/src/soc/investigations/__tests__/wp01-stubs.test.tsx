/**
 * Round 16 WP01: the cross-package mount points exist with their final props and change
 * nothing yet (SPEC §4.1 "Stub-first mount points", §4.3 WP01).
 *
 * * The AI run stubs say nothing and render nothing.
 * * The explain stubs render their children unchanged; every builder answers `null`.
 * * The records stubs render nothing, except the two that replace today's markup:
 *   `FindingsList` (today's first-sentence list) and `CaseUsageButton` (the cost text).
 * * `ReinvestigateDialog` is today's blocking dialog: it posts, hands the returned case
 *   over and closes; a refusal is worded.
 * * The explainability contract file parses and names every section.
 */
import * as React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
  class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    reinvestigateCase: vi.fn(),
    toastError: vi.fn(),
    canViewCost: true,
    FakeApiError,
  };
});

vi.mock('@/lib/api', () => ({
  ApiError: h.FakeApiError,
  api: { reinvestigateCase: h.reinvestigateCase },
}));
vi.mock('sonner', () => ({ toast: { error: h.toastError } }));
vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ hasPermission: (r: string, a: string) => (r === 'cost' && a === 'view' ? h.canViewCost : true) }),
}));

import type { Case, InvestigationView } from '@/lib/types';
import { fmtMoney } from '@/lib/format';
import { aiRunAccessibleText } from '../aiRunText';
import { useAiRun } from '../useAiRun';
import { AiRunChip } from '../AiRunChip';
import { AiRunMark } from '../AiRunMark';
import { AiQueueNotice } from '../AiQueueNotice';
import { ReinvestigateDialog, reinvestigateErrorText } from '../ReinvestigateDialog';
import { ExplainTrigger } from '@/design-system/explain';
import * as builders from '@/lib/explain/builders';
import { RiskExplain } from '@/soc/pages/casedetail/explain/RiskExplain';
import { DecisionExplain } from '@/soc/pages/casedetail/explain/DecisionExplain';
import { FactExplain } from '@/soc/pages/casedetail/explain/FactExplain';
import { CaseEvents } from '@/soc/pages/casedetail/records/CaseEvents';
import { CaseUsageButton } from '@/soc/pages/casedetail/records/CaseUsageButton';
import { AllFieldsSheet } from '@/soc/pages/casedetail/records/AllFieldsSheet';
import { AwaitingReason } from '@/soc/pages/casedetail/records/AwaitingReason';
import { FindingsList } from '@/soc/pages/casedetail/records/FindingsList';

const CASE = { case_id: 'case-1', case_number: 'CASE-0001', token_cost: 0.25, risk_score: 81 } as Case;
const VIEW: InvestigationView = {
  run_id: 'inv-1',
  case_id: 'case-1',
  state: 'running',
  phase: 'evidence',
  trigger: 'manual',
  queued_at: '2026-11-24T10:00:00Z',
  started_at: '2026-11-24T10:00:01Z',
  deadline_at: '2026-11-24T10:10:01Z',
  time_cap_seconds: 600,
  finished_at: null,
  outcome: null,
  status_after: null,
  verdict_after: null,
};

beforeEach(() => {
  h.reinvestigateCase.mockReset();
  h.toastError.mockReset();
  h.canViewCost = true;
});

describe('the AI run stubs', () => {
  it('say nothing and render nothing', () => {
    expect(aiRunAccessibleText(VIEW, Date.now())).toBeNull();
    expect(aiRunAccessibleText(null, Date.now())).toBeNull();
    const Probe = () => <span data-testid="run">{String(useAiRun('case-1'))}</span>;
    render(<Probe />);
    expect(screen.getByTestId('run')).toHaveTextContent('null');
    const { container } = render(
      <>
        <AiRunChip caseId="case-1" />
        <AiRunChip caseId="case-1" compact />
        <AiRunMark caseId="case-1" />
        <AiQueueNotice />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the explain stubs', () => {
  it('render their children unchanged', () => {
    render(
      <>
        <ExplainTrigger explanation={null}>
          <span>trigger</span>
        </ExplainTrigger>
        <ExplainTrigger explanation={null} mode="row-hover">
          <span>row</span>
        </ExplainTrigger>
        <RiskExplain caseId="case-1" score={81} breakdown={null}>
          <span>81</span>
        </RiskExplain>
        <RiskExplain caseId="case-1" score={81} breakdown={{ total: 81.11 }} variant="row">
          <span>81 row</span>
        </RiskExplain>
        <DecisionExplain caseRecord={CASE}>
          <span>decision</span>
        </DecisionExplain>
        <FactExplain explanation={null}>
          <span>fact</span>
        </FactExplain>
      </>,
    );
    for (const text of ['trigger', 'row', '81', '81 row', 'decision', 'fact']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it('answer null from every builder until the kit lands', () => {
    const block = { p50: 1, p90: 2, mean: 1.5, max: 3, count: 4, available: true, reason: '' };
    expect(builders.explainRisk(CASE, null)).toBeNull();
    expect(builders.explainDecision(CASE, null)).toBeNull();
    expect(builders.explainSla(null)).toBeNull();
    expect(builders.explainPriority(null)).toBeNull();
    expect(builders.explainSeverity(null)).toBeNull();
    expect(builders.explainShare(1, 2)).toBeNull();
    expect(builders.explainPercentile(block, [1, 2])).toBeNull();
    expect(builders.explainWilson(27, 30)).toBeNull();
    expect(builders.explainCost([])).toBeNull();
  });
});

describe('the records stubs', () => {
  it('render nothing where nothing is shown today', () => {
    const { container } = render(
      <>
        <CaseEvents caseId="case-1" filterEventIds={['e1']} onClearFilter={() => undefined} />
        <AllFieldsSheet caseId="case-1" open onOpenChange={() => undefined} />
        <AwaitingReason caseRecord={CASE} />
        <CaseUsageButton caseId="case-1" totalCost={null} />
        <FindingsList findings={[]} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('show the cost as text, as the facts rail does today', () => {
    render(<CaseUsageButton caseId="case-1" totalCost={0.25} />);
    expect(screen.getByText(fmtMoney(0.25))).toBeInTheDocument();
  });

  it("render today's findings list, with hostile text as text", () => {
    render(
      <FindingsList
        findings={[
          { summary: 'Login burst from 203.0.113.9. Then more detail.', query: 'rule:"ssh"' },
          { summary: 'No match in threat intel.' },
          { summary: '<img src=x onerror=alert(1)> is a value.' },
        ]}
        onShowEvents={() => undefined}
      />,
    );
    expect(screen.getByTestId('investigation-findings')).toBeInTheDocument();
    expect(screen.getByText('Login burst from 203.0.113.9.')).toBeInTheDocument();
    expect(screen.getByText('rule:"ssh"')).toBeInTheDocument();
    expect(screen.getAllByText('Found')).toHaveLength(2);
    expect(screen.getByText('Clear')).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror=alert(1)> is a value.')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('the Reinvestigate dialog stub (today\'s dialog)', () => {
  it('posts, hands the returned case over and closes', async () => {
    const next = { ...CASE, verdict: 'TRUE_POSITIVE' } as Case;
    h.reinvestigateCase.mockResolvedValue(next);
    const onOpenChange = vi.fn();
    const onReinvestigated = vi.fn();
    render(
      <ReinvestigateDialog
        caseRecord={CASE}
        open
        onOpenChange={onOpenChange}
        models={{ providers: {} } as never}
        onReinvestigated={onReinvestigated}
      />,
    );
    expect(screen.getByText('Re-run the investigation')).toBeInTheDocument();
    expect(screen.getByText(`Investigation cost to date ${fmtMoney(0.25)}.`, { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reinvestigate/ }));
    await waitFor(() => expect(onReinvestigated).toHaveBeenCalledWith(next));
    expect(h.reinvestigateCase).toHaveBeenCalledWith('case-1', undefined);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('words a refusal and hides the cost without cost:view', async () => {
    h.canViewCost = false;
    h.reinvestigateCase.mockRejectedValue(new h.FakeApiError(403, 'permission denied: cases:reinvestigate'));
    const onOpenChange = vi.fn();
    render(<ReinvestigateDialog caseRecord={CASE} open onOpenChange={onOpenChange} models={null} />);
    expect(screen.queryByText(/Investigation cost to date/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reinvestigate/ }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('You do not have permission to reinvestigate cases.'));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(reinvestigateErrorText(new Error('boom'))).toBe('boom');
    expect(reinvestigateErrorText(null)).toBe('The reinvestigation could not be started.');
  });
});

describe('the explainability contract file', () => {
  it('parses and names every section the two ends check', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const contract = JSON.parse(
      readFileSync(resolve(here, '../../../lib/explain/explain.contract.json'), 'utf8'),
    ) as Record<string, unknown>;
    for (const key of ['rounding', 'risk', 'wilson', 'percentile', 'priority', 'sla']) {
      expect(contract).toHaveProperty(key);
    }
    const rounding = contract.rounding as { vectors: Array<{ value: number; display: number }> };
    for (const v of rounding.vectors) expect(Math.floor(v.value + 0.5)).toBe(v.display);
  });
});

// Keep React in scope for the JSX in this file under every transform.
void React;
