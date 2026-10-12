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
  compareQueueOrder,
  keepAdvisoryBands,
  matchesSearch,
  mergeQueueRow,
  queueMembership,
  queueQuery,
  scopeHeading,
  scopeSummary,
  windowPlacement,
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

describe('queueMembership — the client mirror of the server view (live honesty)', () => {
  const open: Case = { case_id: 'c1', status: 'needs_human', verdict: 'NEEDS_HUMAN', severity_band: 'high', title: 'SSH brute force', assignee: 'Aryan' };

  it('scope, single status, owner, search and severity all decide membership', () => {
    expect(queueMembership(open, { ...base, scope: 'active' })).toBe('in');
    expect(queueMembership({ ...open, status: 'closed' }, { ...base, scope: 'active' })).toBe('out');
    expect(queueMembership({ ...open, status: 'closed' }, { ...base, scope: 'all' })).toBe('in');
    expect(queueMembership({ ...open, status: 'investigating' }, { ...base, scope: 'active', status: 'needs_human' })).toBe('out');
    expect(queueMembership(open, { ...base, scope: 'mine', username: 'aryan' })).toBe('in');
    expect(queueMembership({ ...open, assignee: 'someone' }, { ...base, scope: 'mine', username: 'aryan' })).toBe('out');
    expect(queueMembership(open, { ...base, scope: 'all', search: 'ssh brute' })).toBe('in');
    expect(queueMembership(open, { ...base, scope: 'all', search: 'phishing' })).toBe('out');
    expect(queueMembership(open, { ...base, scope: 'all', severity: 'critical' })).toBe('out');
    expect(queueMembership(open, { ...base, scope: 'all', severity: 'high' })).toBe('in');
  });

  it('an action response with no read-time severity band is unknown under a severity filter', () => {
    const bare: Case = { ...open, severity_band: undefined, risk_score: 90 };
    expect(queueMembership(bare, { ...base, scope: 'all', severity: 'high' })).toBe('unknown');
    expect(queueMembership(bare, { ...base, scope: 'all' })).toBe('in');
  });
});

describe('windowPlacement / compareQueueOrder', () => {
  const at = (id: string, minute: number, extra: Partial<Case> = {}): Case => ({
    case_id: id,
    status: 'open',
    updated_at: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
    ...extra,
  });
  const loaded = [at('a', 50), at('b', 40), at('c', 30)];

  it('a case updated after the window lists inside it; an older one lists beyond it', () => {
    expect(windowPlacement(at('x', 60), loaded, 10, 'updated_desc')).toBe('inside');
    expect(windowPlacement(at('x', 10), loaded, 10, 'updated_desc')).toBe('beyond');
    expect(windowPlacement(at('x', 30), loaded, 10, 'updated_desc')).toBe('edge');
    // Everything loaded: anything that matches belongs in the window.
    expect(windowPlacement(at('x', 10), loaded, 3, 'updated_desc')).toBe('inside');
  });

  it('the boundary is the row that lists last, not the last row on screen', () => {
    // Row "c" was updated in place (now the newest) but stays last on screen.
    const drifted = [at('a', 50), at('b', 40), at('c', 70)];
    expect(windowPlacement(at('x', 45), drifted, 10, 'updated_desc')).toBe('inside');
  });

  it('orders risk descending and titles ascending like the server', () => {
    expect(compareQueueOrder(at('a', 1, { risk_score: 90 }), at('b', 1, { risk_score: 10 }), 'risk_desc')).toBeLessThan(0);
    expect(compareQueueOrder(at('a', 1, { title: 'Alpha' }), at('b', 1, { title: 'beta' }), 'title_asc')).toBeLessThan(0);
    expect(compareQueueOrder(at('a', 1, { risk_score: 50 }), at('b', 1, { risk_score: 50 }), 'risk_desc')).toBe(0);
  });

  it('a row keeps its listed read-time bands when an action response lacks them', () => {
    const merged = mergeQueueRow(
      { case_id: 'c1', severity_band: 'critical', severity_source: 'source_asserted' },
      { case_id: 'c1', status: 'closed' },
    );
    expect(merged).toMatchObject({ status: 'closed', severity_band: 'critical', severity_source: 'source_asserted' });
  });
});

describe('keepAdvisoryBands (the case detail header guard)', () => {
  const shown = {
    case_id: 'c1',
    risk_score: 7.41,
    severity_band: 'critical',
    severity_source: 'source_asserted',
    urgency_band: 'low',
    priority_level: 'P3',
  };

  it('a response for the same case without bands keeps the bands on screen', () => {
    const next = keepAdvisoryBands(shown, { case_id: 'c1', risk_score: 7.41, status: 'investigating' });
    expect(next).toMatchObject({
      status: 'investigating',
      severity_band: 'critical',
      severity_source: 'source_asserted',
      urgency_band: 'low',
      priority_level: 'P3',
    });
  });

  it('a response that carries bands is taken as it is, including a priority turned off', () => {
    const next = keepAdvisoryBands(shown, {
      case_id: 'c1',
      severity_band: 'medium',
      severity_source: 'source_asserted',
      priority_level: undefined,
    });
    expect(next.severity_band).toBe('medium');
    expect(next.priority_level).toBeUndefined();
  });

  it('never carries bands across to a different case or onto a first load', () => {
    expect(keepAdvisoryBands(shown, { case_id: 'c2' }).severity_band).toBeUndefined();
    expect(keepAdvisoryBands(null, { case_id: 'c1' }).severity_band).toBeUndefined();
  });
});
