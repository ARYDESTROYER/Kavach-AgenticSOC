/**
 * useEventStream — a graceful, additive live-update hook over the backend's
 * multiplexed Server-Sent-Events spine (`GET /api/events`, see backend
 * `app/realtime.py`).
 *
 * DESIGN — purely ADDITIVE enhancement on top of the existing polling. Nothing in
 * the app's default behaviour changes: realtime is DEFAULT-OFF on the backend
 * (`Preferences.realtime.enabled` False → the endpoint returns 204), and when it is
 * off this hook NEVER opens a persistent stream and reports `live: false`, so every
 * caller keeps polling exactly as it does today. The hook only ever SUPPRESSES (or
 * slows) a caller's poll while a stream is confirmed healthy — it does not, and must
 * not, remove the caller's polling fallback.
 *
 * What it does when realtime IS enabled:
 *   - ONE `EventSource` per page (Round 16 SPEC §4.5 WP09): every hook and store on the
 *     page shares one stream over the reference-counted union of their topics
 *     (browsers allow six connections per origin over HTTP/1.1, and the shell, the
 *     queue and an open case used to hold about six). Each frame is routed by its
 *     channel (`CHANNEL_TOPICS`), so a hook receives only the frames its topics can
 *     carry, and a case-room hook only frames for its case;
 *   - cookie-authenticated: an `EventSource` cannot set an `Authorization` header, so
 *     the same-origin session cookie is the only auth (`withCredentials` is set so it
 *     also flows under a CORS dev proxy);
 *   - resumes after a drop or a change of the topic set with `lastEventId` (the
 *     backend emits monotonic `id:` frames and replays missed retained events from a
 *     bounded ring); a frame seen twice is dropped by its id;
 *   - reconnects with capped exponential backoff + jitter;
 *   - GRACEFULLY FALLS BACK: it first PROBES the endpoint with `fetch` — a 204 means
 *     realtime is disabled, so it stays in polling mode and never opens a stream that
 *     would otherwise reconnect forever (an `EventSource` cannot observe a 204; it
 *     would just error-loop). Any probe error, or repeated immediate `EventSource`
 *     failures, also drop the hook back to `live: false` so the caller resumes
 *     polling.
 *
 * SECURITY (#9): this hook is PURE TRANSPORT. It hands each frame's parsed JSON to
 * the caller's `onEvent` verbatim; it renders NOTHING. Callers must continue to treat
 * every field as UNTRUSTED and escape it on render (the backend producers fence at
 * their boundary; the bus encodes verbatim). A live frame is only ever a NUDGE — the
 * caller refetches authoritative state; nothing here decides anything (#3 untouched).
 */
import * as React from 'react';

/** A parsed SSE frame handed to the caller. `data` is the JSON-decoded payload. */
export interface StreamEvent {
  /** The SSE `event:` channel (e.g. `inapp`, `case.activity`, `overflow`). */
  type: string;
  /** The decoded JSON payload (an object for our producers; `null` if undecodable). */
  data: unknown;
  /** The SSE `id:` (monotonic seq as a string), when present. */
  lastEventId: string;
}

export interface UseEventStreamOptions {
  /**
   * Master switch. When false (the default-OFF posture, or a caller that hasn't
   * opted in), the hook stays completely inert: no probe, no `EventSource`, and
   * `live` is false so the caller keeps polling. Toggling it re-runs the connect.
   */
  enabled?: boolean;
  /** Called for every received frame (already JSON-decoded). Kept in a ref. */
  onEvent?: (ev: StreamEvent) => void;
  /** Override the endpoint path (tests). Defaults to `/api/events`. */
  url?: string;
}

export interface UseEventStreamState {
  /**
   * True only while a stream is OPEN and CONFIRMED healthy. A caller should suppress
   * (or slow) its own polling while this is true, and resume full polling when false.
   * Starts false and returns to false on disable / disconnect / fallback.
   */
  live: boolean;
}

/** Endpoint the hook subscribes to (same-origin; the Vite/nginx `/api` proxy fronts it). */
const DEFAULT_URL = '/api/events';

/**
 * The typed SSE channels we explicitly listen on. An `EventSource` delivers a typed
 * `event:` frame to `addEventListener(<name>)` and NOT to `onmessage`, so a channel
 * missing from this list is simply never seen. `message` (the untyped default
 * channel) is wired as well so a default-channel frame is not dropped.
 *
 * ⚠ THESE MUST MATCH THE BACKEND EXACTLY, character for character. `EventSource`
 * matches a typed `event:` by exact string, and neither end can observe a mismatch:
 * the publish succeeds, the subscription succeeds, and the frames are silently never
 * delivered. That is precisely what happened to investigation progress — this list
 * carried `agent`, while the producer (`app/agents/pipeline.py`) publishes
 * `agent.step`, so not one agent-step frame had ever reached a browser. The backend
 * side now names its channels once in `app/realtime.py` (`SSE_EVENT_TYPES`), and the
 * test for this module asserts that registry and this list agree.
 */
export const AGENT_STEP_CHANNEL = 'agent.step';

export const STREAM_CHANNELS = [
  'message',
  'inapp',
  'case.activity',
  AGENT_STEP_CHANNEL,
  'job',
  // Round 12 (SPEC D13): the caller's own chat turns, owner-only, topic `chat`.
  'chat.turn',
  // Round 12 (SPEC D13): the caller read a conversation's answer on another console.
  'chat.read',
  // Round 12 (WP-CM): a case was saved (created or updated), topic `cases` — the live
  // Case Manager queue nudge. Ids, status and timestamps only; the queue refetches.
  'case.changed',
  // Round 14 (SPEC §4.10.15): a case's runbook run changed, topic `runbooks` (served
  // only with runbooks:read and cases:read). Ids, progress counts and the revision only.
  'case.runbook',
  // Round 15 (SPEC D6.5): an auto-close review was picked or recorded, topics `cases:{id}`
  // and `cases`. Ids and the review state only; the Review scope re-reads.
  'case.review',
  // Round 16 (SPEC §4.3 WP01): an AI investigation run was queued, started, attached its
  // case or finished, topics `cases`, `cases:{id}` and `investigations`. Ids, enums,
  // timestamps and counts only; the Console reconciles through the active-runs route.
  'case.investigation',
  'overflow',
] as const;

/**
 * Which hooks a typed frame is for, by its channel (Round 16 SPEC §4.5 WP09). An SSE frame
 * does not say which topic it was published on, so the page's one stream routes each
 * frame by its channel: a hook receives a frame only when one of its topics can carry
 * that channel. `cases:{id}` stands for a case room: a hook on `cases:X` receives such a
 * frame only when its `data.case_id` is `X`. `*` reaches every hook (`message`, the
 * untyped default, and `overflow`, the "you missed frames" notice). Keep it in step with
 * `STREAM_CHANNELS` (a test checks that every channel has a row).
 */
export const CHANNEL_TOPICS: Readonly<Record<string, readonly string[]>> = {
  message: ['*'],
  inapp: ['notifications', 'inbox'],
  'case.activity': ['cases:{id}'],
  [AGENT_STEP_CHANNEL]: ['cases:{id}'],
  job: ['jobs'],
  'chat.turn': ['chat'],
  'chat.read': ['chat'],
  'case.changed': ['cases'],
  'case.runbook': ['runbooks'],
  'case.review': ['cases', 'cases:{id}'],
  'case.investigation': ['cases', 'cases:{id}', 'investigations'],
  overflow: ['*'],
};

/** Backoff schedule (ms) for reconnect attempts; index is clamped to the last slot. */
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
/**
 * How many consecutive immediate failures (a connect that errors before it was ever
 * confirmed open) before we GIVE UP on realtime and stay in polling mode, until the
 * page's topic set changes. Bounds an error-loop against a backend that 204s without a
 * clean probe (e.g. a proxy that rewrites the status), so we never thrash forever.
 */
const MAX_COLD_FAILURES = 4;
/** A change of the page's topic set waits this long, so a route change reopens once. */
const UNION_DEBOUNCE_MS = 300;
/** How many recent event ids are remembered to drop a frame seen twice. */
const SEEN_IDS = 512;

/** Small +/- jitter so many tabs don't reconnect in lockstep. */
function jitter(ms: number): number {
  return ms + Math.floor((Math.random() - 0.5) * Math.min(ms, 1000));
}

/** Options of {@link subscribeEvents}, the imperative form of {@link useEventStream}. */
export interface EventSubscriptionOptions {
  /** Called for every frame meant for these topics. */
  onEvent?: (ev: StreamEvent) => void;
  /** Called when the stream starts or stops carrying every one of these topics. */
  onLive?: (live: boolean) => void;
  /** Override the endpoint path (tests). Defaults to `/api/events`. */
  url?: string;
}

interface Subscriber {
  topics: readonly string[];
  opts: EventSubscriptionOptions;
  live: boolean;
}

/** One EventSource (or the probe that precedes it) for one topic set. */
interface Connection {
  key: string;
  topics: ReadonlySet<string>;
  es: EventSource | null;
  ctrl: AbortController;
  open: boolean;
  dead: boolean;
}

/** The page's stream for one endpoint (see {@link createMultiplexer}). */
interface Multiplexer {
  add(sub: Subscriber): void;
  remove(sub: Subscriber): void;
}

/**
 * THE page's stream for one endpoint: one EventSource over the reference-counted union
 * of every subscriber's topics. A change of the union is debounced, then a stream for
 * the new union is opened (with `lastEventId`, so retained frames missed in between are
 * replayed) and the old one is closed only once the new one is open: no frame falls in
 * a gap, and a subscriber whose topics both streams carry stays live throughout. Frames
 * are deduped by event id (the two streams overlap for a moment, and the backend gives a
 * frame published on several topics one id). The last unsubscribe closes everything.
 *
 * A closure rather than a class, so the minifier can shorten its state and helpers: it
 * rides the entry chunk (Round 16 SPEC §3.1).
 */
function createMultiplexer(url: string): Multiplexer {
  const subs = new Set<Subscriber>();
  let current: Connection | null = null;
  let next: Connection | null = null;
  let lastId = '';
  let seen: string[] = [];
  let cold = 0;
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queued = false;

  const union = (): string => {
    const all = new Set<string>();
    for (const sub of subs) for (const topic of sub.topics) all.add(topic);
    return [...all].sort().join(',');
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (ms: number): void => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      ensure();
    }, ms);
  };

  /** The topic set moved: open a stream for it (at once for the first, else debounced). */
  function changed(): void {
    const target = next ?? current;
    if (target && target.key === union()) return;
    // A new topic set retries realtime afresh, as a new hook's mount always did.
    idle = false;
    cold = 0;
    if (!target && !timer) {
      if (queued) return;
      // Every hook mounted in one commit joins the first stream (a microtask later).
      queued = true;
      void Promise.resolve().then(ensure);
      return;
    }
    schedule(UNION_DEBOUNCE_MS);
  }

  function ensure(): void {
    queued = false;
    clearTimer();
    if (!subs.size || idle) return;
    const key = union();
    if (next) {
      if (next.key === key) return;
      retire(next);
    }
    if (current && current.key === key) return;
    start(key);
  }

  /**
   * PROBE then CONNECT. We `fetch` the endpoint first so we can read the STATUS: a 204
   * unambiguously means realtime is disabled; we then stay in polling mode and never open
   * an `EventSource` (which cannot see a 204 and would reconnect forever). A 200
   * (text/event-stream) means realtime is live: open the persistent stream. A network or
   * other error falls back to polling (and a capped retry).
   */
  function start(key: string): void {
    const conn: Connection = {
      key,
      topics: new Set(key.split(',')),
      es: null,
      ctrl: new AbortController(),
      open: false,
      dead: false,
    };
    next = conn;
    const query = `${url}?topics=${encodeURIComponent(key)}`;
    // Set once the probe resolves with ANY definitive status, all handled in `.then`.
    // The success-path `abort()` can reject into `.catch` in some runtimes; this flag
    // keeps `.catch` a genuine pre-response network error path only, so the no-retry 204
    // fallback can never leak into a reconnect storm.
    let resolved = false;
    fetch(query, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'text/event-stream' },
      signal: conn.ctrl.signal,
    })
      .then((res) => {
        resolved = true;
        // We only needed the status line; never read the (infinite) body.
        abort(conn);
        if (conn.dead) return;
        if (res.status === 204) {
          // Realtime disabled: graceful fallback to polling, no retries.
          retire(conn);
          idle = true;
          return;
        }
        // A 2xx only means the endpoint ACCEPTED the request, not that the stream will
        // open: the cold counter resets on a confirmed open or frame, never here.
        if (res.status >= 200 && res.status < 300) openStream(conn, query);
        else fail(conn); // auth bounce or server error: poll, retry with backoff
      })
      .catch(() => {
        abort(conn);
        if (conn.dead || resolved || conn.es) return;
        fail(conn);
      });
  }

  function openStream(conn: Connection, query: string): void {
    let es: EventSource;
    try {
      // Cookie auth: an EventSource cannot set an Authorization header.
      es = new EventSource(lastId ? `${query}&lastEventId=${encodeURIComponent(lastId)}` : query, {
        withCredentials: true,
      });
    } catch {
      fail(conn);
      return;
    }
    conn.es = es;
    es.onopen = () => {
      if (!conn.dead) promote(conn);
    };
    for (const channel of STREAM_CHANNELS) {
      es.addEventListener(channel, (ev) => {
        if (conn.dead) return;
        if (!conn.open) promote(conn);
        const frame = ev as MessageEvent;
        deliver(channel === 'message' ? frame.type || 'message' : channel, frame);
      });
    }
    es.onerror = () => {
      if (conn.dead) return;
      // An error fires on a drop AND on a hard failure. One that never opened counts as
      // a cold failure (capped). We close and reschedule with our own capped backoff
      // rather than the browser's auto-reconnect.
      const wasOpen = conn.open || es.readyState === EventSource.OPEN;
      retire(conn);
      if (!wasOpen) cold += 1;
      // Retry unless a stream for the page's topic set still serves or is on its way. A
      // stream for a NEW topic set that fails before it opens leaves the old one serving
      // the old set: it is retried too, or the new topics would never get a stream.
      if (!next && !(current && current.key === union())) backoff();
    };
  }

  /** `conn` is open: it serves the page now, and the stream it replaces closes. */
  function promote(conn: Connection): void {
    conn.open = true;
    cold = 0;
    if (next === conn) next = null;
    const previous = current;
    current = conn;
    if (previous && previous !== conn) retire(previous);
    // A plain (re)connect: the server may have restarted its ids, so start afresh (the
    // replay it sends after `lastEventId` sets them again).
    else if (!previous) {
      seen = [];
      lastId = '';
    }
    refreshLive();
    if (union() !== conn.key) schedule(UNION_DEBOUNCE_MS);
  }

  function fail(conn: Connection): void {
    retire(conn);
    cold += 1;
    backoff();
  }

  function backoff(): void {
    if (cold >= MAX_COLD_FAILURES) {
      // Give up on realtime until the topic set changes; every hook stays on polling.
      idle = true;
      return;
    }
    schedule(jitter(BACKOFF_MS[Math.min(cold, BACKOFF_MS.length - 1)]));
  }

  function retire(conn: Connection): void {
    conn.dead = true;
    abort(conn);
    const es = conn.es;
    if (es) {
      // Drop the handlers and close, so a stale socket cannot deliver after teardown.
      es.onopen = null;
      es.onerror = null;
      es.onmessage = null;
      try {
        es.close();
      } catch {
        /* closing an already-closed source is harmless */
      }
      conn.es = null;
    }
    if (next === conn) next = null;
    if (current === conn) {
      current = null;
      refreshLive();
    }
  }

  /** A subscriber is live while the open stream carries every one of its topics. */
  function refreshLive(): void {
    const open = current && current.open ? current : null;
    for (const sub of subs) {
      const live = open !== null && sub.topics.every((topic) => open.topics.has(topic));
      if (live === sub.live) continue;
      sub.live = live;
      safely(() => sub.opts.onLive?.(live));
    }
  }

  function deliver(type: string, frame: MessageEvent): void {
    const id = frame.lastEventId || '';
    if (id) {
      if (seen.includes(id)) return;
      seen.push(id);
      if (seen.length > SEEN_IDS) seen.shift();
      if (!(Number(lastId) > Number(id))) lastId = id;
    }
    let data: unknown = null;
    const raw = typeof frame.data === 'string' ? frame.data : '';
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        // Non-JSON payload: hand the raw string through rather than dropping it.
        data = raw;
      }
    }
    const ev: StreamEvent = { type, data, lastEventId: id };
    for (const sub of [...subs]) {
      if (subs.has(sub) && frameIsFor(sub.topics, type, data)) safely(() => sub.opts.onEvent?.(ev));
    }
  }

  const mux: Multiplexer = {
    add(sub) {
      subs.add(sub);
      refreshLive();
      changed();
    },
    remove(sub) {
      subs.delete(sub);
      if (subs.size) {
        changed();
        return;
      }
      clearTimer();
      queued = false;
      if (next) retire(next);
      if (current) retire(current);
      if (streams.get(url) === mux) streams.delete(url);
    },
  };
  return mux;
}

/** Abort a connection's probe (best effort). */
function abort(conn: Connection): void {
  try {
    conn.ctrl.abort();
  } catch {
    /* aborting is best-effort */
  }
}

/** Run a caller's handler: its error must never break the stream. */
function safely(run: () => void): void {
  try {
    run();
  } catch {
    /* a caller handler error must never break the stream */
  }
}

/** Whether a frame on `channel` (with payload `data`) is for a hook on `topics`. */
export function frameIsFor(topics: readonly string[], channel: string, data: unknown): boolean {
  const routes = CHANNEL_TOPICS[channel];
  // A channel without a row reaches every hook (the test keeps the table complete).
  if (!routes || routes.includes('*')) return true;
  const caseId =
    data && typeof data === 'object' ? String((data as { case_id?: unknown }).case_id ?? '') : '';
  return topics.some((topic) =>
    topic.startsWith('cases:')
      ? routes.includes('cases:{id}') && caseId !== '' && topic.slice(6) === caseId
      : routes.includes(topic),
  );
}

/** The page's streams, one per endpoint. */
const streams = new Map<string, Multiplexer>();

/**
 * Subscribe to `topics` on the page's one stream (Round 16 SPEC §4.5 WP09): the
 * imperative form of {@link useEventStream}, for a store outside React. Returns the
 * unsubscribe; the last one closes the stream. Without topics, or without
 * `EventSource`, it stays inert and reports `live: false`.
 */
export function subscribeEvents(
  topics: readonly string[],
  opts: EventSubscriptionOptions = {},
): () => void {
  const list = [...new Set(topics.map((t) => String(t).trim()).filter(Boolean))].sort();
  if (!list.length || typeof EventSource === 'undefined') {
    opts.onLive?.(false);
    return () => undefined;
  }
  const url = opts.url || DEFAULT_URL;
  let mux = streams.get(url);
  if (!mux) {
    mux = createMultiplexer(url);
    streams.set(url, mux);
  }
  const owner = mux;
  const sub: Subscriber = { topics: list, opts, live: false };
  owner.add(sub);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    owner.remove(sub);
  };
}

/**
 * Subscribe to the live event stream for `topics`, with a graceful fallback to the
 * caller's existing polling when realtime is disabled or unavailable. Every hook on a
 * page shares ONE EventSource (`subscribeEvents`); a hook receives only the frames its
 * topics can carry (`CHANNEL_TOPICS`).
 *
 * @param topics  the SSE topics to subscribe to (e.g. `['notifications','inbox']` or
 *                `['cases:case-1234']`). An empty list disables the stream (inert).
 * @returns `{ live }`: true only while the page's stream is open and carries every one
 *          of `topics`. Callers gate their poll on `!live`.
 */
export function useEventStream(
  topics: string[],
  opts: UseEventStreamOptions = {},
): UseEventStreamState {
  const { enabled = false, onEvent, url = DEFAULT_URL } = opts;
  const [live, setLive] = React.useState(false);

  // Keep the latest callback in a ref so a changing `onEvent` identity does NOT
  // resubscribe (the effect depends only on enabled + the topic key).
  const onEventRef = React.useRef<typeof onEvent>(onEvent);
  React.useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  // Stable, order-independent key for the topic set so the effect re-runs only when
  // the actual topics change (not on every array-literal re-render).
  const topicKey = React.useMemo(
    () => [...topics].filter(Boolean).sort().join(','),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topics.join('|')],
  );

  React.useEffect(() => {
    // Inert unless explicitly enabled with at least one topic (the default-OFF path:
    // the caller keeps polling, `live` stays false).
    if (!enabled || !topicKey) {
      setLive(false);
      return undefined;
    }
    const off = subscribeEvents(topicKey.split(','), {
      url,
      onLive: setLive,
      onEvent: (ev) => onEventRef.current?.(ev),
    });
    return () => {
      off();
      setLive(false);
    };
  }, [enabled, topicKey, url]);

  return { live };
}

export default useEventStream;
