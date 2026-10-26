/**
 * Round 14 routes and deep links (SPEC §2.2 items 3 and 4, §4.5.1, §4.6.6, §4.8.2,
 * §4.10.12): the page redirects, the new durable hash keys and their validators.
 *
 *   - `#/dashboard` (the landing page's old child URL) is `#/overview`; `#/playbooks` and
 *     `#/catalog` open `#/runbooks`; `#/scans` opens Case Manager filtered to the cases
 *     the AI agent closed; `#/dashboards?board=builtin:cyber-defence-center` is the
 *     landing page. Each is REPLACED in history, so Back never bounces through an alias.
 *   - Every new key validates exactly; one bad key drops the whole query; empty keys are
 *     never written; a rule with spaces and non-ASCII letters round-trips.
 */
import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { NavOpts } from '@/lib/types';
import {
  LANDING_BOARD_ID,
  optsFromHash,
  pageFromHash,
  pageHash,
  redirectRoute,
  RouterProvider,
  useNavigationBlocker,
  useRoute,
  type NavigationBlockerOptions,
} from '../router';
import type { PageId } from '../nav';

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

/** Parse `hash` as a fresh tab would. */
function parse(hash: string): { page: PageId; opts?: NavOpts } {
  window.location.hash = hash;
  return { page: pageFromHash(), opts: optsFromHash() };
}

afterEach(() => {
  window.location.hash = '';
});

describe('page redirects', () => {
  it.each([
    ['#/dashboard', 'overview', undefined],
    ['#/playbooks', 'runbooks', undefined],
    ['#/catalog', 'runbooks', undefined],
    ['#/scans', 'case_manager', { closedBy: 'agent' }],
    [`#/dashboards?board=${LANDING_BOARD_ID}`, 'overview', undefined],
  ] as const)('%s resolves to %s', (hash, page, opts) => {
    expect(parse(hash)).toEqual({ page, opts });
  });

  it('redirectRoute leaves every other route as it is', () => {
    expect(redirectRoute('dashboards', { board: 'builtin:soc-operations' })).toEqual({
      page: 'dashboards',
      opts: { board: 'builtin:soc-operations' },
      redirected: false,
    });
    expect(redirectRoute('overview').redirected).toBe(false);
  });

  it('replaces an alias in a bookmark without a history entry', () => {
    const before = window.history.length;
    mount('#/dashboard');
    expect(probe()).toBe('overview|null');
    expect(window.location.hash).toBe('#/overview');
    expect(window.history.length).toBe(before + 1); // the bookmark's own entry, nothing more
  });

  it('replaces #/scans with the filtered Case Manager URL', () => {
    mount('#/scans');
    expect(probe()).toBe('case_manager|{"closedBy":"agent"}');
    expect(window.location.hash).toBe('#/case_manager?closedBy=agent');
  });

  it('replaces the landing board with the landing page', () => {
    mount(`#/dashboards?board=${LANDING_BOARD_ID}`);
    expect(probe()).toBe('overview|null');
    expect(window.location.hash).toBe('#/overview');
  });

  it('follows an alias typed while the console is open, in place', () => {
    mount('#/cases');
    act(() => {
      window.location.hash = '#/playbooks';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(probe()).toBe('runbooks|null');
    expect(window.location.hash).toBe('#/runbooks');
  });

  it('in-app navigation to an alias lands on its destination', () => {
    mount('#/cases');
    act(() => route.navigate('scans'));
    expect(probe()).toBe('case_manager|{"closedBy":"agent"}');
    expect(window.location.hash).toBe('#/case_manager?closedBy=agent');
    act(() => route.navigate('dashboard'));
    expect(probe()).toBe('overview|null');
  });

  it('opening a board is a history entry (Back returns to the library)', () => {
    mount('#/dashboards');
    const before = window.history.length;
    act(() => route.navigate('dashboards', { board: 'builtin:soc-operations' }));
    expect(window.location.hash).toBe('#/dashboards?board=builtin%3Asoc-operations');
    expect(window.history.length).toBe(before + 1);
    expect(probe()).toBe('dashboards|{"board":"builtin:soc-operations"}');
  });
});

describe('dashboards: board', () => {
  it.each(['builtin:soc-operations', 'builtin:executive-summary', 'overview', 'new', 'u:0a1b2c3d', 'team.board-1'])(
    'accepts %s',
    (board) => {
      expect(parse(pageHash('dashboards', { board })).opts).toEqual({ board });
    },
  );

  it.each(['has space', 'a/b', 'x'.repeat(129), 'é'])('refuses %s', (board) => {
    expect(parse(`#/dashboards?board=${encodeURIComponent(board)}`).opts).toBeUndefined();
  });

  it('never writes an empty key', () => {
    expect(pageHash('dashboards', { board: '' })).toBe('#/dashboards');
    expect(pageHash('dashboards')).toBe('#/dashboards');
  });
});

describe('logs: rule, severity, severity_gte', () => {
  const RULE = 'Fehlgeschlagene Anmeldung über SSH';

  it('round-trips a rule with spaces and non-ASCII letters byte for byte', () => {
    const hash = pageHash('logs', { rule: RULE, severity_gte: 'high', from: 'now-3d', sourceId: 'src-1' });
    expect(hash).not.toContain('+');
    expect(parse(hash).opts).toEqual({ rule: RULE, severity_gte: 'high', from: 'now-3d', sourceId: 'src-1' });
    // Leading and trailing spaces are part of the value (never trimmed).
    expect(parse(pageHash('logs', { rule: ' x ' })).opts).toEqual({ rule: ' x ' });
  });

  it.each(['info', 'low', 'medium', 'high', 'critical'])('accepts severity %s', (severity) => {
    expect(parse(`#/logs?severity=${severity}`).opts).toEqual({ severity });
    expect(parse(`#/logs?severity_gte=${severity}`).opts).toEqual({ severity_gte: severity });
  });

  it.each([
    ['severity=High', 'a capitalised level'],
    ['severity=urgent', 'an unknown level'],
    [`rule=${encodeURIComponent('x'.repeat(257))}`, 'a rule over 256 characters'],
    [`rule=${encodeURIComponent('a‮b')}`, 'a bidi control in a rule'],
    [`rule=${encodeURIComponent('a\nb')}`, 'a line break in a rule'],
    ['rule=a&rule=b', 'a duplicated key'],
    ['rule=ok&severity=bad', 'one bad key among good ones'],
  ])('refuses %s (%s) and drops the whole query', (query) => {
    expect(parse(`#/logs?${query}`).opts).toBeUndefined();
  });
});

describe('cases: rule (the Rule filter) and case_manager: closedBy', () => {
  it('round-trips the Cases rule through the hash, beside the case keys', () => {
    const RULE = 'Brute force: Anmeldung über SSH';
    const hash = pageHash('cases', { rule: RULE, status: 'open', caseId: 'case-1' });
    expect(parse(hash).opts).toEqual({ caseId: 'case-1', status: 'open', rule: RULE });
  });

  it('never writes an invalid rule to the Cases hash', () => {
    expect(pageHash('cases', { rule: 'a\u0000b' })).toBe('#/cases');
  });

  it.each(['agent', 'analyst', 'analyst_policy', 'system'])('Case Manager accepts closedBy=%s', (closedBy) => {
    expect(parse(pageHash('case_manager', { closedBy })).opts).toEqual({ closedBy });
  });

  it('Case Manager refuses an unknown closer', () => {
    expect(parse('#/case_manager?closedBy=human').opts).toBeUndefined();
    expect(pageHash('case_manager', { closedBy: 'nobody' })).toBe('#/case_manager');
  });
});

describe('runbooks: id', () => {
  it.each(['new', 'phishing', 'brute-force_ssh', 'a', 'a'.repeat(64)])('accepts %s', (id) => {
    expect(parse(pageHash('runbooks', { id })).opts).toEqual({ id });
  });

  it.each(['-lead', 'Upper', 'has space', 'a'.repeat(65), '_x'])('refuses %s', (id) => {
    expect(parse(`#/runbooks?id=${encodeURIComponent(id)}`).opts).toBeUndefined();
  });
});

describe('audit: scope, filters and record', () => {
  it('round-trips a full audit view', () => {
    const opts: NavOpts = {
      scope: 'people',
      from: 'now-7d',
      q: 'role changed for vpatel',
      event: 'user.role_changed',
      actor: 'trao',
      outcome: 'denied',
      case: 'case-0042',
      target: 'vpatel',
      ip: '198.51.100.23',
      record: 'sql:-42',
    };
    expect(parse(pageHash('audit', opts)).opts).toEqual(opts);
  });

  it.each(['people', 'agent', 'all'])('accepts scope %s', (scope) => {
    expect(parse(`#/audit?scope=${scope}`).opts).toEqual({ scope });
  });

  it.each(['user', 'user.role_changed', 'auth.login_failed'])('accepts event %s', (event) => {
    expect(parse(`#/audit?event=${event}`).opts).toEqual({ event });
  });

  it.each(['User.Login', 'a.b.c', 'auth-login', `${'a'.repeat(33)}.b`])('refuses event %s', (event) => {
    expect(parse(`#/audit?event=${encodeURIComponent(event)}`).opts).toBeUndefined();
  });

  it.each(['10.0.0.1', '255.255.255.255', '::1', '2001:db8::8a2e:370:7334', '::ffff:192.0.2.1'])('accepts ip %s', (ip) => {
    expect(parse(`#/audit?ip=${encodeURIComponent(ip)}`).opts).toEqual({ ip });
  });

  it.each(['256.1.1.1', '1.2.3', '1.2.3.4.', '01.2.3.4', '1:2', 'host.example', 'g::1'])('refuses ip %s', (ip) => {
    expect(parse(`#/audit?ip=${encodeURIComponent(ip)}`).opts).toBeUndefined();
  });

  it.each([
    'es:tlsoc-agent-audit-000001:QUJDREVGR0g',
    'demo:es:tlsoc-agent-audit-2026.10.26:aGl0LWlk',
    'es:audit+v2:ab',
    'sql:42',
    'sql:-9223372036854775807',
    'mem:0',
    'demo:mem:12',
    `es:${'a'.repeat(255)}:${'A'.repeat(683)}`,
  ])('accepts record %s', (record) => {
    expect(parse(pageHash('audit', { record })).opts).toEqual({ record });
  });

  it.each([
    'sql:0',
    'sql:01',
    'sql:12345678901234567890',
    'es:Index:abc',
    'es:index:a',
    'es:index:ab=',
    'mem:x',
    'demo:demo:mem:1',
    `es:${'a'.repeat(256)}:ab`,
    `es:a:${'A'.repeat(684)}`,
  ])('refuses record %s', (record) => {
    expect(parse(`#/audit?record=${encodeURIComponent(record)}`).opts).toBeUndefined();
  });

  it('bounds free text: q at 200 characters, actor at 128', () => {
    expect(parse(`#/audit?q=${'a'.repeat(200)}`).opts).toEqual({ q: 'a'.repeat(200) });
    expect(parse(`#/audit?q=${'a'.repeat(201)}`).opts).toBeUndefined();
    expect(parse(`#/audit?actor_contains=${'a'.repeat(128)}`).opts).toEqual({ actor_contains: 'a'.repeat(128) });
    expect(parse(`#/audit?actor=${'a'.repeat(129)}`).opts).toBeUndefined();
  });

  it('refuses a key another page owns', () => {
    expect(parse('#/audit?rule=x').opts).toBeUndefined();
    expect(parse('#/logs?record=sql:1').opts).toBeUndefined();
  });
});

describe('leave guards on a page with several URLs (SPEC §2.2 item 7)', () => {
  const DISCARD: NavigationBlockerOptions = {
    title: 'Discard changes to My dashboard?',
    confirmLabel: 'Discard',
    cancelLabel: 'Keep editing',
  };

  function Guarded({ options }: { options: NavigationBlockerOptions }) {
    useNavigationBlocker(true, options);
    return null;
  }

  function mountGuarded(hash: string, options: NavigationBlockerOptions) {
    window.location.hash = hash;
    render(
      <RouterProvider>
        <Probe />
        <Guarded options={options} />
      </RouterProvider>,
    );
  }

  it('asks before a board goes back to the library when the guard opts in', async () => {
    mountGuarded('#/dashboards?board=overview', { ...DISCARD, sameRoute: true });
    act(() => route.navigate('dashboards'));
    expect(await screen.findByRole('alertdialog', { name: 'Discard changes to My dashboard?' })).toBeInTheDocument();
    expect(probe()).toBe('dashboards|{"board":"overview"}');
    expect(window.location.hash).toBe('#/dashboards?board=overview');
  });

  it('Keep editing stays on the board; Discard opens the library', async () => {
    const user = userEvent.setup();
    mountGuarded('#/dashboards?board=overview', { ...DISCARD, sameRoute: true });
    act(() => route.navigate('dashboards'));
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));
    expect(probe()).toBe('dashboards|{"board":"overview"}');
    expect(window.location.hash).toBe('#/dashboards?board=overview');

    act(() => route.navigate('dashboards'));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(probe()).toBe('dashboards|null');
    expect(window.location.hash).toBe('#/dashboards');
  });

  it('still asks before leaving the page, opted in or not', async () => {
    mountGuarded('#/dashboards?board=overview', { ...DISCARD, sameRoute: true });
    act(() => route.navigate('cases'));
    expect(await screen.findByRole('alertdialog', { name: 'Discard changes to My dashboard?' })).toBeInTheDocument();
    expect(probe()).toBe('dashboards|{"board":"overview"}');
  });

  it('never asks for a navigation to the URL already shown', () => {
    mountGuarded('#/dashboards?board=overview', { ...DISCARD, sameRoute: true });
    act(() => route.navigate('dashboards', { board: 'overview' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(probe()).toBe('dashboards|{"board":"overview"}');
  });

  it('a guard that does not opt in keeps its draft through same-page jumps without asking', () => {
    mountGuarded('#/dashboards?board=overview', DISCARD);
    act(() => route.navigate('dashboards'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(probe()).toBe('dashboards|null');
  });
});
