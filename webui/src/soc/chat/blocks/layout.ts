/**
 * How an answer's blocks sit in the conversation lane (Round 13, SPEC-chat §5.1, T7, T8).
 * Pure and light (types only from `schema`), so the transcript's route chunk can read a
 * block's width without loading the lazy blocks kit.
 *
 *  - {@link blockWidth}: COMPACT blocks stay in the 42rem reading column, so a sparse
 *    card never puts a label and its value a lane apart; every other block is WIDE and
 *    takes the whole lane. The card's own "Full width" toggle is unchanged.
 *  - {@link sharedScope}: when two or more framed data blocks of one answer repeat the
 *    same caption parts ("44 cases · exact · last 24 hours") and the same "as of"
 *    minute, the answer states them ONCE in a scope line above the first of them, and
 *    each card's caption keeps only its other parts (only a RUN of consecutive cards
 *    shares a line, so no card sits under a neighbour stating another window). Display only: the blocks are never
 *    changed, so print, every export, Add to report and the expanded sheet keep each
 *    block's full caption (a block can travel alone).
 */
import type { AnswerBlock, ChartKind } from './schema';
import { formatUtc } from './format';

export type BlockWidth = 'compact' | 'wide';

/** A KPI row of at most this many figures stays compact. */
export const COMPACT_KPI_ITEMS = 4;
/** A table of at most this many columns stays compact. */
export const COMPACT_TABLE_COLUMNS = 3;
/** A categorical chart of at most this many categories stays compact. */
export const COMPACT_CHART_CATEGORIES = 12;
/** The categorical chart views that fit the reading column. */
const COMPACT_CHART_KINDS: ReadonlySet<ChartKind> = new Set<ChartKind>(['hbar', 'bar', 'donut', 'funnel']);

/**
 * A block's width in the lane, from its type and size (SPEC-chat §5.1): `kpi_group` with
 * at most 4 figures, `entity`, `case_list`, `mitre`, a `table` of at most 3 columns and a
 * categorical `chart` (`hbar`, `bar`, `donut`, `funnel` over categories) of at most 12
 * categories are compact; everything else is wide. The bare prose blocks (`markdown`,
 * `callout`) are capped to the reading column by the lane itself and read as compact.
 */
export function blockWidth(block: AnswerBlock): BlockWidth {
  switch (block.type) {
    case 'markdown':
    case 'callout':
    case 'entity':
    case 'case_list':
    case 'mitre':
      return 'compact';
    case 'kpi_group':
      return block.items.length <= COMPACT_KPI_ITEMS ? 'compact' : 'wide';
    case 'table':
      return block.columns.length <= COMPACT_TABLE_COLUMNS ? 'compact' : 'wide';
    case 'chart':
      return block.x.kind === 'category' &&
        COMPACT_CHART_KINDS.has(block.kind) &&
        block.x.values.length <= COMPACT_CHART_CATEGORIES
        ? 'compact'
        : 'wide';
    default:
      return 'wide';
  }
}

/**
 * How AnswerBlocks lays an answer's blocks out: one block per row, except a run of two or
 * more consecutive `entity` blocks, which shares one row (a 2-column grid from ~48rem) and
 * so spans the lane as one WIDE row. {@link widestBlock} reads the same grouping, so the
 * meta row and the blocks it acts on never disagree about the answer's right edge.
 */
export type BlockGroup = { kind: 'single'; index: number } | { kind: 'entities'; indices: number[] };

export function blockGroups(blocks: readonly AnswerBlock[]): BlockGroup[] {
  const out: BlockGroup[] = [];
  blocks.forEach((b, i) => {
    const last = out[out.length - 1];
    if (b.type === 'entity' && last && last.kind === 'entities') last.indices.push(i);
    else if (b.type === 'entity' && blocks[i + 1]?.type === 'entity') out.push({ kind: 'entities', indices: [i] });
    else out.push({ kind: 'single', index: i });
  });
  return out;
}

/**
 * The widest framed row of an answer (`null`: no framed block at all), as AnswerBlocks
 * lays it out: a pair (or more) of indicators side by side is one wide row even though
 * each card in it is compact.
 */
export function widestBlock(blocks: readonly AnswerBlock[]): BlockWidth | null {
  let out: BlockWidth | null = null;
  for (const group of blockGroups(blocks)) {
    if (group.kind === 'entities') return 'wide';
    const block = blocks[group.index];
    if (block.type === 'markdown' || block.type === 'callout') continue;
    if (blockWidth(block) === 'wide') return 'wide';
    out = 'compact';
  }
  return out;
}

/** Framed data blocks whose captions may share a scope line (not prose, notes, sources, briefs or queries). */
const SCOPED_TYPES: ReadonlySet<AnswerBlock['type']> = new Set<AnswerBlock['type']>([
  'kpi_group',
  'chart',
  'heatmap',
  'table',
  'case_list',
  'timeline',
  'entity',
  'mitre',
]);

/** The caption separator the server and the cards use. */
export const CAPTION_SEPARATOR = ' · ';

/** A caption's parts, trimmed, empty ones dropped. */
export function captionParts(caption: string | null | undefined): string[] {
  if (!caption) return [];
  return caption
    .split(CAPTION_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

const partKey = (part: string) => part.toLowerCase();

/** The answer's shared scope (see the module note). */
export interface SharedScope {
  /** The scope line, shown once: the shared parts, then "as of …" when they share one. */
  line: string;
  /** The shared caption parts (as the first member writes them). */
  parts: string[];
  /** The shared "as of" text ("as of 2026-10-17 11:13 UTC"), or null. */
  asOf: string | null;
  /** Indexes (into the answer's blocks) of the blocks whose captions it states. */
  members: number[];
}

/**
 * The parts of a caption a card shows once the answer's scope line states `scope`:
 * everything but the shared parts. A block that is not a member keeps its caption.
 */
export function ownCaptionParts(caption: string | null | undefined, scope: SharedScope | null): string[] {
  const parts = captionParts(caption);
  if (!scope) return parts;
  const shared = new Set(scope.parts.map(partKey));
  return parts.filter((part) => !shared.has(partKey(part)));
}

/**
 * The one scope line of an answer, or null (SPEC-chat T8): the longest RUN (the earliest
 * on a tie) of at least two consecutive framed data blocks with a caption that carry the
 * same "as of" minute (or none) and share at least one caption part. Only prose
 * (`markdown`, `callout`) may sit between two members: any other framed block ends the
 * run, so a card never hides its window under a neighbour that states another one (a
 * "last 30 days" card between two "last 7 days" cards keeps every caption whole). The
 * line holds the parts EVERY member carries, in the first member's order and words.
 */
export function sharedScope(blocks: readonly AnswerBlock[]): SharedScope | null {
  const runs: number[][] = [];
  let run: { minute: string; keys: Set<string>; members: number[] } | null = null;
  const close = () => {
    if (run && run.members.length >= 2) runs.push(run.members);
    run = null;
  };
  blocks.forEach((block, index) => {
    if (block.type === 'markdown' || block.type === 'callout') return; // prose never breaks a run
    const parts = SCOPED_TYPES.has(block.type) ? captionParts(block.caption) : [];
    if (!parts.length) {
      close(); // a framed block with no scoped caption ends the run
      return;
    }
    const minute = block.as_of ? formatUtc(block.as_of) : '';
    const keys = new Set(parts.map(partKey));
    const current = run as { minute: string; keys: Set<string>; members: number[] } | null;
    if (current && current.minute === minute) {
      const shared = new Set([...current.keys].filter((k) => keys.has(k)));
      if (shared.size) {
        current.keys = shared;
        current.members.push(index);
        return;
      }
    }
    close();
    run = { minute, keys, members: [index] };
  });
  close();
  let best: SharedScope | null = null;
  for (const members of runs) {
    const [first, ...rest] = members.map((i) => captionParts(blocks[i].caption));
    const restKeys = rest.map((parts) => new Set(parts.map(partKey)));
    const seen = new Set<string>();
    const parts = first.filter((part) => {
      const key = partKey(part);
      if (seen.has(key)) return false;
      seen.add(key);
      return restKeys.every((keys) => keys.has(key));
    });
    if (!parts.length) continue;
    const asOfBlock = blocks[members[0]].as_of;
    const minute = asOfBlock ? formatUtc(asOfBlock) : '';
    const asOf = minute ? `as of ${minute}` : null;
    const candidate: SharedScope = {
      line: [...parts, ...(asOf ? [asOf] : [])].join(CAPTION_SEPARATOR),
      parts,
      asOf,
      members,
    };
    if (!best || members.length > best.members.length) best = candidate;
  }
  return best;
}
