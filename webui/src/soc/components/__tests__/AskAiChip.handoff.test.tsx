/**
 * The Ask AI hand-off through the REAL router (Round 12 WP-ASK): a chip (as the case
 * detail hosts it, reading the router and auth contexts itself) click lands on the chat
 * page with a TYPED reference in the route's in-memory options, the URL never carries
 * the value, and the chat page's own parser reads it as a fresh chat's `entity` (the page
 * then asks the server's question with origin `starter`; pinned by
 * `pages/__tests__/Chat.entity.test.tsx`), never a prefill and never a topic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

import { RouterProvider, useRoute } from '@/soc/router';
import { parseChatNavRequest } from '@/soc/chat/useChatConversations';
import { AskAi } from '@/soc/pages/casedetail/AskAi';

function RouteProbe() {
  const { page, opts } = useRoute();
  return <output data-testid="route" data-page={page} data-opts={JSON.stringify(opts ?? null)} />;
}

const HASH = '44d88612fea8a8f36de82e1278abb02f';

beforeEach(() => {
  window.location.hash = '#/case_manager?caseId=case-7';
});
afterEach(() => {
  window.location.hash = '';
});

describe('Ask AI hand-off', () => {
  it('opens the chat page with the reference in memory only, read as an entity question', async () => {
    const user = userEvent.setup();
    render(
      <RouterProvider>
        <RouteProbe />
        <AskAi kind="hash" value={HASH} />
      </RouterProvider>,
    );
    expect(screen.getByTestId('route')).toHaveAttribute('data-page', 'case_manager');
    await user.click(await screen.findByRole('button', { name: `Ask AI about ${HASH}` }));

    const probe = screen.getByTestId('route');
    expect(probe).toHaveAttribute('data-page', 'chat');
    const opts = JSON.parse(probe.getAttribute('data-opts') ?? 'null');
    expect(opts).toEqual({ newChat: true, entity: { kind: 'hash', value: HASH } });
    // The value never reaches the URL (a refresh or a shared link cannot replay it), and
    // the case the analyst came from does not follow them into the Workspace chat.
    expect(window.location.hash).toBe('#/chat');

    expect(parseChatNavRequest(opts)).toEqual({
      conversationId: null,
      messageId: null,
      newChat: true,
      topic: null,
      ask: null,
      entity: { kind: 'hash', value: HASH },
      resend: null,
    });
  });

  it('reads only a well-formed reference, and a topic wins over it', () => {
    expect(parseChatNavRequest({ newChat: true, entity: { kind: 'process', value: 'cmd.exe' } })?.entity).toBeNull();
    expect(parseChatNavRequest({ newChat: true, entity: { kind: 'user', value: 'two words' } })?.entity).toBeNull();
    expect(parseChatNavRequest({ entity: { kind: 'ip', value: '' } })).toBeNull();
    // A reference alone implies a fresh chat, and drops a palette prefill.
    expect(parseChatNavRequest({ entity: { kind: 'ip', value: ' 10.0.0.5 ' }, ask: 'words' })).toEqual({
      conversationId: null,
      messageId: null,
      newChat: true,
      topic: null,
      ask: null,
      entity: { kind: 'ip', value: '10.0.0.5' },
      resend: null,
    });
    expect(parseChatNavRequest({ topic: 'kpi:mttd', entity: { kind: 'ip', value: '10.0.0.5' } })?.entity).toBeNull();
    // An open conversation wins over every fresh-chat request.
    expect(parseChatNavRequest({ conversationId: 'c-1', entity: { kind: 'ip', value: '10.0.0.5' } })?.entity).toBeNull();
  });
});
