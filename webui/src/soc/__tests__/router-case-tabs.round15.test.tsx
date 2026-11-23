/**
 * Round 15 (SPEC D8.3, D6.12): the case detail has five tabs, and a link to a retired tab
 * still opens the case.
 *
 *   - `#/case_manager?caseId=X&tab=timeline` keeps the case, opens Overview and asks the
 *     case to scroll to "What happened"; `tab=threat` opens Investigation on "Threat
 *     context". The hash is REPLACED with the new tab (no history entry), and the section
 *     request stays in memory, never in the address.
 *   - The same holds for an in-app navigate and for a link pasted while the queue is open.
 *   - `review` is a durable Case Manager key with a closed set of values.
 */
import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { NavOpts } from '@/lib/types';
import { optsFromHash, pageFromHash, pageHash, redirectRoute, RouterProvider, useRoute } from '../router';
import type { PageId } from '../nav';
import { CASE_TABS, LEGACY_CASE_TABS, isCaseTab } from '../case-tabs';

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

describe('the five case tabs (D8.3)', () => {
  it('lists Overview, Runbook, Investigation, Collaboration and Chat, Runbook second', () => {
    expect([...CASE_TABS]).toEqual(['overview', 'runbook', 'investigation', 'collab', 'chat']);
    expect(CASE_TABS.indexOf('runbook')).toBe(1);
  });

  it('keeps the retired ids out of the tab list and maps each to its tab and section', () => {
    expect(isCaseTab('timeline')).toBe(false);
    expect(isCaseTab('threat')).toBe(false);
    expect(LEGACY_CASE_TABS.timeline).toEqual(['overview', 'what-happened']);
    expect(LEGACY_CASE_TABS.threat).toEqual(['investigation', 'threat-context']);
  });
});

describe('a link to a retired case tab (D8.3)', () => {
  it.each([
    ['timeline', 'overview', 'what-happened'],
    ['threat', 'investigation', 'threat-context'],
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
      tab: 'investigation',
      section: 'threat-context',
    });
  });

  it('replaces the address with the new tab, without a history entry and without the section', () => {
    const before = window.history.length;
    mount('#/case_manager?caseId=case-214&tab=timeline');
    expect(probe()).toBe('case_manager|{"caseId":"case-214","tab":"overview","section":"what-happened"}');
    expect(window.location.hash).toBe('#/case_manager?caseId=case-214&tab=overview');
    expect(window.history.length).toBe(before + 1);
  });

  it('rewrites an in-app navigation the same way', () => {
    mount('#/cases');
    act(() => route.navigate('case_manager', { caseId: 'case-9', tab: 'threat' }));
    expect(probe()).toBe('case_manager|{"caseId":"case-9","tab":"investigation","section":"threat-context"}');
    expect(window.location.hash).toBe('#/case_manager?caseId=case-9&tab=investigation');
  });

  it('applies a retired link pasted while the queue is open, section included', () => {
    mount('#/case_manager?caseId=case-1');
    act(() => {
      window.location.hash = '#/case_manager?caseId=case-2&tab=threat';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(window.location.hash).toBe('#/case_manager?caseId=case-2&tab=investigation');
    expect(probe()).toBe('case_manager|{"caseId":"case-2","tab":"investigation","section":"threat-context"}');
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
