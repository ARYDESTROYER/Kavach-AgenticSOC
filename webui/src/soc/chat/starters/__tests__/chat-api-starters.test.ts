/**
 * The starter endpoints' client (SPEC-chat §3.2.2, §3.8): `GET /api/chat/starters` is
 * normalised so a card is shown and sent EXACTLY as the server worded it or dropped
 * (never cut or altered), display-only cards need a safe reference, the catch-up line
 * keeps only sendable clauses, and `POST /api/chat/starters/events` sends only opaque
 * keys. The `types.ts` mirrors are pinned by these shapes (the backend's own output).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getChatStarters,
  normaliseChatStartersInfo,
  normaliseStarterCard,
  postChatStarterEvent,
} from '../../chat-api';
import { CATCH_UP, CONTINUE, HOME_STARTERS, NEEDS_HUMAN, SAVED_BOOK, json, makeInfo, query, stubStarterFetch } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('normaliseStarterCard', () => {
  it('keeps a server card exactly, every Round 13 field included', () => {
    expect(normaliseStarterCard(NEEDS_HUMAN)).toEqual(NEEDS_HUMAN);
    expect(normaliseStarterCard(CONTINUE)).toEqual(CONTINUE);
    expect(normaliseStarterCard(SAVED_BOOK)).toEqual(SAVED_BOOK);
  });

  it('reads an older payload (no Round 13 fields) as a send card', () => {
    const old = { id: 'posture', label: 'Posture now', description: 'Key metrics', prompt: 'How is our posture right now?', tools: ['soc_metrics'] };
    expect(normaliseStarterCard(old)).toMatchObject({ ...old, action: 'send', urgency: 'none', ref: null, key: null, reason: '' });
  });

  it('drops a question it could not send byte for byte (never cut or altered)', () => {
    const bad = [
      `${NEEDS_HUMAN.prompt}​`, // zero-width space
      `Why does case‮-0042 need a person?`, // bidi override
      'Why does case-0042\nneed a person?',
      ' Why does case-0042 need a person?',
      'Why does case-0042 need a person? ',
      'x'.repeat(401),
      '',
    ];
    for (const prompt of bad) expect(normaliseStarterCard({ ...NEEDS_HUMAN, prompt }), JSON.stringify(prompt)).toBeNull();
  });

  it('drops an unknown action, a malformed id or a malformed reference', () => {
    expect(normaliseStarterCard({ ...NEEDS_HUMAN, action: 'close_case' })).toBeNull();
    expect(normaliseStarterCard({ ...NEEDS_HUMAN, id: 'Needs Human' })).toBeNull();
    expect(normaliseStarterCard({ ...NEEDS_HUMAN, ref: { kind: 'case', value: 'case-0042\n' } })).toBeNull();
    expect(normaliseStarterCard({ ...NEEDS_HUMAN, ref: { kind: 'host', value: 'web-01' } })).toBeNull();
  });

  it('needs a safe conversation or prompt reference on a display-only card', () => {
    expect(normaliseStarterCard({ ...CONTINUE, ref: null })).toBeNull();
    expect(normaliseStarterCard({ ...CONTINUE, ref: { kind: 'case', value: 'case-0042' } })).toBeNull();
    expect(normaliseStarterCard({ ...CONTINUE, ref: { kind: 'conversation', value: '../c-1' } })).toBeNull();
    expect(normaliseStarterCard({ ...SAVED_BOOK, ref: { kind: 'prompt', value: 'x'.repeat(65) } })).toBeNull();
    // Display text is at most 120 characters.
    expect(normaliseStarterCard({ ...CONTINUE, prompt: `Continue: ${'a'.repeat(111)}` })).toBeNull();
  });

  it('keeps only an opaque key and a known urgency', () => {
    expect(normaliseStarterCard({ ...NEEDS_HUMAN, key: 'ABCDEF0123456789' })?.key).toBeNull();
    expect(normaliseStarterCard({ ...NEEDS_HUMAN, key: '3cf51d4967fc61e9\n' })?.key).toBeNull();
    expect(normaliseStarterCard({ ...NEEDS_HUMAN, urgency: 'panic' })?.urgency).toBe('none');
  });
});

describe('normaliseChatStartersInfo', () => {
  it('keeps at most six cards in server order, one per family and per key', () => {
    const info = normaliseChatStartersInfo(
      makeInfo({ starters: [...HOME_STARTERS, { ...NEEDS_HUMAN, key: 'aaaaaaaaaaaaaaaa' }, { ...HOME_STARTERS[1] }] }),
    );
    expect(info.starters.map((s) => s.id)).toEqual(HOME_STARTERS.map((s) => s.id));
  });

  it('keeps only the catch-up clauses it can send, and drops an empty line', () => {
    const withDisplayOnly = { ...CATCH_UP, clauses: [...CATCH_UP.clauses, { text: 'A chat is ready', starter: CONTINUE }] };
    expect(normaliseChatStartersInfo(makeInfo({ catch_up: withDisplayOnly })).catch_up).toEqual(CATCH_UP);
    expect(normaliseChatStartersInfo(makeInfo({ catch_up: { ...CATCH_UP, clauses: [] } })).catch_up).toBeNull();
  });

  it('reads enabled as on unless the server says false, and falls back safely', () => {
    expect(normaliseChatStartersInfo({}).enabled).toBe(true);
    expect(normaliseChatStartersInfo({ enabled: false }).enabled).toBe(false);
    expect(normaliseChatStartersInfo(null, 'case')).toMatchObject({ surface: 'case', starters: [], catch_up: null, timezone: 'UTC' });
  });
});

describe('getChatStarters / postChatStarterEvent', () => {
  it('reads each surface with its own scope', async () => {
    const server = stubStarterFetch(() => json(makeInfo()));
    await getChatStarters({ surface: 'home' });
    await getChatStarters({ surface: 'thread', conversationId: 'c-1' });
    await getChatStarters({ surface: 'case', caseId: 'case-0042' });
    const [home, thread, caseRead] = server.reads().map(query);
    expect(Object.fromEntries(home)).toEqual({ surface: 'home' });
    expect(Object.fromEntries(thread)).toEqual({ surface: 'thread', conversation_id: 'c-1' });
    expect(Object.fromEntries(caseRead)).toEqual({ surface: 'case', case_id: 'case-0042' });
  });

  it('refuses a thread or case read without its id, with no request', async () => {
    const server = stubStarterFetch(() => json(makeInfo()));
    await expect(getChatStarters({ surface: 'thread', conversationId: 'bad id' })).rejects.toMatchObject({ status: 404 });
    await expect(getChatStarters({ surface: 'case', caseId: '' })).rejects.toMatchObject({ status: 404 });
    expect(server.calls).toHaveLength(0);
  });

  it('posts only opaque keys (at most six), never text', async () => {
    const server = stubStarterFetch(() => json(makeInfo()));
    await postChatStarterEvent({
      type: 'viewed',
      surface: 'home',
      keys: ['3cf51d4967fc61e9', 'not-a-key', '3cf51d4967fc61e9', ...'0123456'.split('').map((d) => d.repeat(16))],
    });
    expect(server.events()).toEqual([
      { type: 'viewed', surface: 'home', keys: ['3cf51d4967fc61e9', '0'.repeat(16), '1'.repeat(16), '2'.repeat(16), '3'.repeat(16), '4'.repeat(16)] },
    ]);
  });
});
