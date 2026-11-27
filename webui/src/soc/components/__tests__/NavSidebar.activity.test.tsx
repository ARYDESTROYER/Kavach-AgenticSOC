/**
 * NavSidebar — the chat "agent is working" indicator on every nav form (Round 12,
 * SPEC D13): the collapsed rail badge and its flyout, the expanded parent and child
 * rows, the tooltip and `aria-describedby` text (never `aria-busy` on a nav button),
 * reduced motion ("Working"), Case Manager for case-scoped turns, and the brand ring
 * that never animates an operator's logo.
 */
import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { TooltipProvider } from '@/ui/tooltip';

expect.extend(toHaveNoViolations);

vi.mock('../../auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../../prefs', () => ({ usePrefs: () => ({ prefs: { misc: {} }, ready: true }) }));
vi.mock('@/lib/api', () => ({ api: { prefs: { putUser: () => Promise.resolve({}) } } }));

import { NavSidebar } from '../NavSidebar';
import { navStore } from '../../nav-store';
import { loadRailInteractions } from '../nav-rail-loader';
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

/** The navigation with the Workspace group open (rail state from the store). */
function renderNav({ collapsed = false, ...props }: Partial<React.ComponentProps<typeof NavSidebar>> & { collapsed?: boolean } = {}) {
  window.localStorage.setItem('soc.nav.collapsed', collapsed ? '1' : '0');
  window.localStorage.setItem('soc.nav.openGroups', JSON.stringify(['chat']));
  navStore.beginSession();
  return render(
    <TooltipProvider>
      <NavSidebar page="overview" onNavigate={vi.fn()} {...props} />
    </TooltipProvider>,
  );
}

/** The Workspace row and its Chat page (the host shares its id with that page). */
const chatRows = () => [screen.getByTestId('nav-chat'), screen.getByTestId('nav-chat-page')];

const describedText = (element: HTMLElement) => {
  const id = element.getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent ?? null : null;
};

// The collapsed rail's flyout is a lazy chunk (`nav-rail-loader.ts`): load it before rendering.
beforeAll(async () => {
  await loadRailInteractions();
});

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
    for (const row of chatRows()) expect(row).not.toHaveAttribute('aria-describedby');
    expect(container.querySelector('.chat-brand-ring')).toBeNull();
  });

  it('turns a ring on the Workspace row and its Chat leaf, describes it, and never sets aria-busy', () => {
    putChatActivity(entry({ scope: 'conv:c1' }));
    const { container } = renderNav();
    for (const row of chatRows()) {
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
    expect(describedText(screen.getByTestId('nav-chat'))).toBe('Chat: 1 new answer: Investigate host X');
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
    expect(screen.getByTestId('nav-chat').querySelector('[data-activity]')).toBeNull();
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
    expect(screen.getByTestId('nav-chat').querySelector('[data-activity="running"]')).not.toBeNull();
  });

  it('explains every amber glyph it draws, and draws none for a question the analyst already looked at', () => {
    putChatActivity(entry({ scope: 'conv:c1', status: 'needs_input', title: 'Which host?' }));
    putChatActivity(entry({ scope: 'case:k', kind: 'case', caseId: 'k', conversationId: null, status: 'needs_input', title: 'Which user?' }));
    for (const collapsed of [false, true]) {
      const { container, unmount } = renderNav({ collapsed });
      const glyphs = Array.from(container.querySelectorAll('[data-activity="needs_input"]'));
      expect(glyphs.length).toBeGreaterThan(0);
      for (const glyph of glyphs) {
        const host = glyph.closest('a') as HTMLElement;
        expect(describedText(host)).toMatch(/question needs your input: (Case k: )?Which (host|user)\?$/);
      }
      unmount();
    }
    // Looked at (seen) and left unanswered: no mark on any page, and no text without a mark.
    putChatActivity(entry({ scope: 'conv:c1', status: 'needs_input', seen: true, title: 'Which host?' }));
    putChatActivity(entry({ scope: 'case:k', kind: 'case', caseId: 'k', conversationId: null, status: 'needs_input', seen: true, title: 'Which user?' }));
    for (const collapsed of [false, true]) {
      const { container, unmount } = renderNav({ collapsed });
      expect(container.querySelectorAll('[data-activity]')).toHaveLength(0);
      expect(container.textContent).not.toMatch(/question/);
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
    const rail = screen.getByRole('link', { name: 'Workspace' });
    // The rail badge sits on the icon (top right); the label's glyph is drawer-only.
    expect(rail.querySelector('.nav-railmark [data-activity="running"]')).not.toBeNull();
    expect(describedText(rail)).toBe('Chat: 1 answer in progress: Investigate host X');
    act(() => rail.focus());
    expect(within(screen.getByTestId('nav-flyout-chat')).getByText('Chat: 1 answer in progress: Investigate host X')).toBeInTheDocument();
    const chatLeaf = within(screen.getByTestId('nav-flyout-chat')).getByRole('link', { name: 'Chat' });
    expect(chatLeaf.querySelector('[data-activity="running"]')).not.toBeNull();
  });

  it('says "Working" when the ring stands still (reduced motion)', () => {
    putChatActivity(entry({ scope: 'conv:c1' }));
    renderNav({ collapsed: true, reducedMotion: true });
    const rail = screen.getByRole('link', { name: 'Workspace' });
    act(() => rail.focus());
    expect(within(screen.getByTestId('nav-flyout-chat')).getByText(/^Working\. Chat: 1 answer in progress/)).toBeInTheDocument();
  });
});

describe('NavSidebar — the brand ring below sm (Round 13, SPEC-chat T32)', () => {
  it('draws the brand ring only from sm: on a phone the Chat item\'s glyph alone turns', () => {
    putChatActivity(entry({ scope: 'conv:c1' }));
    const { container } = renderNav();
    const ring = container.querySelector('.chat-brand-ring') as HTMLElement;
    expect(ring).not.toBeNull();
    // The brand tile hides its ring below sm (the phone sheet) and keeps it from sm.
    const tile = ring.parentElement as HTMLElement;
    expect(tile).toHaveClass('max-sm:[&>.chat-brand-ring]:hidden');
    expect(tile.querySelector('img, svg')).not.toBeNull();
    // The Chat destination keeps its own turning glyph at every width.
    for (const row of chatRows()) {
      const glyph = row.querySelector('[data-activity="running"]');
      expect(glyph).not.toBeNull();
      expect(glyph?.closest('.hidden')).toBeNull();
    }
  });
});
