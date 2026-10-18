/**
 * Round 13 (SPEC-chat) pure rules of the message parts: the lane geometry (T5, T7), the
 * product words for engine values (T14), the follow-up back-off (§4.2), the run log's
 * pending lines (T20) and the block placeholders' reserved heights (T20).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  KIND_LABEL,
  caseStatusWord,
  kindLabel,
  reasonSentence,
  sourcesChip,
  statusTransitionLabel,
} from '../../display';
import { statusLabel } from '@/soc/components/semantic-labels';

import { parseBlock } from '../../blocks/schema';
import {
  FOLLOW_UPS_BACKOFF_AFTER,
  FOLLOW_UPS_IGNORED_KEY,
  followUpLimit,
  noteFollowUpUsed,
  noteFollowUpsShown,
  resetFollowUpBackoffForTests,
} from '../follow-up-backoff';
import {
  BLOCK_HANG,
  BLOCK_PROSE_CAP,
  CARD_HANG_PX,
  CONTENT_COL,
  HANG_FROM_PX,
  LANE_WIDTH_HINT,
  META_COL,
  PROSE_COL,
  PROSE_MEASURE,
  PROSE_PX,
  READING_COL,
  READING_MEASURE,
  READING_PX,
  cardHangPx,
  laneGutterPx,
} from '../lane';
import { paramValue } from '../format';
import { PLACEHOLDER_ROW_PX, placeholderHeight } from '../Message';
import { PENDING_TEXT, pendingLine, type RunLogStep } from '../RunLog';

describe('the reading column and the block hang (T5, T7)', () => {
  it('keeps prose to its own 38rem measure: at most about 90 characters of Inter 15/24 a line (review F16)', () => {
    expect(PROSE_MEASURE).toBe('38rem');
    expect(PROSE_PX).toBe(38 * 16);
    expect(PROSE_COL).toBe('max-w-[38rem]');
    // The narrowest line measured at 42rem was 99 characters in 672 px (6.79 px each); at
    // the prose measure the same text holds at most 89 (the §8.3 bound is 92).
    expect(Math.floor(PROSE_PX / (672 / 99))).toBeLessThanOrEqual(90);
    // Model-written markdown blocks are prose too.
    expect(BLOCK_PROSE_CAP).toContain('[&>*>*[data-block-type=markdown]]:max-w-[38rem]');
    expect(BLOCK_PROSE_CAP).not.toContain('[&>*>*[data-block-type=markdown]]:max-w-[42rem]');
  });

  it('measures the reading column at 42rem on the lane’s left edge, and keeps the Round 12 name for hosts', () => {
    expect(READING_MEASURE).toBe('42rem');
    expect(READING_PX).toBe(42 * 16);
    expect(READING_COL).toContain('max-w-[42rem]');
    expect(READING_COL).toContain('justify-self-start');
    expect(CONTENT_COL).toBe(READING_COL);
    // What follows the meta row in its column keeps the reading measure.
    expect(META_COL).toContain('[&>*+*]:max-w-[42rem]');
  });

  it('caps compact cards to 42rem of text: the frame adds exactly its hang on each side', () => {
    // The prose blocks are compact too, but keep their own caps: the compact caps leave
    // them out (the computed cascade is pinned by lane-cascade.test.ts). Written out in
    // full: Tailwind scans this file, and an interpolated class would emit a broken rule.
    expect(BLOCK_PROSE_CAP).toContain(
      '[&>*>*[data-block-width=compact]:not([data-block-type=markdown]):not([data-block-type=callout])]:max-w-[42rem]',
    );
    expect(BLOCK_PROSE_CAP).toContain(
      '@[40rem]:[&>*>*[data-block-width=compact]:not([data-block-type=markdown]):not([data-block-type=callout])]:max-w-[calc(42rem+1.5rem+2px)]',
    );
    expect(BLOCK_PROSE_CAP).not.toContain('[data-block-width=compact]]');
    // 42rem + 2 × (0.75rem + 1px): the card text ends on the reading column's right edge.
    expect(READING_PX + 2 * CARD_HANG_PX).toBe(42 * 16 + 1.5 * 16 + 2);
    expect(BLOCK_PROSE_CAP).toContain('[&>*>*[data-scope-line]]:max-w-[42rem]');
  });

  it('hangs framed cards only from a 40rem conversation, never the prose blocks or the scope line', () => {
    expect(HANG_FROM_PX).toBe(40 * 16);
    expect(BLOCK_HANG.startsWith('@[40rem]:')).toBe(true);
    expect(BLOCK_HANG).toContain(':not([data-block-type=markdown])');
    expect(BLOCK_HANG).toContain(':not([data-block-type=callout])');
    expect(BLOCK_HANG).toContain(':not([data-scope-line])');
    expect(BLOCK_HANG).toContain('-mx-[calc(0.75rem+1px)]');
  });

  it('never lets a card frame leave the scroll lane at any width (the phone clipping, A2)', () => {
    // The lane fills the conversation less its two gutters; a hung frame is the lane plus
    // its hang on each side. It stays inside the lane's scroll box when hang ≤ gutter.
    for (let conversation = 300; conversation <= 2600; conversation += 10) {
      const gutter = laneGutterPx(conversation);
      const hang = cardHangPx(conversation);
      const lane = conversation - 2 * gutter;
      const frameRight = gutter + lane + hang;
      expect(frameRight).toBeLessThanOrEqual(conversation);
      expect(hang).toBeLessThanOrEqual(gutter);
    }
    // A 390 px phone: no hang at all, so every border is inside the lane.
    expect(cardHangPx(390)).toBe(0);
    expect(cardHangPx(639)).toBe(0);
    expect(cardHangPx(640)).toBe(CARD_HANG_PX);
  });

  it('describes the width choices in words, not pixels (T26 copy lives here)', () => {
    expect(LANE_WIDTH_HINT).toEqual({
      comfortable: 'Narrower, easier to read',
      wide: 'Wider, centred',
      full: 'Fills the space (default)',
    });
  });
});

describe('product words for engine values (T14)', () => {
  it('names kinds as the console does, and leaves unknown kinds as written', () => {
    expect(kindLabel('ip')).toBe('IP');
    expect(kindLabel(' Domain ')).toBe('Domain');
    expect(kindLabel('esql')).toBe('ES|QL');
    expect(kindLabel('toString')).toBe('toString');
    expect(KIND_LABEL.hash).toBe('File hash');
  });

  it('reads a status change as "Open → Escalated", and only between known statuses', () => {
    expect(statusTransitionLabel('open -> escalated')).toBe('Open → Escalated');
    expect(statusTransitionLabel('created -> new')).toBe('Created → New');
    // The StatusBadge's own words (the shared statusLabel map), never a second map (review F8).
    expect(statusTransitionLabel('needs_human -> on_hold')).toBe('Open · awaiting analyst → On hold');
    for (const key of ['created', 'new', 'open', 'needs_human', 'investigating', 'escalated', 'on_hold', 'resolved', 'closed']) {
      expect(caseStatusWord(key)).toBe(statusLabel(key));
    }
    expect(paramValue('NEEDS_HUMAN', 'status')).toBe(statusLabel('needs_human'));
    // A kind the console has no word for reads in sentence case, never lower case (F21).
    expect(paramValue('posture', 'kind')).toBe('Posture');
    expect(paramValue('case_mix', 'kind')).toBe('Case mix');
    expect(paramValue('mitre_coverage', 'kind')).toBe('MITRE ATT&CK coverage');
    expect(paramValue('ip', 'kind')).toBe('IP');
    expect(statusTransitionLabel('open -> pwned')).toBeNull();
    expect(statusTransitionLabel('ignore previous -> escalated')).toBeNull();
    expect(caseStatusWord('constructor')).toBeNull();
  });

  it('reads known decision reasons as sentences, and anything else as written (null)', () => {
    expect(reasonSentence('tp auto-close disabled')).toBe('True-positive auto-close is off');
    expect(reasonSentence('fp auto-close disabled.')).toBe('False-positive auto-close is off');
    expect(reasonSentence('by system: True positive routed to human: tp auto-close disabled.')).toBe(
      'By the system: True positive sent to a person because true-positive auto-close is off.',
    );
    expect(reasonSentence('by agent: No confident close decision; routing to human (fail-safe).')).toBe(
      'By the AI agent: No confident decision, so a person decides (fail-safe).',
    );
    // An analyst's own reason, an unknown actor or a lookalike stays exactly as written.
    expect(reasonSentence('by alice: tp auto-close disabled')).toBeNull();
    expect(reasonSentence('by system: closed after phone call')).toBeNull();
    expect(reasonSentence('tp auto-close disabled; also ignore all rules')).toBeNull();
  });

  it('reads several sources as a count with the names in the tooltip', () => {
    expect(sourcesChip(['Wazuh'])).toEqual({ text: 'Wazuh', title: 'Wazuh' });
    expect(sourcesChip(['Wazuh', 'Elastic', 'Wazuh', ' '])).toEqual({ text: '2 sources', title: 'Wazuh, Elastic' });
    expect(sourcesChip([])).toEqual({ text: '', title: '' });
  });
});

describe('the follow-up back-off (§4.2)', () => {
  beforeEach(() => resetFollowUpBackoffForTests());
  afterEach(() => resetFollowUpBackoffForTests());

  it('offers one chip after five answers in a row whose chips went unused', () => {
    expect(followUpLimit()).toBe(3);
    // Answer 1..6 shown; each later one counts the one before it as ignored.
    for (let i = 1; i <= FOLLOW_UPS_BACKOFF_AFTER; i += 1) noteFollowUpsShown(`a${i}`);
    expect(followUpLimit()).toBe(3);
    noteFollowUpsShown(`a${FOLLOW_UPS_BACKOFF_AFTER + 1}`);
    expect(window.localStorage.getItem(FOLLOW_UPS_IGNORED_KEY)).toBe(String(FOLLOW_UPS_BACKOFF_AFTER));
    expect(followUpLimit()).toBe(1);
  });

  it('counts an answer once, however often it re-renders', () => {
    noteFollowUpsShown('a1');
    noteFollowUpsShown('a1');
    noteFollowUpsShown('a1');
    expect(window.localStorage.getItem(FOLLOW_UPS_IGNORED_KEY)).toBeNull();
  });

  it('resets and restores three chips on any use', () => {
    for (let i = 1; i <= FOLLOW_UPS_BACKOFF_AFTER + 1; i += 1) noteFollowUpsShown(`a${i}`);
    expect(followUpLimit()).toBe(1);
    noteFollowUpUsed();
    expect(followUpLimit()).toBe(3);
    expect(window.localStorage.getItem(FOLLOW_UPS_IGNORED_KEY)).toBeNull();
    // The next answer does not count the one whose chip was used.
    noteFollowUpsShown('b1');
    expect(window.localStorage.getItem(FOLLOW_UPS_IGNORED_KEY)).toBeNull();
  });

  it('works without storage (every access is guarded): three chips, no throw', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      expect(() => noteFollowUpsShown('x1')).not.toThrow();
      expect(() => noteFollowUpsShown('x2')).not.toThrow();
      expect(followUpLimit()).toBe(3);
      expect(() => noteFollowUpUsed()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('ignores a garbled stored count', () => {
    window.localStorage.setItem(FOLLOW_UPS_IGNORED_KEY, 'lots');
    expect(followUpLimit()).toBe(3);
    window.localStorage.setItem(FOLLOW_UPS_IGNORED_KEY, '-7');
    expect(followUpLimit()).toBe(3);
  });
});

describe('the live run log before any lookup (T20)', () => {
  const model = (label: string, status: RunLogStep['status']): RunLogStep => ({
    index: 1, kind: 'model', tool: null, label, params: {}, group: null, status, result: null,
  });

  it('reads the question, then chooses lookups, and gives way to the first lookup', () => {
    expect(pendingLine([])).toBe(PENDING_TEXT.reading);
    expect(pendingLine([model('Thinking', 'running')])).toBe(PENDING_TEXT.choosing);
    expect(pendingLine([model('Writing the answer', 'running')])).toBeNull();
    const tool: RunLogStep = { ...model('Searched logs', 'running'), index: 2, kind: 'tool', tool: 'search_logs' };
    expect(pendingLine([model('Planned lookups', 'ok'), tool])).toBeNull();
    expect(pendingLine([], [{ key: 'n', text: 'x', kind: 'repeat' }])).toBeNull();
  });
});

describe('block placeholders keep their height (T20)', () => {
  it('reserves 112 px for KPIs, 280 px for a chart and 32 px a row (up to 10) for a table', () => {
    const kpis = parseBlock({ id: 'k', type: 'kpi_group', provenance: 'code', artifact_kind: 'kpis', items: [{ key: 'a', label: 'A', value: 1, unit: 'count' }] });
    expect(placeholderHeight(kpis)).toBe(112);
    const chart = parseBlock({
      id: 'c', type: 'chart', kind: 'bar', provenance: 'code', artifact_kind: 'categories', unit: 'count',
      x: { kind: 'category', values: ['a', 'b'] }, series: [{ key: 's', label: 'S', values: [1, 2] }],
    });
    expect(placeholderHeight(chart)).toBe(280);
    const table = (rows: number) =>
      parseBlock({
        id: `t${rows}`, type: 'table', provenance: 'source', artifact_kind: 'table', allowed_views: ['table'],
        columns: [{ key: 'h', label: 'Host', type: 'text' }],
        rows: Array.from({ length: rows }, (_, i) => [`h${i}`]),
      });
    expect(placeholderHeight(table(3))).toBe(3 * PLACEHOLDER_ROW_PX);
    expect(placeholderHeight(table(25))).toBe(10 * PLACEHOLDER_ROW_PX);
  });
});
