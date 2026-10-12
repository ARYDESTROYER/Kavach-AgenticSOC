/**
 * Same-page hash changes (Round 12 final review): Back/Forward or a typed URL that stays on
 * one page lets the hash decide the durable options. Back from `#/reports?reportId=x` to
 * `#/reports` drops `reportId` (the list shows again); options that never reach the hash
 * (a Cases severity drill-through, a new chat, a Settings section) survive the hash echo of
 * the in-app navigate that set them, with the same object identity.
 */
import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { NavOpts } from '@/lib/types';
import { RouterProvider, samePageOpts, useRoute } from '../router';

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

describe('samePageOpts', () => {
  it('replaces only the keys the current opts would write to the hash', () => {
    expect(samePageOpts('reports', { reportId: 'r1' }, undefined)).toBeUndefined();
    expect(samePageOpts('logs', { logQuery: 'x', from: 'now-1h' }, { logQuery: 'y' })).toEqual({ logQuery: 'y' });
    expect(samePageOpts('chat', { conversationId: 'c1', messageId: 'm1' }, { conversationId: 'c1' })).toEqual({ conversationId: 'c1' });
    expect(samePageOpts('cases', { severity: 'high', status: 'open' }, undefined)).toEqual({ severity: 'high' });
    // Metrics serialises only the effectiveness tab: another tab is in-memory state.
    const cost = { tab: 'cost' };
    expect(samePageOpts('metrics', cost, undefined)).toBe(cost);
    expect(samePageOpts('metrics', { tab: 'effectiveness' }, undefined)).toBeUndefined();
  });

  it('returns the current object when nothing changed, and undefined for nothing', () => {
    const current = { caseId: 'a', severity: 'high' };
    expect(samePageOpts('cases', current, { caseId: 'a', status: undefined, assignee: undefined, tag: undefined })).toBe(current);
    expect(samePageOpts('reports', undefined, undefined)).toBeUndefined();
  });
});
