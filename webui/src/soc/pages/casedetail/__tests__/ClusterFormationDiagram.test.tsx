/**
 * ClusterFormationDiagram (Round 14, SPEC §4.9.2): each node names its role in the flow
 * with a plain sentence-case label (no overline prop), uses the radius scale (no arbitrary
 * radius) and keeps its copy free of dashes used as punctuation.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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

  it('keeps the visible flow free of dashes used as punctuation', () => {
    const { container } = render(<ClusterFormationDiagram data={data} />);
    expect(container.textContent ?? '').not.toMatch(/[\u2013\u2014]/);
  });
});
