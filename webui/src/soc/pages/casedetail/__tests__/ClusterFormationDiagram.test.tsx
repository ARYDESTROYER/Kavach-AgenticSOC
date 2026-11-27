/**
 * ClusterFormationDiagram (Round 14, SPEC §4.9.2): each node names its role in the flow
 * with a plain sentence-case label (no overline prop), uses the radius scale (no arbitrary
 * radius) and keeps its copy free of dashes used as punctuation.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
vi.mock('@/soc/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/router')>()),
  useNavigateOptional: () => navigate,
}));

import { ClusterFormationDiagram, type ClusterExplanation } from '../ClusterFormationDiagram';

const data: ClusterExplanation = {
  available: true,
  cluster_id: 'abcdef0123456789',
  input_count: 3,
  input_refs: ['h-1', 'h-2', 'h-3'],
  source_breakdown: { wazuh: 2, splunk: 1 },
  correlation: { mode: 'threshold', window_seconds: 300, group_by: 'source.ip', observed_count: 3 },
  opened_case: { case_id: 'case-1', display_id: 'CASE-000048', status: 'open', verdict: 'needs_human' },
};

describe('ClusterFormationDiagram', () => {
  it('labels each node by its role in plain sentence case', () => {
    render(<ClusterFormationDiagram data={data} />);
    const section = screen.getByRole('region', { name: 'How this case was clustered' });
    for (const label of ['Input alerts', 'Correlation cluster', 'Opened case']) {
      const node = within(section).getByText(label);
      expect(node).toHaveClass('text-xs', 'font-medium');
      expect(node.className).not.toMatch(/uppercase|tracking-/);
    }
    expect(within(section).getByText('CASE-000048')).toBeInTheDocument();
  });

  it('draws nodes on the radius scale, never an arbitrary radius', () => {
    const { container } = render(<ClusterFormationDiagram data={data} />);
    expect(container.innerHTML).not.toMatch(/rounded-\[/);
    const nodes = screen.getAllByRole('button');
    expect(nodes).toHaveLength(3);
    nodes.forEach((node) => expect(node).toHaveClass('rounded-md'));
  });

  it('renders nothing when the explanation is unavailable', () => {
    const { container } = render(<ClusterFormationDiagram data={{ available: false }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names each related case by its case number and opens it (cross-cutting review)', () => {
    navigate.mockReset();
    render(
      <ClusterFormationDiagram
        data={{
          ...data,
          related_cases: [
            {
              case_id: 'demo-tune-00000049-0001',
              case_number: 'CASE-000049',
              relationship: 'same_entity_history',
              verdict: 'false_positive',
            },
            { case_id: 'legacy-id-without-number', relationship: 'cross_source' },
          ],
        }}
      />,
    );
    const list = screen.getByTestId('cluster-related-cases');
    const link = within(list).getByRole('link', { name: 'Open case CASE-000049' });
    // The number is the label; the internal id stays only in the tooltip.
    expect(link).toHaveTextContent(/^CASE-000049$/);
    expect(link).toHaveAttribute('title', 'demo-tune-00000049-0001');
    expect(link).toHaveAttribute('href', '#/case_manager?caseId=demo-tune-00000049-0001');
    expect(link).toHaveClass('font-mono', 'text-primary');
    expect(list.textContent).not.toMatch(/demo-tune/);
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('case_manager', { caseId: 'demo-tune-00000049-0001' });
    // A row without a number still opens its case, named by the full id (never cut).
    expect(
      within(list).getByRole('link', { name: 'Open case legacy-id-without-number' }),
    ).toHaveTextContent(/^legacy-id-without-number$/);
  });

  it('keeps the visible flow free of dashes used as punctuation', () => {
    const { container } = render(<ClusterFormationDiagram data={data} />);
    expect(container.textContent ?? '').not.toMatch(/[\u2013\u2014]/);
  });
});
