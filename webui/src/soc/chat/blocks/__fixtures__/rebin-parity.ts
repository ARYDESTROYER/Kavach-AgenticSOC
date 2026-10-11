/**
 * Re-bin parity fixture (Round 12 P0-8 acceptance: "re-binning daily to weekly gives
 * sums equal to a server weekly query"). GENERATED from the backend's own calendar code
 * (`engine/time_windows.calendar_buckets`, `period_label`, `align_window` and the
 * `display_bucket_labels` cut-edge grammar), not hand-written: for each zone, "last 90
 * days" resolved at a fixed now (the New York window holds a DST change) and aligned to
 * days, 2,400 deterministic synthetic event instants, and the per-bucket counts the
 * server returns at day, week and month over the SAME window. The web test re-bins the
 * daily series in the browser and must reproduce the server's weekly and monthly counts
 * and labels exactly.
 *
 * Regenerate from `backend/` with `.venv/bin/python gen.py` (it prints the JSON this file
 * holds), where gen.py is:
 *
 * """Generate the WP-BLK re-bin parity fixture from the BACKEND's own calendar code.
 *
 * For each zone: resolve "last 90 days" at a fixed now, align it to days (what the chat
 * tools do for a by-day breakdown), place deterministic synthetic event instants in the
 * window, and count them per server bucket at day, week and month over the SAME window.
 * The web test re-bins the daily series and must equal the server's week/month counts.
 * """
 * import json
 * import sys
 * from datetime import datetime, timedelta, timezone
 *
 * sys.path.insert(0, ".")
 * from app.engine.time_windows import align_window, calendar_buckets, period_start, resolve_window  # noqa: E402
 * from app.agents.chat_tools.stats import _edge_text  # noqa: E402
 *
 * NOW = datetime(2026, 10, 11, 9, 30, tzinfo=timezone.utc)
 * # New York is resolved later, so its window holds the 1 Nov 2026 DST change (a 25-hour day).
 * CASES = (("UTC", NOW), ("Asia/Kolkata", NOW), ("America/New_York", datetime(2026, 11, 20, 15, 0, tzinfo=timezone.utc)))
 * out = {"cases": []}
 * for tz, now in CASES:
 *     window = align_window(resolve_window("last 90 days", tz=tz, now=now), "day")
 *     span = (window.end - window.start).total_seconds()
 *     # Deterministic pseudo-random instants (an LCG), denser on some days.
 *     seed = 12345
 *     events = []
 *     for _ in range(2400):
 *         seed = (seed * 1103515245 + 12345) % (2 ** 31)
 *         frac = seed / 2 ** 31
 *         events.append(window.start + timedelta(seconds=frac * span))
 *     case = {"tz": tz, "now": now.isoformat(), "window_start": window.start.isoformat(), "window_end": window.end.isoformat()}
 *     for unit in ("day", "week", "month"):
 *         buckets = calendar_buckets(window, unit)
 *         counts = [sum(1 for e in events if b.start <= e < b.end and window.contains(e)) for b in buckets]
 *         labels = [b.label for b in buckets]
 *         # The server's display label of a bucket the window cuts (stats.display_bucket_labels).
 *         if unit != "day" and period_start(window.start, unit, tz) < window.start:
 *             labels[0] = f"{labels[0]} (from {_edge_text(window.start, unit, tz)})"
 *         case[unit] = {
 *             "x": [b.start.isoformat().replace("+00:00", "Z") for b in buckets],
 *             "labels": labels,
 *             "in_progress": [b.in_progress for b in buckets],
 *             "counts": counts,
 *         }
 *     assert sum(case["day"]["counts"]) == sum(case["week"]["counts"]) == sum(case["month"]["counts"])
 *     out["cases"].append(case)
 * print(json.dumps(out, separators=(",", ":")))
 */
export interface ParityUnit {
  /** Bucket starts (UTC instants). */
  x: string[];
  /** The server's labels (a bucket the window cuts names its edge, like the chat tools). */
  labels: string[];
  in_progress: boolean[];
  counts: number[];
}
export interface ParityCase {
  tz: string;
  now: string;
  window_start: string;
  window_end: string;
  day: ParityUnit;
  week: ParityUnit;
  month: ParityUnit;
}

export const REBIN_PARITY: ParityCase[] = [
  {
    tz: 'UTC',
    now: '2026-10-11T09:30:00+00:00',
    window_start: '2026-07-14T00:00:00+00:00',
    window_end: '2026-10-11T09:30:00+00:00',
    day: {
      x: ['2026-07-14T00:00:00Z', '2026-07-15T00:00:00Z', '2026-07-16T00:00:00Z', '2026-07-17T00:00:00Z', '2026-07-18T00:00:00Z', '2026-07-19T00:00:00Z', '2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z', '2026-07-22T00:00:00Z', '2026-07-23T00:00:00Z', '2026-07-24T00:00:00Z', '2026-07-25T00:00:00Z', '2026-07-26T00:00:00Z', '2026-07-27T00:00:00Z', '2026-07-28T00:00:00Z', '2026-07-29T00:00:00Z', '2026-07-30T00:00:00Z', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', '2026-08-03T00:00:00Z', '2026-08-04T00:00:00Z', '2026-08-05T00:00:00Z', '2026-08-06T00:00:00Z', '2026-08-07T00:00:00Z', '2026-08-08T00:00:00Z', '2026-08-09T00:00:00Z', '2026-08-10T00:00:00Z', '2026-08-11T00:00:00Z', '2026-08-12T00:00:00Z', '2026-08-13T00:00:00Z', '2026-08-14T00:00:00Z', '2026-08-15T00:00:00Z', '2026-08-16T00:00:00Z', '2026-08-17T00:00:00Z', '2026-08-18T00:00:00Z', '2026-08-19T00:00:00Z', '2026-08-20T00:00:00Z', '2026-08-21T00:00:00Z', '2026-08-22T00:00:00Z', '2026-08-23T00:00:00Z', '2026-08-24T00:00:00Z', '2026-08-25T00:00:00Z', '2026-08-26T00:00:00Z', '2026-08-27T00:00:00Z', '2026-08-28T00:00:00Z', '2026-08-29T00:00:00Z', '2026-08-30T00:00:00Z', '2026-08-31T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-03T00:00:00Z', '2026-09-04T00:00:00Z', '2026-09-05T00:00:00Z', '2026-09-06T00:00:00Z', '2026-09-07T00:00:00Z', '2026-09-08T00:00:00Z', '2026-09-09T00:00:00Z', '2026-09-10T00:00:00Z', '2026-09-11T00:00:00Z', '2026-09-12T00:00:00Z', '2026-09-13T00:00:00Z', '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z', '2026-09-16T00:00:00Z', '2026-09-17T00:00:00Z', '2026-09-18T00:00:00Z', '2026-09-19T00:00:00Z', '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z', '2026-09-22T00:00:00Z', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z', '2026-09-25T00:00:00Z', '2026-09-26T00:00:00Z', '2026-09-27T00:00:00Z', '2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z', '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z', '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z', '2026-10-09T00:00:00Z', '2026-10-10T00:00:00Z', '2026-10-11T00:00:00Z'],
      labels: ['14 Jul 2026', '15 Jul 2026', '16 Jul 2026', '17 Jul 2026', '18 Jul 2026', '19 Jul 2026', '20 Jul 2026', '21 Jul 2026', '22 Jul 2026', '23 Jul 2026', '24 Jul 2026', '25 Jul 2026', '26 Jul 2026', '27 Jul 2026', '28 Jul 2026', '29 Jul 2026', '30 Jul 2026', '31 Jul 2026', '1 Aug 2026', '2 Aug 2026', '3 Aug 2026', '4 Aug 2026', '5 Aug 2026', '6 Aug 2026', '7 Aug 2026', '8 Aug 2026', '9 Aug 2026', '10 Aug 2026', '11 Aug 2026', '12 Aug 2026', '13 Aug 2026', '14 Aug 2026', '15 Aug 2026', '16 Aug 2026', '17 Aug 2026', '18 Aug 2026', '19 Aug 2026', '20 Aug 2026', '21 Aug 2026', '22 Aug 2026', '23 Aug 2026', '24 Aug 2026', '25 Aug 2026', '26 Aug 2026', '27 Aug 2026', '28 Aug 2026', '29 Aug 2026', '30 Aug 2026', '31 Aug 2026', '1 Sep 2026', '2 Sep 2026', '3 Sep 2026', '4 Sep 2026', '5 Sep 2026', '6 Sep 2026', '7 Sep 2026', '8 Sep 2026', '9 Sep 2026', '10 Sep 2026', '11 Sep 2026', '12 Sep 2026', '13 Sep 2026', '14 Sep 2026', '15 Sep 2026', '16 Sep 2026', '17 Sep 2026', '18 Sep 2026', '19 Sep 2026', '20 Sep 2026', '21 Sep 2026', '22 Sep 2026', '23 Sep 2026', '24 Sep 2026', '25 Sep 2026', '26 Sep 2026', '27 Sep 2026', '28 Sep 2026', '29 Sep 2026', '30 Sep 2026', '1 Oct 2026', '2 Oct 2026', '3 Oct 2026', '4 Oct 2026', '5 Oct 2026', '6 Oct 2026', '7 Oct 2026', '8 Oct 2026', '9 Oct 2026', '10 Oct 2026', '11 Oct 2026'],
      in_progress: [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, true],
      counts: [20, 28, 31, 26, 25, 25, 31, 20, 29, 25, 27, 34, 23, 35, 24, 21, 25, 28, 25, 33, 21, 35, 38, 28, 22, 33, 25, 24, 23, 21, 19, 28, 35, 42, 20, 28, 22, 24, 23, 25, 28, 25, 32, 23, 27, 24, 22, 15, 23, 33, 29, 25, 27, 34, 26, 25, 31, 27, 30, 23, 28, 32, 24, 24, 21, 43, 47, 24, 18, 26, 27, 35, 21, 26, 29, 33, 26, 28, 15, 27, 27, 21, 37, 25, 28, 25, 28, 20, 27, 8],
    },
    week: {
      x: ['2026-07-13T00:00:00Z', '2026-07-20T00:00:00Z', '2026-07-27T00:00:00Z', '2026-08-03T00:00:00Z', '2026-08-10T00:00:00Z', '2026-08-17T00:00:00Z', '2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z', '2026-09-07T00:00:00Z', '2026-09-14T00:00:00Z', '2026-09-21T00:00:00Z', '2026-09-28T00:00:00Z', '2026-10-05T00:00:00Z'],
      labels: ['W29 2026 (from 14 Jul)', 'W30 2026', 'W31 2026', 'W32 2026', 'W33 2026', 'W34 2026', 'W35 2026', 'W36 2026', 'W37 2026', 'W38 2026', 'W39 2026', 'W40 2026', 'W41 2026'],
      in_progress: [false, false, false, false, false, false, false, false, false, false, false, false, true],
      counts: [155, 189, 191, 202, 192, 170, 168, 197, 196, 201, 197, 181, 161],
    },
    month: {
      x: ['2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'],
      labels: ['Jul 2026 (from 14 Jul)', 'Aug 2026', 'Sep 2026', 'Oct 2026'],
      in_progress: [false, false, false, true],
      counts: [477, 813, 837, 273],
    },
  },
  {
    tz: 'Asia/Kolkata',
    now: '2026-10-11T09:30:00+00:00',
    window_start: '2026-07-13T18:30:00+00:00',
    window_end: '2026-10-11T09:30:00+00:00',
    day: {
      x: ['2026-07-13T18:30:00Z', '2026-07-14T18:30:00Z', '2026-07-15T18:30:00Z', '2026-07-16T18:30:00Z', '2026-07-17T18:30:00Z', '2026-07-18T18:30:00Z', '2026-07-19T18:30:00Z', '2026-07-20T18:30:00Z', '2026-07-21T18:30:00Z', '2026-07-22T18:30:00Z', '2026-07-23T18:30:00Z', '2026-07-24T18:30:00Z', '2026-07-25T18:30:00Z', '2026-07-26T18:30:00Z', '2026-07-27T18:30:00Z', '2026-07-28T18:30:00Z', '2026-07-29T18:30:00Z', '2026-07-30T18:30:00Z', '2026-07-31T18:30:00Z', '2026-08-01T18:30:00Z', '2026-08-02T18:30:00Z', '2026-08-03T18:30:00Z', '2026-08-04T18:30:00Z', '2026-08-05T18:30:00Z', '2026-08-06T18:30:00Z', '2026-08-07T18:30:00Z', '2026-08-08T18:30:00Z', '2026-08-09T18:30:00Z', '2026-08-10T18:30:00Z', '2026-08-11T18:30:00Z', '2026-08-12T18:30:00Z', '2026-08-13T18:30:00Z', '2026-08-14T18:30:00Z', '2026-08-15T18:30:00Z', '2026-08-16T18:30:00Z', '2026-08-17T18:30:00Z', '2026-08-18T18:30:00Z', '2026-08-19T18:30:00Z', '2026-08-20T18:30:00Z', '2026-08-21T18:30:00Z', '2026-08-22T18:30:00Z', '2026-08-23T18:30:00Z', '2026-08-24T18:30:00Z', '2026-08-25T18:30:00Z', '2026-08-26T18:30:00Z', '2026-08-27T18:30:00Z', '2026-08-28T18:30:00Z', '2026-08-29T18:30:00Z', '2026-08-30T18:30:00Z', '2026-08-31T18:30:00Z', '2026-09-01T18:30:00Z', '2026-09-02T18:30:00Z', '2026-09-03T18:30:00Z', '2026-09-04T18:30:00Z', '2026-09-05T18:30:00Z', '2026-09-06T18:30:00Z', '2026-09-07T18:30:00Z', '2026-09-08T18:30:00Z', '2026-09-09T18:30:00Z', '2026-09-10T18:30:00Z', '2026-09-11T18:30:00Z', '2026-09-12T18:30:00Z', '2026-09-13T18:30:00Z', '2026-09-14T18:30:00Z', '2026-09-15T18:30:00Z', '2026-09-16T18:30:00Z', '2026-09-17T18:30:00Z', '2026-09-18T18:30:00Z', '2026-09-19T18:30:00Z', '2026-09-20T18:30:00Z', '2026-09-21T18:30:00Z', '2026-09-22T18:30:00Z', '2026-09-23T18:30:00Z', '2026-09-24T18:30:00Z', '2026-09-25T18:30:00Z', '2026-09-26T18:30:00Z', '2026-09-27T18:30:00Z', '2026-09-28T18:30:00Z', '2026-09-29T18:30:00Z', '2026-09-30T18:30:00Z', '2026-10-01T18:30:00Z', '2026-10-02T18:30:00Z', '2026-10-03T18:30:00Z', '2026-10-04T18:30:00Z', '2026-10-05T18:30:00Z', '2026-10-06T18:30:00Z', '2026-10-07T18:30:00Z', '2026-10-08T18:30:00Z', '2026-10-09T18:30:00Z', '2026-10-10T18:30:00Z'],
      labels: ['14 Jul 2026', '15 Jul 2026', '16 Jul 2026', '17 Jul 2026', '18 Jul 2026', '19 Jul 2026', '20 Jul 2026', '21 Jul 2026', '22 Jul 2026', '23 Jul 2026', '24 Jul 2026', '25 Jul 2026', '26 Jul 2026', '27 Jul 2026', '28 Jul 2026', '29 Jul 2026', '30 Jul 2026', '31 Jul 2026', '1 Aug 2026', '2 Aug 2026', '3 Aug 2026', '4 Aug 2026', '5 Aug 2026', '6 Aug 2026', '7 Aug 2026', '8 Aug 2026', '9 Aug 2026', '10 Aug 2026', '11 Aug 2026', '12 Aug 2026', '13 Aug 2026', '14 Aug 2026', '15 Aug 2026', '16 Aug 2026', '17 Aug 2026', '18 Aug 2026', '19 Aug 2026', '20 Aug 2026', '21 Aug 2026', '22 Aug 2026', '23 Aug 2026', '24 Aug 2026', '25 Aug 2026', '26 Aug 2026', '27 Aug 2026', '28 Aug 2026', '29 Aug 2026', '30 Aug 2026', '31 Aug 2026', '1 Sep 2026', '2 Sep 2026', '3 Sep 2026', '4 Sep 2026', '5 Sep 2026', '6 Sep 2026', '7 Sep 2026', '8 Sep 2026', '9 Sep 2026', '10 Sep 2026', '11 Sep 2026', '12 Sep 2026', '13 Sep 2026', '14 Sep 2026', '15 Sep 2026', '16 Sep 2026', '17 Sep 2026', '18 Sep 2026', '19 Sep 2026', '20 Sep 2026', '21 Sep 2026', '22 Sep 2026', '23 Sep 2026', '24 Sep 2026', '25 Sep 2026', '26 Sep 2026', '27 Sep 2026', '28 Sep 2026', '29 Sep 2026', '30 Sep 2026', '1 Oct 2026', '2 Oct 2026', '3 Oct 2026', '4 Oct 2026', '5 Oct 2026', '6 Oct 2026', '7 Oct 2026', '8 Oct 2026', '9 Oct 2026', '10 Oct 2026', '11 Oct 2026'],
      in_progress: [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, true],
      counts: [20, 28, 30, 27, 25, 25, 30, 19, 31, 25, 26, 34, 22, 36, 24, 22, 24, 29, 23, 34, 22, 31, 40, 30, 22, 31, 27, 23, 22, 22, 19, 28, 32, 45, 19, 27, 20, 27, 24, 26, 25, 25, 32, 25, 25, 22, 24, 16, 22, 34, 28, 26, 28, 32, 27, 25, 30, 28, 28, 26, 25, 32, 24, 25, 19, 38, 49, 30, 17, 24, 31, 31, 24, 25, 27, 35, 25, 28, 17, 19, 29, 26, 29, 27, 32, 24, 25, 25, 23, 16],
    },
    week: {
      x: ['2026-07-12T18:30:00Z', '2026-07-19T18:30:00Z', '2026-07-26T18:30:00Z', '2026-08-02T18:30:00Z', '2026-08-09T18:30:00Z', '2026-08-16T18:30:00Z', '2026-08-23T18:30:00Z', '2026-08-30T18:30:00Z', '2026-09-06T18:30:00Z', '2026-09-13T18:30:00Z', '2026-09-20T18:30:00Z', '2026-09-27T18:30:00Z', '2026-10-04T18:30:00Z'],
      labels: ['W29 2026 (from 14 Jul)', 'W30 2026', 'W31 2026', 'W32 2026', 'W33 2026', 'W34 2026', 'W35 2026', 'W36 2026', 'W37 2026', 'W38 2026', 'W39 2026', 'W40 2026', 'W41 2026'],
      in_progress: [false, false, false, false, false, false, false, false, false, false, false, false, true],
      counts: [155, 187, 192, 203, 191, 168, 169, 197, 194, 202, 197, 173, 172],
    },
    month: {
      x: ['2026-06-30T18:30:00Z', '2026-07-31T18:30:00Z', '2026-08-31T18:30:00Z', '2026-09-30T18:30:00Z'],
      labels: ['Jul 2026 (from 14 Jul)', 'Aug 2026', 'Sep 2026', 'Oct 2026'],
      in_progress: [false, false, false, true],
      counts: [477, 810, 838, 275],
    },
  },
  {
    tz: 'America/New_York',
    now: '2026-11-20T15:00:00+00:00',
    window_start: '2026-08-23T04:00:00+00:00',
    window_end: '2026-11-20T15:00:00+00:00',
    day: {
      x: ['2026-08-23T04:00:00Z', '2026-08-24T04:00:00Z', '2026-08-25T04:00:00Z', '2026-08-26T04:00:00Z', '2026-08-27T04:00:00Z', '2026-08-28T04:00:00Z', '2026-08-29T04:00:00Z', '2026-08-30T04:00:00Z', '2026-08-31T04:00:00Z', '2026-09-01T04:00:00Z', '2026-09-02T04:00:00Z', '2026-09-03T04:00:00Z', '2026-09-04T04:00:00Z', '2026-09-05T04:00:00Z', '2026-09-06T04:00:00Z', '2026-09-07T04:00:00Z', '2026-09-08T04:00:00Z', '2026-09-09T04:00:00Z', '2026-09-10T04:00:00Z', '2026-09-11T04:00:00Z', '2026-09-12T04:00:00Z', '2026-09-13T04:00:00Z', '2026-09-14T04:00:00Z', '2026-09-15T04:00:00Z', '2026-09-16T04:00:00Z', '2026-09-17T04:00:00Z', '2026-09-18T04:00:00Z', '2026-09-19T04:00:00Z', '2026-09-20T04:00:00Z', '2026-09-21T04:00:00Z', '2026-09-22T04:00:00Z', '2026-09-23T04:00:00Z', '2026-09-24T04:00:00Z', '2026-09-25T04:00:00Z', '2026-09-26T04:00:00Z', '2026-09-27T04:00:00Z', '2026-09-28T04:00:00Z', '2026-09-29T04:00:00Z', '2026-09-30T04:00:00Z', '2026-10-01T04:00:00Z', '2026-10-02T04:00:00Z', '2026-10-03T04:00:00Z', '2026-10-04T04:00:00Z', '2026-10-05T04:00:00Z', '2026-10-06T04:00:00Z', '2026-10-07T04:00:00Z', '2026-10-08T04:00:00Z', '2026-10-09T04:00:00Z', '2026-10-10T04:00:00Z', '2026-10-11T04:00:00Z', '2026-10-12T04:00:00Z', '2026-10-13T04:00:00Z', '2026-10-14T04:00:00Z', '2026-10-15T04:00:00Z', '2026-10-16T04:00:00Z', '2026-10-17T04:00:00Z', '2026-10-18T04:00:00Z', '2026-10-19T04:00:00Z', '2026-10-20T04:00:00Z', '2026-10-21T04:00:00Z', '2026-10-22T04:00:00Z', '2026-10-23T04:00:00Z', '2026-10-24T04:00:00Z', '2026-10-25T04:00:00Z', '2026-10-26T04:00:00Z', '2026-10-27T04:00:00Z', '2026-10-28T04:00:00Z', '2026-10-29T04:00:00Z', '2026-10-30T04:00:00Z', '2026-10-31T04:00:00Z', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', '2026-11-03T05:00:00Z', '2026-11-04T05:00:00Z', '2026-11-05T05:00:00Z', '2026-11-06T05:00:00Z', '2026-11-07T05:00:00Z', '2026-11-08T05:00:00Z', '2026-11-09T05:00:00Z', '2026-11-10T05:00:00Z', '2026-11-11T05:00:00Z', '2026-11-12T05:00:00Z', '2026-11-13T05:00:00Z', '2026-11-14T05:00:00Z', '2026-11-15T05:00:00Z', '2026-11-16T05:00:00Z', '2026-11-17T05:00:00Z', '2026-11-18T05:00:00Z', '2026-11-19T05:00:00Z', '2026-11-20T05:00:00Z'],
      labels: ['23 Aug 2026', '24 Aug 2026', '25 Aug 2026', '26 Aug 2026', '27 Aug 2026', '28 Aug 2026', '29 Aug 2026', '30 Aug 2026', '31 Aug 2026', '1 Sep 2026', '2 Sep 2026', '3 Sep 2026', '4 Sep 2026', '5 Sep 2026', '6 Sep 2026', '7 Sep 2026', '8 Sep 2026', '9 Sep 2026', '10 Sep 2026', '11 Sep 2026', '12 Sep 2026', '13 Sep 2026', '14 Sep 2026', '15 Sep 2026', '16 Sep 2026', '17 Sep 2026', '18 Sep 2026', '19 Sep 2026', '20 Sep 2026', '21 Sep 2026', '22 Sep 2026', '23 Sep 2026', '24 Sep 2026', '25 Sep 2026', '26 Sep 2026', '27 Sep 2026', '28 Sep 2026', '29 Sep 2026', '30 Sep 2026', '1 Oct 2026', '2 Oct 2026', '3 Oct 2026', '4 Oct 2026', '5 Oct 2026', '6 Oct 2026', '7 Oct 2026', '8 Oct 2026', '9 Oct 2026', '10 Oct 2026', '11 Oct 2026', '12 Oct 2026', '13 Oct 2026', '14 Oct 2026', '15 Oct 2026', '16 Oct 2026', '17 Oct 2026', '18 Oct 2026', '19 Oct 2026', '20 Oct 2026', '21 Oct 2026', '22 Oct 2026', '23 Oct 2026', '24 Oct 2026', '25 Oct 2026', '26 Oct 2026', '27 Oct 2026', '28 Oct 2026', '29 Oct 2026', '30 Oct 2026', '31 Oct 2026', '1 Nov 2026', '2 Nov 2026', '3 Nov 2026', '4 Nov 2026', '5 Nov 2026', '6 Nov 2026', '7 Nov 2026', '8 Nov 2026', '9 Nov 2026', '10 Nov 2026', '11 Nov 2026', '12 Nov 2026', '13 Nov 2026', '14 Nov 2026', '15 Nov 2026', '16 Nov 2026', '17 Nov 2026', '18 Nov 2026', '19 Nov 2026', '20 Nov 2026'],
      in_progress: [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, true],
      counts: [20, 28, 30, 27, 25, 25, 30, 20, 30, 25, 26, 34, 22, 37, 24, 21, 25, 28, 23, 35, 21, 34, 39, 28, 22, 32, 26, 24, 23, 21, 18, 29, 34, 43, 19, 28, 21, 26, 22, 26, 28, 24, 32, 24, 26, 25, 21, 16, 23, 33, 29, 25, 27, 33, 27, 24, 31, 26, 32, 23, 27, 31, 25, 23, 22, 39, 51, 25, 18, 24, 29, 34, 22, 26, 29, 33, 26, 28, 15, 26, 28, 21, 37, 24, 27, 27, 26, 22, 25, 10],
    },
    week: {
      x: ['2026-08-17T04:00:00Z', '2026-08-24T04:00:00Z', '2026-08-31T04:00:00Z', '2026-09-07T04:00:00Z', '2026-09-14T04:00:00Z', '2026-09-21T04:00:00Z', '2026-09-28T04:00:00Z', '2026-10-05T04:00:00Z', '2026-10-12T04:00:00Z', '2026-10-19T04:00:00Z', '2026-10-26T04:00:00Z', '2026-11-02T05:00:00Z', '2026-11-09T05:00:00Z', '2026-11-16T05:00:00Z'],
      labels: ['W34 2026 (from 23 Aug)', 'W35 2026', 'W36 2026', 'W37 2026', 'W38 2026', 'W39 2026', 'W40 2026', 'W41 2026', 'W42 2026', 'W43 2026', 'W44 2026', 'W45 2026', 'W46 2026', 'W47 2026'],
      in_progress: [false, false, false, false, false, false, false, false, false, false, false, false, false, true],
      counts: [20, 185, 198, 187, 194, 192, 179, 168, 196, 187, 208, 198, 178, 110],
    },
    month: {
      x: ['2026-08-01T04:00:00Z', '2026-09-01T04:00:00Z', '2026-10-01T04:00:00Z', '2026-11-01T04:00:00Z'],
      labels: ['Aug 2026 (from 23 Aug)', 'Sep 2026', 'Oct 2026', 'Nov 2026'],
      in_progress: [false, false, false, true],
      counts: [235, 810, 840, 515],
    },
  },
];
