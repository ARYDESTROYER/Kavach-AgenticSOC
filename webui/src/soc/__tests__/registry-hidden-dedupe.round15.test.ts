/**
 * Round 15 (SPEC §3.1): the 11 hidden `FEATURES` entries that repeated a visible child of
 * the same id and label are gone. This pins that the removal changed nothing a person can
 * reach: every removed id is still a page id with a route, keeps the label it had, is
 * still offered by the navigation and the command palette (both read the visible children)
 * under the same permission gate, and no hidden entry repeats a visible child again.
 */
import { describe, expect, it } from 'vitest';

import { NAV_CHILDREN, isPageId, navCurrentLabel, navLabel } from '../nav';
import { FEATURES, ROUTES, type PageId } from '../registry';

/** The removed hidden entries: id, the label they carried and their permission gate. */
const REMOVED: ReadonlyArray<readonly [PageId, string, string | null]> = [
  ['dashboard', 'Cyber Defence Center', null],
  ['investigate', 'Entity investigation', null],
  ['cost', 'Cost', 'cost:view'],
  ['models', 'Models', null],
  ['standup', 'Standup', null],
  ['knowledge', 'Knowledge corpus', 'rag:read'],
  ['runbooks', 'Runbooks', 'runbooks:read'],
  ['memory', 'Operator memory', 'memory:read'],
  ['personas', 'Agent personas', null],
  ['roles', 'Roles', 'roles:manage'],
  ['users', 'Users', 'users:manage'],
];

describe('the hidden duplicates removed in Round 15', () => {
  it.each(REMOVED)('"%s" keeps its route, label and gate', (id, label, gate) => {
    expect(isPageId(id)).toBe(true);
    expect(ROUTES[id], `no route for ${id}`).toBeDefined();
    expect(navLabel(id)).toBe(label);
    const child = NAV_CHILDREN.find((c) => c.id === id);
    expect(child, `${id} is no longer a visible child`).toBeDefined();
    expect(child?.label).toBe(label);
    // The palette and the navigation offer the child, under the same gate as before
    // (`roles` and `users` were ungated hidden copies of gated children; the children's
    // gates always decided, so nothing a role could reach changed).
    expect(child?.perm ? `${child.perm.resource}:${child.perm.action}` : null).toBe(gate);
    expect(navCurrentLabel(child?.target ?? id)).toBeDefined();
  });

  it('leaves no hidden entry that repeats a visible child', () => {
    const childIds = new Set(NAV_CHILDREN.map((c) => c.id));
    const repeats = FEATURES.filter((f) => f.hidden && childIds.has(f.id)).map((f) => f.id);
    expect(repeats).toEqual([]);
  });

  it('keeps the hidden entries that have no visible child', () => {
    for (const id of ['catalog', 'playbooks', 'account', 'sessions', 'security', 'admin_sessions'] as PageId[]) {
      expect(FEATURES.find((f) => f.id === id)?.hidden, `${id} lost its hidden entry`).toBe(true);
      expect(isPageId(id)).toBe(true);
    }
  });
});
