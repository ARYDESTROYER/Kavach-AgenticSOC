/**
 * The report DOCUMENT model (chat revamp SPEC §9.3): one normalised description of a
 * report — or of a whole conversation — that every renderer reads. The panel preview,
 * the Reports library view, the Print/PDF portal and the Markdown / HTML / CSV / JSON
 * exporters all start here, so they cannot disagree about what the report says.
 *
 * Everything in it is derived DETERMINISTICALLY from the report as the server returned
 * it (re-validated: every block goes through `parseBlocks`, every string is display-
 * sanitised) plus, when available, the source turns' recorded steps and usage. Nothing
 * here calls a model or invents a number: the "Methodology & limitations" section is
 * built from engine-recorded facts only (tools that ran, queries, sample basis,
 * truncation, sources that did not answer, values not measured, tokens and cost), and it
 * says plainly when those facts are unavailable (a source conversation that was deleted
 * or evicted).
 */
import type {
  ChatConversation,
  ChatResponse,
  ChatStep,
  Report,
  ReportItem,
  ReportItemScope,
  ReportItemSource,
  ReportTemplateName,
  TurnNotice,
  TurnUsage,
} from '@/lib/types';

import { LIMITS, isExpiredBlock, leafBlocks, legacyTableBlock, parseBlocks } from '../blocks/schema';
import type { AnswerBlock, KpiItem, LeafBlock } from '../blocks/schema';
import { displayText } from '../stream-events';

/* -------------------------------------------------------------------------- */
/* Vocabulary.                                                                 */
/* -------------------------------------------------------------------------- */

export const TEMPLATE_LABEL: Readonly<Record<ReportTemplateName, string>> = {
  investigation: 'Investigation',
  hunt: 'Threat hunt',
  ioc: 'Indicator report',
  shift: 'Shift handoff',
  posture: 'Posture review',
  custom: 'Custom',
};

/** The order the template picker offers. */
export const TEMPLATE_ORDER: readonly ReportTemplateName[] = ['investigation', 'hunt', 'ioc', 'shift', 'posture', 'custom'];

/** A block type's human name when the block has no title of its own. */
export const BLOCK_TYPE_LABEL: Readonly<Record<AnswerBlock['type'], string>> = {
  markdown: 'Note',
  kpi_group: 'Key figures',
  chart: 'Chart',
  heatmap: 'Heatmap',
  table: 'Table',
  case_list: 'Cases',
  timeline: 'Timeline',
  entity: 'Indicator',
  mitre: 'ATT&CK techniques',
  query: 'Query',
  callout: 'Note',
  citations: 'Sources',
  guide: 'How to',
  report: 'Brief',
};

/** The fixed notices every document carries (engine copy, never model text). */
export const AI_SUMMARY_NOTICE = 'AI-generated; verify before acting.';
export const READ_ONLY_NOTICE =
  'Read-only: every figure came from read-only lookups by the assistant; nothing in the console was changed to produce this report.';
export const UNTRUSTED_NOTICE =
  'Log-derived values (host names, users, rule names, messages) are untrusted source data and are reproduced as text.';
export const SOURCE_UNAVAILABLE = 'Conversation no longer available';
/** At most this many source conversations are read for one report (export or view). */
export const MAX_SOURCE_CONVERSATIONS = 10;

/** A block's plain-text title (the same rule as the transcript card). */
export function blockTitle(block: AnswerBlock): string {
  if (block.type === 'report') return block.title;
  if (block.title) return block.title;
  if (block.type === 'entity') return `${BLOCK_TYPE_LABEL.entity}: ${block.entity.value}`;
  return BLOCK_TYPE_LABEL[block.type];
}

/* -------------------------------------------------------------------------- */
/* Source-turn facts (steps + usage), used only for the methodology section.   */
/* -------------------------------------------------------------------------- */

/** What the engine recorded for the assistant turn an item came from. */
export interface SourceTurnFacts {
  steps: ChatStep[];
  usage: TurnUsage | null;
  model: string | null;
  notice: TurnNotice | null;
}

/** Turn facts by assistant message id. */
export type SourceTurns = ReadonlyMap<string, SourceTurnFacts>;

/**
 * What became of reading one source conversation: `read` (its facts are in), `gone`
 * (404: deleted or evicted), `failed` (any other error) or `skipped` (beyond the
 * per-export read limit). The methodology words a missing lookup record by it.
 */
export type ConversationReadStatus = 'read' | 'gone' | 'failed' | 'skipped';

/**
 * The facts that belong to one report item. A whole answer (a section) carries its turn's
 * facts; a single block that names the lookup that produced it (`from_step`) carries only
 * that lookup (all lookups when the step is not found — the server's scope capture does
 * the same) and no answer-level notice, so a report never attributes an unrelated lookup,
 * failure or query to the block.
 */
export function scopeTurnFacts(facts: SourceTurnFacts | null, block: AnswerBlock | undefined): SourceTurnFacts | null {
  const fromStep = block?.from_step;
  if (!facts || typeof fromStep !== 'number') return facts;
  const own = facts.steps.filter((s) => s.kind === 'tool' && s.index === fromStep);
  if (!own.length) return facts;
  return { ...facts, steps: [...facts.steps.filter((s) => s.kind !== 'tool'), ...own], notice: null };
}

/** The facts of one persisted assistant response. */
export function turnFactsOf(response: ChatResponse | null | undefined, model?: string | null): SourceTurnFacts | null {
  if (!response) return null;
  return {
    steps: Array.isArray(response.steps) ? response.steps : [],
    usage: response.usage ?? null,
    model: response.usage?.model ?? response.effective_model ?? model ?? null,
    notice: response.notice ?? null,
  };
}

/** Every assistant message of a conversation, keyed by message id. */
export function sourceTurnsFromConversation(conversation: ChatConversation): Map<string, SourceTurnFacts> {
  const out = new Map<string, SourceTurnFacts>();
  for (const message of conversation.messages) {
    if (message.role !== 'assistant') continue;
    const facts = turnFactsOf(message.response, message.model);
    if (facts) out.set(message.id, facts);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The document.                                                               */
/* -------------------------------------------------------------------------- */

export interface DocItem {
  id: string;
  /** `section` = a whole added answer (or a conversation exchange); `block` = one block. */
  kind: 'block' | 'section';
  /** The user's question (section) or the block's title. */
  title: string;
  /** Re-validated blocks, in order. A section starts with the answer's Markdown. */
  blocks: AnswerBlock[];
  /** Blocks the client could not keep (replaced by a quiet fallback in place). */
  dropped: number;
  /** A section snapshot offered more blocks than it holds (G4). */
  truncated: boolean;
  /** The analyst's note (untrusted for models; plain text here). */
  note: string | null;
  /**
   * Conversation exports: the user's full prompt (the title is cut to one line), shown
   * as the section's first callout. Absent on report items.
   */
  question?: string | null;
  scope: ReportItemScope;
  source: ReportItemSource;
  addedAt: string;
  /** The recorded steps/usage of the source turn, when the conversation is still readable. */
  turn: SourceTurnFacts | null;
}

export interface DocSummary {
  text: string;
  nextSteps: string[];
  model: string | null;
  usage: TurnUsage | null;
  generatedAt: string;
  /** The report changed after the summary was written (`based_on_version` lags). */
  stale: boolean;
}

export interface DocQuery {
  /** 1-based item number the query belongs to. */
  item: number;
  /** "Searched logs", "Query" … (engine label or the block title). */
  label: string;
  language: string | null;
  text: string;
  sources: string[];
}

export interface ReportDoc {
  kind: 'report' | 'conversation';
  title: string;
  template: ReportTemplateName | null;
  author: string | null;
  /** When this rendering was produced (export time), ISO-8601 UTC. */
  generatedAt: string;
  /** The report's last change (or the conversation's), ISO-8601. */
  updatedAt: string;
  appVersion: string | null;
  /** Source conversations: id plus the title when known. */
  conversations: Array<{ id: string; title: string | null }>;
  windows: string[];
  sources: string[];
  models: string[];
  demo: boolean;
  summary: DocSummary | null;
  items: DocItem[];
  methodology: string[];
  queries: DocQuery[];
  version: number;
}

export interface BuildOptions {
  /** The signed-in user (the export's author). */
  author?: string | null;
  /** This console's version (`CONSOLE_RELEASE_IDENTITY.version`). */
  appVersion?: string | null;
  /** The export instant; defaults to now. Pass it for byte-identical output. */
  generatedAt?: string;
  /** Recorded facts of the items' source turns (keyed by assistant message id). */
  sourceTurns?: SourceTurns | null;
  /** Known conversation titles (keyed by id). */
  conversationTitles?: ReadonlyMap<string, string> | null;
  /** How reading each source conversation went (for the methodology wording). */
  conversationStatus?: ReadonlyMap<string, ConversationReadStatus> | null;
}

const uniq = (values: Iterable<string | null | undefined>): string[] => {
  const out: string[] = [];
  for (const v of values) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
};

const isoOr = (value: string | undefined | null, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value : fallback;

/** Parse an item snapshot into blocks (a section holds up to {@link LIMITS.section_blocks}). */
export function itemBlocks(item: ReportItem): { blocks: AnswerBlock[]; dropped: number; truncated: boolean; title: string } {
  if (item.kind === 'section') {
    const snap = (item.block && typeof item.block === 'object' ? item.block : {}) as Record<string, unknown>;
    const parsed = parseBlocks(snap.blocks, { limit: LIMITS.section_blocks });
    return {
      blocks: parsed.blocks,
      dropped: parsed.dropped.length,
      truncated: snap.truncated === true,
      title: displayText(snap.title, LIMITS.title) || 'Answer',
    };
  }
  const parsed = parseBlocks([item.block], { limit: 1 });
  const block = parsed.blocks[0];
  return {
    blocks: block ? [block] : [],
    dropped: parsed.dropped.length,
    truncated: false,
    title: block ? blockTitle(block) : 'Block',
  };
}

/** Build the document of a report. Pure and deterministic for the same inputs. */
export function buildReportDoc(report: Report, options: BuildOptions = {}): ReportDoc {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const turns = options.sourceTurns ?? null;
  const items: DocItem[] = report.items.map((item) => {
    const parsed = itemBlocks(item);
    return {
      id: item.id,
      kind: item.kind,
      title: parsed.title,
      blocks: parsed.blocks,
      dropped: parsed.dropped,
      truncated: parsed.truncated,
      note: item.note ? displayText(item.note, LIMITS.callout, { multiline: true }) || null : null,
      scope: item.scope,
      source: item.source,
      addedAt: item.added_at,
      turn: item.source.message_id
        ? item.kind === 'block'
          ? scopeTurnFacts(turns?.get(item.source.message_id) ?? null, parsed.blocks[0])
          : (turns?.get(item.source.message_id) ?? null)
        : null,
    };
  });
  const conversationIds = uniq([report.conversation_id, ...report.items.map((i) => i.source.conversation_id)]);
  const summary = report.summary
    ? {
        text: report.summary.executive_summary,
        nextSteps: report.summary.next_steps,
        model: report.summary.model ?? null,
        usage: report.summary.usage ?? null,
        generatedAt: report.summary.generated_at,
        stale: report.summary.based_on_version < report.version,
      }
    : null;
  const doc: ReportDoc = {
    kind: 'report',
    title: report.title,
    template: report.template,
    author: options.author ? displayText(options.author, 120) || null : report.owner || null,
    generatedAt,
    updatedAt: isoOr(report.updated_at, generatedAt),
    appVersion: options.appVersion ?? (uniq(report.items.map((i) => i.scope.app_version))[0] || null),
    conversations: conversationIds.map((id) => ({ id, title: options.conversationTitles?.get(id) ?? null })),
    windows: uniq(items.map((i) => i.scope.window)),
    sources: uniq([...items.flatMap((i) => i.scope.sources ?? []), ...items.flatMap((i) => (i.turn?.steps ?? []).flatMap((s) => s.sources ?? []))]),
    models: uniq([...items.map((i) => i.scope.generated_by), ...items.map((i) => i.turn?.model)]),
    demo: items.some((i) => i.scope.demo === true),
    summary,
    items,
    methodology: [],
    queries: [],
    version: report.version,
  };
  doc.queries = collectQueries(doc.items);
  doc.methodology = buildMethodology(doc, { turnsAvailable: turns !== null, conversationStatus: options.conversationStatus ?? null });
  return doc;
}

/* -------------------------------------------------------------------------- */
/* Conversation documents (the chat toolbar's "Export conversation").          */
/* -------------------------------------------------------------------------- */

/** The longest prompt a conversation export quotes in full (the composer's own bound). */
const PROMPT_EXPORT_CHARS = 8_000;

/**
 * A conversation as a document: one section per exchange, titled by the user's prompt
 * (one line) and quoting it in full, holding the answer prose, then that turn's blocks
 * (the legacy `table` when no block carries it). Turns that failed or were stopped keep
 * their notice as a callout; a prompt with no saved answer (a failed or stopped send)
 * still appears, with a "No answer was saved" callout, so the export never drops what
 * the analyst asked.
 */
export function buildConversationDoc(conversation: ChatConversation, options: BuildOptions = {}): ReportDoc {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const items: DocItem[] = [];
  let pending: { id: string; title: string; full: string | null; at: string } | null = null;
  const unanswered = (prompt: { id: string; title: string; full: string | null; at: string }) => {
    items.push({
      id: prompt.id,
      kind: 'section',
      title: prompt.title,
      blocks: parseBlocks([{ id: 'unanswered', type: 'callout', provenance: 'code', tone: 'info', text: 'No answer was saved for this question.' }], { limit: 1 }).blocks,
      dropped: 0,
      truncated: false,
      note: null,
      question: prompt.full,
      scope: { window: null, sources: [], generated_by: null, app_version: null, demo: false },
      source: { conversation_id: conversation.id, message_id: '', block_id: null },
      addedAt: prompt.at,
      turn: null,
    });
  };
  conversation.messages.forEach((message) => {
    if (message.role === 'user') {
      if (pending) unanswered(pending);
      const title = displayText(message.content, LIMITS.title) || 'Question';
      const full = displayText(message.content, PROMPT_EXPORT_CHARS, { multiline: true }) || null;
      // The title already says it all for a one-line prompt; quote only a longer one.
      pending = { id: message.id, title, full: full && full !== title ? full : null, at: message.created_at };
      return;
    }
    const question = pending;
    pending = null;
    const response = message.response ?? null;
    const raw: unknown[] = [];
    const answer = response?.answer ?? message.content;
    if (typeof answer === 'string' && answer.trim()) raw.push({ id: 'answer', type: 'markdown', provenance: 'ai', text: answer });
    if (response?.notice && response.notice.kind !== 'not_saved') {
      raw.push({ id: 'notice', type: 'callout', provenance: 'ai', tone: 'warning', text: response.notice.message });
    }
    const parsed = parseBlocks(response?.blocks ?? [], { limit: LIMITS.blocks_per_message });
    const blocks: AnswerBlock[] = [...parseBlocks(raw, { limit: 2 }).blocks, ...parsed.blocks];
    if (!parsed.blocks.some((b) => b.type === 'table')) {
      const legacy = legacyTableBlock(response?.table ?? null);
      if (legacy) blocks.push(legacy);
    }
    items.push({
      id: message.id,
      kind: 'section',
      title: question?.title ?? 'Answer',
      blocks,
      dropped: parsed.dropped.length,
      truncated: false,
      note: null,
      question: question?.full ?? null,
      scope: {
        window: null,
        sources: uniq([message.source_name, response?.effective_source_name]),
        generated_by: response?.usage?.model ?? response?.effective_model ?? message.model ?? null,
        app_version: null,
        demo: response?.usage?.simulated === true,
      },
      source: { conversation_id: conversation.id, message_id: message.id, block_id: null },
      addedAt: question?.at || message.created_at,
      turn: turnFactsOf(response, message.model),
    });
  });
  if (pending) unanswered(pending);
  const doc: ReportDoc = {
    kind: 'conversation',
    title: displayText(conversation.title, LIMITS.title) || 'Conversation',
    template: null,
    author: options.author ? displayText(options.author, 120) || null : null,
    generatedAt,
    updatedAt: isoOr(conversation.updated_at, generatedAt),
    appVersion: options.appVersion ?? null,
    conversations: [{ id: conversation.id, title: displayText(conversation.title, LIMITS.title) || null }],
    windows: conversation.time_range ? [timeRangeLabel(conversation.time_range.from, conversation.time_range.to)] : [],
    sources: uniq([...items.flatMap((i) => i.scope.sources ?? []), ...items.flatMap((i) => (i.turn?.steps ?? []).flatMap((s) => s.sources ?? []))]),
    models: uniq(items.map((i) => i.scope.generated_by)),
    demo: items.some((i) => i.scope.demo === true),
    summary: null,
    items,
    methodology: [],
    queries: [],
    version: 0,
  };
  doc.queries = collectQueries(doc.items);
  doc.methodology = buildMethodology(doc, { turnsAvailable: true });
  return doc;
}

/** "last 24h" for `now-24h → now`, else "<from> → <to>". */
export function timeRangeLabel(from: string, to?: string | null): string {
  const rel = /^now-(\d{1,5})([mhdw])$/.exec(from);
  if (rel && (!to || to === 'now')) return `last ${rel[1]}${rel[2]}`;
  return `${from} → ${to || 'now'}`;
}

/* -------------------------------------------------------------------------- */
/* Appendix of queries.                                                        */
/* -------------------------------------------------------------------------- */

/** Every distinct query behind the document: query blocks first, then recorded steps. */
export function collectQueries(items: readonly DocItem[]): DocQuery[] {
  const out: DocQuery[] = [];
  const seen = new Set<string>();
  const push = (q: DocQuery) => {
    const key = q.text.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(q);
  };
  items.forEach((item, index) => {
    for (const block of leafBlocks(item.blocks)) {
      if (block.type === 'query') {
        push({
          item: index + 1,
          label: block.title || 'Query',
          language: block.language,
          text: block.query,
          sources: block.source_name ? [block.source_name] : [],
        });
      }
    }
    for (const step of item.turn?.steps ?? []) {
      if (step.kind !== 'tool' || typeof step.query !== 'string' || !step.query.trim()) continue;
      push({
        item: index + 1,
        label: displayText(step.label, 120) || 'Lookup',
        language: null,
        text: displayText(step.query, LIMITS.query_chars, { multiline: true }),
        sources: (step.sources ?? []).map((s) => displayText(s, 120)).filter(Boolean),
      });
    }
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* Methodology & limitations (deterministic; engine-recorded facts only).      */
/* -------------------------------------------------------------------------- */

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
/** "1 block shows" / "3 blocks show". */
const counted = (n: number, one: string, singularVerb: string, pluralVerb: string): string =>
  `${plural(n, one)} ${n === 1 ? singularVerb : pluralVerb}`;

/**
 * Each source answer once (several items may come from the same answer): its usage and
 * notice counted once, its steps the union of what its items carry (a block item carries
 * only its own lookup, so two blocks of one answer contribute both lookups).
 */
function distinctTurns(items: readonly DocItem[]): SourceTurnFacts[] {
  const seen = new Map<string, { facts: SourceTurnFacts; steps: Map<number, ChatStep> }>();
  items.forEach((item, i) => {
    if (!item.turn) return;
    const key = item.source.message_id || `#${i}`;
    let entry = seen.get(key);
    if (!entry) {
      entry = { facts: { ...item.turn, notice: null }, steps: new Map() };
      seen.set(key, entry);
    }
    if (item.turn.notice && !entry.facts.notice) entry.facts.notice = item.turn.notice;
    for (const step of item.turn.steps) if (!entry.steps.has(step.index)) entry.steps.set(step.index, step);
  });
  return Array.from(seen.values(), ({ facts, steps }) => ({
    ...facts,
    steps: Array.from(steps.values()).sort((a, b) => a.index - b.index),
  }));
}

/** Deterministic, locale-free money for the methodology line. */
export function usd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const digits = Math.abs(value) >= 1 ? 2 : 4;
  return `$${value.toFixed(digits)}`;
}

/** Deterministic, locale-free token count ("12.4k"). */
export function tokens(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Count `null` (not measured) numbers in a block's data. */
export function notMeasuredCount(block: LeafBlock): number {
  const nulls = (values: ReadonlyArray<number | null | undefined>) => values.filter((v) => v === null).length;
  const kpis = (items: readonly KpiItem[]) => nulls(items.map((i) => i.value));
  switch (block.type) {
    case 'kpi_group':
      return kpis(block.items);
    case 'chart':
      return block.series.reduce((n, s) => n + nulls(s.values), 0);
    case 'heatmap':
      return block.cells.reduce((n, row) => n + nulls(row), 0);
    case 'table': {
      const numeric = block.columns.map((c) => c.type === 'number' || c.type === 'risk');
      return block.rows.reduce((n, row) => n + row.filter((cell, i) => numeric[i] && cell === null).length, 0);
    }
    case 'entity':
      return kpis(block.counts) + (block.risk === null ? 1 : 0);
    default:
      return 0;
  }
}

const DATA_TYPES = new Set<AnswerBlock['type']>(['kpi_group', 'chart', 'heatmap', 'table', 'case_list', 'timeline', 'entity', 'mitre']);

/**
 * The "Methodology & limitations" lines. Every sentence is an engine template filled
 * with counts, enums and recorded labels — never model prose.
 */
export function buildMethodology(
  doc: ReportDoc,
  context: { turnsAvailable: boolean; conversationStatus?: ReadonlyMap<string, ConversationReadStatus> | null },
): string[] {
  const lines: string[] = [READ_ONLY_NOTICE];
  const leaves = doc.items.flatMap((i) => leafBlocks(i.blocks));
  const turns = distinctTurns(doc.items);
  const steps = turns.flatMap((t) => t.steps);
  const toolSteps = steps.filter((s) => s.kind === 'tool');

  // Tools that ran (recorded labels with counts, in first-seen order).
  if (toolSteps.length) {
    const counts = new Map<string, number>();
    for (const s of toolSteps) {
      const label = displayText(s.label, 80) || displayText(s.tool, 64) || 'Lookup';
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const list = Array.from(counts, ([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join('; ');
    lines.push(`Lookups (${plural(toolSteps.length, 'call')}): ${list}.`);
  }
  const withoutTurn = doc.items.filter((i) => i.turn === null);
  if (withoutTurn.length > 0 && !context.turnsAvailable) {
    lines.push(`Lookup details are not shown for ${plural(withoutTurn.length, 'item')}: the source conversation was not loaded.`);
  } else if (withoutTurn.length > 0) {
    // Say WHY each item has no lookup record: a missing record is not a skipped read.
    const by = { gone: 0, failed: 0, skipped: 0, unrecorded: 0 };
    for (const item of withoutTurn) {
      const status = context.conversationStatus?.get(item.source.conversation_id);
      if (status === 'gone' || status === 'failed' || status === 'skipped') by[status] += 1;
      else by.unrecorded += 1;
    }
    if (by.unrecorded) lines.push(`Lookup details were not recorded for ${plural(by.unrecorded, 'item')} (older answers).`);
    if (by.gone) lines.push(`Lookup details are not available for ${plural(by.gone, 'item')}: ${SOURCE_UNAVAILABLE.toLowerCase()}.`);
    if (by.failed) lines.push(`Lookup details are not shown for ${plural(by.failed, 'item')}: the source conversation could not be loaded.`);
    if (by.skipped) {
      lines.push(
        `Lookup details are not shown for ${plural(by.skipped, 'item')}: an export reads at most ${MAX_SOURCE_CONVERSATIONS} source conversations, and theirs were not read.`,
      );
    }
  }

  // Sample basis and coverage, as the engine stated it.
  const sampled = toolSteps.filter((s) => s.basis === 'newest_n' || s.basis === 'sample' || s.basis === 'cached');
  if (sampled.length) {
    const details = uniq(sampled.map((s) => (s.coverage ? `${displayText(s.label, 80)}: ${displayText(s.coverage, 160)}` : null)));
    lines.push(
      `${plural(sampled.length, 'lookup')} read a sample or cached result rather than an exact count` +
        (details.length ? ` (${details.slice(0, 6).join('; ')})` : '') +
        '.',
    );
  }
  const partialCoverage = uniq(
    toolSteps
      .filter((s) => s.basis !== 'newest_n' && s.basis !== 'sample' && s.coverage && /\bof\b/.test(s.coverage))
      .map((s) => `${displayText(s.label, 80)}: ${displayText(s.coverage, 160)}`),
  );
  if (partialCoverage.length) lines.push(`Coverage: ${partialCoverage.slice(0, 6).join('; ')}.`);

  // Lookups that did not complete.
  const failed = toolSteps.filter((s) => s.status !== 'ok');
  if (failed.length) {
    const by = new Map<string, number>();
    const word: Record<string, string> = {
      error: 'failed',
      timeout: 'timed out',
      denied: 'denied',
      skipped: 'skipped',
      cancelled: 'stopped',
    };
    for (const s of failed) by.set(word[s.status] ?? s.status, (by.get(word[s.status] ?? s.status) ?? 0) + 1);
    lines.push(
      `${counted(failed.length, 'lookup', 'did', 'did')} not complete (${Array.from(by, ([w, n]) => `${n} ${w}`).join(', ')}); ` +
        'figures that depend on them are missing, not zero.',
    );
  }
  const notices = uniq(turns.map((t) => (t.notice ? displayText(t.notice.message, 200) : null)));
  if (notices.length) lines.push(`Answer notices: ${notices.slice(0, 4).join('; ')}.`);

  // Truncation, storage and provenance disclosures from the blocks themselves.
  const truncated = leaves.filter((b) => b.truncated).length;
  if (truncated) lines.push(`${counted(truncated, 'block', 'shows', 'show')} the top entries of a larger total (stated on each block).`);
  const downsampled = leaves.filter((b) => b.downsampled_for_storage).length;
  if (downsampled) lines.push(`${counted(downsampled, 'block', 'was', 'were')} downsampled for saved history.`);
  const expired = leaves.filter((b) => isExpiredBlock(b)).length;
  if (expired) lines.push(`${plural(expired, 'block')} expired from saved history; only the titles remain.`);
  const clipped = doc.items.filter((i) => i.truncated).length;
  if (clipped) lines.push(`${plural(clipped, 'answer')} held more blocks than a report section keeps; the first ones are shown.`);
  const dropped = doc.items.reduce((n, i) => n + i.dropped, 0);
  if (dropped) lines.push(`${counted(dropped, 'block', 'was', 'were')} not displayable and ${dropped === 1 ? 'is' : 'are'} shown as a notice.`);
  const unmeasured = leaves.reduce((n, b) => n + notMeasuredCount(b), 0);
  if (unmeasured) lines.push(`${counted(unmeasured, 'value', 'was', 'were')} not measured and ${unmeasured === 1 ? 'is' : 'are'} shown as "—", never as 0.`);
  const aiStated = leaves.filter((b) => DATA_TYPES.has(b.type) && b.provenance === 'ai').length;
  if (aiStated) lines.push(`${counted(aiStated, 'block', 'states', 'state')} values written by the model, not measured.`);
  if (leaves.some((b) => b.untrusted)) lines.push(UNTRUSTED_NOTICE);

  // Windows and sources.
  if (doc.windows.length) lines.push(`Time windows: ${doc.windows.join('; ')}.`);
  if (doc.sources.length) lines.push(`Sources queried: ${doc.sources.slice(0, 12).join(', ')}${doc.sources.length > 12 ? ', …' : ''}.`);

  // Tokens and cost.
  const usages = turns.map((t) => t.usage).filter((u): u is TurnUsage => !!u);
  if (usages.length) {
    const total = usages.reduce((n, u) => n + (u.total_tokens || 0), 0);
    const cost = usages.reduce((n, u) => n + (u.cost || 0), 0);
    const flags = uniq([usages.some((u) => u.estimated) ? 'partly estimated' : null, usages.some((u) => u.simulated) ? 'simulated' : null]);
    lines.push(
      `The source answers used ${tokens(total)} tokens and ${usd(cost)} across ${plural(usages.length, 'answer')}` +
        (flags.length ? ` (${flags.join(', ')})` : '') +
        '.',
    );
  }
  if (doc.summary?.usage) {
    const u = doc.summary.usage;
    lines.push(`The summary used ${tokens(u.total_tokens || 0)} tokens and ${usd(u.cost || 0)}${u.simulated ? ' (simulated)' : ''}.`);
  }
  if (doc.models.length) lines.push(`Models: ${doc.models.join(', ')}.`);
  if (doc.demo) lines.push('Demo Mode: the data is synthetic and money figures are simulated.');
  return lines;
}
