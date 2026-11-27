/**
 * Round 16 (SPEC D8; Round 15 D8.3, D6.12): the case detail has six tabs, one lane each,
 * and a link to a retired tab, or to a section that moved, still opens the case.
 *
 *   - `#/case_manager?caseId=X&tab=timeline` keeps the case, opens Evidence and asks the
 *     case to scroll to "What happened"; `tab=threat` opens Evidence on "Threat context".
 *     The hash is REPLACED with the new tab (no history entry), and the section request
 *     stays in memory, never in the address.
 *   - An in-app request for `tab=investigation` with `section=threat-context`, or any tab
 *     with `section=related-cases`, opens Evidence: the sections are there now.
 *     `tab=investigation` alone is unchanged (the audit log's "Open case trace").
 *   - The same holds for an in-app navigate and for a link pasted while the queue is open.
 *   - `review` is a durable Case Manager key with a closed set of values.
 */
import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { NavOpts } from '@/lib/types';
import { optsFromHash, pageFromHash, pageHash, redirectRoute, RouterProvider, useRoute } from '../router';
import type { PageId } from '../nav';
import { CASE_SECTION_TABS, CASE_TABS, LEGACY_CASE_TABS, isCaseTab } from '../case-tabs';

let route: ReturnType<typeof useRoute>;

function Probe() {
  route = useRoute();
  return <div data-testid="probe">{`${route.page}|${JSON.stringify(route.opts ?? null)}`}</div>;
}

function mount(hash: string) {
  window.location.hash = hash;
  render(
    <RouterProvider>
      <Probe />
    </RouterProvider>,
  );
}

const probe = () => screen.getByTestId('probe').textContent;

function parse(hash: string): { page: PageId; opts?: NavOpts } {
  window.location.hash = hash;
  return { page: pageFromHash(), opts: optsFromHash() };
}

afterEach(() => {
  window.location.hash = '';
});

describe('the six case tabs (Round 16, D8)', () => {
  it('lists Brief, Evidence, AI investigation, Response, Activity and Chat, Chat last', () => {
    expect([...CASE_TABS]).toEqual(['overview', 'evidence', 'investigation', 'runbook', 'collab', 'chat']);
    // Alt+N indexes this list: Alt+2 Evidence, Alt+4 Response, Alt+5 Activity, Alt+6 Chat.
    expect(CASE_TABS.indexOf('evidence')).toBe(1);
    expect(CASE_TABS.indexOf('runbook')).toBe(3);
    expect(CASE_TABS.indexOf('collab')).toBe(4);
    expect(CASE_TABS.indexOf('chat')).toBe(5);
  });

  it('keeps the retired ids out of the tab list and maps each to its tab and section', () => {
    expect(isCaseTab('timeline')).toBe(false);
    expect(isCaseTab('threat')).toBe(false);
    expect(LEGACY_CASE_TABS.timeline).toEqual(['evidence', 'what-happened']);
    expect(LEGACY_CASE_TABS.threat).toEqual(['evidence', 'threat-context']);
  });

  it('puts every section a link can name on the Evidence tab', () => {
    expect(CASE_SECTION_TABS).toEqual({
      'what-happened': 'evidence',
      'threat-context': 'evidence',
      'related-cases': 'evidence',
    });
  });
});

describe('a link to a retired case tab (D8)', () => {
  it.each([
    ['timeline', 'evidence', 'what-happened'],
    ['threat', 'evidence', 'threat-context'],
  ] as const)('tab=%s keeps the case and opens %s on %s', (legacy, tab, section) => {
    expect(parse(`#/case_manager?caseId=case-214&tab=${legacy}`)).toEqual({
      page: 'case_manager',
      opts: { caseId: 'case-214', tab, section },
    });
    expect(redirectRoute('case_manager', { caseId: 'case-214', tab: legacy })).toEqual({
      page: 'case_manager',
      opts: { caseId: 'case-214', tab, section },
      redirected: true,
    });
  });

  it('keeps the closer filter beside a rewritten tab', () => {
    expect(parse('#/case_manager?caseId=case-214&closedBy=agent&tab=threat').opts).toEqual({
      caseId: 'case-214',
      closedBy: 'agent',
      tab: 'evidence',
      section: 'threat-context',
    });
  });

  it('replaces the address with the new tab, without a history entry and without the section', () => {
    const before = window.history.length;
    mount('#/case_manager?caseId=case-214&tab=timeline');
    expect(probe()).toBe('case_manager|{"caseId":"case-214","tab":"evidence","section":"what-happened"}');
    expect(window.location.hash).toBe('#/case_manager?caseId=case-214&tab=evidence');
    expect(window.history.length).toBe(before + 1);
  });

  it('rewrites an in-app navigation the same way', () => {
    mount('#/cases');
    act(() => route.navigate('case_manager', { caseId: 'case-9', tab: 'threat' }));
    expect(probe()).toBe('case_manager|{"caseId":"case-9","tab":"evidence","section":"threat-context"}');
    expect(window.location.hash).toBe('#/case_manager?caseId=case-9&tab=evidence');
  });

  it('opens Evidence for a section that moved there, whatever tab the request names', () => {
    mount('#/cases');
    act(() => route.navigate('case_manager', { caseId: 'case-9', tab: 'investigation', section: 'threat-context' }));
    expect(probe()).toBe('case_manager|{"caseId":"case-9","tab":"evidence","section":"threat-context"}');
    expect(window.location.hash).toBe('#/case_manager?caseId=case-9&tab=evidence');
    act(() => route.navigate('case_manager', { caseId: 'case-10', tab: 'overview', section: 'related-cases' }));
    expect(probe()).toBe('case_manager|{"caseId":"case-10","tab":"evidence","section":"related-cases"}');
    expect(redirectRoute('case_manager', { caseId: 'case-11', section: 'related-cases' })).toEqual({
      page: 'case_manager',
      opts: { caseId: 'case-11', section: 'related-cases', tab: 'evidence' },
      redirected: true,
    });
  });

  it('leaves tab=investigation alone ("Open case trace")', () => {
    expect(redirectRoute('case_manager', { caseId: 'case-214', tab: 'investigation' })).toEqual({
      page: 'case_manager',
      opts: { caseId: 'case-214', tab: 'investigation' },
      redirected: false,
    });
    expect(parse('#/case_manager?caseId=case-214&tab=investigation')).toEqual({
      page: 'case_manager',
      opts: { caseId: 'case-214', tab: 'investigation' },
    });
  });

  it('applies a retired link pasted while the queue is open, section included', () => {
    mount('#/case_manager?caseId=case-1');
    act(() => {
      window.location.hash = '#/case_manager?caseId=case-2&tab=threat';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(window.location.hash).toBe('#/case_manager?caseId=case-2&tab=evidence');
    expect(probe()).toBe('case_manager|{"caseId":"case-2","tab":"evidence","section":"threat-context"}');
  });

  it('drops the section on the next address change, so Back to a case never replays it', () => {
    mount('#/case_manager?caseId=case-1');
    act(() => {
      window.location.hash = '#/case_manager?caseId=case-2&tab=timeline';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(probe()).toBe('case_manager|{"caseId":"case-2","tab":"evidence","section":"what-happened"}');
    // Back or Forward to another case on the same tab: the request was one-shot.
    act(() => {
      window.location.hash = '#/case_manager?caseId=case-3&tab=evidence';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(probe()).toBe('case_manager|{"caseId":"case-3","tab":"evidence"}');
  });

  it('never writes a section into a Case Manager address', () => {
    expect(pageHash('case_manager', { caseId: 'case-1', tab: 'overview', section: 'what-happened' })).toBe(
      '#/case_manager?caseId=case-1&tab=overview',
    );
  });

  it('still refuses an unknown tab, dropping the typed link', () => {
    for (const tab of ['Timeline', 'trace', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(parse(`#/case_manager?caseId=case-214&tab=${encodeURIComponent(tab)}`).opts).toBeUndefined();
    }
  });
});

describe('case_manager: review (D6.12)', () => {
  it.each(['pending', 'completed', 'disagreed', 'expired'])('round-trips review=%s', (review) => {
    const hash = pageHash('case_manager', { review });
    expect(hash).toBe(`#/case_manager?review=${review}`);
    expect(parse(hash).opts).toEqual({ review });
  });

  it('refuses any other value', () => {
    expect(pageHash('case_manager', { review: 'all' })).toBe('#/case_manager');
    expect(parse('#/case_manager?review=open').opts).toBeUndefined();
  });
});
