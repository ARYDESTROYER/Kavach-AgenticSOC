/**
 * The conversation lane's column grid (chat revamp SPEC §10.1: "Blocks widen to
 * min(64rem, conversation width); prose stays ≤ 48rem").
 *
 * One five-track "breakout" grid: a centred content track of min(48rem, 100%) for
 * prose, the user bubble, the meta row and the composer, flanked by two tracks of up
 * to 8rem that let answer blocks widen to 64rem, then free space. Grid sizing fills
 * the bounded tracks before the `fr` ones, so prose keeps its full measure until the
 * lane is narrower than 48rem, and blocks stop widening first. Exchanges and messages
 * repeat the lane tracks (messages subgrid their exchange), so every row of every turn
 * shares the same edges as the composer below (which uses the same grid).
 */

/** The lane grid (transcript and composer area). */
export const LANE_GRID =
  'grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)_min(48rem,100%)_minmax(0,8rem)_minmax(0,1fr)]';

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
export const LANE_EXCHANGE =
  'col-span-full grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)_min(48rem,100%)_minmax(0,8rem)_minmax(0,1fr)]';

/** Prose measure (≤ 48rem). */
export const CONTENT_COL = 'col-start-3 col-end-4 min-w-0';

/** Block measure (≤ 64rem). */
export const WIDE_COL = 'col-start-2 col-end-5 min-w-0';
