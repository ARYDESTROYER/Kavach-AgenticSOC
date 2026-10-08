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
