/**
 * Case facts: small, pure helpers shared by the Case Manager queue, the case header
 * meta row and the facts rail (Round 12, WP-CM).
 *
 * Nothing here fetches, decides or mutates (#3). Every value derived from a case is
 * returned as PLAIN DATA for the caller to render as a text node (#9).
 */
import type { Case, CaseRationale, SlaPolicy } from '@/lib/types';
import { fmtDuration, humanizeAge, humanizeToken } from '@/lib/format';
import { displayScore } from '@/lib/explain/rounding';
import type { SlaReadingWire } from '@/lib/explain/sla';

/** The AI ran on this case: it carries a verdict (a candidate or a policy close does not). */
export function aiAssessed(c: Pick<Case, 'verdict'>): boolean {
  const v = String(c.verdict ?? '').trim().toLowerCase();
  return Boolean(v) && v !== 'none';
}

/**
 * The AI's own reading of a case (Round 15, G17): the model's reasoning excerpt, else
 * the summary the investigation wrote when the AI assessed the case. NEVER the code's
 * `decision_rationale` (that is the Decision's line), and never a system summary of a
 * case the AI did not assess (a candidate awaiting analysis, an analyst-policy close).
 * Empty when there is none. Plain data (#9).
 */
export function aiAssessmentText(
  c: Pick<Case, 'verdict' | 'summary'>,
  rationale: Pick<CaseRationale, 'reasoning'> | null | undefined,
): string {
  const reasoning = rationale?.reasoning?.trim();
  if (reasoning) return reasoning;
  return aiAssessed(c) ? c.summary?.trim() || '' : '';
}

/** The case's human-facing id (template display id, else the raw id). */
export function caseDisplayId(c: Pick<Case, 'case_id' | 'case_number'>): string {
  return (c.case_number || '').trim() || c.case_id;
}

/** The title chain the queue has always used (title → summary → number → id). */
export function caseTitle(c: Pick<Case, 'case_id' | 'case_number' | 'title' | 'summary'>): string {
  return c.title || c.summary || c.case_number || c.case_id;
}

/**
 * Middle-ellipsise a long identifier so BOTH ends stay readable ("case-dfec…70b4").
 * Short ids are returned unchanged; the full id stays in the accessible name and the
 * hover card, so nothing is lost.
 */
export function middleEllipsis(value: string, head = 9, tail = 4): string {
  const text = String(value ?? '');
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** Entity-type label in sentence case that keeps well-known acronyms intact. */
export function entityTypeLabel(type: string): string {
  const t = type.trim().toLowerCase();
  if (t === 'ip' || t === 'url' || t === 'asn' || t === 'md5' || t === 'sha1' || t === 'sha256') {
    return t.toUpperCase();
  }
  return humanizeToken(type);
}

/**
 * The row's secondary fact: primary entity → source name → summary, each shown only
 * when it adds information beyond the title (a redundant candidate falls through).
 */
export function primaryFact(c: Case): string | null {
  const title = caseTitle(c).toLowerCase();
  const value = c.entity?.value ? String(c.entity.value) : '';
  if (value && !title.includes(value.toLowerCase())) {
    const type = c.entity?.type || c.entity_type;
    return type ? `${entityTypeLabel(String(type))} ${value}` : value;
  }
  if (c.source_name && !title.includes(c.source_name.toLowerCase())) return c.source_name;
  const summary = (c.summary || '').trim();
  return summary && summary.toLowerCase() !== title ? summary : null;
}

/** A 0..100 risk score clamped and rounded half up (the one display rule, D4), or null. */
export function riskValue(score: unknown): number | null {
  return displayScore(score);
}

/** Epoch millis for an ISO string, or null. */
export function millis(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso.trim()) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * "12m", "3h", "2d": a compact duration for SLA phrases. `round` picks the rounding
 * (B32): the time left on a "due in" line is rounded DOWN, so 94 minutes left reads "1h"
 * and the phrase never claims more time than remains.
 */
export function shortDuration(ms: number, round: (n: number) => number = Math.round): string {
  const abs = Math.abs(ms);
  const minutes = round(abs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = round(abs / 3_600_000);
  if (hours < 48) return `${hours}h`;
  return `${round(abs / 86_400_000)}d`;
}

/** The time left on a "due in" line: rounded down, never more than remains (B32). */
export function timeLeft(ms: number): string {
  return shortDuration(ms, Math.floor);
}

/** The first member event's instant (`first_seen_millis`) as an ISO string, or null. */
export function firstEventAt(c: object): string | null {
  const ms = (c as { first_seen_millis?: unknown }).first_seen_millis;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The per-case time to detect: the first member event to the case's opening, the MTTD
 * input of the posture metrics. Null when either instant is missing or the case opened
 * before its first event (the metrics leave such a case out too).
 */
export function timeToDetect(c: Pick<Case, 'created_at'>): string | null {
  const first = (c as { first_seen_millis?: unknown }).first_seen_millis;
  const opened = millis(c.created_at);
  if (typeof first !== 'number' || !Number.isFinite(first) || first <= 0 || opened === null || opened < first) {
    return null;
  }
  const minutes = (opened - first) / 60_000;
  return minutes < 1 ? `${Math.max(0, Math.round((opened - first) / 1000))}s` : fmtDuration(minutes);
}

export interface CaseClock {
  /** Short label, e.g. "Opened", "Acknowledged". */
  label: string;
  /** ISO instant. */
  at: string;
  /** "3h ago": relative age. */
  relative: string;
}

/**
 * The lifecycle clocks a case carries (detected / opened / acknowledged / first response,
 * then closed or resolved for a case that ended, from the status trail's last move into
 * its current terminal status).
 */
export function caseClocks(c: Case): CaseClock[] {
  const rows: CaseClock[] = [];
  const push = (label: string, at: unknown) => {
    if (typeof at === 'string' && at.trim()) rows.push({ label, at, relative: humanizeAge(at) });
  };
  const firstEvent = firstEventAt(c);
  if (firstEvent) push('First event', firstEvent);
  push('Detected', c.detected_at);
  push('Opened', c.created_at);
  const detect = timeToDetect(c);
  if (detect !== null && typeof c.created_at === 'string') {
    rows.push({ label: 'Time to detect', at: c.created_at, relative: detect });
  }
  push('Acknowledged', c.acknowledged_at);
  push('First response', c.first_response_at);
  const status = String(c.status || '').trim().toLowerCase();
  if (status === 'closed' || status === 'resolved') {
    const trail = Array.isArray(c.status_history) ? c.status_history : [];
    const ended = [...trail].reverse().find((entry) => String(entry?.to_status || '').trim().toLowerCase() === status);
    push(status === 'closed' ? 'Closed' : 'Resolved', ended?.at);
  }
  push('Updated', c.updated_at);
  return rows;
}

export type SlaState = 'met' | 'running' | 'due_soon' | 'breached';

export interface SlaReading {
  /** The phrase shown in the meta row ("Response due in 45m", "Response overdue by 2h"). */
  text: string;
  state: SlaState;
  /** The priority level whose target applied ("P2"). */
  priority: string;
}

/** Statuses a person moves a case into that stop the response clock (the metrics' rule). */
const RESPONSE_STATUSES = new Set(['investigating', 'escalated', 'on_hold', 'resolved', 'closed']);
/** Transition authors that are not people (an automatic escalation is not a response). */
const NON_HUMAN_ACTORS = new Set(['system', 'agent', 'analyst_policy']);

/**
 * The first human response to a case, as the server's SLA metrics count it: the earliest
 * of `first_response_at`, `acknowledged_at` and the first move a PERSON made into
 * Investigating, Escalated, On hold, Resolved or Closed. A system or agent move never
 * counts. Null when no person has responded.
 */
export function firstHumanResponse(
  c: Pick<Case, 'acknowledged_at' | 'first_response_at' | 'status_history'>,
): number | null {
  let best: number | null = null;
  const consider = (ms: number | null) => {
    if (ms !== null && (best === null || ms < best)) best = ms;
  };
  consider(millis(c.first_response_at));
  consider(millis(c.acknowledged_at));
  for (const entry of Array.isArray(c.status_history) ? c.status_history : []) {
    const to = String(entry?.to_status || '').trim().toLowerCase();
    const by = String(entry?.by || '').trim().toLowerCase();
    if (!RESPONSE_STATUSES.has(to) || NON_HUMAN_ACTORS.has(by)) continue;
    consider(millis(entry?.at));
  }
  return best;
}

/** The share of a target after which a running clock is at risk (the metrics' rule). */
const AT_RISK_FRACTION = 0.8;

/**
 * The advisory SLA reading for a case (response clock until a person responds, then the
 * resolution clock until terminal). Returns null when the policy is off, has no target
 * for the case's priority, or runs on business hours (the console does not model the
 * business calendar, so it states nothing rather than a wrong countdown).
 *
 * It counts the same human responses as the server's SLA metrics (an acknowledgement,
 * or a person moving the case into Investigating, Escalated or On hold), and a clock is
 * at risk from 80% of its target, so the reading agrees with the dashboards. The time
 * left is rounded down (B32). ADVISORY ONLY: never read by `decide()` (#3).
 */
export function slaReading(
  c: Case,
  policy: SlaPolicy | null | undefined,
  now: number = Date.now(),
): SlaReading | null {
  if (!policy?.enabled || policy.business_hours_only) return null;
  const priority = String(c.priority_level || '').trim().toUpperCase();
  const target = priority ? policy.targets?.[priority] : undefined;
  if (!target) return null;
  const start = millis(c.detected_at) ?? millis(c.created_at);
  if (start === null) return null;
  const status = String(c.status || '').toLowerCase();
  const terminal = status === 'closed' || status === 'resolved';
  const responded = firstHumanResponse(c);

  const phrase = (kind: 'Response' | 'Resolution', minutes: number | undefined): SlaReading | null => {
    if (typeof minutes !== 'number' || minutes <= 0) return null;
    const due = start + minutes * 60_000;
    const left = due - now;
    if (left < 0) {
      return { text: `${kind} overdue by ${shortDuration(-left)}`, state: 'breached', priority };
    }
    const soon = now - start >= minutes * 60_000 * AT_RISK_FRACTION;
    return {
      text: `${kind} due in ${timeLeft(left)}`,
      state: soon ? 'due_soon' : 'running',
      priority,
    };
  };

  if (terminal) {
    return { text: 'SLA closed', state: 'met', priority };
  }
  if (responded === null) return phrase('Response', target.response_minutes);
  return phrase('Resolution', target.resolve_minutes);
}

const SERVER_SLA_STATE: Record<string, SlaState> = {
  ok: 'running',
  running: 'running',
  at_risk: 'due_soon',
  due_soon: 'due_soon',
  breached: 'breached',
  met: 'met',
};

/**
 * The SLA phrase from the server's reading (`GET /api/cases/{id}/triage`, field `sla`):
 * "Response due in 1h", "Resolution overdue by 2h", in the same shape as `slaReading`.
 * The time left is rounded down (B32). Null when the reading names no due time or
 * priority, so nothing is claimed that was not read.
 */
export function serverSlaReading(reading: SlaReadingWire | null | undefined, now: number = Date.now()): SlaReading | null {
  if (!reading) return null;
  const state = SERVER_SLA_STATE[String(reading.state).toLowerCase()];
  const priority = (reading.priority || '').trim().toUpperCase();
  const due = millis(reading.due_at);
  if (!state || !priority || due === null) return null;
  const kind = String(reading.clock).toLowerCase() === 'resolution' ? 'Resolution' : 'Response';
  if (state === 'met') return { text: 'SLA met', state, priority };
  const left = due - now;
  if (state === 'breached' || left < 0) {
    return { text: `${kind} overdue by ${shortDuration(Math.abs(left))}`, state: 'breached', priority };
  }
  return { text: `${kind} due in ${timeLeft(left)}`, state, priority };
}

/** The analyst-facing word for a status, keeping the legacy alias readable. */
export function statusWords(status: unknown): string {
  const t = String(status || '').trim().toLowerCase();
  if (!t) return 'Unknown';
  if (t === 'needs_human') return 'Open · awaiting analyst';
  return humanizeToken(t);
}

/** Tags on a case as clean strings. */
export function caseTags(c: Case): string[] {
  return Array.isArray(c.tags)
    ? c.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];
}

/** Explains why source severity and our risk band can disagree (the "Critical · Risk 7" puzzle). */
export function severityVersusRiskNote(severitySource: string | null | undefined): string {
  const who =
    severitySource === 'source_asserted' ? 'as reported by the source' : 'derived from the risk score';
  return `Severity rates the alert type (${who}). Risk scores this case from its volume, velocity, reputation, diversity and asset criticality, so a critical alert type can still be low risk here.`;
}
