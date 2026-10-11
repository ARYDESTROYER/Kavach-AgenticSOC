/**
 * Case facts — small, pure helpers shared by the Case Manager queue, the case header
 * meta row and the facts rail (Round 12, WP-CM).
 *
 * Nothing here fetches, decides or mutates (#3). Every value derived from a case is
 * returned as PLAIN DATA for the caller to render as a text node (#9).
 */
import type { Case, SlaPolicy } from '@/lib/types';
import { humanizeAge, humanizeToken } from '@/lib/format';

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

/** Monogram for an owner chip ("asmith" → "A"). Decorative; the name is the text. */
export function monogram(name: string): string {
  const t = name.trim();
  return t ? t.charAt(0).toUpperCase() : '';
}

/** A 0..100 risk score clamped and rounded, or null. */
export function riskValue(score: unknown): number | null {
  return typeof score === 'number' && Number.isFinite(score)
    ? Math.round(Math.max(0, Math.min(100, score)))
    : null;
}

/** Epoch millis for an ISO string, or null. */
export function millis(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso.trim()) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** "12m", "3h", "2d" — a compact duration for SLA phrases. */
export function shortDuration(ms: number): string {
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(abs / 3_600_000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(abs / 86_400_000)}d`;
}

export interface CaseClock {
  /** Short label, e.g. "Opened", "Acknowledged". */
  label: string;
  /** ISO instant. */
  at: string;
  /** "3h ago" — relative age. */
  relative: string;
}

/** The lifecycle clocks a case carries (detected / opened / acknowledged / first response). */
export function caseClocks(c: Case): CaseClock[] {
  const rows: CaseClock[] = [];
  const push = (label: string, at: unknown) => {
    if (typeof at === 'string' && at.trim()) rows.push({ label, at, relative: humanizeAge(at) });
  };
  push('Detected', c.detected_at);
  push('Opened', c.created_at);
  push('Acknowledged', c.acknowledged_at);
  push('First response', c.first_response_at);
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

/**
 * The advisory SLA reading for a case (response clock until acknowledged, then the
 * resolution clock until terminal). Returns null when the policy is off, has no target
 * for the case's priority, or runs on business hours (the console does not model the
 * business calendar, so it states nothing rather than a wrong countdown). ADVISORY ONLY —
 * never read by `decide()` (#3).
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
  const acknowledged = millis(c.acknowledged_at) ?? millis(c.first_response_at);

  const phrase = (kind: 'Response' | 'Resolution', minutes: number | undefined): SlaReading | null => {
    if (typeof minutes !== 'number' || minutes <= 0) return null;
    const due = start + minutes * 60_000;
    const left = due - now;
    if (left < 0) {
      return { text: `${kind} overdue by ${shortDuration(-left)}`, state: 'breached', priority };
    }
    const soon = left <= Math.max(5 * 60_000, minutes * 60_000 * 0.2);
    return {
      text: `${kind} due in ${shortDuration(left)}`,
      state: soon ? 'due_soon' : 'running',
      priority,
    };
  };

  if (terminal) {
    return { text: `${priority} SLA closed`, state: 'met', priority };
  }
  if (acknowledged === null) return phrase('Response', target.response_minutes);
  return phrase('Resolution', target.resolve_minutes);
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
