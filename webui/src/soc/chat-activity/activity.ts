/**
 * Chat activity writers (Round 12, SPEC D13): the rules behind the store's snapshot.
 * Imported only by lazy chunks (the turn runner, the chat views, `ActivityEffects`), so
 * none of this rides the first-paint bundle; `store.ts` keeps the eager core. Every
 * write goes through `commit`, which also precomputes the navigation summaries the eager
 * glyph hosts read (`workspace`, `case`, `all`).
 *
 * Writers:
 *  - the turn runner (`soc/chat/turn-runner.ts`) for this tab's own turns;
 *  - `ActivityEffects` for other tabs (BroadcastChannel) and for turns the server
 *    reports (`GET /api/chat/turns/active`, the conversation list's
 *    `unread` / `needs_input`);
 *  - the chat views, which register what is on screen (`viewChatActivity`).
 *
 * A turn that finishes on screen simply ends; elsewhere it becomes `unread` (an answer)
 * or `failed`, and a clarifying question stays as `needs_input` until it is answered.
 */
import type { ChatOrigin } from '@/lib/types';
import {
  BRAND_KEY,
  getChatActivity,
  writeChatActivity,
  type ChatActivity,
  type ChatActivityStatus,
  type ChatActivitySummary,
} from './store';

export * from './store';

export type ChatActivityOutcome = 'done' | 'needs_input' | 'error' | 'stopped';

/** Messages for other tabs (`ActivityEffects` sends them on a BroadcastChannel). */
export type ChatActivityMessage =
  | { t: 'put'; a: ChatActivity }
  | { t: 'drop' | 'seen'; s: string }
  | { t: 'clear' };

export interface ChatActivitySettled {
  activity: ChatActivity;
  outcome: ChatActivityOutcome;
  /** The analyst had this chat on screen (no toast, no unread mark). */
  viewed: boolean;
  /**
   * Nothing can show this chat again (a new thread whose first answer was never saved):
   * it leaves no mark, and the toast offers to ask the question again instead of Open.
   */
  unreachable?: boolean;
  /** The exact question, for "Ask again" (this tab's own turns only; never stored). */
  prompt?: string | null;
  /**
   * Who authored that question (#9): only `user` is the analyst's own words, which
   * "Ask again" may put back in a composer. Any other origin (an Ask AI or "Ask about
   * this" question, a starter, a follow-up) is asked again with the SAME origin and
   * topic, never prefilled; with no origin nothing is prefilled either. This tab only;
   * never stored or sent to another tab.
   */
  origin?: ChatOrigin;
  /** The "Ask about this" topic the question was asked with, if any. */
  topic?: string | null;
}

export interface ChatActivitySettleOptions {
  unreachable?: boolean;
  prompt?: string | null;
  /** See {@link ChatActivitySettled.origin}. */
  origin?: ChatOrigin;
  topic?: string | null;
  /**
   * A view is attached to the turn (the runner knows): it counts as on screen while the
   * tab is visible, even before that view has registered the turn's scope.
   */
  attached?: boolean;
  /**
   * This tab followed the turn without starting it (a reload, another console, a closing
   * tab): the console that asked may be showing it, so off screen it waits out the
   * policy's grace before it leaves a mark or a notice (see {@link ChatSettlePolicy}).
   */
  followed?: boolean;
}

/**
 * What the shell's observer (`ActivityEffects`) knows that the settle rules ask. With no
 * policy set, a turn settles at once and only this tab's screen counts.
 */
export interface ChatSettlePolicy {
  /** The analyst already saw this turn's outcome on another console (`chat.read`). */
  seenElsewhere(entry: ChatActivity): boolean;
  /**
   * How long a turn followed off screen waits before it leaves a mark or a notice (0:
   * none): another console's "seen" can land a moment after this tab reads the end.
   */
  followedGraceMs(): number;
}

type Listener = () => void;

const settledListeners = new Set<(event: ChatActivitySettled) => void>();
const shownListeners = new Set<(entry: ChatActivity) => void>();
const clearListeners = new Set<Listener>();
let policy: ChatSettlePolicy | null = null;
/**
 * Followed turns waiting out their grace, by scope (their entry still reads `running`).
 * `seen` records a look meanwhile: on this tab's screen, or on another console.
 */
interface PendingSettle {
  turnId: string | null;
  seen: 'here' | 'elsewhere' | null;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<string, PendingSettle>();

function cancelPending(scope?: string): void {
  for (const [key, held] of Array.from(pending)) {
    if (scope !== undefined && key !== scope) continue;
    clearTimeout(held.timer);
    pending.delete(key);
  }
}
/**
 * Mounted views, one token each. A token follows its turn when a new thread's
 * `draft:` scope becomes `conv:<id>` (`rekeyChatActivity`), synchronously: the view
 * re-registers the new scope only in a later effect, and an answer can land first.
 */
const viewing = new Set<{ scope: string }>();
const isViewing = (scope: string) => {
  for (const token of viewing) if (token.scope === scope) return true;
  return false;
};
/** A case-chat toast's Open, waiting for its case page (see `requestCaseChat`). */
let caseChatRequest: { caseId: string; at: number } | null = null;
let sink: ((message: ChatActivityMessage) => void) | null = null;

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const find = (scope: string) => getChatActivity().entries.find((entry) => entry.scope === scope);

/** Most important first: [state, one, several]. */
const PHRASES: Array<[ChatActivityStatus, string, string]> = [
  ['running', 'answer in progress', 'answers in progress'],
  ['needs_input', 'question needs your input', 'questions need your input'],
  ['failed', 'answer failed', 'answers failed'],
  ['unread', 'new answer', 'new answers'],
];
/** A question the analyst has already looked at: it stays until it is answered. */
const SEEN_QUESTION: [string, string] = ['question waiting for your answer', 'questions waiting for your answer'];

/** Display titles stay short: a case id plus a prompt is clipped here. */
const TITLE_CHARS = 120;

/**
 * An entry's display title. A case chat names its case ("Case <id>: Summarize case"),
 * so two cases summarising at once can be told apart. Plain text only (#9).
 */
export function chatActivityTitle(entry: Pick<ChatActivity, 'kind' | 'caseId' | 'title'>): string {
  const text = entry.kind === 'case' && entry.caseId ? `Case ${entry.caseId}${entry.title ? `: ${entry.title}` : ''}` : entry.title;
  const chars = Array.from(text);
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join('').trimEnd()}…` : text;
}

/**
 * The glyph state and its text for a set of entries ("Chat: 1 answer in progress:
 * <title>"). Whenever there is a glyph there is text: a question the analyst has
 * already looked at reads "1 question waiting for your answer".
 */
export function describeChatActivity(entries: readonly ChatActivity[], label = 'Chat'): ChatActivitySummary {
  const parts: string[] = [];
  let status: ChatActivityStatus | null = null;
  const phrase = (group: readonly ChatActivity[], one: string, several: string) => {
    if (group.length === 1) {
      const title = chatActivityTitle(group[0]);
      parts.push(`1 ${one}${title ? `: ${title}` : ''}`);
    } else if (group.length) parts.push(`${group.length} ${several}`);
  };
  for (const [kind, one, several] of PHRASES) {
    const group = entries.filter((entry) => entry.status === kind);
    if (!group.length) continue;
    status ??= kind;
    phrase(
      group.filter((entry) => !entry.seen),
      one,
      several,
    );
    if (kind === 'needs_input') phrase(group.filter((entry) => entry.seen), ...SEEN_QUESTION);
  }
  return { status, text: parts.length ? `${label}: ${parts.join('; ')}` : '' };
}

/** The previous summary while nothing it shows changed (hosts select it by identity). */
const keep = (previous: ChatActivitySummary, next: ChatActivitySummary) =>
  previous.status === next.status && previous.text === next.text ? previous : next;

/** The one write path: the entries, the brand switch, and the summaries derived from them. */
function commit(entries: readonly ChatActivity[], animatedBrand = getChatActivity().animatedBrand): void {
  const before = getChatActivity();
  writeChatActivity({
    entries,
    animatedBrand,
    workspace: keep(before.workspace, describeChatActivity(entries.filter((entry) => entry.kind === 'workspace'))),
    case: keep(
      before.case,
      describeChatActivity(
        entries.filter((entry) => entry.kind === 'case'),
        'Case chat',
      ),
    ),
    all: keep(before.all, describeChatActivity(entries)),
  });
}

function replace(entry: ChatActivity | null, scope: string): void {
  const rest = getChatActivity().entries.filter((item) => item.scope !== scope);
  commit(entry ? [entry, ...rest] : rest);
}

function send(message: ChatActivityMessage, local: boolean): void {
  if (local) sink?.(message);
}

/** Where this tab's own changes go (the BroadcastChannel); `null` detaches. */
export function setChatActivitySink(next: ((message: ChatActivityMessage) => void) | null): void {
  sink = next;
}

/** `ActivityEffects` sets what it knows about other consoles; `null` lets go. */
export function setChatSettlePolicy(next: ChatSettlePolicy | null): void {
  policy = next;
}

/** Is this scope's followed turn waiting out its grace (its entry still reads `running`)? */
export function isChatActivitySettling(scope: string): boolean {
  return pending.has(scope);
}

/** Sign-out or another user: forget everything and stop this tab's turns (the runner listens). */
export function clearChatActivity(local = true): void {
  cancelPending();
  if (getChatActivity().entries.length) commit([]);
  caseChatRequest = null;
  for (const listener of Array.from(clearListeners)) listener();
  send({ t: 'clear' }, local);
}

/**
 * `settled` fires once per finished turn; `shown` when this tab put a turn's outcome on
 * screen (it settled in view, or its mark was looked at), for the other consoles to
 * hear; `clear` on sign-out (the runner aborts).
 */
export function onChatActivity(event: 'settled', listener: (event: ChatActivitySettled) => void): () => void;
export function onChatActivity(event: 'shown', listener: (entry: ChatActivity) => void): () => void;
export function onChatActivity(event: 'clear', listener: Listener): () => void;
export function onChatActivity(
  event: 'settled' | 'shown' | 'clear',
  listener: Listener | ((event: ChatActivitySettled) => void) | ((entry: ChatActivity) => void),
): () => void {
  if (event === 'clear') {
    const plain = listener as Listener;
    clearListeners.add(plain);
    return () => clearListeners.delete(plain);
  }
  if (event === 'shown') {
    const shown = listener as (entry: ChatActivity) => void;
    shownListeners.add(shown);
    return () => shownListeners.delete(shown);
  }
  const typed = listener as (event: ChatActivitySettled) => void;
  settledListeners.add(typed);
  return () => settledListeners.delete(typed);
}

function emitShown(entry: ChatActivity): void {
  if (!entry.turnId) return;
  for (const listener of Array.from(shownListeners)) listener(entry);
}

export function setAnimatedBrand(value: boolean): void {
  const current = getChatActivity();
  if (current.animatedBrand === value) return;
  commit(current.entries, value);
  try {
    window.localStorage.setItem(BRAND_KEY, value ? '1' : '0');
  } catch {
    /* storage blocked: the switch still applies for this page */
  }
}

/**
 * Add or replace an entry. A server report never overrides what a tab is streaming
 * itself (`local`) or hears from another tab (`peer`).
 */
export function putChatActivity(entry: ChatActivity, local = entry.source === 'local'): void {
  const current = find(entry.scope);
  if (entry.source === 'server' && current && current.source !== 'server') return;
  replace(entry, entry.scope);
  send({ t: 'put', a: entry }, local);
}

export function patchChatActivity(scope: string, patch: Partial<ChatActivity>): void {
  const current = find(scope);
  if (current) putChatActivity({ ...current, ...patch, scope });
}

/** A new thread's turn learnt its conversation id (`draft:` → `conv:`). */
export function rekeyChatActivity(from: string, to: string, patch: Partial<ChatActivity> = {}): void {
  if (from === to) return;
  // The view on screen moves with its turn at once (see `viewing`).
  let moved = false;
  for (const token of viewing) {
    if (token.scope !== from) continue;
    token.scope = to;
    moved = true;
  }
  if (moved) viewedChanged();
  const current = find(from);
  if (!current) return;
  dropChatActivity(from);
  putChatActivity({ ...current, ...patch, scope: to });
}

export function dropChatActivity(scope: string, local = true): void {
  cancelPending(scope);
  if (!find(scope)) return;
  replace(null, scope);
  send({ t: 'drop', s: scope }, local);
}

export function isChatActivityViewed(scope: string): boolean {
  return isViewing(scope) && visible();
}

/**
 * A turn finished: on screen it simply ends; elsewhere it leaves its mark, unless
 * nothing could ever show it (`unreachable`: a new thread that saved nothing) or the
 * analyst already saw it on another console (the policy's `seenElsewhere`). A turn this
 * tab only followed waits out the policy's grace first, still reading as running, so a
 * "seen" from the console that asked can land: no mark, no notice, nothing to take back.
 */
export function settleChatActivity(
  scope: string,
  outcome: ChatActivityOutcome,
  local = true,
  options: ChatActivitySettleOptions = {},
): void {
  const current = find(scope);
  if (!current) return;
  cancelPending(scope);
  const here = isChatActivityViewed(scope) || (options.attached === true && visible());
  const grace = local && options.followed === true && !here && outcome !== 'stopped' ? (policy?.followedGraceMs() ?? 0) : 0;
  if (grace > 0 && policy?.seenElsewhere(current) !== true) {
    const held: PendingSettle = {
      turnId: current.turnId,
      seen: null,
      timer: setTimeout(() => {
        if (pending.get(scope) !== held) return;
        pending.delete(scope);
        const now = find(scope);
        // Replaced meanwhile (a new turn there, a sign-out, a thread that is gone).
        if (!now || now.status !== 'running' || now.turnId !== held.turnId) return;
        finishSettle(now, outcome, local, options, held.seen);
      }, grace),
    };
    pending.set(scope, held);
    return;
  }
  finishSettle(current, outcome, local, options, here ? 'here' : null);
}

function finishSettle(
  current: ChatActivity,
  outcome: ChatActivityOutcome,
  local: boolean,
  options: ChatActivitySettleOptions,
  seen: PendingSettle['seen'],
): void {
  const { scope } = current;
  const here = seen === 'here' || isChatActivityViewed(scope) || (options.attached === true && visible());
  const viewed = here || seen === 'elsewhere' || policy?.seenElsewhere(current) === true;
  const status: ChatActivityStatus | null = options.unreachable
    ? null
    : outcome === 'needs_input'
      ? 'needs_input'
      : viewed || outcome === 'stopped'
        ? null
        : outcome === 'done'
          ? 'unread'
          : 'failed';
  if (status) putChatActivity({ ...current, status, seen: viewed, label: null, parked: false }, local);
  else dropChatActivity(scope, local);
  // On this tab's screen: the analyst's other consoles may hold a mark for it.
  if (here && outcome !== 'stopped') emitShown(current);
  const event: ChatActivitySettled = { activity: current, outcome, viewed };
  if (options.unreachable) {
    event.unreachable = true;
    event.prompt = options.prompt ?? null;
    // No origin is no licence to prefill: only an explicit `user` is the analyst's words.
    if (options.origin) event.origin = options.origin;
    event.topic = options.topic ?? null;
  }
  for (const listener of Array.from(settledListeners)) listener(event);
}

/**
 * The analyst looked at this chat: an answer or failure is read; a question stays.
 * `elsewhere`: they looked on another console (its `chat.read`), which already told the
 * others; otherwise a look on this tab's screen is passed on (`shown`). A followed turn
 * still waiting out its grace settles as seen.
 */
export function markChatActivitySeen(scope: string, local = true, options: { elsewhere?: boolean } = {}): void {
  const current = find(scope);
  if (!current || current.seen) return;
  if (current.status === 'running') {
    const held = pending.get(scope);
    if (held && held.seen !== 'here') held.seen = local && !options.elsewhere ? 'here' : 'elsewhere';
    return;
  }
  if (current.status === 'needs_input') replace({ ...current, seen: true }, scope);
  else replace(null, scope);
  send({ t: 'seen', s: scope }, local);
  if (local && !options.elsewhere) emitShown(current);
}

/** Mark every on-screen chat seen (the tab became visible again). */
export function markViewedChatActivitySeen(): void {
  for (const scope of new Set(Array.from(viewing, (token) => token.scope))) markChatActivitySeen(scope);
}

/** Register a chat that is on screen; returns the release. */
export function viewChatActivity(scope: string): () => void {
  const token = { scope };
  viewing.add(token);
  viewedChanged();
  if (visible()) markChatActivitySeen(scope);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    viewing.delete(token);
    viewedChanged();
  };
}

/* The scopes on screen, for hosts that render them differently (the history rail does
   not list, as another row, the new thread whose first answer is on screen). */
let viewedScopes: ReadonlySet<string> = new Set();
const viewedListeners = new Set<Listener>();

function viewedChanged(): void {
  viewedScopes = new Set(Array.from(viewing, (token) => token.scope));
  for (const listener of Array.from(viewedListeners)) listener();
}

/** The scopes mounted views show (identity changes only when the set does). */
export function getViewedChatScopes(): ReadonlySet<string> {
  return viewedScopes;
}

export function subscribeViewedChatScopes(listener: Listener): () => void {
  viewedListeners.add(listener);
  return () => viewedListeners.delete(listener);
}

/* "Open" on a case-chat toast: the case opens on its Chat tab. The request waits for
   that case's page to take it (it may still be loading), for a short while only. */
const CASE_CHAT_REQUEST_MS = 30_000;
const caseChatListeners = new Set<Listener>();

export function requestCaseChat(caseId: string): void {
  caseChatRequest = { caseId, at: Date.now() };
  for (const listener of Array.from(caseChatListeners)) listener();
}

/** True once, for the case that was asked for (and drops the request). */
export function takeCaseChatRequest(caseId: string): boolean {
  const request = caseChatRequest;
  if (!request || request.caseId !== caseId) return false;
  caseChatRequest = null;
  return Date.now() - request.at <= CASE_CHAT_REQUEST_MS;
}

export function subscribeCaseChatRequest(listener: Listener): () => void {
  caseChatListeners.add(listener);
  return () => caseChatListeners.delete(listener);
}

/** Apply another tab's change (never sent back out). */
export function applyChatActivityMessage(message: ChatActivityMessage): void {
  if (message.t === 'clear') {
    clearChatActivity(false);
  } else if (message.t !== 'put') {
    if (message.t === 'drop') dropChatActivity(message.s, false);
    else markChatActivitySeen(message.s, false);
  } else {
    const before = find(message.a.scope);
    if (before?.source === 'local') return;
    const entry: ChatActivity = { ...message.a, source: 'peer' };
    if (before?.status === 'running' && entry.status !== 'running') {
      // The other tab settled it: run the same rules here (on screen → read).
      replace({ ...before, source: 'peer' }, entry.scope);
      settleChatActivity(entry.scope, entry.status === 'unread' ? 'done' : entry.status === 'failed' ? 'error' : 'needs_input', false);
    } else {
      putChatActivity(entry, false);
    }
  }
}
