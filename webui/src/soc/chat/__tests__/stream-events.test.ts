/**
 * The tolerant NDJSON event parser + lenient ChatResponse normaliser (chat revamp
 * SPEC §6.2, §3.2) and the shared `displayText()` sanitiser (BLOCKS.md amendment 4).
 * Every line from the stream is untrusted: the parser never throws, drops what it
 * cannot use, and sanitises every string a renderer will show.
 */
import { describe, expect, it } from 'vitest';

import {
  CHAT_STREAM_EVENT_TYPES,
  displayText,
  isPing,
  isStepEnd,
  isTerminalEvent,
  isTextDelta,
  isTurnDone,
  isTurnError,
  isTurnStart,
  normaliseChatResponse,
  normaliseChatStep,
  normaliseConsoleLink,
  parseStreamEvent,
  type ChatStreamEvent,
} from '@/soc/chat/stream-events';

const line = (payload: unknown) => JSON.stringify(payload);

const VALID_LINES: Record<string, unknown> = {
  'turn.start': {
    type: 'turn.start',
    turn_id: 'turn-1',
    conversation_id: 'conv-1',
    model: 'gpt',
    stream_mode: 'text',
    replayed: false,
    estimate: { prompt_tokens: 1200 },
  },
  'step.start': {
    type: 'step.start',
    step: { index: 1, ordinal: 1, kind: 'tool', tool: 'log_stats', label: 'Counting logs', params: { from: 'now-24h' }, group: 1 },
  },
  'step.end': {
    type: 'step.end',
    step: { index: 1, ordinal: 1, kind: 'tool', tool: 'log_stats', label: 'Counted logs', params: {}, status: 'ok', duration_ms: 12, summary: '1,284 events' },
  },
  usage: { type: 'usage', totals: { calls: 1, total_tokens: 900, cost: 0.001, simulated: true } },
  'text.delta': { type: 'text.delta', text: 'Top **hosts**\n' },
  'text.reset': { type: 'text.reset' },
  'turn.done': { type: 'turn.done', response: { answer: 'done', blocks: [{ type: 'markdown' }] } },
  'turn.error': { type: 'turn.error', code: 'budget_blocked', message: 'Budget reached', retryable: false, notice: null },
  ping: { type: 'ping' },
};

describe('parseStreamEvent', () => {
  it('parses every event type and the guards narrow them', () => {
    expect(Object.keys(VALID_LINES).sort()).toEqual([...CHAT_STREAM_EVENT_TYPES].sort());
    const events = Object.values(VALID_LINES).map((p) => parseStreamEvent(line(p)));
    expect(events.every((e) => e !== null)).toBe(true);
    const parsed = events as ChatStreamEvent[];
    expect(parsed.map((e) => e.type)).toEqual(Object.keys(VALID_LINES));
    expect(parsed.filter(isTerminalEvent).map((e) => e.type)).toEqual(['turn.done', 'turn.error']);
    const start = parsed.find(isTurnStart);
    expect(start?.estimate.prompt_tokens).toBe(1200);
    expect(start?.stream_mode).toBe('text');
    expect(parsed.find(isTextDelta)?.text).toBe('Top **hosts**\n');
    expect(parsed.find(isStepEnd)?.step.summary).toBe('1,284 events');
    expect(parsed.some(isPing)).toBe(true);
    const done = parsed.find(isTurnDone);
    expect(done?.response.answer).toBe('done');
    // blocks stay raw for parseBlocks() (lazy chunk)
    expect(done?.response.blocks).toEqual([{ type: 'markdown' }]);
  });

  it.each([
    '',
    '   ',
    'not json',
    '[]',
    'null',
    '42',
    '{"type":"nope"}',
    '{"type":"turn.start"}', // no turn_id
    '{"type":"step.end","step":{"label":"x"}}', // no index
    '{"type":"text.delta","text":7}',
    '{"type":"turn.done","response":{"blocks":[]}}', // no answer
    '{"type":"usage","totals":"x"}',
    '{"type":"step.start","step":"x"}',
  ])('drops a malformed line: %j', (raw) => {
    expect(parseStreamEvent(raw)).toBeNull();
  });

  it('never throws on any input type', () => {
    for (const raw of [undefined, null, 1, {}, [], () => 1, Symbol('x'), '{"type":'] as unknown[]) {
      expect(() => parseStreamEvent(raw)).not.toThrow();
      expect(parseStreamEvent(raw)).toBeNull();
    }
  });

  it('coerces drifted enums to their fallbacks and sanitises strings', () => {
    const start = parseStreamEvent(line({ type: 'turn.start', turn_id: 't', stream_mode: 'fast', estimate: 'x' }));
    expect(start).toMatchObject({ stream_mode: 'steps', replayed: false, estimate: { prompt_tokens: 0 } });
    const err = parseStreamEvent(line({ type: 'turn.error', code: 'kaboom', message: 'boom\n‮again', retryable: 'yes' }));
    expect(err && isTurnError(err) ? err : null).toEqual({
      type: 'turn.error',
      code: 'internal',
      message: 'boom again',
      retryable: false,
      notice: null,
    });
    const step = parseStreamEvent(
      line({ type: 'step.start', step: { index: 2, kind: 'warp', tool: 'Bad Tool', label: 'Search​ing', params: { 'bad key': 1, ok: { a: 1 }, from: 'now-1h' } } }),
    );
    expect(step).toEqual({
      type: 'step.start',
      step: { index: 2, ordinal: null, kind: 'tool', tool: null, label: 'Searching', params: { from: 'now-1h' }, group: null },
    });
    const delta = parseStreamEvent(line({ type: 'text.delta', text: 'a‮b\nc' }));
    expect(delta).toEqual({ type: 'text.delta', text: 'ab\nc' });
  });
});

describe('normaliseChatStep', () => {
  it('reads an unknown status as a failure and sanitises display fields', () => {
    const step = normaliseChatStep({
      index: 3,
      status: 'exploded',
      label: 'x'.repeat(300),
      params: { n: 3, f: Number.POSITIVE_INFINITY, s: 'v​' },
      untrusted_params: { v: 42 },
      query: 'a\r\nb\u0000',
      basis: 'guess',
      duration_ms: 12.7,
      rows: -1,
      sources: ['Primary', 3, ''],
    });
    expect(step).toMatchObject({
      status: 'error',
      kind: 'tool',
      params: { n: 3, s: 'v' },
      untrusted_params: { v: '42' },
      query: 'a\nb',
      basis: null,
      duration_ms: 12,
      rows: null,
      sources: ['Primary'],
    });
    expect(Array.from(step?.label ?? '').length).toBe(120);
    expect(normaliseChatStep({ label: 'no index' })).toBeNull();
  });
});

describe('normaliseChatResponse', () => {
  it('keeps legacy responses and applies the revamp fallbacks', () => {
    const legacy = normaliseChatResponse({ answer: 'ok', cost: 0.01, query: 'x', table: { columns: ['a'], rows: [[1]] } });
    expect(legacy).toMatchObject({
      answer: 'ok',
      cost: 0.01,
      query: 'x',
      blocks: [],
      steps: [],
      usage: null,
      answer_kind: 'conversation',
      stream_mode: null,
      notice: null,
    });
    expect(normaliseChatResponse({ blocks: [] })).toBeNull();
    expect(normaliseChatResponse('x')).toBeNull();
  });

  it('drops invalid sub-items and fails closed', () => {
    const resp = normaliseChatResponse({
      answer: 'x',
      steps: [{ index: 1 }, 'junk', { label: 'no index' }],
      citations: [
        { id: 'D1', kind: 'doc', title: 'Chat', doc: '/docs/0.1/analyst/chat/' },
        { id: 'D2', kind: 'doc', title: 'Bad', doc: 'https://evil.example/' },
        { id: 'C1', kind: 'case', title: 'Missing target' },
        { id: 'M1', kind: 'mitre', title: 'Brute force', technique: 't1110' },
      ],
      console_links: [
        { id: 'settings:sources', label: 'Sources', page: 'settings', opts: { section: 'sources', href: 'x', window: 99999 }, allowed: 'yes' },
        { id: 'BAD', label: 'x', page: 'settings' },
      ],
      follow_ups: ['One\nline', 5, '', 'Two', 'Three', 'Four'],
      answer_kind: 'philosophy',
      notice: { kind: 'meteor', message: 'm', retryable: true },
      memory_proposal: { op: 'remove', text: 'everything' },
      usage: { calls: 2, cost: 0.004, total_tokens: 1000 },
      cost: 9,
    });
    expect(resp?.steps).toHaveLength(1);
    expect(resp?.citations?.map((c) => c.id)).toEqual(['D1', 'M1']);
    expect(resp?.citations?.[1].technique).toBe('T1110');
    expect(resp?.console_links).toEqual([
      { id: 'settings:sources', label: 'Sources', page: 'settings', opts: { section: 'sources' }, allowed: false, requires: null },
    ]);
    expect(resp?.follow_ups).toEqual(['One line', 'Two', 'Three']);
    expect(resp?.answer_kind).toBe('conversation');
    expect(resp?.notice).toEqual({ kind: 'partial', message: 'm', retryable: true });
    expect(resp?.memory_proposal).toBeNull();
    expect(resp?.cost).toBe(0.004); // cost mirrors usage.cost
  });
});

describe('displayText', () => {
  it('strips invisible, bidi and control characters', () => {
    expect(displayText('a‮b​c\u0000d⁦e﻿f­')).toBe('abcdef');
  });

  it('folds line breaks unless multiline, and trims single-line values', () => {
    expect(displayText(' a\nb\tc ')).toBe('a b c');
    expect(displayText('a\r\nb\rc', 0, { multiline: true })).toBe('a\nb\nc');
  });

  it('clamps by code points with an ellipsis', () => {
    expect(displayText('x'.repeat(10), 5)).toBe('xxxx…');
    expect(displayText('🔐🔐🔐', 2)).toBe('🔐…');
    expect(displayText('short', 0)).toBe('short');
  });

  it('drops lone surrogates and non-text values', () => {
    expect(displayText('lone \ud800 half')).toBe('lone  half');
    expect(displayText({ a: 1 })).toBe('');
    expect(displayText(null)).toBe('');
    expect(displayText(Number.NaN)).toBe('');
    expect(displayText(3)).toBe('3');
    expect(displayText(true)).toBe('true');
  });

  it('never linkifies or interprets markup', () => {
    expect(displayText('<script>alert(1)</script> https://evil.example')).toBe(
      '<script>alert(1)</script> https://evil.example',
    );
  });
});

describe('normaliseChatResponse — every displayed string is sanitised', () => {
  const HOSTILE = 'ok\u202e\u200b\u0007\u{e0041}\ufe0f done';

  it('sanitises the answer exactly like the streamed text it replaces', () => {
    const answer = `Top **hosts**\u202e\n\n- a\u200bb\n- \u{e0049}\u{e0067}c\u0007`;
    const deltas = [answer.slice(0, 9), answer.slice(9)].map((text) => parseStreamEvent(line({ type: 'text.delta', text })));
    const streamed = deltas.map((e) => (e && isTextDelta(e) ? e.text : '')).join('');
    const resp = normaliseChatResponse({ answer });
    expect(resp?.answer).toBe('Top **hosts**\n\n- ab\n- c');
    expect(resp?.answer).toBe(streamed);
    // Prose is not clamped to a label length.
    expect(normaliseChatResponse({ answer: 'x'.repeat(20_000) })?.answer).toHaveLength(20_000);
  });

  it('sanitises the pre-revamp scalars and memory echoes', () => {
    const resp = normaliseChatResponse({
      answer: 'a',
      conversation_title: `Title ${HOSTILE}\nsecond line`,
      effective_model: `gpt${HOSTILE}`,
      effective_source_name: `Primary${HOSTILE}`,
      effective_source_id: `src-a${HOSTILE}`,
      query: `source.ip: *${HOSTILE}\nAND x`,
      case_id: 'case-1\u202e',
      idempotency_key: 'k'.repeat(300),
      memory_suggestion: { text: `Remember${HOSTILE}`, reason: { nested: true } },
      memory_action: { op: 'add', text: `Fact${HOSTILE}`, ids: ['m-1', 'bad id', 3] },
    });
    expect(resp?.conversation_title).toBe('Title ok done second line');
    expect(resp?.effective_model).toBe('gptok done');
    expect(resp?.effective_source_name).toBe('Primaryok done');
    expect(resp?.effective_source_id).toBe('src-aok done');
    expect(resp?.query).toBe('source.ip: *ok done\nAND x');
    expect(resp?.case_id).toBeNull();
    expect(resp?.idempotency_key).toBeNull();
    expect(resp?.memory_suggestion).toEqual({ text: 'Rememberok done' });
    expect(resp?.memory_action).toEqual({ op: 'add', text: 'Factok done', ids: ['m-1'] });
    // Absent fields stay absent; a missing memory text drops the echo.
    const bare = normaliseChatResponse({ answer: 'a', memory_suggestion: { text: '\u200b' } });
    expect(bare && 'conversation_title' in bare).toBe(false);
    expect(bare?.memory_suggestion).toBeNull();
  });
});

describe('normaliseConsoleLink — the same guards as a block ref', () => {
  const link = (page: string, opts: Record<string, unknown> = {}) =>
    normaliseConsoleLink({ id: 'cases:queue', label: 'Cases', page, opts, allowed: true });

  it('drops a link to a page the router does not know', () => {
    expect(link('cases')).not.toBeNull();
    expect(link('teleporter')).toBeNull();
  });

  it('keeps only enum-valid status and severity options, one by one', () => {
    expect(link('cases', { status: 'escalated', severity: 'high', tab: 'queue' })?.opts).toEqual({
      status: 'escalated',
      severity: 'high',
      tab: 'queue',
    });
    expect(link('cases', { status: 'teleported', severity: 'apocalyptic', tab: 'queue' })?.opts).toEqual({ tab: 'queue' });
    expect(link('cases', { severity: 'HIGH', status: 'Escalated' })?.opts).toEqual({});
  });
});

describe('displayText — the extended invisible set', () => {
  it('strips tag characters, variation selectors and fillers', () => {
    expect(displayText('a\u{e0041}\u{e0042}b\ufe0fc\u3164d\u034fe\u{e0100}f\u{1d173}g', 0)).toBe('abcdefg');
  });

  it('leaves neighbouring visible code points alone', () => {
    expect(displayText('\ue000\u{1f510}\u{e1000}0', 0)).toBe('\ue000\u{1f510}\u{e1000}0');
  });
});

