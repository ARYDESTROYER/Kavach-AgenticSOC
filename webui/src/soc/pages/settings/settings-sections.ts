/**
 * settings-sections — the SINGLE source of truth for the Settings page (Round-5 Sett-A).
 *
 * Historically the Settings page hand-synced THREE parallel structures: a `SectionId`
 * union, a `SECTION_GROUPS` rail array, and a `SECTION_KEYS` dirty-map (in
 * `settings-dirty.ts`). This module collapses all three into one authoritative table —
 * {@link SETTINGS_SECTIONS} — an array of {@link SettingsSectionDef}
 * `{ id, group, perm, ownedKeys, title, blurb, icon, Component }`. From it we DERIVE:
 *   - {@link SectionId} (the id union),
 *   - {@link SECTION_GROUPS} (the grouped rail),
 *   - {@link SECTION_KEYS} (consumed by `settings-dirty.ts` for the per-section dot),
 *   - {@link GRID_SECTIONS} (sections that render their own full-width card grid),
 *   - the render lookup (kills the giant switch).
 *
 * Each section's renderer receives a single {@link SectionRenderContext} and picks the
 * props it needs. This keeps the registry data-driven while every section keeps its
 * exact current label / id / markup / save behaviour (Sett-B relabels later).
 *
 * Round-5 Coupling-A — the COMPONENT-FREE half (section metadata + the search/jump
 * helpers + the `SECTION_KEYS` dirty-map) now lives in `settings-sections-meta.ts`, which
 * this module re-exports UNCHANGED. Only the two EAGER consumers that never touch a
 * renderer — `components/CommandPalette.tsx` (the always-on Cmd-K jump) and
 * `pages/settings-dirty.ts` — import that meta module directly, so the heavy Settings
 * renderer tree (BrandingEditor / RolesInner / DangerZone / …) no longer rides the eager
 * CommandPalette into the first-paint entry chunk. This file layers the `Component`
 * renderers on top of the metadata; it is still the one import site for the full page.
 *
 * IMPORTANT (import graph): this file imports the section renderer components. It is
 * imported by `settings-dirty.ts` (for `SECTION_KEYS`) — which is in turn imported by
 * `useDirtyDraft` (only for `deepEqual`). No section renderer imports `useDirtyDraft`,
 * so there is NO import cycle. `settings-dirty.ts` still owns the pure diff helpers.
 *
 * Security: this module carries no secrets and renders nothing itself; it only wires
 * operator-facing section metadata + renderer functions.
 */
import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

import type {
  ConfiguredStatus,
  ModelsResponse,
  Preferences,
} from '@/lib/types';

import type { NavigateFn, SecProps } from './primitives';

// The component-free metadata + search/jump helpers + the dirty-map (single source).
import {
  SETTINGS_SECTIONS_META,
  SECTION_GROUP_ORDER,
  type SectionMeta,
  type SectionGroupId,
  type SectionPerm,
  type SectionId,
} from './settings-sections-meta';

// Section renderers (each keeps its exact former markup + behaviour).
import { GeneralSection } from './general';
import { ModelsSection } from './models';
import { ChatAgentSection } from './chat-agent';
import { KeysSection } from './keys';
import { DetectionSection } from './detection';
import { DetectionRulesSection } from './detection-rules';
import { CaseIdSection } from './cases';
import { CasePolicySection } from './case-policy';
import { AutomationSection } from './automation';
import { StandupSection } from './standup';
import { KnowledgeSection } from './knowledge';
import { EnrichmentSection } from './enrichment';
import { AdvancedSection } from './advanced';
import { AdvancedSchemaSection } from './advanced-schema';
import { OrgSecuritySection } from './security';
import { DataExportSection } from './data-export';
import { StorageLifecycleSection } from './storage';
import { ReleaseUpdatesSection } from './release-updates';

// Embedded page bodies re-hosted as Settings sub-sections (unchanged wiring).
import { AccountInner } from '@/soc/pages/Account';
import { SessionsInner } from '@/soc/pages/Sessions';
import { UsersInner } from '@/soc/pages/Users';
import { AdminSessionsInner } from '@/soc/pages/AdminSessions';
import { RolesInner } from '@/soc/pages/Roles';
import { SecurityMfaInner } from '@/soc/pages/Security';
import { CustomizationSection } from '@/soc/components/CustomizationSection';
import { BrandingEditor } from '@/soc/components/BrandingEditor';
import { NotificationsEditor } from '@/soc/components/NotificationsEditor';
import { DemoModeSection } from '@/soc/components/DemoModeSection';
import { DangerZone } from '@/soc/components/DangerZone';

/* ------------------------------------------------------- re-export the meta -- *
 * Everything the metadata module owns is re-exported here UNCHANGED so every existing
 * `import { ... } from '.../settings-sections'` site keeps working (the search helpers,
 * SETTING_ANCHORS, GRID_SECTIONS, SECTION_KEYS, isSectionId, the id/group/perm types, …). */
export {
  SETTINGS_SECTIONS_META,
  SECTION_GROUP_ORDER,
  SECTION_META_BY_ID,
  SECTION_GROUPS_META,
  GRID_SECTIONS,
  SECTION_KEYS,
  isSectionId,
  SETTING_ANCHORS,
  allJumpTargets,
  searchJumpTargets,
  sectionMatchesQuery,
  matchedAnchorsForSection,
} from './settings-sections-meta';
export type {
  SectionMeta,
  SectionGroupId,
  SectionPerm,
  SectionId,
  SettingAnchor,
  SettingsJumpTarget,
  SectionGroupMeta,
} from './settings-sections-meta';

/* -------------------------------------------------------------- render ctx -- */

/**
 * The single context handed to every section renderer. A section reads only the fields
 * it needs; the page owns all this state. `prefs`/`update` are guaranteed non-null when
 * a renderer runs (the page early-returns before rendering a section body).
 */
export interface SectionRenderContext {
  prefs: Preferences;
  /** Last server-saved snapshot; lifecycle apply must never use an unsaved draft. */
  persistedPrefs: Preferences;
  update: (p: Partial<Preferences>) => void;
  models: ModelsResponse | null;
  configured: ConfiguredStatus;
  readOnly: boolean;
  onNavigate: NavigateFn;
  /** Switch to another Settings section by id (used by the Profile → 2FA hand-off). */
  setSection: (id: SectionId) => void;
  /** Write-only secret draft state (Keys section only). */
  secretDraft: Record<string, string>;
  setSecretDraft: (d: Record<string, string>) => void;
  /** Settings-wide save in flight; secret fields stay stable until it settles. */
  saving: boolean;
}

/** A section renderer: given the shared context, returns the section body. */
export type SectionRenderer = (ctx: SectionRenderContext) => React.ReactElement;

/**
 * One Settings section — the SINGLE source of truth for id/group/perm/keys/render. It
 * is the {@link SectionMeta} shape (metadata) plus the `Component` renderer, so a
 * consumer can index the same table for both the rail label AND the body.
 */
export interface SettingsSectionDef extends SectionMeta {
  id: string;
  group: SectionGroupId;
  perm?: SectionPerm;
  ownedKeys?: readonly string[];
  title: string;
  blurb: string;
  icon: LucideIcon;
  keywords?: string[];
  grid?: boolean;
  /** The section body renderer. */
  Component: SectionRenderer;
}

/* -------------------------------------------------------------- registry --- */

const h = React.createElement;

/**
 * id → renderer map. Kept beside the metadata (which lives in `settings-sections-meta.ts`)
 * so the metadata can be imported component-free; the two are paired below into
 * {@link SETTINGS_SECTIONS}. Every id in the metadata table MUST have an entry here.
 */
const SECTION_COMPONENTS: Record<string, SectionRenderer> = {
  profile: (ctx) =>
    h(AccountInner, {
      embedded: true,
      onNavigateToSecurity: () => ctx.setSection('account_security'),
    }),
  account_security: () => h(SecurityMfaInner, { embedded: true }),
  sessions: () => h(SessionsInner, { embedded: true }),
  customization: () => h(CustomizationSection),
  general: (ctx) =>
    h(GeneralSection, { prefs: ctx.prefs, update: ctx.update, onNavigate: ctx.onNavigate }),
  models: (ctx) =>
    h(ModelsSection, {
      prefs: ctx.prefs,
      update: ctx.update,
      models: ctx.models,
      onNavigate: ctx.onNavigate,
    }),
  chat_agent: (ctx) => h(ChatAgentSection, { prefs: ctx.prefs, update: ctx.update }),
  detection: (ctx) => h(DetectionSection, { prefs: ctx.prefs, update: ctx.update }),
  detection_rules: (ctx) => h(DetectionRulesSection, { prefs: ctx.prefs, update: ctx.update }),
  cases: (ctx) => h(CaseIdSection, { prefs: ctx.prefs, update: ctx.update }),
  case_policy: (ctx) => h(CasePolicySection, { prefs: ctx.prefs, update: ctx.update }),
  // The per-rule editor lives in the Detection & rules home now; this section links there
  // via `setSection('detection_rules')` (Round-6 de-dup).
  automation: (ctx) =>
    h(AutomationSection, {
      prefs: ctx.prefs,
      update: ctx.update,
      onOpenRules: () => ctx.setSection('detection_rules'),
    }),
  standup: (ctx) => h(StandupSection, { prefs: ctx.prefs, update: ctx.update }),
  notifications: (ctx) => h(NotificationsEditor, { prefs: ctx.prefs, update: ctx.update }),
  enrichment: (ctx) => h(EnrichmentSection, { prefs: ctx.prefs, update: ctx.update }),
  knowledge: (ctx) =>
    h(KnowledgeSection, { prefs: ctx.prefs, update: ctx.update, onNavigate: ctx.onNavigate }),
  admin_users: () => h(UsersInner, { embedded: true }),
  roles: () => h(RolesInner, { embedded: true }),
  security: (ctx) =>
    h(OrgSecuritySection, { prefs: ctx.prefs, update: ctx.update, configured: ctx.configured }),
  admin_sessions: () => h(AdminSessionsInner, { embedded: true }),
  keys: (ctx) =>
    h(KeysSection, {
      configured: ctx.configured,
      draft: ctx.secretDraft,
      setDraft: ctx.setSecretDraft,
      saving: ctx.saving,
      readOnly: ctx.readOnly,
    }),
  appearance: (ctx) => h(BrandingEditor, { readOnly: ctx.readOnly }),
  release_updates: (ctx) =>
    h(ReleaseUpdatesSection, {
      prefs: ctx.prefs,
      persistedPrefs: ctx.persistedPrefs,
      update: ctx.update,
      readOnly: ctx.readOnly,
    }),
  advanced: (ctx) =>
    h(AdvancedSection, { prefs: ctx.prefs, update: ctx.update, onNavigate: ctx.onNavigate }),
  advanced_all: (ctx) => h(AdvancedSchemaSection, { prefs: ctx.prefs, update: ctx.update }),
  demo: () => h(DemoModeSection),
  storage: (ctx) =>
    h(StorageLifecycleSection, {
      prefs: ctx.prefs,
      persistedPrefs: ctx.persistedPrefs,
      update: ctx.update,
      readOnly: ctx.readOnly,
    }),
  data_export: () => h(DataExportSection),
  danger: () => h(DangerZone),
};

/**
 * The one authoritative section table. Order is authoritative (drives rail order within
 * each group). Built by pairing the component-free metadata ({@link SETTINGS_SECTIONS_META},
 * in `settings-sections-meta.ts`) with its `Component` renderer — every existing section +
 * its exact current label/id/render is preserved.
 */
export const SETTINGS_SECTIONS: SettingsSectionDef[] = SETTINGS_SECTIONS_META.map((m) => {
  const Component = SECTION_COMPONENTS[m.id];
  if (!Component) {
    // A metadata entry without a renderer is a programming error (kept explicit so a
    // future new section can't silently render nothing).
    throw new Error(`settings-sections: no Component for section "${m.id}"`);
  }
  return { ...m, Component };
});

/* -------------------------------------------------------------- derived ---- */

/** All sections, in registry (rail) order. */
export const ALL_SECTIONS: SettingsSectionDef[] = SETTINGS_SECTIONS;

/** Fast id → section lookup (replaces the render switch). */
export const SECTION_BY_ID: Record<string, SettingsSectionDef> = Object.fromEntries(
  SETTINGS_SECTIONS.map((s) => [s.id, s]),
);

/** Grouped, rail-ordered view derived from the registry. */
export interface SectionGroup {
  id: SectionGroupId;
  label: string;
  sections: SettingsSectionDef[];
}

export const SECTION_GROUPS: SectionGroup[] = SECTION_GROUP_ORDER.map((g) => ({
  id: g.id,
  label: g.label,
  sections: SETTINGS_SECTIONS.filter((s) => s.group === g.id),
})).filter((g) => g.sections.length > 0);

// Re-export the primitive contract types for section-file convenience.
export type { NavigateFn, SecProps };
