/**
 * Label placement for the Simple noise reduction flow (Round 12 polish 3).
 *
 * The flow graph is drawn only where its labels fit. Tour 3 showed why a fixed rem
 * cut-off cannot decide that: at 768 px with the nav collapsed the Overview column was
 * 656 px, just over the old 38rem threshold, so the full flow was drawn and
 * "Not analyst-closed · 10 · 83%" sat on top of the Escalated node marker while the two
 * right-hand labels hid the escalated ribbons entirely. Whether labels fit depends on
 * their measured widths (counts and shares change them) and on the measured container.
 *
 * This module is pure: the component measures the container, the band height and every
 * label's box in both of its forms, then asks {@link placeFlowLabels} for a placement.
 * Every label starts on one line ("Escalated · 12 · 27%"); the labels a collision names
 * switch to two lines (name, then count · share), the right-hand resolution labels first,
 * until nothing collides. Each attempt first spreads the labels that share a column so
 * they never overlap each other, a label already placed beside them, or a ribbon that
 * crosses the column (collision avoidance). A label that still hides a ribbon is a
 * collision like any other: every case-flow ribbon keeps a stretch of `MIN_RIBBON_RUN`
 * that no label covers. When stacking cannot clear every collision, the result is `collides` and
 * the component lists the same stages in the aligned stage rail instead of drawing the
 * graph.
 *
 * Coordinates are the flow's viewBox units, which the component keeps equal to CSS
 * pixels by sizing the viewBox to the measured box.
 */

export interface LabelSize {
  w: number;
  h: number;
}

/** `line`: one row. `stack`: the stage name above its count and share. */
export type FlowLabelForm = 'line' | 'stack';

export interface FlowLabelSizes {
  line: LabelSize;
  stack: LabelSize;
}

/** A case-flow node and where its label sits by default. */
export interface FlowLabelNode {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The default label centre (the node's middle, or above it for Cases opened). */
  labelY: number;
  /** `after`: the label starts right of the node. `before`: it ends left of it. */
  labelSide: 'after' | 'before';
  /**
   * A label that sits above its node (Cases opened) grows upward when stacked: its bottom
   * edge stays where the one-line label's bottom edge was, so it never covers more of
   * the node's ribbons than the one-line label did.
   */
  growUp?: boolean;
}

/** An alert / cluster context node; its label hangs above or below it. */
export interface FlowConversionNode {
  key: string;
  /** The marker's left edge; the label starts `LABEL_NODE_OFFSET` right of its centre. */
  x: number;
  y: number;
  /** Node marker width (the conversion nodes share the case nodes' 4 px). */
  w: number;
  h: number;
  labelY: number;
  labelSide: 'above' | 'below';
}

/**
 * A case-flow ribbon in the cubic form `ribbonPath` draws: both edges leave the source
 * horizontally and reach the target horizontally, with their control points at the
 * horizontal midpoint.
 */
export interface FlowLabelRibbon {
  key: string;
  /** The node keys it joins, so a label column never treats its own ribbons as obstacles. */
  source: string;
  target: string;
  x0: number;
  /** Top and bottom edge at the source. */
  sy0: number;
  sy1: number;
  x1: number;
  /** Top and bottom edge at the target. */
  ty0: number;
  ty1: number;
}

export interface FlowLabelInput {
  width: number;
  height: number;
  /** Nodes whose label is drawn (a zero-height node has none). */
  nodes: FlowLabelNode[];
  conversion: FlowConversionNode[];
  /**
   * Labels that share a column, top to bottom, spread so they never overlap. A key that
   * is not in `nodes` is ignored.
   */
  columns: string[][];
  /**
   * A `before` label covers the ribbons arriving at its node: map it to the node those
   * ribbons leave from, so a run of each ribbon stays visible between that node and the
   * label (`MIN_RIBBON_RUN`).
   */
  ribbonSource: Record<string, string>;
  /** Labels stacked before any other when they collide (the right-hand resolution column). */
  stackFirst: string[];
  /**
   * The case-flow ribbons no label may hide (polish 3 re-verify). A ribbon that crosses a
   * label column, other than the column's own, bounds that column's lane the way a placed
   * label does, so "Closed by analyst policy" spreads above the escalated ribbons instead
   * of lying on them. And every ribbon keeps a visible run of at least `MIN_RIBBON_RUN`
   * that no label covers, whichever side of its node the label sits on.
   */
  ribbons?: FlowLabelRibbon[];
}

export interface FlowLabelPlacement {
  fit: 'fits' | 'collides';
  forms: Record<string, FlowLabelForm>;
  /** Placed label centre (`after` / `before` labels) per node key. */
  labelY: Record<string, number>;
  /** What collided in the returned candidate (empty when it fits), for tests and QA. */
  collisions: string[];
}

/** Distance between a label and its own node (the component draws it there). */
export const LABEL_NODE_OFFSET = 8;
/** Least clear space between two labels, or between a label and any node marker. */
export const LABEL_GAP = 4;
/** Least visible run of every case-flow ribbon, and of the ribbons a `before` label sits on. */
export const MIN_RIBBON_RUN = 32;
/**
 * How much of a ribbon's thickness must stay uncovered at a point for the ribbon to count
 * as visible there (all of it when the ribbon is thinner). A label that only grazes the
 * edge of a thick ribbon leaves it easy to follow; one that covers it does not.
 */
export const MIN_RIBBON_SLIVER = 2;
/**
 * How far a label may spill above or below the band: the band sits between the
 * headline row and the footer with 12 px around it, and the topmost conversion label
 * has always hung a few pixels above the plot.
 */
export const VERTICAL_SPILL = 8;

export interface Box {
  key: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Rounding slack, so a label spread to exactly `LABEL_GAP` from another never "touches" it. */
const EPS = 1e-6;
const overlaps = (a: Box, b: Box, gap: number) =>
  a.left < b.right + gap - EPS &&
  b.left < a.right + gap - EPS &&
  a.top < b.bottom + gap - EPS &&
  b.top < a.bottom + gap - EPS;

function nodeLabelBox(node: FlowLabelNode, size: LabelSize, centre: number): Box {
  const left =
    node.labelSide === 'after' ? node.x + node.w + LABEL_NODE_OFFSET : node.x - LABEL_NODE_OFFSET - size.w;
  return { key: node.key, left, right: left + size.w, top: centre - size.h / 2, bottom: centre + size.h / 2 };
}

function conversionLabelBox(node: FlowConversionNode, size: LabelSize): Box {
  const left = node.x + node.w / 2 + LABEL_NODE_OFFSET;
  const top = node.labelSide === 'above' ? node.labelY - size.h : node.labelY;
  return { key: node.key, left, right: left + size.w, top, bottom: top + size.h };
}

/** A ribbon's vertical extent at one horizontal position. */
export interface RibbonSection {
  x: number;
  top: number;
  bottom: number;
}

/**
 * A ribbon's cross-section at every whole pixel along it. With the control points at
 * the horizontal midpoint, both edges share x(t) = x0 + (x1 - x0)(1.5t - 1.5t² + t³),
 * which only rises, and each edge eases from its source height to its target height by
 * 3t² - 2t³; so each x maps to one t (found by bisection) and one top and bottom.
 */
export function ribbonSections(ribbon: FlowLabelRibbon): RibbonSection[] {
  const span = ribbon.x1 - ribbon.x0;
  if (!(span > 0) || ![ribbon.sy0, ribbon.sy1, ribbon.ty0, ribbon.ty1].every(Number.isFinite)) return [];
  const steps = Math.max(1, Math.ceil(span));
  const sections: RibbonSection[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const along = i / steps;
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 32; k += 1) {
      const t = (lo + hi) / 2;
      if (1.5 * t - 1.5 * t * t + t * t * t < along) lo = t;
      else hi = t;
    }
    const t = (lo + hi) / 2;
    const ease = 3 * t * t - 2 * t * t * t;
    sections.push({
      x: ribbon.x0 + span * along,
      top: ribbon.sy0 + (ribbon.ty0 - ribbon.sy0) * ease,
      bottom: ribbon.sy1 + (ribbon.ty1 - ribbon.sy1) * ease,
    });
  }
  return sections;
}

/** The longest stretch of `sections` no box hides (see `MIN_RIBBON_SLIVER`), in pixels. */
export function longestVisibleRun(sections: RibbonSection[], boxes: Box[]): number {
  let best = 0;
  let start: number | null = null;
  for (const section of sections) {
    const thickness = section.bottom - section.top;
    // The covered parts of this cross-section, top to bottom, then the widest gap left.
    const covered = boxes
      .filter(
        (box) =>
          box.left <= section.x &&
          section.x <= box.right &&
          box.top < section.bottom &&
          section.top < box.bottom,
      )
      .map((box) => [Math.max(section.top, box.top), Math.min(section.bottom, box.bottom)] as const)
      .sort((a, b) => a[0] - b[0]);
    let gap = 0;
    let reach = section.top;
    for (const [from, to] of covered) {
      gap = Math.max(gap, from - reach);
      reach = Math.max(reach, to);
    }
    gap = Math.max(gap, section.bottom - reach);
    const visible = thickness > 0 && gap >= Math.min(thickness, MIN_RIBBON_SLIVER) - EPS;
    if (visible) {
      start ??= section.x;
      best = Math.max(best, section.x - start);
    } else {
      start = null;
    }
  }
  return best;
}

/** The part of a ribbon inside `[left, right]` as one box (its highest top, lowest bottom). */
function ribbonBoxWithin(key: string, sections: RibbonSection[], left: number, right: number): Box | null {
  let top = Infinity;
  let bottom = -Infinity;
  let first = Infinity;
  let last = -Infinity;
  for (const section of sections) {
    if (section.x < left || section.x > right) continue;
    top = Math.min(top, section.top);
    bottom = Math.max(bottom, section.bottom);
    first = Math.min(first, section.x);
    last = Math.max(last, section.x);
  }
  return bottom > top ? { key, left: first, right: last, top, bottom } : null;
}

/**
 * Spread one column of labels (top to bottom) around their wanted centres so that each
 * clears the next by `LABEL_GAP` and the column stays inside `[floor, ceiling]` (the
 * caller narrows that lane to clear any label already placed beside the column). Returns
 * the centres, or `null` when the column cannot fit.
 */
export function spreadColumn(
  wanted: number[],
  heights: number[],
  floor: number,
  ceiling: number,
): number[] | null {
  const n = wanted.length;
  if (n === 0) return [];
  const sep = (i: number) => (heights[i - 1] + heights[i]) / 2 + LABEL_GAP;
  // Blocks of touching labels, each centred on the mean of what its members want, merged
  // until no two blocks overlap (the classic dodge: a label moves only as far as its
  // neighbours force it, and two that collide share the move).
  type Block = { start: number; end: number; offsets: number[]; centre: number };
  const blocks: Block[] = [];
  for (let i = 0; i < n; i += 1) {
    blocks.push({ start: i, end: i, offsets: [0], centre: wanted[i] });
    for (;;) {
      if (blocks.length < 2) break;
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      const aLast = a.centre + a.offsets[a.offsets.length - 1];
      const bFirst = b.centre + b.offsets[0];
      if (bFirst - aLast >= sep(b.start) - 1e-9) break;
      // Merge b into a: lay the members out at their required spacing, then centre the
      // block on the mean of the members' wanted positions.
      const offsets = [...a.offsets];
      for (let k = b.start; k <= b.end; k += 1) offsets.push(offsets[offsets.length - 1] + sep(k));
      const members = offsets.length;
      let meanWanted = 0;
      let meanOffset = 0;
      for (let k = 0; k < members; k += 1) {
        meanWanted += wanted[a.start + k];
        meanOffset += offsets[k];
      }
      blocks.splice(blocks.length - 2, 2, {
        start: a.start,
        end: b.end,
        offsets,
        centre: (meanWanted - meanOffset) / members,
      });
    }
  }
  const centres: number[] = [];
  for (const b of blocks) for (const off of b.offsets) centres.push(b.centre + off);
  // Inside the lane: push down from the floor, then up from the ceiling.
  if (centres[0] - heights[0] / 2 < floor) {
    centres[0] = floor + heights[0] / 2;
    for (let i = 1; i < n; i += 1) centres[i] = Math.max(centres[i], centres[i - 1] + sep(i));
  }
  if (centres[n - 1] + heights[n - 1] / 2 > ceiling) {
    centres[n - 1] = ceiling - heights[n - 1] / 2;
    for (let i = n - 2; i >= 0; i -= 1) centres[i] = Math.min(centres[i], centres[i + 1] - sep(i + 1));
  }
  if (centres[0] - heights[0] / 2 < floor - 1e-6) return null;
  return centres;
}

interface SampledRibbon {
  ribbon: FlowLabelRibbon;
  sections: RibbonSection[];
}

function placeCandidate(
  input: FlowLabelInput,
  sizes: Record<string, FlowLabelSizes>,
  forms: Record<string, FlowLabelForm>,
  ribbons: SampledRibbon[],
): { labelY: Record<string, number>; collisions: string[] } {
  const byKey = new Map(input.nodes.map((node) => [node.key, node]));
  const sizeOf = (key: string): LabelSize => sizes[key]?.[forms[key] ?? 'line'] ?? { w: 0, h: 0 };
  const labelY: Record<string, number> = {};
  for (const node of input.nodes) {
    const size = sizeOf(node.key);
    const line = sizes[node.key]?.line ?? size;
    labelY[node.key] = node.growUp ? node.labelY + (line.h - size.h) / 2 : node.labelY;
  }
  const collisions: string[] = [];

  const conversionBoxes = input.conversion
    .filter((node) => node.h > 0)
    .map((node) => conversionLabelBox(node, sizes[node.key]?.line ?? { w: 0, h: 0 }));
  const lower = -VERTICAL_SPILL;
  const upper = input.height + VERTICAL_SPILL;

  // Spread each column against what is already placed: the fixed labels (every node
  // label outside a column, and the conversion labels) and earlier columns.
  const columnKeys = new Set(input.columns.flat());
  const placed: Box[] = [
    ...conversionBoxes,
    ...input.nodes
      .filter((node) => !columnKeys.has(node.key))
      .map((node) => nodeLabelBox(node, sizeOf(node.key), labelY[node.key])),
  ];
  for (const column of input.columns) {
    const members = column.map((key) => byKey.get(key)).filter((node): node is FlowLabelNode => Boolean(node));
    if (!members.length) continue;
    const heights = members.map((node) => sizeOf(node.key).h);
    // The column's horizontal extent: anything placed there bounds it from above or
    // below, by which side of the column's wanted middle it sits on.
    const spans = members.map((node) => nodeLabelBox(node, sizeOf(node.key), node.labelY));
    const left = Math.min(...spans.map((box) => box.left));
    const right = Math.max(...spans.map((box) => box.right));
    const wanted = members.map((node) => node.y + node.h / 2);
    const middle = (wanted[0] + wanted[wanted.length - 1]) / 2;
    let floor = lower;
    let ceiling = upper;
    // Ribbons crossing the column bound it like placed labels, except the members' own
    // ribbons (a label sits at the end of the ribbon that arrives at its node by design).
    const memberKeys = new Set(column);
    const crossing = ribbons
      .filter(({ ribbon }) => !memberKeys.has(ribbon.source) && !memberKeys.has(ribbon.target))
      .map(({ ribbon, sections }) =>
        ribbonBoxWithin(ribbon.key, sections, left - LABEL_GAP, right + LABEL_GAP),
      )
      .filter((box): box is Box => box !== null);
    for (const box of [...placed, ...crossing]) {
      if (!(box.left < right + LABEL_GAP && left < box.right + LABEL_GAP)) continue;
      if ((box.top + box.bottom) / 2 <= middle) floor = Math.max(floor, box.bottom + LABEL_GAP);
      else ceiling = Math.min(ceiling, box.top - LABEL_GAP);
    }
    const centres = spreadColumn(wanted, heights, floor, ceiling);
    if (!centres) {
      collisions.push(`column:${members.map((node) => node.key).join('+')}`);
      continue;
    }
    members.forEach((node, i) => {
      labelY[node.key] = centres[i];
      placed.push(nodeLabelBox(node, sizeOf(node.key), centres[i]));
    });
  }

  const nodeBoxes: Box[] = [
    ...input.nodes.map((node) => nodeLabelBox(node, sizeOf(node.key), labelY[node.key])),
  ];
  const labels = [...conversionBoxes, ...nodeBoxes];
  const conversionKeys = new Set(conversionBoxes.map((box) => box.key));
  const markers: Box[] = [
    ...input.nodes.map((node) => ({ key: node.key, left: node.x, right: node.x + node.w, top: node.y, bottom: node.y + node.h })),
    ...input.conversion
      .filter((node) => node.h > 0)
      .map((node) => ({ key: node.key, left: node.x, right: node.x + node.w, top: node.y, bottom: node.y + node.h })),
  ];

  for (const box of labels) {
    // Inside the band: horizontally always. Vertically within the spill, except the
    // conversion labels, which hang from their node by design.
    if (box.left < -0.5 || box.right > input.width + 0.5) collisions.push(`bounds:${box.key}`);
    else if (!conversionKeys.has(box.key) && (box.top < lower - 0.5 || box.bottom > upper + 0.5)) {
      collisions.push(`bounds:${box.key}`);
    }
  }
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      if (overlaps(labels[i], labels[j], LABEL_GAP)) collisions.push(`label:${labels[i].key}+${labels[j].key}`);
    }
  }
  for (const box of labels) {
    for (const marker of markers) {
      if (marker.bottom - marker.top <= 0) continue;
      if (overlaps(box, marker, LABEL_GAP / 2)) collisions.push(`node:${box.key}+${marker.key}`);
    }
  }
  for (const box of nodeBoxes) {
    const sourceKey = input.ribbonSource[box.key];
    const source = sourceKey ? byKey.get(sourceKey) : undefined;
    if (!source || byKey.get(box.key)?.labelSide !== 'before') continue;
    if (box.left - (source.x + source.w) < MIN_RIBBON_RUN) collisions.push(`ribbon:${box.key}`);
  }
  // Every case-flow ribbon keeps a stretch no label hides, whichever label covers it: the
  // right-hand decision labels ("Closed by analyst policy") lie across the escalated
  // ribbons as readily as the resolution labels lie at their ends.
  for (const { ribbon, sections } of ribbons) {
    if (longestVisibleRun(sections, labels) >= MIN_RIBBON_RUN) continue;
    const span = { left: ribbon.x0, right: ribbon.x1 };
    for (const box of labels) {
      if (box.right < span.left || box.left > span.right) continue;
      const covers = sections.some(
        (section) =>
          box.left <= section.x && section.x <= box.right && box.top < section.bottom && section.top < box.bottom,
      );
      if (covers) collisions.push(`ribbon:${box.key}+${ribbon.key}`);
    }
  }
  return { labelY, collisions };
}

/**
 * Place every flow label. Every label starts on one line; while anything collides, the
 * labels involved switch to their stacked form (the right-hand resolution labels first,
 * since they crowd first; a column always switches together), and the placement is
 * tried again. The first collision-free
 * placement wins, so a label is stacked only when it has to be. `fit: 'collides'` returns
 * the attempt with the fewest collisions, for a surface that must draw the graph
 * regardless (the full-screen inspection).
 */
export function placeFlowLabels(
  input: FlowLabelInput,
  sizes: Record<string, FlowLabelSizes>,
): FlowLabelPlacement {
  const keys = input.nodes.map((node) => node.key);
  const nodeKeys = new Set(keys);
  const stackFirst = new Set(input.stackFirst);
  const forms = Object.fromEntries(keys.map((key) => [key, 'line'])) as Record<string, FlowLabelForm>;
  // Sampled once: the ribbons do not move between attempts, only the labels do.
  const ribbons = (input.ribbons ?? [])
    .map((ribbon) => ({ ribbon, sections: ribbonSections(ribbon) }))
    .filter(({ sections }) => sections.length > 0);
  let best: FlowLabelPlacement | null = null;
  for (let round = 0; round <= keys.length; round += 1) {
    const { labelY, collisions } = placeCandidate(input, sizes, forms, ribbons);
    const attempt: FlowLabelPlacement = {
      fit: collisions.length ? 'collides' : 'fits',
      forms: { ...forms },
      labelY,
      collisions,
    };
    if (!collisions.length) return attempt;
    if (!best || collisions.length < best.collisions.length) best = attempt;
    // The labels a collision names: both labels of a pair, the label (not the marker)
    // of a label-on-node, the label of a bounds or ribbon problem (a ribbon's own key is
    // never a node key, so only the label covering it switches), a crowded column.
    const involved = new Set<string>();
    for (const collision of collisions) {
      const [kind, rest = ''] = collision.split(':');
      const [a, b] = rest.split('+');
      involved.add(a);
      if (b && kind !== 'node') involved.add(b);
    }
    const switchable = [...involved].filter((key) => nodeKeys.has(key) && forms[key] === 'line');
    if (!switchable.length) break;
    const first = switchable.filter((key) => stackFirst.has(key));
    for (const key of first.length ? first : switchable) {
      // A column switches together, so the labels stacked over each other read alike.
      const column = input.columns.find((members) => members.includes(key)) ?? [key];
      for (const member of column) if (nodeKeys.has(member)) forms[member] = 'stack';
    }
  }
  return best!;
}

/**
 * Every label's box under a placement, the conversion labels first, in the input's
 * coordinates: what tests and QA read to check what a placement leaves in view.
 */
export function placedLabelBoxes(
  input: FlowLabelInput,
  sizes: Record<string, FlowLabelSizes>,
  placement: Pick<FlowLabelPlacement, 'forms' | 'labelY'>,
): Box[] {
  const none = { w: 0, h: 0 };
  return [
    ...input.conversion
      .filter((node) => node.h > 0)
      .map((node) => conversionLabelBox(node, sizes[node.key]?.line ?? none)),
    ...input.nodes.map((node) =>
      nodeLabelBox(
        node,
        sizes[node.key]?.[placement.forms[node.key] ?? 'line'] ?? none,
        placement.labelY[node.key] ?? node.labelY,
      ),
    ),
  ];
}
