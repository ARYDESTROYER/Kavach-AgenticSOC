/**
 * NavSidebar: the AI investigation count on the Case Manager item (Round 16 SPEC §4.5
 * WP09, S8). A separate numeric badge with its own hidden text ("AI investigating 2
 * cases"), joined to the item's description, beside the case chat glyph, which keeps its
 * meaning. The ring turns while either is working. Only a viewer who may read cases
 * subscribes to the `investigations` topic.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { TooltipProvider } from '@/ui/tooltip';

import type { InvestigationsActive, InvestigationView } from '@/lib/types';

expect.extend(toHaveNoViolations);

const h = vi.hoisted(() => ({
  read: vi.fn(),
  topics: [] as string[][],
  canReadCases: true,
}));

vi.mock('../../auth', () => ({
  useAuth: () => ({ hasPermission: (r: string, a: string) => (r === 'cases' && a === 'read' ? h.canReadCases : true) }),
}));
vi.mock('../../prefs', () => ({ usePrefs: () => ({ prefs: { misc: {} }, ready: true }) }));
vi.mock('@/lib/api', () => ({ api: { prefs: { putUser: () => Promise.resolve({}) } } }));
vi.mock('@/lib/api-investigations', () => ({ getActiveInvestigations: h.read }));
vi.mock('@/lib/useEventStream', () => ({
  subscribeEvents: (topics: string[]) => {
    h.topics.push(topics);
    return () => undefined;
  },
}));

import { NavSidebar, aiCountText } from '../NavSidebar';
import { navStore } from '../../nav-store';
import { loadRailInteractions } from '../nav-rail-loader';
import { clearChatActivity, putChatActivity, type ChatActivity } from '../../chat-activity/activity';
import { resetInvestigationsForTests } from '../../investigations/store';

const T0 = Date.parse('2026-11-25T10:00:00Z');

function run(caseId: string): InvestigationView {
  return {
    run_id: `inv-${caseId}`,
    case_id: caseId,
    state: 'running',
    phase: 'triage',
    trigger: 'automatic',
    queued_at: new Date(T0 - 20_000).toISOString(),
    started_at: new Date(T0 - 20_000).toISOString(),
    deadline_at: new Date(T0 + 100_000).toISOString(),
    time_cap_seconds: 120,
    finished_at: null,
    outcome: null,
    status_after: null,
    verdict_after: null,
  };
}

function serve(items: InvestigationView[]) {
  h.read.mockImplementation(
    async (): Promise<InvestigationsActive> => ({
      items,
      recent: [],
      new_runs: 0,
      slots: { in_use: items.length, cap: 3 },
      process_local: true,
      generated_at: new Date(Date.now()).toISOString(),
    }),
  );
}

function caseChat(status: ChatActivity['status']): ChatActivity {
  return {
    kind: 'case',
    conversationId: null,
    caseId: 'case-4',
    turnId: 't1',
    requestKey: null,
    title: 'Summarize Case',
    label: 'Searching logs',
    lookups: 1,
    status,
    startedAt: 1,
    source: 'local',
    scope: 'case:case-4',
  };
}

function renderNav(collapsed = false) {
  window.localStorage.setItem('soc.nav.collapsed', collapsed ? '1' : '0');
  navStore.beginSession();
  return render(
    <TooltipProvider>
      <NavSidebar page="overview" onNavigate={vi.fn()} />
    </TooltipProvider>,
  );
}

const describedText = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') || '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' | ');

/** Let the store load (a dynamic import, a few turns) and its first read land. */
async function settle() {
  for (let i = 0; i < 50 && !h.topics.length && h.canReadCases; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeAll(async () => {
  await loadRailInteractions();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetInvestigationsForTests();
  clearChatActivity();
  h.read.mockReset();
  h.topics = [];
  h.canReadCases = true;
  serve([]);
});

afterEach(() => {
  resetInvestigationsForTests();
  clearChatActivity();
  vi.useRealTimers();
});

describe('NavSidebar: the AI investigation count', () => {
  it('shows nothing while the AI investigates no case', async () => {
    renderNav();
    await settle();
    const item = screen.getByTestId('nav-case_manager');
    expect(screen.queryByTestId('nav-ai-count')).toBeNull();
    expect(item.querySelector('[data-activity]')).toBeNull();
    expect(item).not.toHaveAttribute('aria-describedby');
    expect(h.topics).toEqual([['investigations']]);
  });

  it('counts the cases, says so in hidden text, and turns the ring', async () => {
    serve([run('case-1'), run('case-2')]);
    renderNav();
    await settle();
    const item = screen.getByTestId('nav-case_manager');
    expect(screen.getByTestId('nav-ai-count')).toHaveTextContent('2');
    expect(screen.getByTestId('nav-ai-count')).toHaveAttribute('aria-hidden');
    expect(describedText(item)).toBe('AI investigating 2 cases');
    expect(item.querySelector('[data-activity="running"]')).not.toBeNull();
    expect(item).not.toHaveAttribute('aria-busy');
  });

  it('shows the case chat glyph and the AI count together, each with its own words', async () => {
    serve([run('case-1')]);
    putChatActivity(caseChat('running'));
    renderNav();
    await settle();
    const item = screen.getByTestId('nav-case_manager');
    expect(screen.getByTestId('nav-ai-count')).toHaveTextContent('1');
    // One ring for both (the rail badge and the drawer's trailing mark are one glyph each).
    expect(item.querySelectorAll('.nav-railmark [data-activity="running"]')).toHaveLength(1);
    expect(item.querySelectorAll('[data-activity="running"]')).toHaveLength(2);
    expect(describedText(item)).toBe('Case chat: 1 answer in progress: Case case-4: Summarize Case | AI investigating 1 case');
  });

  it('keeps a case chat question that waits on you, beside the count', async () => {
    serve([run('case-1')]);
    putChatActivity(caseChat('needs_input'));
    renderNav();
    await settle();
    const item = screen.getByTestId('nav-case_manager');
    expect(item.querySelector('[data-activity="needs_input"]')).not.toBeNull();
    expect(item.querySelector('[data-activity="running"]')).toBeNull();
    expect(screen.getByTestId('nav-ai-count')).toHaveTextContent('1');
  });

  it('badges the collapsed rail icon with the count', async () => {
    serve([run('case-1'), run('case-2'), run('case-3')]);
    renderNav(true);
    await settle();
    const badge = screen.getByTestId('nav-ai-count-rail');
    expect(badge).toHaveTextContent('3');
    expect(badge.closest('.nav-railmark')).not.toBeNull();
  });

  it('does not subscribe without cases:read', async () => {
    h.canReadCases = false;
    serve([run('case-1')]);
    renderNav();
    await settle();
    expect(h.topics).toEqual([]);
    expect(h.read).not.toHaveBeenCalled();
    expect(screen.queryByTestId('nav-ai-count')).toBeNull();
  });

  it('words the count', () => {
    expect(aiCountText(0)).toBe('');
    expect(aiCountText(1)).toBe('AI investigating 1 case');
    expect(aiCountText(1200)).toBe('AI investigating 1,200 cases');
  });

  it('is axe-clean with the count on', async () => {
    serve([run('case-1')]);
    putChatActivity(caseChat('running'));
    vi.useRealTimers();
    const { container } = renderNav();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
