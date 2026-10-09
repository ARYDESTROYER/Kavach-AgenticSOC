/**
 * NDJSON reader for `POST /api/chat/stream` (chat revamp SPEC §6.2, §6.4, §10.10).
 *
 * The stream is UNTRUSTED input. This module turns a fetch `Response` body into typed
 * {@link ChatStreamEvent}s and reports how the stream ended:
 *
 *  - bytes are decoded with ONE streaming `TextDecoder`, so a multi-byte UTF-8
 *    character split across network chunks is never mangled;
 *  - lines are split on `\n` (a trailing `\r` is dropped) and a partial line is held
 *    until its newline arrives or the stream ends;
 *  - every line goes through the tolerant `parseStreamEvent` (never throws; blank,
 *    malformed and unknown lines are counted and skipped);
 *  - an oversized line is discarded whole (memory bound) and counted as malformed;
 *  - the first `turn.done` / `turn.error` is terminal: the reader stops there and
 *    releases the connection, whatever follows;
 *  - a stream that ends WITHOUT a terminal event is reported as `incomplete`, which
 *    the engine turns into "Connection lost — checking whether the answer was saved"
 *    and one replay with the same idempotency key;
 *  - an `AbortSignal` stops reading promptly and is reported as `aborted`.
 *
 * Lives in the lazy chat chunk; nothing here is imported by the entry bundle.
 */
import {
  parseStreamEvent,
  type ChatStreamEvent,
  type TurnDoneEvent,
  type TurnErrorEvent,
  type TurnStartEvent,
} from './stream-events';

/**
 * The longest line kept, in UTF-16 code units. A `turn.done` line carries the whole
 * response (blocks ≤ 48 kB plus steps, citations and usage), so this is generous; a
 * longer line is dropped instead of growing memory without bound.
 */
export const MAX_NDJSON_LINE_CHARS = 4 * 1024 * 1024;

/**
 * Incremental line splitter over decoded text. `push` returns the complete lines in a
 * chunk; `flush` returns the final unterminated line (if any). Oversized lines are
 * discarded up to their newline and counted in {@link NdjsonLineSplitter.dropped}.
 */
export class NdjsonLineSplitter {
  private buffer = '';
  private discarding = false;
  /** Lines discarded for exceeding the size bound. */
  dropped = 0;

  constructor(private readonly maxLineChars = MAX_NDJSON_LINE_CHARS) {}

  push(text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline < 0) break;
      const piece = text.slice(start, newline);
      start = newline + 1;
      if (this.discarding) {
        // The tail of an oversized line: skip it, then resume normal splitting.
        this.discarding = false;
        this.buffer = '';
        continue;
      }
      const line = this.buffer + piece;
      this.buffer = '';
      if (line.length > this.maxLineChars) {
        this.dropped += 1;
        continue;
      }
      lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    const rest = text.slice(start);
    if (this.discarding) return lines;
    if (this.buffer.length + rest.length > this.maxLineChars) {
      // Stop buffering: the line can never be kept, so do not hold it in memory.
      this.buffer = '';
      this.discarding = true;
      this.dropped += 1;
      return lines;
    }
    this.buffer += rest;
    return lines;
  }

  /** The final line when the stream ends without a trailing newline. */
  flush(): string[] {
    const line = this.discarding ? '' : this.buffer;
    this.buffer = '';
    this.discarding = false;
    if (!line) return [];
    return [line.endsWith('\r') ? line.slice(0, -1) : line];
  }
}

/** How a chat stream ended. */
export type ChatStreamOutcome =
  /** `turn.done` arrived: its `response` is the truth to render. */
  | { status: 'done'; event: TurnDoneEvent; start: TurnStartEvent | null; malformed: number }
  /** `turn.error` arrived: a typed failure (no response). */
  | { status: 'error'; event: TurnErrorEvent; start: TurnStartEvent | null; malformed: number }
  /**
   * The stream ended (or the connection broke) before any terminal event. `reason`
   * is `eof` for a clean end without `turn.done`, `network` when reading threw.
   */
  | { status: 'incomplete'; reason: 'eof' | 'network'; start: TurnStartEvent | null; malformed: number }
  /** The caller's `AbortSignal` fired; nothing more was read. */
  | { status: 'aborted'; start: TurnStartEvent | null; malformed: number };

export interface ReadChatStreamOptions {
  /** Called for every parsed event, in order, including the terminal one. */
  onEvent?: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
  /** Test seam / memory bound; defaults to {@link MAX_NDJSON_LINE_CHARS}. */
  maxLineChars?: number;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * Read a chat NDJSON response to its terminal event. Never throws for stream content
 * or a broken connection (those become an outcome); a throwing `onEvent` callback is
 * the caller's bug and propagates.
 */
export async function readChatStream(
  response: Response,
  options: ReadChatStreamOptions = {},
): Promise<ChatStreamOutcome> {
  const { onEvent, signal } = options;
  const splitter = new NdjsonLineSplitter(options.maxLineChars);
  let start: TurnStartEvent | null = null;
  let malformed = 0;
  let terminal: TurnDoneEvent | TurnErrorEvent | null = null;

  const handle = (lines: string[]): boolean => {
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = parseStreamEvent(line);
      if (!event) {
        malformed += 1;
        continue;
      }
      if (event.type === 'turn.start' && !start) start = event;
      onEvent?.(event);
      if (event.type === 'turn.done' || event.type === 'turn.error') {
        terminal = event;
        return true;
      }
    }
    return false;
  };

  const finish = (): ChatStreamOutcome => {
    const counted = malformed + splitter.dropped;
    const end = terminal as TurnDoneEvent | TurnErrorEvent | null;
    if (end?.type === 'turn.done') return { status: 'done', event: end, start, malformed: counted };
    if (end?.type === 'turn.error') return { status: 'error', event: end, start, malformed: counted };
    return { status: 'incomplete', reason: 'eof', start, malformed: counted };
  };

  if (signal?.aborted) return { status: 'aborted', start, malformed };

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    // No streaming body (an old proxy or test double): read it whole. The events
    // arrive at once, but the outcome rules are identical.
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (isAbortError(error, signal)) return { status: 'aborted', start, malformed };
      return { status: 'incomplete', reason: 'network', start, malformed };
    }
    if (signal?.aborted) return { status: 'aborted', start, malformed };
    if (!handle(splitter.push(text))) handle(splitter.flush());
    return finish();
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  // Abort promptly even while a read is pending (a stalled proxy may never yield).
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (isAbortError(error, signal)) return { status: 'aborted', start, malformed };
        // A broken connection: whatever complete lines arrived were already handled.
        return { status: 'incomplete', reason: 'network', start, malformed: malformed + splitter.dropped };
      }
      if (signal?.aborted) return { status: 'aborted', start, malformed };
      if (chunk.done) {
        const tail = decoder.decode();
        if (!handle(splitter.push(tail))) handle(splitter.flush());
        return finish();
      }
      const value = chunk.value;
      const text = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      if (handle(splitter.push(text))) {
        // Terminal event seen: anything after it is ignored and the connection freed.
        reader.cancel().catch(() => undefined);
        return finish();
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released or the stream was cancelled */
    }
  }
}
