/**
 * The command palette's chat hits show their match snippet as plain text (Round 13,
 * SPEC-chat T27): the server cuts it from the stored Markdown answer, so bold, link and
 * code markers are dropped (`plainSnippet`, shared with the history rail).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('@/soc/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
const chatApi = vi.hoisted(() => ({ listConversations: vi.fn(), listReports: vi.fn() }));
vi.mock('@/soc/chat/chat-api', () => chatApi);

import { Command, CommandList } from '@/ui/command';
import PaletteSearch from '../PaletteSearch';

const item = (value: string) => document.querySelector(`[cmdk-item][data-value="${value}"]`) as HTMLElement | null;

describe('PaletteSearch — chat hit snippets', () => {
  it('shows a snippet cut from a Markdown answer without its markers', async () => {
    chatApi.listReports.mockResolvedValue([]);
    chatApi.listConversations.mockResolvedValue({
      conversations: [
        {
          id: 'conv-1',
          title: 'Case volume',
          created_at: '',
          updated_at: '',
          message_count: 2,
          match: { message_id: 'm-1', snippet: '…the **SOC performance report** says **65 cases**, see [the queue](https://soc/q) and `*.exe`…' },
        },
      ],
    });
    render(
      <Command shouldFilter={false}>
        <CommandList>
          <PaletteSearch query="65 cases" go={vi.fn()} />
        </CommandList>
      </Command>,
    );
    fireEvent.click(item('action-search-chats')!);
    await waitFor(() => expect(item('chat conv-1')).toBeTruthy());
    const hit = item('chat conv-1')!;
    expect(hit).toHaveTextContent('…the SOC performance report says 65 cases, see the queue and *.exe…');
    expect(hit.textContent).not.toMatch(/\*\*|\]\(|`/);
  });
});
