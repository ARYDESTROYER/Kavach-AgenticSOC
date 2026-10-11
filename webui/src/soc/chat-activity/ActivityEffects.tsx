/**
 * ActivityEffects — the shell's observer for chat turns (Round 12, SPEC D13), mounted
 * by AppShell beside `JobMonitor` through a lazy import, so none of it rides the
 * first-paint bundle (the eager side is only the store and the glyph).
 *
 *  - Lifetime: sign-out (the shell unmounts) and a change of user forget every turn and
 *    stop reading them (the server still finishes and saves them), in this tab and in
 *    the user's other tabs.
 *  - Other tabs: one BroadcastChannel carries this tab's own changes and applies the
 *    others' (scoped to the signed-in user), so two tabs agree; a closing tab hands its
 *    running turns over to this one.
 *  - The server: `GET /api/chat/turns/active` on load hands every running turn this tab
 *    does not know to the turn runner, which follows it WITHOUT holding a connection
 *    (a parked run: one cheap poll) and reads its real outcome when it ends. The
 *    conversation list adds titles, unread answers and waiting questions, and drops
 *    marks for threads that no longer exist. Owner-only `chat.turn` frames (auth on,
 *    realtime on, this tab visible, a parked turn running) only make that sooner.
 *  - Settled turns the analyst was not looking at: one deduplicated toast with Open
 *    (sonner's polite live region announces it; nothing else speaks it again).
 *  - The tab title: "●" while an answer is being written, "✓" for an unread one.
 *
 * Every title is prompt- or model-derived display text: it goes into toasts and the
 * title as plain text only (#9). Server labels are engine templates.
 */
import * as React from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { useEventStream, type StreamEvent } from '@/lib/useEventStream';
import { useOptionalAuth } from '@/soc/auth';
import type { Navigate } from '@/soc/router';
import { setDocumentTitlePrefix } from './title-prefix';
import {
  applyChatActivityMessage,
  chatActivityTitle,
  clearChatActivity,
  dropChatActivity,
  getChatActivity,
  markViewedChatActivitySeen,
  onChatActivity,
  patchChatActivity,
  putChatActivity,
  requestCaseChat,
  setChatActivitySink,
  useChatActivity,
  type ChatActivity,
  type ChatActivityMessage,
  type ChatActivitySettled,
} from './activity';

export const ACTIVITY_CHANNEL = 'agentic-soc-chat-activity';
/**
 * The conversation list read for titles and marks: one page holds every kept thread
 * (50 unpinned + 10 pinned, SPEC A9), so a thread missing from it no longer exists.
 */
const LIST_LIMIT = 60;
const TOAST_SEEN_LIMIT = 100;

/** Mounted shells (a development double mount must not clear a live store). */
let mounted = 0;
/** The user the newest channel belongs to (a closing one compares against it). */
let channelUser: string | null = null;

type Envelope =
  | { u: string; m: ChatActivityMessage }
  | { u: string; hello: true }
  | { u: string; release: string[] };

interface ActiveTurn {
  turn_id?: unknown;
  conversation_id?: unknown;
  case_id?: unknown;
  started_at?: unknown;
  label?: unknown;
  lookups?: unknown;
  status?: unknown;
}

interface ListedRow {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  unread?: unknown;
  updated_at?: unknown;
}

type Runner = typeof import('@/soc/chat/turn-runner');
let runner: Promise<Runner> | null = null;
/** The turn runner (the lazy chat code), loaded only when a turn has to be followed. */
function loadRunner(): Promise<Runner | null> {
  runner ??= import('@/soc/chat/turn-runner');
  return runner.catch(() => {
    runner = null;
    return null;
  });
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const safeId = (value: unknown): string | null => (typeof value === 'string' && SAFE_ID.test(value) ? value : null);
// Invisible, bidi and control characters never reach a toast or the title.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
function plain(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('').trimEnd()}…` : text;
}
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const find = (scope: string) => getChatActivity().entries.find((entry) => entry.scope === scope);

function scopeOf(turn: ActiveTurn): { scope: string; kind: ChatActivity['kind']; conversationId: string | null; caseId: string | null } | null {
  const turnId = safeId(turn.turn_id);
  if (!turnId) return null;
  const conversationId = safeId(turn.conversation_id);
  const caseId = safeId(turn.case_id);
  if (caseId) return { scope: `case:${caseId}`, kind: 'case', conversationId: null, caseId };
  if (conversationId) return { scope: `conv:${conversationId}`, kind: 'workspace', conversationId, caseId: null };
  return { scope: `turn:${turnId}`, kind: 'workspace', conversationId: null, caseId: null };
}

/** The tab-title prefix for a snapshot (exported for tests): ● working, ✓ unread. */
export function titlePrefix(entries: readonly ChatActivity[]): string {
  if (entries.some((entry) => entry.status === 'running')) return '●';
  if (entries.some((entry) => entry.status === 'unread')) return '✓';
  return '';
}

/** Toast copy for a turn that finished off screen (exported for tests). */
export function settledCopy(event: ChatActivitySettled): { heading: string; title: string; action: string } | null {
  if (event.viewed || event.outcome === 'stopped') return null;
  const title = chatActivityTitle(event.activity) || 'Chat';
  if (event.unreachable) {
    // A new thread that saved nothing: there is no conversation to open.
    return {
      heading: event.outcome === 'done' ? 'The answer could not be saved' : 'The answer could not be completed',
      title,
      action: 'Ask again',
    };
  }
  if (event.outcome === 'done') return { heading: 'Answer ready', title, action: 'Open' };
  if (event.outcome === 'needs_input') return { heading: 'A question needs your input', title, action: 'Open' };
  return { heading: 'The answer could not be completed', title, action: 'Open' };
}

export interface ActivityEffectsProps {
  /** The signed-in user ('' when auth is off): other tabs and a change of user key on it. */
  username?: string | null;
  onNavigate: Navigate;
}

const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export default function ActivityEffects({ username: user, onNavigate }: ActivityEffectsProps) {
  const username = user ?? '';
  const auth = useOptionalAuth();
  const authEnabled = auth?.authEnabled ?? false;
  const canRead = auth ? auth.hasPermission('cases', 'read') : true;
  // Selected slices only: the shell observer never re-renders on every step.
  const prefix = useChatActivity((snapshot) => titlePrefix(snapshot.entries));
  const parkedRunning = useChatActivity((snapshot) =>
    snapshot.entries.some((entry) => entry.source === 'local' && entry.parked === true && entry.status === 'running'),
  );
  const [visible, setVisible] = React.useState(isVisible);
  const navigateRef = React.useRef(onNavigate);
  navigateRef.current = onNavigate;

  /* ------------------------------------------------------------ lifetime -- */

  // Another user in the same shell: nothing of the previous one may show.
  const userRef = React.useRef(username);
  React.useEffect(() => {
    if (userRef.current === username) return;
    userRef.current = username;
    clearChatActivity();
  }, [username]);

  // The shell goes away on sign-out (or a session that ended): forget every turn and
  // stop reading them. Deferred one tick so a development double mount does not clear.
  React.useEffect(() => {
    mounted += 1;
    return () => {
      mounted -= 1;
      setTimeout(() => {
        if (mounted === 0) clearChatActivity();
      }, 0);
    };
  }, []);

  /**
   * Hand running turns to the turn runner, which follows them with no connection open
   * and reads how each one ended (its answer, question or failure).
   */
  const follow = React.useCallback(async (turns: ReadonlyArray<Pick<ChatActivity, 'scope' | 'kind' | 'conversationId' | 'caseId' | 'turnId' | 'title' | 'label' | 'lookups' | 'startedAt'>>) => {
    const runnerModule = await loadRunner();
    if (!runnerModule) return;
    for (const turn of turns) {
      const existing = find(turn.scope);
      // This tab already reads it, or another tab does.
      if (!turn.turnId || (existing?.status === 'running' && existing.source !== 'server')) continue;
      runnerModule.trackRun({
        scope: turn.scope,
        kind: turn.kind,
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        caseId: turn.caseId,
        title: turn.title || existing?.title || '',
        label: turn.label,
        lookups: turn.lookups,
        startedAt: turn.startedAt,
      });
    }
  }, []);

  /* ---------------------------------------------------------- other tabs -- */

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return undefined;
    let channel: BroadcastChannel;
    try {
      channel = new window.BroadcastChannel(ACTIVITY_CHANNEL);
    } catch {
      return undefined;
    }
    channelUser = username;
    const post = (envelope: Envelope) => {
      try {
        channel.postMessage(envelope);
      } catch {
        /* a closed channel: the other tabs fall back to the server */
      }
    };
    const locals = () => getChatActivity().entries.filter((entry) => entry.source === 'local');
    setChatActivitySink((m) => post({ u: username, m }));
    channel.onmessage = (event: MessageEvent<Envelope>) => {
      const data = event.data;
      if (!data || typeof data !== 'object' || data.u !== username) return;
      if ('m' in data) applyChatActivityMessage(data.m);
      else if ('hello' in data) for (const a of locals()) post({ u: username, m: { t: 'put', a } });
      else if ('release' in data && Array.isArray(data.release)) {
        // The other tab closed: this one follows its running turns now.
        const handed: ChatActivity[] = [];
        for (const scope of data.release) {
          const entry = typeof scope === 'string' ? find(scope) : undefined;
          if (!entry || entry.source !== 'peer') continue;
          dropChatActivity(entry.scope, false);
          if (entry.status === 'running') handed.push(entry);
        }
        if (handed.length) void follow(handed);
      }
    };
    post({ u: username, hello: true });
    const onHide = () => {
      const running = locals().filter((entry) => entry.status === 'running').map((entry) => entry.scope);
      if (running.length) post({ u: username, release: running });
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      setChatActivitySink(null);
      const closing = username;
      // Deferred like the clear above: a development double mount neither clears nor
      // tells the other tabs to. Sign-out (no shell left) or another user: this user's
      // other tabs forget too.
      setTimeout(() => {
        if (mounted === 0 || channelUser !== closing) post({ u: closing, m: { t: 'clear' } });
        channel.close();
      }, 0);
    };
  }, [follow, username]);

  /* -------------------------------------------------------------- server -- */

  /** Titles, unread answers and questions waiting on the analyst, from the list. */
  const reconcileList = React.useCallback(async () => {
    // Marks that change while the list loads are newer than it: they are left alone.
    const before = new Set(getChatActivity().entries);
    let rows: ListedRow[] = [];
    try {
      const response = await api.get<{ conversations?: unknown }>('chat/conversations', { limit: LIST_LIMIT });
      rows = Array.isArray(response?.conversations) ? (response.conversations as ListedRow[]) : [];
    } catch {
      return;
    }
    const byId = new Map<string, ListedRow>();
    for (const row of rows) {
      const id = safeId(row.id);
      if (id) byId.set(id, row);
    }
    for (const [id, row] of byId) {
      const scope = `conv:${id}`;
      const entry = find(scope);
      const title = plain(row.title, 80);
      if (entry) {
        if (!entry.title && title) patchChatActivity(scope, { title });
        continue;
      }
      if (row.unread !== true && row.status !== 'needs_input') continue;
      const question = row.status === 'needs_input';
      putChatActivity({
        scope,
        kind: 'workspace',
        conversationId: id,
        caseId: null,
        turnId: null,
        requestKey: null,
        title,
        label: null,
        lookups: 0,
        status: question ? 'needs_input' : 'unread',
        // A question the analyst already opened (read) stays, but is not news.
        ...(question ? { seen: row.unread !== true } : {}),
        startedAt: Date.parse(String(row.updated_at)) || Date.now(),
        source: 'server',
      });
    }
    // A thread the list no longer has (deleted, or a new thread that was never saved)
    // can never be opened, and a question answered elsewhere waits no more.
    for (const entry of getChatActivity().entries) {
      if (!before.has(entry) || entry.kind !== 'workspace' || !entry.conversationId || entry.status === 'running') continue;
      const row = byId.get(entry.conversationId);
      if (!row || (entry.status === 'needs_input' && row.status !== 'needs_input')) dropChatActivity(entry.scope);
    }
  }, []);

  /** `GET /chat/turns/active`: running turns this tab does not know go to the runner. */
  const pollActive = React.useCallback(async (): Promise<void> => {
    let turns: ActiveTurn[];
    try {
      const response = await api.get<unknown>('chat/turns/active');
      turns = Array.isArray(response) ? (response as ActiveTurn[]) : [];
    } catch {
      return;
    }
    const unknown = turns.flatMap((turn) => {
      const where = scopeOf(turn);
      const existing = where ? find(where.scope) : undefined;
      if (!where || (existing?.status === 'running' && existing.source !== 'server')) return [];
      return [
        {
          ...where,
          turnId: safeId(turn.turn_id),
          title: existing?.title ?? '',
          label: plain(turn.label, 120) || null,
          lookups: count(turn.lookups),
          startedAt: Date.parse(String(turn.started_at)) || Date.now(),
        },
      ];
    });
    if (unknown.length) await follow(unknown);
  }, [follow]);

  // On load (and for another user): turns still running after a reload, then the list
  // (titles for them, unread answers, waiting questions, marks for gone threads).
  React.useEffect(() => {
    if (!canRead) return;
    void pollActive().then(reconcileList);
  }, [canRead, pollActive, reconcileList, username]);

  const onFrame = React.useCallback(
    (event: StreamEvent) => {
      if (event.type !== 'chat.turn' || !event.data || typeof event.data !== 'object') return;
      const frame = event.data as ActiveTurn & { phase?: unknown };
      const turnId = safeId(frame.turn_id);
      if (!turnId) return;
      const entry = getChatActivity().entries.find((item) => item.turnId === turnId);
      if (frame.phase === 'progress') {
        if (entry?.source === 'local' && entry.parked) {
          patchChatActivity(entry.scope, { label: plain(frame.label, 120) || null, lookups: count(frame.lookups) });
        }
        return;
      }
      // Ended: the runner reads how (sooner than its poll). Started elsewhere: follow it.
      if (entry) void loadRunner().then((module) => module?.pollParkedRuns());
      else if (frame.phase === 'started') void pollActive();
    },
    [pollActive],
  );
  useEventStream(['chat'], { enabled: canRead && authEnabled && parkedRunning && visible, onEvent: onFrame });

  /* ------------------------------------------------------------- toast -- */

  const toastedRef = React.useRef<string[]>([]);
  React.useEffect(
    () =>
      onChatActivity('settled', (event) => {
        const copy = settledCopy(event);
        if (!copy) return;
        const { activity } = event;
        // A peer tab's turn: only a tab someone is looking at speaks up.
        if (activity.source !== 'local' && typeof document !== 'undefined' && document.hidden) return;
        const key = activity.turnId ?? activity.requestKey ?? `${activity.scope}@${activity.startedAt}`;
        if (toastedRef.current.includes(key)) return;
        toastedRef.current = [...toastedRef.current.slice(-TOAST_SEEN_LIMIT), key];
        const prompt = event.prompt;
        const open = () => {
          if (event.unreachable) {
            // Nothing to open: a new chat with the question ready to send again.
            navigateRef.current('chat', prompt ? { newChat: true, ask: prompt } : { newChat: true });
          } else if (activity.kind === 'case' && activity.caseId) {
            requestCaseChat(activity.caseId);
            navigateRef.current('case_manager', { caseId: activity.caseId, tab: 'chat' });
          } else if (activity.conversationId) navigateRef.current('chat', { conversationId: activity.conversationId });
          else navigateRef.current('chat');
        };
        // The toaster's own polite live region announces it (once): no second voice.
        const options = { id: `chat-${key}`, description: copy.title, duration: 9_000, action: { label: copy.action, onClick: open } };
        if (event.outcome === 'done' && !event.unreachable) toast.success(copy.heading, options);
        else if (event.outcome === 'needs_input' && !event.unreachable) toast.warning(copy.heading, options);
        else toast.error(copy.heading, options);
      }),
    [],
  );

  /* ----------------------------------------------------- title, visibility -- */

  React.useEffect(() => {
    setDocumentTitlePrefix(prefix);
  }, [prefix]);
  React.useEffect(() => () => setDocumentTitlePrefix(''), []);

  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVisible = () => {
      setVisible(isVisible());
      if (document.visibilityState === 'visible') markViewedChatActivitySeen();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return null;
}
