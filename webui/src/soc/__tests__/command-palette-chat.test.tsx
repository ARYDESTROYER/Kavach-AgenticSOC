/**
 * Command palette chat entries (chat revamp SPEC §10.4a): "New chat" opens a fresh chat
 * (`newChat`), "Ask AI: <text>" carries the operator's own words, "Search chats" finds
 * saved conversations (with the matched snippet) and reports, and "Open Reports" jumps to
 * the library. The chat entries are a LAZY chunk; the chat data client loads only when the
 * operator chooses to search.
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

  it('sends the typed text with "Ask AI: <text>" as a new chat', async () => {
    const { onNavigate, onOpenChange } = renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    fireEvent.change(input, { target: { value: '  who logged in from 203.0.113.14?  ' } });
    await waitFor(() => expect(item('action-ask-ai')).toBeTruthy());
    expect(item('action-ask-ai')).toHaveTextContent('Ask AI: who logged in from 203.0.113.14?');
    fireEvent.click(item('action-ask-ai')!);
    expect(onNavigate).toHaveBeenCalledWith('chat', { newChat: true, ask: 'who logged in from 203.0.113.14?' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
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
