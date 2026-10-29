import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMemoryMock, updateMemoryMock, deleteMemoryMock } = vi.hoisted(() => ({
  getMemoryMock: vi.fn(),
  updateMemoryMock: vi.fn(),
  deleteMemoryMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getMemory: getMemoryMock,
      updateMemory: updateMemoryMock,
      deleteMemory: deleteMemoryMock,
    },
  };
});

vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  return { ...actual, useCan: () => true };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import Memory from '../Memory';

const pending = {
  id: 'memory-agent-1',
  text: 'Treat scanner-a as a known scanner.',
  source: 'agent',
  author: 'investigator',
  active: true,
  review_status: 'pending',
  created_at: '2026-08-02T12:00:00Z',
};

describe('Memory review boundary', () => {
  beforeEach(() => {
    getMemoryMock.mockReset();
    updateMemoryMock.mockReset();
    deleteMemoryMock.mockReset().mockResolvedValue({ ok: true });
    getMemoryMock.mockResolvedValue({ entries: [pending], count: 1 });
  });

  it('labels an agent suggestion as pending and keeps it out of the effective active count', async () => {
    render(<Memory embedded />);

    expect(await screen.findByText('Pending review')).toBeInTheDocument();
    expect(screen.getByText('1 not injected')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Memory pending review' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('requires an explicit manager update before presenting the fact as approved', async () => {
    updateMemoryMock.mockResolvedValue({
      ...pending,
      review_status: 'approved',
      approved_by: 'reviewer',
    });
    render(<Memory embedded />);
    await screen.findByText('Pending review');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(updateMemoryMock).toHaveBeenCalledWith('memory-agent-1', {
        review_status: 'approved',
      }),
    );
    await waitFor(() => expect(screen.queryByText('Pending review')).not.toBeInTheDocument());
  });
});

describe('Memory on the Round 14 console grammar (IN7, F10)', () => {
  beforeEach(() => {
    getMemoryMock.mockReset();
    getMemoryMock.mockResolvedValue({
      entries: [{ ...pending, id: 'm-op', source: 'human', review_status: 'approved', category: 'network' }],
      count: 1,
    });
  });

  it('heads the standalone page with a help tip and an icon Refresh, no eyebrow or callout', async () => {
    render(<Memory />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Memory' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Memory' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Refresh memory' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Platform')).toBeNull();
    expect(screen.queryByText('What is memory?')).toBeNull();
  });

  it('lays out Category and Tags as two Fields with the same label and help structure', async () => {
    render(<Memory embedded />);
    const fields = await screen.findByTestId('memory-add-fields');
    const category = screen.getByLabelText('Category (optional)');
    const tags = screen.getByLabelText('Tags (optional)');
    expect(fields).toContainElement(category);
    expect(fields).toContainElement(tags);
    expect(category).toHaveAccessibleDescription('For example network, scanners or policy.');
    expect(tags).toHaveAccessibleDescription(/Type a tag and press Enter\./);
    expect(fields).toHaveClass('items-start');
  });

  it('keeps the fact placeholder free of em dashes and the delete icon neutral at rest', async () => {
    render(<Memory embedded />);
    const fact = await screen.findByLabelText('Fact');
    expect(fact.getAttribute('placeholder') ?? '').not.toContain('—');
    const del = screen.getByRole('button', { name: 'Delete memory' });
    expect(del).toHaveClass('text-muted-foreground');
    expect(del.className).not.toMatch(/(^|\s)text-critical(\s|$)/);
  });

  it('filters through one FilterBar and shows "N of M shown" only while a filter is on', async () => {
    getMemoryMock.mockResolvedValue({
      entries: [
        { ...pending, id: 'a', source: 'human', review_status: 'approved', text: 'Alpha fact' },
        { ...pending, id: 'b', source: 'human', review_status: 'approved', text: 'Beta fact' },
      ],
      count: 2,
    });
    render(<Memory embedded />);
    const saved = await screen.findByRole('region', { name: 'Saved memories' });
    const count = () => saved.querySelector('[data-panel-count]')?.textContent;
    expect(count()).toBe('2');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search memories' }), {
      target: { value: 'alpha' },
    });
    await waitFor(() => expect(count()).toBe('1 of 2 shown'));
    expect(screen.queryByText('Beta fact')).toBeNull();
  });

  it('shows one count on the saved-memories panel and does not repeat the strip under it', async () => {
    getMemoryMock.mockResolvedValue({
      entries: [
        { ...pending, id: 'a', source: 'human', review_status: 'approved', text: 'Alpha fact' },
        { ...pending, id: 'b', source: 'human', review_status: 'approved', text: 'Beta fact', active: false },
      ],
      count: 2,
    });
    render(<Memory embedded />);
    const saved = await screen.findByRole('region', { name: 'Saved memories' });
    expect(saved.querySelector('[data-panel-count]')?.textContent).toBe('2');
    // The "N active" caption repeated the strip's Active tile ("0  0 active" on an empty store).
    expect(saved.querySelector('[data-panel-caption]')).toBeNull();
    expect(within(saved).queryByText(/\d+ active$/)).toBeNull();
  });

  it('returns focus to the row Delete button when the delete dialog is cancelled (SPEC §3.3)', async () => {
    render(<Memory embedded />);
    const del = await screen.findByRole('button', { name: 'Delete memory' });
    del.focus();
    fireEvent.click(del);
    const dialog = await screen.findByRole('dialog', { name: 'Delete this memory?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(del));
  });

  it("moves focus to the next row's Delete after a confirmed delete, then to the panel heading", async () => {
    getMemoryMock.mockResolvedValue({
      entries: [
        { ...pending, id: 'a', source: 'human', review_status: 'approved', text: 'Alpha fact' },
        { ...pending, id: 'b', source: 'human', review_status: 'approved', text: 'Beta fact' },
      ],
      count: 2,
    });
    render(<Memory embedded />);
    const [first] = await screen.findAllByRole('button', { name: 'Delete memory' });
    fireEvent.click(first);
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Delete this memory?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Delete memory' })).toHaveLength(1));
    const [next] = screen.getAllByRole('button', { name: 'Delete memory' });
    await waitFor(() => expect(document.activeElement).toBe(next));

    fireEvent.click(next);
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Delete this memory?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    const heading = await screen.findByRole('heading', { name: 'Saved memories' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(deleteMemoryMock).toHaveBeenCalledTimes(2);
  });
});
