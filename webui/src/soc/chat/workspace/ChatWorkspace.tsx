/**
 * ChatWorkspace — the Chat page frame (chat revamp SPEC §10.1, §10.1a, §10.2, §10.6).
 *
 *   ┌ rail (264 px | 48 px strip | Sheet) ┬ toolbar (44 px) ──────────────┬ report ┐
 *   │ New chat · search · Pinned · Today… │ transcript (role=log)          │ panel  │
 *   │                                     │ budget alert · composer        │ (split │
 *   └─────────────────────────────────────┴────────────────────────────────┴ /sheet)┘
 *
 * Chrome contract: the frame bleeds the shell's whole inset (`-mx-4 -my-6 sm:-mx-6`
 * with `w-auto`, the matched pair of `CONTENT_INSET`'s `px-4 py-6 sm:px-6`), so the rail,
 * strip and report panel sit flush with the nav rail and the window edge and there are
 * no canvas strips beside the chat (Round 12, diagnosis/layout.md (h)). It is exactly
 * `100dvh − 3.5rem` tall, so nothing overflows the document at any reference size, and
 * `overflow-clip` (not `hidden`): a clipped box cannot be scrolled programmatically, so a
 * `focus()`, a contents jump or find-in-page can never slide the toolbar under the header
 * or leave a blank band below the composer (diagnosis (d)). One sr-only `<h1>Chat</h1>`,
 * the thread title is the toolbar `<h2>` and every turn has a hidden `<h3>`. Zones follow
 * the MEASURED frame width (`useChatGeometry`), and exactly one New chat is visible at
 * every width (rail header, icon strip, or toolbar when the rail is a Sheet).
 *
 * The conversation zone is an `@container` that sets the lane's gutter and cap
 * (`laneVars`, from the viewer's width preference in the thread ⋯ menu), so the
 * transcript and the composer share one lane (lane.ts).
 *
 * The hooks (`useChatConversations`, `useChatEngine`, `useChatContext`) live in the
 * page; this component renders them and owns presentation state only.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { RotateCcw } from 'lucide-react';

import type { ChatConversation, ChatConversationSummary, ChatStarter, StarterSurface } from '@/lib/types';
import { Button } from '@/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet';
import { LoadingState } from '@/design-system/loading';
import { useAuth } from '@/soc/auth';
import { useAnnouncer } from '@/soc/components/announcer';
import { useOptionalPrefs } from '@/soc/prefs';
import { postChatStarterEvent } from '../chat-api';
import { BudgetAlert } from '../composer/BudgetAlert';
import { Composer, type ComposerHandle } from '../composer/Composer';
import { pickPromptFromLibrary } from '../composer/library-events';
import { EmptyState } from '../empty/EmptyState';
import { LANE_COL, LANE_GRID, laneVars } from '../message/lane';
import { NoticeCallout } from '../message/NoticeCallout';
import { Transcript } from '../message/Transcript';
import { announcedLookupBound, useTurnAnnouncer } from '../message/useTurnAnnouncer';
import { ShortcutSheet } from '../shortcuts/ShortcutSheet';
import { ThreadCatchUp } from '../starters/ThreadCatchUp';
import { useChatStarters, useStarterViewed } from '../starters/useChatStarters';
import { CHAT_KEYSHORTCUTS, useChatShortcuts } from '../shortcuts/useChatShortcuts';
import type { ChatConversationsController } from '../useChatConversations';
import type { ChatContextController } from '../useChatContext';
import { type ChatEngine, type ChatUserItem } from '../useChatEngine';
import { EARLIER_LOAD_ERROR, EARLIER_MISSING_ERROR, useEarlierMessages } from '../useEarlierMessages';
import { HistoryRail, HistoryStrip, type ConversationExportFormat } from './HistoryRail';
import { ReportOverlay, ReportSplit } from './ReportPanelHost';
import { ThreadToolbar } from './ThreadToolbar';
import { useChatLaneWidth } from './useChatLaneWidth';
import { useConversationReport } from './useConversationReport';
import { useConversationExport } from './useConversationExport';
import { useFocusAfterSwap, useOpenerFocus } from './useOpenerFocus';
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
  const { hasPermission, username } = useAuth();
  const principal = username ?? author ?? null;
  // The model picker lists `/api/models`, which needs models:read (SPEC §10.4).
  const canChooseModel = hasPermission('models', 'read');
  const composerRef = React.useRef<ComposerHandle>(null);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historySearchFocus, setHistorySearchFocus] = React.useState(false);
  // However the sheet closed (a pick or New chat closes it without onOpenChange), the
  // next open records its opener as usual: only Search chats moves focus into the
  // search field itself (left on, the field took focus before the opener was recorded).
  React.useEffect(() => {
    if (!historyOpen) setHistorySearchFocus(false);
  }, [historyOpen]);
  const historyOpener = useOpenerFocus();
  // Collapse history / Show history (and the shortcut) swap the rail and the strip, and
  // the docked report's Close button leaves with the panel: focus that went with them
  // moves to the toggle that is on screen now, quietly (Round 13 polish).
  const focusAfterSwap = useFocusAfterSwap();
  const railZoneRef = React.useRef<HTMLDivElement>(null);
  const conversationRef = React.useRef<HTMLElement>(null);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [pendingReportFor, setPendingReportFor] = React.useState<string | null>(null);
  const geometry = useChatGeometry(panelOpen && !caseScoped);
  // Older messages of a long saved conversation ("Show earlier messages", Round 12).
  const earlier = useEarlierMessages({
    conversation: caseScoped ? null : conv.conversation,
    engine,
    onLoaded: (added) => {
      if (added > 0) announce(`Loaded ${added} earlier ${added === 1 ? 'message' : 'messages'}`);
    },
  });
  const laneWidth = useChatLaneWidth();
  const busy = engine.busy;
  const ctx = context.context;

  // A lookup limit is spoken only in `bounded` mode (chat is unlimited by default, D1).
  useTurnAnnouncer(engine, announcedLookupBound(ctx));

  const activeId = typeof conv.activeId === 'string' ? conv.activeId : null;
  const summary = conv.activeSummary;

  /* -------------------------------------------- suggestions (Round 13, Part A) -- */

  // The viewer's "Suggestions when a chat starts" (`UserPrefs.misc.chat_suggest_start`,
  // absent = on). Nothing is requested before the preferences are known, and nothing at
  // all while the viewer has them off (SPEC-chat §3.11). Without a provider (a
  // standalone render) they are on.
  const prefsCtx = useOptionalPrefs();
  const suggestKnown = !prefsCtx || prefsCtx.ready;
  const suggestOn = !prefsCtx || prefsCtx.prefs.misc?.chat_suggest_start !== false;
  const suggest = suggestKnown && suggestOn;
  // The new-chat start stack is on screen (a deliberate New chat with no message yet).
  const homeActive = !caseScoped && conv.enabled && conv.activeId === null && engine.items.length === 0;
  // An open, restored Workspace thread whose transcript is the engine's.
  const threadOpen =
    !caseScoped &&
    !!activeId &&
    !conv.restoring &&
    !conv.threadError &&
    engine.conversationId === activeId &&
    engine.items.length > 0;
  const homeStarters = useChatStarters({ surface: 'home', principal, enabled: homeActive && suggest, poll: true });
  // The cards on screen (StartScreen reports them) travel with the `viewed` event.
  const shownKeysRef = React.useRef<string[]>([]);
  const onShownKeysChange = React.useCallback((keys: string[]) => {
    shownKeysRef.current = keys;
  }, []);
  // A thread counts as OPENED (a visit to it) when it was read back from history; the
  // thread a first send just created in this view is not a second visit.
  const threadOpened = threadOpen && engine.items.some((item) => item.kind === 'assistant' && item.restored);
  const flushViewed = useStarterViewed({
    target: !suggest ? null : homeActive ? `home:${conv.transcriptEpoch}` : threadOpened ? `thread:${activeId}` : null,
    surface: homeActive ? 'home' : 'thread',
    enabled: suggest,
    ready: !homeActive || !homeStarters.loading,
    keys: () => shownKeysRef.current,
  });
  // The first send counts as seen even before the 2 seconds are up (§3.10).
  React.useEffect(() => {
    if (busy) flushViewed();
  }, [busy, flushViewed]);
  // When the thread's last answer settled (restored answers carry their saved time).
  let lastAnswerAt: number | null = null;
  for (let i = engine.items.length - 1; i >= 0; i -= 1) {
    const item = engine.items[i];
    if (item.kind !== 'assistant') continue;
    lastAnswerAt = item.status === 'running' ? null : item.at;
    break;
  }

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
  const { select: selectConversation } = conv;
  // A starter card, catch-up clause or case chip (SPEC-chat §3.9). A `send` card sends
  // its server-worded question exactly, with origin `starter`, and is replaced by the
  // transcript: focus stays in the composer (SPEC §10.9) instead of dropping to <body>.
  // `open_conversation` selects the analyst's own conversation (nothing is sent) and
  // hands focus to the composer, the same landing point as a send: the card is replaced
  // by the restoring thread, so focus must not drop to <body>. `use_prompt` runs the
  // analyst's saved prompt through the library's Use (the composer fills or asks for its
  // values, and places focus; sent later as the analyst's own words). A used Workspace
  // card is recorded (`used`); a case chip records nothing.
  const activateStarter = React.useCallback(
    (starter: ChatStarter, surface: StarterSurface) => {
      const action = starter.action ?? 'send';
      let used = false;
      if (action === 'send') {
        flushViewed();
        used = engine.send(starter.prompt, { origin: 'starter' });
        if (used) focusComposer();
      } else if (action === 'open_conversation' && starter.ref?.kind === 'conversation') {
        selectConversation(starter.ref.value);
        setHistoryOpen(false);
        focusComposer();
        used = true;
      } else if (action === 'use_prompt' && starter.ref?.kind === 'prompt') {
        pickPromptFromLibrary(starter.ref.value);
        used = true;
      }
      if (used && surface !== 'case' && starter.key) {
        void postChatStarterEvent({ type: 'used', surface, keys: [starter.key] }).catch(() => {
          /* presentation state only */
        });
      }
    },
    [engine, flushViewed, focusComposer, selectConversation],
  );

  // Never refused while an answer is being written: the turn keeps running in the
  // turn runner and the history row shows it (SPEC D13).
  const newChat = React.useCallback(() => {
    conv.startNew();
    setHistoryOpen(false);
    // After the draft paints (the composer stays mounted).
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [conv]);

  const select = React.useCallback(
    (item: ChatConversationSummary) => {
      conv.select(item);
      setHistoryOpen(false);
    },
    [conv],
  );

  // One guarded runner per conversation: progress, a result toast and the PDF guidance
  // before the print dialog, like a report export (useConversationExport).
  const { run: exportThread } = useConversationExport({ author });

  // Whether un-collapsing would actually dock the rail right now (an open split panel
  // may be what keeps it a strip; then the Sheet is the way to see history).
  const dockable =
    computeGeometry({
      frameWidth: geometry.frameWidth,
      railCollapsed: false,
      panelOpen: panelOpen && !caseScoped,
      panelWidth: geometry.panelWidth,
    }).rail === 'docked';
  // Docked ↔ strip: the toggle on screen afterwards (Show history or Collapse history)
  // takes a focus the swap dropped.
  const setRailCollapsed = React.useCallback(
    (collapsed: boolean) => {
      geometry.setRailCollapsed(collapsed);
      focusAfterSwap(() => railZoneRef.current?.querySelector<HTMLElement>('[data-history-toggle]'));
    },
    [focusAfterSwap, geometry],
  );
  const toggleHistory = React.useCallback(() => {
    if (caseScoped) return;
    if (geometry.rail === 'docked') setRailCollapsed(true);
    else if (geometry.rail === 'strip' && geometry.railCollapsed && dockable) setRailCollapsed(false);
    else setHistoryOpen((open) => !open);
  }, [caseScoped, dockable, geometry, setRailCollapsed]);

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
  const highlightRestored = !!highlight && !conv.restoring && !conv.threadError;
  // A requested message older than the messages on screen (a search hit or a link into a
  // long conversation): page back to it first (Round 12), then highlight it.
  const highlightShown =
    !!highlight && engine.items.some((item) => item.key === highlight.messageId || item.messageId === highlight.messageId);
  // (A question asked in this session carries its saved id, `user_message_id`, so a hit
  // on it is shown and never reads the conversation's older history.)
  //
  // A seek belongs to one request (its nonce) and one read of the conversation: a fresh
  // read (Reopen conversation after a 404, or opening the conversation again) seeks a
  // request that is still pending in the new copy. A request stays pending only until
  // the transcript shows or drops it (it then clears it), so this never reads back for
  // a message already handled.
  const [seeked, setSeeked] = React.useState<{ nonce: number; conversation: ChatConversation | null } | null>(null);
  const seekStarted = !!highlight && seeked?.nonce === highlight.nonce && seeked.conversation === conv.conversation;
  // Only against a read of the highlight's own conversation: while another one is
  // being handed to the engine, `earlier` still describes the previous read for a
  // render, and a seek then would read the wrong conversation.
  const seekOwnRead = !!highlight && conv.conversation?.id === highlight.conversationId;
  const seekOlder = highlightRestored && seekOwnRead && !highlightShown && earlier.remaining > 0;
  const { loadUntil, load: loadEarlier, loading: earlierLoading } = earlier;
  const retryThread = conv.retryThread;
  // What the page shows now, for a toast action raised earlier (see below).
  const shownConversationRef = React.useRef(conv.conversation);
  shownConversationRef.current = conv.conversation;
  const failedSeekRef = React.useRef(earlier.failedSeek);
  failedSeekRef.current = earlier.failedSeek;
  React.useEffect(() => {
    // A "Show earlier messages" load still running is waited for: the seek starts
    // once it lands (from the cursor it leaves), and is never used up meanwhile.
    if (!seekOlder || !highlight || seekStarted || earlierLoading) return;
    const raisedFor = conv.conversation;
    const { messageId, nonce } = highlight;
    setSeeked({ nonce, conversation: raisedFor });
    void loadUntil(messageId).then((outcome) => {
      if (outcome !== 'failed' && outcome !== 'missing') return;
      // The request stays pending (see highlightReady) and the transcript shows the
      // error at its top; the toast says so wherever the reader is, in the same words
      // and with the same action as the transcript's control. The kind comes from the
      // outcome itself: `earlier.errorKind` is not rendered yet when this runs.
      const gone = outcome === 'missing';
      // An action acts only on the request it was raised for: never on another
      // conversation (or a fresh read of this one, which seeks again by itself), and
      // never once that read-back was resumed elsewhere.
      const stillPending = () => shownConversationRef.current === raisedFor && failedSeekRef.current === messageId;
      toast.error('Could not open that message', {
        description: gone ? EARLIER_MISSING_ERROR : EARLIER_LOAD_ERROR,
        action: gone
          ? {
              label: 'Reopen conversation',
              onClick: () => {
                if (stillPending()) retryThread();
              },
            }
          : {
              label: 'Retry',
              onClick: () => {
                if (stillPending()) loadEarlier();
              },
            },
      });
    });
  }, [conv.conversation, highlight, loadUntil, loadEarlier, retryThread, seekOlder, seekStarted, earlierLoading]);
  // Held back while the read-back runs, or after it failed (Retry or Reopen resumes
  // it): the transcript must not take a failed read for "not in this conversation" and
  // jump to the latest turn.
  const seekFailed = !!highlight && earlier.failedSeek === highlight.messageId;
  const highlightReady =
    highlightRestored && !(!highlightShown && (earlierLoading || seekFailed || (seekOlder && !seekStarted)));

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
      // The case variant's access popover shows a failed /chat/context with Retry.
      error={context.error}
      onRetry={context.refresh}
      onStarter={(starter) => activateStarter(starter, caseScoped ? 'case' : 'home')}
      // The start stack's cards: null while the viewer has suggestions off (no request).
      // A case-scoped chat reads its own case chips (the empty state's chips do).
      starters={caseScoped ? undefined : suggestOn ? { ...homeStarters, loading: homeStarters.loading || !suggestKnown } : null}
      principal={principal}
      onShownKeysChange={onShownKeysChange}
      caseId={caseId}
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
      else {
        // Select it, then open the panel once it is active.
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
      className="-mx-4 -my-6 flex h-[calc(100dvh-3.5rem)] w-auto min-h-0 min-w-0 overflow-clip bg-background sm:-mx-6"
      data-testid="workspace-chat-page"
      data-rail={rail ?? 'none'}
      data-panel={showPanel ? panelMode : 'closed'}
      data-lane-width={laneWidth.width}
    >
      <h1 className="sr-only">Chat</h1>

      {rail === 'docked' ? (
        // Not a landmark of its own: the rail's <nav> ("Chat history") is the landmark.
        <div ref={railZoneRef} className="flex w-[264px] shrink-0 flex-col border-r border-border bg-surface/40" data-testid="chat-history-rail">
          <HistoryRail {...railProps} onCollapse={() => setRailCollapsed(true)} />
        </div>
      ) : rail === 'strip' ? (
        <div ref={railZoneRef} className="w-12 shrink-0 border-r border-border bg-surface/40">
          <HistoryStrip
            busy={busy}
            onNewChat={newChat}
            onSearch={() => {
              // The rail focuses its search field as it mounts, so the sheet's open
              // event (where the opener is usually recorded) never fires: record Search
              // chats now, or closing the sheet would drop focus to the page.
              historyOpener.capture();
              setHistorySearchFocus(true);
              setHistoryOpen(true);
            }}
            onExpand={() => (geometry.railCollapsed && dockable ? setRailCollapsed(false) : setHistoryOpen(true))}
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

      <section
        ref={conversationRef}
        className="@container flex min-w-0 flex-1 flex-col"
        aria-label="Conversation"
        style={laneVars(laneWidth.width) as React.CSSProperties}
      >
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
          laneWidth={{ value: laneWidth.width, onChange: laneWidth.setWidth }}
        />

        <Transcript
          engine={engine}
          label={caseScoped ? `Case ${caseId} messages` : 'Messages'}
          header={hasHeader ? header : null}
          earlier={
            caseScoped
              ? null
              : {
                  remaining: earlier.remaining,
                  loading: earlier.loading,
                  error: earlier.error,
                  errorKind: earlier.errorKind,
                  // Gone (404): re-read the conversation instead of repeating the read.
                  onReopen: conv.retryThread,
                  loadedAny: earlier.loadedAny,
                  onLoad: earlier.load,
                }
          }
          replace={replace}
          empty={empty}
          highlight={highlight}
          highlightReady={highlightReady}
          onHighlightDone={conv.clearHighlight}
          onFocusComposer={focusComposer}
          reportFor={caseScoped ? undefined : report.bindingFor}
          onSavePrompt={caseScoped ? undefined : onSavePrompt}
        />

        {/* The transcript reserves a scrollbar gutter on both edges; the composer area
            reserves the same one (an overflow box with no overflow), and both take their
            side gutters from the lane grid's tracks, so the composer spans exactly the
            lane above (the prose's left edge to the bubble's right edge) at every width.
            Its menus and popovers are portalled, so nothing here is clipped. */}
        <div className="shrink-0 overflow-hidden pb-4 pt-1 [scrollbar-gutter:stable_both-edges]">
          <div className={LANE_GRID}>
            <div className={`${LANE_COL} space-y-2`}>
              <BudgetAlert context={ctx} />
              {caseScoped ? null : (
                <ThreadCatchUp
                  conversationId={threadOpen ? activeId : null}
                  principal={principal}
                  enabled={suggest}
                  lastAnswerAt={lastAnswerAt}
                  draftEmpty={!engine.draft.trim()}
                  busy={busy}
                  disabled={!!disabledReason}
                  onSend={(starter) => activateStarter(starter, 'thread')}
                  // Hide removes the line: focus lands in the composer right below it.
                  onHidden={focusComposer}
                />
              )}
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
          onClose={() => {
            setPanelOpen(false);
            // Its Close button leaves with the panel: back to the toolbar's Report toggle.
            focusAfterSwap(() => conversationRef.current?.querySelector<HTMLElement>('[data-testid="chat-report-toggle"]'));
          }}
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
