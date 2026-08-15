/**
 * usePosture — the shared hook for the server-side security-posture rollup.
 *
 * Round-5 W0-B B5: gives Overview/Dashboard a one-liner to consume `GET /api/metrics/
 * posture` (the backend computes MTTA/MTTR/dwell percentiles, quality rates, aging + SLA
 * + period-over-period deltas server-side). The Dashboard-density wave (Dash-A) uses this
 * to delete the ~120 lines of client-side posture math that duplicated the server rollup.
 *
 * Uses the existing co-located `fetchPosture` data layer
 * (`pages/Metrics.posture.api.ts`) with a parameter-keyed response guard and request
 * cancellation — no new endpoint or payload field.
 *
 *   usePosture(hours, period) -> { data: PostureResponse|null, loading, error, reload }
 *
 * `period` selects the period-over-period comparison window: `'prev'` includes the
 * `compare` block (deltas vs the prior equal window); `'none'` (default) omits it. It
 * re-fetches whenever `hours` or `period` change.
 *
 * SECURITY (#9): every label/entity in `PostureResponse` is operator-/log-derived; the
 * consuming components render them as PLAIN text. This hook only moves the SHAPE around.
 */
import * as React from 'react';

import { fetchPosture } from '@/soc/pages/Metrics.posture.api';
import type { PostureResponse } from '@/soc/pages/Metrics.posture.api';

import type { AsyncState } from './useAsync';

/** The comparison window for the posture rollup. `'prev'` → include deltas. */
export type PosturePeriod = 'none' | 'prev';

export function usePosture(
  hours: number,
  period: PosturePeriod = 'none',
): AsyncState<PostureResponse> {
  const requestKey = `${hours}:${period}`;
  const paramsRef = React.useRef({ hours, period, requestKey });
  paramsRef.current = { hours, period, requestKey };

  const currentKeyRef = React.useRef(requestKey);
  currentKeyRef.current = requestKey;
  const requestIdRef = React.useRef(0);
  const controllerRef = React.useRef<AbortController | null>(null);
  const mountedRef = React.useRef(true);

  const [snapshot, setSnapshot] = React.useState<{
    key: string | null;
    data: PostureResponse | null;
    loading: boolean;
    error: unknown;
  }>({ key: null, data: null, loading: true, error: null });

  /**
   * Stable by design: a timer may retain this callback across a range change, but
   * every invocation reads `paramsRef.current`, so a LIVE pulse can never re-issue
   * the previous window. The request key is checked in addition to monotonic order.
   */
  const run = React.useCallback(async () => {
    const issued = paramsRef.current;
    const requestId = (requestIdRef.current += 1);

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setSnapshot((previous) => ({
      key: issued.requestKey,
      data: previous.key === issued.requestKey ? previous.data : null,
      loading: true,
      error: null,
    }));

    try {
      const result = await fetchPosture(
        issued.hours,
        issued.period === 'prev' ? 'prev' : '',
        controller.signal,
      );
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        requestId !== requestIdRef.current ||
        issued.requestKey !== currentKeyRef.current
      ) {
        return;
      }

      // The response echoes its measured window. Treat a mismatched payload as
      // unusable instead of ever presenting it beneath a different selector.
      if (result.window_hours !== issued.hours) {
        throw new Error(
          `Posture response window ${result.window_hours}h did not match requested ${issued.hours}h`,
        );
      }

      setSnapshot({ key: issued.requestKey, data: result, loading: false, error: null });
    } catch (nextError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        requestId !== requestIdRef.current ||
        issued.requestKey !== currentKeyRef.current
      ) {
        return;
      }
      setSnapshot({ key: issued.requestKey, data: null, loading: false, error: nextError });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    void run();
    return () => {
      controllerRef.current?.abort();
    };
  }, [requestKey, run]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      controllerRef.current?.abort();
    };
  }, []);

  // Parameter-keyed projection is synchronous: on the render where the selector
  // changes, an old successful snapshot is already hidden before the new effect runs.
  const current = snapshot.key === requestKey;
  return {
    data: current ? snapshot.data : null,
    loading: current ? snapshot.loading : true,
    error: current ? snapshot.error : null,
    reload: run,
  };
}
