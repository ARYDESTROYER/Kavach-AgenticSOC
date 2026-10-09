/**
 * NDJSON reader edge cases (SPEC §6.2/§6.4): partial lines across chunks, UTF-8
 * characters split across chunk boundaries, CRLF, malformed and unknown lines, the
 * first terminal event wins, "ended without turn.done", a broken connection, abort,
 * the line-size bound and a body without a stream.
 */
import { describe, expect, it } from 'vitest';

import { MAX_NDJSON_LINE_CHARS, NdjsonLineSplitter, readChatStream } from '../ndjson';
import type { ChatStreamEvent } from '../stream-events';

const encoder = new TextEncoder();

const START = JSON.stringify({
  type: 'turn.start',
  turn_id: 'turn-1',
  conversation_id: null,
  model: 'demo-model',
  stream_mode: 'steps',
  replayed: false,
  estimate: { prompt_tokens: 120 },
});
const DONE = JSON.stringify({ type: 'turn.done', response: { answer: 'All quiet.', usage: null } });
const ERROR = JSON.stringify({ type: 'turn.error', code: 'provider_unavailable', message: 'No model', retryable: true });
const DELTA = (text: string) => JSON.stringify({ type: 'text.delta', text });

/** A Response whose body yields exactly these chunks (strings are UTF-8 encoded). */
function chunkedResponse(chunks: Array<string | Uint8Array>, options: { failAfter?: boolean } = {}): Response {
  // Pull-based, one chunk per read, so a failure arrives AFTER the delivered chunks
  // (erroring in `start` would discard the queued ones).
  let next = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) {
        const chunk = chunks[next++];
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      } else if (options.failAfter) {
        controller.error(new TypeError('network error'));
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

/** A Response whose stream stays open until the test pushes / closes it. */
function controlledResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    wasCancelled: () => cancelled,
  };
}

async function collect(response: Response, options: Parameters<typeof readChatStream>[1] = {}) {
  const events: ChatStreamEvent[] = [];
  const outcome = await readChatStream(response, { ...options, onEvent: (event) => events.push(event) });
  return { events, outcome };
}

describe('NdjsonLineSplitter', () => {
  it('holds a partial line until its newline arrives and drops a trailing CR', () => {
    const splitter = new NdjsonLineSplitter();
    expect(splitter.push('{"a":')).toEqual([]);
    expect(splitter.push('1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(':2}\n\n')).toEqual(['{"b":2}', '']);
    expect(splitter.flush()).toEqual([]);
  });

  it('returns the final unterminated line on flush', () => {
    const splitter = new NdjsonLineSplitter();
    expect(splitter.push('one\ntwo')).toEqual(['one']);
    expect(splitter.flush()).toEqual(['two']);
  });

  it('discards an oversized line (even one spanning chunks) and resumes after it', () => {
    const splitter = new NdjsonLineSplitter(10);
    expect(splitter.push('0123456789ABC')).toEqual([]);
    expect(splitter.push('DEF\nok\n')).toEqual(['ok']);
    expect(splitter.dropped).toBe(1);
    expect(splitter.push('0123456789XYZ\nfine\n')).toEqual(['fine']);
    expect(splitter.dropped).toBe(2);
  });
});

describe('readChatStream', () => {
  it('parses lines split across arbitrary chunk boundaries', async () => {
    const body = `${START}\n${DELTA('Hello')}\n${DONE}\n`;
    const chunks = body.match(/[\s\S]{1,7}/g) as string[];
    const { events, outcome } = await collect(chunkedResponse(chunks));
    expect(events.map((e) => e.type)).toEqual(['turn.start', 'text.delta', 'turn.done']);
    expect(outcome.status).toBe('done');
    expect(outcome.start?.turn_id).toBe('turn-1');
  });

  it('decodes a multi-byte UTF-8 character split between two chunks', async () => {
    const line = encoder.encode(`${DELTA('café 🛡️ naïve')}\n${DONE}\n`);
    // Split inside the 4-byte shield emoji and inside the "é".
    const shield = line.indexOf(0xf0);
    const accent = line.indexOf(0xc3);
    const cuts = [accent + 1, shield + 2].sort((a, b) => a - b);
    const chunks = [line.slice(0, cuts[0]), line.slice(cuts[0], cuts[1]), line.slice(cuts[1])];
    const { events, outcome } = await collect(chunkedResponse(chunks));
    expect(outcome.status).toBe('done');
    const delta = events.find((e) => e.type === 'text.delta');
    // VS16 is display-stripped by the shared sanitiser; the code points survive whole.
    expect(delta && delta.type === 'text.delta' && delta.text).toBe('café 🛡 naïve');
  });

  it('skips malformed, unknown and blank lines and counts the malformed ones', async () => {
    const body = ['not json', '{"type":"mystery"}', '', '[1,2]', START, DONE, ''].join('\n');
    const { events, outcome } = await collect(chunkedResponse([body]));
    expect(events.map((e) => e.type)).toEqual(['turn.start', 'turn.done']);
    expect(outcome.malformed).toBe(3);
  });

  it('stops at the first terminal event and frees the connection', async () => {
    const controlled = controlledResponse();
    const pending = collect(controlled.response);
    controlled.push(`${START}\n${ERROR}\n${DONE}\n`);
    const { events, outcome } = await pending;
    expect(outcome.status).toBe('error');
    expect(events.map((e) => e.type)).toEqual(['turn.start', 'turn.error']);
    expect(controlled.wasCancelled()).toBe(true);
  });

  it('reports a clean end without turn.done as incomplete (eof)', async () => {
    const { outcome } = await collect(chunkedResponse([`${START}\n`, DELTA('partial')]));
    expect(outcome).toMatchObject({ status: 'incomplete', reason: 'eof' });
    expect(outcome.start?.turn_id).toBe('turn-1');
  });

  it('parses a final terminal line that has no trailing newline', async () => {
    const { outcome } = await collect(chunkedResponse([`${START}\n${DONE}`]));
    expect(outcome.status).toBe('done');
  });

  it('reports a broken connection as incomplete (network) after the events it delivered', async () => {
    const { events, outcome } = await collect(chunkedResponse([`${START}\n`], { failAfter: true }));
    expect(events.map((e) => e.type)).toEqual(['turn.start']);
    expect(outcome).toMatchObject({ status: 'incomplete', reason: 'network' });
  });

  it('stops promptly on abort, even while a read is pending', async () => {
    const controlled = controlledResponse();
    const abort = new AbortController();
    const pending = collect(controlled.response, { signal: abort.signal });
    controlled.push(`${START}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    abort.abort();
    const { events, outcome } = await pending;
    expect(outcome.status).toBe('aborted');
    expect(events.map((e) => e.type)).toEqual(['turn.start']);
  });

  it('returns aborted without reading when the signal already fired', async () => {
    const abort = new AbortController();
    abort.abort();
    const { events, outcome } = await collect(chunkedResponse([`${START}\n${DONE}\n`]), { signal: abort.signal });
    expect(outcome.status).toBe('aborted');
    expect(events).toEqual([]);
  });

  it('drops an oversized line and keeps reading', async () => {
    const huge = DELTA('x'.repeat(400));
    const { events, outcome } = await collect(chunkedResponse([`${huge}\n${START}\n${DONE}\n`]), { maxLineChars: 200 });
    expect(events.map((e) => e.type)).toEqual(['turn.start', 'turn.done']);
    expect(outcome.malformed).toBe(1);
    expect(MAX_NDJSON_LINE_CHARS).toBeGreaterThan(1_000_000);
  });

  it('reads a body without a readable stream through text()', async () => {
    const fake = { body: null, text: async () => `${START}\n${DONE}\n` } as unknown as Response;
    const { events, outcome } = await collect(fake);
    expect(outcome.status).toBe('done');
    expect(events).toHaveLength(2);
  });

  it('display-sanitises streamed strings (bidi controls never reach the UI)', async () => {
    const { events } = await collect(chunkedResponse([`${DELTA('safe‮txt.exe')}\n${DONE}\n`]));
    const delta = events[0];
    expect(delta.type === 'text.delta' && delta.text).toBe('safetxt.exe');
  });
});
