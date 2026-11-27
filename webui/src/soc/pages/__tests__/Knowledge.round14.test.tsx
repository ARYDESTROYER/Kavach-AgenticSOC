/**
 * Knowledge page, Round 14 fix pass (W9b): proper names and focus return.
 *
 * Proves:
 *  - a corpus source is spelled the way its owner writes it ("MITRE", never "Mitre"), on
 *    the source badge, the "Corpus by source" bars and the filter options;
 *  - the document sheet and the delete dialog open from state, so each hands focus back to
 *    the row button that opened it when it closes (SPEC §3.3);
 *  - a confirmed delete takes that button away when the list reloads: focus then moves to
 *    the next row's Delete, else the documents heading, never to the page body.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  ragStats: vi.fn(),
  ragDocuments: vi.fn(),
  ragDocument: vi.fn(),
  ragDeleteDocument: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      ragStats: mocks.ragStats,
      ragDocuments: mocks.ragDocuments,
      ragDocument: mocks.ragDocument,
      ragDeleteDocument: mocks.ragDeleteDocument,
    },
  };
});

vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  // Grant everything; `Can` renders its children (the real one reads the auth context).
  return {
    ...actual,
    useCan: () => true,
    Can: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Knowledge from '../Knowledge';
import { TooltipProvider } from '@/ui/tooltip';

const DOCS = [
  { document_id: 'd1', title: 'ATT&CK techniques', source: 'mitre', chunk_count: 30, tags: [] },
  { document_id: 'd2', title: 'Advisory', source: 'threat_context', chunk_count: 20, tags: [] },
];

function renderKnowledge() {
  return render(
    <TooltipProvider>
      <Knowledge />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  mocks.ragStats.mockResolvedValue({
    total_chunks: 50,
    document_count: 2,
    embedding_model: 'mock-embed',
    dim: 384,
    by_source: { mitre: 30, threat_context: 20 },
  });
  mocks.ragDocuments.mockResolvedValue({ documents: DOCS });
  mocks.ragDocument.mockResolvedValue({ ...DOCS[1], chunks: [{ chunk_id: 'c1', text: 'chunk text' }] });
  mocks.ragDeleteDocument.mockResolvedValue({ ok: true });
});

describe('Knowledge, Round 14 fix pass', () => {
  it('spells the MITRE corpus as MITRE on the bars and the badge, never "Mitre"', async () => {
    const { container } = renderKnowledge();
    const documents = await screen.findByRole('region', { name: 'Indexed documents' });
    const bySource = screen.getByRole('region', { name: 'Corpus by source' });
    expect(within(bySource).getByText('MITRE')).toBeInTheDocument();
    expect(within(documents).getAllByText('MITRE').length).toBeGreaterThan(0);
    expect(container.textContent ?? '').not.toMatch(/\bMitre\b/);
  });

  it('returns focus to the row View button when the document sheet closes', async () => {
    renderKnowledge();
    const documents = await screen.findByRole('region', { name: 'Indexed documents' });
    const view = within(documents).getAllByRole('button', { name: 'View document chunks' })[0];
    view.focus();
    fireEvent.click(view);
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(view));
  });

  it('returns focus to the row Delete button when the delete dialog is cancelled', async () => {
    renderKnowledge();
    const documents = await screen.findByRole('region', { name: 'Indexed documents' });
    const del = within(documents).getAllByRole('button', { name: 'Delete from the corpus' })[0];
    del.focus();
    fireEvent.click(del);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(del));
  });

  it("moves focus to the next row's Delete after a confirmed delete, then to the heading", async () => {
    let remaining = [...DOCS];
    // The list reload can be held back, so the dialog has closed and handed focus back to
    // the row's Delete before the row leaves.
    let reloadGate: Promise<void> | null = null;
    mocks.ragDocuments.mockImplementation(async () => {
      if (reloadGate) await reloadGate;
      return { documents: remaining };
    });
    mocks.ragDeleteDocument.mockImplementation(async (id: string) => {
      remaining = remaining.filter((doc) => doc.document_id !== id);
      return { ok: true };
    });
    renderKnowledge();
    const documents = await screen.findByRole('region', { name: 'Indexed documents' });
    const deleteButtons = () => within(documents).queryAllByRole('button', { name: 'Delete from the corpus' });
    await waitFor(() => expect(deleteButtons()).toHaveLength(2));

    const first = deleteButtons()[0];
    first.focus();
    let releaseReload!: () => void;
    reloadGate = new Promise<void>((resolve) => (releaseReload = resolve));
    fireEvent.click(first);
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /^(Force delete|Delete)$/ }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(first));
    reloadGate = null;
    await act(async () => releaseReload());
    await waitFor(() => expect(deleteButtons()).toHaveLength(1));
    await waitFor(() => expect(document.activeElement).toBe(deleteButtons()[0]));

    const last = deleteButtons()[0];
    fireEvent.click(last);
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /^(Force delete|Delete)$/ }),
    );
    await waitFor(() => expect(deleteButtons()).toHaveLength(0));
    const heading = within(documents).getByRole('heading', { name: 'Indexed documents' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(mocks.ragDeleteDocument).toHaveBeenCalledTimes(2);
  });
});
