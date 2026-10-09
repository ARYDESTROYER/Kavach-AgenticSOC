/**
 * Workspace Chat — the page that wires the chat hooks to the workspace shell (chat
 * revamp SPEC §10, §10.7, §10.8).
 *
 *  - `useChatConversations` owns the history (list, selection tri-state, guards,
 *    cross-tab refresh, drafts, rename/pin/delete, retention, search, the REQUESTED
 *    selection from the route);
 *  - `useChatEngine` owns the transcript and the turn state machine (one engine, two
 *    entry points: this page and the case-scoped Case Manager chat, #5);
 *  - `useChatContext` feeds the composer meter, the starters and the turn bounds;
 *  - `ChatWorkspace` renders the three zones.
 *
 * "Ask about this" (`NavOpts.topic`): the page resolves the topic to its server-side
 * templated question and sends THAT (origin `starter`, with the topic id) in a fresh
 * chat; it never sends free text from a link. The palette's "Ask AI: <text>"
 * (`NavOpts.ask`) only PREFILLS a fresh chat's composer (the workspace focuses it); the
 * analyst sends it, so it is never sent on their behalf. A deep-linked `#/chat?conversationId=` is cleared from the
 * hash as soon as the selection moves elsewhere, so a refresh does not reopen it.
 *
 * With `caseId` (Case Chat → "Open full chat") the page is case-scoped: no history,
 * no report, nothing saved to personal history.
 */
import * as React from 'react';
import { toast } from 'sonner';

import type { ChatConversationSummary, NavOpts } from '@/lib/types';
import { useAuth } from '@/soc/auth';
import { useConfirm } from '@/soc/components/ConfirmDialog';
import { useRoute } from '@/soc/router';
import { getChatTopic } from '../chat/chat-api';
import { useChatContext } from '../chat/useChatContext';
import { useChatConversations } from '../chat/useChatConversations';
import { useChatEngine } from '../chat/useChatEngine';
import { ChatWorkspace } from '../chat/workspace/ChatWorkspace';

export interface ChatProps {
  /** Case scope preserved by a Case Chat → Workspace deep link. */
  caseId?: string;
  /** The route's options (else read from the router when one is mounted). */
  opts?: NavOpts;
}

/**
 * The current route's opts without requiring a router: a standalone render (tests,
 * embeds) has none. `useRoute` always calls `useContext` first, so the hook order is
 * the same whether or not it throws.
 */
function useRouteOpts(): NavOpts | undefined {
  try {
    return useRoute().opts;
  } catch {
    return undefined;
  }
}

/** Drop a `conversationId` deep link that no longer names the open thread. */
function clearStaleChatHash(activeId: string | null): void {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash || '';
  const query = hash.indexOf('?');
  if (!/^#\/chat(\?|$)/.test(hash) || query < 0) return;
  const linked = new URLSearchParams(hash.slice(query + 1)).get('conversationId');
  if (!linked || linked === activeId) return;
  try {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/chat`);
  } catch {
    /* A sandboxed frame may refuse; the stale link only matters on a manual refresh. */
  }
}

export default function Chat({ caseId, opts }: ChatProps = {}) {
  const routeOpts = useRouteOpts();
  const requested = opts ?? routeOpts ?? null;
  const caseScoped = !!caseId;
  const confirm = useConfirm();
  const { username } = useAuth();

  const confirmDelete = React.useCallback(
    (item: ChatConversationSummary) =>
      confirm({
        title: 'Delete conversation?',
        description: `“${item.title}” and its saved messages will be removed. Its report stays in Reports.`,
        confirmLabel: 'Delete',
        destructive: true,
      }),
    [confirm],
  );
  const conv = useChatConversations({
    enabled: !caseScoped,
    requested: caseScoped ? null : requested,
    confirmDelete,
  });

  // The context depends on the engine's model and busy flag, the engine on the
  // context's bounds: the two engine values are mirrored into state.
  const [engineModel, setEngineModel] = React.useState<string | null>(null);
  const [engineBusy, setEngineBusy] = React.useState(false);
  const activeId = typeof conv.activeId === 'string' ? conv.activeId : null;
  const context = useChatContext({
    conversationId: caseScoped ? null : activeId,
    model: engineModel,
    caseId: caseId ?? null,
    principal: username ?? null,
    busy: engineBusy,
  });
  const ctx = context.context;

  const { setBusy: setConvBusy } = conv;
  const onBusyChange = React.useCallback(
    (busy: boolean) => {
      setConvBusy(busy);
      setEngineBusy(busy);
    },
    [setConvBusy],
  );

  const engine = useChatEngine(
    caseScoped
      ? {
          caseId,
          onBusyChange: setEngineBusy,
          textStreamingAvailable: ctx?.text_streaming.available ?? true,
          orgDefaultStreamMode: ctx?.bounds.default_stream_mode ?? null,
          turnBounds: ctx?.bounds ?? null,
        }
      : {
          conversation: conv.enabled ? conv.conversation : undefined,
          draft: conv.draft,
          onDraftChange: conv.setDraft,
          blocked: conv.restoring || !!conv.threadError,
          // Every New chat AND every thread switch (see `transcriptEpoch`).
          resetKey: conv.transcriptEpoch,
          onBusyChange,
          onConversationPersisted: conv.conversationPersisted,
          textStreamingAvailable: ctx?.text_streaming.available ?? true,
          orgDefaultStreamMode: ctx?.bounds.default_stream_mode ?? null,
          turnBounds: ctx?.bounds ?? null,
        },
  );

  React.useEffect(() => setEngineModel(engine.model), [engine.model]);

  // "Ask about this": once the fresh draft is in place, ask the topic's templated
  // question. The topic is consumed first, so a re-render can never ask twice.
  // Set on (re)mount too: StrictMode's dev double-invoke runs the cleanup once, and a
  // flag that only ever goes false would drop every topic question after it.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const { topic, clearTopic } = conv;
  const { send } = engine;
  React.useEffect(() => {
    if (!topic || conv.activeId !== null || engine.busy) return;
    clearTopic();
    getChatTopic(topic)
      .then(({ question, topic: resolved }) => {
        // The topic id travels with its question so retrieval can pin that topic's
        // sections (SPEC A7); the server ignores it if it does not know the id.
        if (mountedRef.current) send(question, { origin: 'starter', topic: resolved || topic });
      })
      .catch(() => {
        if (mountedRef.current) toast.error('That topic is not available to ask about.');
      });
  }, [clearTopic, conv.activeId, engine.busy, send, topic]);

  // A deep-linked conversation stops being the URL once the rail selection moves on.
  React.useEffect(() => {
    if (caseScoped || conv.activeId === undefined) return;
    clearStaleChatHash(conv.activeId);
  }, [caseScoped, conv.activeId]);

  return <ChatWorkspace conv={conv} engine={engine} context={context} caseId={caseId ?? null} author={username ?? null} />;
}
