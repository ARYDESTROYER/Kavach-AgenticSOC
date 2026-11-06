/**
 * Round-5 Sett-A — the data-driven Settings section registry.
 *
 * Proves the SINGLE source of truth (`settings-sections.ts`) is internally consistent
 * and that the three formerly hand-synced structures are now DERIVED from it:
 *   - the `SectionId` union ⇄ registry ids,
 *   - the grouped rail (`SECTION_GROUPS`) preserves order,
 *   - the per-section dirty map (`SECTION_KEYS`) is derived from `ownedKeys`,
 *   - `settings-dirty` re-exports the SAME derived `SECTION_KEYS` (no drift),
 *   - `FULL_WIDTH_SECTIONS` names the table and editor sections (Round 14, C9 A),
 *   - every section has a Component + the lookup covers every id.
 *
 * Pure data assertions — no rendering, no DOM.
 */
import { describe, it, expect } from 'vitest';

import {
  SETTINGS_SECTIONS,
  SECTION_GROUPS,
  SECTION_BY_ID,
  SECTION_KEYS,
  FULL_WIDTH_SECTIONS,
  ALL_SECTIONS,
  isSectionId,
} from '../settings-sections';
import { SECTION_KEYS as DIRTY_SECTION_KEYS } from '../../settings-dirty';
import { SETTINGS_SECTIONS_META, searchJumpTargets } from '../settings-sections-meta';

/** The exact set of section ids the page must keep routable (deep-link back-compat). */
const EXPECTED_IDS = [
  'profile',
  'account_security',
  'sessions',
  'customization',
  'general',
  'models',
  'discounted-inference', // NEW (Round 14 D30: moved here from the Jobs page)
  'chat_agent', // NEW (chat revamp: the curated Chat assistant editor)
  'keys',
  'detection',
  'detection_rules', // NEW (Round-5 G6 R2: unified "Detection & rules" home)
  'cases',
  'case_policy', // NEW (Round-6: mounts the orphaned G6 SLA / priority / suppression editors)
  'automation',
  'standup',
  'notifications',
  'enrichment',
  'knowledge',
  'runbooks', // NEW (Round 14: every Preferences.runbooks key)
  'admin_users',
  'roles', // NEW (Round-5 Sett-B: split out of Users into Security & access)
  'security',
  'admin_sessions',
  'appearance',
  'release_updates',
  'advanced',
  'advanced_all', // NEW (Round-5 Sett-C: schema-driven "All settings" generic renderer)
  'demo',
  'storage',
  'data_export',
  'danger', // NEW (Round-5 Sett-B: isolated Danger zone, last)
].sort();

describe('settings section registry — single source of truth', () => {
  it('registers every expected section id exactly once', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id).sort();
    expect(ids).toEqual(EXPECTED_IDS);
    // no duplicate ids
    expect(new Set(ids).size).toBe(ids.length);
    expect(ALL_SECTIONS).toBe(SETTINGS_SECTIONS);
  });

  it('exposes a lookup covering every id, each with a Component', () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(SECTION_BY_ID[s.id]).toBe(s);
      expect(typeof s.Component).toBe('function');
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.blurb.length).toBeGreaterThan(0);
    }
    // No stray keys beyond the registered ids.
    expect(Object.keys(SECTION_BY_ID).sort()).toEqual(EXPECTED_IDS);
  });

  it('isSectionId accepts registered ids and rejects unknowns', () => {
    expect(isSectionId('general')).toBe(true);
    expect(isSectionId('admin_users')).toBe(true);
    expect(isSectionId('demo')).toBe(true);
    expect(isSectionId('not-a-section')).toBe(false);
    expect(isSectionId('')).toBe(false);
  });
});

describe('grouped rail derivation (Round-5 Sett-B: 5 groups, Security promoted)', () => {
  it('groups sections in the canonical FIVE-group order, non-empty', () => {
    expect(SECTION_GROUPS.map((g) => g.id)).toEqual([
      'account',
      'general',
      'integrations',
      'security_access',
      'organization',
    ]);
    for (const g of SECTION_GROUPS) expect(g.sections.length).toBeGreaterThan(0);
  });

  it('every registered section appears in exactly one group', () => {
    const grouped = SECTION_GROUPS.flatMap((g) => g.sections.map((s) => s.id)).sort();
    expect(grouped).toEqual(EXPECTED_IDS);
  });

  it('preserves the registry order within a group', () => {
    // General group order (Round-6 inserts case_policy after cases).
    const general = SECTION_GROUPS.find((g) => g.id === 'general')!;
    expect(general.sections.map((s) => s.id)).toEqual([
      'general',
      'models',
      'discounted-inference',
      'chat_agent',
      'detection',
      'detection_rules',
      'cases',
      'case_policy',
      'automation',
      'standup',
    ]);
    // Integrations: Runbooks sits right after Knowledge (the Intelligence settings).
    const integrations = SECTION_GROUPS.find((g) => g.id === 'integrations')!;
    expect(integrations.sections.map((s) => s.id)).toEqual([
      'notifications',
      'enrichment',
      'knowledge',
      'runbooks',
    ]);
    // Security & access group: Users → Roles → SSO → Active sessions → Secret keys.
    const sec = SECTION_GROUPS.find((g) => g.id === 'security_access')!;
    expect(sec.sections.map((s) => s.id)).toEqual([
      'admin_users',
      'roles',
      'security',
      'admin_sessions',
      'keys',
    ]);
    // Organization group ends with the isolated Danger zone (last).
    const org = SECTION_GROUPS.find((g) => g.id === 'organization')!;
    expect(org.sections.map((s) => s.id)).toEqual([
      'appearance',
      'release_updates',
      'advanced',
      'advanced_all',
      'demo',
      'storage',
      'data_export',
      'danger',
    ]);
    expect(org.sections[org.sections.length - 1].id).toBe('danger');
  });

  it('caps the hierarchy at TWO levels (group → section; no nested sub-groups)', () => {
    // Each section is a flat leaf under exactly one group — no section carries its own
    // children/sub-sections, so the rail can never exceed group → section → in-page.
    for (const s of SETTINGS_SECTIONS) {
      expect('children' in s).toBe(false);
    }
  });
});

describe('SECTION_KEYS is derived from ownedKeys (kills the 3-file hand-sync)', () => {
  it('re-exported identically from settings-dirty', () => {
    expect(DIRTY_SECTION_KEYS).toBe(SECTION_KEYS);
  });

  it('contains only sections that declare ownedKeys', () => {
    for (const s of SETTINGS_SECTIONS) {
      if (s.ownedKeys && s.ownedKeys.length > 0) {
        expect(SECTION_KEYS[s.id]).toEqual(s.ownedKeys);
      } else {
        expect(s.id in SECTION_KEYS).toBe(false);
      }
    }
  });

  it('tracks the auto-close keys on detection (Round-5 R1) and both rag homes', () => {
    expect(SECTION_KEYS.detection).toContain('auto_close');
    expect(SECTION_KEYS.detection).toContain('fp_auto_close');
    // rag is owned by BOTH knowledge and advanced (honest dual-dot signal).
    expect(SECTION_KEYS.knowledge).toContain('rag');
    expect(SECTION_KEYS.advanced).toContain('rag');
    expect(SECTION_KEYS.storage).toEqual(['storage_lifecycle']);
    expect(SECTION_KEYS.release_updates).toEqual(['release_updates']);
    expect(SECTION_KEYS.chat_agent).toEqual(['chat_agent']);
    // Round 14: the two new sections save through the page like every preference.
    expect(SECTION_KEYS.runbooks).toEqual(['runbooks']);
    expect(SECTION_KEYS['discounted-inference']).toEqual(['batch']);
  });

  it('leaves the embedded / self-saving sections out of the dirty map', () => {
    // These manage their own save lifecycle (embedded bodies, write-only keys,
    // enrichment's self-contained provider editor, roles matrix, danger-zone resets).
    for (const id of ['profile', 'account_security', 'sessions', 'customization', 'keys', 'enrichment', 'admin_users', 'roles', 'admin_sessions', 'appearance', 'demo', 'data_export', 'danger']) {
      expect(id in SECTION_KEYS).toBe(false);
    }
  });
});

describe('Round-6 de-dup — automation links to the single rule editor (deep-links intact)', () => {
  it('keeps automation AND the new case_policy as deep-linkable sections (no route deleted)', () => {
    // The automation section is retained (not retired) so `#/settings?s=automation`
    // still resolves; case_policy is the new mount point for the orphaned G6 editors.
    for (const id of ['automation', 'case_policy']) {
      expect(isSectionId(id)).toBe(true);
      expect(SECTION_BY_ID[id]).toBeTruthy();
    }
  });

  it('the automation link-card target (detection_rules) is a real, deep-linkable section', () => {
    // AutomationSection routes via setSection('detection_rules'); that target must exist.
    expect(isSectionId('detection_rules')).toBe(true);
    expect(SECTION_BY_ID.detection_rules).toBeTruthy();
  });

  it('the case_policy section owns the orphaned G6 editor keys plus analyst policies', () => {
    // `analyst_rule_policies` is the operator's rule-level "declared benign" list. It
    // belongs beside `suppression_rules` (the event-drop list) because an operator
    // reaching for one is choosing between the two.
    expect(SECTION_KEYS.case_policy).toEqual([
      'sla',
      'priority_matrix',
      'suppression_rules',
      'analyst_rule_policies',
    ]);
  });

  it('detection owns the asset-criticality keys (its new Asset criticality card)', () => {
    expect(SECTION_KEYS.detection).toContain('asset_networks');
    expect(SECTION_KEYS.detection).toContain('asset_criticality');
  });
});

describe('FULL_WIDTH_SECTIONS (Round 14, C9 A: tables and wide editors)', () => {
  it('lets the table sections and the wide editors take the full content width', () => {
    // SPEC §4.9.6: Users, Roles, Sessions, Admin sessions and Enrichment providers take
    // the full content width; so do the editors that lay out their own wide grids.
    for (const id of [
      'sessions',
      'admin_users',
      'roles',
      'admin_sessions',
      'enrichment',
      'customization',
      'detection_rules',
      'notifications',
      'appearance',
      'demo',
    ]) {
      expect(FULL_WIDTH_SECTIONS.has(id)).toBe(true);
    }
  });

  it('keeps every form section on the 44rem form measure', () => {
    for (const id of [
      'general',
      'models',
      'discounted-inference',
      'chat_agent',
      'detection',
      'cases',
      'case_policy',
      'automation',
      'standup',
      'knowledge',
      'runbooks',
      'security',
      'keys',
      'release_updates',
      'advanced',
      'advanced_all',
      'storage',
      'data_export',
      'profile',
      'account_security',
      // DangerZone renders itself at form width so each tier's button stays near its
      // name; the registry says the same, so the save bar and footer follow it.
      'danger',
    ]) {
      expect(FULL_WIDTH_SECTIONS.has(id)).toBe(false);
    }
  });

  it('derives the set from the registry width, nothing else', () => {
    const declared = SETTINGS_SECTIONS.filter((s) => s.width === 'full').map((s) => s.id).sort();
    expect([...FULL_WIDTH_SECTIONS].sort()).toEqual(declared);
  });
});

describe('section copy (Round 14, C9 A)', () => {
  it('gives every section a help tip and keeps the copy plain', () => {
    for (const meta of SETTINGS_SECTIONS_META) {
      expect(meta.help, meta.id).toBeTruthy();
      const text = [meta.title, meta.blurb, meta.help ?? ''].join(' ');
      expect(text, meta.id).not.toMatch(/\u2014/);
      expect(text.toLowerCase(), meta.id).not.toContain('playbook');
    }
  });

  it('renames Appearance & customization to Appearance', () => {
    expect(SECTION_BY_ID.customization.title).toBe('Appearance');
  });
});

describe('Chat assistant is findable (Settings search + command palette)', () => {
  const allowAll = () => true;
  // The words an operator types for the chat_agent knobs: the section title, its blurb
  // and its keywords form the haystack (the console map indexes the same text).
  for (const query of ['chat', 'assistant', 'token', 'tokens', 'email', 'e-mail', 'enrichment', 'per-question', 'internal domains', 'type out answers']) {
    it(`"${query}" finds the Chat assistant section`, () => {
      const hits = searchJumpTargets(query, allowAll).filter((t) => !t.anchor);
      expect(hits.map((t) => t.section)).toContain('chat_agent');
    });
  }
});

describe('Runbooks settings search finds step approvals', () => {
  const allowAll = () => true;
  // The command palette ranks a page whose name is the query (Approvals) above every
  // Settings target (command-palette tests), so the setting's own words can be keywords.
  for (const query of ['step approvals', 'step approval', 'Step approvals']) {
    it(`"${query}" finds the Runbooks section and its Publishing and review card`, () => {
      const hits = searchJumpTargets(query, allowAll);
      expect(hits.some((t) => t.section === 'runbooks' && !t.anchor)).toBe(true);
      expect(hits.some((t) => t.section === 'runbooks' && t.anchor === 'runbooks-publishing')).toBe(true);
    });
  }
});
