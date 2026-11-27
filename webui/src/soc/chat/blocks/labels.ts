/**
 * The human words of the answer-block vocabulary (Round 12 polish): what the block
 * renderers show on screen and what every export writes, from ONE place, so a Word,
 * Excel, Markdown, HTML or CSV file says "True positive", "Needs human", "Critical",
 * "Escalated", "IP address" or "Runbook" where the screen does, never `true_positive`
 * or `ip`. Severity, verdict and status words come from the console's shared
 * `semantic-labels` (the badges' own words). Only the JSON export keeps the raw values.
 *
 * Pure: no React and no icons.
 */
import { severityLabel, statusLabel, verdictLabel } from '@/soc/components/semantic-labels';

import { formatValue } from './format';
import type {
  CitationBlockKind,
  ColumnType,
  EntityBlock,
  EntityKind,
  QueryBlock,
  QueryLanguage,
  ReputationVerdict,
  SeverityLevelData,
  SeveritySample,
  SeveritySubject,
  TimelineKind,
} from './schema';
import { CASE_STATUS_KEYS, ENTITY_KINDS, SEVERITY_KEYS, VERDICT_KEYS } from './schema';

/** The table column types whose known values the screen draws as a badge. */
export type SemanticColumn = 'severity' | 'verdict' | 'status';

export const ENTITY_KIND_LABEL: Readonly<Record<EntityKind, string>> = {
  ip: 'IP address',
  domain: 'Domain',
  url: 'URL',
  hash: 'File hash',
  host: 'Host',
  user: 'User',
  email: 'E-mail',
  process: 'Process',
};

/**
 * The facts an entity card lists, on screen and in every export (T14). The card's kind
 * is its badge (and each export's own Kind row), in words: a fact labelled "Kind" that
 * restates it ("ip", from answers saved before the server stopped writing it) is left
 * out, so the kind shows once and never as the raw value. A "Kind" fact naming another
 * known kind is shown in words. Every other fact is listed as written.
 */
export function entityFacts(block: Pick<EntityBlock, 'entity' | 'facts'>): EntityBlock['facts'] {
  return block.facts.flatMap((fact) => {
    if (fact.label.trim().toLowerCase() !== 'kind') return [fact];
    const value = fact.value.trim().toLowerCase();
    const kind = ENTITY_KINDS.find((k) => k === value || ENTITY_KIND_LABEL[k].toLowerCase() === value);
    if (!kind) return [fact];
    return kind === block.entity.kind ? [] : [{ ...fact, value: ENTITY_KIND_LABEL[kind] }];
  });
}

export const REPUTATION_LABEL: Readonly<Record<ReputationVerdict, string>> = {
  malicious: 'Malicious',
  suspicious: 'Suspicious',
  clean: 'Clean',
  unknown: 'Unknown',
};

export const TIMELINE_KIND_LABEL: Readonly<Record<TimelineKind, string>> = {
  alert: 'Alert',
  detection: 'Detection',
  case: 'Case',
  action: 'Action',
  note: 'Note',
};

export const CITATION_KIND_LABEL: Readonly<Record<CitationBlockKind, string>> = {
  runbook: 'Runbook',
  mitre: 'ATT&CK',
  case: 'Case',
  docs: 'Help Center',
  memory: 'Memory',
  knowledge: 'Knowledge',
  log: 'Log',
};

/**
 * A query's language as its caption names it ("ES|QL · Elastic · 12 hits"). A code
 * fence keeps the raw key (`esql`): that is the syntax hint, not a word for people.
 */
export const QUERY_LANGUAGE_LABEL: Readonly<Record<QueryLanguage, string>> = {
  kql: 'KQL',
  lucene: 'Lucene',
  esql: 'ES|QL',
  dsl: 'Query DSL',
  sql: 'SQL',
};

/** A query block's caption, on screen and in every export: language · source · hits. */
export function queryCaption(block: QueryBlock): string {
  const parts = [QUERY_LANGUAGE_LABEL[block.language]];
  if (block.source_name) parts.push(block.source_name);
  if (typeof block.hits === 'number') parts.push(`${formatValue(block.hits, 'count')} hits`);
  return parts.join(' · ');
}

/** The badge axis of a table column type, or null for a plain column. */
export function semanticColumn(type: ColumnType | undefined): SemanticColumn | null {
  return type === 'severity' || type === 'verdict' || type === 'status' ? type : null;
}

const known = (list: readonly string[], key: string): boolean => list.includes(key);

/**
 * A severity, verdict or status cell in the words its badge shows (`TypedCell`,
 * `CaseListView`): a known key becomes its label ("needs_human" → "Needs human" as a
 * verdict, "Open · awaiting analyst" as a status); any other text stays as written,
 * exactly as the screen shows it as plain text.
 */
export function semanticText(kind: SemanticColumn, text: string): string {
  const key = text.trim().toLowerCase();
  switch (kind) {
    case 'severity':
      return known(SEVERITY_KEYS, key) ? severityLabel(key) ?? text : text;
    case 'verdict':
      return known(VERDICT_KEYS, key) ? verdictLabel(key) : text;
    case 'status':
      return known(CASE_STATUS_KEYS, key) ? statusLabel(key) : text;
    default:
      return text;
  }
}

/** Engine context words the console says plainly (Round 13, SPEC-chat T19). */
const KPI_CONTEXT_WORDS: Readonly<Record<string, string>> = {
  'not windowed': 'Right now',
};

/**
 * A KPI's context as a tile (and an export) says it: the engine's "not windowed" (a count
 * of right now, not of the chosen window) reads "Right now"; anything else as written.
 */
export function kpiContext(context: string): string {
  return KPI_CONTEXT_WORDS[context.trim().toLowerCase()] ?? context;
}

/** A yes/no cell as the table shows it. */
export function booleanText(value: boolean): string {
  return value ? 'Yes' : 'No';
}

/* -------------------------------------------------------------------------- */
/* Round 14 (SPEC §4.7.2, §4.7.3): severity levels in words.                   */
/* -------------------------------------------------------------------------- */

/** A raw source value as a level names it: "73", "8", "7.5" (no trailing zeros). */
export function rawValueText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

/** The distinct raw values a level holds, in the order the server listed them: "73, 8". */
export function levelRawText(level: Pick<SeverityLevelData, 'raw_values'>): string {
  const out: string[] = [];
  for (const raw of level.raw_values) {
    const text = rawValueText(raw.value);
    if (!out.includes(text)) out.push(text);
  }
  return out.join(', ');
}

/** "High (73, 8)": the level's name and the raw values it holds; just "High" without any. */
export function levelLabel(level: Pick<SeverityLevelData, 'level' | 'raw_values'>): string {
  const name = severityLabel(level.level) ?? level.level;
  const raws = levelRawText(level);
  return raws ? `${name} (${raws})` : name;
}

/**
 * Each raw value on its source's own scale, for the level's help tip: "73 on a 0 to 100
 * scale and 8 on a 0 to 10 scale". Empty when the level names no raw value.
 */
export function levelScaleText(level: Pick<SeverityLevelData, 'raw_values'>): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of level.raw_values) {
    const part = `${rawValueText(raw.value)} on a 0 to ${rawValueText(raw.scale_max)} scale`;
    if (seen.has(part)) continue;
    seen.add(part);
    parts.push(part);
  }
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** A share of the counted events, always one decimal: "0.0%", "80.2%". */
export function shareText(share: number | null): string {
  return share === null ? 'Not stated' : `${share.toFixed(1)}%`;
}

/** "event" / "events", "case" / "cases" for a breakdown's subject. */
export function subjectNoun(subject: SeveritySubject, count: number): string {
  const singular = subject === 'cases' ? 'case' : 'event';
  return count === 1 ? singular : `${singular}s`;
}

const fmtInt = (n: number) => n.toLocaleString('en-US');

/**
 * The honest basis of a breakdown when the levels do not cover the stated total (SPEC
 * §4.7.2, the backend `severity_sample_caption`): "1,000 of 2,500 events sampled, newest
 * 200 per source", and both kinds when some sources counted exactly and others were
 * sampled. Null when the levels cover everything.
 */
export function sampleSentence(sample: SeveritySample | undefined, subject: SeveritySubject): string | null {
  if (!sample) return null;
  const noun = subjectNoun(subject, 2);
  const { counted, total, per_source_cap: cap, sources_exact: exact, sources_sampled: sampled } = sample;
  if (sampled <= 0 && total !== null && counted === total) return null;
  if (sample.exact && sampled <= 0) return null;
  const of = total !== null ? fmtInt(total) : 'an unknown number of';
  const capText = cap !== null ? fmtInt(cap) : null;
  if (exact > 0 && sampled > 0 && capText) {
    return `${fmtInt(counted)} of ${of} ${noun} counted: ${fmtInt(exact)} ${exact === 1 ? 'source' : 'sources'} exactly, ${fmtInt(sampled)} sampled at the newest ${capText} each`;
  }
  if (sampled > 0 && capText) {
    return `${fmtInt(counted)} of ${of} ${noun} sampled, newest ${capText} ${sampled > 1 ? 'per source' : 'from the source'}`;
  }
  return `${fmtInt(counted)} of ${of} ${noun} counted`;
}
