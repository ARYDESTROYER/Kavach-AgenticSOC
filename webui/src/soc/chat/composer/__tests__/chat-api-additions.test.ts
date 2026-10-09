/**
 * WP-I2b's additive chat-api surface: `normaliseChatContext` keeps starters (strictly
 * shaped, never clamped), `getChatTopic` resolves an "Ask about this" topic to its
 * templated question, and the saved-prompt helpers read/write `UserPrefs.chat_prompts`
 * through the existing prefs routes, refusing to claim a save the server ignored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import {
  addSavedPrompt,
  CHAT_TOPIC_RE,
  deleteSavedPrompt,
  getChatTopic,
  getSavedPrompts,
  makeSavedPrompt,
  normaliseChatContext,
  normaliseSavedPrompts,
  SAVED_PROMPTS_UNSUPPORTED,
} from '../../chat-api';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}
let calls: Call[] = [];
let handler: (call: Call) => Response = () => new Response('{}');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return handler(call);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('normaliseChatContext starters', () => {
  it('keeps well-formed starters in server order and drops unusable ones', () => {
    const ctx = normaliseChatContext({
      starters: [
        { id: 'investigate', label: 'Investigate', description: 'Newest open case', prompt: 'Investigate case-0042.', tools: ['get_case', 'BAD TOOL'] },
        { id: 'investigate', label: 'Dup', prompt: 'x', tools: [] },
        { id: 'Bad-Id', label: 'x', prompt: 'x' },
        { id: 'hunt', label: '', prompt: 'x' },
        { id: 'posture', label: 'Posture now', prompt: '' },
        { id: 'learn_app', label: 'Learn​ the app', prompt: 'How do I add a model?', tools: [] },
        { id: 'shift_brief', label: 'Long', prompt: 'x'.repeat(401) },
      ],
    });
    expect(ctx.starters).toEqual([
      { id: 'investigate', label: 'Investigate', description: 'Newest open case', prompt: 'Investigate case-0042.', tools: ['get_case'] },
      { id: 'learn_app', label: 'Learn the app', description: '', prompt: 'How do I add a model?', tools: [] },
    ]);
  });

  it('defaults to an empty list', () => {
    expect(normaliseChatContext({}).starters).toEqual([]);
    expect(normaliseChatContext({ starters: 'nope' }).starters).toEqual([]);
  });
});

describe('getChatTopic', () => {
  it('GETs the topic and returns its question', async () => {
    handler = () => json({ topic: 'kpi:false_positive_rate', question: 'How is the False Positive Rate calculated?' });
    await expect(getChatTopic('kpi:false_positive_rate')).resolves.toEqual({
      topic: 'kpi:false_positive_rate',
      question: 'How is the False Positive Rate calculated?',
    });
    expect(calls[0].url).toBe('/api/chat/topics/kpi%3Afalse_positive_rate');
  });

  it('refuses an id outside the grammar without a request', async () => {
    await expect(getChatTopic('../etc/passwd')).rejects.toBeInstanceOf(ApiError);
    await expect(getChatTopic('Has Spaces')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
    expect(CHAT_TOPIC_RE.test('settings:data_export')).toBe(true);
    // The longest console-link id (121 chars) is accepted and requested.
    const longest = `${'k'.repeat(40)}:${'x'.repeat(80)}`;
    expect(CHAT_TOPIC_RE.test(longest)).toBe(true);
    expect(CHAT_TOPIC_RE.test(`${longest}x`)).toBe(false);
  });

  it('surfaces 404 and refuses an unreadable or over-long question', async () => {
    handler = () => json({ detail: 'unknown topic' }, 404);
    await expect(getChatTopic('kpi:nope')).rejects.toMatchObject({ status: 404 });
    handler = () => json({ topic: 'kpi:x' });
    await expect(getChatTopic('kpi:x')).rejects.toMatchObject({ status: 502 });
    handler = () => json({ question: 'q'.repeat(401) });
    await expect(getChatTopic('kpi:x')).rejects.toMatchObject({ status: 502 });
  });
});

describe('saved prompts', () => {
  let stored: unknown[] = [];
  let ignoreWrites = false;
  beforeEach(() => {
    stored = [];
    ignoreWrites = false;
    handler = (call) => {
      if (call.url === '/api/prefs/user' && call.method === 'GET') return json({ chat_prompts: stored });
      if (call.url === '/api/prefs/user' && call.method === 'PUT') {
        if (!ignoreWrites) stored = (call.body?.chat_prompts as unknown[]) ?? stored;
        return json({ chat_prompts: stored });
      }
      return json({}, 404);
    };
  });

  it('normalises: ids, dedupe, title fallback, bounds', () => {
    const list = normaliseSavedPrompts([
      { id: 'a', title: '', text: 'First line\nsecond line' },
      { id: 'a', title: 'dup', text: 'x' },
      { id: 'bad id', title: 't', text: 'x' },
      { id: 'b', title: 't', text: '   ' },
      { id: 'c', title: 'T'.repeat(80), text: 'y'.repeat(2500) },
    ]);
    expect(list.map((p) => p.id)).toEqual(['a', 'c']);
    expect(list[0].title).toBe('First line second line');
    expect(Array.from(list[1].title)).toHaveLength(60);
    expect(Array.from(list[1].text)).toHaveLength(2000);
    expect(normaliseSavedPrompts(Array.from({ length: 70 }, (_, i) => ({ id: `p${i}`, title: 't', text: 'x' })))).toHaveLength(50);
    expect(makeSavedPrompt({ text: '  ' })).toBeNull();
    expect(makeSavedPrompt({ text: 'hello' })?.id).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
  });

  it('reads the list from GET /api/prefs/user', async () => {
    stored = [{ id: 'a', title: 'A', text: 'alpha' }];
    await expect(getSavedPrompts()).resolves.toEqual([{ id: 'a', title: 'A', text: 'alpha' }]);
  });

  it('adds by re-reading then PUTting the whole list', async () => {
    stored = [{ id: 'a', title: 'A', text: 'alpha' }];
    const result = await addSavedPrompt({ title: 'Beta', text: 'beta text' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect((calls[1].body?.chat_prompts as unknown[]).length).toBe(2);
    expect(result.prompts.map((p) => p.title)).toEqual(['A', 'Beta']);
    expect(result.prompt.text).toBe('beta text');
  });

  it('refuses a 51st prompt', async () => {
    stored = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, title: 't', text: 'x' }));
    await expect(addSavedPrompt({ text: 'one more' })).rejects.toMatchObject({ status: 409 });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('reports a server that silently ignores chat_prompts', async () => {
    ignoreWrites = true;
    await expect(addSavedPrompt({ text: 'hello' })).rejects.toMatchObject({ status: 501, message: SAVED_PROMPTS_UNSUPPORTED });
    stored = [{ id: 'a', title: 'A', text: 'alpha' }];
    await expect(deleteSavedPrompt('a')).rejects.toMatchObject({ status: 501 });
  });

  it('deletes by id and is a no-op for an unknown id', async () => {
    stored = [
      { id: 'a', title: 'A', text: 'alpha' },
      { id: 'b', title: 'B', text: 'beta' },
    ];
    await expect(deleteSavedPrompt('a')).resolves.toEqual([{ id: 'b', title: 'B', text: 'beta' }]);
    calls = [];
    await deleteSavedPrompt('zzz');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});
