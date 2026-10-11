/**
 * NavSidebar — the chat "agent is working" indicator on every nav form (Round 12,
 * SPEC D13): the collapsed rail badge and its flyout, the expanded parent and child
 * rows, the tooltip and `aria-describedby` text (never `aria-busy` on a nav button),
 * reduced motion ("Working"), Case Manager for case-scoped turns, and the brand ring
 * that never animates an operator's logo.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { TooltipProvider } from '@/ui/tooltip';

expect.extend(toHaveNoViolations);

vi.mock('../../auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../../prefs', () => ({ usePrefs: () => ({ prefs: { misc: {} }, ready: true }) }));
vi.mock('@/lib/api', () => ({ api: { prefs: { putUser: () => Promise.resolve({}) } } }));

import { NavSidebar } from '../NavSidebar';
import { clearChatActivity, putChatActivity, setAnimatedBrand, type ChatActivity } from '../../chat-activity/activity';

function entry(patch: Partial<ChatActivity> & { scope: string }): ChatActivity {
  return {
    kind: 'workspace',
    conversationId: 'c1',
    caseId: null,
    turnId: 't1',
    requestKey: null,
    title: 'Investigate host X',
    label: 'Searching logs',
    lookups: 1,
    status: 'running',
    startedAt: 1,
    source: 'local',
    ...patch,
  };
}

function renderNav(props: Partial<React.ComponentProps<typeof NavSidebar>> = {}) {
  return render(
    <TooltipProvider>
      <NavSidebar
        page="overview"
        onNavigate={vi.fn()}
        collapsed={false}
        openGroups={new Set<string>(['chat'])}
        onToggleGroup={vi.fn()}
        onOpenGroup={vi.fn()}
        {...props}
      />
    </TooltipProvider>,
  );
}

const describedText = (element: HTMLElement) => {
  const id = element.getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent ?? null : null;
};

beforeEach(() => {
  clearChatActivity();
  setAnimatedBrand(true);
});

afterEach(() => {
  clearChatActivity();
});

describe('NavSidebar — chat activity (expanded)', () => {
  it('shows nothing while no answer is being written', () => {
    const { container } = renderNav();
    expect(container.querySelector('[data-activity]')).toBeNull();
    for (const row of screen.getAllByTestId('nav-chat')) expect(row).not.toHaveAttribute('aria-describedby');
    expect(container.querySelector('.chat-brand-ring')).toBeNull();
  });

  it('turns a ring on the Workspace row and its Chat leaf, describes it, and never sets aria-busy', () => {
    putChatActivity(entry({ scope: 'conv:c1' }));
    const { container } = renderNav();
    const rows = screen.getAllByTestId('nav-chat');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelector('[data-activity="running"]')).not.toBeNull();
      expect(describedText(row)).toBe('Chat: 1 answer in progress: Investigate host X');
      // The accessible name stays the plain label.
      expect(row).not.toHaveAccessibleName(/progress/);
      expect(row).not.toHaveAttribute('aria-busy');
    }
    expect(container.querySelectorAll('nav [aria-busy]')).toHaveLength(0);
    expect(container.querySelector('.chat-brand-ring')).not.toBeNull();
  });

  it('uses an accent dot for an unread answer, amber for a question, red for a failure', () => {
    putChatActivity(entry({ scope: 'conv:c1', status: 'unread' }));
    const { container, unmount } = renderNav();
    expect(container.querySelector('.chat-activity[data-activity="unread"]')).not.toBeNull();
    expect(describedText(screen.getAllByTestId('nav-chat')[0])).toBe('Chat: 1 new answer: Investigate host X');
    unmount();
    act(() => putChatActivity(entry({ scope: 'conv:c1', status: 'needs_input' })));
    const second = renderNav();
    expect(second.container.querySelector('.chat-activity[data-activity="needs_input"]')).not.toBeNull();
    second.unmount();
    act(() => putChatActivity(entry({ scope: 'conv:c1', status: 'failed' })));
    const third = renderNav();
    expect(third.container.querySelector('.chat-activity[data-activity="failed"]')).not.toBeNull();
    // No brand ring once nothing is running.
    expect(third.container.querySelector('.chat-brand-ring')).toBeNull();
  });

  it('marks Case Manager for a case-scoped turn', () => {
    putChatActivity(entry({ scope: 'case:case-4', kind: 'case', caseId: 'case-4', conversationId: null, title: 'Summarize Case' }));
    renderNav();
    const caseManager = screen.getByTestId('nav-case_manager');
    expect(caseManager.querySelector('[data-activity="running"]')).not.toBeNull();
    expect(describedText(caseManager)).toBe('Case chat: 1 answer in progress: Case case-4: Summarize Case');
    expect(screen.getAllByTestId('nav-chat')[0].querySelector('[data-activity]')).toBeNull();
  });

  it('animates only the ring around an operator’s logo, never the logo', () => {
    putChatActivity(entry({ scope: 'conv:c1' }));
    const { container } = renderNav({ logoUrl: 'data:image/png;base64,AAAA' });
    const logo = container.querySelector('img');
    expect(logo?.className).not.toMatch(/animate|chat-brand-ring|chat-activity|spin/);
    expect(container.querySelector('.chat-brand-ring')).not.toBeNull();
    // The ring is the logo's sibling, never the logo or its parent's transform.
    expect(container.querySelector('.chat-brand-ring')?.parentElement).toBe(logo?.parentElement);
    act(() => setAnimatedBrand(false));
    expect(container.querySelector('.chat-brand-ring')).toBeNull();
    // The nav glyph stays: the switch only governs the brand ring.
    expect(screen.getAllByTestId('nav-chat')[0].querySelector('[data-activity="running"]')).not.toBeNull();
  });

  it('explains every glyph it draws, also a question the analyst already looked at', () => {
    // Seen questions keep their amber dot until answered: the dot is never unexplained.
    putChatActivity(entry({ scope: 'conv:c1', status: 'needs_input', seen: true, title: 'Which host?' }));
    putChatActivity(entry({ scope: 'case:k', kind: 'case', caseId: 'k', conversationId: null, status: 'needs_input', seen: true, title: 'Which user?' }));
    for (const collapsed of [false, true]) {
      const { container, unmount } = renderNav({ collapsed });
      const glyphs = Array.from(container.querySelectorAll('[data-activity]'));
      expect(glyphs.length).toBeGreaterThan(0);
      for (const glyph of glyphs) {
        const host = glyph.closest('button') as HTMLElement;
        expect(describedText(host)).toMatch(/question waiting for your answer: (Case k: )?Which (host|user)\?$/);
      }
      unmount();
    }
  });

  it('is axe-clean with activity on', async () => {
    putChatActivity(entry({ scope: 'conv:c1' }));
    putChatActivity(entry({ scope: 'case:k', kind: 'case', caseId: 'k', conversationId: null, status: 'unread' }));
    const { container } = renderNav();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('NavSidebar — chat activity (collapsed rail)', () => {
  it('badges the rail button and repeats the state in the flyout', () => {
    putChatActivity(entry({ scope: 'conv:c1' }));
    renderNav({ collapsed: true });
    const rail = screen.getByRole('button', { name: 'Workspace' });
    expect(rail.querySelector('.chat-activity-badge[data-activity="running"]')).not.toBeNull();
    expect(describedText(rail)).toBe('Chat: 1 answer in progress: Investigate host X');
    act(() => rail.focus());
    expect(within(screen.getByTestId('nav-flyout-chat')).getByText('Chat: 1 answer in progress: Investigate host X')).toBeInTheDocument();
    const chatLeaf = within(screen.getByTestId('nav-flyout-chat')).getByRole('button', { name: 'Chat' });
    expect(chatLeaf.querySelector('[data-activity="running"]')).not.toBeNull();
  });

  it('says "Working" when the ring stands still (reduced motion)', () => {
    putChatActivity(entry({ scope: 'conv:c1' }));
    renderNav({ collapsed: true, reducedMotion: true });
    const rail = screen.getByRole('button', { name: 'Workspace' });
    act(() => rail.focus());
    expect(within(screen.getByTestId('nav-flyout-chat')).getByText(/^Working\. Chat: 1 answer in progress/)).toBeInTheDocument();
  });
});
