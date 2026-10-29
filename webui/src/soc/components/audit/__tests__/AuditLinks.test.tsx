/**
 * Links into the audit log (Round 14 SPEC §4.5.8): the Case trace's "View in audit log"
 * (every scope, filtered to the case), Users' "Audit events for this user" and the
 * Account page (the exact actor). Each is an `<a href>` shown only with `audit:view`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ perms: new Set<string>(['audit:view']), withProvider: true }));

vi.mock('@/soc/auth', () => ({
  useAuth: () => {
    if (!h.withProvider) throw new Error('useAuth must be used within an <AuthProvider>');
    return { authEnabled: true, hasPermission: (r: string, a: string) => h.perms.has(`${r}:${a}`) };
  },
}));

import { TraceTimeline } from '@/soc/components/TraceTimeline';
import type { TimelineResponse } from '@/soc/pages/CaseDetail.api';

import { AuditLogLink } from '../AuditLink';

const TIMELINE: TimelineResponse = {
  case_id: 'case-214',
  spans: [
    {
      id: 's1',
      step_index: 1,
      kind: 'invoke_agent',
      name: 'router',
      ts: '2026-10-25T15:10:33Z',
      summary: 'Routed to the investigator',
      trusted: true,
    } as TimelineResponse['spans'][number],
  ],
  total: 1,
  totals: { cost: 0, tokens: 0 },
};

beforeEach(() => {
  h.perms = new Set(['audit:view']);
  h.withProvider = true;
});
afterEach(() => cleanup());

describe('AuditLogLink', () => {
  it('is a link to the filtered audit log', () => {
    render(<AuditLogLink opts={{ scope: 'all', actor: 'trao' }}>Audit events</AuditLogLink>);
    expect(screen.getByRole('link', { name: 'Audit events' })).toHaveAttribute('href', '#/audit?scope=all&actor=trao');
  });

  it('is hidden without audit:view, and outside a sign-in provider', () => {
    h.perms = new Set();
    const { unmount } = render(<AuditLogLink opts={{ scope: 'all' }}>Audit events</AuditLogLink>);
    expect(screen.queryByRole('link')).toBeNull();
    unmount();
    h.withProvider = false;
    render(<AuditLogLink opts={{ scope: 'all' }}>Audit events</AuditLogLink>);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('the Case trace', () => {
  // An hour before the earliest step, so the audit log's default last 7 days never hides
  // an older investigation; open-ended, so the case work that followed stays in view.
  const HREF = '#/audit?scope=all&from=2026-10-25T14%3A10%3A33Z&case=case-214';

  it('links to every audit row of the case from before its first step, in both presentations', () => {
    const { unmount } = render(<TraceTimeline data={TIMELINE} />);
    expect(screen.getByRole('link', { name: 'View in audit log' })).toHaveAttribute('href', HREF);
    unmount();
    render(<TraceTimeline data={TIMELINE} presentation="case-manager" />);
    expect(screen.getByRole('link', { name: 'View in audit log' })).toHaveAttribute('href', HREF);
  });

  it('starts at the earliest step whatever the order, and falls back to 90 days without a readable time', () => {
    const later = { ...TIMELINE.spans[0], id: 's2', step_index: 2, ts: '2026-10-26T09:00:00Z' };
    const earlier = { ...TIMELINE.spans[0], id: 's0', step_index: 0, ts: '2026-10-20T08:30:15.123456+00:00' };
    const { unmount } = render(<TraceTimeline data={{ ...TIMELINE, spans: [later, earlier] }} />);
    expect(screen.getByRole('link', { name: 'View in audit log' })).toHaveAttribute(
      'href',
      '#/audit?scope=all&from=2026-10-20T07%3A30%3A15Z&case=case-214',
    );
    unmount();
    render(<TraceTimeline data={{ ...TIMELINE, spans: [{ ...TIMELINE.spans[0], ts: 'not a time' }] }} />);
    expect(screen.getByRole('link', { name: 'View in audit log' })).toHaveAttribute(
      'href',
      '#/audit?scope=all&from=now-90d&case=case-214',
    );
  });

  it('shows no link for a case id the audit log link cannot carry', () => {
    render(<TraceTimeline data={{ ...TIMELINE, case_id: 'bad id with spaces' }} />);
    expect(screen.queryByRole('link', { name: 'View in audit log' })).toBeNull();
  });
});

describe('Users and Account', () => {
  const SRC = path.resolve(__dirname, '../../../..');
  it('link each person to their own audit events by exact actor', () => {
    const users = readFileSync(path.join(SRC, 'soc/pages/Users.tsx'), 'utf8');
    expect(users).toMatch(/<AuditLogLink\s+opts=\{\{ scope: 'all', actor: u\.username \}\}/);
    expect(users).toContain('aria-label={`Audit events for ${u.username}`}');
    const account = readFileSync(path.join(SRC, 'soc/pages/Account.tsx'), 'utf8');
    expect(account).toMatch(/<AuditLogLink opts=\{\{ scope: 'all', actor: shownUser \}\}/);
    expect(account).toContain('Your recent activity in the audit log');
  });
});
