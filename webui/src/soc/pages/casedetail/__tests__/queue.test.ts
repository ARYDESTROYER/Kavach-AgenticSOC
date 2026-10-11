/**
 * Case Manager queue helpers (Round 12, CM-1). The queue is server-backed: these pin
 * the exact `GET /api/cases` parameters per view, so no view can silently fall back to
 * "newest 200, filtered in the browser".
 */
import { describe, expect, it } from 'vitest';

import type { Case } from '@/lib/types';
import {
  QUEUE_STATUS_OPTIONS,
  caseInScope,
  matchesSearch,
  queueQuery,
  scopeHeading,
  scopeSummary,
} from '../queue';

const base = { search: '', severity: null, status: null, sort: 'updated_desc' as const };

describe('queueQuery', () => {
  it('Active asks the server for the whole active lifecycle group', () => {
    expect(queueQuery({ ...base, scope: 'active' })).toEqual({
      sort_field: 'updated_at',
      sort_order: 'desc',
      status_group: 'active',
    });
  });

  it('Mine adds the signed-in analyst as the assignee filter', () => {
    expect(queueQuery({ ...base, scope: 'mine', username: 'aryan' })).toMatchObject({
      status_group: 'active',
      assignee: 'aryan',
    });
  });

  it('All has no lifecycle filter; a status replaces the group', () => {
    expect(queueQuery({ ...base, scope: 'all' })).not.toHaveProperty('status_group');
    expect(queueQuery({ ...base, scope: 'all', status: 'closed' })).toMatchObject({ status: 'closed' });
    expect(queueQuery({ ...base, scope: 'active', status: 'on_hold' })).toEqual(
      expect.objectContaining({ status: 'on_hold' }),
    );
    expect(queueQuery({ ...base, scope: 'active', status: 'on_hold' })).not.toHaveProperty('status_group');
  });

  it('drops a terminal status in an active-only scope (it could only ever be empty)', () => {
    expect(queueQuery({ ...base, scope: 'active', status: 'closed' })).toMatchObject({ status_group: 'active' });
  });

  it('search, severity and sort travel to the server', () => {
    const q = queueQuery({ ...base, scope: 'all', search: '  ssh brute  ', severity: 'high', sort: 'title_asc' });
    expect(q).toMatchObject({ q: 'ssh brute', severity: 'high', sort_field: 'title', sort_order: 'asc' });
    expect(queueQuery({ ...base, scope: 'all', search: 'x'.repeat(500) }).q).toHaveLength(200);
  });

  it('the status filter lists the full lifecycle taxonomy', () => {
    expect(QUEUE_STATUS_OPTIONS.map((o) => o.value)).toEqual([
      'new',
      'open',
      'needs_human',
      'investigating',
      'escalated',
      'on_hold',
      'resolved',
      'closed',
    ]);
  });
});

describe('scope + search helpers', () => {
  const c = (over: Partial<Case>) => ({ case_id: 'c', status: 'open', ...over }) as Case;

  it('caseInScope keeps live updates honest', () => {
    expect(caseInScope(c({ status: 'closed' }), 'active')).toBe(false);
    expect(caseInScope(c({ status: 'closed' }), 'all')).toBe(true);
    expect(caseInScope(c({ assignee: 'Aryan' }), 'mine', 'aryan')).toBe(true);
    expect(caseInScope(c({ assignee: 'bob' }), 'mine', 'aryan')).toBe(false);
  });

  it('matchesSearch requires every term', () => {
    const item = c({ title: 'SSH brute force', entity: { type: 'ip', value: '10.0.0.5' } } as Partial<Case>);
    expect(matchesSearch(item, 'ssh 10.0.0.5')).toBe(true);
    expect(matchesSearch(item, 'ssh rdp')).toBe(false);
    expect(matchesSearch(item, '   ')).toBe(true);
  });

  it('the scope line always states loaded versus total', () => {
    expect(scopeHeading('mine')).toBe('My cases');
    expect(scopeSummary('active', 50, 253, 23)).toBe('23 of 253 active · 50 loaded');
    expect(scopeSummary('all', 50, 1200, null)).toBe('1,200 cases · 50 loaded');
  });
});
