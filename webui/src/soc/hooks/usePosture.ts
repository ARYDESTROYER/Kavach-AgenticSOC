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
 *   usePosture(hours, period) -> { data, loading, error, stale, reload }
 *
 * `period` selects the period-over-period comparison window: `'prev'` includes the
 * `compare` block (deltas vs the prior equal window); `'none'` (default) omits it. It
 * re-fetches whenever `hours` or `period` change.
 *
 * STALE-WHILE-REVALIDATE: changing the window keeps the LAST SUCCESSFUL snapshot as
 * `data` (flagged `stale: true`) while the new window's request is in flight, instead
 * of nulling it and blanking every posture consumer. The consumer stays responsible
 * for labelling stale content (Overview shows its "Loading Nh" sub); a fresh payload
 * replaces the snapshot atomically and clears the flag. Correctness is unchanged:
 * the response still echoes its measured window and a mismatched payload is rejected,
 * a superseded request can never write state, and a failed request drops the data
 * (an error is reported explicitly, never rendered as a healthy snapshot).
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

/** `AsyncState` plus the stale-while-revalidate marker. */
export interface PostureState extends AsyncState<PostureResponse> {
  /**
   * True while `data` is a RETAINED previous-parameter snapshot shown during an
   * in-flight window change. Consumers must present stale data with an explicit
   * loading/refresh indicator, never as fresh selected-window truth.
   */
  stale: boolean;
}

export function usePosture(
  hours: number,
  period: PosturePeriod = 'none',
): PostureState {
  const requestKey = `${hours}:${period}`;
  const paramsRef = React.useRef({ hours, period, requestKey });
  paramsRef.current = { hours, period, requestKey };

  const currentKeyRef = React.useRef(requestKey);
  currentKeyRef.current = requestKey;
  const requestIdRef = React.useRef(0);
  const controllerRef = React.useRef<AbortController | null>(null);
  const mountedRef = React.useRef(true);

  const [snapshot, setSnapshot] = React.useState<{
    /** The request key this snapshot's load state belongs to. */
    key: string | null;
    data: PostureResponse | null;
    /** The request key `data` was fetched for (staleness authority). */
    dataKey: string | null;
    loading: boolean;
    error: unknown;
  }>({ key: null, data: null, dataKey: null, loading: true, error: null });

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

    // Stale-while-revalidate: retain the last successful snapshot (and the key it
    // belongs to) while the new request is in flight, so a window change never
    // blanks the consuming dashboard. `dataKey` keeps the staleness truthful.
    setSnapshot((previous) => ({
      key: issued.requestKey,
      data: previous.data,
      dataKey: previous.dataKey,
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

      setSnapshot({
        key: issued.requestKey,
        data: result,
        dataKey: issued.requestKey,
        loading: false,
        error: null,
      });
    } catch (nextError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        requestId !== requestIdRef.current ||
        issued.requestKey !== currentKeyRef.current
      ) {
        return;
      }
      // A failed read is reported explicitly; a stale snapshot must never keep
      // masquerading as usable data beneath an error state.
      setSnapshot({
        key: issued.requestKey,
        data: null,
        dataKey: null,
        loading: false,
        error: nextError,
      });
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
  // changes, the retained snapshot is ALREADY flagged stale (dataKey !== requestKey)
  // and loading is true, before the new effect even runs.
  const current = snapshot.key === requestKey;
  const stale = snapshot.data != null && snapshot.dataKey !== requestKey;
  return {
    data: snapshot.data,
    loading: current ? snapshot.loading : true,
    error: current ? snapshot.error : null,
    stale,
    reload: run,
  };
}
