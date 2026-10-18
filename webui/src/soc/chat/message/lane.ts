/**
 * The conversation lane: "one lane, two edges" (Round 12 SPEC D12, diagnosis/layout.md
 * §3), refined by Round 13 (SPEC-chat §5.1) into ONE reading column inside the lane.
 *
 *   gutter │◀──────────── lane L = min(conversation − 2·gutter, cap) ────────────▶│ gutter
 *          │ prose, notices, run log, follow-ups (READING column, ≤ 42rem, LEFT)  │
 *          │ compact blocks (≤ 42rem of text; the frame hangs into the gutter)    │
 *          │ wide blocks (the whole lane; the frame hangs into the gutter)        │
 *          │                                  user bubble (on the RIGHT edge) ▶│
 *          │ meta row (the widest block's edge) · composer (the whole lane)       │
 *
 * Three tracks: two side tracks of at least the gutter that share any free space (so the
 * lane is centred once it reaches its cap), and the lane itself, which grows to the cap.
 * The cap is the viewer's width preference (`--chat-lane-max`: Full width 100%, the
 * default, so the lane fills whatever the side menus leave; Comfortable 64rem and Wide
 * 88rem on request) and the gutter is `--chat-gutter` (`clamp(1rem, 2.5cqi, 2.5rem)`
 * of the conversation zone), both set by the host (ChatWorkspace). Without a host
 * (the Case Manager embed) the lane is the whole width with no gutter: the embed brings
 * its own 4 px inset. However wide the lane, the reading column keeps its 42rem measure
 * on the lane's left edge, and answer prose inside it its 38rem prose measure (about 86
 * to 90 characters a line at 15/24, `PROSE_COL`); wide blocks, the composer and the user
 * bubble reach the right edge.
 *
 * A block is COMPACT or WIDE (`data-block-width`, set by AnswerBlocks from the block's
 * type and size, `blocks/layout.ts`): a compact block (a few KPIs, an indicator, a case
 * list, a short table or a categorical chart) stays in the reading column so a label and
 * its value never sit a lane apart; every other block takes the lane.
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

/** The reading column (SPEC-chat §5.1): 42rem, the right edge of compact cards, notices and the run log. */
export const READING_MEASURE = '42rem';

/**
 * The PROSE measure inside the reading column: 38rem. Inter at 15/24 averages about
 * 6.8 px a character, so a 42rem line held up to 99 characters (measured, 1920 dark),
 * past the §8.3 bound of 92; at 38rem (608 px) a full line holds about 86 to 90, the
 * range §5.1 asks for. Prose is ragged right, so its shorter measure never shows as a
 * second edge; compact cards still end on the reading column's 42rem edge.
 */
export const PROSE_MEASURE = '38rem';
/** Answer prose (and model-written `markdown` blocks) at the prose measure. Literal for Tailwind. */
export const PROSE_COL = 'max-w-[38rem]';
/** The prose measure in px (38rem). */
export const PROSE_PX = 608;

/**
 * The reading column: at most 42rem, on the lane's LEFT edge (never centred), so prose,
 * blocks and the composer share one left edge. Answer prose, notices, the run log, the
 * meta row of an answer without wide blocks, follow-ups and the clarify card use it.
 */
export const READING_COL = 'col-start-2 col-end-3 min-w-0 w-full max-w-[42rem] justify-self-start';

/**
 * The Round 12 name of the reading column, kept for the hosts that import it (the Case
 * Manager embed keeps its composer and bubble in the same column).
 */
export const CONTENT_COL = READING_COL;

/**
 * The block hang: `[&>*>*]` = the answer-blocks list's children (the block column's only
 * child is the lazy AnswerBlocks root, or its placeholder). A FRAMED card (anything but
 * the bare prose blocks, `markdown` and `callout`, and the answer's shared scope line)
 * hangs into the gutter by its border and padding (1px + BlockCard's 0.75rem `px-3`), so
 * its title, table and chart text start exactly on the prose edge (optical alignment).
 *
 * Only from a conversation of 40rem (Round 13, T5): the gutter is then at least 1rem
 * against a 13px hang. Below it (a phone) the cards sit inside the lane, so no frame is
 * ever clipped by the scroll lane's edge. The container is the conversation zone (the
 * host's `@container`). A literal, so Tailwind's compiler sees it.
 */
export const BLOCK_HANG =
  '@[40rem]:[&>*>*:not([data-block-type=markdown]):not([data-block-type=callout]):not([data-scope-line])]:-mx-[calc(0.75rem+1px)]';

/**
 * The reading-column cap inside the block column: the bare prose blocks (a model-written
 * `markdown` block is prose, at the 38rem prose measure; a `callout` a note like the
 * message's notices), the shared scope line, and every COMPACT framed block. A compact card's frame is 42rem of text
 * plus its hang on each side once the hang applies, so its text ends exactly on the
 * reading column's right edge. The prose blocks are marked compact too (so an answer of
 * prose alone keeps its meta row in the reading column), so the two compact caps leave
 * `markdown` and `callout` out: Tailwind emits these rules with equal specificity in its
 * own order, and a compact cap that matched a prose block would replace its prose cap
 * (the computed cascade is pinned by `lane-cascade.test.ts`). Literals, so Tailwind's
 * compiler sees them.
 */
export const BLOCK_PROSE_CAP = [
  '[&>*>*[data-block-type=markdown]]:max-w-[38rem]',
  '[&>*>*[data-block-type=callout]]:max-w-[42rem]',
  '[&>*>*[data-scope-line]]:max-w-[42rem]',
  '[&>*>*[data-block-width=compact]:not([data-block-type=markdown]):not([data-block-type=callout])]:max-w-[42rem]',
  '@[40rem]:[&>*>*[data-block-width=compact]:not([data-block-type=markdown]):not([data-block-type=callout])]:max-w-[calc(42rem+1.5rem+2px)]',
].join(' ');

/** Answer blocks: the whole lane, framed cards hanging into the gutter, compact blocks and prose capped (above). */
export const WIDE_COL = `${LANE_COL} ${BLOCK_HANG} ${BLOCK_PROSE_CAP}`;

/**
 * The meta row under an answer with a WIDE block: the whole lane, so its actions end on
 * the blocks' right edge (it follows the widest block of its answer, SPEC-chat §5.1).
 * What follows it in the same column (the run log, Sources, the memory line) keeps the
 * reading measure. An answer whose blocks are all compact (or that has none) puts its
 * meta row in the reading column, next to the prose and cards it acts on.
 */
export const META_COL = `${LANE_COL} [&>*+*]:max-w-[42rem]`;

/** The lane gutter (the host sets it as `--chat-gutter`). */
export const LANE_GUTTER = 'clamp(1rem, 2.5cqi, 2.5rem)';

/* Geometry the classes above encode, in px (1rem = 16 px), for tests and measurement. */

/** The conversation width from which framed cards hang into the gutter (`@[40rem]`, T5). */
export const HANG_FROM_PX = 640;
/** A framed card's hang: its border plus BlockCard's `px-3` (0.75rem + 1px). */
export const CARD_HANG_PX = 13;
/** The reading column (`READING_MEASURE`) in px. */
export const READING_PX = 672;

/** The lane gutter for a conversation width (`clamp(1rem, 2.5cqi, 2.5rem)`). */
export function laneGutterPx(conversation: number): number {
  return Math.min(40, Math.max(16, conversation * 0.025));
}

/** How far a framed card hangs into the gutter at a conversation width (0 below 40rem). */
export function cardHangPx(conversation: number): number {
  return conversation >= HANG_FROM_PX ? CARD_HANG_PX : 0;
}

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
  comfortable: 'Narrower, easier to read',
  wide: 'Wider, centred',
  full: 'Fills the space (default)',
};

export function isLaneWidth(value: unknown): value is ChatLaneWidth {
  return value === 'comfortable' || value === 'wide' || value === 'full';
}

/** The CSS variables a host sets on the conversation zone (an `@container`). */
export function laneVars(width: ChatLaneWidth): Record<string, string> {
  return { '--chat-gutter': LANE_GUTTER, '--chat-lane-max': LANE_MAX[width] };
}
