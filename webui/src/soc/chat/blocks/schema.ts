/**
 * Answer-block schema (chat revamp SPEC §7, BLOCKS.md + v2 amendments) — the client
 * mirror of `backend/app/agents/blocks.py`, pinned to `answer-blocks.contract.json`
 * by `__tests__/answer-blocks.contract.test.ts`.
 *
 * Blocks are inert DATA (G10). The server validates them, and the client validates
 * them AGAIN here before anything renders, because a response, an event or a saved
 * report is untrusted input (#9). {@link parseBlocks}:
 *
 * - never throws (G9);
 * - display-sanitises every string with {@link displayText} and clamps it (G7, G8);
 * - coerces a non-finite number, a boolean or a numeric string to `null` (= not
 *   measured, G3) — it is never drawn as 0;
 * - repairs what can be repaired (series aligned to the x axis, rows to the columns,
 *   lists clipped with `truncated: true`, an unknown fallback-able enum to its
 *   fallback, duplicate ids suffixed) exactly like the backend;
 * - replaces a block it cannot keep with a quiet fallback callout at the same
 *   position, and reports it in `dropped`;
 * - validates every in-app ref with the router's own guards (`isPageId`,
 *   `isSafeRouteToken`, `isSafeCaseId`, `isSafeCaseResultStatus`) and every Help
 *   Center ref against the docs path pattern. No string ever becomes a URL, a style,
 *   a class name, a DOM id or a colour (G2): units, tones, kinds and semantics are
 *   enums, links are typed refs.
 *
 * The parsed form is NORMALISED: optional base fields are explicit (`artifact_kind:
 * null`, `allowed_views: []`, flags `false`, `total: null`), so renderers need no
 * defaults of their own. Provenance follows G5 on the client: a missing/unknown value
 * becomes `'ai'` (fail-safe) and the renderer captions it "Values stated by the
 * model, not measured"; the server already refuses model-authored data blocks.
 */
import type { PageId } from '@/soc/nav';
import { isPageId } from '@/soc/nav';
import { isSafeCaseId, isSafeCaseResultStatus, isSafeRouteToken } from '@/soc/case-result-route';
import type { ChatTable } from '@/lib/types';

import { SEVERITY_KEYS, displayText } from '../stream-events';
import type { SeverityKey } from '../stream-events';

export { SEVERITY_KEYS, displayText } from '../stream-events';
export type { DisplayTextOptions, SeverityKey } from '../stream-events';

/* -------------------------------------------------------------------------- */
/* Versions, enums, limits, patterns (pinned by the contract file).            */
/* -------------------------------------------------------------------------- */
export const ANSWER_BLOCKS_MAJOR = 1;
export const BLOCKS_VERSION = 1;

export const BLOCK_TYPES = [
  'markdown',
  'kpi_group',
  'chart',
  'heatmap',
  'table',
  'case_list',
  'timeline',
  'entity',
  'mitre',
  'query',
  'callout',
  'citations',
  'guide',
  'report',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const CHART_KINDS = ['bar', 'hbar', 'stacked_bar', 'line', 'area', 'donut', 'sparkline', 'funnel'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export const VALUE_UNITS = [
  'count',
  'percent',
  'ratio',
  'score',
  'ms',
  'seconds',
  'minutes',
  'hours',
  'usd',
  'tokens',
  'bytes',
] as const;
export type ValueUnit = (typeof VALUE_UNITS)[number];

export const COLUMN_TYPES = [
  'text',
  'number',
  'time',
  'severity',
  'verdict',
  'status',
  'risk',
  'case',
  'entity',
  'mitre',
  'code',
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export const TONES = ['info', 'success', 'warning', 'critical'] as const;
export type ToneKey = (typeof TONES)[number];

export const PROVENANCES = ['code', 'source', 'ai'] as const;
export type BlockProvenance = (typeof PROVENANCES)[number];

export const ARTIFACT_KINDS = [
  'table',
  'kpis',
  'series',
  'categories',
  'funnel',
  'heatmap',
  'case_list',
  'timeline',
  'entity',
  'mitre',
  'guide',
  'query',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const BLOCK_VIEWS = [
  'bar',
  'hbar',
  'stacked_bar',
  'line',
  'area',
  'donut',
  'sparkline',
  'funnel',
  'kpi_group',
  'table',
  'heatmap',
  'case_list',
  'timeline',
  'entity',
  'mitre',
  'guide',
  'query',
] as const;
export type BlockView = (typeof BLOCK_VIEWS)[number];

export const KPI_DISPLAYS = ['value', 'gauge'] as const;
export type KpiDisplay = (typeof KPI_DISPLAYS)[number];

// Semantic axes — mirrored from soc/components/palette.ts (pinned by a test, not
// imported, so this module carries no icon imports). SEVERITY_KEYS lives in
// ../stream-events (the console-link normaliser checks it) and is re-exported above.
export const STATUS_KEYS = ['new', 'investigating', 'escalated', 'on_hold', 'resolved', 'closed'] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];
export const VERDICT_KEYS = [
  'true_positive',
  'false_positive',
  'benign',
  'needs_human',
  'suspicious',
  'duplicate',
  'undetermined',
] as const;
export type VerdictKey = (typeof VERDICT_KEYS)[number];
export type SemanticKey = SeverityKey | StatusKey | VerdictKey;
export const SEMANTIC_KEYS: readonly SemanticKey[] = Array.from(
  new Set<SemanticKey>([...SEVERITY_KEYS, ...STATUS_KEYS, ...VERDICT_KEYS]),
);
/** A case's stored lifecycle value (the StatusBadge renders all of them). */
export const CASE_STATUS_KEYS = [
  'new',
  'open',
  'needs_human',
  'investigating',
  'escalated',
  'on_hold',
  'resolved',
  'closed',
] as const;
export type CaseStatusKey = (typeof CASE_STATUS_KEYS)[number];

export const ENTITY_KINDS = ['ip', 'domain', 'url', 'hash', 'host', 'user', 'email', 'process'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const REPUTATION_VERDICTS = ['malicious', 'suspicious', 'clean', 'unknown'] as const;
export type ReputationVerdict = (typeof REPUTATION_VERDICTS)[number];
export const TIMELINE_KINDS = ['alert', 'detection', 'case', 'action', 'note'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];
export const CITATION_KINDS = ['runbook', 'mitre', 'case', 'docs', 'memory', 'knowledge', 'log'] as const;
export type CitationBlockKind = (typeof CITATION_KINDS)[number];
export const QUERY_LANGUAGES = ['kql', 'lucene', 'esql', 'dsl', 'sql'] as const;
export type QueryLanguage = (typeof QUERY_LANGUAGES)[number];
export const X_KINDS = ['category', 'time'] as const;
export type XKind = (typeof X_KINDS)[number];
export const TIME_BUCKETS = ['1m', '5m', '15m', '1h', '6h', '1d', '1w'] as const;
export type TimeBucket = (typeof TIME_BUCKETS)[number];
export const GOOD_DIRECTIONS = ['up', 'down', 'none'] as const;
export type GoodDirection = (typeof GOOD_DIRECTIONS)[number];
export const REPORT_TEMPLATES = ['investigation', 'hunt', 'ioc', 'shift', 'posture', 'custom'] as const;
export type ReportTemplate = (typeof REPORT_TEMPLATES)[number];
/** The InternalRef `status` opt (the router's `isSafeCaseResultStatus` set). */
export const NAV_STATUSES = [
  'active',
  'new',
  'open',
  'needs_human',
  'investigating',
  'escalated',
  'on_hold',
  'resolved',
  'closed',
] as const;
/** The only block types the model may author (provenance `ai` without a caption). */
export const AI_AUTHORED_TYPES: readonly BlockType[] = ['callout', 'markdown', 'report'];

/**
 * SPEC §7.3: artifact kind → the views the client may switch between without a model
 * call. The first entry of each row is the default view. `donut` only while the
 * categories fit in six segments.
 */
export const ALLOWED_VIEWS: Readonly<Record<ArtifactKind, readonly BlockView[]>> = {
  categories: ['hbar', 'bar', 'donut', 'table'],
  series: ['line', 'area', 'bar', 'stacked_bar', 'sparkline', 'table'],
  funnel: ['funnel', 'hbar', 'table'],
  kpis: ['kpi_group', 'table'],
  table: ['table'],
  heatmap: ['heatmap', 'table'],
  case_list: ['case_list', 'table'],
  timeline: ['timeline', 'table'],
  entity: ['entity'],
  mitre: ['mitre'],
  guide: ['guide'],
  query: ['query'],
};
export const DEFAULT_VIEW: Readonly<Record<ArtifactKind, BlockView>> = Object.fromEntries(
  ARTIFACT_KINDS.map((kind) => [kind, ALLOWED_VIEWS[kind][0]]),
) as Record<ArtifactKind, BlockView>;
/** A view is a chart kind (block type `chart`) or a block type of the same name. */
export function viewBlockType(view: BlockView): BlockType {
  return (CHART_KINDS as readonly string[]).includes(view) ? 'chart' : (view as BlockType);
}

/** SPEC §7.4 / BLOCKS.md §5.4 — the server clips to these; the client clamps again. */
export const LIMITS = {
  blocks_per_message: 12,
  /** A report `section` snapshot: the answer's Markdown plus a full turn's blocks. */
  section_blocks: 13,
  report_sections: 12,
  report_leaves: 40,
  blocks_bytes_target: 40_000,
  blocks_bytes: 48_000,
  series: 8,
  points: 200,
  donut_segments: 6,
  table_columns: 12,
  table_rows: 200,
  cell_chars: 500,
  heatmap_x: 48,
  heatmap_y: 24,
  title: 120,
  label: 60,
  caption: 280,
  callout: 600,
  markdown: 12_000,
  fallback: 2_000,
  kpi_items: 6,
  trend_points: 60,
  case_list: 25,
  timeline: 50,
  entity_facts: 12,
  reputation: 12,
  entity_counts: 4,
  related_cases: 5,
  mitre: 60,
  query_chars: 4_000,
  citation_items: 20,
  guide_steps: 10,
  guide_links: 6,
  category_chars: 200,
  value_chars: 512,
  detail_chars: 500,
  snippet: 280,
  section_summary: 1_200,
  sources: 20,
  timestamp_chars: 40,
  stored_table_rows: 25,
  stored_series_points: 100,
  stored_query_chars: 1_000,
} as const;

/** The same grammars as the backend (source strings pinned by the contract file). */
export const PATTERN_SOURCES = {
  block_id: '^[a-z0-9][a-z0-9_.-]{0,47}$',
  key: '^[A-Za-z0-9_.:@-]{1,64}$',
  page: '^[a-z][a-z_]{0,39}$',
  route_token: '^[A-Za-z0-9_.:@ -]{1,128}$',
  case_id: '^[A-Za-z0-9_.:@ /-]{1,128}$',
  // Help Center path: the version line, zero or more lowercase dot-joined segments
  // (so `/docs/0.1/` and `releases/0.1.13/` cite), never a `.`/`..`/empty segment,
  // scheme, host, query, uppercase, `%` or backslash. Vectors: contract `doc_ref_examples`.
  doc_ref:
    '^/docs/[0-9]{1,4}\\.[0-9]{1,4}/' +
    '(?:[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*(?:/[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*)*/?)?' +
    '(?:#[a-z0-9_-]+)?$',
  technique: '^T\\d{4}(\\.\\d{3})?$',
  section_id: '^[a-z0-9][a-z0-9_-]{0,31}$',
  artifact_ref: '^t([1-9][0-9]{0,2})\\.a([1-9][0-9]{0,2})$',
  stored_ref: '^m([1-9][0-9]{0,2})\\.b([1-9][0-9]{0,2})$',
  timestamp:
    '^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])' +
    '(?:[Tt ](?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\\.[0-9]{1,9})?)?' +
    '(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):?[0-5][0-9])?)?$',
} as const;
const BLOCK_ID_RE = new RegExp(PATTERN_SOURCES.block_id);
const KEY_RE = new RegExp(PATTERN_SOURCES.key);
const DOC_REF_RE = new RegExp(PATTERN_SOURCES.doc_ref);
const TECHNIQUE_RE = new RegExp(PATTERN_SOURCES.technique);
const SECTION_ID_RE = new RegExp(PATTERN_SOURCES.section_id);

export const FALLBACK_TEXT = 'This part of the answer could not be displayed';
export const EXPIRED_TEXT = 'Expired from saved history';

/* -------------------------------------------------------------------------- */
/* Block types.                                                                */
/* -------------------------------------------------------------------------- */
/** An in-app destination, never a URL. Rendered via the router. */
export interface InternalRef {
  page: PageId;
  opts?: {
    caseId?: string;
    severity?: SeverityKey;
    status?: string;
    /** Hours, 1..720. */
    window?: number;
    tab?: string;
    section?: string;
    anchor?: string;
  };
}
/** A same-origin Help Center page, e.g. `/docs/0.1/analyst/chat/#sources`. */
export interface DocRef {
  doc: string;
}
export type BlockRef = InternalRef | DocRef;

interface BlockBase {
  /** Unique per message; for anchors/TOC only — never a DOM id (G2). */
  id: string;
  title?: string;
  caption?: string;
  provenance: BlockProvenance;
  artifact_kind: ArtifactKind | null;
  allowed_views: BlockView[];
  untrusted: boolean;
  truncated: boolean;
  total: number | null;
  as_of?: string;
  from_step?: number;
  fallback_text?: string;
  downsampled_for_storage: boolean;
}

export interface MarkdownBlock extends BlockBase {
  type: 'markdown';
  text: string;
}

export interface KpiItem {
  key: string;
  label: string;
  value: number | null;
  unit: ValueUnit;
  bound?: 'lower';
  context?: string;
  delta?: { value: number; period_label: string; good_direction: GoodDirection };
  semantic?: SemanticKey;
  trend?: { points: Array<number | null>; window_label: string };
  ref?: InternalRef;
  /** `gauge` draws a 0-100 index as RiskGauge. */
  display?: KpiDisplay;
}
export interface KpiGroupBlock extends BlockBase {
  type: 'kpi_group';
  items: KpiItem[];
}

export interface ChartSeries {
  key: string;
  label: string;
  semantic?: SemanticKey;
  values: Array<number | null>;
}
export type ChartReference = { axis: 'y'; value: number; label: string } | { axis: 'x'; value: string; label: string };
export interface ChartBlock extends BlockBase {
  type: 'chart';
  kind: ChartKind;
  unit: ValueUnit;
  y_label?: string;
  x: { kind: XKind; values: string[]; label?: string; bucket?: TimeBucket };
  series: ChartSeries[];
  reference?: ChartReference;
  last_in_progress: boolean;
  drill?: Array<InternalRef | null>;
}

export interface HeatmapBlock extends BlockBase {
  type: 'heatmap';
  unit: ValueUnit;
  x: { values: string[]; label?: string };
  y: { values: string[]; label?: string };
  /** y-major: cells[y][x]. */
  cells: Array<Array<number | null>>;
}

export type Cell = string | number | boolean | null;
export interface TableColumn {
  key: string;
  label: string;
  type: ColumnType;
  unit?: ValueUnit;
  align?: 'left' | 'right';
  untrusted: boolean;
}
export interface TableBlock extends BlockBase {
  type: 'table';
  columns: TableColumn[];
  rows: Cell[][];
  sort?: { key: string; dir: 'asc' | 'desc' };
}

export interface CaseListItem {
  case_id: string;
  title: string;
  severity?: SeverityKey;
  verdict?: VerdictKey;
  status?: CaseStatusKey;
  risk?: number | null;
  created_at?: string;
}
export interface CaseListBlock extends BlockBase {
  type: 'case_list';
  items: CaseListItem[];
}

export interface TimelineEvent {
  at: string;
  label: string;
  detail?: string;
  kind?: TimelineKind;
  semantic?: SemanticKey;
  ref?: InternalRef;
}
export interface TimelineBlock extends BlockBase {
  type: 'timeline';
  events: TimelineEvent[];
}

export interface EntityBlock extends BlockBase {
  type: 'entity';
  entity: { kind: EntityKind; value: string };
  risk?: number | null;
  verdict?: VerdictKey;
  facts: Array<{ label: string; value: string; untrusted: boolean }>;
  reputation: Array<{ provider: string; verdict: ReputationVerdict; score?: number | null; detail?: string }>;
  counts: KpiItem[];
  related_cases: Array<{ case_id: string; title: string; severity?: SeverityKey }>;
  first_seen?: string;
  last_seen?: string;
}

export interface MitreTechnique {
  id: string;
  name?: string;
  tactic?: string;
  count?: number | null;
}
export interface MitreBlock extends BlockBase {
  type: 'mitre';
  techniques: MitreTechnique[];
}

export interface QueryBlock extends BlockBase {
  type: 'query';
  language: QueryLanguage;
  query: string;
  source_name?: string;
  hits?: number | null;
}

export interface CalloutBlock extends BlockBase {
  type: 'callout';
  tone: ToneKey;
  text: string;
  /** Set on a retention stub: what the block used to be. */
  expired?: { type: BlockType; artifact_kind: ArtifactKind | null };
}

export interface CitationItem {
  n: number;
  kind: CitationBlockKind;
  label: string;
  ref?: BlockRef;
  snippet?: string;
}
export interface CitationsBlock extends BlockBase {
  type: 'citations';
  items: CitationItem[];
}

export interface GuideBlock extends BlockBase {
  type: 'guide';
  steps: Array<{ text: string }>;
  links: Array<{ label: string; ref: BlockRef }>;
}

export type LeafBlock =
  | MarkdownBlock
  | KpiGroupBlock
  | ChartBlock
  | HeatmapBlock
  | TableBlock
  | CaseListBlock
  | TimelineBlock
  | EntityBlock
  | MitreBlock
  | QueryBlock
  | CalloutBlock
  | CitationsBlock
  | GuideBlock;

export interface ReportSection {
  id: string;
  heading: string;
  summary?: string;
  blocks: LeafBlock[];
}
export interface ReportBlock extends BlockBase {
  type: 'report';
  title: string;
  subtitle?: string;
  template?: ReportTemplate;
  scope: { window_label?: string; sources: string[]; generated_at: string };
  sections: ReportSection[];
}

export type AnswerBlock = LeafBlock | ReportBlock;

/** A block (or report leaf) the parser could not keep, with a value-free reason. */
export interface DroppedBlock {
  /** Position: "3" or "2.s1.4" (1-based). */
  path: string;
  type: string | null;
  reason: string;
}

export interface ParseBlocksResult {
  blocks: AnswerBlock[];
  dropped: DroppedBlock[];
}

/* -------------------------------------------------------------------------- */
/* Internal helpers.                                                           */
/* -------------------------------------------------------------------------- */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class Invalid extends Error {}
function fail(reason: string): never {
  throw new Invalid(reason);
}

const has = <T extends string>(allowed: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v);

function enumOr<T extends string, F>(value: unknown, allowed: readonly T[], fallback: F): T | F {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (has(allowed, v)) return v;
  }
  return fallback;
}

/** A finite number, else null (G3). Booleans and numeric strings are not numbers. */
export function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteRequired(value: unknown, field: string): number {
  const n = finiteOrNull(value);
  if (n === null) fail(`float_type:${field}`);
  return n;
}

/** Text for a REQUIRED field: a string or plain scalar; a container is invalid. */
function text(value: unknown, limit: number, field: string, multiline = false): string {
  if (typeof value === 'string') return displayText(value, limit, { multiline });
  if (typeof value === 'number' && Number.isFinite(value)) return displayText(String(value), limit);
  if (typeof value === 'boolean') return String(value);
  return fail(`string_type:${field}`);
}

/** Text for an OPTIONAL field: blank or non-text becomes undefined. */
function optText(value: unknown, limit: number, multiline = false): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
  const t = typeof value === 'string' ? displayText(value, limit, { multiline }) : displayText(value, limit);
  return t || undefined;
}

const TIMESTAMP_RE = new RegExp(PATTERN_SOURCES.timestamp);
const FRACTION_RE = /^\.([0-9]{1,9})/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
}

/**
 * Epoch ms of a timestamp in the ONE grammar shared with the backend (the pinned
 * `timestamp` pattern, which already bounds month, day, clock and offset; a naive
 * value is UTC), else `NaN`. Mirrors the backend `parse_timestamp`: the day must
 * exist in its month and the year must not be 0 — `Date.parse` alone accepts
 * 2026-02-30 (rolling into March) and reads years 0–99 as 1900–1999.
 */
export function parseTimestamp(value: string): number {
  if (!TIMESTAMP_RE.test(value)) return Number.NaN;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || day > daysInMonth(year, month)) return Number.NaN;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let ms = 0;
  let offsetMinutes = 0;
  if (value.length > 10) {
    hour = Number(value.slice(11, 13));
    minute = Number(value.slice(14, 16));
    let rest = value.slice(16);
    if (rest.startsWith(':')) {
      second = Number(rest.slice(1, 3));
      rest = rest.slice(3);
      const fraction = FRACTION_RE.exec(rest);
      if (fraction) {
        ms = Number(fraction[1].padEnd(3, '0').slice(0, 3));
        rest = rest.slice(fraction[0].length);
      }
    }
    if (rest && rest !== 'Z' && rest !== 'z') {
      const digits = rest.slice(1).replace(':', '');
      const sign = rest.startsWith('-') ? -1 : 1;
      offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    }
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime() - offsetMinutes * 60_000;
}

/** A valid shared-grammar timestamp string (sanitised, bounded), else undefined. */
function isoOrUndefined(value: unknown): string | undefined {
  const t = optText(value, LIMITS.timestamp_chars);
  return t && !Number.isNaN(parseTimestamp(t)) ? t : undefined;
}

function instant(value: string): number {
  const ms = parseTimestamp(value);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

function clip(value: unknown, limit: number): { items: unknown[]; clipped: boolean } {
  if (!Array.isArray(value)) return { items: [], clipped: false };
  return { items: value.slice(0, limit), clipped: value.length > limit };
}

/** Validate items one by one, dropping invalid ones; keep at most `limit`. */
function keepValid<T>(value: unknown, fn: (raw: unknown) => T, limit: number): { items: T[]; clipped: boolean } {
  if (!Array.isArray(value)) return { items: [], clipped: false };
  const items: T[] = [];
  let clipped = false;
  for (const raw of value) {
    let parsed: T;
    try {
      parsed = fn(raw);
    } catch {
      continue;
    }
    if (items.length >= limit) {
      clipped = true;
      break;
    }
    items.push(parsed);
  }
  return { items, clipped };
}

function lenient<T>(fn: (raw: unknown) => T): (raw: unknown) => T | undefined {
  return (raw) => {
    if (raw === null || raw === undefined) return undefined;
    try {
      return fn(raw);
    } catch {
      return undefined;
    }
  };
}

function unit(value: unknown, field = 'unit'): ValueUnit {
  const u = enumOr(value, VALUE_UNITS, null);
  return u ?? fail(`literal_error:${field}`);
}

function riskOrNull(value: unknown): number | null {
  const n = finiteOrNull(value);
  return n === null || n < 0 || n > 100 ? null : n;
}

const semantic = (v: unknown): SemanticKey | undefined => enumOr(v, SEMANTIC_KEYS, undefined);

/* -------------------------------------------------------------------------- */
/* Refs.                                                                       */
/* -------------------------------------------------------------------------- */
const NAV_OPT_KEYS = ['caseId', 'severity', 'status', 'window', 'tab', 'section', 'anchor'] as const;

/** A valid in-app ref (router guards), else null. Unknown opts invalidate the ref. */
export function parseInternalRef(raw: unknown): InternalRef | null {
  if (!isObj(raw) || typeof raw.page !== 'string' || !isPageId(raw.page)) return null;
  if (Object.keys(raw).some((k) => k !== 'page' && k !== 'opts')) return null;
  if (raw.opts === undefined || raw.opts === null) return { page: raw.page };
  if (!isObj(raw.opts)) return null;
  const opts: NonNullable<InternalRef['opts']> = {};
  for (const [key, value] of Object.entries(raw.opts)) {
    if (value === null || value === undefined) continue;
    if (!(NAV_OPT_KEYS as readonly string[]).includes(key)) return null;
    if (key === 'caseId') {
      if (typeof value !== 'string' || !isSafeCaseId(value)) return null;
      opts.caseId = value;
    } else if (key === 'severity') {
      if (!has(SEVERITY_KEYS, value)) return null;
      opts.severity = value;
    } else if (key === 'status') {
      if (typeof value !== 'string' || !isSafeCaseResultStatus(value)) return null;
      opts.status = value;
    } else if (key === 'window') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 720) return null;
      opts.window = value;
    } else {
      if (typeof value !== 'string' || !isSafeRouteToken(value)) return null;
      opts[key as 'tab' | 'section' | 'anchor'] = value;
    }
  }
  return Object.keys(opts).length ? { page: raw.page, opts } : { page: raw.page };
}

/** A valid Help Center ref (`/docs/<major.minor>/…`), else null. */
export function parseDocRef(raw: unknown): DocRef | null {
  if (!isObj(raw) || typeof raw.doc !== 'string' || Object.keys(raw).length !== 1) return null;
  return DOC_REF_RE.test(raw.doc) ? { doc: raw.doc } : null;
}

/** Either kind of ref, else null. */
export function parseRef(raw: unknown): BlockRef | null {
  return isObj(raw) && 'doc' in raw ? parseDocRef(raw) : parseInternalRef(raw);
}

export const isDocRef = (ref: BlockRef): ref is DocRef => 'doc' in ref;
export const isInternalRef = (ref: BlockRef): ref is InternalRef => 'page' in ref;

const optInternalRef = (raw: unknown): InternalRef | undefined => parseInternalRef(raw) ?? undefined;

/* -------------------------------------------------------------------------- */
/* Per-type parsers (mirror backend/app/agents/blocks.py).                     */
/* -------------------------------------------------------------------------- */
function parseKpiItem(raw: unknown): KpiItem {
  if (!isObj(raw)) fail('model_type');
  const key = raw.key;
  if (typeof key !== 'string' || !KEY_RE.test(key)) fail('string_pattern_mismatch:key');
  const value = finiteOrNull(raw.value);
  let display = enumOr(raw.display, KPI_DISPLAYS, undefined);
  // A gauge only makes sense for a 0-100 index; anything else is a value tile.
  if (display === 'gauge' && value !== null && (value < 0 || value > 100)) display = undefined;
  const item: KpiItem = { key, label: text(raw.label, LIMITS.label, 'label'), value, unit: unit(raw.unit) };
  if (raw.bound === 'lower') item.bound = 'lower';
  const context = optText(raw.context, LIMITS.label);
  if (context) item.context = context;
  const delta = lenient((d) => {
    if (!isObj(d)) fail('model_type');
    return {
      value: finiteRequired(d.value, 'value'),
      period_label: text(d.period_label, LIMITS.label, 'period_label'),
      good_direction: enumOr(d.good_direction, GOOD_DIRECTIONS, 'none' as const),
    };
  })(raw.delta);
  if (delta) item.delta = delta;
  const sem = semantic(raw.semantic);
  if (sem) item.semantic = sem;
  const trend = lenient((t) => {
    if (!isObj(t)) fail('model_type');
    return {
      points: clip(t.points, LIMITS.trend_points).items.map(finiteOrNull),
      window_label: text(t.window_label, LIMITS.label, 'window_label'),
    };
  })(raw.trend);
  if (trend) item.trend = trend;
  const ref = optInternalRef(raw.ref);
  if (ref) item.ref = ref;
  if (display) item.display = display;
  return item;
}

function categoryLabel(value: unknown, limit: number): string {
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
    return displayText(value, limit);
  }
  return '';
}

type Base = Omit<BlockBase, 'id'> & { id: string };

function parseChart(raw: Obj, base: Base): ChartBlock {
  const kind = enumOr(raw.kind, CHART_KINDS, null) ?? fail('literal_error:kind');
  if (!isObj(raw.x)) fail('missing:x');
  const xKind = enumOr(raw.x.kind, X_KINDS, 'category' as const);
  const values = Array.isArray(raw.x.values) ? raw.x.values : [];
  const n = values.length;
  // Time keeps the NEWEST points; categories keep the first (materialiser-sorted).
  const start = xKind === 'time' ? Math.max(0, n - LIMITS.points) : 0;
  const stop = xKind === 'time' ? n : Math.min(n, LIMITS.points);
  const width = stop - start;
  let truncated = base.truncated || n > LIMITS.points;
  const x: ChartBlock['x'] = {
    kind: xKind,
    values: values.slice(start, stop).map((v) => categoryLabel(v, LIMITS.category_chars)),
  };
  const xLabel = optText(raw.x.label, LIMITS.label);
  if (xLabel) x.label = xLabel;
  const bucket = enumOr(raw.x.bucket, TIME_BUCKETS, undefined);
  if (bucket) x.bucket = bucket;
  const seriesRaw = clip(raw.series, LIMITS.series);
  truncated ||= seriesRaw.clipped;
  const series = keepValid(
    seriesRaw.items,
    (s): ChartSeries => {
      if (!isObj(s)) fail('model_type');
      if (typeof s.key !== 'string' || !KEY_RE.test(s.key)) fail('string_pattern_mismatch:key');
      const rawValues = Array.isArray(s.values) ? s.values.slice(start, stop) : [];
      const aligned = rawValues.map(finiteOrNull);
      while (aligned.length < width) aligned.push(null);
      const out: ChartSeries = { key: s.key, label: text(s.label, LIMITS.label, 'label'), values: aligned };
      const sem = semantic(s.semantic);
      if (sem) out.semantic = sem;
      return out;
    },
    LIMITS.series,
  ).items;
  if (series.length === 0) fail('too_short:series');
  if ((kind === 'donut' || kind === 'sparkline' || kind === 'funnel') && series.length !== 1) {
    fail('value_error:series');
  }
  if (kind === 'donut' && x.values.length > LIMITS.donut_segments) fail('value_error:x');
  const block: ChartBlock = {
    ...base,
    truncated,
    type: 'chart',
    kind,
    unit: unit(raw.unit),
    x,
    series,
    last_in_progress: raw.last_in_progress === true,
  };
  const yLabel = optText(raw.y_label, LIMITS.label);
  if (yLabel) block.y_label = yLabel;
  const reference = lenient((r): ChartReference => {
    if (!isObj(r)) fail('model_type');
    if (r.axis === 'y') return { axis: 'y', value: finiteRequired(r.value, 'value'), label: text(r.label, LIMITS.label, 'label') };
    if (r.axis === 'x') {
      return { axis: 'x', value: text(r.value, LIMITS.category_chars, 'value'), label: text(r.label, LIMITS.label, 'label') };
    }
    return fail('union_tag_invalid:reference');
  })(raw.reference);
  if (reference) block.reference = reference;
  if (Array.isArray(raw.drill)) {
    const drill = raw.drill.slice(start, stop).map((d) => parseInternalRef(d));
    if (drill.some((d) => d !== null)) {
      while (drill.length < width) drill.push(null);
      block.drill = drill;
    }
  }
  return block;
}

function parseHeatmap(raw: Obj, base: Base): HeatmapBlock {
  if (!isObj(raw.x) || !isObj(raw.y)) fail('missing:x');
  let truncated = base.truncated;
  const axis = (a: Obj, limit: number) => {
    const { items, clipped } = clip(a.values, limit);
    truncated ||= clipped;
    const out: { values: string[]; label?: string } = {
      values: items.map((v) => categoryLabel(v, LIMITS.category_chars)),
    };
    const label = optText(a.label, LIMITS.label);
    if (label) out.label = label;
    return out;
  };
  const x = axis(raw.x, LIMITS.heatmap_x);
  const y = axis(raw.y, LIMITS.heatmap_y);
  const rows = Array.isArray(raw.cells) ? raw.cells : [];
  const cells = y.values.map((_, r) => {
    const row = Array.isArray(rows[r]) ? (rows[r] as unknown[]).slice(0, x.values.length).map(finiteOrNull) : [];
    while (row.length < x.values.length) row.push(null);
    return row;
  });
  return { ...base, truncated, type: 'heatmap', unit: unit(raw.unit), x, y, cells };
}

/** One table cell: sanitised bounded text, a finite number, a boolean or null. */
export function tableCell(value: unknown): Cell {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return finiteOrNull(value);
  if (typeof value === 'string') return displayText(value, LIMITS.cell_chars);
  return null;
}

function parseTable(raw: Obj, base: Base): TableBlock {
  const colsRaw = clip(raw.columns, LIMITS.table_columns);
  const seen = new Set<string>();
  // Columns are repaired positionally: dropping one would misalign every row.
  const columns: TableColumn[] = colsRaw.items.map((col, i) => {
    const c = isObj(col) ? col : {};
    let key = typeof c.key === 'string' && KEY_RE.test(c.key) && !seen.has(c.key) ? c.key : `c${i + 1}`;
    while (seen.has(key)) key = `${key}_`;
    seen.add(key);
    const label = optText(c.label, LIMITS.label) ?? key;
    const out: TableColumn = {
      key,
      label,
      type: enumOr(c.type, COLUMN_TYPES, 'text' as const),
      // A malformed `untrusted` flag fails safe (G7).
      untrusted: c.untrusted === undefined || c.untrusted === false ? false : true,
    };
    const u = enumOr(c.unit, VALUE_UNITS, undefined);
    if (u) out.unit = u;
    const align = enumOr(c.align, ['left', 'right'] as const, undefined);
    if (align) out.align = align;
    return out;
  });
  if (columns.length === 0) fail('too_short:columns');
  const rowsRaw = clip(raw.rows, LIMITS.table_rows);
  const rows = rowsRaw.items.map((row) => {
    const cells = Array.isArray(row) ? row.slice(0, columns.length).map(tableCell) : [];
    while (cells.length < columns.length) cells.push(null);
    return cells;
  });
  const block: TableBlock = {
    ...base,
    truncated: base.truncated || colsRaw.clipped || rowsRaw.clipped,
    type: 'table',
    columns,
    rows,
  };
  if (isObj(raw.sort) && typeof raw.sort.key === 'string' && seen.has(raw.sort.key)) {
    block.sort = { key: raw.sort.key, dir: raw.sort.dir === 'asc' ? 'asc' : 'desc' };
  }
  return block;
}

function caseId(value: unknown): string {
  if (typeof value !== 'string' || !isSafeCaseId(value)) fail('string_pattern_mismatch:case_id');
  return value;
}

function parseCaseList(raw: Obj, base: Base): CaseListBlock {
  const { items, clipped } = keepValid(
    raw.items,
    (it): CaseListItem => {
      if (!isObj(it)) fail('model_type');
      const id = caseId(it.case_id);
      const out: CaseListItem = { case_id: id, title: optText(it.title, LIMITS.title) ?? displayText(id, LIMITS.title) };
      const severity = enumOr(it.severity, SEVERITY_KEYS, undefined);
      if (severity) out.severity = severity;
      const verdict = enumOr(it.verdict, VERDICT_KEYS, undefined);
      if (verdict) out.verdict = verdict;
      const status = enumOr(it.status, CASE_STATUS_KEYS, undefined);
      if (status) out.status = status;
      const risk = riskOrNull(it.risk);
      if (risk !== null) out.risk = risk;
      const created = isoOrUndefined(it.created_at);
      if (created) out.created_at = created;
      return out;
    },
    LIMITS.case_list,
  );
  return { ...base, truncated: base.truncated || clipped, type: 'case_list', items };
}

function parseTimeline(raw: Obj, base: Base): TimelineBlock {
  let events = keepValid(
    raw.events,
    (ev): TimelineEvent => {
      if (!isObj(ev)) fail('model_type');
      const at = isoOrUndefined(ev.at) ?? fail('value_error:at');
      const out: TimelineEvent = { at, label: text(ev.label, 160, 'label') };
      const detail = optText(ev.detail, LIMITS.detail_chars, true);
      if (detail) out.detail = detail;
      const kind = enumOr(ev.kind, TIMELINE_KINDS, undefined);
      if (kind) out.kind = kind;
      const sem = semantic(ev.semantic);
      if (sem) out.semantic = sem;
      const ref = optInternalRef(ev.ref);
      if (ref) out.ref = ref;
      return out;
    },
    10_000,
  ).items;
  // Ascending by instant (stable), keeping the newest LIMITS.timeline.
  events = events
    .map((e, i) => ({ e, i, t: instant(e.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.e);
  let truncated = base.truncated;
  if (events.length > LIMITS.timeline) {
    events = events.slice(-LIMITS.timeline);
    truncated = true;
  }
  return { ...base, truncated, type: 'timeline', events };
}

function parseEntity(raw: Obj, base: Base): EntityBlock {
  if (!isObj(raw.entity)) fail('missing:entity');
  const kind = enumOr(raw.entity.kind, ENTITY_KINDS, null) ?? fail('literal_error:kind');
  let truncated = base.truncated;
  const facts = keepValid(
    raw.facts,
    (f) => {
      if (!isObj(f)) fail('model_type');
      return {
        label: text(f.label, LIMITS.label, 'label'),
        value: text(f.value, LIMITS.detail_chars, 'value'),
        untrusted: f.untrusted === true,
      };
    },
    LIMITS.entity_facts,
  );
  const reputation = keepValid(
    raw.reputation,
    (r) => {
      if (!isObj(r)) fail('model_type');
      const out: EntityBlock['reputation'][number] = {
        provider: text(r.provider, LIMITS.label, 'provider'),
        verdict: enumOr(r.verdict, REPUTATION_VERDICTS, 'unknown' as const),
      };
      const score = finiteOrNull(r.score);
      if (score !== null) out.score = score;
      const detail = optText(r.detail, LIMITS.snippet);
      if (detail) out.detail = detail;
      return out;
    },
    LIMITS.reputation,
  );
  const counts = keepValid(raw.counts, parseKpiItem, LIMITS.entity_counts);
  const related = keepValid(
    raw.related_cases,
    (c) => {
      if (!isObj(c)) fail('model_type');
      const out: EntityBlock['related_cases'][number] = {
        case_id: caseId(c.case_id),
        title: text(c.title, LIMITS.title, 'title'),
      };
      const severity = enumOr(c.severity, SEVERITY_KEYS, undefined);
      if (severity) out.severity = severity;
      return out;
    },
    LIMITS.related_cases,
  );
  truncated ||= facts.clipped || reputation.clipped || counts.clipped || related.clipped;
  const block: EntityBlock = {
    ...base,
    truncated,
    type: 'entity',
    entity: { kind, value: text(raw.entity.value, LIMITS.value_chars, 'value') },
    facts: facts.items,
    reputation: reputation.items,
    counts: counts.items,
    related_cases: related.items,
  };
  const risk = riskOrNull(raw.risk);
  if (risk !== null) block.risk = risk;
  const verdict = enumOr(raw.verdict, VERDICT_KEYS, undefined);
  if (verdict) block.verdict = verdict;
  const first = isoOrUndefined(raw.first_seen);
  if (first) block.first_seen = first;
  const last = isoOrUndefined(raw.last_seen);
  if (last) block.last_seen = last;
  return block;
}

function parseMitre(raw: Obj, base: Base): MitreBlock {
  const { items, clipped } = keepValid(
    raw.techniques,
    (t): MitreTechnique => {
      if (!isObj(t) || typeof t.id !== 'string') fail('model_type');
      const id = t.id.trim().toUpperCase();
      if (!TECHNIQUE_RE.test(id)) fail('string_pattern_mismatch:id');
      const out: MitreTechnique = { id };
      const name = optText(t.name, LIMITS.title);
      if (name) out.name = name;
      const tactic = optText(t.tactic, LIMITS.label);
      if (tactic) out.tactic = tactic;
      const n = finiteOrNull(t.count);
      if (n !== null) out.count = n;
      return out;
    },
    LIMITS.mitre,
  );
  return { ...base, truncated: base.truncated || clipped, type: 'mitre', techniques: items };
}

function parseQuery(raw: Obj, base: Base): QueryBlock {
  const block: QueryBlock = {
    ...base,
    type: 'query',
    language: enumOr(raw.language, QUERY_LANGUAGES, null) ?? fail('literal_error:language'),
    query: text(raw.query, LIMITS.query_chars, 'query', true),
  };
  const source = optText(raw.source_name, LIMITS.title);
  if (source) block.source_name = source;
  const hits = finiteOrNull(raw.hits);
  if (hits !== null) block.hits = hits;
  return block;
}

function parseCallout(raw: Obj, base: Base): CalloutBlock {
  const block: CalloutBlock = {
    ...base,
    type: 'callout',
    tone: enumOr(raw.tone, TONES, 'info' as const),
    text: text(raw.text, LIMITS.callout, 'text', true),
  };
  if (isObj(raw.expired) && has(BLOCK_TYPES, raw.expired.type)) {
    block.expired = { type: raw.expired.type, artifact_kind: enumOr(raw.expired.artifact_kind, ARTIFACT_KINDS, null) };
  }
  return block;
}

function parseCitations(raw: Obj, base: Base): CitationsBlock {
  const { items, clipped } = keepValid(
    raw.items,
    (it): CitationItem => {
      if (!isObj(it)) fail('model_type');
      const n = it.n;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 99) fail('int_type:n');
      const kind = enumOr(it.kind, CITATION_KINDS, null) ?? fail('literal_error:kind');
      const out: CitationItem = { n, kind, label: text(it.label, LIMITS.title, 'label') };
      const ref = parseRef(it.ref);
      if (ref) out.ref = ref;
      const snippet = optText(it.snippet, LIMITS.snippet, true);
      if (snippet) out.snippet = snippet;
      return out;
    },
    LIMITS.citation_items,
  );
  return { ...base, truncated: base.truncated || clipped, type: 'citations', items };
}

function parseGuide(raw: Obj, base: Base): GuideBlock {
  const steps = keepValid(
    raw.steps,
    (s) => {
      if (!isObj(s)) fail('model_type');
      return { text: text(s.text, LIMITS.caption, 'text', true) };
    },
    LIMITS.guide_steps,
  );
  const links = keepValid(
    raw.links,
    (l) => {
      if (!isObj(l)) fail('model_type');
      const ref = parseRef(l.ref) ?? fail('value_error:ref');
      return { label: text(l.label, LIMITS.label, 'label'), ref };
    },
    LIMITS.guide_links,
  );
  return {
    ...base,
    truncated: base.truncated || steps.clipped || links.clipped,
    type: 'guide',
    steps: steps.items,
    links: links.items,
  };
}

/* -------------------------------------------------------------------------- */
/* Block-level validation.                                                     */
/* -------------------------------------------------------------------------- */
function nonNegIntOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function parseBase(raw: Obj, id: string): Base {
  const base: Base = {
    id,
    provenance: enumOr(raw.provenance, PROVENANCES, 'ai' as const),
    artifact_kind: enumOr(raw.artifact_kind, ARTIFACT_KINDS, null),
    allowed_views: Array.isArray(raw.allowed_views)
      ? Array.from(new Set(raw.allowed_views.map((v) => enumOr(v, BLOCK_VIEWS, null)).filter((v): v is BlockView => v !== null)))
      : [],
    untrusted: raw.untrusted === undefined || raw.untrusted === false ? false : true,
    truncated: raw.truncated === true,
    total: nonNegIntOrNull(raw.total),
    downsampled_for_storage: raw.downsampled_for_storage === true,
  };
  const title = optText(raw.title, LIMITS.title);
  if (title) base.title = title;
  const caption = optText(raw.caption, LIMITS.caption);
  if (caption) base.caption = caption;
  const asOf = isoOrUndefined(raw.as_of);
  if (asOf) base.as_of = asOf;
  const step = nonNegIntOrNull(raw.from_step);
  if (step) base.from_step = step;
  const fallback = optText(raw.fallback_text, LIMITS.fallback, true);
  if (fallback) base.fallback_text = fallback;
  return base;
}

/** The current view of a block (a chart kind, else the block type). */
export function blockView(block: AnswerBlock): BlockView | 'markdown' | 'callout' | 'citations' | 'report' {
  return block.type === 'chart' ? block.kind : block.type;
}

/** SPEC §7.3 row for `kind` (`donut` only while `categories` ≤ 6). */
export function allowedViewsFor(kind: ArtifactKind, categories?: number): BlockView[] {
  const views = [...ALLOWED_VIEWS[kind]];
  if (categories !== undefined && categories > LIMITS.donut_segments) {
    return views.filter((v) => v !== 'donut');
  }
  return views;
}

/** `allowed_views` must sit inside the artifact kind's row and include the current view. */
function cohereViews<B extends AnswerBlock>(block: B): B {
  const kind = block.artifact_kind;
  if (kind === null) return { ...block, allowed_views: [] };
  const allowed = ALLOWED_VIEWS[kind];
  const current = blockView(block);
  if (!(allowed as readonly string[]).includes(current)) fail('value_error:artifact_kind');
  const views = block.allowed_views.filter((v) => allowed.includes(v));
  if (!views.includes(current as BlockView)) views.unshift(current as BlockView);
  return { ...block, allowed_views: views };
}

function parseLeaf(raw: Obj, id: string): LeafBlock {
  const base = parseBase(raw, id);
  let block: LeafBlock;
  switch (raw.type) {
    case 'markdown':
      block = { ...base, type: 'markdown', text: text(raw.text, LIMITS.markdown, 'text', true) };
      break;
    case 'kpi_group': {
      const { items, clipped } = keepValid(raw.items, parseKpiItem, LIMITS.kpi_items);
      if (items.length === 0) fail('too_short:items');
      block = { ...base, truncated: base.truncated || clipped, type: 'kpi_group', items };
      break;
    }
    case 'chart':
      block = parseChart(raw, base);
      break;
    case 'heatmap':
      block = parseHeatmap(raw, base);
      break;
    case 'table':
      block = parseTable(raw, base);
      break;
    case 'case_list':
      block = parseCaseList(raw, base);
      break;
    case 'timeline':
      block = parseTimeline(raw, base);
      break;
    case 'entity':
      block = parseEntity(raw, base);
      break;
    case 'mitre':
      block = parseMitre(raw, base);
      break;
    case 'query':
      block = parseQuery(raw, base);
      break;
    case 'callout':
      block = parseCallout(raw, base);
      break;
    case 'citations':
      block = parseCitations(raw, base);
      break;
    case 'guide':
      block = parseGuide(raw, base);
      break;
    default:
      return fail('unknown_type');
  }
  return cohereViews(block);
}

/** The quiet callout that stands in for a block that cannot be displayed (G9). */
export function fallbackBlock(id: string, fallbackText?: unknown): CalloutBlock {
  const block: CalloutBlock = {
    id,
    type: 'callout',
    tone: 'info',
    provenance: 'code',
    text: FALLBACK_TEXT,
    artifact_kind: null,
    allowed_views: [],
    untrusted: false,
    truncated: false,
    total: null,
    downsampled_for_storage: false,
  };
  const fb = optText(fallbackText, LIMITS.fallback, true);
  if (fb) block.fallback_text = fb;
  return block;
}

function uniqueId(candidate: unknown, fallback: string, used: Set<string>): string {
  const base = typeof candidate === 'string' && BLOCK_ID_RE.test(candidate) ? candidate : fallback;
  let out = base;
  let n = 2;
  while (used.has(out)) {
    const suffix = `-${n}`;
    out = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(out);
  return out;
}

const typeOf = (raw: unknown): string | null =>
  isObj(raw) && typeof raw.type === 'string' ? displayText(raw.type, 32) : null;
const reasonOf = (err: unknown): string => (err instanceof Invalid ? err.message : 'invalid');

function parseReport(raw: Obj, id: string, path: string, used: Set<string>, dropped: DroppedBlock[]): ReportBlock {
  const base = parseBase(raw, id);
  const title = text(raw.title, LIMITS.title, 'title');
  if (!isObj(raw.scope)) fail('missing:scope');
  const generatedAt = isoOrUndefined(raw.scope.generated_at) ?? fail('value_error:generated_at');
  const sectionsRaw = clip(raw.sections, LIMITS.report_sections);
  let truncated = base.truncated || sectionsRaw.clipped;
  let leaves = 0;
  const sections: ReportSection[] = [];
  sectionsRaw.items.forEach((section, si) => {
    const sPath = `${path}.s${si + 1}`;
    if (!isObj(section)) {
      dropped.push({ path: sPath, type: null, reason: 'not_an_object' });
      return;
    }
    const blocks: LeafBlock[] = [];
    const rawBlocks = Array.isArray(section.blocks) ? section.blocks : [];
    rawBlocks.forEach((leaf, bi) => {
      const lPath = `${sPath}.${bi + 1}`;
      if (leaves >= LIMITS.report_leaves) {
        dropped.push({ path: lPath, type: typeOf(leaf), reason: 'report_leaf_limit' });
        truncated = true;
        return;
      }
      const leafId = uniqueId(isObj(leaf) ? leaf.id : undefined, `b${used.size + 1}`, used);
      if (!isObj(leaf) || typeof leaf.type !== 'string') {
        dropped.push({ path: lPath, type: typeOf(leaf), reason: 'not_an_object' });
        blocks.push(fallbackBlock(leafId));
      } else if (leaf.type === 'report') {
        dropped.push({ path: lPath, type: 'report', reason: 'nested_report' });
        blocks.push(fallbackBlock(leafId, leaf.fallback_text));
      } else {
        try {
          blocks.push(parseLeaf(leaf, leafId));
        } catch (err) {
          dropped.push({ path: lPath, type: typeOf(leaf), reason: reasonOf(err) });
          blocks.push(fallbackBlock(leafId, leaf.fallback_text));
        }
      }
      leaves += 1;
    });
    if (blocks.length === 0) return;
    const out: ReportSection = {
      id: typeof section.id === 'string' && SECTION_ID_RE.test(section.id) ? section.id : `s${si + 1}`,
      // A missing heading must not sink the whole document.
      heading: optText(section.heading, LIMITS.title) ?? `Section ${si + 1}`,
      blocks,
    };
    const summary = optText(section.summary, LIMITS.section_summary, true);
    if (summary) out.summary = summary;
    sections.push(out);
  });
  if (sections.length === 0) fail('value_error:sections');
  const scope: ReportBlock['scope'] = {
    sources: clip(raw.scope.sources, LIMITS.sources)
      .items.map((s) => (typeof s === 'string' ? displayText(s, LIMITS.title) : ''))
      .filter(Boolean),
    generated_at: generatedAt,
  };
  const windowLabel = optText(raw.scope.window_label, LIMITS.label);
  if (windowLabel) scope.window_label = windowLabel;
  const block: ReportBlock = { ...base, truncated, type: 'report', title, scope, sections };
  const subtitle = optText(raw.subtitle, 200);
  if (subtitle) block.subtitle = subtitle;
  if (raw.template !== undefined && raw.template !== null) {
    block.template = enumOr(raw.template, REPORT_TEMPLATES, 'custom' as const);
  }
  return cohereViews(block);
}

/* -------------------------------------------------------------------------- */
/* Public entry points.                                                        */
/* -------------------------------------------------------------------------- */
export interface ParseBlocksOptions {
  /**
   * The most blocks to keep: {@link LIMITS.blocks_per_message} for an answer (the
   * default), {@link LIMITS.section_blocks} for a report `section` snapshot (the
   * answer's Markdown plus a full turn). Blocks past it are listed as `block_limit`.
   */
  limit?: number;
}

/**
 * Validate untrusted blocks for rendering. NEVER throws. Invalid blocks are
 * replaced IN PLACE by a {@link fallbackBlock} (positions stay stable for `mK.bJ`
 * references and "Add to report") and listed in `dropped`; blocks past the limit
 * are dropped. Report leaves are validated one by one.
 */
export function parseBlocks(raw: unknown, options: ParseBlocksOptions = {}): ParseBlocksResult {
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(0, Math.trunc(options.limit))
      : LIMITS.blocks_per_message;
  const blocks: AnswerBlock[] = [];
  const dropped: DroppedBlock[] = [];
  try {
    if (!Array.isArray(raw)) {
      if (raw !== null && raw !== undefined) dropped.push({ path: '0', type: null, reason: 'not_a_list' });
      return { blocks, dropped };
    }
    const used = new Set<string>();
    raw.forEach((item, index) => {
      const path = String(index + 1);
      if (blocks.length >= limit) {
        dropped.push({ path, type: typeOf(item), reason: 'block_limit' });
        return;
      }
      const id = uniqueId(isObj(item) ? item.id : undefined, `b${index + 1}`, used);
      if (!isObj(item) || typeof item.type !== 'string' || !has(BLOCK_TYPES, item.type)) {
        dropped.push({ path, type: typeOf(item), reason: isObj(item) ? 'unknown_type' : 'not_an_object' });
        blocks.push(fallbackBlock(id, isObj(item) ? item.fallback_text : undefined));
        return;
      }
      try {
        blocks.push(item.type === 'report' ? parseReport(item, id, path, used, dropped) : parseLeaf(item, id));
      } catch (err) {
        dropped.push({ path, type: item.type, reason: reasonOf(err) });
        blocks.push(fallbackBlock(id, item.fallback_text));
      }
    });
  } catch {
    // Defence in depth: an unforeseen input shape degrades to "nothing more to show".
    dropped.push({ path: String(blocks.length + 1), type: null, reason: 'invalid' });
  }
  return { blocks, dropped };
}

/** Parse ONE block (a report item, an expanded view); never throws. */
export function parseBlock(raw: unknown): AnswerBlock {
  const { blocks } = parseBlocks([raw]);
  return blocks[0] ?? fallbackBlock('b1');
}

/**
 * The legacy `ChatResponse.table` as a `table` block (BLOCKS.md §5.1): every column
 * is text and untrusted, so old saved turns render through the same path.
 */
export function legacyTableBlock(table: ChatTable | null | undefined, id = 'legacy-table'): TableBlock | null {
  if (!table || !Array.isArray(table.columns) || table.columns.length === 0) return null;
  const parsed = parseBlock({
    id,
    type: 'table',
    provenance: 'source',
    artifact_kind: 'table',
    untrusted: true,
    truncated: table.truncated === true,
    columns: table.columns.map((label, i) => ({ key: `c${i + 1}`, label, type: 'text', untrusted: true })),
    rows: table.rows,
  });
  return parsed.type === 'table' ? parsed : null;
}

/** True for a retention stub (its data expired from saved history). */
export function isExpiredBlock(block: AnswerBlock): boolean {
  return block.type === 'callout' && block.expired !== undefined;
}

/** Every renderable leaf, descending into report sections (exports, TOCs). */
export function leafBlocks(blocks: readonly AnswerBlock[]): LeafBlock[] {
  return blocks.flatMap((b) => (b.type === 'report' ? b.sections.flatMap((s) => s.blocks) : [b]));
}
