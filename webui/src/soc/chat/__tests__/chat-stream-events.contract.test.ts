/**
 * Chat wire contract (chat revamp SPEC §3, §6.2): the client enums, fallbacks and
 * limits EXACTLY equal the committed `chat-stream-events.contract.json`, the same
 * file the backend test (`backend/tests/test_chat_contracts.py`) pins
 * `chat_events.py` + `models.py` to. A one-sided enum change fails CI on whichever
 * side forgot to update.
 */
import { describe, expect, it } from 'vitest';

import contract from '@/soc/chat/chat-stream-events.contract.json';
import {
  CHAT_ANSWER_KINDS,
  CHAT_BUDGET_STATES,
  CHAT_CITATION_KINDS,
  CHAT_LIMITS,
  CHAT_ORIGINS,
  CHAT_SCOPES,
  CHAT_STEP_BASES,
  CHAT_STEP_KINDS,
  CHAT_STEP_STATUSES,
  CHAT_STREAM_EVENT_TYPES,
  CHAT_STREAM_MODES,
  CHAT_STREAM_PROTOCOL_VERSION,
  MAX_TEXT_DELTA_CHARS,
  MEMORY_PROPOSAL_OPS,
  NDJSON_CONTENT_TYPE,
  PING_INTERVAL_S,
  REPORT_ITEM_KINDS,
  REPORT_TEMPLATES,
  STREAM_FALLBACKS,
  TERMINAL_EVENT_TYPES,
  TEXT_STREAMING_REASONS,
  TURN_ERROR_CODES,
  TURN_NOTICE_KINDS,
} from '@/soc/chat/stream-events';

describe('chat stream-events contract', () => {
  it('pins the transport constants', () => {
    expect(contract.protocol_version).toBe(CHAT_STREAM_PROTOCOL_VERSION);
    expect(contract.ndjson_content_type).toBe(NDJSON_CONTENT_TYPE);
    expect(contract.ping_interval_s).toBe(PING_INTERVAL_S);
    expect(contract.max_text_delta_chars).toBe(MAX_TEXT_DELTA_CHARS);
  });

  it('pins the event types and error codes (ordered)', () => {
    expect([...CHAT_STREAM_EVENT_TYPES]).toEqual(contract.event_types);
    expect([...TERMINAL_EVENT_TYPES].sort()).toEqual([...contract.terminal_event_types].sort());
    expect([...TURN_ERROR_CODES]).toEqual(contract.turn_error_codes);
  });

  it.each([
    ['stream_modes', CHAT_STREAM_MODES],
    ['origins', CHAT_ORIGINS],
    ['scopes', CHAT_SCOPES],
    ['step_kinds', CHAT_STEP_KINDS],
    ['step_statuses', CHAT_STEP_STATUSES],
    ['step_bases', CHAT_STEP_BASES],
    ['answer_kinds', CHAT_ANSWER_KINDS],
    ['notice_kinds', TURN_NOTICE_KINDS],
    ['citation_kinds', CHAT_CITATION_KINDS],
    ['memory_proposal_ops', MEMORY_PROPOSAL_OPS],
    ['budget_states', CHAT_BUDGET_STATES],
    ['text_streaming_reasons', TEXT_STREAMING_REASONS],
    ['report_templates', REPORT_TEMPLATES],
    ['report_item_kinds', REPORT_ITEM_KINDS],
  ] as const)('pins %s', (key, values) => {
    expect([...values]).toEqual((contract as unknown as Record<string, string[]>)[key]);
  });

  it('pins the drift fallbacks and display limits', () => {
    expect(STREAM_FALLBACKS).toEqual(contract.fallbacks);
    expect(CHAT_LIMITS).toEqual(contract.limits);
  });
});
