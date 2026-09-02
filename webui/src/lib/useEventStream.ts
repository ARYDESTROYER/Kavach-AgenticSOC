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
 *   - subscribes to the requested `topics` over a single `EventSource`
 *     (cookie-authenticated: an `EventSource` cannot set an `Authorization` header,
 *     so the same-origin session cookie is the only auth — `withCredentials` is set
 *     so it also flows under a CORS dev proxy);
 *   - resumes after a drop via the browser's native `Last-Event-ID` (the backend
 *     emits monotonic `id:` frames and replays missed events from a bounded ring);
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
  'overflow',
] as const;

/** Backoff schedule (ms) for reconnect attempts; index is clamped to the last slot. */
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
/**
 * How many consecutive immediate failures (a connect that errors before it was ever
 * confirmed open) before we GIVE UP on realtime for this mount and stay in polling
 * mode. Bounds an error-loop against a backend that 204s without a clean probe (e.g.
 * a proxy that rewrites the status), so we never thrash forever.
 */
const MAX_COLD_FAILURES = 4;

/** Small +/- jitter so many tabs don't reconnect in lockstep. */
function jitter(ms: number): number {
  return ms + Math.floor((Math.random() - 0.5) * Math.min(ms, 1000));
}

/**
 * Subscribe to the live event stream for `topics`, with a graceful fallback to the
 * caller's existing polling when realtime is disabled or unavailable.
 *
 * @param topics  the SSE topics to subscribe to (e.g. `['notifications','inbox']` or
 *                `['cases:case-1234']`). An empty list disables the stream (inert).
 * @returns `{ live }` — true only while a healthy stream is open. Callers gate their
 *          poll on `!live` (keep polling when there is no live stream).
 */
export function useEventStream(
  topics: string[],
  opts: UseEventStreamOptions = {},
): UseEventStreamState {
  const { enabled = false, onEvent, url = DEFAULT_URL } = opts;
  const [live, setLive] = React.useState(false);

  // Keep the latest callback in a ref so a changing `onEvent` identity does NOT tear
  // down + reopen the stream (the effect depends only on enabled + the topic key).
  const onEventRef = React.useRef<typeof onEvent>(onEvent);
  React.useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  // Stable, order-independent key for the topic set so the connect effect re-runs
  // only when the actual topics change (not on every array-literal re-render).
  const topicKey = React.useMemo(
    () => [...topics].filter(Boolean).sort().join(','),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topics.join('|')],
  );

  React.useEffect(() => {
    // Inert unless explicitly enabled with at least one topic. This is the
    // default-OFF path: the caller keeps polling, `live` stays false.
    if (!enabled || !topicKey) {
      setLive(false);
      return undefined;
    }
    // No EventSource (SSR / very old runtime): stay in polling mode.
    if (typeof EventSource === 'undefined') {
      setLive(false);
      return undefined;
    }

    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let coldFailures = 0; // consecutive failures with no successful open in between

    const queryUrl = `${url}?topics=${encodeURIComponent(topicKey)}`;

    const clearTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const teardownEs = () => {
      if (es) {
        // Drop listeners + close so a stale socket can't deliver after teardown.
        es.onopen = null;
        es.onerror = null;
        es.onmessage = null;
        try {
          es.close();
        } catch {
          /* closing an already-closed source is harmless */
        }
        es = null;
      }
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (coldFailures >= MAX_COLD_FAILURES) {
        // Give up on realtime for this mount — the caller stays on polling.
        return;
      }
      const base = BACKOFF_MS[Math.min(coldFailures, BACKOFF_MS.length - 1)];
      clearTimer();
      reconnectTimer = setTimeout(() => {
        if (!cancelled) connect();
      }, jitter(base));
    };

    const handleFrame = (type: string, e: MessageEvent) => {
      // A confirmed message means the stream is healthy — reset the cold counter.
      coldFailures = 0;
      let data: unknown = null;
      const raw = typeof e.data === 'string' ? e.data : '';
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          // Non-JSON payload: hand the raw string through rather than dropping it.
          data = raw;
        }
      }
      const cb = onEventRef.current;
      if (cb) {
        try {
          cb({ type, data, lastEventId: e.lastEventId || '' });
        } catch {
          /* a caller handler error must never break the stream */
        }
      }
    };

    // The exact typed channels the backend publishes (see STREAM_CHANNELS above).
    const CHANNELS: readonly string[] = STREAM_CHANNELS;

    const openStream = () => {
      teardownEs();
      try {
        es = new EventSource(queryUrl, { withCredentials: true });
      } catch {
        // Constructing the source threw (bad URL / blocked) — treat as a cold fail.
        coldFailures += 1;
        setLive(false);
        scheduleReconnect();
        return;
      }
      const source = es;
      source.onopen = () => {
        if (cancelled) return;
        // A CONFIRMED open is the only signal that realtime is actually healthy, so
        // the cold-failure counter is cleared HERE (and in handleFrame), never on a
        // mere probe 200. A 200 probe followed by a stream that never opens must keep
        // accruing cold failures until MAX_COLD_FAILURES engages the give-up cap —
        // otherwise the probe→open→onerror loop resets the counter and thrashes forever.
        coldFailures = 0;
        setLive(true);
      };
      for (const ch of CHANNELS) {
        source.addEventListener(ch, (ev) => {
          if (cancelled) return;
          // The first real frame also implies the stream is up.
          setLive(true);
          handleFrame(ch === 'message' ? (ev as MessageEvent).type || 'message' : ch, ev as MessageEvent);
        });
      }
      source.onerror = () => {
        if (cancelled) return;
        // An EventSource error fires on a drop AND on a hard failure. If it never
        // opened, count it as a cold failure (a disabled-but-non-204 backend would
        // error-loop here, so we cap it). The browser auto-reconnects an OPEN stream
        // via Last-Event-ID; we additionally close + reschedule to apply our own
        // capped backoff and to honour the give-up cap.
        const wasOpen = source.readyState === EventSource.OPEN;
        if (!wasOpen) coldFailures += 1;
        setLive(false);
        teardownEs();
        scheduleReconnect();
      };
    };

    /**
     * PROBE then CONNECT. We `fetch` the endpoint first so we can read the STATUS: a
     * 204 unambiguously means realtime is disabled — we then stay in polling mode and
     * never open an `EventSource` (which cannot see a 204 and would reconnect forever).
     * A 200 (text/event-stream) means realtime is live → open the persistent stream.
     * A network/other error falls back to polling (and a capped retry).
     */
    const connect = () => {
      if (cancelled) return;
      // The probe must not itself hang an open stream; it's a cheap HEAD-of-stream
      // GET that we abort immediately once we have the status line.
      const ctrl = new AbortController();
      // Set once the probe resolves with ANY definitive status (204 / 2xx / error
      // status), all of which are handled fully inside `.then`. The success-path
      // `ctrl.abort()` can reject into `.catch` in some runtimes; this flag keeps
      // `.catch` a genuine-PRE-response-network-error path only, so the no-retry 204
      // fallback can never leak into a reconnect storm.
      let probeResolved = false;
      fetch(queryUrl, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal,
      })
        .then((res) => {
          probeResolved = true;
          // We only needed the status + headers; never read the (infinite) body.
          try {
            ctrl.abort();
          } catch {
            /* aborting is best-effort */
          }
          if (cancelled) return;
          if (res.status === 204) {
            // Realtime disabled — graceful fallback to polling, no retries.
            setLive(false);
            return;
          }
          if (res.status >= 200 && res.status < 300) {
            // Do NOT reset coldFailures here — a 200 probe only means the endpoint
            // ACCEPTED the request, not that the EventSource will actually open. The
            // reset happens on a confirmed open/frame; a stream that 200-probes but
            // never opens must reach the give-up cap instead of looping forever.
            openStream();
            return;
          }
          // Auth bounce / server error → fall back to polling, retry with backoff.
          coldFailures += 1;
          setLive(false);
          scheduleReconnect();
        })
        .catch(() => {
          try {
            ctrl.abort();
          } catch {
            /* ignore */
          }
          if (cancelled) return;
          // A response was already received + fully handled in `.then` (the no-retry
          // 204 path, the stream-open 2xx path, and the abort we issue on success that
          // rejects here in some runtimes) — only a genuine PRE-response network error
          // (probe never resolved, no stream open) should count as a cold failure.
          if (probeResolved || es) return;
          coldFailures += 1;
          setLive(false);
          scheduleReconnect();
        });
    };

    connect();

    return () => {
      cancelled = true;
      clearTimer();
      teardownEs();
      setLive(false);
    };
    // Re-run only when the enable flag, topic set, or endpoint changes.
  }, [enabled, topicKey, url]);

  return { live };
}

/**
 * One received `agent.step` frame, normalised to plain strings.
 *
 * Every field is UNTRUSTED (#9): the backend fences at its boundary and the bus
 * encodes verbatim, so a consumer must still let React escape these on render and
 * must never treat `detail` as markup.
 */
export interface AgentStep {
  /** The case the step belongs to (as reported by the producer). */
  caseId: string;
  /** Short step label, e.g. `triage`, `tools`, `decision`. */
  step: string;
  /** Step status, e.g. `running`, `done`. Defaults to `running` when absent. */
  status: string;
  /** Optional short, already-render-safe detail label. May be empty. */
  detail: string;
  /** Client receive time (ms since epoch) — ordering only, never authoritative. */
  receivedAt: number;
}

export interface UseAgentStepsOptions {
  /** Master switch (default true). Combined with a non-empty `caseId`. */
  enabled?: boolean;
  /** Ring size; the oldest steps past this are dropped (default 50). */
  limit?: number;
  /** Override the endpoint path (tests). */
  url?: string;
}

export interface UseAgentStepsState {
  /** Steps received on this mount, oldest first, bounded by `limit`. */
  steps: AgentStep[];
  /** True only while a healthy stream is open (mirrors `useEventStream`). */
  live: boolean;
}

/** Coerce an untrusted payload value to a short plain string (never markup). */
function asShortText(value: unknown, max = 200): string {
  if (value == null) return '';
  const text = String(value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * A STANDALONE subscriber for the investigation-progress channel.
 *
 * Opens its own stream on a case's room (`cases:{caseId}`) and accumulates the
 * `agent.step` frames the pipeline publishes while an investigation runs. Use it for a
 * surface that wants ONLY the steps and holds no stream of its own.
 *
 * The rendered consumer today is `CaseActivityFeed`, which folds the same frames into
 * the ONE subscription it already holds on that room (via `agentStepFromFrame` above) —
 * CaseDetail deliberately does not mount this hook as well, because a second
 * `EventSource` on one room spends a browser connection slot for nothing.
 *
 * PURE TRANSPORT, exactly like `useEventStream`: the steps are a NARRATION. Nothing
 * here decides anything (#3) — the authoritative case record still comes from the
 * API, and a consumer that wants authoritative state refetches it.
 *
 * The buffer is bounded (`limit`) and is CLEARED whenever `caseId` changes, so one
 * case's steps can never bleed into another's.
 */
/**
 * Parse one raw SSE frame into an `AgentStep`, or `null` when it is not one.
 *
 * Exported because the rendered consumer is `CaseActivityFeed`, which already holds an
 * open stream on the case room and folds `agent.step` into that ONE subscription — a
 * second `EventSource` on the same room would spend a browser connection slot for
 * nothing. `useAgentSteps` below is the same logic for a surface that wants only the
 * steps and has no stream of its own; CaseDetail deliberately does not mount it.
 *
 * Every field is provider-/log-influenceable UNTRUSTED text (#9): it is length-capped
 * here and rendered exclusively as a plain text node by the consumer.
 */
export function agentStepFromFrame(
  ev: StreamEvent,
  caseId?: string | null,
): AgentStep | null {
  if (ev.type !== AGENT_STEP_CHANNEL) return null;
  const raw = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as Record<string, unknown>;
  const frameCase = asShortText(raw.case_id, 120);
  // Defence in depth: the room is already per-case, but never accept a frame that
  // names a different case.
  if (caseId && frameCase && frameCase !== caseId) return null;
  const step = asShortText(raw.step, 80);
  if (!step) return null;
  return {
    caseId: frameCase || String(caseId ?? ''),
    step,
    status: asShortText(raw.status, 40) || 'running',
    detail: asShortText(raw.detail),
    receivedAt: Date.now(),
  };
}

/** Append one step to a BOUNDED buffer (oldest dropped first). Pure. */
export function appendAgentStep(
  prev: AgentStep[],
  entry: AgentStep,
  limit: number,
): AgentStep[] {
  const next = [...prev, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function useAgentSteps(
  caseId: string | null | undefined,
  opts: UseAgentStepsOptions = {},
): UseAgentStepsState {
  const { enabled = true, limit = 50, url } = opts;
  const [steps, setSteps] = React.useState<AgentStep[]>([]);
  const active = Boolean(caseId) && enabled;

  // A different case is a different run — never carry steps across.
  React.useEffect(() => {
    setSteps([]);
  }, [caseId]);

  const onEvent = React.useCallback(
    (ev: StreamEvent) => {
      const entry = agentStepFromFrame(ev, caseId);
      if (!entry) return;
      setSteps((prev) => appendAgentStep(prev, entry, limit));
    },
    [caseId, limit],
  );

  const { live } = useEventStream(active && caseId ? [`cases:${caseId}`] : [], {
    enabled: active,
    onEvent,
    url,
  });

  return { steps, live };
}

export default useEventStream;
