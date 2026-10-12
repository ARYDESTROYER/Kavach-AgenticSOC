/**
 * The conversation lane: "one lane, two edges" (Round 12 SPEC D12, diagnosis/layout.md
 * §3). Replaces the chat revamp's five-track 48rem/64rem breakout (SPEC §10.1).
 *
 *   gutter │◀──────────── lane L = min(conversation − 2·gutter, cap) ────────────▶│ gutter
 *          │ prose, notices, run log (≤ 48rem, on the lane's LEFT edge)           │
 *          │ answer blocks (the whole lane; the card frame hangs into the gutter  │
 *          │   by its padding, so card text starts on the prose edge)            │
 *          │                                  user bubble (on the RIGHT edge) ▶│
 *          │ meta row (with blocks) · follow-ups · composer (the whole lane)      │
 *
 * Three tracks: two side tracks of at least the gutter that share any free space (so the
 * lane is centred once it reaches its cap), and the lane itself, which grows to the cap.
 * The cap is the viewer's width preference (`--chat-lane-max`: Full width 100%, the
 * default, so the lane fills whatever the side menus leave; Comfortable 64rem and Wide
 * 88rem on request) and the gutter is `--chat-gutter` (`clamp(1rem, 2.5cqi, 2.5rem)`
 * of the conversation zone), both set by the host (ChatWorkspace). Without a host
 * (the Case Manager embed) the lane is the whole width with no gutter: the embed brings
 * its own 4 px inset. However wide the lane, prose keeps its 48rem measure on the
 * lane's left edge; blocks, the composer and the user bubble reach the right edge.
 *
 * Exchanges and messages repeat the lane tracks (messages subgrid their exchange), so
 * every row of every turn shares the same edges as the composer below (which uses the
 * same grid).
 */

/** The three tracks (shared by the lane grid and every exchange). */
const LANE_TRACKS =
  'grid-cols-[minmax(var(--chat-gutter,0px),1fr)_minmax(0,var(--chat-lane-max,100%))_minmax(var(--chat-gutter,0px),1fr)]';

/** The lane grid (transcript and composer area). */
export const LANE_GRID = `grid ${LANE_TRACKS}`;

/** A message (or the log): spans its grid and reuses that grid's columns. */
export const LANE_SUBGRID = 'col-span-full grid grid-cols-subgrid';

/**
 * One exchange: spans the lane with its OWN copy of the lane tracks instead of a
 * subgrid. An older exchange gets `content-visibility: auto`, whose layout containment
 * makes a grid an independent formatting context, and CSS Grid 2 then computes
 * `subgrid` to `none`; an independent grid with the same track list over the same width
 * resolves to the same edges, so its children (the user bubble, and the message as a
 * subgrid OF THE EXCHANGE) still line up with the composer.
 */
export const LANE_EXCHANGE = `col-span-full grid ${LANE_TRACKS}`;

/** The whole lane, edge to edge: composer, follow-ups, a meta row under blocks, the user turn. */
export const LANE_COL = 'col-start-2 col-end-3 min-w-0';

/**
 * Prose measure: at most 48rem, on the lane's LEFT edge (never centred), so prose,
 * blocks and the composer share one left edge. Notices and the run log use it too.
 */
export const CONTENT_COL = 'col-start-2 col-end-3 min-w-0 w-full max-w-[48rem] justify-self-start';

/**
 * The block hang: `[&>*>*]` = the answer-blocks list's children (the block column's only
 * child is the lazy AnswerBlocks root, or its placeholder). A FRAMED card (anything but
 * the bare prose blocks, `markdown` and `callout`) hangs into the gutter by its border
 * and padding (1px + BlockCard's 0.75rem `px-3`), so its title, table and chart text
 * start exactly on the prose edge and end on the user bubble's edge (optical
 * alignment). The gutter is always at least 1rem, so the hang never leaves the lane's
 * scroll box. A literal, so Tailwind's compiler sees it.
 */
export const BLOCK_HANG =
  '[&>*>*:not([data-block-type=markdown]):not([data-block-type=callout])]:-mx-[calc(0.75rem+1px)]';

/**
 * The prose measure for the bare prose blocks in the block column: a model-written
 * `markdown` block is prose, and a `callout` is a note like the message's notices, so
 * both keep the 48rem measure on the lane's left edge (the callout's box sits on the
 * prose edge, as the notices do) instead of running the whole lane under a 48rem
 * paragraph. A literal, so Tailwind's compiler sees it.
 */
export const BLOCK_PROSE_CAP =
  '[&>*>*[data-block-type=markdown]]:max-w-[48rem] [&>*>*[data-block-type=callout]]:max-w-[48rem]';

/** Answer blocks: the whole lane, framed cards hanging into the gutter, prose capped (above). */
export const WIDE_COL = `${LANE_COL} ${BLOCK_HANG} ${BLOCK_PROSE_CAP}`;

/**
 * The meta row under an answer WITH blocks: the whole lane, so its actions end on the
 * blocks' right edge. What follows it in the same column (the run log, Sources, the
 * memory line) keeps the prose measure. Without blocks the meta row uses CONTENT_COL,
 * so its actions stay next to the prose they act on.
 */
export const META_COL = `${LANE_COL} [&>*+*]:max-w-[48rem]`;

/** The lane gutter (the host sets it as `--chat-gutter`). */
export const LANE_GUTTER = 'clamp(1rem, 2.5cqi, 2.5rem)';

/* -------------------------------------------------------------------------- */
/* The per-viewer width preference.                                            */
/* -------------------------------------------------------------------------- */

export type ChatLaneWidth = 'comfortable' | 'wide' | 'full';

export const LANE_WIDTHS: readonly ChatLaneWidth[] = ['comfortable', 'wide', 'full'];

/**
 * Full width is the default (Round 12 final review, operator ask 1: the chat uses the
 * whole screen when the side menus are collapsed; amends D12's "Wide (default)"). Only a
 * viewer who never chose gets it: a stored Comfortable or Wide choice is kept.
 */
export const DEFAULT_LANE_WIDTH: ChatLaneWidth = 'full';

/** The lane cap per preference (`--chat-lane-max`). Full = the whole conversation. */
export const LANE_MAX: Record<ChatLaneWidth, string> = {
  comfortable: '64rem',
  wide: '88rem',
  full: '100%',
};

/** Menu labels and one-line descriptions (sentence case). */
export const LANE_WIDTH_LABEL: Record<ChatLaneWidth, string> = {
  comfortable: 'Comfortable',
  wide: 'Wide',
  full: 'Full width',
};

/** One line each in the Width menu (it is 15rem wide); the default says so. */
export const LANE_WIDTH_HINT: Record<ChatLaneWidth, string> = {
  comfortable: 'Up to about 1,000 px',
  wide: 'Up to about 1,400 px, centred',
  full: 'Fills the space (default)',
};

export function isLaneWidth(value: unknown): value is ChatLaneWidth {
  return value === 'comfortable' || value === 'wide' || value === 'full';
}

/** The CSS variables a host sets on the conversation zone (an `@container`). */
export function laneVars(width: ChatLaneWidth): Record<string, string> {
  return { '--chat-gutter': LANE_GUTTER, '--chat-lane-max': LANE_MAX[width] };
}
