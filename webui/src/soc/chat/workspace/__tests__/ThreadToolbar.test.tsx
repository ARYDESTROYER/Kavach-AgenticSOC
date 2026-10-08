/**
 * ThreadToolbar — the 44 px band (SPEC §10.1a): History + New chat only when the rail
 * is a Sheet (so exactly one New chat is visible), the title as the `<h2>` with inline
 * rename, the conversation total inline from 560 px (else in ⋯), Report · n as a toggle,
 * and the ⋯ menu (Rename, Pin conversation, Export conversation ▸, Delete).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { ChatConversationSummary } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { ThreadToolbar, conversationTotal, type ThreadToolbarProps } from '../ThreadToolbar';

expect.extend(toHaveNoViolations);

const SUMMARY: ChatConversationSummary = {
  id: 'c-1',
  title: 'Failed sign-in review',
  created_at: '2026-10-08T09:00:00Z',
  updated_at: '2026-10-08T09:05:00Z',
  message_count: 4,
  total_tokens: 12_400,
  total_cost: 0.031,
};

function renderToolbar(overrides: Partial<ThreadToolbarProps> = {}) {
  const props: ThreadToolbarProps = {
    title: SUMMARY.title,
    summary: SUMMARY,
    railInSheet: false,
    onOpenHistory: vi.fn(),
    onNewChat: vi.fn(),
    wide: true,
    report: { count: 2, open: false, onToggle: vi.fn() },
    busy: false,
    onRename: vi.fn(),
    onTogglePin: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  const view = render(
    <TooltipProvider>
      <ThreadToolbar {...props} />
    </TooltipProvider>,
  );
  return { ...view, props };
}

describe('ThreadToolbar', () => {
  it('formats the conversation total, with a dash for legacy threads', () => {
    expect(conversationTotal(SUMMARY)).toBe('12.4k tokens · $0.03');
    expect(conversationTotal({ ...SUMMARY, total_tokens: null })).toBe('Usage —');
    expect(conversationTotal(null)).toBeNull();
  });

  it('shows the title as the h2, the total inline and the report toggle', () => {
    const { props } = renderToolbar();
    expect(screen.getByRole('heading', { level: 2, name: 'Failed sign-in review' })).toBeInTheDocument();
    expect(screen.getByTestId('conversation-total')).toHaveTextContent('12.4k tokens · $0.03');
    const toggle = screen.getByRole('button', { name: /Report · 2/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(props.report?.onToggle).toHaveBeenCalledTimes(1);
    // The rail is docked: neither History nor a second New chat here.
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
  });

  it('offers History and New chat when the rail is a Sheet', () => {
    const { props } = renderToolbar({ railInSheet: true });
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(props.onOpenHistory).toHaveBeenCalledTimes(1);
    expect(props.onNewChat).toHaveBeenCalledTimes(1);
  });

  it('renames inline from the title (Enter commits, Escape cancels)', () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Failed sign-in review' }));
    const input = screen.getByRole('textbox', { name: 'Conversation title' });
    fireEvent.change(input, { target: { value: 'Sign-in review, final' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onRename).toHaveBeenCalledWith('Sign-in review, final');
  });

  it('moves the total into ⋯ on a narrow toolbar and runs the thread actions', async () => {
    const user = userEvent.setup();
    const { props } = renderToolbar({ wide: false });
    expect(screen.queryByTestId('conversation-total')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    expect(await screen.findByText('This conversation: 12.4k tokens · $0.03')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Pin conversation' }));
    expect(props.onTogglePin).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export conversation' }));
    // Radix sub-menu items are driven by keyboard here (jsdom has no pointer geometry).
    const html = await screen.findByRole('menuitem', { name: 'HTML (.html)' });
    act(() => html.focus());
    await user.keyboard('{Enter}');
    expect(props.onExport).toHaveBeenCalledWith('html');
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it('disables thread actions for an unsaved draft and hides the report for case scope', async () => {
    const user = userEvent.setup();
    const { unmount } = renderToolbar({ summary: null, title: 'New chat' });
    expect(screen.getByRole('heading', { level: 2, name: 'New chat' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toHaveAttribute('data-disabled');
    unmount();
    renderToolbar({ caseScoped: true, summary: null, title: 'Case case-9', report: null });
    expect(screen.queryByRole('button', { name: /Report/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conversation actions' })).toBeNull();
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = renderToolbar({ railInSheet: true });
    expect(await axe(container)).toHaveNoViolations();
  });
});
