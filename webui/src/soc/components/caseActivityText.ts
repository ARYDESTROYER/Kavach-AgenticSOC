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
 * SPEC §3.1 ("Older runbook selector"); the stored text stays verbatim under
 * Details (AU-7).
 *
 * SECURITY (#9): the values come from the audit trail and can carry log- or
 * operator-derived text (a rule id, a reasoning excerpt). They are only ever copied into
 * a string that the caller renders as a plain text node, never as markup.
 */
import { humanizeToken } from '@/lib/format';
import { confidencePercent, dispositionWords, verdictWords } from '@/soc/components/outcome';

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
  playbook_selector: 'Older runbook selector',
  run_playbook: 'Older runbook automation',
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
  playbook: 'Older runbook',
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

/** Whether an automation notification went out, as its record says. */
export type NotifyDelivery = 'sent' | 'not_sent' | 'partly_sent';

/**
 * The detail a `notify` action records (`_maybe_notify` in `engine/threshold_automation.py`):
 * `notify=<trigger>` when every channel took it,
 * `notify=<trigger>. Not sent: <reason>.` when nothing went out (a channel failed or was
 * rate limited, the service failed or is not connected, or no channel was due: notifications
 * are off, no channel takes the trigger, no one is addressed, or a repeat inside the dedup
 * window), and `notify=<trigger>. Partly sent: <reason>.` when some channels did not take it
 * (or the service failed after one did). Only a detail without a note reads as a send, so the
 * backend writes a note on every path on which nothing, or not everything, went out.
 */
const NOTIFY_DETAIL = /^notify=(.*?)(?:\. (Not sent|Partly sent): (.*?)\.?)?$/s;

/**
 * How a notification went, read from its recorded detail, with the recorded reason when
 * it did not (all) go out. A detail without a note reads `sent`, as it always has.
 */
export function notifyDelivery(detail: unknown): { delivery: NotifyDelivery; reason: string } {
  const m = typeof detail === 'string' ? NOTIFY_DETAIL.exec(detail.trim()) : null;
  const reason = m?.[3]?.trim() ?? '';
  if (m?.[2] === 'Not sent') return { delivery: 'not_sent', reason };
  if (m?.[2] === 'Partly sent') return { delivery: 'partly_sent', reason };
  return { delivery: 'sent', reason: '' };
}

/** A `notify` action row in words: whether the notification went out, and why not. */
function automationNotify(rule: string, detail: string): string {
  const { delivery, reason } = notifyDelivery(detail);
  if (delivery === 'not_sent') {
    return sentences(`Automation did not send a notification${ruleNote(rule)}`, reason ? `Not sent: ${reason}` : '');
  }
  if (delivery === 'partly_sent') {
    return sentences(
      `Automation sent the notification to some channels${ruleNote(rule)}`,
      reason ? `Partly sent: ${reason}` : '',
    );
  }
  return `Automation sent a notification${ruleNote(rule)}.`;
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
      return automationNotify(rule, detail);
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

/** The case manager's DECISION record, its gate token optional (older rows lack it). */
const DECISION_RECORD_ROW =
  /^verdict=\S+ status=(\S+) decision_by=(\S+) risk=\S+ cost=\S+ confidence=\S+(?: auto_close_gate=\S+)?$/;

/**
 * Who settled a case and how, in words, from the case manager's DECISION record
 * (`verdict=… status=… decision_by=… risk=… cost=… confidence=… auto_close_gate=…`):
 * "Escalated by the system.", "Closed by the AI agent.", "Left for an analyst.". Null when
 * `raw` is not that record. It leaves out the verdict, confidence, risk and cost (the
 * header has them, and Policy inputs keeps the record word for word) and the gate (the
 * auto-close line explains it). Our own words from the enum tokens only (#9).
 */
export function decisionRecordSentence(raw: string): string | null {
  const m = DECISION_RECORD_ROW.exec(raw.trim());
  if (!m) return null;
  const [, status, by] = m;
  const decider = ownWord(DECIDERS, by);
  return `${ownWord(DECISION_STATUS, status) ?? humanizeToken(status)}${decider ? ` ${decider}` : ''}.`;
}

/** A table's own entry for `key` (never an inherited one such as `constructor`). */
function ownWord(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** A number the engine wrote into a rationale template. */
const NUM = '(-?\\d+(?:\\.\\d+)?)';
const VERDICT_TOKEN = '(?:TRUE_POSITIVE|FALSE_POSITIVE|NEEDS_HUMAN|\\?)';

/**
 * The fixed rationale templates `decide()` writes (`backend/app/engine/case_manager.py`),
 * the same set chat words in `agents/chat_tools/common.py` `status_reason_text`. Each
 * reads as the gate it records, so the words come from {@link GATE}.
 */
const RATIONALE_AUTO_CLOSED = new RegExp(
  `^${VERDICT_TOKEN} auto-closed: confidence ${NUM} >= ${NUM} and risk ${NUM} <= ${NUM}; objection window \\d+m\\.?$`,
);
const RATIONALE_BELOW_BAR = new RegExp(
  `^${VERDICT_TOKEN} routed to human: did not clear the auto-close bar \\(confidence ${NUM} vs ${NUM}, risk ${NUM} vs ${NUM}\\)\\.?$`,
);
const RATIONALE_CLASS_OFF = /^(?:True|False) positive routed to human: (?:tp|fp) auto-close disabled\.?$/;
const RATIONALE_FAIL_SAFE = /^No confident close decision; routing to human \(fail-safe\)\.?$/;

/** The case manager's decision, in words: how it routed the case, and why. */
export interface DecisionWords {
  /** Who settled it and how: "Sent to an analyst by the case policy.", "Escalated by the system.". */
  route: string;
  /** The gate it recorded, as a sentence ("Auto-close is off for this verdict."), or empty. */
  why: string;
}

/**
 * The deterministic decision a case recorded, in plain words: the case manager's DECISION
 * audit record (`verdict=… status=… decision_by=…`) or the rationale `decide()` wrote into
 * the case history ("True positive routed to human: tp auto-close disabled."). Null for
 * any other text, which the caller never shows as it is: the record stays word for word
 * in Policy inputs. The Brief's Decision lane and the History share this one mapping.
 * Our own words from the engine's fixed templates and enum tokens only (#9). Nothing here
 * decides (#3).
 */
export function decisionWords(raw: string | null | undefined): DecisionWords | null {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const record = /^verdict=\S+ status=(\S+) decision_by=(\S+) risk=\S+ cost=\S+ confidence=\S+(?: auto_close_gate=(\S+))?$/.exec(
    text,
  );
  if (record) {
    const gate = record[3] ? ownWord(GATE, record[3]) : undefined;
    return { route: decisionRecordSentence(text) ?? '', why: gate ? `${gate}.` : '' };
  }
  if (RATIONALE_AUTO_CLOSED.test(text)) {
    return { route: 'Closed automatically by the case policy.', why: `${GATE.cleared}.` };
  }
  const bar = RATIONALE_BELOW_BAR.exec(text);
  if (bar) {
    const [conf, minConf, risk, maxRisk] = bar.slice(1).map(Number);
    const low = conf < minConf;
    const high = risk > maxRisk;
    const gate = low && high ? 'blocked_confidence_and_risk' : high ? 'blocked_risk' : 'blocked_confidence';
    return { route: 'Sent to an analyst by the case policy.', why: `${GATE[gate]}.` };
  }
  if (RATIONALE_CLASS_OFF.test(text)) {
    return { route: 'Sent to an analyst by the case policy.', why: `${GATE.class_disabled}.` };
  }
  if (RATIONALE_FAIL_SAFE.test(text)) {
    return { route: 'Sent to an analyst by the case policy.', why: `${GATE.not_closable}.` };
  }
  return null;
}

/** The severity range a stored trigger sentence ends with; its ends compare as numbers. */
const SEVERITY_RANGE = /; severity (-?\d+(?:\.\d+)?)[\u2013-](-?\d+(?:\.\d+)?)$/;

/**
 * A stored trigger sentence as the Console shows it. Correlation writes the severity as
 * a range even when both ends are the same ("; severity 75" then an en dash and "75"),
 * so a range with equal ends reads as one value ("; severity 75"). Any other sentence,
 * and a real range, is returned as stored. Presentation only: the stored sentence is
 * never rewritten, and it is UNTRUSTED text the caller renders as a text node (#9).
 */
export function triggerSentenceText(raw: string | null | undefined): string {
  const text = String(raw ?? '').trim();
  const m = SEVERITY_RANGE.exec(text);
  if (!m || Number(m[1]) !== Number(m[2])) return text;
  return `${text.slice(0, m.index)}; severity ${m[1]}`;
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

/**
 * The read-only lookups a runbook step runs, by their tool token: the labels the server
 * writes (`runbook_lookup.TOOL_RULES`), so a row written before the server worded its own
 * summary reads the same as one written after.
 */
const LOOKUP_TOOLS: Readonly<Record<string, string>> = {
  log_stats: 'Log statistics',
  log_search: 'Log search',
  enrich: 'Enrichment',
  related_cases: 'Related cases',
  campaign: 'Campaign',
  mitre: 'ATT&CK technique',
};

/**
 * What a lookup's result status says, after the lookup's name: the server's own wording
 * (`runbook_runs.lookup_evidence_summary`), which a row written today already carries. An
 * older row has no reason to add, so its sentence ends at the status.
 */
const LOOKUP_STATUS: Readonly<Record<string, string>> = {
  ok: 'lookup collected evidence',
  partial: 'lookup collected partial evidence',
  empty: 'lookup found no matching records',
  not_applicable: 'lookup was not applicable',
  error: 'lookup could not run',
};

/**
 * A stored screenshot size in plain words: "107 B", "812 KB", "1.4 MB" (binary units, as
 * the Files section counts them). The audit row carries only the byte count.
 */
function screenshotSize(raw: string): string {
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes.toLocaleString('en-US')} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024).toLocaleString('en-US')} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`;
}

/** What a person's lifecycle action did to the case, in plain words (`case.*` actions). */
const STATUS_ACTION: Readonly<Record<string, string>> = {
  acknowledge: 'Acknowledged the case',
  close: 'Closed the case',
  confirm_fp: 'Confirmed the case as a false positive',
  resolve: 'Marked the case resolved',
  reopen: 'Reopened the case',
  escalate: 'Escalated the case',
  deescalate: 'Took the case off escalation',
  hold: 'Put the case on hold',
  resume: 'Resumed the case',
  set_disposition: 'Set the disposition',
  set_status: 'Set the status',
};

/** A status token in running text ("on hold"); empty for the unknown `?`. */
function statusInText(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!t || t === '?') return '';
  return t === 'needs_human' ? 'needs human review' : humanizeToken(t).toLowerCase();
}

/**
 * A person's status change as the case action route records it
 * (`action=hold status escalated→on_hold disposition=none reason=... classified=...`; the
 * fields after the disposition are appended only when present): what was done, the status
 * before and after, the disposition (or the classification made in this action) and the
 * reason given.
 */
function statusRow(row: {
  action: string;
  from: string;
  to: string;
  disposition: string;
  reason: string;
  classified: string;
}): string {
  const lead = STATUS_ACTION[row.action.toLowerCase()] ?? `${humanizeToken(row.action)} on the case`;
  const from = statusInText(row.from);
  const to = statusInText(row.to);
  const status = !to ? '' : !from ? `The status is now ${to}` : from === to ? `The status stays ${to}` : `The status went from ${from} to ${to}`;
  const disposition = row.classified
    ? `Classified as ${dispositionWords(row.classified).toLowerCase()}`
    : row.disposition && row.disposition.toLowerCase() !== 'none'
      ? `Disposition: ${dispositionWords(row.disposition).toLowerCase()}`
      : '';
  return sentences(lead, status, disposition, row.reason ? `Reason: ${row.reason}` : '');
}

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

  // A person's lifecycle action (`routes.py`, and the seeded Demo rows).
  m = /^action=(\w+) status (\S+?)(?:→|->)(\S+) disposition=(\S+)(?: reason=(.*?))?(?: classified=(\S+))?$/s.exec(raw);
  if (m) {
    return plain(
      statusRow({
        action: m[1],
        from: m[2],
        to: m[3],
        disposition: m[4],
        reason: (m[5] ?? '').trim(),
        classified: m[6] ?? '',
      }),
    );
  }

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

  // A runbook lookup's result row as the server first wrote it, for every status:
  // `Lookup <tool> collected evidence (<status>).` It reads as the sentence the server
  // writes today ("Log statistics lookup found no matching records."), which follows the
  // status (a lookup that could not run collected none) and is shown as it is.
  m = /^Lookup (\w+) collected evidence \((\w+)\)\.$/.exec(raw);
  if (m && LOOKUP_STATUS[m[2]]) {
    const name = LOOKUP_TOOLS[m[1]] ?? humanizeToken(m[1]);
    return plain(`${name} ${LOOKUP_STATUS[m[2]]}.`);
  }

  // A step change as the server first wrote it, by the step's id
  // (`Runbook step check-2 updated.`). The server names the step by its title now
  // ('Runbook step "Isolate the host" marked done.', second acceptance pass, wrb-11),
  // and that sentence is shown as it is; a row stored before keeps its id, read as words.
  // Only the id grammar matches (`RUNBOOK_SLUG_PATTERN`), so a quoted title never does.
  m = /^Runbook step ([a-z0-9][a-z0-9_-]{0,63}) updated\.$/.exec(raw);
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

  // A screenshot added to or deleted from the case (`routes_case_files.py`, Round 16
  // B30). The audit summary names only the file id, its type and size, never the caption
  // or the file name; the Files section lists a deleted screenshot's caption, who added
  // it and when.
  m = /^file_attached file=[0-9a-f]{32} type=(png|jpeg|webp) bytes=(\d+)$/.exec(raw);
  if (m) {
    const size = screenshotSize(m[2]);
    return plain(`Screenshot added (${m[1].toUpperCase()}${size ? `, ${size}` : ''}).`);
  }

  if (/^file_deleted file=[0-9a-f]{32}$/.test(raw)) return plain('Screenshot deleted.');

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
