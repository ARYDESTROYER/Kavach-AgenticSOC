/**
 * The audit event table contract (Round 14 SPEC §4.5.5): the Console's mirror in
 * `events.ts` must equal the one fixture, `backend/app/audit/event_categories.json`,
 * which the read API labels every record with. Any drift (a new action, a renamed
 * label, a moved category) fails here until both sides agree.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_PREFIXES,
  AUDIT_ACTOR_LABELS,
  AUDIT_ACTOR_TOKENS,
  AUDIT_CATEGORIES,
  AUDIT_EVENT_TABLE_VERSION,
  AUDIT_LEGACY_EVENTS,
  AUDIT_QUICK_VIEWS,
  AUDIT_QUICK_VIEWS_HELP,
  actorLabel,
  auditEventGroups,
  categoryLabel,
  eventFilterLabel,
  isAuditCategory,
  quickViewActive,
} from '../events';

const FIXTURE = path.resolve(__dirname, '../../../../../../backend/app/audit/event_categories.json');
const table = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  version: number;
  categories: unknown[];
  legacy_events: unknown[];
  action_prefixes: unknown[];
  actions: unknown[];
  actors: { agent: string[]; system: string[] };
  actor_labels: Record<string, string>;
};

/** The router's `event` key grammar (SPEC §4.5.1). */
const EVENT_KEY = /^[a-z_]{1,32}(\.[a-z_]{1,32})?$/;

describe('audit event table mirror', () => {
  it('matches the backend fixture entry for entry', () => {
    expect(AUDIT_EVENT_TABLE_VERSION).toBe(table.version);
    expect(AUDIT_CATEGORIES).toEqual(table.categories);
    expect(AUDIT_LEGACY_EVENTS).toEqual(table.legacy_events);
    expect(AUDIT_ACTION_PREFIXES).toEqual(table.action_prefixes);
    expect(AUDIT_ACTIONS).toEqual(table.actions);
    expect(AUDIT_ACTOR_TOKENS).toEqual(table.actors);
    expect(AUDIT_ACTOR_LABELS).toEqual(table.actor_labels);
  });

  it('labels categories, actions, prefixed actions, families and unknown tokens', () => {
    expect(isAuditCategory('access')).toBe(true);
    expect(categoryLabel('config')).toBe('Configuration and data');
    expect(eventFilterLabel('access')).toBe('Any event in access and identity');
    expect(eventFilterLabel('user.role_changed')).toBe('User role changed');
    // An action with a known prefix but no exact entry reads as the read API names it.
    expect(eventFilterLabel('runbook.something_new')).toBe('Runbook something new');
    expect(eventFilterLabel('auth')).toBe('Any sign-in event');
    expect(eventFilterLabel('es_query')).toBe('Log query');
    expect(eventFilterLabel('mystery')).toBe('mystery');
  });

  it('gives legacy actor tokens a friendly name and leaves others as stored', () => {
    expect(actorLabel('run_playbook')).toBe(table.actor_labels.run_playbook);
    expect(actorLabel('trao')).toBe('trao');
  });

  it('builds an Event menu grouped by category whose every value the URL can carry', () => {
    const groups = auditEventGroups();
    expect(groups.map((g) => g.category)).toEqual(AUDIT_CATEGORIES.map((c) => c.id));
    for (const group of groups) {
      expect(group.options[0]).toMatchObject({ value: group.category, kind: 'category' });
      const values = group.options.map((o) => o.value);
      expect(new Set(values).size).toBe(values.length);
      for (const value of values) expect(value).toMatch(EVENT_KEY);
    }
    const all = groups.flatMap((g) => g.options.map((o) => o.value));
    for (const action of AUDIT_ACTIONS) expect(all).toContain(action.action);
  });

  it('never lists two choices under one name', () => {
    const labels = auditEventGroups().flatMap((g) => g.options.map((o) => o.label));
    expect(new Set(labels).size).toBe(labels.length);
    // `audit_view` (older rows, no structured action) and `audit.viewed` share a name in
    // the fixture; the older type says which rows it matches, in the menu and on its chip.
    expect(eventFilterLabel('audit.viewed')).toBe('Audit log viewed');
    expect(eventFilterLabel('audit_view')).toBe('Audit log viewed (older rows)');
  });

  it('has five quick views, each one URL-safe filter named for exactly what it matches', () => {
    // The read API takes one `event` value, so a view never promises more than its one
    // filter matches; each label is the words its chip shows (no "and role", no "every").
    expect(AUDIT_QUICK_VIEWS.map((q) => [q.label, q.event ?? null, q.outcome ?? null, q.scope])).toEqual([
      ['Sign-in failed', 'auth.login_failed', null, 'people'],
      ['Access denied', null, 'denied', 'people'],
      ['User events', 'user', null, 'people'],
      ['Settings events', 'settings', null, 'people'],
      ['Configuration and data', 'config', null, 'people'],
    ]);
    for (const qv of AUDIT_QUICK_VIEWS) {
      expect(Boolean(qv.event) || Boolean(qv.outcome)).toBe(true);
      if (qv.event) expect(qv.event).toMatch(EVENT_KEY);
    }
    // The chip a view leaves names the same filter as the button.
    expect(eventFilterLabel('auth.login_failed')).toBe('Sign-in failed');
    expect(eventFilterLabel('user')).toBe('Any user event');
    expect(eventFilterLabel('settings')).toBe('Any settings event');
    expect(eventFilterLabel('config')).toBe('Any event in configuration and data');
    // A family view is a prefix family, and the categories it points older rows to exist.
    expect(AUDIT_ACTION_PREFIXES.map((p) => p.prefix)).toEqual(expect.arrayContaining(['user', 'settings']));
    expect(AUDIT_QUICK_VIEWS_HELP).toContain('Access and identity or Configuration and data');
  });

  it('names in the help tip every quick view that only rows recorded since Round 14 match', () => {
    expect(AUDIT_QUICK_VIEWS_HELP).toBe(
      'Each quick view sets one filter, shown as a chip. Sign-in failed, User events and Settings events match rows ' +
        'recorded since Round 14; for older rows, pick Access and identity or Configuration and data in the Event menu.',
    );
    // An event token that is not a category (an action, or an action family) is matched
    // against the Round 14 `action` field only: older rows carry no such token, so the
    // tip must say the view leaves them out. A category view and an outcome view match
    // older rows too (the category through the legacy table, Denied through derivation).
    const legacyTypes = new Set(AUDIT_LEGACY_EVENTS.map((e) => e.action_type));
    const [named] = AUDIT_QUICK_VIEWS_HELP.split(' match rows recorded since Round 14');
    for (const qv of AUDIT_QUICK_VIEWS) {
      const roundFourteenOnly = Boolean(qv.event && !isAuditCategory(qv.event) && !legacyTypes.has(qv.event));
      expect({ view: qv.label, named: named.includes(qv.label) }).toEqual({ view: qv.label, named: roundFourteenOnly });
    }
  });

  it('marks a quick view active only when its exact filters are applied', () => {
    const [signIn, denied] = AUDIT_QUICK_VIEWS;
    expect(quickViewActive(signIn, 'auth.login_failed', null)).toBe(true);
    expect(quickViewActive(signIn, 'auth.login_failed', 'failure')).toBe(false);
    expect(quickViewActive(denied, null, 'denied')).toBe(true);
    expect(quickViewActive(denied, 'auth', 'denied')).toBe(false);
  });

  it('never shows an em dash, an en dash or the retired word in Console-authored labels', () => {
    const labels = [
      ...auditEventGroups().flatMap((g) => [g.label, ...g.options.map((o) => o.label)]),
      ...AUDIT_QUICK_VIEWS.map((q) => q.label),
      AUDIT_QUICK_VIEWS_HELP,
    ];
    for (const label of labels) {
      expect(label).not.toMatch(/[–—]/);
      expect(label.toLowerCase()).not.toContain('playbook');
    }
  });
});
