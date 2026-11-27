/**
 * Investigation narration over the page's event stream: the `agent.step` frames the
 * pipeline publishes on a case room (`cases:{caseId}`) while an investigation runs.
 *
 * Split out of `useEventStream.ts` (Round 16 SPEC §3.1, WP16): that module rides the
 * entry chunk because the shell's bell and job monitor subscribe at first paint, while
 * these helpers serve only the case page. Kept here, they load with the case page's lazy
 * chunk instead of at first paint. Nothing in an entry module may import this file.
 *
 * PURE TRANSPORT, exactly like `useEventStream`: the steps are a NARRATION. Nothing here
 * decides anything (#3). The authoritative case record still comes from the API, and a
 * consumer that wants authoritative state refetches it.
 */
import * as React from 'react';

import { AGENT_STEP_CHANNEL, useEventStream, type StreamEvent } from './useEventStream';

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
  /** Client receive time (ms since epoch), for ordering only, never authoritative. */
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
 * Parse one raw SSE frame into an `AgentStep`, or `null` when it is not one.
 *
 * Exported because the rendered consumer is `CaseActivityFeed`, which already holds an
 * open stream on the case room and folds `agent.step` into that ONE subscription: a
 * second `EventSource` on the same room would spend a browser connection slot for
 * nothing. `useAgentSteps` below is the same logic for a surface that wants only the
 * steps and has no stream of its own; CaseDetail deliberately does not mount it.
 *
 * Every field is provider-influenceable or log-influenceable UNTRUSTED text (#9): it is
 * length-capped here and rendered exclusively as a plain text node by the consumer.
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

/**
 * A STANDALONE subscriber for the investigation-progress channel.
 *
 * Subscribes to a case's room (`cases:{caseId}`) on the page's one stream and
 * accumulates the `agent.step` frames. Use it for a surface that wants ONLY the steps.
 *
 * The rendered consumer today is `CaseActivityFeed`, which folds the same frames into
 * the subscription it already holds on that room (through `agentStepFromFrame` above),
 * so CaseDetail does not mount this hook as well.
 *
 * The buffer is bounded (`limit`) and is CLEARED whenever `caseId` changes, so one
 * case's steps can never bleed into another's.
 */
export function useAgentSteps(
  caseId: string | null | undefined,
  opts: UseAgentStepsOptions = {},
): UseAgentStepsState {
  const { enabled = true, limit = 50, url } = opts;
  const [steps, setSteps] = React.useState<AgentStep[]>([]);
  const active = Boolean(caseId) && enabled;

  // A different case is a different run: never carry steps across.
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
