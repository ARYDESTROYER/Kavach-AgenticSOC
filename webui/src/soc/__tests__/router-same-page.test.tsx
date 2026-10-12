/**
 * Same-page hash changes (Round 12 final review): Back/Forward or a typed URL that stays on
 * one page lets the hash decide the durable options. Back from `#/reports?reportId=x` to
 * `#/reports` drops `reportId` (the list shows again); options that never reach the hash
 * (a Cases severity drill-through, a new chat, a Settings section) survive the hash echo of
 * the in-app navigate that set them, with the same object identity.
 *
 * The echo of an in-app navigate is a no-op even for values the strict deep-link parser
 * refuses from a typed link: the Overview's `__active__`/`__terminal__` status facets (now
 * also accepted on refresh), a tag containing `/`, or a case id outside the case id
 * grammar. Those were wiped by the echo before the lazy Cases page mounted, so a "View
 * resolved cases" drill-through landed on "All statuses".
 */
import * as React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { NavOpts } from '@/lib/types';
import { optsFromHash, pageHash, RouterProvider, samePageOpts, useRoute } from '../router';

let route: ReturnType<typeof useRoute>;
const seen: Array<NavOpts | undefined> = [];

function Probe() {
  const current = useRoute();
  route = current;
  const { opts } = current;
  React.useEffect(() => {
    seen.push(opts);
  }, [opts]);
  return <div data-testid="probe">{`${current.page}|${JSON.stringify(opts ?? null)}`}</div>;
}

/** The browser's Back/Forward or a typed URL: the hash changes, then `hashchange` fires. */
function goHash(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

function mount(hash: string) {
  window.location.hash = hash;
  seen.length = 0;
  render(
    <RouterProvider>
      <Probe />
    </RouterProvider>,
  );
}

const probe = () => screen.getByTestId('probe').textContent;

afterEach(() => {
  window.location.hash = '';
});

describe('same-page hash changes', () => {
  it('Back from a report document to #/reports clears reportId; Forward reopens it', () => {
    mount('#/reports');
    expect(probe()).toBe('reports|null');
    act(() => route.navigate('reports', { reportId: 'rpt-1' }));
    goHash('#/reports?reportId=rpt-1'); // the navigate's own hash echo
    expect(probe()).toBe('reports|{"reportId":"rpt-1"}');
    goHash('#/reports'); // Back (or a typed #/reports)
    expect(probe()).toBe('reports|null');
    goHash('#/reports?reportId=rpt-1'); // Forward
    expect(probe()).toBe('reports|{"reportId":"rpt-1"}');
    goHash('#/reports');
    expect(probe()).toBe('reports|null');
  });

  it('keeps a Cases severity drill-through when the caseId leaves the hash', () => {
    mount('#/cases');
    act(() => route.navigate('cases', { caseId: 'case-a', severity: 'high' }));
    goHash('#/cases?caseId=case-a');
    expect(probe()).toBe('cases|{"caseId":"case-a","severity":"high"}');
    goHash('#/cases');
    expect(probe()).toBe('cases|{"severity":"high"}');
  });

  it("hands consumers keyed on the opts identity no second request for a navigate's echo", () => {
    mount('#/chat?conversationId=conv-1');
    act(() => route.navigate('chat', { newChat: true, topic: 'kpi.mtta' }));
    const opts = route.opts;
    expect(opts).toEqual({ newChat: true, topic: 'kpi.mtta' });
    const before = seen.length;
    goHash('#/chat');
    expect(route.opts).toBe(opts);
    expect(seen.length).toBe(before);
    // A conversation switch keeps the navigate's object too.
    act(() => route.navigate('chat', { conversationId: 'conv-2' }));
    const switched = route.opts;
    goHash('#/chat?conversationId=conv-2');
    expect(route.opts).toBe(switched);
  });

  it('keeps a Settings section, which travels in its own hash grammar', () => {
    mount('#/settings');
    act(() => route.navigate('settings', { section: 'sources' }));
    const opts = route.opts;
    goHash('#/settings?s=sources');
    expect(route.opts).toBe(opts);
  });
});

/** Let jsdom fire the real `hashchange` queued by a hash assignment (no manual event). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("the real hash echo of an in-app navigate", () => {
  it.each(['__terminal__', '__active__'])('keeps the Overview %s status facet and its window', async (status) => {
    mount('#/overview');
    act(() => route.navigate('cases', { status, window: 24 }));
    const opts = route.opts;
    await settle();
    expect(window.location.hash).toBe(`#/cases?status=${status}`);
    expect(probe()).toBe(`cases|{"status":"${status}","window":24}`);
    expect(route.opts).toBe(opts);
  });

  it('keeps a tag the strict parser refuses, and the status next to it', async () => {
    for (const tag of ['mitre/T1059', 'a?b', 'a#b', 'a&b', 'a=b', '100%', 'x'.repeat(41)]) {
      cleanup();
      mount('#/overview');
      act(() => route.navigate('cases', { tag, status: '__terminal__' }));
      await settle();
      expect(route.opts).toEqual({ tag, status: '__terminal__' });
    }
  });

  it('keeps a case id outside the case id grammar on Case Manager', async () => {
    mount('#/overview');
    act(() => route.navigate('case_manager', { caseId: 'case#1?x' }));
    await settle();
    expect(route.opts).toEqual({ caseId: 'case#1?x' });
  });

  it('Back from #/reports?reportId=x still clears reportId', async () => {
    mount('#/reports');
    act(() => route.navigate('reports', { reportId: 'rpt-1' }));
    await settle();
    expect(probe()).toBe('reports|{"reportId":"rpt-1"}');
    window.location.hash = '#/reports';
    await settle();
    expect(probe()).toBe('reports|null');
  });

  it('Back to a terminal-facet list drops the case id and keeps the facet', async () => {
    mount('#/overview');
    act(() => route.navigate('cases', { status: '__terminal__', window: 24 }));
    await settle();
    act(() => route.navigate('cases', { status: '__terminal__', window: 24, caseId: 'case-a' }));
    await settle();
    expect(route.opts).toEqual({ status: '__terminal__', window: 24, caseId: 'case-a' });
    window.location.hash = '#/cases?status=__terminal__';
    await settle();
    expect(route.opts).toEqual({ status: '__terminal__', window: 24 });
  });
});

describe('samePageOpts', () => {
  it('replaces only the keys the page owns in its hash', () => {
    expect(samePageOpts('reports', { reportId: 'r1' }, '#/reports')).toBeUndefined();
    expect(samePageOpts('logs', { logQuery: 'x', from: 'now-1h' }, '#/logs?logQuery=y')).toEqual({ logQuery: 'y' });
    expect(samePageOpts('chat', { conversationId: 'c1', messageId: 'm1' }, '#/chat?conversationId=c1')).toEqual({ conversationId: 'c1' });
    expect(samePageOpts('cases', { severity: 'high', status: 'open' }, '#/cases')).toEqual({ severity: 'high' });
    // Metrics serialises only the effectiveness tab: another tab is in-memory state.
    const cost = { tab: 'cost' };
    expect(samePageOpts('metrics', cost, '#/metrics')).toBe(cost);
    expect(samePageOpts('metrics', { tab: 'effectiveness' }, '#/metrics')).toBeUndefined();
    expect(samePageOpts('metrics', cost, '#/metrics?tab=effectiveness')).toEqual({ tab: 'effectiveness' });
  });

  it('returns the current object for its own hash, and undefined for nothing', () => {
    const current = { caseId: 'a', severity: 'high' };
    expect(samePageOpts('cases', current, '#/cases?caseId=a')).toBe(current);
    for (const opts of [
      { status: '__terminal__', window: 24 },
      { status: '__active__' },
      { tag: 'review/urgent', assignee: 'ops & intel' },
      { caseId: 'case#1' },
    ]) {
      expect(samePageOpts('cases', opts, pageHash('cases', opts))).toBe(opts);
    }
    const log = { logQuery: 'user:"a b" + c', from: '2026-10-08T09:00:00+02:00' };
    expect(samePageOpts('logs', log, pageHash('logs', log))).toBe(log);
    expect(samePageOpts('reports', undefined, '#/reports')).toBeUndefined();
  });

  it('takes a valid new value and drops one that fails validation', () => {
    expect(samePageOpts('cases', { status: '__terminal__', caseId: 'a' }, '#/cases?status=__terminal__&caseId=b')).toEqual({
      status: '__terminal__',
      caseId: 'b',
    });
    expect(samePageOpts('cases', { status: 'open', severity: 'high' }, '#/cases?status=bogus')).toEqual({ severity: 'high' });
    expect(samePageOpts('cases', { tag: 'a' }, '#/cases?tag=x&tag=y')).toBeUndefined();
    expect(samePageOpts('cases', { tag: 'a' }, '#/cases?tag=%20b%20')).toEqual({ tag: 'b' });
    // A message anchor without its conversation is unreadable.
    expect(samePageOpts('chat', { conversationId: 'c1' }, '#/chat?messageId=m2')).toBeUndefined();
    expect(samePageOpts('chat', { conversationId: 'c1' }, '#/chat?conversationId=c2&messageId=m2')).toEqual({
      conversationId: 'c2',
      messageId: 'm2',
    });
  });

  it('keeps everything when the query cannot be decoded', () => {
    const current = { tag: 'a', status: 'open' };
    expect(samePageOpts('cases', current, '#/cases?tag=%E0%A4%A')).toBe(current);
  });
});

describe('optsFromHash and the Cases status facets', () => {
  it('reopens the Overview facets on refresh, on Cases only', () => {
    window.location.hash = '#/cases?status=__terminal__';
    expect(optsFromHash()).toMatchObject({ status: '__terminal__' });
    window.location.hash = '#/cases?status=__active__';
    expect(optsFromHash()).toMatchObject({ status: '__active__' });
    window.location.hash = '#/cases?status=__other__';
    expect(optsFromHash()).toBeUndefined();
    window.location.hash = '#/case_manager?status=__terminal__';
    expect(optsFromHash()).toBeUndefined();
  });
});
