/**
 * ActivityEffects — the shell's observer for chat turns (Round 12, SPEC D13), mounted
 * by AppShell beside `JobMonitor` through a lazy import, so none of it rides the
 * first-paint bundle (the eager side is only the store and the glyph).
 *
 *  - Lifetime: sign-out (the shell unmounts) and a change of user forget every turn and
 *    stop reading them (the server still finishes and saves them).
 *  - Other tabs: one BroadcastChannel carries this tab's own changes and applies the
 *    others' (scoped to the signed-in user), so two tabs agree; a closing tab hands its
 *    running turns over to the server poll.
 *  - The server: `GET /api/chat/turns/active` on load (a reload mid-turn keeps the
 *    indicator), the conversation list for titles and unread answers, then — only
 *    while a turn this tab is not streaming itself runs — owner-only `chat.turn` frames
 *    (auth on, realtime on) or a 5 s poll (auth off, realtime off, frames missed).
 *  - Settled turns the analyst was not looking at: one polite "Answer ready: <title>"
 *    announcement and one deduplicated toast with Open.
 *  - The tab title: "●" while an answer is being written, "✓" for an unread one.
 *
 * Every title is prompt- or model-derived display text: it goes into toasts, the live
 * region and the title as plain text only (#9). Server labels are engine templates.
 */
import * as React from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { useEventStream, type StreamEvent } from '@/lib/useEventStream';
import { useOptionalAuth } from '@/soc/auth';
import { useAnnouncer } from '@/soc/components/announcer';
import type { Navigate } from '@/soc/router';
import { setDocumentTitlePrefix } from './title-prefix';
import {
  applyChatActivityMessage,
  clearChatActivity,
  dropChatActivity,
  getChatActivity,
  markViewedChatActivitySeen,
  onChatActivity,
  patchChatActivity,
  putChatActivity,
  setChatActivitySink,
  settleChatActivity,
  useChatActivity,
  type ChatActivity,
  type ChatActivityMessage,
  type ChatActivitySettled,
} from './activity';

export const ACTIVITY_CHANNEL = 'agentic-soc-chat-activity';
/** Poll cadence while a server-tracked turn runs (realtime off, auth off). */
export const ACTIVE_POLL_MS = 5_000;
/** Safety-net poll while realtime frames flow. */
export const ACTIVE_POLL_LIVE_MS = 30_000;
const LIST_LIMIT = 20;
const TOAST_SEEN_LIMIT = 100;

/** Mounted shells (a development double mount must not clear a live store). */
let mounted = 0;

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

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const safeId = (value: unknown): string | null => (typeof value === 'string' && SAFE_ID.test(value) ? value : null);
// Invisible, bidi and control characters never reach a toast or the live region.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
function plain(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('').trimEnd()}…` : text;
}
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

function scopeOf(turn: ActiveTurn): { scope: string; kind: ChatActivity['kind']; conversationId: string | null; caseId: string | null } | null {
  const turnId = safeId(turn.turn_id);
  if (!turnId) return null;
  const conversationId = safeId(turn.conversation_id);
  const caseId = safeId(turn.case_id);
  if (caseId) return { scope: `case:${caseId}`, kind: 'case', conversationId: null, caseId };
  if (conversationId) return { scope: `conv:${conversationId}`, kind: 'workspace', conversationId, caseId: null };
  return { scope: `turn:${turnId}`, kind: 'workspace', conversationId: null, caseId: null };
}

/** The tab-title prefix for a snapshot (exported for tests). */
export function titlePrefix(entries: readonly ChatActivity[]): string {
  if (entries.some((entry) => entry.status === 'running')) return '●';
  if (entries.some((entry) => (entry.status === 'unread' || entry.status === 'needs_input') && !entry.seen)) return '✓';
  return '';
}

/** Toast + announcement copy for a turn that finished off screen (exported for tests). */
export function settledCopy(event: ChatActivitySettled): { heading: string; spoken: string; title: string } | null {
  if (event.viewed || event.outcome === 'stopped') return null;
  const { activity } = event;
  const title = activity.title || (activity.kind === 'case' && activity.caseId ? `Case ${activity.caseId}` : 'Chat');
  if (event.outcome === 'done') return { heading: 'Answer ready', spoken: `Answer ready: ${title}`, title };
  if (event.outcome === 'needs_input') return { heading: 'A question needs your input', spoken: `Needs your input: ${title}`, title };
  return { heading: 'The answer could not be completed', spoken: `Error: ${title}`, title };
}

export interface ActivityEffectsProps {
  /** The signed-in user ('' when auth is off): other tabs and a change of user key on it. */
  username?: string | null;
  onNavigate: Navigate;
}

export default function ActivityEffects({ username: user, onNavigate }: ActivityEffectsProps) {
  const username = user ?? '';
  const auth = useOptionalAuth();
  const authEnabled = auth?.authEnabled ?? false;
  const canRead = auth ? auth.hasPermission('cases', 'read') : true;
  const announce = useAnnouncer();
  const { entries } = useChatActivity();
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

  /* ---------------------------------------------------------- other tabs -- */

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return undefined;
    let channel: BroadcastChannel;
    try {
      channel = new window.BroadcastChannel(ACTIVITY_CHANNEL);
    } catch {
      return undefined;
    }
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
        // The other tab closed: its running turns are the server's to report now.
        for (const scope of data.release) {
          const entry = getChatActivity().entries.find((item) => item.scope === scope && item.source === 'peer');
          if (!entry) continue;
          dropChatActivity(scope, false);
          putChatActivity({ ...entry, source: 'server' }, false);
        }
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
      channel.close();
    };
  }, [username]);

  /* -------------------------------------------------------------- server -- */

  /** Titles, unread answers and questions waiting on the analyst, from the list. */
  const reconcileList = React.useCallback(async (finished: readonly ChatActivity[] = []) => {
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
    const current = getChatActivity().entries;
    for (const [id, row] of byId) {
      const scope = `conv:${id}`;
      const entry = current.find((item) => item.scope === scope);
      const title = plain(row.title, 80);
      if (entry?.source === 'server' && entry.status === 'running' && !entry.title && title) {
        patchChatActivity(scope, { title });
      } else if (!entry && (row.unread === true || row.status === 'needs_input')) {
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
          status: row.status === 'needs_input' ? 'needs_input' : 'unread',
          startedAt: Date.parse(String(row.updated_at)) || Date.now(),
          source: 'server',
        });
      }
    }
    // Server-tracked turns that finished: settle them as the list now says.
    for (const entry of finished) {
      const row = entry.conversationId ? byId.get(entry.conversationId) : undefined;
      if (!row || entry.kind === 'case') {
        settleChatActivity(entry.scope, 'done', false);
      } else if (row.status === 'needs_input') settleChatActivity(entry.scope, 'needs_input', false);
      else if (row.status === 'failed') settleChatActivity(entry.scope, 'error', false);
      else if (row.unread === true) settleChatActivity(entry.scope, 'done', false);
      else dropChatActivity(entry.scope, false);
    }
  }, []);

  /**
   * `GET /chat/turns/active`: what runs server-side that this tab is not streaming.
   * Resolves true when it also read the conversation list.
   */
  const pollActive = React.useCallback(async (): Promise<boolean> => {
    let turns: ActiveTurn[];
    try {
      const response = await api.get<unknown>('chat/turns/active');
      turns = Array.isArray(response) ? (response as ActiveTurn[]) : [];
    } catch {
      return false;
    }
    const running = new Set<string>();
    for (const turn of turns) {
      const where = scopeOf(turn);
      if (!where) continue;
      running.add(where.scope);
      const existing = getChatActivity().entries.find((entry) => entry.scope === where.scope);
      if (existing && existing.source !== 'server') continue;
      putChatActivity({
        ...where,
        turnId: safeId(turn.turn_id),
        requestKey: null,
        title: existing?.title ?? '',
        label: plain(turn.label, 120) || null,
        lookups: count(turn.lookups),
        status: turn.status === 'needs_input' ? 'needs_input' : 'running',
        startedAt: Date.parse(String(turn.started_at)) || Date.now(),
        source: 'server',
      });
    }
    const finished = getChatActivity().entries.filter(
      (entry) => entry.source === 'server' && entry.status === 'running' && !running.has(entry.scope),
    );
    const untitled = getChatActivity().entries.some((entry) => entry.source === 'server' && entry.status === 'running' && !entry.title);
    if (!finished.length && !untitled) return false;
    await reconcileList(finished);
    return true;
  }, [reconcileList]);

  // On load: a turn still running after a reload, and unread answers.
  React.useEffect(() => {
    if (!canRead) return;
    void pollActive().then((listed) => (listed ? undefined : reconcileList()));
  }, [canRead, pollActive, reconcileList, username]);

  const serverRunning = entries.some((entry) => entry.source === 'server' && entry.status === 'running');
  const onFrame = React.useCallback(
    (event: StreamEvent) => {
      if (event.type !== 'chat.turn' || !event.data || typeof event.data !== 'object') return;
      const frame = event.data as ActiveTurn & { phase?: unknown };
      const where = scopeOf(frame);
      if (!where) return;
      const existing = getChatActivity().entries.find((entry) => entry.scope === where.scope);
      if (frame.phase === 'progress' && existing?.source === 'server') {
        patchChatActivity(where.scope, { label: plain(frame.label, 120) || null, lookups: count(frame.lookups) });
      } else {
        // Started elsewhere, or finished: the poll reconciles (and fetches the title).
        void pollActive();
      }
    },
    [pollActive],
  );
  const { live } = useEventStream(['chat'], { enabled: canRead && authEnabled && serverRunning, onEvent: onFrame });

  React.useEffect(() => {
    if (!canRead || !serverRunning) return undefined;
    const timer = window.setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void pollActive();
    }, live ? ACTIVE_POLL_LIVE_MS : ACTIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [canRead, live, pollActive, serverRunning]);

  /* ------------------------------------------------- announce and toast -- */

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
        announce(copy.spoken, 'polite');
        const open = () => {
          if (activity.kind === 'case' && activity.caseId) navigateRef.current('case_manager', { caseId: activity.caseId, tab: 'chat' });
          else if (activity.conversationId) navigateRef.current('chat', { conversationId: activity.conversationId });
          else navigateRef.current('chat');
        };
        const options = { id: `chat-${key}`, description: copy.title, duration: 9_000, action: { label: 'Open', onClick: open } };
        if (event.outcome === 'done') toast.success(copy.heading, options);
        else if (event.outcome === 'needs_input') toast.warning(copy.heading, options);
        else toast.error(copy.heading, options);
      }),
    [announce],
  );

  /* ----------------------------------------------------- title, visibility -- */

  const prefix = titlePrefix(entries);
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
