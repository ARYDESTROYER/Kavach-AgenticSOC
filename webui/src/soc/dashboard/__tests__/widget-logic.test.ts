/**
 * Round-6 dashboard-core widget-logic regression tests (pure).
 *
 * The "Autonomous vs human" donut has been wrong twice:
 *   (a) it double-counted the human arc by summing OVERLAPPING escalated + needs_human
 *       tallies (which also include OPEN cases), and painted both arcs the same color
 *       (semanticColor() cannot resolve the token names 'success'/'warning');
 *   (b) the fix for (a) computed `human = terminal − auto_closed`, which
 *       `engine/metrics.py` explicitly forbids: the difference absorbs the
 *       SYSTEM/legacy residual (deterministic routing plus older records that never
 *       recorded a decider) into the analyst band and LABELS it "Human-handled", so
 *       the over-statement is invisible.
 *
 * `autonomySegments` now reads the server's three keys — auto + human + system, which
 * sum to terminal exactly — or renders nothing at all.
 */
import { describe, it, expect } from 'vitest';
import {
  autonomySegments,
  autonomyEmptyMessage,
  closeAttributionState,
  hasCloseAttribution,
} from '@/soc/dashboard/widgets/mix';
import { token } from '@/soc/components/palette';

describe('autonomySegments — the three-way close-attribution split', () => {
  it('renders THREE arcs from the server keys, never `terminal − auto`', () => {
    // terminal 10 = auto 6 + human 3 + system 1. The old `terminal − auto` shortcut
    // would have printed a human arc of 4 — the residual folded into analyst work.
    const out = autonomySegments({
      terminal_cases: 10,
      auto_closed_cases: 6,
      human_closed_cases: 3,
      system_closed_cases: 1,
    });
    const byLabel = Object.fromEntries(out.map((s) => [s.label, s.value]));
    expect(out).toHaveLength(3);
    expect(byLabel['AI agent']).toBe(6);
    expect(byLabel['Human']).toBe(3);
    expect(byLabel['System']).toBe(1);
    expect(byLabel['Human']).not.toBe(4);
    // Centre total == resolved (terminal), exactly.
    expect(out.reduce((a, s) => a + s.value, 0)).toBe(10);
  });

  it('keeps a ZERO residual in the partition (the donut drops empty arcs itself)', () => {
    const out = autonomySegments({
      terminal_cases: 8,
      auto_closed_cases: 6,
      human_closed_cases: 2,
      system_closed_cases: 0,
    });
    expect(out.map((s) => s.label)).toEqual(['AI agent', 'Human', 'System']);
    expect(out[2].value).toBe(0);
    expect(out.reduce((a, s) => a + s.value, 0)).toBe(8);
  });

  it('paints the three arcs DISTINCT colourblind-safe categorical tokens', () => {
    // Identity-arbitrary series: an "AI vs human" split must not borrow the red/green
    // severity axis. These are the same three the HumanVsAiCard chart uses.
    const out = autonomySegments({
      terminal_cases: 10,
      auto_closed_cases: 4,
      human_closed_cases: 4,
      system_closed_cases: 2,
    });
    expect(out[0].color).toBe(token('chart-1'));
    expect(out[1].color).toBe(token('chart-2'));
    expect(out[2].color).toBe(token('chart-8'));
    expect(new Set(out.map((s) => s.color)).size).toBe(3);
  });

  it('refuses a payload whose bands do not reconcile with the terminal total', () => {
    // Not a partition → not renderable as one. Three plausible numbers that do not add
    // up are worse than an honest blank.
    expect(
      autonomySegments({
        terminal_cases: 10,
        auto_closed_cases: 6,
        human_closed_cases: 3,
        system_closed_cases: 3,
      }),
    ).toEqual([]);
  });

  it('renders nothing when the backend reports only part of the partition', () => {
    // An older backend omits human/system. Their absence means "not reported", never
    // zero — so the widget must not infer the analyst band from the difference.
    expect(autonomySegments({ terminal_cases: 10, auto_closed_cases: 7 })).toEqual([]);
    expect(
      autonomySegments({ terminal_cases: 10, auto_closed_cases: 7, human_closed_cases: 3 }),
    ).toEqual([]);
  });

  it('returns no segments when there is no quality data or nothing closed', () => {
    expect(autonomySegments(null)).toEqual([]);
    expect(autonomySegments(undefined)).toEqual([]);
    expect(autonomySegments({})).toEqual([]);
    expect(
      autonomySegments({
        terminal_cases: 0,
        auto_closed_cases: 0,
        human_closed_cases: 0,
        system_closed_cases: 0,
      }),
    ).toEqual([]);
  });
});

describe('hasCloseAttribution / autonomyEmptyMessage — naming the right absence', () => {
  it('separates "reported" from "not reported"', () => {
    expect(hasCloseAttribution(null)).toBe(false);
    expect(hasCloseAttribution({ terminal_cases: 10, auto_closed_cases: 7 })).toBe(false);
    expect(
      hasCloseAttribution({
        terminal_cases: 10,
        auto_closed_cases: 6,
        human_closed_cases: 3,
        system_closed_cases: 1,
      }),
    ).toBe(true);
  });

  it('says WHICH kind of absence it is, instead of always "no resolved cases"', () => {
    const opts = { loading: false, failed: false };
    // Nothing closed in the window — a measurement.
    expect(
      autonomyEmptyMessage(
        { terminal_cases: 0, auto_closed_cases: 0, human_closed_cases: 0, system_closed_cases: 0 },
        0,
        opts,
      ),
    ).toBe('No resolved cases in this window.');
    // The backend does not report the partition — NOT a measurement.
    expect(autonomyEmptyMessage({ terminal_cases: 10, auto_closed_cases: 7 }, 0, opts)).toBe(
      'This backend does not report how closed cases were attributed.',
    );
    // Read failed / nothing loaded.
    expect(autonomyEmptyMessage(undefined, 0, { loading: false, failed: true })).toBe(
      'Posture data unavailable',
    );
    expect(autonomyEmptyMessage(undefined, 0, opts)).toBe('Posture data unavailable');
    // Loading, or already rendering arcs → no empty message at all.
    expect(autonomyEmptyMessage(undefined, 0, { loading: true, failed: false })).toBeUndefined();
    expect(autonomyEmptyMessage(null, 3, opts)).toBeUndefined();
  });

  it('never calls a REPORTED but non-reconciling payload "no resolved cases"', () => {
    // The exact fixture `autonomySegments` refuses above: the four keys are all
    // present (so `hasCloseAttribution` is true) but 6 + 3 + 3 ≠ 10. The server said
    // ten cases reached a terminal state; claiming the window closed nothing would
    // publish a measurement of zero off evidence that says otherwise.
    const q = {
      terminal_cases: 10,
      auto_closed_cases: 6,
      human_closed_cases: 3,
      system_closed_cases: 3,
    };
    const opts = { loading: false, failed: false };
    expect(hasCloseAttribution(q)).toBe(true);
    expect(autonomySegments(q)).toEqual([]);
    expect(autonomyEmptyMessage(q, 0, opts)).toBe(
      'Close attribution did not reconcile for this window.',
    );
    // A negative or non-finite band is the same class of defect, not "nothing closed".
    expect(
      autonomyEmptyMessage(
        { terminal_cases: 10, auto_closed_cases: -1, human_closed_cases: 8, system_closed_cases: 3 },
        0,
        opts,
      ),
    ).toBe('Close attribution did not reconcile for this window.');
  });
});

describe('closeAttributionState — one classifier both surfaces consume', () => {
  const opts = { loading: false, failed: false };

  it('names each distinct fact exactly once', () => {
    expect(closeAttributionState(null)).toBe('unreadable');
    expect(closeAttributionState(undefined)).toBe('unreadable');
    expect(closeAttributionState({})).toBe('unreported');
    expect(closeAttributionState({ terminal_cases: 10, auto_closed_cases: 7 })).toBe('unreported');
    expect(
      closeAttributionState({
        terminal_cases: 10,
        auto_closed_cases: 6,
        human_closed_cases: 3,
        system_closed_cases: 3,
      }),
    ).toBe('unreconciled');
    expect(
      closeAttributionState({
        terminal_cases: 0,
        auto_closed_cases: 0,
        human_closed_cases: 0,
        system_closed_cases: 0,
      }),
    ).toBe('empty');
    expect(
      closeAttributionState({
        terminal_cases: 10,
        auto_closed_cases: 6,
        human_closed_cases: 3,
        system_closed_cases: 1,
      }),
    ).toBe('ok');
  });

  it('keeps the donut and its empty line in agreement for every state', () => {
    // The defect this classifier exists to prevent: arcs and message disagreeing about
    // WHICH absence occurred. Arcs render only on 'ok'; every other state must yield a
    // message, and 'ok' must yield none.
    const fixtures: Array<[string, Parameters<typeof closeAttributionState>[0]]> = [
      ['unreadable', null],
      ['unreported', { terminal_cases: 10, auto_closed_cases: 7 }],
      [
        'unreconciled',
        { terminal_cases: 10, auto_closed_cases: 6, human_closed_cases: 3, system_closed_cases: 3 },
      ],
      [
        'empty',
        { terminal_cases: 0, auto_closed_cases: 0, human_closed_cases: 0, system_closed_cases: 0 },
      ],
      [
        'ok',
        { terminal_cases: 10, auto_closed_cases: 6, human_closed_cases: 3, system_closed_cases: 1 },
      ],
    ];
    for (const [expected, q] of fixtures) {
      const state = closeAttributionState(q);
      expect(state).toBe(expected);
      const segs = autonomySegments(q);
      const msg = autonomyEmptyMessage(q, segs.length, opts);
      if (state === 'ok') {
        expect(segs).toHaveLength(3);
        expect(msg).toBeUndefined();
      } else {
        expect(segs).toEqual([]);
        expect(typeof msg).toBe('string');
      }
    }
  });
});
