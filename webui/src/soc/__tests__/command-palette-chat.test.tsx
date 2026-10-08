/**
 * Command palette chat entries (chat revamp SPEC §10.4a): "New chat" opens a fresh chat
 * (`newChat`), "Search chats" finds saved conversations (with the matched snippet) and
 * reports, and "Open Reports" jumps to the library. The chat entries are a LAZY chunk
 * rendered after every page/action match (Enter on a typed page name still opens the
 * page); the chat data client loads only when the operator chooses to search. "Ask AI:
 * <text>" is the very last item: it opens a new chat with the text PREFILLED (`ask`,
 * capped at 2,000 characters), never first while a page or action matches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
      getBranding: ok({
        org_name: '', product_name: '', logo_data_url: '', favicon_data_url: '',
        accent_color: '', accent_color2: '', theme: '', login_subtitle: '',
      }),
      prefs: {
        effective: ok({
          terminology: {}, theme_mode: 'dark', saved_views: [], pinned_view_ids: [],
          tables: {}, last_list_state: {}, misc: {},
          org: { terminology: {}, default_theme: 'dark', default_saved_views: [], default_pinned_view_ids: [] },
        }),
        putUser: ok({}),
      },
      demo: { status: ok({ mode: 'off', active: false, run_id: null }), enable: ok({}) },
      search: ok({ query: '', cases: [], sources: [], nav: [] }),
    },
  };
});

const chatApi = vi.hoisted(() => ({ listConversations: vi.fn(), listReports: vi.fn() }));
vi.mock('@/soc/chat/chat-api', () => chatApi);

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CommandPalette } from '../components/CommandPalette';

function renderPalette() {
  const onNavigate = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <CommandPalette open onOpenChange={onOpenChange} onNavigate={onNavigate} />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
  return { onNavigate, onOpenChange };
}

const item = (value: string) => document.querySelector(`[cmdk-item][data-value="${value}"]`) as HTMLElement | null;

beforeEach(() => {
  chatApi.listConversations.mockReset();
  chatApi.listReports.mockReset();
  chatApi.listConversations.mockResolvedValue({
    conversations: [
      {
        id: 'conv-1',
        title: 'VPN brute force',
        created_at: '',
        updated_at: '',
        message_count: 2,
        match: { message_id: 'msg-2', snippet: '…failures came from 203.0.113.14…' },
      },
    ],
  });
  chatApi.listReports.mockResolvedValue([
    { id: 'rep-1', title: 'Brute force report', template: 'investigation', item_count: 3, updated_at: '', version: 1 },
    { id: 'rep-2', title: 'Night shift', template: 'shift', item_count: 1, updated_at: '', version: 1 },
  ]);
  window.localStorage.clear();
});

describe('CommandPalette — chat entries', () => {
  it('opens a fresh chat from "New chat"', async () => {
    const { onNavigate } = renderPalette();
    await waitFor(() => expect(item('action-new-chat')).toBeTruthy());
    fireEvent.click(item('action-new-chat')!);
    expect(onNavigate).toHaveBeenCalledWith('chat', { newChat: true });
  });

  it('offers "Search chats" and "Open Reports" in the discovery state (lazily)', async () => {
    const { onNavigate } = renderPalette();
    await waitFor(() => expect(item('action-search-chats')).toBeTruthy());
    expect(item('action-ask-ai')).toBeNull();
    fireEvent.click(item('action-open-reports')!);
    expect(onNavigate).toHaveBeenCalledWith('reports');
    // Nothing was searched just by opening the palette.
    expect(chatApi.listConversations).not.toHaveBeenCalled();
  });

  it('offers "Ask AI: <text>" last and opens a new chat with the question to prefill', async () => {
    const { onNavigate } = renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    fireEvent.change(input, { target: { value: '  who logged in from 203.0.113.14?  ' } });
    await waitFor(() => expect(item('action-ask-ai')).toBeTruthy());
    expect(item('action-ask-ai')).toHaveTextContent('Ask AI: “who logged in from 203.0.113.14?”');
    const values = Array.from(document.querySelectorAll('[cmdk-item]')).map((el) => el.getAttribute('data-value'));
    expect(values[values.length - 1]).toBe('action-ask-ai');
    fireEvent.click(item('action-ask-ai')!);
    expect(onNavigate).toHaveBeenCalledWith('chat', { newChat: true, ask: 'who logged in from 203.0.113.14?' });
  });

  it('caps the Ask AI question at 2,000 characters and ignores a one-character query', async () => {
    const { onNavigate } = renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    fireEvent.change(input, { target: { value: 'x' } });
    await waitFor(() => expect(item('action-search-chats')).toBeTruthy());
    expect(item('action-ask-ai')).toBeNull();
    fireEvent.change(input, { target: { value: 'q'.repeat(2500) } });
    await waitFor(() => expect(item('action-ask-ai')).toBeTruthy());
    fireEvent.click(item('action-ask-ai')!);
    const opts = onNavigate.mock.calls.at(-1)?.[1] as { ask: string };
    expect(opts.ask).toHaveLength(2000);
  });

  it('never makes "Ask AI" the default Enter when a page matches', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    await user.type(input, 'approvals');
    await waitFor(() => expect(item('action-ask-ai')).toBeTruthy());
    const values = Array.from(document.querySelectorAll('[cmdk-item]')).map((el) => el.getAttribute('data-value'));
    expect(values.indexOf('action-ask-ai')).toBeGreaterThan(values.indexOf('nav-approvals'));
    await user.keyboard('{Enter}');
    expect(onNavigate).toHaveBeenCalledWith('approvals');
    expect(onNavigate).not.toHaveBeenCalledWith('chat', expect.anything());
  });

  it('keeps Enter on a typed page name going to that page, with the chat entries last', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    await user.type(input, 'approvals');
    await waitFor(() => expect(item('action-search-chats')).toBeTruthy());
    const values = Array.from(document.querySelectorAll('[cmdk-item]')).map((el) => el.getAttribute('data-value'));
    // The chat group renders after every page target.
    expect(values.indexOf('action-search-chats')).toBeGreaterThan(values.indexOf('nav-approvals'));
    await user.keyboard('{Enter}');
    expect(onNavigate).toHaveBeenCalledWith('approvals');
    expect(onNavigate).not.toHaveBeenCalledWith('chat', expect.anything());
  });

  it('lets the rail "Reports" target answer a query naming it (no duplicate "Open Reports")', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    await user.type(input, 'reports');
    await waitFor(() => expect(item('action-search-chats')).toBeTruthy());
    expect(item('action-open-reports')).toBeNull();
    expect(item('navc-chat-reports')).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(onNavigate).toHaveBeenCalledWith('reports');
  });

  it('searches saved chats and reports only when asked, and opens a hit at its message', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    fireEvent.change(input, { target: { value: 'brute' } });
    await waitFor(() => expect(item('action-search-chats')).toHaveTextContent('Search chats for “brute”'));
    expect(chatApi.listConversations).not.toHaveBeenCalled();
    await user.click(item('action-search-chats')!);
    await waitFor(() => expect(chatApi.listConversations).toHaveBeenCalledWith({ q: 'brute', limit: 8 }, expect.anything()));
    await waitFor(() => expect(item('chat conv-1')).toBeTruthy());
    expect(item('chat conv-1')).toHaveTextContent('…failures came from 203.0.113.14…');
    // Only reports whose title matches.
    expect(item('report rep-1')).toBeTruthy();
    expect(item('report rep-2')).toBeNull();
    fireEvent.click(item('chat conv-1')!);
    expect(onNavigate).toHaveBeenCalledWith('chat', { conversationId: 'conv-1', messageId: 'msg-2' });
  });

  it('opens a matching report', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    fireEvent.change(input, { target: { value: 'brute' } });
    await waitFor(() => expect(item('action-search-chats')).toBeTruthy());
    await user.click(item('action-search-chats')!);
    await waitFor(() => expect(item('report rep-1')).toBeTruthy());
    fireEvent.click(item('report rep-1')!);
    expect(onNavigate).toHaveBeenCalledWith('reports', { reportId: 'rep-1' });
  });
});
