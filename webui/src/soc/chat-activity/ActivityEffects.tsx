/**
 * ActivityEffects — the shell's observer for chat turns (Round 12, SPEC D13), mounted
 * by AppShell beside `JobMonitor` through a lazy import, so none of it rides the
 * first-paint bundle (the eager side is only the store and the glyph).
 *
 *  - Lifetime: a sign-out (or a session that ended) and a change of user forget every
 *    turn and stop reading them (the server still finishes and saves them), in this tab
 *    and in the user's other tabs. The shell also goes away while the user stays signed
 *    in (the setup wizard, a boot error): then nothing is forgotten, so the shell asks
 *    the server who is signed in before it clears anything.
 *  - Other tabs: one BroadcastChannel carries this tab's own changes and applies the
 *    others' (scoped to the signed-in user), so two tabs agree; a closing tab hands its
 *    running turns over to this one.
 *  - The server: `GET /api/chat/turns/active` on load hands every running turn this tab
 *    does not know to the turn runner, which follows it WITHOUT holding a connection
 *    (a parked run: one cheap poll) and reads its real outcome when it ends. The
 *    conversation list adds titles, unread answers and waiting questions, and drops
 *    marks for threads that no longer exist. No live connection of its own: the
 *    runner's poll hears that a followed turn ended (a browser allows only six
 *    connections to the console, and the shell's streams already hold some).
 *  - Settled turns the analyst was not looking at: one deduplicated toast with Open
 *    (sonner's polite live region announces it; nothing else speaks it again).
 *  - The tab title: "●" while an answer is being written, "✓" for an unread one.
 *
 * Every title is prompt- or model-derived display text: it is cleaned with the chat's
 * shared sanitizer (`displayText`: invisible, bidi, TAG and control characters go) and
 * goes into toasts and the title as plain text only (#9). Server labels are engine
 * templates, cleaned the same way.
 */
import * as React from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { useOptionalAuth } from '@/soc/auth';
import { displayText } from '@/soc/chat/stream-events';
import type { NavOpts } from '@/lib/types';
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
/** The user whose turns the store holds: a shell for another user starts clean. */
let storeUser: string | null = null;

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
/** Server text (a listed title, a step label) as one clean line: the rail's own sanitizer. */
const plain = (value: unknown, limit: number): string => (typeof value === 'string' ? displayText(value, limit) : '');
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

/**
 * Where "Ask again" goes for a new chat that saved nothing (exported for tests). Only the
 * analyst's own words (`origin: user`) are put back in a composer for them to send. A
 * question they did not type (an Ask AI or "Ask about this" question, a starter, a
 * follow-up) is sent again with its own origin and topic and never prefilled, so its
 * log- or console-derived text never becomes theirs (#9; the page re-validates it).
 */
export function askAgainOpts(event: Pick<ChatActivitySettled, 'prompt' | 'origin' | 'topic'>): NavOpts {
  const prompt = event.prompt;
  if (!prompt) return { newChat: true };
  if (event.origin === 'user') return { newChat: true, ask: prompt };
  if (!event.origin) return { newChat: true };
  return { newChat: true, resend: { message: prompt, origin: event.origin, topic: event.topic ?? null } };
}

export interface ActivityEffectsProps {
  /** The signed-in user ('' when auth is off): other tabs and a change of user key on it. */
  username?: string | null;
  onNavigate: Navigate;
}

/** Tell `user`'s other tabs to forget (a sign-out, or another user in this browser). */
function broadcastClear(user: string): void {
  if (typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return;
  try {
    const channel = new window.BroadcastChannel(ACTIVITY_CHANNEL);
    channel.postMessage({ u: user, m: { t: 'clear' } } satisfies Envelope);
    channel.close();
  } catch {
    /* best effort: the other tabs' own requests fail and send them to sign in */
  }
}

/**
 * The shell went away (it is not shown any more). That alone is no sign-out: the setup
 * wizard and a boot error after a passing `/auth/me` failure replace the shell while the
 * user stays signed in, and their turns must go on (also in their other tabs). So ask the
 * server: only a confirmed sign-out, an ended session or another user forgets every turn,
 * here (unless a shell came back meanwhile) and in this user's other tabs. With auth off
 * nobody signs out; when the server cannot be asked, nothing is forgotten (a shell for
 * another user still starts clean, see `storeUser`).
 */
async function forgetIfSignedOut(closing: string): Promise<void> {
  let me: unknown;
  try {
    me = await api.get<unknown>('auth/me');
  } catch {
    return;
  }
  if (!me || typeof me !== 'object') return;
  const state = me as { auth_enabled?: unknown; authenticated?: unknown; user?: { username?: unknown } | null };
  if (state.auth_enabled !== true) return;
  const signedIn = state.authenticated === true && typeof state.user?.username === 'string' ? state.user.username : null;
  if (signedIn !== null && signedIn === closing) return;
  if (mounted === 0) {
    clearChatActivity(false);
    storeUser = null;
  }
  broadcastClear(closing);
}

export default function ActivityEffects({ username: user, onNavigate }: ActivityEffectsProps) {
  const username = user ?? '';
  const auth = useOptionalAuth();
  const authEnabled = auth?.authEnabled ?? false;
  const canRead = auth ? auth.hasPermission('cases', 'read') : true;
  // Selected slices only: the shell observer never re-renders on every step.
  const prefix = useChatActivity((snapshot) => titlePrefix(snapshot.entries));
  const navigateRef = React.useRef(onNavigate);
  navigateRef.current = onNavigate;
  const signInRef = React.useRef({ username, authEnabled });
  signInRef.current = { username, authEnabled };

  /* ------------------------------------------------------------ lifetime -- */

  // Another user (in this shell, or in a shell that came back): nothing of the previous
  // one may show. Local only: the previous user's other tabs are told by the closing
  // channel (below) or by `forgetIfSignedOut`.
  React.useEffect(() => {
    if (storeUser !== null && storeUser !== username) clearChatActivity(false);
    storeUser = username;
  }, [username]);

  // The shell goes away. Deferred one tick so a development double mount does nothing;
  // then only a sign-out the server confirms forgets (see `forgetIfSignedOut`).
  React.useEffect(() => {
    mounted += 1;
    return () => {
      mounted -= 1;
      const { username: closing, authEnabled: withAuth } = signInRef.current;
      setTimeout(() => {
        if (mounted === 0 && withAuth) void forgetIfSignedOut(closing);
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
      channel.onmessage = null;
      channel.close();
      const closing = username;
      // Deferred like the lifetime check above: a development double mount tells the
      // other tabs nothing. Another user in this shell: this user's other tabs forget
      // too. A shell that simply went away tells them nothing here (a sign-out is
      // confirmed with the server first, see `forgetIfSignedOut`).
      setTimeout(() => {
        if (mounted > 0 && channelUser !== closing) broadcastClear(closing);
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
        const open = () => {
          if (event.unreachable) {
            // Nothing to open: a new chat that asks the question again.
            navigateRef.current('chat', askAgainOpts(event));
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
      if (document.visibilityState === 'visible') markViewedChatActivitySeen();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return null;
}
