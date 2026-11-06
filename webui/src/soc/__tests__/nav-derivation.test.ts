/**
 * nav.ts derivation-layer coverage (Round-6 nav batch).
 *
 * `nav.ts` is a thin derivation over the typed feature registry. Two invariants are
 * load-bearing but previously unguarded:
 *
 *   1. Every rail item (non-hidden feature) carries a REAL icon. `toNavItem` used to
 *      cast a missing icon to `undefined as unknown as LucideIcon`, converting a
 *      registry data mistake into a runtime white-screen when the shell rendered
 *      `<item.icon />`. It now fails fast at module-load instead; this pins that every
 *      derived NAV_ITEM has a defined, renderable icon.
 *
 *   2. `navLabel` sources its label from the registry (the single source of truth) for
 *      hidden-but-routable pages, only humanising a truly-unknown id as a last resort.
 */
import { describe, it, expect } from 'vitest';
import { NAV_FOOTER_ITEMS, NAV_ITEMS, navLabel } from '../nav';
import { FEATURES, type PageId } from '../registry';

describe('NAV_ITEMS — every rail item carries a real icon', () => {
  it('has a defined, renderable icon for every top-level nav item', () => {
    expect(NAV_ITEMS.length).toBeGreaterThan(0);
    for (const item of NAV_ITEMS) {
      expect(item.icon, `nav item ${item.id} is missing an icon`).toBeDefined();
      // A LucideIcon is a React component — a function or a forwardRef object.
      expect(['function', 'object']).toContain(typeof item.icon);
    }
  });
});

describe('navLabel — the registry is the authoritative label source', () => {
  // Pages that are hidden-but-routable only (NOT a rail item and NOT a disclosure
  // child), so navLabel must reach the FEATURES lookup rather than NAV_ITEMS/CHILDREN.
  const hiddenOnly: PageId[] = ['catalog', 'account', 'sessions', 'security', 'admin_sessions'];

  it.each(hiddenOnly)('resolves hidden page "%s" to its registry label', (id) => {
    const feat = FEATURES.find((f) => f.id === id);
    expect(feat, `registry has no feature ${id}`).toBeDefined();
    expect(navLabel(id)).toBe(feat!.label);
  });

  it('still resolves a rail item + a disclosure child to their registry labels', () => {
    expect(navLabel('cases')).toBe('Cases'); // top-level rail item
    expect(navLabel('case_manager')).toBe('Case Manager');
    expect(navLabel('standup')).toBe('Standup'); // disclosure child of Overview
  });

  it('places Case Manager directly beneath Cases in the Triage rail', () => {
    const triage = FEATURES.filter((feature) => feature.group === 'triage' && !feature.hidden);
    const casesIndex = triage.findIndex((feature) => feature.id === 'cases');
    expect(casesIndex).toBeGreaterThanOrEqual(0);
    expect(triage[casesIndex + 1]).toMatchObject({
      id: 'case_manager',
      label: 'Case Manager',
      perm: { resource: 'cases', action: 'read' },
    });
  });

  it('keeps Intelligence labels explicit and aligned with backend read grants', () => {
    const intelligence = FEATURES.find((feature) => feature.id === 'intelligence');
    // Round 14 (SPEC §4.8.2): one Runbooks entry replaces "Reference runbooks" and
    // "Response playbooks"; their old page ids redirect to it for one release.
    expect((intelligence?.children ?? []).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'knowledge', label: 'Knowledge corpus' },
      { id: 'runbooks', label: 'Runbooks' },
      { id: 'memory', label: 'Operator memory' },
      { id: 'personas', label: 'Agent personas' },
    ]);
    const permissions = Object.fromEntries(
      (intelligence?.children ?? []).map((child) => [child.id, child.perm]),
    );
    expect(permissions).toMatchObject({
      knowledge: { resource: 'rag', action: 'read' },
      runbooks: { resource: 'runbooks', action: 'read' },
      memory: { resource: 'memory', action: 'read' },
    });
    // No navigation entry, visible or hidden, gates on the retired `playbooks` resource.
    expect(FEATURES.some((feature) => feature.perm?.resource === 'playbooks')).toBe(false);
    // The read-only persona endpoint is authenticated but has no resource-specific
    // grant. The UI must not invent a stricter permission than the API contract.
    expect(permissions.personas).toBeUndefined();
  });

  it('gates Approvals with the proposal-list read grant', () => {
    expect(FEATURES.find((feature) => feature.id === 'approvals')?.perm).toEqual({
      resource: 'proposals',
      action: 'read',
    });
  });

  it('derives Docs as the single pinned footer destination', () => {
    expect(NAV_FOOTER_ITEMS.map((item) => item.id)).toEqual(['docs']);
    expect(NAV_ITEMS.some((item) => item.id === 'docs')).toBe(true);
    // D25: one name per page, the nav item and the page are both "Help Center".
    expect(navLabel('docs')).toBe('Help Center');
  });

  it('keeps the redundant Automated Scans surface out of primary navigation', () => {
    expect(NAV_ITEMS.some((item) => item.id === 'scans')).toBe(false);
    expect(FEATURES.find((feature) => feature.id === 'scans')).toMatchObject({
      hidden: true,
      label: 'Automated scans (legacy)',
    });
  });

  it('humanises a truly-unknown id only as the last resort', () => {
    expect(navLabel('made_up_page' as PageId)).toBe('Made up page');
  });
});
