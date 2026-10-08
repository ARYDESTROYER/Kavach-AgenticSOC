/**
 * The conversation lane's column grid (chat revamp SPEC §10.1: "Blocks widen to
 * min(64rem, conversation width); prose stays ≤ 48rem").
 *
 * One five-track "breakout" grid: a centred content track of min(48rem, 100%) for
 * prose, the user bubble, the meta row and the composer, flanked by two tracks of up
 * to 8rem that let answer blocks widen to 64rem, then free space. Grid sizing fills
 * the bounded tracks before the `fr` ones, so prose keeps its full measure until the
 * lane is narrower than 48rem, and blocks stop widening first. Exchanges and messages
 * are column SUBGRIDS, so every row of every turn shares the same edges as the
 * composer below (which uses the same grid).
 */

/** The lane grid (transcript and composer area). */
export const LANE_GRID =
  'grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)_min(48rem,100%)_minmax(0,8rem)_minmax(0,1fr)]';

/** An exchange or message: spans the lane and reuses its columns. */
export const LANE_SUBGRID = 'col-span-full grid grid-cols-subgrid';

/** Prose measure (≤ 48rem). */
export const CONTENT_COL = 'col-start-3 col-end-4 min-w-0';

/** Block measure (≤ 64rem). */
export const WIDE_COL = 'col-start-2 col-end-5 min-w-0';
