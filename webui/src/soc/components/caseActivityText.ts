/**
 * Plain words for a case activity row (Round 14, SPEC §4.9.4, ui-audit CM4 and X11).
 *
 * Several pipeline and automation writers record their audit summary as `key=value`
 * text ("rule=demo-seed-approval action=request_approval proposal=prop-... kind=..."),
 * which the Collaboration timeline used to print as it was. This module reads the shapes
 * those writers produce and returns one plain sentence instead. The recorded text is kept
 * (`recorded`) so the row's Details disclosure still shows exactly what the audit log
 * holds (#2): the sentence is presentation only and never feeds a decision (#3).
 *
 * Every shape is matched in full and anchored; anything that does not match is returned
 * unchanged, so a new or unknown summary is never guessed at.
 *
 * Cases investigated before Round 14 keep their stored rows, written with the retired
 * procedure noun (`playbook=...`, actor `playbook_selector`, action type `playbook`).
 * Those shapes are read too, and their tokens get the Console-authored friendly names of
 * SPEC §3.1 ("Runbook selector (before Round 14)"); the stored text stays verbatim under
 * Details (AU-7).
 *
 * SECURITY (#9): the values come from the audit trail and can carry log- or
 * operator-derived text (a rule id, a reasoning excerpt). They are only ever copied into
 * a string that the caller renders as a plain text node, never as markup.
 */
import { humanizeToken } from '@/lib/format';
import { confidencePercent, verdictWords } from '@/soc/components/outcome';

/** A prompt excerpt longer than this, or on several lines, is kept under Details. */
const PROMPT_INLINE_MAX = 240;

/** A row's display text, and the recorded summary when the display text differs. */
export interface ActivityText {
  text: string;
  /** The summary exactly as recorded, present only when `text` rewrote it. */
  recorded: string | null;
}

interface ActivityInput {
  kind?: string | null;
  actor?: string | null;
  summary?: string | null;
}

/** Actors the pipeline writes as internal tokens, in the words the timeline shows. */
const SYSTEM_ACTORS: Readonly<Record<string, string>> = {
  automation: 'Automation',
  case_manager: 'Case manager',
  context: 'Investigation context',
  formatter: 'Formatter',
  investigator: 'Investigator',
  pipeline: 'Pipeline',
  procedure_provenance: 'Procedure record',
  router: 'Router',
  runbook_selector: 'Runbook selector',
  // Legacy tokens (SPEC §3.1): the stored value stays in the record; a list names them.
  playbook_selector: 'Runbook selector (before Round 14)',
  run_playbook: 'Runbook automation (before Round 14)',
  analyst_policy: 'Analyst policy',
  agentic_soc: 'Agentic SOC',
  scheduler: 'Scheduler',
  poller: 'Poller',
  system: 'System',
};

/**
 * The actor's display name: the plain name of a known pipeline actor, otherwise the
 * recorded value unchanged (a person's username is never rewritten).
 */
export function activityActorLabel(actor: string | null | undefined): string {
  const raw = String(actor ?? '').trim();
  if (!raw) return 'System';
  return SYSTEM_ACTORS[raw.toLowerCase()] ?? raw;
}

/** Activity kinds (audit action types) whose list name is not the token's own words. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  // Legacy `ActionType.PLAYBOOK` (SPEC §3.1).
  playbook: 'Runbook (before Round 14)',
};

/** The kind badge's words: a friendly name for a legacy token, else the token's words. */
export function activityKindLabel(kind: string | null | undefined): string {
  const raw = String(kind ?? '').trim();
  if (!raw) return 'Event';
  return KIND_LABELS[raw.toLowerCase()] ?? humanizeToken(raw);
}

/** "97% confidence", or empty when the value is not a number. */
function confidencePhrase(raw: string): string {
  const pct = confidencePercent(Number(raw));
  return pct === null || !raw.trim() ? '' : `${pct}% confidence`;
}

/** "false positive" (the verdict in running text). */
function verdictInText(raw: string): string {
  return verdictWords(raw).toLowerCase();
}

/** "(rule X)", the automation rule a sentence names. */
function ruleNote(rule: string): string {
  return rule ? ` (rule ${rule})` : '';
}

/** Join sentences, dropping empty ones. */
function sentences(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
    .join(' ');
}

const APPROVAL_KIND: Readonly<Record<string, string>> = {
  automation_ack: 'review',
  suppression: 'suppression',
  memory: 'memory',
};

function approvalKind(kind: string): string {
  return APPROVAL_KIND[kind] ?? humanizeToken(kind).toLowerCase();
}

/** `threshold_automation` action rows: `rule=<id> action=<action> <detail>`. */
function automationAction(rule: string, action: string, detail: string): string {
  switch (action) {
    case 'request_approval': {
      if (/^proposal=none$/.test(detail)) return `Automation could not request approval${ruleNote(rule)}.`;
      return `Automation requested approval${ruleNote(rule)}.`;
    }
    case 'tag': {
      const tag = /^tag=(.*?)(?:\. Not added: (.*?)\.?)?$/s.exec(detail);
      const tags = tag?.[1]?.trim() ?? '';
      const lead =
        !tags || tags === '(empty)'
          ? `Automation had no tags to add${ruleNote(rule)}.`
          : `Automation tagged the case: ${tags}${ruleNote(rule)}.`;
      return tag?.[2] ? sentences(lead, `Not added: ${tag[2]}`) : lead;
    }
    case 'recommend': {
      const text = /^recommend=(.*)$/s.exec(detail)?.[1]?.trim() ?? '';
      return text
        ? `Automation recommended: ${text}${ruleNote(rule)}.`
        : `Automation made a recommendation${ruleNote(rule)}.`;
    }
    case 'notify':
      return `Automation sent a notification${ruleNote(rule)}.`;
    case 'run_playbook': {
      // Before Round 14 the action queued a new investigation with the runbook as context.
      const queued = /^run_playbook=(.*) queued=(True|False)$/s.exec(detail);
      if (queued) {
        const id = queued[1].trim();
        if (!id || id === '(none)') return `Automation found no runbook to use${ruleNote(rule)}.`;
        return queued[2] === 'True'
          ? `Automation queued a new investigation with the runbook ${id}${ruleNote(rule)}.`
          : `Automation did not queue a new investigation with the runbook ${id}${ruleNote(rule)}.`;
      }
      const attach = /^attach_runbook=(.*) attached=(True|False)$/s.exec(detail);
      if (!attach) return `Automation tried to attach a runbook${ruleNote(rule)}.`;
      const id = attach[1].trim();
      if (attach[2] === 'True') return `Automation attached the runbook ${id}${ruleNote(rule)}.`;
      if (!id || id === '(none)') return `Automation found no runbook to attach${ruleNote(rule)}.`;
      return `Automation did not attach the runbook ${id}${ruleNote(rule)}.`;
    }
    default:
      return `Automation ran the action ${humanizeToken(action).toLowerCase()}${ruleNote(rule)}.`;
  }
}

const DECIDERS: Readonly<Record<string, string>> = {
  agent: 'by the AI agent',
  analyst: 'by an analyst',
  analyst_policy: 'by an analyst policy',
  system: 'by the system',
};

const DECISION_STATUS: Readonly<Record<string, string>> = {
  closed: 'Closed',
  resolved: 'Resolved',
  escalated: 'Escalated',
  needs_human: 'Left for an analyst',
  investigating: 'Kept under investigation',
  open: 'Kept open',
};

const GATE: Readonly<Record<string, string>> = {
  cleared: 'It met the auto-close bar',
  blocked_confidence: 'Confidence was below the auto-close bar',
  blocked_risk: 'Risk was above the auto-close bar',
  blocked_confidence_and_risk: 'Confidence was below and risk above the auto-close bar',
  class_disabled: 'Auto-close is off for this verdict',
  not_closable: 'This verdict never closes automatically',
};

/** The deterministic decision row the case manager writes after `decide()` (#3). */
function decisionRow(fields: {
  verdict: string;
  status: string;
  by: string;
  risk: string;
  confidence: string;
  gate: string;
}): string {
  const status = DECISION_STATUS[fields.status] ?? humanizeToken(fields.status);
  const by = DECIDERS[fields.by] ?? '';
  const assessment = [verdictInText(fields.verdict), confidencePhrase(fields.confidence)]
    .filter(Boolean)
    .join(' at ');
  const risk = fields.risk && fields.risk !== 'None' ? `risk ${fields.risk}` : '';
  const facts = [assessment, risk].filter(Boolean).join(', ');
  return sentences(`${[status, by].filter(Boolean).join(' ')}${facts ? `: ${facts}` : ''}`, GATE[fields.gate] ?? '');
}

const TRIAGE: Readonly<Record<string, string>> = {
  needs_strong_model: 'Triage sent the case to a full investigation',
  obviously_benign: 'Triage judged the case obviously benign',
  uncertain: 'Triage was uncertain about the case',
};

/** `['a', 'b']` (a Python list as recorded) as "a, b". */
function listWords(raw: string): string {
  const inner = raw.trim().replace(/^\[|\]$/g, '');
  return inner
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .join(', ');
}

/**
 * One `selected=<x> consulted=<bool>` half of the procedure record. A row from before
 * Round 14 names the runbook half `playbook`; it reads as a runbook.
 */
function consulted(noun: string, part: string): string {
  const match = /^(persona|runbook|playbook) selected=(.*?) consulted=(True|False)$/s.exec(part.trim());
  if (!match) return '';
  const name = match[2].trim();
  if (!name || name === 'none' || name === 'None') return `no ${noun} was selected`;
  const which = noun === 'persona' ? `the ${name} persona` : `the runbook ${name}`;
  return match[3] === 'True' ? `${which} was consulted` : `${which} was selected but not consulted`;
}

/** "Runbook X selected for the Y persona", or that none was selected. */
function selectionLead(label: string, persona: string): string {
  const name = label.trim();
  return !name || name === 'none'
    ? `No runbook selected (persona ${persona})`
    : `Runbook ${name} selected for the ${persona} persona`;
}

/**
 * The reason a selector row from before Round 14 recorded, in plain words where its
 * shape is known (`forced:<id>`, `forced_missing:<id>`, `matched ...`,
 * `no_playbook_matched`); anything else is left to Details.
 */
function legacySelectionReason(reason: string): string {
  if (/^forced:/.test(reason)) return 'An analyst chose it for this investigation';
  if (/^forced_missing:/.test(reason)) return 'The runbook an analyst chose was not found';
  if (/^matched\b/.test(reason)) return 'Its match rules matched this case';
  if (reason === 'no_playbook_matched') return 'No runbook matched this case';
  return '';
}

/** The read-only lookups a runbook step runs, by their tool token. */
const LOOKUP_TOOLS: Readonly<Record<string, string>> = {
  log_stats: 'Log statistics',
  log_search: 'Log search',
  enrich: 'Enrichment',
  related_cases: 'Related cases',
  campaign: 'Campaign',
  mitre: 'MITRE ATT&CK',
};

/** What a lookup's result status says, after the lookup's name. */
const LOOKUP_STATUS: Readonly<Record<string, string>> = {
  ok: 'lookup collected evidence',
  empty: 'lookup found nothing',
  partial: 'lookup returned partial results',
  error: 'lookup failed',
  not_applicable: 'lookup did not apply to this case',
};

/**
 * The display text for one activity row. A recognised `key=value` summary becomes one
 * plain sentence and `recorded` keeps the original; anything else is returned as it is.
 */
export function activityText(item: ActivityInput): ActivityText {
  const summary = String(item.summary ?? '');
  const raw = summary.trim();
  const plain = (text: string): ActivityText => ({ text, recorded: text === summary ? null : summary });
  if (!raw) return { text: '', recorded: null };

  let m = /^rule=(\S+) action=(\S+)(?: (.*))?$/s.exec(raw);
  if (m) return plain(automationAction(m[1], m[2], (m[3] ?? '').trim()));

  m = /^automation drafted (\S+) proposal \S+ \(rule=(\S+)\)$/.exec(raw);
  if (m) return plain(`Automation drafted a ${approvalKind(m[1])} proposal for approval${ruleNote(m[2])}.`);

  m =
    /^verdict=(\S+) status=(\S+) decision_by=(\S+) risk=(\S+) cost=\S+ confidence=(\S+) auto_close_gate=(\S+)$/.exec(
      raw,
    );
  if (m) {
    return plain(
      decisionRow({ verdict: m[1], status: m[2], by: m[3], risk: m[4], confidence: m[5], gate: m[6] }),
    );
  }

  m = /^verdict=(\S+) confidence=(\S+)(?: reasoning=(.*))?$/s.exec(raw);
  if (m) {
    const lead = ['Verdict ' + verdictInText(m[1]), confidencePhrase(m[2])].filter(Boolean).join(' at ');
    return plain(m[3]?.trim() ? `${sentences(lead)}\n${m[3].trim()}` : sentences(lead));
  }

  m = /^formatted verdict (\S+) \(confidence (\S+)\)$/.exec(raw);
  if (m) {
    const facts = [verdictInText(m[1]), confidencePhrase(m[2])].filter(Boolean).join(' at ');
    return plain(sentences(`Formatted the verdict: ${facts}`));
  }

  m = /^bucket=(\S+) confidence=(\S+) reason=(.*)$/s.exec(raw);
  if (m) {
    const lead = TRIAGE[m[1]] ?? `Triage chose ${humanizeToken(m[1]).toLowerCase()}`;
    const pct = Number(m[2]) > 0 ? ` (${confidencePhrase(m[2])})` : '';
    const reason = m[3].trim();
    return plain(sentences(`${lead}${pct}`, reason ? `Reason: ${reason}` : ''));
  }

  m = /^runbook=(.*?) persona=(\S+) reason=(\w+): (.*)$/s.exec(raw);
  if (m) return plain(sentences(selectionLead(m[1], m[2]), m[4].trim()));

  // The selector row before Round 14: `playbook=<id vN> persona=<p> reason=<reason>`.
  m = /^playbook=(.*?) persona=(\S+) reason=(.*)$/s.exec(raw);
  if (m) return plain(sentences(selectionLead(m[1], m[2]), legacySelectionReason(m[3].trim())));

  m = /^persona=(\S+) (?:runbook|playbook)=(.*)$/s.exec(raw);
  if (m) {
    const runbook = m[2].trim();
    return plain(
      runbook && runbook !== 'none'
        ? `Investigator prompt with the ${m[1]} persona and the runbook ${runbook}.`
        : `Investigator prompt with the ${m[1]} persona and no runbook.`,
    );
  }

  m = /^(persona selected=.*? consulted=(?:True|False)); ((?:runbook|playbook) selected=.*? consulted=(?:True|False))$/s.exec(raw);
  if (m) {
    const persona = consulted('persona', m[1]);
    const runbook = consulted('runbook', m[2]);
    if (persona && runbook) {
      return plain(sentences(`${persona.charAt(0).toUpperCase()}${persona.slice(1)}; ${runbook}`));
    }
  }

  // A runbook lookup's result row: `Lookup <tool> collected evidence (<status>).`, written
  // for every status, so the sentence follows the status (a failed lookup collected none).
  m = /^Lookup (\w+) collected evidence \((\w+)\)\.$/.exec(raw);
  if (m && LOOKUP_STATUS[m[2]]) {
    const name = LOOKUP_TOOLS[m[1]] ?? humanizeToken(m[1]);
    return plain(`${name} ${LOOKUP_STATUS[m[2]]}.`);
  }

  m = /^Runbook step (\S+) updated\.$/.exec(raw);
  if (m) return plain(`Runbook step "${humanizeToken(m[1])}" updated.`);

  m = /^registered candidate risk=(\S+) rules=(.*)$/s.exec(raw);
  if (m) {
    const rules = listWords(m[2]);
    return plain(`Registered as a candidate at risk ${m[1]}${rules ? ` (rules ${rules})` : ''}.`);
  }

  m = /^closed by analyst rule policy rules=(.*) policies=(\S*) risk=(\S+)$/s.exec(raw);
  if (m) {
    const rules = listWords(m[1]);
    return plain(`Closed by an analyst policy at risk ${m[3]}${rules ? ` (rules ${rules})` : ''}.`);
  }

  m = /^no material change; returning existing case unchanged \(verdict=(\S+)\)$/.exec(raw);
  if (m) return plain(`No material change, so the case stays as it was (${verdictInText(m[1])}).`);

  m = /^assessment=(\S+) outcome=(\S+) accuracy=(\S+)$/.exec(raw);
  if (m) {
    return plain(
      `Feedback recorded: ${humanizeToken(m[1]).toLowerCase()}, actual outcome ${humanizeToken(m[2]).toLowerCase()}, accuracy ${humanizeToken(m[3]).toLowerCase()}.`,
    );
  }

  // A prompt row records the prompt excerpt itself (fenced context, many lines): the
  // timeline names the step and keeps the excerpt in Details.
  if (String(item.kind ?? '').toLowerCase() === 'prompt' && (raw.includes('\n') || raw.length > PROMPT_INLINE_MAX)) {
    const to = String(item.actor ?? '').trim() ? activityActorLabel(item.actor).toLowerCase() : 'the model';
    return plain(`Prompt sent to the ${to.replace(/^the /, '')}.`);
  }

  return { text: summary, recorded: null };
}
