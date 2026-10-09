/**
 * ChatWorkspace — the Chat page frame (chat revamp SPEC §10.1, §10.1a, §10.2, §10.6).
 *
 *   ┌ rail (264 px | 48 px strip | Sheet) ┬ toolbar (44 px) ──────────────┬ report ┐
 *   │ New chat · search · Pinned · Today… │ transcript (role=log)          │ panel  │
 *   │                                     │ budget alert · composer        │ (split │
 *   └─────────────────────────────────────┴────────────────────────────────┴ /sheet)┘
 *
 * Chrome contract: the frame bleeds the shell's vertical inset (`-my-6`, the matched
 * pair of `CONTENT_INSET`'s `py-6`) and is exactly `100dvh − 3.5rem` tall, so nothing
 * overflows the document at any reference size; one sr-only `<h1>Chat</h1>`, the thread
 * title is the toolbar `<h2>` and every turn has a hidden `<h3>`. Zones follow the
 * MEASURED frame width (`useChatGeometry`), and exactly one New chat is visible at
 * every width (rail header, icon strip, or toolbar when the rail is a Sheet).
 *
 * The hooks (`useChatConversations`, `useChatEngine`, `useChatContext`) live in the
 * page; this component renders them and owns presentation state only.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { RotateCcw } from 'lucide-react';

import type { ChatConversationSummary, ChatStarter } from '@/lib/types';
import { Button } from '@/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet';
import { LoadingState } from '@/design-system/loading';
import { useAuth } from '@/soc/auth';
import { useAnnouncer } from '@/soc/components/announcer';
import { getConversation } from '../chat-api';
import { BudgetAlert } from '../composer/BudgetAlert';
import { Composer, type ComposerHandle } from '../composer/Composer';
import { estimateNextRequest } from '../display';
import { EmptyState } from '../empty/EmptyState';
import { CONTENT_COL, LANE_GRID } from '../message/lane';
import { NoticeCallout } from '../message/NoticeCallout';
import { Transcript } from '../message/Transcript';
import { useTurnAnnouncer } from '../message/useTurnAnnouncer';
import { ShortcutSheet } from '../shortcuts/ShortcutSheet';
import { CHAT_KEYSHORTCUTS, useChatShortcuts } from '../shortcuts/useChatShortcuts';
import type { ChatConversationsController } from '../useChatConversations';
import type { ChatContextController } from '../useChatContext';
import { CONTINUE_PROMPT, type ChatEngine, type ChatUserItem } from '../useChatEngine';
import { HistoryRail, HistoryStrip, type ConversationExportFormat } from './HistoryRail';
import { ReportOverlay, ReportSplit } from './ReportPanelHost';
import { ThreadToolbar } from './ThreadToolbar';
import { useConversationReport } from './useConversationReport';
import { useOpenerFocus } from './useOpenerFocus';
import {
  C_MIN,
  PANEL_MAX,
  RAIL_WIDTH,
  SPLIT_HANDLE_PX,
  STRIP_WIDTH,
  TOOLBAR_COMPACT_MAX,
  TOOLBAR_TOTAL_MIN,
  computeGeometry,
  useChatGeometry,
} from './useChatGeometry';

/** Copy for a requested thread that no longer exists (SPEC §10.7). */
export const REQUESTED_UNAVAILABLE =
  'This conversation is no longer available (deleted or removed by the 50-conversation limit).';

export interface ChatWorkspaceProps {
  conv: ChatConversationsController;
  engine: ChatEngine;
  context: ChatContextController;
  /** Case-scoped chat from the Workspace route: no rail, no report, never saved. */
  caseId?: string | null;
  /** The signed-in user, named as the author of an exported conversation. */
  author?: string | null;
}

export function ChatWorkspace({ conv, engine, context, caseId = null, author = null }: ChatWorkspaceProps) {
  const caseScoped = !!caseId;
  const announce = useAnnouncer();
  const { hasPermission } = useAuth();
  // The model picker lists `/api/models`, which needs models:read (SPEC §10.4).
  const canChooseModel = hasPermission('models', 'read');
  const composerRef = React.useRef<ComposerHandle>(null);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historySearchFocus, setHistorySearchFocus] = React.useState(false);
  const historyOpener = useOpenerFocus();
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [pendingReportFor, setPendingReportFor] = React.useState<string | null>(null);
  const geometry = useChatGeometry(panelOpen && !caseScoped);
  const busy = engine.busy;
  const ctx = context.context;

  useTurnAnnouncer(engine, ctx?.bounds.max_tool_calls ?? null);

  const activeId = typeof conv.activeId === 'string' ? conv.activeId : null;
  const summary = conv.activeSummary;

  /* ---------------------------------------------------------------- report -- */

  // The first add of a conversation opens a split panel without moving focus; in
  // overlay geometry it never auto-opens (a toast offers it instead), SPEC §10.6.
  const autoOpenedRef = React.useRef(new Set<string>());
  const panelOpenRef = React.useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  const geometryRef = React.useRef(geometry);
  geometryRef.current = geometry;
  const { noteReport } = conv;
  const onAdded = React.useCallback(
    (count: number, reportId: string) => {
      // The row learns its report now (the first add created it), so the rail's "Open
      // report" and the toolbar count survive switching away before the next refresh.
      if (activeId) noteReport(activeId, reportId);
      announce(`Added to report (${count} ${count === 1 ? 'item' : 'items'})`);
      if (panelOpenRef.current) return;
      const g = geometryRef.current;
      const splitFits =
        computeGeometry({ frameWidth: g.frameWidth, railCollapsed: g.railCollapsed, panelOpen: true, panelWidth: g.panelWidth })
          .panel === 'split';
      const key = activeId ?? '';
      if (splitFits && !autoOpenedRef.current.has(key)) {
        autoOpenedRef.current.add(key);
        setPanelOpen(true);
        return;
      }
      toast('Added to report', { action: { label: 'Open', onClick: () => setPanelOpen(true) } });
    },
    [activeId, announce, noteReport],
  );
  const report = useConversationReport({
    conversationId: activeId,
    reportId: summary?.report_id ?? null,
    enabled: !caseScoped && conv.enabled,
    onAdded,
    onRemoved: (count) => announce(`Removed from report (${count} ${count === 1 ? 'item' : 'items'})`),
  });

  // "Open report" on another rail row: select it, then open the panel once it is active.
  React.useEffect(() => {
    if (pendingReportFor && activeId === pendingReportFor && !conv.restoring) {
      setPanelOpen(true);
      setPendingReportFor(null);
    }
  }, [activeId, conv.restoring, pendingReportFor]);

  /* --------------------------------------------------------------- actions -- */

  const focusComposer = React.useCallback(() => composerRef.current?.focus(), []);
  // A starter card or chip is replaced by the transcript once it sends: focus stays in
  // the composer (SPEC §10.9) instead of dropping to <body>.
  const sendStarter = React.useCallback(
    (starter: ChatStarter) => {
      if (engine.send(starter.prompt, { origin: 'starter' })) focusComposer();
    },
    [engine, focusComposer],
  );

  const newChat = React.useCallback(() => {
    if (busy) return;
    conv.startNew();
    setHistoryOpen(false);
    // After the draft paints (the composer stays mounted).
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [busy, conv]);

  const select = React.useCallback(
    (item: ChatConversationSummary) => {
      conv.select(item);
      setHistoryOpen(false);
    },
    [conv],
  );

  const exportThread = React.useCallback(
    async (id: string, format: ConversationExportFormat) => {
      try {
        const [conversation, module] = await Promise.all([getConversation(id), import('../report/export/conversation')]);
        const outcome = await module.exportConversation(conversation, format, { author });
        announce(outcome.message);
        if (!outcome.ok) toast.error(outcome.message);
      } catch (error) {
        toast.error(error instanceof Error && error.message ? error.message : 'Could not export the conversation.');
      }
    },
    [announce, author],
  );

  // Whether un-collapsing would actually dock the rail right now (an open split panel
  // may be what keeps it a strip; then the Sheet is the way to see history).
  const dockable =
    computeGeometry({
      frameWidth: geometry.frameWidth,
      railCollapsed: false,
      panelOpen: panelOpen && !caseScoped,
      panelWidth: geometry.panelWidth,
    }).rail === 'docked';
  const toggleHistory = React.useCallback(() => {
    if (caseScoped) return;
    if (geometry.rail === 'docked') geometry.setRailCollapsed(true);
    else if (geometry.rail === 'strip' && geometry.railCollapsed && dockable) geometry.setRailCollapsed(false);
    else setHistoryOpen((open) => !open);
  }, [caseScoped, dockable, geometry]);

  useChatShortcuts(
    {
      newChat,
      toggleHistory,
      focusComposer,
      openShortcuts: () => setShortcutsOpen(true),
    },
    !caseScoped,
  );

  // The EXACT prompt (`prompt`, not its display form `content`): a saved prompt must
  // send what was sent, including a lookalike character the display strips (SPEC §7.6).
  const onSavePrompt = React.useCallback((item: ChatUserItem) => composerRef.current?.savePrompt(item.prompt), []);

  // The palette's "Ask AI: <text>" (SPEC §10.4a): once the fresh draft is in place,
  // prefill the composer with the analyst's words and focus it. Never sent here: the
  // analyst reviews and sends, so the turn is honestly `origin: user`.
  const { ask, clearAsk } = conv;
  React.useEffect(() => {
    if (!ask || conv.activeId !== null || busy) return;
    clearAsk();
    composerRef.current?.setText(ask);
  }, [ask, busy, clearAsk, conv.activeId]);

  /* -------------------------------------------------------------- derived -- */

  // Calibrated on every part, exactly like the composer meter (display.estimateNextRequest).
  const continueEstimate = React.useMemo(() => {
    if (!ctx) return null;
    return estimateNextRequest({
      staticPromptTokens: ctx.static_prompt_tokens,
      historyTokens: ctx.history_tokens,
      draft: CONTINUE_PROMPT,
      charsPerToken: ctx.chars_per_token,
      calibration: ctx.calibration ?? null,
    }).total;
  }, [ctx]);

  const disabledReason = conv.restoring
    ? 'Restoring this conversation…'
    : conv.threadError
      ? 'Restore this conversation before sending'
      : null;

  // A highlight belongs to one conversation: it applies only once that conversation is
  // the engine's transcript, and is dropped by the transcript if its message is not
  // there once the thread has finished restoring.
  const highlight =
    conv.highlight && conv.highlight.conversationId === engine.conversationId ? conv.highlight : null;
  const highlightReady = !!highlight && !conv.restoring && !conv.threadError;

  const title = caseScoped
    ? `Case ${caseId}`
    : summary?.title || conv.conversation?.title || (activeId ? 'Conversation' : 'New chat');

  const header = (
    <>
      {conv.requestedUnavailable ? (
        <NoticeCallout
          kind="unsupported"
          tone="info"
          title="Conversation not found"
          message={REQUESTED_UNAVAILABLE}
          secondaryLabel="Dismiss"
          onSecondary={conv.dismissRequestedUnavailable}
        />
      ) : null}
      {conv.threadRetention.note ? (
        <p className="border-l-2 border-warning px-3 py-1 text-xs leading-relaxed text-muted-foreground" role="note">
          {conv.threadRetention.note}
        </p>
      ) : null}
    </>
  );
  // A thread only shortened in place has no thread-level line: each compacted answer
  // carries its own quiet "Trimmed to fit storage" hint (SPEC A22).
  const hasHeader = conv.requestedUnavailable || !!conv.threadRetention.note;

  // Restoring replaces the transcript unless the engine already holds THIS thread (a
  // retry of the same thread keeps its answers in place). A transcript that belongs to
  // another thread never shows under this one's title.
  const restoringOther = conv.restoring && (!engine.items.length || engine.conversationId !== activeId);
  const replace = restoringOther ? (
    <LoadingState label="Restoring conversation" description="Loading the saved answers and their evidence." layout="panel" />
  ) : conv.threadError ? (
    <div className="space-y-3 pt-4">
      <NoticeCallout kind="provider" tone="critical" title="Could not restore this conversation" message={conv.threadError} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={conv.retryThread}>
          <RotateCcw aria-hidden />
          Retry
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={newChat}>
          Start new chat
        </Button>
      </div>
    </div>
  ) : null;

  const empty = (
    <EmptyState
      context={ctx}
      variant={caseScoped ? 'case' : 'workspace'}
      disabled={busy || !!disabledReason}
      // A failed /chat/context with nothing cached is an error with Retry, not skeletons.
      error={context.error}
      onRetry={context.refresh}
      onStarter={sendStarter}
    />
  );

  const rail = caseScoped ? null : geometry.rail;
  const railProps = {
    conversations: conv.conversations,
    activeId: conv.activeId,
    busy,
    loading: conv.listLoading,
    error: conv.listError,
    retention: conv.retention,
    search: {
      query: conv.searchQuery,
      setQuery: conv.setSearchQuery,
      results: conv.searchResults,
      searching: conv.searching,
      error: conv.searchError,
      openHit: (hit: Parameters<typeof conv.openSearchHit>[0]) => {
        conv.openSearchHit(hit);
        setHistoryOpen(false);
      },
    },
    onRetry: () => void conv.reload(),
    onNewChat: newChat,
    onSelect: select,
    onRename: (item: ChatConversationSummary, next: string) => void conv.rename(item, next),
    onTogglePin: (item: ChatConversationSummary) => void conv.setPinned(item, !item.pinned),
    onOpenReport: (item: ChatConversationSummary) => {
      setHistoryOpen(false);
      if (item.id === activeId) setPanelOpen(true);
      else if (!busy) {
        // Selection is refused while a turn runs; only then remember to open it.
        setPendingReportFor(item.id);
        conv.select(item);
      }
    },
    onExport: (item: ChatConversationSummary, format: ConversationExportFormat) => void exportThread(item.id, format),
    onDelete: (item: ChatConversationSummary) => void conv.remove(item),
    shortcuts: { newChat: CHAT_KEYSHORTCUTS.newChat, toggle: CHAT_KEYSHORTCUTS.toggleHistory },
  };

  // How the panel shows when open (decided with it open, so a closing overlay keeps
  // its Sheet mounted for the close transition and focus return).
  const panelMode = computeGeometry({
    frameWidth: geometry.frameWidth,
    railCollapsed: geometry.railCollapsed,
    panelOpen: true,
    panelWidth: geometry.panelWidth,
  }).panel;
  // The widest split panel that still leaves the conversation its 640 px.
  const railZone = rail === 'docked' ? RAIL_WIDTH + 1 : rail === 'strip' ? STRIP_WIDTH + 1 : 0;
  const panelMax = Math.min(PANEL_MAX, (geometry.frameWidth || 1600) - railZone - C_MIN - SPLIT_HANDLE_PX);
  const showPanel = panelOpen && !caseScoped;

  return (
    <div
      ref={geometry.frameRef}
      className="-my-6 flex h-[calc(100dvh-3.5rem)] min-h-0 min-w-0 overflow-hidden bg-background"
      data-testid="workspace-chat-page"
      data-rail={rail ?? 'none'}
      data-panel={showPanel ? panelMode : 'closed'}
    >
      <h1 className="sr-only">Chat</h1>

      {rail === 'docked' ? (
        // Not a landmark of its own: the rail's <nav> ("Chat history") is the landmark.
        <div className="flex w-[264px] shrink-0 flex-col border-r border-border bg-surface/40" data-testid="chat-history-rail">
          <HistoryRail {...railProps} onCollapse={() => geometry.setRailCollapsed(true)} />
        </div>
      ) : rail === 'strip' ? (
        <div className="w-12 shrink-0 border-r border-border bg-surface/40">
          <HistoryStrip
            busy={busy}
            onNewChat={newChat}
            onSearch={() => {
              setHistorySearchFocus(true);
              setHistoryOpen(true);
            }}
            onExpand={() => (geometry.railCollapsed && dockable ? geometry.setRailCollapsed(false) : setHistoryOpen(true))}
            shortcuts={railProps.shortcuts}
          />
        </div>
      ) : null}

      {rail === 'strip' || rail === 'sheet' ? (
        <Sheet
          open={historyOpen}
          onOpenChange={(open) => {
            setHistoryOpen(open);
            if (!open) setHistorySearchFocus(false);
          }}
        >
          <SheetContent
            side="left"
            size="sm"
            className="max-w-[20rem] gap-0 p-0"
            // No Radix trigger (History, the strip's buttons): return focus to the opener.
            onOpenAutoFocus={historyOpener.capture}
            onCloseAutoFocus={historyOpener.restore}
          >
            <SheetTitle className="sr-only">Conversations</SheetTitle>
            <SheetDescription className="sr-only">Search and open your saved chats.</SheetDescription>
            <HistoryRail {...railProps} inSheet autoFocusSearch={historySearchFocus} />
          </SheetContent>
        </Sheet>
      ) : null}

      <section className="flex min-w-0 flex-1 flex-col" aria-label="Conversation">
        <ThreadToolbar
          title={title}
          summary={caseScoped ? null : summary}
          caseScoped={caseScoped}
          railInSheet={rail === 'sheet'}
          onOpenHistory={() => setHistoryOpen(true)}
          onNewChat={newChat}
          wide={geometry.conversationWidth >= TOOLBAR_TOTAL_MIN}
          narrow={geometry.conversationWidth < TOOLBAR_COMPACT_MAX}
          report={caseScoped ? null : { count: report.count, open: panelOpen, onToggle: () => setPanelOpen((open) => !open) }}
          busy={busy}
          onRename={(next) => summary && void conv.rename(summary, next)}
          onTogglePin={() => summary && void conv.setPinned(summary, !summary.pinned)}
          onExport={(format) => activeId && void exportThread(activeId, format)}
          onDelete={() => summary && void conv.remove(summary)}
          shortcuts={{ newChat: CHAT_KEYSHORTCUTS.newChat, history: CHAT_KEYSHORTCUTS.toggleHistory }}
        />

        <Transcript
          engine={engine}
          label={caseScoped ? `Case ${caseId} messages` : 'Messages'}
          header={hasHeader ? header : null}
          replace={replace}
          empty={empty}
          highlight={highlight}
          highlightReady={highlightReady}
          onHighlightDone={conv.clearHighlight}
          onFocusComposer={focusComposer}
          reportFor={caseScoped ? undefined : report.bindingFor}
          continueEstimate={continueEstimate}
          onSavePrompt={caseScoped ? undefined : onSavePrompt}
        />

        {/* The transcript reserves a scrollbar gutter on both edges; the composer area
            reserves the same one (an overflow box with no overflow), so the composer's
            edges line up with the bubbles and prose above at every width. Its menus and
            popovers are portalled, so nothing here is clipped. */}
        <div className="shrink-0 overflow-hidden px-4 pb-4 pt-1 [scrollbar-gutter:stable_both-edges] sm:px-6">
          <div className={LANE_GRID}>
            <div className={`${CONTENT_COL} space-y-2`}>
              <BudgetAlert context={ctx} />
              <Composer
                ref={composerRef}
                engine={engine}
                context={ctx}
                variant={caseScoped ? 'case' : 'workspace'}
                disabledReason={disabledReason}
                onOpenShortcuts={() => setShortcutsOpen(true)}
                onComposerFocus={context.revalidate}
                contextError={context.error}
                onRetryContext={context.refresh}
                canChooseModel={canChooseModel}
                defaultModel={context.defaultModel}
                conversationTotals={summary ? { tokens: summary.total_tokens ?? null, cost: summary.total_cost ?? null } : null}
              />
            </div>
          </div>
        </div>
      </section>

      {showPanel && panelMode === 'split' ? (
        <ReportSplit
          width={geometry.panelWidth}
          maxWidth={panelMax}
          onResize={geometry.setPanelWidth}
          onClose={() => setPanelOpen(false)}
          conversationId={activeId}
          reportId={report.reportId}
        />
      ) : null}
      {!caseScoped && panelMode === 'overlay' ? (
        <ReportOverlay
          open={panelOpen}
          onOpenChange={setPanelOpen}
          conversationId={activeId}
          reportId={report.reportId}
        />
      ) : null}

      <ShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
