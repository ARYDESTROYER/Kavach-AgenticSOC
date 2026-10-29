/**
 * The audit event table on the Console side (Round 14 SPEC §4.5.5).
 *
 * The one table of event categories and friendly names is the JSON fixture
 * `backend/app/audit/event_categories.json`. The web build cannot read files outside
 * `webui/` (the image copies only `webui/`), so this module mirrors it word for word and
 * `__tests__/events.contract.test.ts` reads the fixture and fails on any drift. Edit the
 * fixture first, then this mirror.
 *
 * The read API already labels every record (`event_label`, `category`); the page uses
 * this table for what the server does not send: the Event facet menu, the friendly name
 * of a filter chip, and the label of a legacy actor token. Labels are Console-authored
 * copy (plain, sentence case, no em dash); stored tokens stay as stored in Raw record.
 */
import type { AuditCategory, AuditScope } from '@/lib/types-audit';

export interface AuditCategoryEntry {
  id: AuditCategory;
  label: string;
  /** The scope a row of this category belongs to when no person made it. */
  scope: Exclude<AuditScope, 'all'>;
}

export interface AuditLegacyEventEntry {
  action_type: string;
  /** A surface, or `*` for any surface. */
  surface: string;
  category: AuditCategory;
  label: string;
}

export interface AuditPrefixEntry {
  prefix: string;
  category: AuditCategory;
  label: string;
}

export interface AuditActionEntry {
  action: string;
  category: AuditCategory;
  label: string;
}

export const AUDIT_EVENT_TABLE_VERSION = 1;

/** The five categories, in the order the Event menu lists them. */
export const AUDIT_CATEGORIES: readonly AuditCategoryEntry[] = [
  { id: 'access', label: 'Access and identity', scope: 'people' },
  { id: 'config', label: 'Configuration and data', scope: 'people' },
  { id: 'case_work', label: 'Case work', scope: 'people' },
  { id: 'agent', label: 'Agent pipeline', scope: 'agent' },
  { id: 'system', label: 'System', scope: 'agent' },
];

/** Legacy rows (no structured `action`): keyed by `(action_type, surface)`; `*` is any surface. */
export const AUDIT_LEGACY_EVENTS: readonly AuditLegacyEventEntry[] = [
  { action_type: 'auth', surface: '*', category: 'access', label: 'Sign-in event' },
  { action_type: 'access_denied', surface: '*', category: 'access', label: 'Access denied' },
  { action_type: 'user_mgmt', surface: '*', category: 'access', label: 'User changed' },
  { action_type: 'user_mgmt', surface: 'baseline', category: 'config', label: 'Baseline settings changed' },
  { action_type: 'user_mgmt', surface: 'batch', category: 'config', label: 'Discounted inference settings changed' },
  { action_type: 'user_mgmt', surface: 'campaigns', category: 'config', label: 'Campaign settings changed' },
  { action_type: 'user_mgmt', surface: 'models', category: 'config', label: 'Model and budget settings changed' },
  { action_type: 'user_mgmt', surface: 'chat', category: 'config', label: 'Chat prompt library changed' },
  { action_type: 'audit_view', surface: '*', category: 'access', label: 'Audit log viewed' },
  { action_type: 'status', surface: 'settings', category: 'config', label: 'Settings changed' },
  { action_type: 'status', surface: 'storage', category: 'config', label: 'Storage policy changed' },
  { action_type: 'status', surface: 'rules', category: 'config', label: 'Detection rule changed' },
  { action_type: 'status', surface: 'analyst_policy', category: 'config', label: 'Analyst policy changed' },
  { action_type: 'data_export', surface: '*', category: 'config', label: 'Data exported' },
  { action_type: 'reset', surface: '*', category: 'config', label: 'Data reset' },
  { action_type: 'system_update', surface: '*', category: 'config', label: 'System update' },
  { action_type: 'runbook', surface: '*', category: 'config', label: 'Runbook changed' },
  { action_type: 'playbook', surface: '*', category: 'config', label: 'Runbook (before Round 14)' },
  { action_type: 'tuning', surface: '*', category: 'config', label: 'Threshold tuning' },
  { action_type: 'automation', surface: '*', category: 'config', label: 'Rule automation' },
  { action_type: 'status', surface: '*', category: 'case_work', label: 'Case status changed' },
  { action_type: 'collab', surface: '*', category: 'case_work', label: 'Case updated' },
  { action_type: 'feedback', surface: '*', category: 'case_work', label: 'Verdict graded' },
  { action_type: 'thread_post', surface: '*', category: 'case_work', label: 'Case message posted' },
  { action_type: 'reaction', surface: '*', category: 'case_work', label: 'Message reaction' },
  { action_type: 'task_update', surface: '*', category: 'case_work', label: 'Case task updated' },
  { action_type: 'proposal', surface: '*', category: 'case_work', label: 'Approval proposal' },
  { action_type: 'report', surface: '*', category: 'case_work', label: 'Report changed' },
  { action_type: 'decision', surface: 'demo', category: 'config', label: 'Demo Mode action' },
  { action_type: 'context', surface: 'rag', category: 'config', label: 'Threat context imported' },
  { action_type: 'context', surface: 'rag_document_delete', category: 'config', label: 'Knowledge document deleted' },
  { action_type: 'context', surface: 'rag_precedent_bootstrap', category: 'config', label: 'Precedents bootstrapped' },
  { action_type: 'context', surface: 'rag_precedent_exclusion', category: 'config', label: 'Precedent exclusion changed' },
  { action_type: 'context', surface: 'rag_precedent_repair', category: 'config', label: 'Precedent index repaired' },
  { action_type: 'context', surface: 'dashboards', category: 'config', label: 'Dashboard changed' },
  { action_type: 'context', surface: 'chat_history', category: 'config', label: 'Chat conversation changed' },
  { action_type: 'prompt', surface: '*', category: 'agent', label: 'Model prompt' },
  { action_type: 'es_query', surface: '*', category: 'agent', label: 'Log query' },
  { action_type: 'tool_call', surface: '*', category: 'agent', label: 'Tool call' },
  { action_type: 'verdict', surface: '*', category: 'agent', label: 'Verdict' },
  { action_type: 'decision', surface: '*', category: 'agent', label: 'Close or escalate decision' },
  { action_type: 'context', surface: '*', category: 'agent', label: 'Investigation context' },
  { action_type: 'poll', surface: '*', category: 'system', label: 'Source poll' },
  { action_type: 'scan', surface: '*', category: 'system', label: 'Background scan' },
  { action_type: 'notification', surface: '*', category: 'system', label: 'Notification sent' },
  { action_type: 'inapp_notify', surface: '*', category: 'system', label: 'In-app notification' },
  { action_type: 'job', surface: '*', category: 'system', label: 'Background job' },
  { action_type: 'error', surface: '*', category: 'system', label: 'Error' },
];

/** New rows: a structured action's prefix names its family when no exact entry does. */
export const AUDIT_ACTION_PREFIXES: readonly AuditPrefixEntry[] = [
  { prefix: 'auth', category: 'access', label: 'Sign-in' },
  { prefix: 'session', category: 'access', label: 'Session' },
  { prefix: 'user', category: 'access', label: 'User' },
  { prefix: 'role', category: 'access', label: 'Role' },
  { prefix: 'audit', category: 'config', label: 'Audit log' },
  { prefix: 'settings', category: 'config', label: 'Settings' },
  { prefix: 'export', category: 'config', label: 'Export' },
  { prefix: 'reset', category: 'config', label: 'Reset' },
  { prefix: 'update', category: 'config', label: 'System update' },
  { prefix: 'rule', category: 'config', label: 'Detection rule' },
  { prefix: 'analyst_policy', category: 'config', label: 'Analyst policy' },
  { prefix: 'runbook', category: 'config', label: 'Runbook' },
  { prefix: 'dashboard', category: 'config', label: 'Dashboard' },
  { prefix: 'source', category: 'config', label: 'Source' },
  { prefix: 'notification', category: 'config', label: 'Notification channel' },
  { prefix: 'model', category: 'config', label: 'Model' },
  { prefix: 'storage', category: 'config', label: 'Storage policy' },
  { prefix: 'campaign', category: 'config', label: 'Campaign' },
  { prefix: 'case', category: 'case_work', label: 'Case' },
  { prefix: 'run', category: 'case_work', label: 'Runbook run' },
  { prefix: 'step', category: 'case_work', label: 'Runbook step' },
  { prefix: 'report', category: 'case_work', label: 'Report' },
  { prefix: 'agent', category: 'agent', label: 'Agent' },
  { prefix: 'job', category: 'system', label: 'Background job' },
];

/** New rows: the exact structured actions and their friendly names. */
export const AUDIT_ACTIONS: readonly AuditActionEntry[] = [
  { action: 'auth.login', category: 'access', label: 'Signed in' },
  { action: 'auth.login_failed', category: 'access', label: 'Sign-in failed' },
  { action: 'auth.logout', category: 'access', label: 'Signed out' },
  { action: 'auth.mfa_enrolled', category: 'access', label: 'Two-factor authentication set up' },
  { action: 'auth.mfa_failed', category: 'access', label: 'Two-factor check failed' },
  { action: 'auth.password_changed', category: 'access', label: 'Password changed' },
  { action: 'auth.password_change_failed', category: 'access', label: 'Password change failed' },
  { action: 'auth.mfa_setup_started', category: 'access', label: 'Two-factor setup started' },
  { action: 'auth.mfa_challenged', category: 'access', label: 'Two-factor check requested' },
  { action: 'auth.mfa_disabled', category: 'access', label: 'Two-factor authentication turned off' },
  { action: 'auth.reauthenticated', category: 'access', label: 'Identity confirmed for a protected action' },
  { action: 'auth.reauth_failed', category: 'access', label: 'Identity confirmation failed' },
  { action: 'session.created', category: 'access', label: 'Session started' },
  { action: 'session.refreshed', category: 'access', label: 'Session renewed' },
  { action: 'session.revoked', category: 'access', label: 'Session ended' },
  { action: 'user.created', category: 'access', label: 'User created' },
  { action: 'user.updated', category: 'access', label: 'User updated' },
  { action: 'user.deleted', category: 'access', label: 'User deleted' },
  { action: 'user.role_changed', category: 'access', label: 'User role changed' },
  { action: 'user.preferences_updated', category: 'config', label: 'Personal preferences changed' },
  { action: 'role.created', category: 'access', label: 'Role created' },
  { action: 'role.updated', category: 'access', label: 'Role updated' },
  { action: 'role.deleted', category: 'access', label: 'Role deleted' },
  { action: 'audit.viewed', category: 'access', label: 'Audit log viewed' },
  { action: 'audit.export_requested', category: 'config', label: 'Audit export requested' },
  { action: 'audit.exported', category: 'config', label: 'Audit exported' },
  { action: 'audit.export_downloaded', category: 'config', label: 'Audit export downloaded' },
  { action: 'job.artifact_downloaded', category: 'config', label: 'Job file downloaded' },
  { action: 'settings.updated', category: 'config', label: 'Settings changed' },
  { action: 'dashboard.created', category: 'config', label: 'Dashboard created' },
  { action: 'dashboard.updated', category: 'config', label: 'Dashboard updated' },
  { action: 'dashboard.deleted', category: 'config', label: 'Dashboard deleted' },
  { action: 'source.created', category: 'config', label: 'Source added' },
  { action: 'source.updated', category: 'config', label: 'Source changed' },
  { action: 'source.deleted', category: 'config', label: 'Source deleted' },
  { action: 'source.secrets_updated', category: 'config', label: 'Source credentials changed' },
  { action: 'notification.secrets_updated', category: 'config', label: 'Notification channel credentials changed' },
  { action: 'campaign.recorrelated', category: 'config', label: 'Campaigns rebuilt' },
  { action: 'campaign.recorrelate_failed', category: 'config', label: 'Campaign rebuild failed' },
  { action: 'runbook.created', category: 'config', label: 'Runbook created' },
  { action: 'runbook.draft_updated', category: 'config', label: 'Runbook draft updated' },
  { action: 'runbook.draft_discarded', category: 'config', label: 'Runbook draft discarded' },
  { action: 'runbook.duplicated', category: 'config', label: 'Runbook duplicated' },
  { action: 'runbook.imported', category: 'config', label: 'Runbook imported' },
  { action: 'runbook.exported', category: 'config', label: 'Runbook exported' },
  { action: 'runbook.submitted', category: 'config', label: 'Runbook submitted for review' },
  { action: 'runbook.published', category: 'config', label: 'Runbook published' },
  { action: 'runbook.rejected', category: 'config', label: 'Runbook review rejected' },
  { action: 'runbook.retired', category: 'config', label: 'Runbook retired' },
  { action: 'runbook.restored', category: 'config', label: 'Runbook restored' },
  { action: 'runbook.reviewed', category: 'config', label: 'Runbook reviewed' },
  { action: 'runbook.migrated', category: 'config', label: 'Runbook converted' },
  { action: 'runbook.selected', category: 'agent', label: 'Runbook selected' },
  { action: 'runbook.migration_completed', category: 'config', label: 'Runbook conversion finished' },
  { action: 'runbook.migration_skipped', category: 'config', label: 'Runbook not converted' },
  { action: 'runbook.reindexed', category: 'config', label: 'Runbook search index rebuild' },
  { action: 'runbook.create_failed', category: 'config', label: 'Runbook creation failed' },
  { action: 'runbook.draft_update_failed', category: 'config', label: 'Runbook draft update failed' },
  { action: 'runbook.draft_discard_failed', category: 'config', label: 'Runbook draft discard failed' },
  { action: 'runbook.duplicate_failed', category: 'config', label: 'Runbook duplication failed' },
  { action: 'runbook.import_failed', category: 'config', label: 'Runbook import failed' },
  { action: 'runbook.submit_failed', category: 'config', label: 'Runbook submission failed' },
  { action: 'runbook.publish_failed', category: 'config', label: 'Runbook publication failed' },
  { action: 'runbook.reject_failed', category: 'config', label: 'Runbook review rejection failed' },
  { action: 'runbook.retire_failed', category: 'config', label: 'Runbook retirement failed' },
  { action: 'runbook.restore_failed', category: 'config', label: 'Runbook restore failed' },
  { action: 'runbook.review_failed', category: 'config', label: 'Runbook review not recorded' },
  { action: 'runbook.migrate_failed', category: 'config', label: 'Runbook conversion not applied' },
  { action: 'runbook.migration_complete_failed', category: 'config', label: 'Runbook conversion summary not saved' },
  { action: 'run.attached', category: 'case_work', label: 'Runbook attached' },
  { action: 'run.attach_skipped', category: 'case_work', label: 'Runbook not attached' },
  { action: 'run.started', category: 'case_work', label: 'Runbook started' },
  { action: 'run.version_switched', category: 'case_work', label: 'Runbook version switched' },
  { action: 'run.abandoned', category: 'case_work', label: 'Runbook abandoned' },
  { action: 'run.completed', category: 'case_work', label: 'Runbook completed' },
  { action: 'step.updated', category: 'case_work', label: 'Runbook step updated' },
  { action: 'step.evidence_collected', category: 'case_work', label: 'Evidence collected' },
  { action: 'step.decision_recorded', category: 'case_work', label: 'Decision recorded' },
  { action: 'step.action_recorded', category: 'case_work', label: 'Action recorded' },
  { action: 'step.approval_requested', category: 'case_work', label: 'Approval requested' },
  { action: 'step.approved', category: 'case_work', label: 'Step approved' },
  { action: 'step.rejected', category: 'case_work', label: 'Step rejected' },
  { action: 'step.ai_drafted', category: 'case_work', label: 'Step drafted by AI' },
  { action: 'step.ai_draft_confirmed', category: 'case_work', label: 'AI draft confirmed' },
  { action: 'case.closed_with_open_steps', category: 'case_work', label: 'Case closed with open steps' },
  { action: 'run.attach_failed', category: 'case_work', label: 'Runbook attachment failed' },
  { action: 'run.version_switch_failed', category: 'case_work', label: 'Runbook version switch failed' },
  { action: 'run.abandon_failed', category: 'case_work', label: 'Runbook abandonment failed' },
  { action: 'step.update_failed', category: 'case_work', label: 'Runbook step update failed' },
  { action: 'step.evidence_collect_failed', category: 'case_work', label: 'Evidence collection failed' },
  { action: 'step.decision_record_failed', category: 'case_work', label: 'Decision not recorded' },
  { action: 'step.action_record_failed', category: 'case_work', label: 'Action not recorded' },
  { action: 'step.approve_failed', category: 'case_work', label: 'Step approval failed' },
  { action: 'step.reject_failed', category: 'case_work', label: 'Step rejection failed' },
  { action: 'step.ai_draft_failed', category: 'case_work', label: 'AI draft not saved' },
  { action: 'step.ai_draft_confirm_failed', category: 'case_work', label: 'AI draft confirmation failed' },
];

/** Legacy actor tokens, to derive an actor kind for a row that recorded none. */
export const AUDIT_ACTOR_TOKENS: Readonly<Record<'agent' | 'system', readonly string[]>> = {
  agent: ['router', 'investigator', 'formatter', 'standup', 'chat', 'overview', 'embedding', 'pipeline', 'playbook_selector', 'runbook_selector', 'procedure_provenance', 'context', 'reinvestigate', 'agent'],
  system: ['system', 'case_manager', 'analyst_policy', 'poller', 'ingest', 'tuner', 'automation', 'update_supervisor', 'notification', 'run_playbook', 'runbook_migration'],
};

/** Friendly names for legacy actor tokens where a list shows them (stored data stays as is). */
export const AUDIT_ACTOR_LABELS: Readonly<Record<string, string>> = {
  playbook_selector: 'Runbook selector (before Round 14)',
  run_playbook: 'Runbook automation (before Round 14)',
};

/* ---------------------------------------------------------------- helpers -- */

/** `*` in a legacy entry means "any surface". */
export const ANY_SURFACE = '*';

const CATEGORY_LABEL = new Map<string, string>(AUDIT_CATEGORIES.map((c) => [c.id, c.label]));
const ACTION_LABEL = new Map<string, AuditActionEntry>(AUDIT_ACTIONS.map((a) => [a.action, a]));
const PREFIX_LABEL = new Map<string, AuditPrefixEntry>(AUDIT_ACTION_PREFIXES.map((p) => [p.prefix, p]));
/** Legacy action types listed for any surface only, with no surface of their own. */
const LEGACY_FAMILIES: readonly AuditLegacyEventEntry[] = AUDIT_LEGACY_EVENTS.filter(
  (e) =>
    e.surface === ANY_SURFACE &&
    !AUDIT_LEGACY_EVENTS.some((o) => o.action_type === e.action_type && o.surface !== ANY_SURFACE),
);
const ACTION_LABELS = new Set(AUDIT_ACTIONS.map((a) => a.label));

/**
 * The name of an older event type in the Event menu and on its chip. When an exact event
 * carries the same name (`audit_view` and `audit.viewed` both read "Audit log viewed"),
 * the older type matches only rows stored without a structured action, so it says so.
 */
function legacyFamilyLabel(entry: AuditLegacyEventEntry): string {
  return ACTION_LABELS.has(entry.label) ? `${entry.label} (older rows)` : entry.label;
}

/** Is `value` one of the five category ids? */
export function isAuditCategory(value: string): value is AuditCategory {
  return CATEGORY_LABEL.has(value);
}

/** The friendly name of a category id ("Access and identity"); the id itself when unknown. */
export function categoryLabel(id: string): string {
  return CATEGORY_LABEL.get(id) ?? id;
}

/** The read API's `_humanise_verb`: `role_changed` reads "role changed". */
function humaniseVerb(verb: string): string {
  return verb.replace(/_/g, ' ').trim();
}

/**
 * The friendly name of an `event` filter value, for its chip and the export dialog: a
 * category ("Configuration and data"), an exact action ("User role changed"), an action
 * with a known prefix ("Runbook submitted", as the read API names it) or an event
 * family ("Any sign-in event"). An unknown value is shown as the token itself.
 */
export function eventFilterLabel(value: string): string {
  if (CATEGORY_LABEL.has(value)) return `Any event in ${categoryLabel(value).toLowerCase()}`;
  const exact = ACTION_LABEL.get(value);
  if (exact) return exact.label;
  const dot = value.indexOf('.');
  if (dot > 0) {
    const prefix = PREFIX_LABEL.get(value.slice(0, dot));
    return prefix ? `${prefix.label} ${humaniseVerb(value.slice(dot + 1))}`.trim() : value;
  }
  const family = PREFIX_LABEL.get(value);
  if (family) return `Any ${family.label.toLowerCase()} event`;
  const legacy = LEGACY_FAMILIES.find((e) => e.action_type === value);
  return legacy ? legacyFamilyLabel(legacy) : value;
}

/** One choice in the Event menu. */
export interface AuditEventOption {
  /** The `event` filter value: a category id, an exact action or a family token. */
  value: string;
  label: string;
  kind: 'category' | 'family' | 'action';
}

export interface AuditEventGroup {
  category: AuditCategory;
  label: string;
  options: AuditEventOption[];
}

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

/**
 * The Event menu, grouped by category (SPEC §4.5.1): first "Any event in <category>",
 * then each family ("Any sign-in event": new rows with that prefix and older rows of the
 * same type), then the exact events, A to Z. Older event types that have no family of
 * their own (a model prompt, a source poll) are listed by their stored name.
 */
export function auditEventGroups(): AuditEventGroup[] {
  return AUDIT_CATEGORIES.map((category) => {
    // A family named like a category (`agent`) is read as the category by the read API.
    const families: AuditEventOption[] = AUDIT_ACTION_PREFIXES.filter(
      (p) => p.category === category.id && !CATEGORY_LABEL.has(p.prefix),
    ).map(
      (p) => ({ value: p.prefix, label: `Any ${p.label.toLowerCase()} event`, kind: 'family' }),
    );
    const legacy: AuditEventOption[] = LEGACY_FAMILIES.filter(
      (e) => e.category === category.id && !PREFIX_LABEL.has(e.action_type) && !CATEGORY_LABEL.has(e.action_type),
    ).map((e) => ({ value: e.action_type, label: legacyFamilyLabel(e), kind: 'family' }));
    const actions: AuditEventOption[] = AUDIT_ACTIONS.filter((a) => a.category === category.id).map((a) => ({
      value: a.action,
      label: a.label,
      kind: 'action',
    }));
    return {
      category: category.id,
      label: category.label,
      options: [
        { value: category.id, label: `Any event in ${category.label.toLowerCase()}`, kind: 'category' },
        ...[...families, ...legacy].sort(byLabel),
        ...actions.sort(byLabel),
      ],
    };
  });
}

/**
 * The friendly name of an actor token for a list (`run_playbook` reads "Runbook
 * automation (before Round 14)"); Raw record keeps the stored token.
 */
export function actorLabel(actor: string): string {
  return AUDIT_ACTOR_LABELS[actor] ?? actor;
}

/** A quick view on the chips row: a fixed filter the page applies in one click. */
export interface AuditQuickView {
  id: string;
  /** What the view applies, in the words its chip shows: never more than it matches. */
  label: string;
  /** The filters it sets; it replaces the event and outcome filters and keeps time and search. */
  event?: string;
  outcome?: 'denied' | 'failure';
  /**
   * Every quick view reads rows of People and settings categories, so applying one from
   * Agent activity (where it could only match nothing) switches the scope to People and
   * settings; All stays All.
   */
  scope: 'people';
}

/**
 * The five quick views (SPEC §4.5.1, as built). The read API takes one `event` value,
 * so each view sets one filter and is named for exactly what that filter matches, the
 * same words as its chip: "Sign-in failed" is the exact event, which only rows recorded
 * since Round 14 carry (an older failed sign-in is a generic sign-in row with no outcome
 * of its own); "Access denied" is every row whose outcome is Denied (older access-denied
 * rows included); "User events" and "Settings events" are the `user` and `settings`
 * event types, which rows recorded since Round 14 carry (an older user or settings row
 * keeps its stored type, and is found under its category in the Event menu);
 * "Configuration and data" is that whole category, older rows included. The SPEC's wider views (every failed sign-in step,
 * user and role changes, settings changes of every age, exports and resets) need the
 * read API to take several event values at once; until it does, no label promises more
 * than it matches.
 */
export const AUDIT_QUICK_VIEWS: readonly AuditQuickView[] = [
  { id: 'sign-in-failed', label: 'Sign-in failed', event: 'auth.login_failed', scope: 'people' },
  { id: 'access-denied', label: 'Access denied', outcome: 'denied', scope: 'people' },
  { id: 'user-events', label: 'User events', event: 'user', scope: 'people' },
  { id: 'settings-events', label: 'Settings events', event: 'settings', scope: 'people' },
  { id: 'configuration-data', label: 'Configuration and data', event: 'config', scope: 'people' },
];

/** The help tip beside "Quick views": what a view applies and what it leaves out. */
export const AUDIT_QUICK_VIEWS_HELP =
  'Each quick view sets one filter, shown as a chip. Sign-in failed, User events and Settings events match rows ' +
  'recorded since Round 14; for older rows, pick Access and identity or Configuration and data in the Event menu.';

/** Is this quick view the filter the page applies now? */
export function quickViewActive(qv: AuditQuickView, event: string | null, outcome: string | null): boolean {
  return (qv.event ?? null) === event && (qv.outcome ?? null) === outcome && Boolean(qv.event || qv.outcome);
}
