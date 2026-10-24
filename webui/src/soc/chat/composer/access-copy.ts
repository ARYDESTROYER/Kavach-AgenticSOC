/**
 * Copy for "What the assistant can access?" (SPEC §5.6): capabilities in the present
 * tense, and the grants that would unlock a tool.
 *
 * The backend catalogue's `label` is the RUN-LOG label, written in the past tense
 * ("Searched logs") because the run log reports what happened. A list of what the
 * assistant CAN do must read as abilities ("Search logs"), so the known tools are
 * mapped here by name; an unknown future tool gets its leading verb turned into the
 * present tense, and anything else keeps the server label unchanged. Every string is
 * rendered as text (#9).
 */
import type { ChatToolInfo } from '@/lib/types';

/** Present-tense capability per known chat tool (the registry's names). */
export const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  search_logs: 'Search logs',
  log_stats: 'Count log events',
  search_cases: 'Search cases',
  get_case: 'Read a case',
  shift_report: 'Build the shift snapshot',
  list_campaigns: 'List campaigns',
  explain_decision: 'Explain the decision policy',
  soc_metrics: 'Read SOC metrics',
  cost_usage: 'Read AI cost and usage',
  lookup_indicator: 'Look up an indicator',
  mitre_lookup: 'Look up ATT&CK techniques',
  search_knowledge: 'Search the knowledge base',
  source_health: 'Check source health',
  automation_status: 'Read automation status',
  audit_search: 'Search the audit trail',
  app_help: 'Search the Help Center',
  app_status: 'Check this deployment',
};

/** Past-tense run-log verbs → present tense, for tools this client does not know yet. */
const VERB_PRESENT: ReadonlyArray<[RegExp, string]> = [
  [/^Searched\b/, 'Search'],
  [/^Looked up\b/, 'Look up'],
  [/^Counted\b/, 'Count'],
  [/^Checked\b/, 'Check'],
  [/^Listed\b/, 'List'],
  [/^Built\b/, 'Build'],
  [/^Explained\b/, 'Explain'],
  [/^Fetched\b/, 'Fetch'],
  [/^Summari[sz]ed\b/, 'Summarise'],
];

/** "Search logs" for the access list (never the past-tense run-log label). */
export function capabilityLabel(tool: Pick<ChatToolInfo, 'name' | 'label'>): string {
  const known = CAPABILITY_LABELS[tool.name];
  if (known) return known;
  for (const [pattern, present] of VERB_PRESENT) {
    if (pattern.test(tool.label)) return tool.label.replace(pattern, present);
  }
  return tool.label;
}

/** True when the tool has no base grant and any ONE of its per-kind grants unlocks it. */
export function isKindGated(tool: Pick<ChatToolInfo, 'requires' | 'kind_requires'>): boolean {
  return tool.requires.length === 0 && Object.keys(tool.kind_requires ?? {}).length > 0;
}

/**
 * Round 13 (SPEC-chat T24): a missing grant reads as a plain sentence ("Needs permission
 * to read sources") with the `resource:action` code beside it, muted, so an administrator
 * can still grant it. Known grants have hand-written phrases; any other one reads
 * "<action> <resource>" with underscores as spaces.
 */
export const PERMISSION_PHRASES: Readonly<Record<string, string>> = {
  'cases:read': 'read cases',
  'sources:read': 'read sources',
  'metrics:view': 'view metrics',
  'cost:view': 'view costs',
  'audit:view': 'view the audit trail',
  'enrichment:read': 'read threat intel',
  'rag:read': 'read the knowledge base',
  'runbooks:read': 'read runbooks',
  'playbooks:read': 'read playbooks',
  'memory:read': 'read memory',
  'automation:read': 'read automation',
  'settings:read': 'read settings',
  'proposals:read': 'read approvals',
  'rules:read': 'read rules',
  'models:read': 'read models',
};

const GRANT_RE = /^([a-z][a-z0-9_]*):([a-z][a-z0-9_]*)$/;

/** "read sources" for `sources:read`; an unknown well-formed grant reads "<action> <resource>". */
export function permissionPhrase(grant: string): string {
  const known = PERMISSION_PHRASES[grant];
  if (known) return known;
  const match = GRANT_RE.exec(grant);
  if (!match) return grant;
  return `${match[2].replace(/_/g, ' ')} ${match[1].replace(/_/g, ' ')}`;
}

/** A missing grant as copy: the sentence and the codes (shown muted, in parentheses). */
export interface PermissionNeed {
  /** "Needs permission to read sources" / "… to read sources or view metrics". */
  text: string;
  /** "(sources:read)" / "(sources:read or metrics:view)". */
  code: string;
}

/**
 * The copy for what a caller lacks. `missing` is one grant, or several joined with
 * " or " (any one unlocks it) or " and " (all are needed), as {@link missingGrant} and
 * `ScopeAccess.missing` give them. `prefix` replaces "Needs" ("Some details need").
 */
export function permissionNeed(missing: string, prefix = 'Needs'): PermissionNeed {
  const joiner = / or /.test(missing) ? 'or' : 'and';
  const grants = missing
    .split(/ (?:or|and) /)
    .map((grant) => grant.trim())
    .filter(Boolean);
  const phrases: string[] = [];
  for (const grant of grants) {
    const phrase = permissionPhrase(grant);
    if (!phrases.includes(phrase)) phrases.push(phrase);
  }
  const list =
    phrases.length <= 1
      ? (phrases[0] ?? 'access')
      : `${phrases.slice(0, -1).join(', ')} ${joiner} ${phrases[phrases.length - 1]}`;
  return { text: `${prefix} permission to ${list}`, code: `(${grants.join(` ${joiner} `)})` };
}

/** One line: "Needs permission to read sources (sources:read)". */
export function permissionNeedText(missing: string, prefix = 'Needs'): string {
  const need = permissionNeed(missing, prefix);
  return `${need.text} ${need.code}`;
}
