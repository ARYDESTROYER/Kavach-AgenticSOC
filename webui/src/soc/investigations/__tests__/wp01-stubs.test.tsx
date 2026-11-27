/**
 * Round 16 WP01: the cross-package mount points exist with their final props and change
 * nothing yet (SPEC §4.1 "Stub-first mount points", §4.3 WP01).
 *
 * * The AI run stubs are filled by WP09 (their tests are `investigations.test.tsx`,
 *   `AiRunChip.test.tsx` and `ReinvestigateDialog.test.tsx` beside this file).
 * * The explain stubs render their children unchanged; every builder answers `null`.
 * * The records stubs render nothing, except the two that replace today's markup:
 *   `FindingsList` (today's first-sentence list) and `CaseUsageButton` (the cost text).
 * * The explainability contract file parses and names every section.
 */
import * as React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

import type { Case } from '@/lib/types';
import { fmtMoney } from '@/lib/format';
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

beforeEach(() => {
  h.reinvestigateCase.mockReset();
  h.toastError.mockReset();
  h.canViewCost = true;
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

  it('answer null from a builder only when nothing can be explained honestly (WP11 filled them)', () => {
    expect(builders.explainRisk({ case_id: 'case-1' } as Case, null)).toBeNull();
    expect(builders.explainDecision(CASE, null)).toBeNull();
    expect(builders.explainSla(null)).toBeNull();
    expect(builders.explainPriority(null)).toBeNull();
    expect(builders.explainSeverity(null)).toBeNull();
    expect(builders.explainShare(Number.NaN, 2)).toBeNull();
    expect(builders.explainWilson(1, 0)).toBeNull();
    expect(builders.explainCost([])).toBeNull();
    expect(builders.explainRisk(CASE, null)?.display).toBe('Risk 81');
  });
});

describe('the records stubs', () => {
  it('render nothing where there is nothing to show (WP14 filled them; records.wp14.test.tsx covers the rest)', async () => {
    const { container } = render(
      <>
        <AllFieldsSheet caseId="case-1" open={false} onOpenChange={() => undefined} />
        <AwaitingReason caseRecord={CASE} />
        <CaseUsageButton caseId="case-1" totalCost={null} />
        <FindingsList findings={[]} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
    // The events table asks its injected reader, never the stubbed module.
    const load = vi.fn(async () => ({
      case_id: 'case-1', available: true, reason: null, returned: 0, expected: 0,
      truncated: false, limit: 50, next_cursor: null, rows: [],
    }));
    render(<CaseEvents caseId="case-1" filterEventIds={['e1']} onClearFilter={() => undefined} load={load} />);
    expect(load).toHaveBeenCalledWith('case-1', expect.objectContaining({ limit: 50 }));
    // Let the read settle inside act, so the strict run sees no act warning.
    expect(await screen.findByText('This case lists no events.')).toBeInTheDocument();
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
