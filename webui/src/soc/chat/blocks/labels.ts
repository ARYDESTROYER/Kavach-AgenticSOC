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
import type { CitationBlockKind, ColumnType, EntityKind, QueryBlock, QueryLanguage, ReputationVerdict, TimelineKind } from './schema';
import { CASE_STATUS_KEYS, SEVERITY_KEYS, VERDICT_KEYS } from './schema';

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

/** A yes/no cell as the table shows it. */
export function booleanText(value: boolean): string {
  return value ? 'Yes' : 'No';
}
