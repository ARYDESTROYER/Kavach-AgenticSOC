/**
 * Workspace Chat — durable per-user conversations around the one shared chat engine.
 *
 * The page owns only conversation discovery/selection and responsive history chrome.
 * ChatPanel remains the single transcript, composer, source/model, provenance, and
 * send implementation used here and by Case Manager. A draft is intentionally not
 * persisted until its first successful turn, so “New chat” never creates empty rows.
 */
import * as React from "react";
import { History, MessageSquare, Plus } from "lucide-react";

import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { humanizeAge } from "@/lib/format";
import type {
  ChatConversation,
  ChatConversationSummary,
} from "@/lib/types";
import { PageHeader } from "@/soc/components/PageHeader";
import { PageContainer } from "@/soc/components/PageContainer";
import {
  ChatPanel,
  type ChatPanelHandle,
} from "@/soc/components/ChatPanel";
import { ChatHistoryRail } from "@/soc/components/ChatHistoryRail";
import { useConfirm } from "@/soc/components/ConfirmDialog";
import { Button } from "@/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/ui/sheet";

const SUGGESTED_PROMPTS = [
  "Show failed logins for 10.0.0.5 in the last 24h",
  "Summarize today's true positives",
  "Any brute-force activity in the last 24h?",
  "Which hosts had the most alerts this week?",
];

const NEW_DRAFT_KEY = "__new_workspace_chat__";
const HISTORY_CHANNEL = "agentic-soc-workspace-chat-history";
const DEFAULT_HISTORY_LIMIT = 50;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return fallback;
}

function newestConversationFirst(
  a: ChatConversationSummary,
  b: ChatConversationSummary,
): number {
  return Date.parse(b.updated_at) - Date.parse(a.updated_at);
}

export interface ChatProps {
  /** Additive deep-link context preserved by Workspace/registry. */
  caseId?: string;
}

export default function Chat({ caseId }: ChatProps = {}) {
  const panelRef = React.useRef<ChatPanelHandle>(null);
  const detailRequestRef = React.useRef(0);
  const listRequestRef = React.useRef(0);
  const skipDetailIdRef = React.useRef<string | null>(null);
  const conversationsRef = React.useRef<ChatConversationSummary[]>([]);
  const activeIdRef = React.useRef<string | null | undefined>(undefined);
  const chatBusyRef = React.useRef(false);
  const refreshPendingRef = React.useRef(false);
  const historyChannelRef = React.useRef<BroadcastChannel | null>(null);
  const confirm = useConfirm();
  const historyEnabled = !caseId;

  const [conversations, setConversations] = React.useState<
    ChatConversationSummary[]
  >([]);
  // `undefined` means the initial history load has not chosen a thread yet;
  // `null` is an intentional New-chat draft and must survive list refreshes.
  const [activeId, setActiveId] = React.useState<string | null | undefined>(
    undefined,
  );
  const [conversation, setConversation] = React.useState<
    ChatConversation | null
  >(null);
  const [listLoading, setListLoading] = React.useState(true);
  const [threadLoading, setThreadLoading] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);
  const [threadError, setThreadError] = React.useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [threadRetryEpoch, setThreadRetryEpoch] = React.useState(0);
  const [chatBusy, setChatBusy] = React.useState(false);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [historyLimit, setHistoryLimit] = React.useState(DEFAULT_HISTORY_LIMIT);
  const [historyTruncated, setHistoryTruncated] = React.useState(false);
  const [historyTotal, setHistoryTotal] = React.useState(0);

  // The shell no longer injects a full-width demo banner above the routed content
  // (demo mode is a top-bar chip now), so the frame subtracts exactly one band —
  // the sticky top bar + the content inset — in every tenant state.
  const frameHeight = "h-[calc(100dvh-5.5rem)]";

  React.useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  React.useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const loadConversations = React.useCallback(
    async () => {
      const generation = ++listRequestRef.current;
      setListLoading(true);
      setListError(null);
      try {
        const response = await api.chatConversations(50);
        const next = [...(response.conversations || [])].sort(
          newestConversationFirst,
        );
        if (generation !== listRequestRef.current) return;
        setConversations(next);
        setHistoryLimit(
          typeof response.limit === "number" && response.limit > 0
            ? response.limit
            : DEFAULT_HISTORY_LIMIT,
        );
        setHistoryTruncated(response.history_truncated === true);
        setHistoryTotal(
          typeof response.total_conversation_count === "number"
            ? response.total_conversation_count
            : typeof response.total === "number"
              ? response.total
              : next.length,
        );
        setActiveId((current) => {
          if (current && next.some((item) => item.id === current)) return current;
          if (current === null) return null;
          return next[0]?.id ?? null;
        });
      } catch (error) {
        if (generation !== listRequestRef.current) return;
        setListError(
          errorMessage(error, "Could not load previous conversations."),
        );
        // History is helpful, not a prerequisite for a fresh investigation.
        setActiveId((current) => (current === undefined ? null : current));
      } finally {
        if (generation === listRequestRef.current) setListLoading(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    if (!historyEnabled) {
      listRequestRef.current += 1;
      detailRequestRef.current += 1;
      setConversations([]);
      setActiveId(null);
      setConversation(null);
      setListError(null);
      setHistoryTruncated(false);
      setHistoryTotal(0);
      setThreadError(null);
      setListLoading(false);
      setThreadLoading(false);
      return;
    }
    void loadConversations();
  }, [historyEnabled, loadConversations]);

  const requestHistoryRefresh = React.useCallback(() => {
    if (!historyEnabled) return;
    if (chatBusyRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    void loadConversations();
  }, [historyEnabled, loadConversations]);

  const announceHistoryChanged = React.useCallback(() => {
    historyChannelRef.current?.postMessage({ type: "history-changed" });
  }, []);

  React.useEffect(() => {
    if (!historyEnabled || typeof window === "undefined") return;

    const onFocus = () => requestHistoryRefresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") requestHistoryRefresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    if (typeof window.BroadcastChannel === "function") {
      const channel = new window.BroadcastChannel(HISTORY_CHANNEL);
      historyChannelRef.current = channel;
      channel.onmessage = () => requestHistoryRefresh();
    }

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      historyChannelRef.current?.close();
      historyChannelRef.current = null;
    };
  }, [historyEnabled, requestHistoryRefresh]);

  const handleBusyChange = React.useCallback(
    (busy: boolean) => {
      chatBusyRef.current = busy;
      setChatBusy(busy);
      if (!busy && refreshPendingRef.current) {
        refreshPendingRef.current = false;
        void loadConversations();
      }
    },
    [loadConversations],
  );

  React.useEffect(() => {
    const generation = ++detailRequestRef.current;
    setThreadError(null);
    if (!activeId) {
      setConversation(null);
      setThreadLoading(false);
      return;
    }

    if (skipDetailIdRef.current === activeId) {
      // The mounted ChatPanel already owns the just-persisted transcript. Keep this
      // marker for as long as that same thread stays active; clearing it here makes
      // the page infer that a missing parent-level detail is still restoring even
      // though the live answer is already visible. Switching/new-chat paths clear
      // the marker before a future selection, which then hydrates normally.
      setThreadLoading(false);
      return;
    }

    setThreadLoading(true);
    void api
      .chatConversation(activeId)
      .then((detail) => {
        if (generation === detailRequestRef.current) setConversation(detail);
      })
      .catch((error) => {
        if (generation !== detailRequestRef.current) return;
        setConversation(null);
        setThreadError(errorMessage(error, "Could not load this conversation."));
      })
      .finally(() => {
        if (generation === detailRequestRef.current) setThreadLoading(false);
      });
  }, [activeId, threadRetryEpoch]);

  const startNew = React.useCallback(() => {
    if (chatBusy) return;
    detailRequestRef.current += 1;
    skipDetailIdRef.current = null;
    activeIdRef.current = null;
    setActiveId(null);
    setConversation(null);
    setThreadError(null);
    setThreadLoading(false);
    setHistoryOpen(false);
    panelRef.current?.reset();
  }, [chatBusy]);

  const selectConversation = React.useCallback(
    (item: ChatConversationSummary) => {
      if (chatBusy) return;
      if (activeIdRef.current === item.id) {
        setHistoryOpen(false);
        return;
      }
      // Enter the pending state before React paints the new selection. This avoids
      // showing thread A's transcript and enabled composer under thread B's title
      // while the detail-loading effect waits for its first turn.
      detailRequestRef.current += 1;
      skipDetailIdRef.current = null;
      activeIdRef.current = item.id;
      setConversation(null);
      setThreadError(null);
      setThreadLoading(true);
      setActiveId(item.id);
      setHistoryOpen(false);
    },
    [chatBusy],
  );

  const conversationPersisted = React.useCallback(
    (id: string, title: string) => {
      // Only a draft's first persisted response needs to suppress hydration. Later
      // turns on the same thread must not leave a skip token that could be consumed
      // after the analyst switches away and returns.
      if (activeIdRef.current !== id) skipDetailIdRef.current = id;
      activeIdRef.current = id;
      setActiveId(id);
      setConversations((current) => {
        const existing = current.find((item) => item.id === id);
        const now = new Date().toISOString();
        const optimistic: ChatConversationSummary = existing ?? {
          id,
          title,
          preview: title,
          created_at: now,
          updated_at: now,
          message_count: 2,
        };
        return [
          { ...optimistic, title: title || optimistic.title, updated_at: now },
          ...current.filter((item) => item.id !== id),
        ];
      });
      // The response is saved before this callback runs. Refresh metadata in the
      // background without remounting/refetching the live panel that owns the answer.
      requestHistoryRefresh();
      announceHistoryChanged();
    },
    [announceHistoryChanged, requestHistoryRefresh],
  );

  const renameConversation = React.useCallback(
    async (item: ChatConversationSummary, title: string) => {
      try {
        const updated = await api.renameChatConversation(item.id, title);
        // A list request started before this mutation must not put the stale title
        // back after the rename succeeds.
        listRequestRef.current += 1;
        setListLoading(false);
        setConversations((current) =>
          current
            .map((entry) => (entry.id === item.id ? updated : entry))
            .sort(newestConversationFirst),
        );
        announceHistoryChanged();
      } catch (error) {
        setListError(errorMessage(error, "Could not rename the conversation."));
      }
    },
    [announceHistoryChanged],
  );

  const deleteConversation = React.useCallback(
    async (item: ChatConversationSummary) => {
      const approved = await confirm({
        title: "Delete conversation?",
        description: `“${item.title}” and its saved messages will be removed. This cannot be undone.`,
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!approved) return;
      try {
        await api.deleteChatConversation(item.id);
        // Invalidate list/detail responses that still include the deleted thread.
        listRequestRef.current += 1;
        setListLoading(false);
        const deletingActive = activeIdRef.current === item.id;
        if (deletingActive) detailRequestRef.current += 1;
        const remaining = conversationsRef.current.filter(
          (entry) => entry.id !== item.id,
        );
        setConversations(remaining);
        setDrafts((current) => {
          if (!(item.id in current)) return current;
          const next = { ...current };
          delete next[item.id];
          return next;
        });
        setActiveId((current) =>
          current === item.id ? (remaining[0]?.id ?? null) : current,
        );
        if (deletingActive) {
          setConversation(null);
          if (remaining.length === 0) panelRef.current?.reset();
        }
        announceHistoryChanged();
      } catch (error) {
        setListError(errorMessage(error, "Could not delete the conversation."));
      }
    },
    [announceHistoryChanged, confirm],
  );

  const historyRail = (
    autoFocusSearch = false,
    showNewAction = false,
  ) => (
    <ChatHistoryRail
      conversations={conversations}
      activeId={activeId}
      loading={listLoading}
      error={listError}
      autoFocusSearch={autoFocusSearch}
      showNewAction={showNewAction}
      disabled={chatBusy}
      retentionLimit={historyLimit}
      retentionTruncated={historyTruncated}
      retentionTotal={historyTotal}
      onRetry={() => void loadConversations()}
      onNew={startNew}
      onSelect={selectConversation}
      onRename={(item, title) => void renameConversation(item, title)}
      onDelete={(item) => void deleteConversation(item)}
    />
  );

  const actions = (
    <div className="flex items-center gap-2">
      {historyEnabled ? (
        <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" className="lg:hidden">
              <History className="h-4 w-4" />
              History
            </Button>
          </SheetTrigger>
          <SheetContent side="left" size="sm" className="gap-0 p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Conversation history</SheetTitle>
              <SheetDescription>
                Search and open your saved Workspace conversations.
              </SheetDescription>
            </SheetHeader>
            {historyRail(true, true)}
          </SheetContent>
        </Sheet>
      ) : null}
      <Button variant="outline" size="sm" onClick={startNew} disabled={chatBusy}>
        <Plus className="h-4 w-4" />
        New chat
      </Button>
    </div>
  );

  const activeSummary = conversations.find((item) => item.id === activeId);
  const draftKey = activeId || NEW_DRAFT_KEY;
  const activeDraft = drafts[draftKey] ?? "";
  const updateActiveDraft = React.useCallback(
    (value: string) => {
      setDrafts((current) => {
        if (!value) {
          if (!(draftKey in current)) return current;
          const next = { ...current };
          delete next[draftKey];
          return next;
        }
        if (current[draftKey] === value) return current;
        return { ...current, [draftKey]: value };
      });
    },
    [draftKey],
  );
  const threadTitle = activeSummary?.title || conversation?.title || "New conversation";
  const threadSubtitle = activeSummary
    ? `${activeSummary.message_count} ${activeSummary.message_count === 1 ? "message" : "messages"} · updated ${humanizeAge(activeSummary.updated_at)}`
    : conversation
      ? `${conversation.message_count} ${conversation.message_count === 1 ? "message" : "messages"} · updated ${humanizeAge(conversation.updated_at)}`
    : caseId
      ? `Scoped to case ${caseId}`
      : "A new conversation is saved after the first response";
  const retainedMessages = conversation?.message_count ?? activeSummary?.message_count;
  const totalMessages =
    conversation?.total_message_count ?? activeSummary?.total_message_count;
  const threadHistoryTruncated =
    conversation?.history_truncated === true || activeSummary?.history_truncated === true;
  const workspaceRetentionNote = threadHistoryTruncated
    ? typeof retainedMessages === "number" && typeof totalMessages === "number"
      ? `Showing the latest ${retainedMessages} of ${totalMessages} messages. Older turns were removed by retention.`
      : "This conversation shows its retained message window. Older turns were removed by retention."
    : null;

  const restoringThread =
    historyEnabled &&
    (activeId === undefined ||
      threadLoading ||
      (!!activeId &&
        conversation?.id !== activeId &&
        skipDetailIdRef.current !== activeId));

  return (
    <PageContainer
      variant="fluid"
      className={cn(
        // The dynamic viewport height already provides the frame boundary. Fixed
        // minimums made short desktop windows overflow and could put the one docked
        // composer below the visible workspace.
        "flex min-h-0 min-w-0 flex-col gap-3",
        frameHeight,
      )}
      data-testid="workspace-chat-page"
    >
      <PageHeader
        icon={MessageSquare}
        title="Chat"
        description={
          historyEnabled
            ? "Investigate connected telemetry with durable, per-user conversation history."
            : `Continue an analyst conversation scoped to ${caseId}.`
        }
        actions={actions}
        className="shrink-0"
      />

      <div
        className={cn(
          "grid min-h-0 flex-1 overflow-hidden border border-border bg-background",
          historyEnabled && "lg:grid-cols-[264px_minmax(0,1fr)]",
        )}
        data-testid="workspace-chat-frame"
      >
        {historyEnabled ? (
          <div
            className="hidden min-h-0 border-r border-border lg:block"
          >
            {historyRail()}
          </div>
        ) : null}

        <div className="min-h-0 min-w-0" role="region" aria-label={threadTitle}>
          <ChatPanel
            ref={panelRef}
            caseId={caseId}
            starters={SUGGESTED_PROMPTS}
            presentation="workspace"
            conversation={conversation}
            persistConversation={!caseId}
            workspaceTitle={threadTitle}
            workspaceSubtitle={threadSubtitle}
            draft={historyEnabled ? activeDraft : undefined}
            onDraftChange={historyEnabled ? updateActiveDraft : undefined}
            workspaceRetentionNote={workspaceRetentionNote}
            restoring={restoringThread}
            restoreError={threadError}
            onRetryRestore={() => setThreadRetryEpoch((epoch) => epoch + 1)}
            onStartNew={startNew}
            onBusyChange={handleBusyChange}
            onConversationPersisted={conversationPersisted}
          />
        </div>
      </div>
    </PageContainer>
  );
}
