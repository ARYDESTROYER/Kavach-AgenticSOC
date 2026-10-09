/**
 * Chat revamp deep links (SPEC §10.7): the router serialises only the durable,
 * validated keys of each page (chat: conversationId/messageId; reports: reportId;
 * logs: logQuery/from/to/sourceId), keeps newChat/topic/ask in memory, and fails closed
 * on anything malformed when reading a hash.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { optsFromHash, pageHash, type PageId } from '@/soc/router';

const setHash = (hash: string) => {
  window.history.replaceState(null, '', `/${hash}`);
};

afterEach(() => setHash(''));

describe('pageHash — chat revamp keys', () => {
  it('serialises a requested conversation and message for Chat', () => {
    expect(pageHash('chat', { conversationId: 'conv-1', messageId: 'msg-2' })).toBe(
      '#/chat?conversationId=conv-1&messageId=msg-2',
    );
  });

  it('keeps newChat and topic in memory only, and drops an orphan message anchor', () => {
    expect(pageHash('chat', { newChat: true, topic: 'kpi:mttr' })).toBe('#/chat');
    expect(pageHash('chat', { messageId: 'msg-2' })).toBe('#/chat');
  });

  it("never writes the palette's free-text ask to the hash, on any page", () => {
    const ask = 'why did case-12 escalate?';
    expect(pageHash('chat', { newChat: true, ask })).toBe('#/chat');
    expect(pageHash('chat', { conversationId: 'conv-1', ask })).toBe('#/chat?conversationId=conv-1');
    for (const page of ['logs', 'reports', 'cases'] as PageId[]) expect(pageHash(page, { ask })).not.toContain('ask');
  });

  it('never reads an ask from a hash (a shared link cannot prefill free text)', () => {
    setHash('#/chat?ask=hello');
    expect(optsFromHash()).toBeUndefined();
  });

  it('drops invalid ids instead of serialising them', () => {
    expect(pageHash('chat', { conversationId: 'bad id/../x', messageId: 'msg-2' })).toBe('#/chat');
    expect(pageHash('chat', { conversationId: 'x'.repeat(129) })).toBe('#/chat');
  });

  it('serialises a report id for the Reports library', () => {
    expect(pageHash('reports' as PageId, { reportId: 'rep-1' })).toBe('#/reports?reportId=rep-1');
  });

  it('serialises a bounded log query, window and source for Logs', () => {
    expect(
      pageHash('logs', { logQuery: 'source.ip:"10.0.0.5" AND event.outcome:failure', from: 'now-24h', to: 'now', sourceId: 'wazuh-prod' }),
    ).toBe('#/logs?logQuery=source.ip%3A%2210.0.0.5%22%20AND%20event.outcome%3Afailure&from=now-24h&to=now&sourceId=wazuh-prod');
    expect(pageHash('logs', { from: '2026-10-08T09:00:00Z', to: '2026-10-08T10:00:00+02:00' })).toBe(
      '#/logs?from=2026-10-08T09%3A00%3A00Z&to=2026-10-08T10%3A00%3A00%2B02%3A00',
    );
  });

  it('refuses control, bidi and invisible characters and oversize queries', () => {
    expect(pageHash('logs', { logQuery: 'user:admin‮' })).toBe('#/logs');
    expect(pageHash('logs', { logQuery: 'a\nb' })).toBe('#/logs');
    expect(pageHash('logs', { logQuery: 'q'.repeat(513) })).toBe('#/logs');
    expect(pageHash('logs', { from: 'yesterday', to: 'now-1y' })).toBe('#/logs');
  });

  it('never leaks one page’s keys into another page', () => {
    expect(pageHash('cases', { conversationId: 'conv-1', reportId: 'rep-1', logQuery: 'x' })).toBe('#/cases');
    expect(pageHash('chat', { reportId: 'rep-1', logQuery: 'x', caseId: 'case-1' })).toBe('#/chat');
  });
});

describe('optsFromHash — chat revamp keys', () => {
  it('round-trips a chat deep link', () => {
    setHash(pageHash('chat', { conversationId: 'conv-1', messageId: 'msg-2' }));
    expect(optsFromHash()).toEqual({ conversationId: 'conv-1', messageId: 'msg-2' });
  });

  it('round-trips a logs deep link, keeping the query text exact', () => {
    const opts = { logQuery: ' user.name:"Ann Lee" ', from: 'now-7d', sourceId: 'elastic-prod' };
    setHash(pageHash('logs', opts));
    expect(optsFromHash()).toEqual(opts);
  });

  it('round-trips a written + offset', () => {
    setHash(pageHash('logs', { from: '2026-10-08T10:00:00+05:00' }));
    expect(optsFromHash()).toEqual({ from: '2026-10-08T10:00:00+05:00' });
  });

  it('fails closed on unknown, duplicate, invalid or orphaned keys', () => {
    for (const hash of [
      '#/chat?conversationId=conv-1&tab=investigate',
      '#/chat?conversationId=conv-1&conversationId=conv-2',
      '#/chat?conversationId=bad%20id',
      '#/chat?messageId=msg-2',
      '#/chat?conversationId=',
      '#/logs?logQuery=%E2%80%AEevil',
      '#/logs?from=tomorrow',
      // A literal `+` offset decodes to a space; only `%2B` round-trips.
      '#/logs?from=2026-10-08T10:00:00+05:00',
      '#/logs?to=2026-10-08%2010:00:00Z',
      '#/logs?sourceId=%ZZ',
      '#/chat?newChat=1',
      '#/chat?',
    ]) {
      setHash(hash);
      expect(optsFromHash(), hash).toBeUndefined();
    }
  });

  it('leaves the existing case deep links unchanged', () => {
    setHash('#/cases?caseId=case-1&status=open');
    expect(optsFromHash()).toEqual({ caseId: 'case-1', status: 'open', assignee: undefined, tag: undefined });
    setHash('#/case_manager?caseId=case-1&conversationId=conv-1');
    expect(optsFromHash()).toBeUndefined();
  });
});
