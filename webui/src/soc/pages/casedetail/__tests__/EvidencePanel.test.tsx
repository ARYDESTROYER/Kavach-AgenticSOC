/**
 * EvidencePanel: the Evidence tab, the source lane (Round 16, SPEC D8, §4.4 WP03).
 *
 * What the sources said: What happened (why the detection fired, the ingestion stage of
 * the story and the events, a section a retired Timeline link scrolls to), the entities,
 * threat context, the related cases and the baseline. Nothing on it is the AI's: no AI
 * provenance tag renders here. Every case-derived value is plain text or inside an
 * InlineCode fence (#9); the panel never decides or mutates the case (#3).
 */
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import type { ComponentProps } from 'react';

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

// The events table is WP14's: record what the panel passes it.
const eventsProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('../records/CaseEvents', () => ({
  CaseEvents: (props: Record<string, unknown>) => {
    eventsProps.last = props;
    return <div data-testid="case-events-stub" />;
  },
}));

import { EvidencePanel } from '../EvidencePanel';
import type { Case } from '@/lib/types';

const CASE = {
  case_id: 'c1',
  status: 'open',
  verdict: 'true_positive',
  risk_score: 40,
  confidence: 0.9,
  summary: 'Repeated failed logons.',
  rule_ids: ['ssh_bruteforce'],
  source_name: 'IBM QRadar SIEM',
} as unknown as Case;

function renderEvidence(c: Case = CASE, extra: Partial<ComponentProps<typeof EvidencePanel>> = {}) {
  return render(<EvidencePanel c={c} {...extra} />);
}

describe('EvidencePanel: What happened', () => {
  it('is a section a link can scroll to, with why the detection fired, the source story and the events', () => {
    renderEvidence(
      { ...CASE, trigger_reason: { sentence: '5 failed logins in 2 minutes for one user.' } } as unknown as Case,
      { sourceStory: <p>Ingestion stage</p>, filterEventIds: ['e1', 'e2'] },
    );
    const section = screen.getByTestId('evidence-what-happened');
    expect(section).toHaveAttribute('data-section', 'what-happened');
    const heading = within(section).getByRole('heading', { name: 'What happened' });
    expect(heading).toHaveAttribute('data-section-title');
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('evidence-trigger')).toHaveTextContent('Why it fired: 5 failed logins in 2 minutes for one user.');
    expect(within(section).getByText('Ingestion stage')).toBeInTheDocument();
    expect(within(section).getByTestId('case-events-stub')).toBeInTheDocument();
    // A finding's "Cites N events" narrows the events table.
    expect(eventsProps.last).toMatchObject({ caseId: 'c1', filterEventIds: ['e1', 'e2'] });
    // The geometry is measured at the first section's heading row.
    expect(within(section).getByTestId('case-tab-first')).toContainElement(heading);
  });

  it('renders a hostile trigger sentence as text', () => {
    renderEvidence({ ...CASE, trigger_reason: { sentence: '<img src=x onerror=alert(1)>' } } as unknown as Case);
    expect(screen.getByTestId('evidence-trigger')).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('EvidencePanel: entities', () => {
  it('shows the primary entity with its scope, type, copy and Ask AI, and its enrichment', () => {
    renderEvidence({
      ...CASE,
      entity: { type: 'ip', value: '198.51.100.7' },
      enrichment: { country: 'NL', asn: 'AS64500', reputation_score: 87 },
    } as unknown as Case);
    const section = screen.getByTestId('evidence-entities');
    expect(within(section).getByText('198.51.100.7')).toBeInTheDocument();
    expect(within(section).getByText('External')).toBeInTheDocument();
    expect(within(section).getByText('IP')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Copy indicator' })).toBeInTheDocument();
    expect(within(section).getByText('NL')).toBeInTheDocument();
    expect(within(section).getByText('AS64500')).toHaveClass('font-mono');
    expect(within(section).getByText('87')).toBeInTheDocument();
  });

  it('says when no primary entity was recorded', () => {
    renderEvidence();
    expect(screen.getByText('No primary entity was recorded for this case.')).toBeInTheDocument();
  });
});

describe('EvidencePanel: threat context and related cases', () => {
  it('holds Threat context as a section a retired Threat context link scrolls to', () => {
    renderEvidence(CASE, { threatContext: <p>MITRE and reputation</p> });
    const section = screen.getByTestId('evidence-threat-context');
    expect(section).toHaveAttribute('data-section', 'threat-context');
    expect(within(section).getByText('MITRE and reputation')).toBeInTheDocument();
  });

  it('lists related cases in a section the inspector links to, and never merges them', async () => {
    listCasesMock.mockResolvedValueOnce({ cases: [{ case_id: 'c2', title: 'Same user, other source' }] });
    const onNavigate = vi.fn();
    renderEvidence(
      { ...CASE, related_case_ids: ['c2', 'c1'], source_breakdown: { 'demo-splunk': 3 } } as unknown as Case,
      { onNavigate },
    );
    const section = screen.getByTestId('evidence-related');
    expect(section).toHaveAttribute('data-section', 'related-cases');
    expect(section).toHaveTextContent(/never merged/i);
    const link = await within(section).findByRole('button', { name: 'Same user, other source' });
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith('case_manager', { caseId: 'c2' });
    expect(within(section).getByText('demo-splunk')).toBeInTheDocument();
  });

  it('is not rendered without cross-source data', () => {
    renderEvidence();
    expect(screen.queryByTestId('evidence-related')).toBeNull();
  });
});

describe('EvidencePanel: one lane', () => {
  it('shows no AI provenance tag: the source lane holds no AI work', async () => {
    listCasesMock.mockClear();
    const { container } = renderEvidence(
      {
        ...CASE,
        entity: { type: 'ip', value: '10.0.0.5' },
        related_case_ids: ['c2'],
        trigger_reason: { sentence: 'Five failures.' },
      } as unknown as Case,
      { sourceStory: <p>Ingestion stage</p>, threatContext: <p>Threat</p> },
    );
    await waitFor(() => expect(listCasesMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-provenance="ai"]')).toBeNull();
    expect(container.querySelectorAll('.uppercase, .tracking-tight, .tracking-wide')).toHaveLength(0);
    for (const heading of screen.getAllByRole('heading', { level: 2 })) {
      expect(heading.querySelector('svg')).toBeNull();
    }
  });

  it('has no automated accessibility violations', async () => {
    const { container } = renderEvidence(
      { ...CASE, entity: { type: 'ip', value: '10.0.0.5' }, trigger_reason: { sentence: 'Five failures.' } } as unknown as Case,
      { sourceStory: <p>Ingestion stage</p> },
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
