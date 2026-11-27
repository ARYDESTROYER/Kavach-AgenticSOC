/**
 * The words of the one Runbooks feature (Round 14, SPEC §4.10): phases, step kinds,
 * step statuses, governance states, origins, match criteria and lookup tools.
 *
 * Shared by the library and editor (W7a) and the run inside a case (W7b), so a phase or
 * a step kind reads the same on every surface. Console-authored copy only: plain, sentence
 * case, no em dashes, never the retired word for a procedure (§3.1). Stored runbook text
 * (titles, focus lines, notes) is shown verbatim elsewhere and never passes through here.
 *
 * Pure data and string helpers: no React, so tests and the Markdown helpers import it
 * without a DOM.
 */
import type {
  LookupRunMode,
  LookupTool,
  MatchCriterion,
  PhaseId,
  RunbookEntityType,
  RunbookOrigin,
  RunbookState,
  RunbookTemplateValue,
  RunbookVerdict,
  RunbookVersionState,
  StepEvidenceRule,
  StepKind,
  StepStatus,
} from '@/lib/types-runbooks';
import type { SeverityLevel } from '@/lib/types-rules';

/** The fixed phase vocabulary, in response order (NIST SP 800-61r3, SANS PICERL). */
export const PHASE_ORDER: readonly PhaseId[] = ['triage', 'investigate', 'contain', 'eradicate', 'recover', 'close'];

export const PHASE_LABEL: Readonly<Record<PhaseId, string>> = {
  triage: 'Triage',
  investigate: 'Investigate',
  contain: 'Contain',
  eradicate: 'Eradicate',
  recover: 'Recover',
  close: 'Close and learn',
};

/** How each phase maps to the two response frameworks (the backend's `PHASE_FRAMEWORKS`). */
export const PHASE_FRAMEWORKS: Readonly<Record<PhaseId, { nist: string; sans: string }>> = {
  triage: { nist: 'DE.AE, RS.MA-02, RS.MA-03', sans: 'Identification' },
  investigate: { nist: 'RS.AN-03, RS.AN-06 to RS.AN-08', sans: 'Identification' },
  contain: { nist: 'RS.MI-01', sans: 'Containment' },
  eradicate: { nist: 'RS.MI-02', sans: 'Eradication' },
  recover: { nist: 'RC.RP-01 to RC.RP-06', sans: 'Recovery' },
  close: { nist: 'RC.CO-03, RC.CO-04, ID.IM', sans: 'Lessons learned' },
};

/** "NIST RS.MI-01 · SANS Containment": the framework line under a phase heading. */
export function phaseFrameworkLine(phase: PhaseId): string {
  const f = PHASE_FRAMEWORKS[phase];
  return `NIST ${f.nist} · SANS ${f.sans}`;
}

export const STEP_KINDS: readonly StepKind[] = ['check', 'lookup', 'decision', 'action', 'record'];

export const KIND_LABEL: Readonly<Record<StepKind, string>> = {
  check: 'Check',
  lookup: 'Lookup',
  decision: 'Decision',
  action: 'Action',
  record: 'Record',
};

/** Who does a step of each kind (SPEC §4.10.3), for menus and tooltips. */
export const KIND_HELP: Readonly<Record<StepKind, string>> = {
  check: 'A person verifies something and writes a note.',
  lookup: 'Agentic SOC runs a read-only query and attaches the result.',
  decision: 'A person picks an option. An option can skip later steps.',
  action: 'A person acts in another system. Agentic SOC keeps the record.',
  record: 'A person notifies, documents or hands off. Agentic SOC keeps the record.',
};

/** The line every step of a kind carries in a run (SPEC §4.10.3 "Copy on the step"). */
export const KIND_STEP_NOTE: Readonly<Record<StepKind, string>> = {
  check: 'Your note',
  lookup: 'Read-only. Log values are shown as untrusted data.',
  decision: 'Recording a decision does not change the verdict or close the case.',
  action: 'Agentic SOC does not run this action. It keeps the record.',
  record: 'Agentic SOC does not send this. It keeps the record.',
};

/** The kind note under a step's form: who does it and what Agentic SOC does, said once. */
export const KIND_FORM_NOTE: Readonly<Record<StepKind, string>> = {
  check: 'A person verifies something and writes a note.',
  lookup: 'Agentic SOC runs a read-only query and attaches the result. Log values are shown as untrusted data.',
  decision: 'A person picks an option, and an option can skip later steps. Recording a decision does not change the verdict or close the case.',
  action: 'A person acts in another system. Agentic SOC does not run this action; it keeps the record.',
  record: 'A person notifies, documents or hands off. Agentic SOC does not send anything; it keeps the record.',
};

/** A step's display status: the five stored values plus the derived "waiting". */
export type StepDisplayStatus = StepStatus | 'waiting';

export const STEP_STATUS_LABEL: Readonly<Record<StepDisplayStatus, string>> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  not_applicable: 'Not applicable',
  blocked: 'Blocked',
  waiting: 'Waiting for approval',
};

/** A library row's state, as the State column words it with its version. */
export const RUNBOOK_STATE_LABEL: Readonly<Record<RunbookState, string>> = {
  draft: 'Draft',
  in_review: 'In review',
  published: 'Published',
  retired: 'Retired',
};

export const VERSION_STATE_LABEL: Readonly<Record<RunbookVersionState, string>> = {
  draft: 'Draft',
  in_review: 'In review',
  published: 'Published',
  superseded: 'Replaced',
  retired: 'Retired',
};

export const ORIGIN_LABEL: Readonly<Record<RunbookOrigin, string>> = {
  builtin: 'Built-in',
  operator: 'Yours',
  imported: 'Imported',
};

export const ENTITY_TYPES: readonly RunbookEntityType[] = [
  'ip',
  'host',
  'user',
  'domain',
  'hash',
  'url',
  'email',
  'process',
  'file',
];

export const ENTITY_TYPE_LABEL: Readonly<Record<RunbookEntityType, string>> = {
  ip: 'IP address',
  host: 'Host',
  user: 'User',
  domain: 'Domain',
  hash: 'File hash',
  url: 'URL',
  email: 'Email address',
  process: 'Process',
  file: 'File',
};

export const SEVERITY_LEVELS: readonly SeverityLevel[] = ['info', 'low', 'medium', 'high', 'critical'];

export const SEVERITY_WORD: Readonly<Record<SeverityLevel, string>> = {
  info: 'Info',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const VERDICTS: readonly RunbookVerdict[] = ['TRUE_POSITIVE', 'FALSE_POSITIVE', 'NEEDS_HUMAN'];

export const VERDICT_WORD: Readonly<Record<RunbookVerdict, string>> = {
  TRUE_POSITIVE: 'True positive',
  FALSE_POSITIVE: 'False positive',
  NEEDS_HUMAN: 'Needs a person',
};

/** The case statuses a runbook can name (the backend's `CaseStatus` values). */
export const CASE_STATUSES: readonly string[] = [
  'new',
  'open',
  'needs_human',
  'investigating',
  'escalated',
  'on_hold',
  'resolved',
  'closed',
];

export const CASE_STATUS_WORD: Readonly<Record<string, string>> = {
  new: 'New',
  open: 'Open',
  needs_human: 'Open, awaiting analyst',
  investigating: 'Investigating',
  escalated: 'Escalated',
  on_hold: 'On hold',
  resolved: 'Resolved',
  closed: 'Closed',
};

/** The chip prefix of each Applies when criterion ("Rule ssh_auth_failed"). */
export const CRITERION_LABEL: Readonly<Record<MatchCriterion, string>> = {
  rule_ids: 'Rule',
  mitre: 'Technique',
  entity_types: 'Entity',
  severity_at_least: 'Severity',
  sources: 'Source',
  verdicts: 'Verdict',
  statuses: 'Status',
  any_tags: 'Tag',
  min_event_count: 'Events',
  always: 'Fallback',
};

/** The order the editor lists criteria in (and the server's `CRITERIA_ORDER`). */
export const CRITERIA_ORDER: readonly MatchCriterion[] = [
  'rule_ids',
  'mitre',
  'entity_types',
  'severity_at_least',
  'sources',
  'verdicts',
  'statuses',
  'any_tags',
  'min_event_count',
  'always',
];

export const LOOKUP_TOOLS: readonly LookupTool[] = [
  'log_stats',
  'log_search',
  'enrich',
  'related_cases',
  'campaign',
  'mitre',
];

export const LOOKUP_TOOL_LABEL: Readonly<Record<LookupTool, string>> = {
  log_stats: 'Log counts, read-only log key',
  log_search: 'Log search, read-only log key',
  enrich: 'Indicator reputation, cached',
  related_cases: 'Related cases',
  campaign: 'Campaign membership',
  mitre: 'ATT&CK context',
};

/** What each tool needs to run and to be seen (SPEC §4.10.8). */
export const LOOKUP_TOOL_GRANT: Readonly<Record<LookupTool, string>> = {
  log_stats: 'Needs access to log sources.',
  log_search: 'Needs access to log sources. Rows are shown to people only.',
  enrich: 'Needs access to enrichment results.',
  related_cases: 'Needs access to cases.',
  campaign: 'Needs access to cases.',
  mitre: 'Anyone who can read runbooks can see it.',
};

export const RUN_MODE_LABEL: Readonly<Record<LookupRunMode, string>> = {
  on_attach: 'When the runbook starts',
  on_demand: 'When the analyst presses Run',
};

export const EVIDENCE_LABEL: Readonly<Record<StepEvidenceRule, string>> = {
  none: 'Nothing',
  note: 'A note',
  note_or_attachment: 'A note or a link',
};

/** The closed set of lookup template values (SPEC §4.10.8), in the order the editor offers them. */
export const TEMPLATE_VALUES: readonly RunbookTemplateValue[] = [
  'entity.ip',
  'entity.user',
  'entity.host',
  'entity.domain',
  'entity.hash',
  'entity.url',
  'entity.email',
  'case.rule',
  'case.source_id',
  'case.first_seen',
  'case.last_seen',
];

export const TEMPLATE_VALUE_LABEL: Readonly<Record<RunbookTemplateValue, string>> = {
  'entity.ip': 'The case IP address',
  'entity.user': 'The case user',
  'entity.host': 'The case host',
  'entity.domain': 'The case domain',
  'entity.hash': 'The case file hash',
  'entity.url': 'The case URL',
  'entity.email': 'The case email address',
  'case.rule': 'The case rule',
  'case.source_id': 'The case source',
  'case.first_seen': 'When the case was first seen',
  'case.last_seen': 'When the case was last seen',
};

/** `{{entity.ip}}`: how a template value is written in a filter or an indicator. */
export function templateToken(value: RunbookTemplateValue): string {
  return `{{${value}}}`;
}

const TEMPLATE_RE = /^\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}$/;

/** The template value a filter value names, or `null` for a literal. */
export function templateValueOf(text: string | null | undefined): RunbookTemplateValue | null {
  const m = TEMPLATE_RE.exec((text ?? '').trim());
  if (!m) return null;
  return (TEMPLATE_VALUES as readonly string[]).includes(m[1]) ? (m[1] as RunbookTemplateValue) : null;
}

/** A filter value that LOOKS like a template but names no value in the closed set. */
export function isUnknownTemplate(text: string | null | undefined): boolean {
  const value = (text ?? '').trim();
  return value.includes('{{') && templateValueOf(value) === null;
}

/** The reserved runbook ids (the backend's `RUNBOOK_RESERVED_IDS`). */
export const RESERVED_RUNBOOK_IDS: readonly string[] = [
  'new',
  'metrics',
  'validate',
  'import',
  'progress',
  'match-preview',
  'lookup-test',
  'reindex',
  'readme',
  'index',
];

/** The operator runbook id grammar (also the `#/runbooks?id=` deep-link validator). */
export const RUNBOOK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A step or option id: a lower-case slug, stable across versions. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** True when `id` can name an operator runbook (grammar and not reserved). */
export function isValidRunbookId(id: string): boolean {
  return RUNBOOK_ID_PATTERN.test(id) && !RESERVED_RUNBOOK_IDS.includes(id);
}

/** Limits of the runbook model (SPEC §4.10.2), mirrored for the editor's counters. */
export const RUNBOOK_LIMITS = {
  title: 120,
  summary: 280,
  useWhen: 500,
  prerequisites: 500,
  steps: 40,
  stepTitle: 160,
  instructions: 2_000,
  guidance: 300,
  optionLabel: 80,
  optionsMin: 2,
  optionsMax: 6,
  filters: 8,
  groupBy: 2,
  limitMax: 50,
  searchRows: 20,
  rules: 50,
  ruleChars: 256,
  mitre: 50,
  sources: 20,
  statuses: 10,
  tags: 20,
  tagChars: 64,
  references: 10,
  retrievalQueries: 5,
  retrievalQueryChars: 200,
  reviewMin: 30,
  reviewMax: 730,
  reviewDefault: 180,
  promptBudget: 3_000,
  sourceBytes: 65_536,
} as const;

/** The default lookup window, relative to the case. */
export const DEFAULT_LOOKUP_WINDOW = 'case_first_seen-1h..case_last_seen+1h';

type WindowAnchor = 'case_first_seen' | 'case_last_seen' | 'now';
interface WindowBound {
  anchor: WindowAnchor;
  /** Signed offset: the amount and its unit (m, h, d, w). */
  sign: -1 | 0 | 1;
  amount: number;
  unit: 'm' | 'h' | 'd' | 'w';
}

/** The server's bound grammar (`runbook_lookup._BOUND_RE`). */
const BOUND_RE = /^(case_first_seen|case_last_seen|now)(?:([+-])(\d{1,6})([mhdw]))?$/;
const RELATIVE_RE = /^now-(\d{1,6})([mhdw])$/;
const UNIT_WORD: Readonly<Record<WindowBound['unit'], string>> = { m: 'minute', h: 'hour', d: 'day', w: 'week' };
const CALENDAR_WORDS: Readonly<Record<string, string>> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
};

function parseBound(raw: string): WindowBound | null {
  const m = BOUND_RE.exec(raw.trim());
  if (!m) return null;
  const amount = m[3] ? Number(m[3]) : 0;
  const sign: WindowBound['sign'] = !m[2] || amount === 0 ? 0 : m[2] === '-' ? -1 : 1;
  return { anchor: m[1] as WindowAnchor, sign, amount, unit: (m[4] as WindowBound['unit']) ?? 'h' };
}

/** "an hour", "a day", "7 days", "30 minutes". */
function span(amount: number, unit: WindowBound['unit']): string {
  const word = UNIT_WORD[unit];
  if (amount === 1) return `${unit === 'h' ? 'an' : 'a'} ${word}`;
  return `${amount.toLocaleString()} ${word}s`;
}

/** "hour", "24 hours": the span after "The last" or "The". */
function bareSpan(amount: number, unit: WindowBound['unit']): string {
  const word = UNIT_WORD[unit];
  return amount === 1 ? word : `${amount.toLocaleString()} ${word}s`;
}

/** One bound in words; `subject` names the case ("the case") or refers back to it ("it"). */
function boundWords(b: WindowBound, subject: string): string {
  if (b.anchor === 'now') {
    if (b.sign === 0) return 'now';
    return b.sign < 0 ? `${span(b.amount, b.unit)} ago` : `${span(b.amount, b.unit)} from now`;
  }
  const seen = b.anchor === 'case_first_seen' ? 'first seen' : 'last seen';
  if (b.sign === 0) return `when ${subject} was ${seen}`;
  return `${span(b.amount, b.unit)} ${b.sign < 0 ? 'before' : 'after'} ${subject} was ${seen}`;
}

/**
 * A lookup window in words (the grammar of SPEC §4.10.8, `runbook_lookup.parse_window`):
 * "From an hour before the case was first seen to an hour after it was last seen", "The 30
 * days up to the case's last event", "The last 7 days", "Today". A value outside the grammar
 * is shown as written, so nothing is hidden.
 */
export function windowLabel(window: string): string {
  const text = (window ?? '').trim();
  if (!text) return windowLabel(DEFAULT_LOOKUP_WINDOW);
  if (CALENDAR_WORDS[text]) return CALENDAR_WORDS[text];
  const relative = RELATIVE_RE.exec(text);
  if (relative) return `The last ${bareSpan(Number(relative[1]), relative[2] as WindowBound['unit'])}`;
  if (!text.includes('..')) return text;
  const [loRaw, hiRaw] = text.split('..', 2);
  const lo = parseBound(loRaw);
  const hi = parseBound(hiRaw);
  if (!lo || !hi) return text;
  if (lo.anchor === hi.anchor && hi.sign === 0 && lo.sign < 0) {
    const length = bareSpan(lo.amount, lo.unit);
    if (lo.anchor === 'now') return `The last ${length}`;
    return `The ${length} up to the case's ${lo.anchor === 'case_first_seen' ? 'first' : 'last'} event`;
  }
  const loText = boundWords(lo, 'the case');
  const hiText = boundWords(hi, lo.anchor === 'now' ? 'the case' : 'it');
  return `From ${loText} to ${hiText}`;
}

/** "1 step", "4 steps": counts with thousands separators and the right noun. */
export function countNoun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}
