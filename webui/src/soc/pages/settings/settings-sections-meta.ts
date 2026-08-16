/**
 * settings-sections-meta — the COMPONENT-FREE half of the Settings section registry
 * (Round-5 Coupling-A).
 *
 * `settings-sections.ts` is the single source of truth for the Settings page, but it
 * necessarily imports every heavy section renderer component (BrandingEditor,
 * RolesInner, DangerZone, the embedded Account/Sessions/Users bodies, …). Two EAGER
 * consumers only need the section *metadata* + the search/jump helpers, never a
 * renderer:
 *   - `components/CommandPalette.tsx` (mounted in the always-on AppShell) → the Cmd-K
 *     "jump to a setting" search (`searchJumpTargets`), and
 *   - `pages/settings-dirty.ts` → the per-section dirty map (`SECTION_KEYS`).
 *
 * Because both were importing them from `settings-sections.ts`, the whole Settings
 * component tree (~195 kB) was being pulled into the FIRST-PAINT entry chunk via the
 * eager CommandPalette. This module carries the metadata + helpers with **zero
 * component imports**, so those eager consumers pay nothing for the Settings renderers.
 * `settings-sections.ts` re-exports everything here unchanged (back-compat) and layers
 * the `Component` renderers on top.
 *
 * Security: pure operator-facing metadata + search helpers; no secrets, no network, no
 * rendering.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  Bell,
  Brush,
  Database,
  DatabaseBackup,
  FileText,
  FlaskConical,
  Globe,
  GitBranch,
  Hash,
  KeyRound,
  ListChecks,
  ListTree,
  MonitorSmartphone,
  Network,
  Palette,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Trash2,
  UserCircle2,
  Users as UsersIcon,
  Workflow,
  Zap,
} from 'lucide-react';

/* -------------------------------------------------------------- perms/groups */

/** A permission requirement (`resource:action`) gating a section. */
export interface SectionPerm {
  resource: string;
  action: string;
}

/**
 * The FIVE top-level Settings groups (Round-5 Sett-B IA regroup, 6 → 5). This is the
 * single highest-leverage IA change (RESEARCH_SETTINGS_IA §3.1): the old six groups
 * (`My account` · `Configuration` · `Triage logic` · `Integrations & context` ·
 * `Administration` · `Experimental`) collapse to five, with **Security promoted to its
 * own top-level group** (`security_access`) and `Roles` split out of Users.
 *
 * Only the group ids/labels + each section's `group` + display `title` change here —
 * every section `id` stays STABLE (deep-linked via `#/settings?s=<id>`). The router
 * (Sett-B redirect map) aliases the old standalone routes onto these sections.
 */
export type SectionGroupId =
  | 'account'
  | 'general'
  | 'integrations'
  | 'security_access'
  | 'organization';

export const SECTION_GROUP_ORDER: { id: SectionGroupId; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'general', label: 'General' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'security_access', label: 'Security & access' },
  { id: 'organization', label: 'Organization' },
];

/* -------------------------------------------------------------- meta shape -- */

/**
 * The COMPONENT-FREE metadata for one Settings section — id/group/perm/keys/title/
 * blurb/icon/keywords/grid. `settings-sections.ts` pairs each of these with a
 * `Component` renderer to build the full {@link SettingsSectionDef}.
 */
export interface SectionMeta {
  id: string;
  /** Rail group id (see {@link SECTION_GROUP_ORDER}). */
  group: SectionGroupId;
  /** When set, the section is gated by this `resource:action` grant. */
  perm?: SectionPerm;
  /**
   * The top-level `Preferences` keys this section OWNS. Drives the per-section
   * "modified" dot + is the SINGLE source `settings-dirty.ts` derives `SECTION_KEYS`
   * from. Sections whose save lifecycle is independent of the page dirty-map (the
   * embedded bodies, secret keys, enrichment) own no keys.
   */
  ownedKeys?: readonly string[];
  /** Display name (rail label + section title). */
  title: string;
  /** Short one-liner shown in search + as a subtitle. */
  blurb: string;
  icon: LucideIcon;
  /** Extra keywords so search finds a section by the settings it contains. */
  keywords?: string[];
  /**
   * True when this section renders its OWN full-width `SettingsGrid` of cards (no outer
   * Card chrome). Everything else sits on the shared single-card surface.
   */
  grid?: boolean;
}

/* -------------------------------------------------------------- registry --- */

/**
 * The one authoritative section metadata table. Order is authoritative (drives rail
 * order within each group). Every existing section + its exact current label/id is
 * preserved. `settings-sections.ts` maps each id → a `Component` renderer.
 */
export const SETTINGS_SECTIONS_META: SectionMeta[] = [
  /* ---- My account (Personal) ------------------------------------------- */
  {
    id: 'profile',
    group: 'account',
    title: 'Profile',
    blurb: 'Your display name, avatar, secondary email, timezone, and language.',
    icon: UserCircle2,
    keywords: ['profile', 'account', 'display name', 'avatar', 'photo', 'email', 'timezone', 'locale', 'language'],
  },
  {
    id: 'account_security',
    group: 'account',
    title: 'Security & two-factor',
    blurb: 'Enroll TOTP two-factor authentication for your own account.',
    icon: ShieldCheck,
    keywords: ['security', 'mfa', '2fa', 'two factor', 'totp', 'authenticator', 'password'],
  },
  {
    id: 'sessions',
    group: 'account',
    title: 'Sessions & activity',
    blurb: 'Where you are signed in, and your recent account activity.',
    icon: MonitorSmartphone,
    keywords: ['sessions', 'devices', 'activity', 'sign out', 'revoke', 'login history'],
  },
  {
    id: 'customization',
    group: 'account',
    title: 'Appearance & customization',
    blurb: 'Your theme, saved views, and (admin) terminology + org defaults.',
    icon: Palette,
    keywords: ['theme', 'dark mode', 'light mode', 'appearance', 'saved views', 'views', 'terminology', 'labels', 'rename', 'customize', 'customization', 'columns'],
  },

  /* ---- General (org, low blast radius) ---------------------------------- */
  {
    id: 'general',
    group: 'general',
    title: 'Data scope',
    blurb: 'Index pattern, entity fields, severity threshold, and polling.',
    icon: Database,
    grid: true,
    keywords: ['data view', 'index', 'fields', 'polling', 'poll', 'lookback', 'timestamp', 'severity'],
    ownedKeys: [
      'data_view_pattern',
      'time_field',
      'source_ip_field',
      'user_field',
      'host_field',
      'rule_field',
      'rule_name_field',
      'severity_field',
      'severity_threshold',
      'investigate_lookback',
      'polling_enabled',
      'poll_interval_seconds',
      'poll_batch_size',
      'cold_start_lookback_minutes',
    ],
  },
  {
    id: 'models',
    group: 'general',
    title: 'Models',
    blurb: 'The model used for each agent role.',
    icon: Sparkles,
    keywords: ['llm', 'model', 'router', 'investigator', 'formatter', 'chat', 'embedding', 'anthropic', 'openai'],
    ownedKeys: [
      'router_model',
      'investigator_model',
      'formatter_model',
      'standup_model',
      'chat_model',
      'overview_model',
      'embedding_model',
    ],
  },
  {
    id: 'detection',
    group: 'general',
    title: 'Detection',
    blurb: 'Clustering, risk weights, escalation, auto-close, and cross-source correlation.',
    icon: Workflow,
    grid: true,
    keywords: ['correlation', 'risk', 'weights', 'escalation', 'auto-close', 'autonomy', 'false positive', 'cross-source', 'entity', 'asset criticality', 'asset', 'cidr', 'crown jewel'],
    // Both the legacy `fp_auto_close` scalar AND the live `auto_close` policy block are
    // owned here (Round-5 R1 moves the auto-close editor onto `prefs.auto_close`).
    // `asset_networks`/`asset_criticality` are owned here too (Round-6: the Asset
    // criticality editor sits beside Risk weights — the deterministic risk model reads
    // both, so the modified-dot must track them).
    ownedKeys: [
      'default_correlation',
      'risk_weights',
      'escalation_confidence',
      'critical_severity',
      'fp_auto_close',
      'auto_close',
      'cross_source_correlation',
      'asset_networks',
      'asset_criticality',
    ],
  },
  {
    id: 'detection_rules',
    group: 'general',
    title: 'Detection & rules',
    blurb: 'Author detection rules (match/threshold, anomaly) and case-automation rules in one place.',
    icon: ListChecks,
    // Gate on the UNIFIED `rules` resource the router enforces (G6 R9 / M2), NOT the
    // legacy `automation` resource — so a custom role granted `rules:read` sees this
    // section (and the editor loads / ledger / rollback all resolve on the same grant).
    perm: { resource: 'rules', action: 'read' },
    grid: true,
    keywords: [
      'rules',
      'detection rule',
      'detection & rules',
      'match',
      'threshold',
      'correlation',
      'suppression',
      'anomaly',
      'baseline',
      'case automation',
      'automation',
      'rule catalog',
      'condition',
      'predicate',
      'mitre',
    ],
    ownedKeys: ['rule_catalog', 'threshold_automation'],
  },
  {
    id: 'cases',
    group: 'general',
    title: 'Cases',
    blurb: 'Human-facing case-ID nomenclature and live preview.',
    icon: Hash,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['case id', 'case number', 'nomenclature', 'sequence', 'prefix', 'template'],
    ownedKeys: ['case_id_format'],
  },
  {
    id: 'case_policy',
    group: 'general',
    title: 'SLA, priority & suppression',
    blurb: 'Advisory SLA targets and the impact × urgency priority matrix, plus operator suppression rules that drop known-benign events before triage.',
    icon: Timer,
    perm: { resource: 'settings', action: 'manage' },
    grid: true,
    keywords: [
      'sla',
      'service level',
      'response time',
      'resolution',
      'priority',
      'priority matrix',
      'impact',
      'urgency',
      'suppression',
      'suppress',
      'drop event',
      'mute',
      'noise',
      'analyst policy',
      'declared benign',
    ],
    ownedKeys: ['sla', 'priority_matrix', 'suppression_rules', 'analyst_rule_policies'],
  },
  {
    id: 'automation',
    group: 'general',
    title: 'Automation',
    // Round-6: the per-rule editor moved to the unified "Detection & rules" home; this
    // section keeps only the master enable switch + the #3 explainer and links there.
    blurb: 'The master switch for threshold automation — rules that react to a case after the deterministic decision (authored in Detection & rules).',
    icon: Zap,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['automation', 'rules', 'threshold', 'tag', 'notify', 'playbook', 'proposal', 'enable'],
    ownedKeys: ['threshold_automation'],
    // No longer a grid section: with the embedded rule cards gone, the master toggle +
    // link card sit on the shared single-card surface (like Cases / Standup).
  },
  {
    id: 'standup',
    group: 'general',
    title: 'Standup',
    blurb: 'The daily aggregate summary window and cadence.',
    icon: FileText,
    keywords: ['standup', 'summary', 'digest', 'aggregate', 'report'],
    ownedKeys: ['standup'],
  },

  /* ---- Integrations (connectors + outbound + context) ------------------ */
  {
    id: 'notifications',
    group: 'integrations',
    title: 'Alerting & notifications',
    blurb: 'Outbound channels, triggers, dedup, and digests.',
    icon: Bell,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['alerting', 'notifications', 'email', 'slack', 'teams', 'webhook', 'pagerduty', 'telegram', 'channels'],
    ownedKeys: ['notifications'],
  },
  {
    id: 'enrichment',
    group: 'integrations',
    title: 'Enrichment',
    blurb: 'Threat-intel lookups (AbuseIPDB / VirusTotal / GeoIP), cached in Redis.',
    icon: Globe,
    keywords: ['enrichment', 'abuseipdb', 'virustotal', 'geoip', 'reputation', 'cache', 'ttl'],
    // Owns NO page-dirty keys: the section's enable/fusion/provider toggles AND the
    // cache TTL all persist via IMMEDIATE settings PUTs (self-contained provider
    // editor), so the buffered page-save can never re-send a stale `enrichment` block
    // and clobber a provider toggle (matches the documented intent at `ownedKeys`).
  },
  {
    id: 'knowledge',
    group: 'integrations',
    title: 'Knowledge & threat context',
    blurb: 'RAG retrieval, the threat-context panel, MITRE, and runbooks/playbooks.',
    icon: ShieldAlert,
    perm: { resource: 'settings', action: 'manage' },
    grid: true,
    keywords: ['rag', 'retrieval', 'knowledge', 'threat context', 'mitre', 'runbook', 'playbook', 'ioc', 'resolved cases', 'precedent', 'promotion', 'futility'],
    ownedKeys: ['rag', 'threat_context', 'precedent'],
  },

  /* ---- Security & access (org, HIGH blast radius) ----------------------- */
  {
    id: 'admin_users',
    group: 'security_access',
    title: 'Users',
    blurb: 'Add accounts, assign roles, reset passwords, and enable/disable users.',
    icon: UsersIcon,
    perm: { resource: 'users', action: 'manage' },
    keywords: ['users', 'accounts', 'add user', 'reset password', 'enable', 'disable', 'admin', 'identity'],
  },
  {
    id: 'roles',
    group: 'security_access',
    title: 'Roles & permissions',
    blurb: 'Custom roles, the permission matrix, inheritance, and explicit denies.',
    icon: KeyRound,
    perm: { resource: 'roles', action: 'manage' },
    keywords: ['roles', 'rbac', 'permissions', 'matrix', 'grants', 'denies', 'custom role', 'inherit'],
  },
  {
    id: 'security',
    group: 'security_access',
    title: 'Single sign-on & policy',
    blurb: 'Single sign-on (OIDC) providers and the token / session policy.',
    icon: ShieldCheck,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['security', 'sso', 'oidc', 'single sign-on', 'google', 'microsoft', 'session policy', 'token', 'idle', 'access ttl', 'csrf', 'rate limit'],
    ownedKeys: ['sso', 'session_policy', 'mfa'],
  },
  {
    id: 'admin_sessions',
    group: 'security_access',
    title: 'Active sessions',
    blurb: 'Review and force-terminate sessions across all accounts.',
    icon: Network,
    perm: { resource: 'users', action: 'manage' },
    keywords: ['sessions', 'active sessions', 'terminate', 'revoke', 'force sign out', 'admin'],
  },
  {
    id: 'keys',
    group: 'security_access',
    title: 'Secret keys',
    blurb: 'Write-only API keys for Elasticsearch, LLMs, and enrichment.',
    icon: KeyRound,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['api key', 'secret', 'credentials', 'token', 'anthropic', 'openai', 'abuseipdb', 'virustotal'],
  },

  /* ---- Organization (cosmetic + advanced + destructive) ---------------- */
  {
    id: 'appearance',
    group: 'organization',
    title: 'Branding',
    blurb: 'Org wordmark, logo, accent colours, and default theme.',
    icon: Brush,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['branding', 'appearance', 'theme', 'logo', 'favicon', 'colour', 'color', 'white-label', 'accent'],
  },
  {
    id: 'release_updates',
    group: 'organization',
    title: 'Updates & releases',
    blurb: 'Public source repository, Stable/Testing refs, and read-only update discovery.',
    icon: GitBranch,
    perm: { resource: 'settings', action: 'manage' },
    grid: true,
    keywords: ['updates', 'release', 'repository', 'github', 'stable', 'testing', 'branch', 'version'],
    ownedKeys: ['release_updates'],
  },
  {
    id: 'advanced',
    group: 'organization',
    title: 'Advanced',
    blurb: 'Caps, kill switch, suppression rules, rule catalog, and the settings lock.',
    icon: SlidersHorizontal,
    perm: { resource: 'settings', action: 'manage' },
    grid: true,
    keywords: ['advanced', 'caps', 'kill switch', 'suppression', 'rule catalog', 'read-only', 'lock', 'budget', 'allowlist'],
    // NOTE: `excluded_rules` / `in_scope_rules` are intentionally NOT owned here — no
    // control in the Settings tree edits them, so listing them lit a dirty dot that
    // could never trigger. Re-add them only if/when a real editor card is built.
    ownedKeys: [
      'caps',
      'auto_forward_allowlist',
      'background_scan_enabled',
      'rag',
      'read_only_settings_mode',
    ],
  },
  {
    id: 'advanced_all',
    group: 'organization',
    title: 'All settings',
    blurb: 'Every engine preference, generated from the backend schema — the long tail of knobs.',
    icon: ListTree,
    perm: { resource: 'settings', action: 'manage' },
    grid: true,
    keywords: ['schema', 'all settings', 'advanced', 'generic', 'long tail', 'raw', 'every setting', 'knobs', 'reflector'],
  },
  {
    id: 'demo',
    group: 'organization',
    title: 'Experimental & Demo',
    blurb: 'Populate the console with isolated, $0, reversible synthetic data (experimental).',
    icon: FlaskConical,
    perm: { resource: 'demo', action: 'manage' },
    keywords: ['demo', 'experimental', 'sample', 'synthetic', 'sandbox', 'simulated', 'seed', 'try it', 'preview'],
  },
  {
    id: 'storage',
    group: 'organization',
    title: 'Storage & retention',
    blurb: 'Capability-aware Hot, Warm, and desired archive lifecycle for Agentic SOC-owned state.',
    icon: Archive,
    perm: { resource: 'settings', action: 'manage' },
    grid: true,
    keywords: ['storage', 'retention', 'hot', 'warm', 'archive', 'glacier', 'ilm', 'lifecycle', 'audit', 'usage'],
    ownedKeys: ['storage_lifecycle'],
  },
  {
    id: 'data_export',
    group: 'organization',
    title: 'Data export',
    blurb: 'Download a selectable, secret-free Agentic SOC analysis bundle.',
    icon: DatabaseBackup,
    perm: { resource: 'data_export', action: 'export' },
    keywords: ['export', 'download', 'backup', 'portable', 'analysis bundle', 'cases', 'audit', 'usage', 'configuration'],
  },
  {
    id: 'danger',
    group: 'organization',
    // Gate on `users:manage` to match BOTH the DangerZone body's own <Can> guard and the
    // backend `users:manage` admission/execution gate for tiered_reset Jobs — otherwise a principal with only
    // settings:manage saw the rail entry + outer guard pass but a blank (body-gated) panel.
    perm: { resource: 'users', action: 'manage' },
    title: 'Danger zone',
    blurb: 'Tiered reset of cases, sources, or the whole tenant. Never wipes env secrets.',
    icon: Trash2,
    keywords: ['danger', 'reset', 'factory reset', 'wipe', 'delete', 'destructive', 'revoke all', 'kill switch'],
  },
];

/* --------------------------------------------------- setting-level index --- *
 * Round-5 Sett-C — the SINGLE source for setting-LEVEL search + card-level deep-links.
 *
 * Each entry names a specific card WITHIN a grid section by its `anchor` (the `id=` on the
 * `SettingsCard`), so search can deepen from section-level to setting-level and a jump can
 * scroll+highlight the exact card via `#/settings?s=<section>&a=<anchor>`. This is a small
 * hand-kept table (the anchors live in the section renderers), deliberately NOT reflected
 * from the schema — it is the operator-facing label + synonyms, not the wire shape. Keep it
 * in sync when a grid section adds/renames a `SettingsCard anchor=`. */
export interface SettingAnchor {
  /** The owning section id. */
  section: SectionId;
  /** The `SettingsCard anchor=` (its DOM `id`), the `&a=` deep-link target. */
  anchor: string;
  /** Human label (the card title). */
  label: string;
  /** Extra search synonyms. */
  keywords: string[];
}

export const SETTING_ANCHORS: readonly SettingAnchor[] = [
  // General › Data scope
  { section: 'general', anchor: 'general-sources', label: 'Data sources', keywords: ['sources', 'connectors', 'feeds'] },
  { section: 'general', anchor: 'general-mapping', label: 'Default log scope & field mapping', keywords: ['index pattern', 'data view', 'field mapping', 'fields', 'entity', 'severity'] },
  { section: 'general', anchor: 'general-polling', label: 'Polling', keywords: ['poll', 'interval', 'batch size', 'lookback', 'cold start'] },
  // General › Detection
  { section: 'detection', anchor: 'detection-correlation', label: 'Correlation', keywords: ['clustering', 'group by', 'window', 'trigger after'] },
  { section: 'detection', anchor: 'detection-risk', label: 'Risk weights', keywords: ['risk', 'weights', 'severity weight', 'asset criticality'] },
  { section: 'detection', anchor: 'detection-asset', label: 'Asset criticality', keywords: ['asset', 'criticality', 'cidr', 'network', 'crown jewel', 'high value'] },
  { section: 'detection', anchor: 'detection-escalation', label: 'Escalation', keywords: ['escalation', 'confidence', 'critical severity'] },
  { section: 'detection', anchor: 'detection-autoclose', label: 'Auto-close policy', keywords: ['auto-close', 'autonomy', 'false positive', 'true positive', 'needs human'] },
  { section: 'detection', anchor: 'detection-crosssource', label: 'Cross-source correlation', keywords: ['cross-source', 'link', 'shared entity', 'related cases'] },
  // Integrations › Knowledge & threat context
  // General › SLA, priority & suppression
  { section: 'case_policy', anchor: 'case-policy-sla', label: 'SLA targets', keywords: ['sla', 'response', 'resolution', 'timer', 'breach', 'mttr'] },
  { section: 'case_policy', anchor: 'case-policy-priority', label: 'Priority matrix', keywords: ['priority', 'impact', 'urgency', 'p1', 'p2', 'matrix'] },
  { section: 'case_policy', anchor: 'case-policy-suppression', label: 'Suppression rules', keywords: ['suppression', 'suppress', 'drop', 'mute', 'benign', 'noise'] },
  // Integrations › Knowledge & threat context
  { section: 'knowledge', anchor: 'knowledge-rag', label: 'Retrieval (RAG)', keywords: ['rag', 'retrieval', 'top k', 'vector', 'bm25'] },
  { section: 'knowledge', anchor: 'knowledge-threat', label: 'Threat-context panel', keywords: ['threat context', 'ioc', 'mitre', 'reputation'] },
  { section: 'knowledge', anchor: 'knowledge-corpus', label: 'Corpus & procedures', keywords: ['runbooks', 'playbooks', 'resolved cases', 'knowledge corpus'] },
  // Organization › Advanced
  { section: 'advanced', anchor: 'advanced-caps', label: 'Per-case caps', keywords: ['caps', 'budget', 'max tokens', 'max cost', 'concurrency'] },
  { section: 'advanced', anchor: 'advanced-killswitch', label: 'Kill switch', keywords: ['kill switch', 'pause', 'stop', 'disable'] },
  { section: 'advanced', anchor: 'advanced-allowlist', label: 'Auto-forward allowlist', keywords: ['allowlist', 'auto-forward'] },
  { section: 'advanced', anchor: 'advanced-suppression', label: 'Suppression & rule catalog', keywords: ['suppression', 'rule catalog', 'detection rules'] },
  { section: 'advanced', anchor: 'advanced-lock', label: 'Settings lock', keywords: ['read-only', 'lock', 'settings lock'] },
  // Organization › Storage & retention
  { section: 'storage', anchor: 'storage-effective', label: 'Effective lifecycle', keywords: ['effective', 'backend', 'capability', 'ilm', 'status'] },
  { section: 'storage', anchor: 'storage-policy', label: 'Desired policy', keywords: ['hot days', 'warm days', '180 days', '90 days', 'glacier', 'archive'] },
  { section: 'storage', anchor: 'storage-preview', label: 'Preview & safe scope', keywords: ['preview', 'apply', 'source logs', 'cases', 'audit', 'usage', 'safe scope'] },
  // Organization › Updates & releases
  { section: 'release_updates', anchor: 'release-source', label: 'Source & channels', keywords: ['repository', 'github', 'stable', 'testing', 'branch', 'interval'] },
  { section: 'release_updates', anchor: 'release-observed', label: 'Observed revisions', keywords: ['update', 'version', 'commit', 'check', 'source revision'] },
];

/* -------------------------------------------------------------- derived ---- */

/** The stable section id union — DERIVED from the registry (single source). */
export type SectionId =
  | 'profile'
  | 'account_security'
  | 'sessions'
  | 'customization'
  | 'general'
  | 'models'
  | 'keys'
  | 'detection'
  | 'detection_rules'
  | 'cases'
  | 'case_policy'
  | 'automation'
  | 'standup'
  | 'notifications'
  | 'security'
  | 'admin_users'
  | 'roles'
  | 'admin_sessions'
  | 'knowledge'
  | 'enrichment'
  | 'appearance'
  | 'release_updates'
  | 'advanced'
  | 'advanced_all'
  | 'demo'
  | 'storage'
  | 'data_export'
  | 'danger';

/** Fast id → section META lookup (used by the search/jump helpers below). */
export const SECTION_META_BY_ID: Record<string, SectionMeta> = Object.fromEntries(
  SETTINGS_SECTIONS_META.map((s) => [s.id, s]),
);

/** Grouped, rail-ordered META view. */
export interface SectionGroupMeta {
  id: SectionGroupId;
  label: string;
  sections: SectionMeta[];
}

export const SECTION_GROUPS_META: SectionGroupMeta[] = SECTION_GROUP_ORDER.map((g) => ({
  id: g.id,
  label: g.label,
  sections: SETTINGS_SECTIONS_META.filter((s) => s.group === g.id),
})).filter((g) => g.sections.length > 0);

/** Sections that render their OWN full-width SettingsGrid (no outer Card chrome). */
export const GRID_SECTIONS: ReadonlySet<string> = new Set(
  SETTINGS_SECTIONS_META.filter((s) => s.grid).map((s) => s.id),
);

/** Type guard: is a string a known section id? */
export function isSectionId(v: string): v is SectionId {
  return v in SECTION_META_BY_ID;
}

/**
 * The per-section dirty-map: section id → the top-level Preferences keys it OWNS.
 * DERIVED from the registry so `settings-dirty.ts` never hand-syncs it again. Only
 * sections that declare `ownedKeys` appear (the embedded bodies / secret keys /
 * enrichment manage their own save lifecycle and own no page-dirty keys).
 */
export const SECTION_KEYS: Record<string, readonly string[]> = Object.fromEntries(
  SETTINGS_SECTIONS_META.filter((s) => s.ownedKeys && s.ownedKeys.length > 0).map((s) => [
    s.id,
    s.ownedKeys as readonly string[],
  ]),
);

/* ------------------------------------------------------- search / jump ----- *
 * Round-5 Sett-C — shared search helpers used by BOTH the Settings rail filter and the
 * Cmd-K palette so their RBAC filter + matching stay identical (single source). */

/** A Cmd-K / rail jump target: a whole section, or a specific card within one. */
export interface SettingsJumpTarget {
  section: SectionId;
  /** When set, the target is a specific card (`&a=<anchor>`); else the section head. */
  anchor?: string;
  /** Label shown in the palette / result list. */
  label: string;
  /** The section's own title (for grouping / "in <section>" context). */
  sectionTitle: string;
  icon: LucideIcon;
  /** The gating grant (mirrors the section perm) — the caller RBAC-filters on it. */
  perm?: SectionPerm;
}

/** The haystack for one section (title + blurb + keywords), lower-cased once. */
function sectionHaystack(s: SectionMeta): string {
  return [s.title, s.blurb, ...(s.keywords ?? [])].join(' ').toLowerCase();
}

/**
 * All jump targets — every section PLUS every setting-level card anchor — as a flat list,
 * in rail order. The caller (rail filter / palette) applies its own RBAC filter via each
 * target's `perm`, then substring-matches `label`/keywords. Section targets come first so a
 * bare section jump ranks above its cards.
 */
export function allJumpTargets(): SettingsJumpTarget[] {
  const sectionTargets: SettingsJumpTarget[] = SETTINGS_SECTIONS_META.map((s) => ({
    section: s.id as SectionId,
    label: s.title,
    sectionTitle: s.title,
    icon: s.icon,
    perm: s.perm,
  }));
  const anchorTargets: SettingsJumpTarget[] = SETTING_ANCHORS.map((a) => {
    const parent = SECTION_META_BY_ID[a.section];
    return {
      section: a.section,
      anchor: a.anchor,
      label: a.label,
      sectionTitle: parent?.title ?? a.section,
      icon: parent?.icon ?? SlidersHorizontal,
      perm: parent?.perm,
    };
  });
  return [...sectionTargets, ...anchorTargets];
}

/**
 * Substring-search the jump targets. `hasPerm` gates a target the caller can't reach; a
 * blank query returns the SECTION targets only (no card noise). Deepens the filter from
 * section-level to setting-level: a term like "auto-close" or "kill switch" now surfaces
 * the exact card, not just its parent section.
 */
export function searchJumpTargets(
  query: string,
  hasPerm: (resource: string, action: string) => boolean,
): SettingsJumpTarget[] {
  const q = query.trim().toLowerCase();
  const targets = allJumpTargets().filter(
    (t) => !t.perm || hasPerm(t.perm.resource, t.perm.action),
  );
  if (!q) return targets.filter((t) => !t.anchor);
  return targets.filter((t) => {
    if (t.anchor) {
      const anchor = SETTING_ANCHORS.find((a) => a.anchor === t.anchor);
      const hay = [t.label, ...(anchor?.keywords ?? [])].join(' ').toLowerCase();
      return hay.includes(q);
    }
    const def = SECTION_META_BY_ID[t.section];
    return def ? sectionHaystack(def).includes(q) : false;
  });
}

/**
 * Does a section match a query at SECTION or SETTING level? Used by the rail to decide
 * whether to show a section (a match on any of its cards keeps the section visible).
 */
export function sectionMatchesQuery(def: SectionMeta, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (sectionHaystack(def).includes(q)) return true;
  // Setting-level: any card anchor under this section whose label/keywords match.
  return SETTING_ANCHORS.some(
    (a) =>
      a.section === def.id &&
      [a.label, ...a.keywords].join(' ').toLowerCase().includes(q),
  );
}

/**
 * The matching card anchors under a section for a query (empty when none / blank query).
 * Lets the rail render a sub-list of matched settings beneath a section.
 */
export function matchedAnchorsForSection(sectionId: string, query: string): SettingAnchor[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTING_ANCHORS.filter(
    (a) => a.section === sectionId && [a.label, ...a.keywords].join(' ').toLowerCase().includes(q),
  );
}
