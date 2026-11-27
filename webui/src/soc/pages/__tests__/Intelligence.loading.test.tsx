import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  ragStats: vi.fn(),
  ragDocuments: vi.fn(),
  getMemory: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      ragStats: mocks.ragStats,
      ragDocuments: mocks.ragDocuments,
      getMemory: mocks.getMemory,
    },
  };
});

vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  return { ...actual, useCan: () => false };
});

import Knowledge from '../Knowledge';
import Memory from '../Memory';
import Intelligence from '../Intelligence';
import { TooltipProvider } from '@/ui/tooltip';

function widthAuthorities(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[class]')).filter((node) =>
    (node.getAttribute('class') ?? '').includes('max-w-[1760px]'),
  );
}

describe('Intelligence blocking loads', () => {
  // Round 14 (IN2): the leaves no longer draw a "controls" band under the host header;
  // while the first load runs there is only the one blocking state (no Refresh to press).
  it('uses one host heading, one width authority and no leaf control band while Knowledge boots', () => {
    mocks.ragStats.mockReturnValue(new Promise<never>(() => {}));
    mocks.ragDocuments.mockReturnValue(new Promise<never>(() => {}));

    const { container } = render(
      <TooltipProvider>
        <Intelligence tab="knowledge" />
      </TooltipProvider>,
    );

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Knowledge corpus' })).toBeInTheDocument();
    expect(widthAuthorities(container)).toHaveLength(1);
    expect(screen.queryByRole('group', { name: 'Knowledge corpus controls' })).toBeNull();
    expect(screen.queryByText('Knowledge controls')).toBeNull();
    expect(screen.getByText('Loading knowledge corpus')).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(screen.queryByText('Corpus by source')).not.toBeInTheDocument();
  });

  it('uses one host heading and no leaf control band while durable memory boots', () => {
    mocks.getMemory.mockReturnValue(new Promise<never>(() => {}));

    render(
      <TooltipProvider>
        <Intelligence tab="memory" />
      </TooltipProvider>,
    );

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Operator memory' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Operator memory controls' })).toBeNull();
    expect(screen.queryByText('Memory controls')).toBeNull();
    expect(screen.getByText('Loading memory')).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(screen.queryByText('Saved memories')).not.toBeInTheDocument();
  });

  it('preserves the standalone Knowledge page header', () => {
    mocks.ragStats.mockReturnValue(new Promise<never>(() => {}));
    mocks.ragDocuments.mockReturnValue(new Promise<never>(() => {}));

    render(<Knowledge />);

    expect(screen.getByRole('heading', { level: 1, name: 'Knowledge & RAG' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Knowledge corpus controls' })).not.toBeInTheDocument();
  });

  it('preserves the standalone Memory page header', () => {
    mocks.getMemory.mockReturnValue(new Promise<never>(() => {}));

    render(<Memory />);

    expect(screen.getByRole('heading', { level: 1, name: 'Memory' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Operator memory controls' })).not.toBeInTheDocument();
  });
});

describe('Intelligence leaves after the first load (Round 14, IN2 to IN5, F19)', () => {
  it('puts the Knowledge Refresh on the documents panel and the counts on a compact strip', async () => {
    mocks.ragStats.mockResolvedValue({
      total_chunks: 120,
      document_count: 2,
      embedding_model: 'mock-embed',
      dim: 384,
      by_source: { threat_context: 20, resolved_case: 100 },
    });
    mocks.ragDocuments.mockResolvedValue({
      documents: [
        { document_id: 'd1', title: 'Advisory', source: 'threat_context', chunk_count: 20, tags: [] },
        { document_id: 'd2', title: 'Case 12', source: 'resolved_case', chunk_count: 100, tags: [] },
      ],
    });

    render(
      <TooltipProvider>
        <Intelligence tab="knowledge" />
      </TooltipProvider>,
    );

    const documents = await screen.findByRole('region', { name: 'Indexed documents' });
    expect(within(documents).getByRole('button', { name: 'Refresh knowledge' })).toBeInTheDocument();
    const strip = screen.getByRole('group', { name: 'Corpus summary' });
    expect(strip).toHaveAttribute('data-kpi-strip', 'compact');
    // The embedding model is a plain line, never a numeral tile.
    expect(within(strip).queryByText('mock-embed')).toBeNull();
    expect(screen.getByTestId('knowledge-embedding-model')).toHaveTextContent('Embedding model mock-embed');
    // IN4: one series colour, the share of the total on the label row.
    const bySource = screen.getByRole('region', { name: 'Corpus by source' });
    expect(within(bySource).getByText('100 · 83%')).toBeInTheDocument();
    expect(bySource.querySelector('.bg-critical, .bg-success, .bg-info')).toBeNull();
    // F19: the document count is in each source panel's title row.
    const threat = screen.getByRole('region', { name: 'Threat intel' });
    expect(threat.querySelector('[data-panel-title-row] [data-panel-count]')).toHaveTextContent('1 doc');
  });

  it('puts the Memory Refresh and help on the saved-memories panel, with no callout', async () => {
    mocks.getMemory.mockResolvedValue({
      entries: [
        { id: 'm1', text: 'Fact one', source: 'human', active: true, category: 'network', tags: [] },
      ],
    });

    render(
      <TooltipProvider>
        <Intelligence tab="memory" />
      </TooltipProvider>,
    );

    const saved = await screen.findByRole('region', { name: 'Saved memories' });
    expect(within(saved).getByRole('button', { name: 'Refresh memory' })).toBeInTheDocument();
    expect(within(saved).getByRole('button', { name: 'About memory' })).toBeInTheDocument();
    expect(screen.queryByText('What is memory?')).toBeNull();
    expect(screen.getByRole('group', { name: 'Memory summary' })).toHaveAttribute('data-kpi-strip', 'compact');
    // Group titles are sentence case, not tracked capitals.
    const group = within(saved).getByRole('heading', { level: 3, name: 'Network' });
    expect(group.className).not.toMatch(/uppercase|tracking-/);
  });
});
