/**
 * Round 12 answer-level wire (WP-FEAT-A): the `turn.done` normalisers for clarify,
 * saved_report, saved_report_error, continued and compacted (#9: model-authored text is
 * display-sanitised), and the lazy client calls for feedback, the step inspector, the
 * "Add to case" picker and the case-thread comment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CASE_COMMENT_MAX_CHARS,
  getStepObservation,
  listChatFeedback,
  observationSuggestions,
  postCaseComment,
  postChatFeedback,
  saveAnswerAsReport,
  searchCasesForPicker,
} from '../chat-api';
import {
  normaliseChatResponse,
  normaliseClarify,
  normaliseReportSaveError,
  normaliseSavedReport,
  parseStreamEvent,
} from '../stream-events';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return handler(call);
    }),
  );
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Round 12 response normalisers', () => {
  it('keeps a clarify question with at most four distinct, sanitised options', () => {
    const clarify = normaliseClarify({
      question: 'Trend of\u202e what?',
      options: ['Alerts', 'Alerts', 'Cases\u200b', 7, 'AI cost', 'FP rate', 'Extra'],
      allow_custom: false,
    });
    expect(clarify).toEqual({ question: 'Trend of what?', options: ['Alerts', 'Cases', 'AI cost', 'FP rate'], allow_custom: false });
    // allow_custom defaults to true; a question is required.
    expect(normaliseClarify({ question: 'Which?', options: 'nope' })).toEqual({ question: 'Which?', options: [], allow_custom: true });
    expect(normaliseClarify({ options: ['A'] })).toBeNull();
    expect(normaliseClarify('Which?')).toBeNull();
  });

  it('bounds the question and the option length (≤200 / ≤80)', () => {
    const clarify = normaliseClarify({ question: 'q'.repeat(400), options: ['o'.repeat(200)] });
    expect(clarify?.question.length).toBeLessThanOrEqual(200);
    expect(clarify?.options[0].length).toBeLessThanOrEqual(80);
  });

  it('keeps a saved report only with a safe id and sanitises its model-authored title', () => {
    expect(normaliseSavedReport({ id: 'rpt-1', title: 'Monthly\u202e report', items: 7, skipped: 2 })).toEqual({
      id: 'rpt-1',
      title: 'Monthly report',
      items: 7,
      skipped: 2,
    });
    expect(normaliseSavedReport({ id: '../etc', title: 'x' })).toBeNull();
    expect(normaliseSavedReport({ title: 'x' })).toBeNull();
    expect(normaliseSavedReport({ id: 'rpt-2', items: -1 })).toEqual({ id: 'rpt-2', title: '', items: 0, skipped: 0 });
  });

  it('keeps a report-save error only with a known code', () => {
    expect(normaliseReportSaveError({ code: 'report_limit', message: 'Your report library is full.', retryable: 'yes' })).toEqual({
      code: 'report_limit',
      message: 'Your report library is full.',
      retryable: false,
    });
    expect(normaliseReportSaveError({ code: 'boom' })).toBeNull();
  });

  it('normalises the Round 12 fields of a turn.done response', () => {
    const response = normaliseChatResponse({
      answer: 'Which trend?',
      clarify: { question: 'Trend of what?', options: ['Alerts'] },
      saved_report: { id: 'rpt-9', title: 'Lifetime', items: 3 },
      saved_report_error: { code: 'report_unavailable', message: 'Try later', retryable: true },
      continued: 2,
      compacted: 'true',
      steps: [{ index: 2, kind: 'tool', tool: 'case_stats', label: 'Counted cases', observation_ref: 'o1:turn-1', progress: { done: 5, total: 9, unit: 'cases' } }],
    });
    expect(response?.clarify).toEqual({ question: 'Trend of what?', options: ['Alerts'], allow_custom: true });
    expect(response?.saved_report).toEqual({ id: 'rpt-9', title: 'Lifetime', items: 3, skipped: 0 });
    expect(response?.saved_report_error).toEqual({ code: 'report_unavailable', message: 'Try later', retryable: true });
    expect(response?.continued).toBe(2);
    // Only a real boolean true counts.
    expect(response?.compacted).toBe(false);
    expect(response?.steps?.[0].observation_ref).toBe('o1:turn-1');
    expect(response?.steps?.[0].progress).toEqual({ done: 5, total: 9, unit: 'cases' });
  });

  it('defaults the Round 12 fields on a legacy response', () => {
    const response = normaliseChatResponse({ answer: 'ok' });
    expect(response).toMatchObject({ clarify: null, saved_report: null, saved_report_error: null, continued: 0, compacted: false });
  });

  it('parses step.progress and text.continued events', () => {
    expect(parseStreamEvent(JSON.stringify({ type: 'step.progress', index: 3, done: 42000, total: 118402, unit: 'cases' }))).toEqual({
      type: 'step.progress',
      index: 3,
      done: 42000,
      total: 118402,
      unit: 'cases',
    });
    expect(parseStreamEvent(JSON.stringify({ type: 'text.continued', part: 2 }))).toEqual({ type: 'text.continued', part: 2 });
    expect(parseStreamEvent(JSON.stringify({ type: 'text.continued', part: 1 }))).toBeNull();
  });
});

describe('Round 12 client calls', () => {
  it('posts feedback with only the allowed fields and a bounded comment', async () => {
    stubFetch(() => json(null, 204));
    await postChatFeedback({
      conversation_id: 'conv-1',
      message_id: 'msg-2',
      rating: 'down',
      reason: 'incomplete',
      comment: `  ${'x'.repeat(1200)}  `,
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/api/chat/feedback');
    const body = calls[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ conversation_id: 'conv-1', message_id: 'msg-2', rating: 'down', reason: 'incomplete' });
    expect((body.comment as string).length).toBe(1000);

    calls = [];
    await postChatFeedback({ conversation_id: 'conv-1', message_id: 'msg-2', rating: 'up', reason: null, comment: '   ' });
    expect(calls[0].body).toEqual({ conversation_id: 'conv-1', message_id: 'msg-2', rating: 'up' });
  });

  it('reads the stored ratings of one conversation and drops malformed rows', async () => {
    stubFetch(() =>
      json({
        feedback: [
          { conversation_id: 'conv-1', message_id: 'msg-2', rating: 'down', reason: 'wrong', comment: 'off\u202e by one', updated_at: '2026-10-11T10:00:00Z' },
          { conversation_id: 'conv-1', message_id: 'bad id!', rating: 'up' },
          { conversation_id: 'conv-1', message_id: 'msg-3', rating: 'meh' },
          { conversation_id: 'conv-OTHER', message_id: 'msg-4', rating: 'up' },
          { conversation_id: 'conv-1', message_id: 'msg-5', rating: 'up', reason: 'nonsense' },
        ],
      }),
    );
    const entries = await listChatFeedback('conv-1');
    expect(calls[0].url).toContain('conversation_id=conv-1');
    expect(entries).toEqual([
      { conversation_id: 'conv-1', message_id: 'msg-2', rating: 'down', reason: 'wrong', comment: 'off by one', updated_at: '2026-10-11T10:00:00Z' },
      { conversation_id: 'conv-1', message_id: 'msg-5', rating: 'up', reason: null, comment: '', updated_at: '' },
    ]);
  });

  it('reads a step observation and extracts its zero-result suggestions', async () => {
    stubFetch(() =>
      json({
        conversation_id: 'conv-1',
        message_id: 'msg-2',
        index: 2,
        tool: 'case_stats',
        status: 'ok',
        label: 'Counted cases',
        summary: '0 cases (exact, this week)',
        observation: {
          total: 0,
          suggestions: [
            { label: 'All time', tool: 'case_stats', input: { window: 'all' } },
            { label: 'All time', tool: 'case_stats' },
            { label: 'Without the verdict filter', tool: 'BAD TOOL' },
            { tool: 'case_stats' },
          ],
        },
        params: { query: 'x\u202ey', 'bad key!': 'z' },
        truncated: true,
        stored_at: '2026-10-11T12:00:00Z',
      }),
    );
    const read = await getStepObservation('conv-1', 'msg-2', 2);
    expect(calls[0].url).toContain('/api/chat/conversations/conv-1/messages/msg-2/steps/2');
    expect(read.suggestions).toEqual([
      { label: 'All time', tool: 'case_stats' },
      { label: 'Without the verdict filter', tool: null },
    ]);
    expect(read.params).toEqual({ query: 'xy' });
    expect(read.truncated).toBe(true);
    expect(read.observation).toMatchObject({ total: 0 });
    expect(observationSuggestions(null)).toEqual([]);
  });

  it('searches cases for the picker, newest first, with plain display rows', async () => {
    stubFetch(() =>
      json({
        cases: [
          { case_id: 'case-1', case_number: 'SOC-0001', title: 'Brute force\u202e on vpn', status: 'escalated' },
          { case_id: 'case-2', summary: 'Phishing', status: 'new' },
          { case_id: 'case-1', title: 'duplicate' },
          { case_id: '<script>' },
        ],
        total: 3,
      }),
    );
    const rows = await searchCasesForPicker('  vpn  ');
    expect(calls[0].url).toContain('q=vpn');
    expect(calls[0].url).toContain('sort_field=created_at');
    expect(rows).toEqual([
      { case_id: 'case-1', display_id: 'SOC-0001', title: 'Brute force on vpn', status: 'escalated', severity: null },
      { case_id: 'case-2', display_id: 'case-2', title: 'Phishing', status: 'new', severity: null },
    ]);
  });

  it("posts the analyst's own comment to the case thread", async () => {
    stubFetch(() => json({ id: 'msg-77', body: 'hello' }));
    const out = await postCaseComment('case 1/2', 'hello');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/api/cases/case%201%2F2/thread');
    expect(calls[0].body).toEqual({ body: 'hello', author_type: 'human', kind: 'comment' });
    expect(out).toEqual({ id: 'msg-77' });
    expect(CASE_COMMENT_MAX_CHARS).toBe(8000);
  });

  it('saves an answer as a report by reference only, through the idempotent server route', async () => {
    stubFetch(() => json({ id: 'rpt-1', title: 'Sept\u202e report', items: 4, skipped: 1 }));
    const out = await saveAnswerAsReport('conv-1', 'm-1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/api/reports/from-answer');
    // No title, template or content from the client: the server reads the stored answer.
    expect(calls[0].body).toEqual({ conversation_id: 'conv-1', message_id: 'm-1' });
    expect(out).toEqual({ id: 'rpt-1', title: 'Sept report', items: 4, skipped: 1 });
    stubFetch(() => json({ id: '../index' }));
    await expect(saveAnswerAsReport('conv-1', 'm-1')).rejects.toThrow();
  });
});
