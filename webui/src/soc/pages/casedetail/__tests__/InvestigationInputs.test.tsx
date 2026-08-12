import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { CaseRationale } from '@/lib/types';
import { InvestigationInputs } from '../InvestigationInputs';

expect.extend(toHaveNoViolations);

const RATIONALE: CaseRationale = {
  case_id: 'case-1',
  memory_used: ['The finance scanner is approved.', 'The payroll subnet is restricted.'],
  knowledge: [
    { source: 'runbook', snippet: 'Validate the scanner owner.' },
    { source: 'resolved_case', snippet: 'A prior case used the same source.' },
    { source: 'mitre', snippet: 'Technique context.' },
  ],
  playbook: {
    id: 'credential-response',
    version: '3',
    reason: 'matched auth activity',
    consulted: true,
  },
  procedure_provenance: {
    persona: {
      selected_id: 'network_specialist',
      selection_reason: 'entity_type=ip',
      consulted: true,
    },
    playbook: {
      selected_id: 'credential-response',
      selection_reason: 'exact rule match',
      consulted: true,
    },
    consultation_path: 'strong_investigator',
    retrieval_status: 'measured',
    retrieval_reason: 'completed',
    retrieval_query_groups: [],
    knowledge: [],
  },
  platform_tuning_status: 'recorded',
  platform_tuning: [
    {
      record_id: 'tune-1',
      target: 'correlation_n',
      rule_id: 'auth-failures',
      before: 2,
      after: 3,
    },
  ],
};

describe('InvestigationInputs', () => {
  it('separates the actual latest-run inputs and keeps decision authority explicit', async () => {
    const onReview = vi.fn();
    const { container } = render(
      <InvestigationInputs rationale={RATIONALE} onReview={onReview} />,
    );

    expect(screen.getByText('Investigation inputs')).toBeInTheDocument();
    expect(screen.getByText('2 approved operator facts')).toBeInTheDocument();
    expect(screen.getByText('2 retrieved references')).toBeInTheDocument();
    expect(screen.getByText('1 retrieved reference')).toBeInTheDocument();
    expect(screen.getByText('network_specialist · Consulted')).toBeInTheDocument();
    expect(screen.getByText('credential-response · v3 · Consulted')).toBeInTheDocument();
    expect(screen.getByText('Correlation threshold 2 → 3')).toBeInTheDocument();
    expect(screen.getByText(/Deterministic policy still made the final route/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Review inputs' }));
    expect(onReview).toHaveBeenCalledOnce();
    expect(screen.getByLabelText(/Persona: network_specialist/)).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/latest run actually consulted this persona/i),
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('does not claim that a merely selected playbook was consulted', () => {
    render(
      <InvestigationInputs
        rationale={{
          case_id: 'case-2',
          playbook: { id: 'selected-only', consulted: false },
          knowledge: [{ source: 'runbook', snippet: 'A retrieved runbook descriptor.' }],
        }}
      />,
    );

    expect(screen.queryByText('selected-only')).toBeNull();
    expect(screen.getByText('Runbook')).toBeInTheDocument();
  });

  it('discloses selected-only procedures in the Investigation view without calling them inputs', () => {
    render(
      <InvestigationInputs
        showSelectionStatus
        rationale={{
          case_id: 'case-selected-only',
          procedure_provenance: {
            persona: {
              selected_id: 'network_specialist',
              selection_reason: 'entity_type=ip',
              consulted: false,
            },
            playbook: {
              selected_id: 'scanner-response',
              selection_reason: 'exact rule match',
              consulted: false,
            },
            consultation_path: 'router_benign_shortcut',
            retrieval_query_groups: [],
            knowledge: [],
          },
          playbook: { id: '', consulted: false },
        }}
      />,
    );

    expect(screen.getByText('network_specialist · Selected only')).toBeInTheDocument();
    expect(screen.getByText('scanner-response · Selected only')).toBeInTheDocument();
    expect(screen.queryByText(/These inputs informed preprocessing/)).toBeNull();
  });

  it('does not turn missing retrieval telemetry into a false no-input state', () => {
    render(
      <InvestigationInputs
        rationale={{
          case_id: 'case-3',
          memory_used: [],
          knowledge: [],
          platform_tuning_status: 'recorded',
          platform_tuning: [],
        }}
        onReview={vi.fn()}
      />,
    );
    expect(screen.getByText('Provenance unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review inputs' })).toBeNull();
    expect(screen.queryByText(/These inputs informed preprocessing/)).toBeNull();
  });

  it('discloses an explicit not-run retrieval path without calling it an input', () => {
    render(
      <InvestigationInputs
        showSelectionStatus
        rationale={{
          case_id: 'case-not-run',
          knowledge: [],
          procedure_provenance: {
            persona: { selected_id: '', selection_reason: '', consulted: false },
            playbook: { selected_id: '', selection_reason: '', consulted: false },
            consultation_path: 'kill_switch',
            retrieval_status: 'not_attempted',
            retrieval_reason: 'kill_switch',
            retrieval_query_groups: [],
            knowledge: [],
          },
        }}
        onReview={vi.fn()}
      />,
    );

    expect(screen.getByText('Not run')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review inputs' })).toBeNull();
    expect(screen.queryByText(/These inputs informed preprocessing/)).toBeNull();
  });

  it('does not turn a provenance failure into a false no-input state', async () => {
    const retry = vi.fn();
    render(
      <InvestigationInputs rationale={null} error={new Error('offline')} onRetry={retry} />,
    );
    expect(screen.getByText('Inputs unavailable.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('does not present unavailable tuning provenance as an input that informed the case', () => {
    render(
      <InvestigationInputs
        rationale={{
          case_id: 'case-4',
          platform_tuning_status: 'unavailable',
          platform_tuning: [],
        }}
        onReview={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Provenance unavailable')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Review inputs' })).toBeNull();
    expect(screen.queryByText(/These inputs informed preprocessing/)).toBeNull();
  });
});
