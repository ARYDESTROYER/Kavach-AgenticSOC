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
 *    marks for threads that no longer exist.
 *  - Live frames: the caller's own `chat.turn` frames (topic `chat`, owner-only) ride the
 *    shell's job stream (`JobMonitor` relays them, `relayChatFrame`), so this observer
 *    opens no connection of its own (a browser allows only six to the console, and the
 *    shell's streams already hold some). A frame is a nudge, never the truth: a turn
 *    this tab does not know (another device or browser) is looked up in
 *    `turns/active` and followed like one found on load; a parked run's frame updates
 *    its step label, and its end wakes the run to read the outcome now; a turn that
 *    ended before it was followed sends the list to be read for its mark, which is
 *    announced like a followed turn's (a failure is marked only). An outcome the
 *    analyst sees on another console is no news here (`chat.read`): a console that marks
 *    a conversation read sends one for that conversation, and a console that puts a
 *    turn's outcome on screen (an answer, a question or a failure, in a Workspace or a
 *    Case Manager chat, which lists several) sends one for each turn it shows
 *    (`POST …/turns/{id}/seen`, from the `shown` signal). Exactly that turn's mark and
 *    toast go (never another turn's in the same chat), and a mark for it that lands a
 *    moment later goes too, with no toast; a conversation read drops its mark and holds
 *    any on its way until a new turn's frame there arrives (30 seconds at most). A turn
 *    this tab only follows waits a short grace before it marks or announces anything
 *    (`followGraceMs`), so a "seen" from the console that asked can land first. Polling stays the fallback: on
 *    load, when the tab becomes visible again (with authentication off no frame is
 *    sent), after an `overflow`, and the runner's park poll.
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
  isChatActivitySettling,
  markChatActivitySeen,
  markViewedChatActivitySeen,
  onChatActivity,
  patchChatActivity,
  putChatActivity,
  requestCaseChat,
  setChatActivitySink,
  setChatFrameSink,
  setChatSettlePolicy,
  subscribeChatActivity,
  useChatActivity,
  type ChatActivity,
  type ChatActivityMessage,
  type ChatActivitySettled,
  type ChatFrame,
} from './activity';

export const ACTIVITY_CHANNEL = 'agentic-soc-chat-activity';
/**
 * The conversation list read for titles and marks: one page holds every kept thread
 * (50 unpinned + 10 pinned, SPEC A9), so a thread missing from it no longer exists.
 */
const LIST_LIMIT = 60;
const TOAST_SEEN_LIMIT = 100;
/**
 * Frame timings (mutable for tests only):
 *  - `settleMs`: a turn a frame reports is looked up after this pause (the frames of one
 *    moment make one request, and the other device's analyst may have read an answer by
 *    then);
 *  - `askAgainMs`: a turn's frames ask about it again only after this long (a failed
 *    lookup heals; a turn that cannot be followed costs one request per interval);
 *  - `readHoldMs`: how long an answer read on another console stays read here (a mark
 *    for it that was already on its way is dropped); a new turn in it ends this sooner;
 *  - `followGraceMs`: how long a turn this tab only follows (it did not start it) waits,
 *    still reading as running, before it leaves a mark or a notice: the console that
 *    asked says "seen" when it shows the outcome, a moment after this tab reads the end.
 */
export const FRAME_TIMING = { settleMs: 750, askAgainMs: 10_000, readHoldMs: 30_000, followGraceMs: 2_500 };
/** Turn ids remembered as this tab's (its own, other tabs', followed ones). */
const KNOWN_LIMIT = 200;
/** The SSE channel of the caller's chat turns (`STREAM_CHANNELS` in useEventStream). */
const CHAT_TURN_EVENT = 'chat.turn';
/** The caller read a conversation's answer on one of their consoles (`POST …/read`). */
const CHAT_READ_EVENT = 'chat.read';

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

/** One owner-only `chat.turn` frame, as this observer reads it (exported for tests). */
export interface ChatTurnFrame {
  turnId: string;
  /** The Workspace conversation the turn answers in, when it has one (by grammar). */
  conversationId: string | null;
  phase: 'started' | 'progress' | 'finished' | 'failed' | 'needs_input';
  /** The engine's step label, cleaned like every server label (display text). */
  label: string;
  lookups: number;
}

const FRAME_PHASES: ReadonlySet<string> = new Set(['started', 'progress', 'finished', 'failed', 'needs_input']);

/** Read an untrusted `chat.turn` payload (#9): ids by grammar, the label cleaned, else `null`. */
export function chatTurnFrame(data: unknown): ChatTurnFrame | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const turnId = safeId(raw.turn_id);
  const phase = typeof raw.phase === 'string' && FRAME_PHASES.has(raw.phase) ? (raw.phase as ChatTurnFrame['phase']) : null;
  if (!turnId || !phase) return null;
  return { turnId, conversationId: safeId(raw.conversation_id), phase, label: plain(raw.label, 120), lookups: count(raw.lookups) };
}

/** One owner-only `chat.read` frame: what the analyst saw on another console. */
export interface ChatReadFrame {
  /** A turn whose outcome was on screen there (`POST …/turns/{id}/seen`). */
  turnId: string | null;
  /** The Workspace conversation read there (`POST …/read`), or the seen turn's. */
  conversationId: string | null;
  /** The case whose chat the seen turn ran in. */
  caseId: string | null;
}

/** Read an untrusted `chat.read` payload (#9): ids by grammar, else `null` (nothing named). */
export function chatReadFrame(data: unknown): ChatReadFrame | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const read = { turnId: safeId(raw.turn_id), conversationId: safeId(raw.conversation_id), caseId: safeId(raw.case_id) };
  return read.turnId || read.conversationId || read.caseId ? read : null;
}

/** `POST /chat/turns/{id}/seen`: tell the analyst's other consoles (best effort). */
async function postSeen(turnId: string): Promise<void> {
  try {
    await api.post(`chat/turns/${encodeURIComponent(turnId)}/seen`);
  } catch {
    /* offline: nothing is told (the server answers any well-formed id of the caller's) */
  }
}

/** Keep `key` in a bounded set (oldest first out). */
function keepBounded(set: Set<string>, key: string): void {
  set.delete(key);
  set.add(key);
  if (set.size > KNOWN_LIMIT) set.delete(set.values().next().value as string);
}

/**
 * Was this conversation's answer read on another console a moment ago (`chat.read`)?
 * An expired hold is forgotten here.
 */
function heldAsRead(read: Map<string, number>, conversationId: string | null): boolean {
  if (!conversationId) return false;
  const at = read.get(conversationId);
  if (at === undefined) return false;
  if (Date.now() - at < FRAME_TIMING.readHoldMs) return true;
  read.delete(conversationId);
  return false;
}

/**
 * A Workspace question sent from this browser whose turn is not named yet (no
 * `turn.start` so far, or still waiting for capacity): a reported turn with no entry
 * could be that very one, so none is followed until it is named. A case turn is told
 * apart by its scope (`case:<id>` from the start).
 */
const unnamed = (entry: ChatActivity) =>
  entry.status === 'running' && !entry.turnId && entry.kind === 'workspace' && entry.source !== 'server';

/**
 * Does this entry already read turn `turnId` (this tab's run, or another tab's)? An
 * earlier turn in the same chat that only waits out its grace does not: it has ended.
 */
const readsTurn = (entry: ChatActivity, turnId: string) =>
  entry.status === 'running' && entry.source !== 'server' && (entry.turnId === turnId || !entry.turnId || !isChatActivitySettling(entry.scope));

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
  const canReadRef = React.useRef(canRead);
  canReadRef.current = canRead;
  const authEnabledRef = React.useRef(authEnabled);
  authEnabledRef.current = authEnabled;
  /**
   * Turn ids this tab has held (its own, another tab's, followed ones; oldest dropped
   * first): a frame about one of them is never a turn to follow or an answer to look up
   * (a turn this tab stopped may still send a frame or two).
   */
  const knownRef = React.useRef(new Set<string>());
  /** When a turn's frames last asked `turns/active` about it. */
  const askedRef = React.useRef(new Map<string, number>());
  /**
   * Conversations whose answer the analyst read on another console (`chat.read`), and
   * when: a mark that lands for one meanwhile is no news (see `heldAsRead`).
   */
  const readRef = React.useRef(new Map<string, number>());
  /**
   * Turns whose outcome the analyst saw on another console (`chat.read` naming a turn):
   * no mark or notice for them, whenever it would land (oldest dropped first).
   */
  const seenTurnsRef = React.useRef(new Set<string>());
  /** Turns this tab already told the other consoles it showed (`postSeen`). */
  const postedRef = React.useRef(new Set<string>());
  /**
   * Turns that ended before this tab could follow them, by conversation, until the list
   * read they sent for is in (see `scheduleList`).
   */
  const endedRef = React.useRef(new Map<string, { turnId: string; outcome: 'done' | 'needs_input' }>());
  /** A reported turn was left until this browser's unnamed question is named. */
  const waitingRef = React.useRef(false);
  const timersRef = React.useRef<{ adopt: ReturnType<typeof setTimeout> | null; list: ReturnType<typeof setTimeout> | null }>({
    adopt: null,
    list: null,
  });

  /* ------------------------------------------------------------ lifetime -- */

  // Another user (in this shell, or in a shell that came back): nothing of the previous
  // one may show. Local only: the previous user's other tabs are told by the closing
  // channel (below) or by `forgetIfSignedOut`.
  React.useEffect(() => {
    if (storeUser !== null && storeUser !== username) clearChatActivity(false);
    storeUser = username;
    knownRef.current.clear();
    askedRef.current.clear();
    readRef.current.clear();
    seenTurnsRef.current.clear();
    postedRef.current.clear();
    endedRef.current.clear();
    toastByScopeRef.current.clear();
    waitingRef.current = false;
  }, [username]);
  React.useEffect(
    () =>
      onChatActivity('clear', () => {
        knownRef.current.clear();
        askedRef.current.clear();
        readRef.current.clear();
        seenTurnsRef.current.clear();
        postedRef.current.clear();
        endedRef.current.clear();
        toastByScopeRef.current.clear();
        waitingRef.current = false;
      }),
    [],
  );

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
      // This tab already reads it, or another tab does (an earlier turn there that only
      // waits out its grace has ended: the new one is followed).
      if (!turn.turnId || (existing && readsTurn(existing, turn.turnId))) continue;
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

  /** Titles, unread answers and questions waiting on the analyst, from the list (false: not read). */
  const reconcileList = React.useCallback(async (): Promise<boolean> => {
    // Marks that change while the list loads are newer than it: they are left alone.
    const before = new Set(getChatActivity().entries);
    let rows: ListedRow[] = [];
    try {
      const response = await api.get<{ conversations?: unknown }>('chat/conversations', { limit: LIST_LIMIT });
      rows = Array.isArray(response?.conversations) ? (response.conversations as ListedRow[]) : [];
    } catch {
      return false;
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
      // Read on another console after this list was read: an answer is no news, and a
      // question stays, but as one the analyst has seen.
      const readElsewhere = heldAsRead(readRef.current, id);
      if (readElsewhere && !question) continue;
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
        ...(question ? { seen: row.unread !== true || readElsewhere } : {}),
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
    return true;
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
    const entries = getChatActivity().entries;
    const naming = entries.some(unnamed);
    let waiting = false;
    const unknown = turns.flatMap((turn) => {
      const where = scopeOf(turn);
      const turnId = safeId(turn.turn_id);
      const existing = where ? find(where.scope) : undefined;
      if (!where || !turnId || (existing && readsTurn(existing, turnId))) return [];
      // Read here or in another tab already, or held before (a turn this tab stopped).
      if (knownRef.current.has(turnId) || entries.some((entry) => entry.turnId === turnId)) return [];
      if (naming && where.kind === 'workspace') {
        waiting = true;
        return [];
      }
      return [
        {
          ...where,
          turnId,
          title: existing?.title ?? '',
          label: plain(turn.label, 120) || null,
          lookups: count(turn.lookups),
          startedAt: Date.parse(String(turn.started_at)) || Date.now(),
        },
      ];
    });
    waitingRef.current = waiting;
    if (unknown.length) await follow(unknown);
  }, [follow]);

  /** Look `turns/active` up once after `delay` (a burst of nudges makes one request). */
  const scheduleAdopt = React.useCallback(
    (delay: number) => {
      if (timersRef.current.adopt !== null) return;
      timersRef.current.adopt = setTimeout(() => {
        timersRef.current.adopt = null;
        void pollActive();
      }, delay);
    },
    [pollActive],
  );

  /* ------------------------------------------------------------- toast -- */

  const toastedRef = React.useRef<string[]>([]);
  /** The toast showing for a chat (`conv:` or `case:` scope): a look elsewhere dismisses it. */
  const toastByScopeRef = React.useRef(new Map<string, string>());
  /**
   * One deduplicated toast for a turn that ended while its chat was not on screen: a
   * followed or own turn (`settled`), or one that ended before it could be followed and
   * that the list marked (`scheduleList`).
   */
  const announce = React.useCallback(
    (event: ChatActivitySettled) => {
      const copy = settledCopy(event);
      if (!copy) return;
      const { activity } = event;
      // A peer tab's turn: only a tab someone is looking at speaks up.
      if (activity.source !== 'local' && typeof document !== 'undefined' && document.hidden) return;
      // The analyst already saw it on another console.
      if (activity.turnId && seenTurnsRef.current.has(activity.turnId)) return;
      if (activity.kind === 'workspace' && heldAsRead(readRef.current, activity.conversationId)) return;
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
      const where = activity.kind === 'case' ? activity.caseId && `case:${activity.caseId}` : activity.conversationId && `conv:${activity.conversationId}`;
      if (where && !event.unreachable) {
        const shown = toastByScopeRef.current;
        shown.delete(where);
        shown.set(where, options.id);
        if (shown.size > KNOWN_LIMIT) shown.delete(shown.keys().next().value as string);
      }
      if (event.outcome === 'done' && !event.unreachable) toast.success(copy.heading, options);
      else if (event.outcome === 'needs_input' && !event.unreachable) toast.warning(copy.heading, options);
      else toast.error(copy.heading, options);
    },
    [],
  );

  /* ------------------------------------------------- turns that ended -- */

  /** Read the list for marks (an answer or question that ended elsewhere), once. */
  const scheduleList = React.useCallback(() => {
    if (timersRef.current.list !== null) return;
    timersRef.current.list = setTimeout(() => {
      timersRef.current.list = null;
      const ended = new Map(endedRef.current);
      endedRef.current.clear();
      void reconcileList().then((listed) => {
        // An answer on screen is read, not news (unless the tab is hidden).
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') markViewedChatActivitySeen();
        if (!listed) return;
        // An answer or question the list still marks is announced like a followed one's
        // (a read elsewhere, or one on screen here, left no mark to announce).
        for (const [conversationId, { turnId, outcome }] of ended) {
          const mark = find(`conv:${conversationId}`);
          const status = outcome === 'done' ? 'unread' : 'needs_input';
          if (!mark || mark.source === 'local' || mark.seen || mark.status !== status) continue;
          announce({ activity: { ...mark, turnId }, outcome, viewed: false });
        }
      });
    }, FRAME_TIMING.settleMs);
  }, [announce, reconcileList]);

  React.useEffect(
    () => () => {
      const timers = timersRef.current;
      if (timers.adopt !== null) clearTimeout(timers.adopt);
      if (timers.list !== null) clearTimeout(timers.list);
      timers.adopt = null;
      timers.list = null;
    },
    [],
  );

  // Remember every turn id the store holds, drop a mark for an answer just read on
  // another console, and once this browser's unnamed question is named, look up the
  // turns that were left for it.
  React.useEffect(() => {
    const remember = () => {
      const { entries } = getChatActivity();
      const known = knownRef.current;
      const read = readRef.current;
      const seenTurns = seenTurnsRef.current;
      for (const entry of entries) {
        // A mark that landed after the analyst saw it elsewhere (a followed run that
        // ended, another tab's mark, a list read before the read) is no news. For a
        // conversation, a new turn there ends the hold through its frames (below), so its
        // own answer is news again; a turn is held for good.
        if (
          entry.status !== 'running' &&
          !entry.seen &&
          ((entry.turnId && seenTurns.has(entry.turnId)) ||
            (read.size && entry.kind === 'workspace' && heldAsRead(read, entry.conversationId)))
        ) {
          markChatActivitySeen(entry.scope, true, { elsewhere: true });
        }
        if (!entry.turnId || known.has(entry.turnId)) continue;
        known.add(entry.turnId);
        if (known.size > KNOWN_LIMIT) known.delete(known.values().next().value as string);
      }
      if (waitingRef.current && !entries.some(unnamed)) {
        waitingRef.current = false;
        scheduleAdopt(0);
      }
    };
    remember();
    return subscribeChatActivity(remember);
  }, [scheduleAdopt]);

  /* -------------------------------------------------------- live frames -- */

  React.useEffect(() => {
    if (!canRead) return undefined;
    const onFrame = ({ type, data }: ChatFrame) => {
      if (type === 'overflow') {
        // This tab missed frames: ask what runs now, and what the parked runs did. A new
        // turn's frame may be among them, so no answer is held as read any more.
        readRef.current.clear();
        scheduleAdopt(0);
        void loadRunner().then((runnerModule) => runnerModule?.pollParkedRuns());
        return;
      }
      if (type === CHAT_READ_EVENT) {
        // Seen on another console (or this one): no news here, now or later.
        const seen = chatReadFrame(data);
        if (!seen) return;
        const { turnId, conversationId } = seen;
        if (turnId) {
          // One turn's outcome (`…/seen`): exactly that turn's mark and toast go. Never
          // another turn's in the same chat, older or newer, settled or running: that
          // console showed this one (a case chat posts one for every answer it lists).
          keepBounded(seenTurnsRef.current, turnId);
          for (const entry of getChatActivity().entries) {
            // Settled, or waiting out its grace (it then settles as seen).
            if (entry.turnId === turnId) markChatActivitySeen(entry.scope, true, { elsewhere: true });
          }
          if (toastedRef.current.includes(turnId)) toast.dismiss(`chat-${turnId}`);
          return;
        }
        const toasts = new Set<string>();
        if (conversationId) {
          // A Workspace conversation read there (`…/read`): its mark goes, and one on its
          // way is held until a new turn's frame arrives there.
          const read = readRef.current;
          read.delete(conversationId);
          read.set(conversationId, Date.now());
          if (read.size > KNOWN_LIMIT) read.delete(read.keys().next().value as string);
          markChatActivitySeen(`conv:${conversationId}`, true, { elsewhere: true });
          const scope = `conv:${conversationId}`;
          const toastId = toastByScopeRef.current.get(scope);
          if (toastId) {
            toastByScopeRef.current.delete(scope);
            toasts.add(toastId);
          }
        }
        // Its "Answer ready" toast, if one still shows here, is old news too.
        for (const toastId of toasts) toast.dismiss(toastId);
        return;
      }
      if (type !== CHAT_TURN_EVENT) return;
      const frame = chatTurnFrame(data);
      if (!frame) return;
      // A turn's frames come before the read of its answer, so a frame after a read is a
      // new turn in that conversation: its answer is news again.
      if (frame.conversationId) readRef.current.delete(frame.conversationId);
      const entry = getChatActivity().entries.find((item) => item.turnId === frame.turnId);
      // Only this tab's parked runs take a frame's news: a run with a read open hears
      // its own events, and another tab's run is that tab's.
      const parked = entry?.parked === true && entry.source === 'local' && entry.status === 'running';
      if (frame.phase === 'started' || frame.phase === 'progress') {
        if (entry) {
          if (parked && frame.phase === 'progress') {
            patchChatActivity(entry.scope, { label: frame.label || entry.label, lookups: frame.lookups });
          }
          return;
        }
        // Another device's or browser's turn: follow it (once `turns/active` lists it).
        if (knownRef.current.has(frame.turnId) || waitingRef.current) return;
        const now = Date.now();
        const asked = askedRef.current;
        if (now - (asked.get(frame.turnId) ?? -Infinity) < FRAME_TIMING.askAgainMs) return;
        asked.set(frame.turnId, now);
        if (asked.size > KNOWN_LIMIT) asked.delete(asked.keys().next().value as string);
        scheduleAdopt(FRAME_TIMING.settleMs);
        return;
      }
      // It ended: a parked run reads how (its answer, question or failure) right away.
      if (parked) void loadRunner().then((runnerModule) => runnerModule?.wakeParkedRun(frame.turnId));
      // Never followed here (it ended before it could be): the list holds its mark, which
      // is announced like a followed turn's (a failure is marked, not announced).
      else if (!entry && !knownRef.current.has(frame.turnId)) {
        if (frame.conversationId && frame.phase !== 'failed') {
          const ended = endedRef.current;
          ended.delete(frame.conversationId);
          ended.set(frame.conversationId, { turnId: frame.turnId, outcome: frame.phase === 'needs_input' ? 'needs_input' : 'done' });
          if (ended.size > KNOWN_LIMIT) ended.delete(ended.keys().next().value as string);
        }
        scheduleList();
      }
    };
    setChatFrameSink(onFrame);
    return () => setChatFrameSink(null);
  }, [canRead, scheduleAdopt, scheduleList]);

  // On load (and for another user): turns still running after a reload, then the list
  // (titles for them, unread answers, waiting questions, marks for gone threads).
  React.useEffect(() => {
    if (!canRead) return;
    void pollActive().then(reconcileList);
  }, [canRead, pollActive, reconcileList, username]);

  React.useEffect(() => onChatActivity('settled', announce), [announce]);

  // What the settle rules ask this observer: was a turn seen on another console, and how
  // long a turn this tab only follows waits for that (with auth off no frame is sent, so
  // there is nothing to wait for).
  React.useEffect(() => {
    setChatSettlePolicy({
      seenElsewhere: (entry) =>
        (!!entry.turnId && seenTurnsRef.current.has(entry.turnId)) ||
        (entry.kind === 'workspace' && heldAsRead(readRef.current, entry.conversationId)),
      followedGraceMs: () => (authEnabledRef.current && canReadRef.current ? FRAME_TIMING.followGraceMs : 0),
    });
    return () => setChatSettlePolicy(null);
  }, []);

  // A turn's outcome went on screen here: the analyst's other consoles drop their mark
  // for it (owner-only `chat.read`). Signed in only (no frame reaches anyone otherwise),
  // once per turn per tab.
  React.useEffect(
    () =>
      onChatActivity('shown', (shownTurnId) => {
        if (!authEnabledRef.current || !canReadRef.current) return;
        const turnId = safeId(shownTurnId);
        if (!turnId || postedRef.current.has(turnId)) return;
        keepBounded(postedRef.current, turnId);
        void postSeen(turnId);
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
      if (document.visibilityState !== 'visible') return;
      markViewedChatActivitySeen();
      // A turn started on another device or browser while this tab was hidden (with
      // authentication off, or a frame missed, nothing else says so).
      if (canReadRef.current) scheduleAdopt(0);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [scheduleAdopt]);

  return null;
}
