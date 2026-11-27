/**
 * The navigation store reads open-group ids an earlier release stored (Round 14).
 *
 * Before Round 14 the Analytics group WAS the Metrics page, so a viewer who had it open
 * stored `metrics` in both copies of the open-group list: the `localStorage` mirror
 * (`soc.nav.openGroups`) and the server's `UserPrefs.misc.nav_open_groups`. Round 14 gave
 * the group its own id (`analytics`). Both copies are read through the legacy map,
 * de-duplicated, and the migrated list is written back, so the group stays open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const putUser = vi.fn((_body: unknown) => Promise.resolve({}));
vi.mock('@/lib/api', () => ({ api: { prefs: { putUser: (body: unknown) => putUser(body) } } }));
vi.mock('../prefs', () => ({ usePrefs: () => ({ prefs: { misc: {} }, ready: true }) }));

import { navStore } from '../nav-store';

const LS_OPEN_GROUPS = 'soc.nav.openGroups';
const stored = () => JSON.parse(window.localStorage.getItem(LS_OPEN_GROUPS) ?? 'null') as unknown;
const open = () => Array.from(navStore.getState().openGroups);

beforeEach(() => {
  window.localStorage.clear();
  putUser.mockClear();
});

describe('legacy open-group ids in the localStorage mirror', () => {
  it("reads a stored ['metrics'] as the open Analytics group and rewrites the mirror", () => {
    window.localStorage.setItem(LS_OPEN_GROUPS, JSON.stringify(['metrics']));
    navStore.beginSession();
    expect(navStore.getState().openGroups).toEqual(new Set(['analytics']));
    expect(stored()).toEqual(['analytics']);
    // The server copy is migrated by reconcile, not on the synchronous first read.
    expect(putUser).not.toHaveBeenCalled();
  });

  it('drops the duplicate when both ids were stored, keeping the first position', () => {
    window.localStorage.setItem(LS_OPEN_GROUPS, JSON.stringify(['overview', 'metrics', 'analytics']));
    navStore.beginSession();
    expect(open()).toEqual(['overview', 'analytics']);
    expect(stored()).toEqual(['overview', 'analytics']);
  });

  it('leaves a list already in current ids untouched', () => {
    const raw = JSON.stringify(['overview', 'analytics']);
    window.localStorage.setItem(LS_OPEN_GROUPS, raw);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    navStore.beginSession();
    expect(open()).toEqual(['overview', 'analytics']);
    expect(setItem).not.toHaveBeenCalledWith(LS_OPEN_GROUPS, expect.anything());
    setItem.mockRestore();
    expect(window.localStorage.getItem(LS_OPEN_GROUPS)).toBe(raw);
  });

  it('ignores a malformed mirror', () => {
    window.localStorage.setItem(LS_OPEN_GROUPS, '{not json');
    navStore.beginSession();
    expect(open()).toEqual([]);
  });
});

describe('legacy open-group ids in the server preferences', () => {
  it("reconciles misc nav_open_groups ['metrics'] to the open Analytics group and migrates both copies", () => {
    navStore.beginSession();
    navStore.reconcile({ nav_open_groups: ['metrics'] });
    expect(navStore.getState().openGroups).toEqual(new Set(['analytics']));
    expect(stored()).toEqual(['analytics']);
    expect(putUser).toHaveBeenCalledTimes(1);
    expect(putUser).toHaveBeenCalledWith({ misc: { nav_open_groups: ['analytics'] } });
  });

  it('de-duplicates the server list and writes the migrated list once', () => {
    navStore.beginSession();
    navStore.reconcile({ nav_open_groups: ['metrics', 'analytics', 'overview'] });
    expect(open()).toEqual(['analytics', 'overview']);
    expect(putUser).toHaveBeenCalledWith({ misc: { nav_open_groups: ['analytics', 'overview'] } });
  });

  it('writes nothing to the server when the server list is already current', () => {
    navStore.beginSession();
    navStore.reconcile({ nav_open_groups: ['analytics'] });
    expect(open()).toEqual(['analytics']);
    expect(putUser).not.toHaveBeenCalled();
  });

  it('a migration on reconcile does not count as a change the viewer made', () => {
    // A later reconcile in the same session (a new device value) still applies, which it
    // would not if the migration write had marked the key as the viewer's own change.
    navStore.beginSession();
    navStore.reconcile({ nav_open_groups: ['metrics'] });
    navStore.reconcile({ nav_open_groups: ['overview'] });
    expect(open()).toEqual(['overview']);
  });

  it("keeps the viewer's own change made before the reconcile", () => {
    navStore.beginSession();
    navStore.setGroupOpen('intelligence', true);
    putUser.mockClear();
    navStore.reconcile({ nav_open_groups: ['metrics'] });
    expect(open()).toEqual(['intelligence']);
    expect(putUser).not.toHaveBeenCalled();
  });
});
