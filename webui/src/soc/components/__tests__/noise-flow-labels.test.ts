/**
 * Label placement for the Simple noise reduction flow (Round 12 polish 3, tour 3 item 2):
 * the graph is drawn only where its measured labels fit the measured container, the
 * right-hand labels never sit on the Escalated node or hide its ribbons, and labels that
 * share a column are spread instead of stacked on top of each other.
 */
import { describe, expect, it } from 'vitest';

import {
  LABEL_GAP,
  MIN_RIBBON_RUN,
  longestVisibleRun,
  placeFlowLabels,
  placedLabelBoxes,
  ribbonSections,
  spreadColumn,
  type FlowLabelInput,
  type FlowLabelRibbon,
  type FlowLabelSizes,
} from '../noise-flow-labels';
import { ribbonPath } from '../NoiseFunnel';

/** Text widths at 12 px Inter, roughly 6.4 px a glyph plus the label's 12 px padding. */
const glyphs = (text: string) => Math.round(text.length * 6.4) + 12;
function sizesFor(labels: Record<string, [string, string]>): Record<string, FlowLabelSizes> {
  const out: Record<string, FlowLabelSizes> = {};
  for (const [key, [name, figures]] of Object.entries(labels)) {
    const stack = { w: Math.max(glyphs(name), glyphs(figures)), h: 40 };
    // The alert and cluster labels have one two-line form; the component measures it once.
    out[key] =
      key === 'ingested' || key === 'clustered'
        ? { line: stack, stack }
        : { line: { w: glyphs(`${name} · ${figures}`) + 4, h: 24 }, stack };
  }
  return out;
}

/** The demo window of tour 3: 177 alerts, 45 clusters and cases, 33 auto-cleared, 12 escalated (2 closed). */
const TOUR3 = sizesFor({
  ingested: ['Alerts ingested', '177 alerts · —'],
  clustered: ['After clustering', '45 clusters · 25%'],
  cases: ['Cases opened', '45 · 100%'],
  auto_cleared: ['Auto-cleared by AI', '33 · 73%'],
  escalated: ['Escalated', '12 · 27%'],
  closed: ['Closed by human', '2 · 17%'],
  escalated_remaining: ['Not analyst-closed', '10 · 83%'],
});

/**
 * The flow's geometry for the tour-3 window at a given container width, as
 * `buildSimpleLayout` lays it out in the 240 px inline band (x scales with the width;
 * NoiseFunnel.test.tsx drives the real layout end to end).
 */
function flowAt(width: number, height = 240): FlowLabelInput {
  const casesX = width * 0.405;
  const decisionX = width * 0.69;
  const resolutionX = width - 10;
  const node = (key: string, x: number, y: number, h: number, labelY: number, labelSide: 'after' | 'before') => ({
    key,
    x: x - 2,
    y,
    w: 4,
    h,
    labelY,
    labelSide,
  });
  return {
    width,
    height,
    nodes: [
      { ...node('cases', casesX, 88.6, 86.7, 80.6, 'after'), growUp: true },
      node('auto_cleared', decisionX, 76.6, 63.6, 108.4, 'after'),
      node('escalated', decisionX, 164.3, 23.1, 175.8, 'before'),
      node('closed', resolutionX, 155.3, 3.85, 157.2, 'before'),
      node('escalated_remaining', resolutionX, 177.1, 19.3, 186.8, 'before'),
    ],
    conversion: [
      { key: 'ingested', x: 10, y: 46, w: 4, h: 172, labelY: 40, labelSide: 'above' },
      { key: 'clustered', x: width * 0.205 - 2, y: 88.6, w: 4, h: 86.7, labelY: 181.3, labelSide: 'below' },
    ],
    columns: [['auto_cleared', 'policy_closed'], ['closed', 'escalated_remaining']],
    ribbonSource: { escalated: 'cases', closed: 'escalated', escalated_remaining: 'escalated' },
    stackFirst: ['closed', 'escalated_remaining'],
  };
}

describe('placeFlowLabels', () => {
  it('keeps every label on one line where the flow is wide (1440 px Overview cell)', () => {
    const placed = placeFlowLabels(flowAt(870), TOUR3);
    expect(placed.fit).toBe('fits');
    expect(new Set(Object.values(placed.forms))).toEqual(new Set(['line']));
  });

  it('never draws the tour-3 defect at the 656 px column: it stacks the labels instead', () => {
    const input = flowAt(656);
    // The one-line candidate is exactly what tour 3 showed: "Not analyst-closed · 10 ·
    // 83%" crosses the Escalated node marker and leaves none of its ribbons visible.
    const oneLine = placeFlowLabels({ ...input, stackFirst: [] }, {
      ...TOUR3,
      // Without a narrower form to fall back on, nothing else can fit either.
      ...Object.fromEntries(Object.entries(TOUR3).map(([key, size]) => [key, { line: size.line, stack: size.line }])),
    });
    expect(oneLine.fit).toBe('collides');
    expect(oneLine.collisions).toContain('ribbon:escalated_remaining');
    expect(oneLine.collisions.some((c) => c.startsWith('node:escalated_remaining+escalated'))).toBe(true);
    // With the measured two-line forms the compact layout fits.
    const placed = placeFlowLabels(input, TOUR3);
    expect(placed.fit).toBe('fits');
    expect(placed.forms.escalated_remaining).toBe('stack');
  });

  it('falls back to the stage list once even the compact labels collide', () => {
    expect(placeFlowLabels(flowAt(560), TOUR3).fit).toBe('collides');
  });

  it('stacks only the labels that collide, the right-hand column first and together', () => {
    const placed = placeFlowLabels(flowAt(760), TOUR3);
    expect(placed.fit).toBe('fits');
    expect(placed.forms).toEqual({
      cases: 'line',
      auto_cleared: 'line',
      escalated: 'line',
      closed: 'stack',
      escalated_remaining: 'stack',
    });
    // Narrower, the decision-column labels follow, still never more than needed.
    const narrower = placeFlowLabels(flowAt(656), TOUR3);
    expect(narrower.fit).toBe('fits');
    expect(narrower.forms.cases).toBe('line');
    expect(narrower.forms.auto_cleared).toBe('stack');
  });

  it('decides on the measured label widths, not on the container alone', () => {
    // The same container gives a different answer once the counts run to six digits.
    const wide = sizesFor({
      ingested: ['Alerts ingested', '1,234,567 alerts · —'],
      clustered: ['After clustering', '456,789 clusters · 37%'],
      cases: ['Cases opened', '123,456 · 27%'],
      auto_cleared: ['Auto-cleared by AI', '100,000 · 81%'],
      escalated: ['Escalated', '23,456 · 19%'],
      closed: ['Closed by human', '12,345 · 53%'],
      escalated_remaining: ['Not analyst-closed', '11,111 · 47%'],
    });
    expect(placeFlowLabels(flowAt(870), TOUR3).forms.escalated_remaining).toBe('line');
    expect(placeFlowLabels(flowAt(870), wide).forms.escalated_remaining).toBe('stack');
    expect(placeFlowLabels(flowAt(700), TOUR3).forms.cases).toBe('line');
    expect(placeFlowLabels(flowAt(700), wide).forms.cases).toBe('stack');
    expect(placeFlowLabels(flowAt(560), wide).fit).toBe('collides');
  });

  it('grows a stacked Cases opened label upward from where the one-line label ended', () => {
    const placed = placeFlowLabels(flowAt(640), TOUR3);
    expect(placed.forms.cases).toBe('stack');
    // One-line: centred on 80.6, 24 px tall, bottom 92.6. Stacked (40 px): same bottom.
    expect(placed.labelY.cases + 40 / 2).toBeCloseTo(80.6 + 24 / 2, 6);
  });

  it('spreads the two right-hand labels and keeps both clear of the Auto-cleared label', () => {
    const input = flowAt(1100);
    // Push the escalated branch up against the Auto-cleared label's row.
    input.nodes = input.nodes.map((node) =>
      node.key === 'closed'
        ? { ...node, y: 112, h: 2 }
        : node.key === 'escalated_remaining'
          ? { ...node, y: 116, h: 2 }
          : node,
    );
    const placed = placeFlowLabels(input, TOUR3);
    expect(placed.fit).toBe('fits');
    const closed = placed.labelY.closed;
    const remaining = placed.labelY.escalated_remaining;
    expect(remaining - closed).toBeGreaterThanOrEqual(24 + LABEL_GAP - 1e-6);
    // Auto-cleared's one-line label (24 px) shares their horizontal span: the column
    // starts below it instead of on top of it.
    expect(placed.forms.closed).toBe('line');
    const auto = input.nodes.find((node) => node.key === 'auto_cleared')!;
    expect(closed - 12).toBeGreaterThanOrEqual(auto.labelY + 12 + LABEL_GAP - 1e-6);
  });

  it('spreads Auto-cleared and Closed by analyst policy when thin nodes put them together', () => {
    const input = flowAt(1100);
    const decisionX = 1100 * 0.69;
    input.nodes = [
      ...input.nodes.map((node) => (node.key === 'auto_cleared' ? { ...node, y: 90, h: 6, labelY: 93 } : node)),
      { key: 'policy_closed', x: decisionX - 2, y: 110, w: 4, h: 4, labelY: 112, labelSide: 'after' },
    ];
    const sizes = {
      ...TOUR3,
      ...sizesFor({ policy_closed: ['Closed by analyst policy', '3 · 7%'] }),
    };
    const placed = placeFlowLabels(input, sizes);
    expect(placed.fit).toBe('fits');
    // Both wanted the same ~20 px; they share the move and end one label plus a gap apart.
    expect(placed.labelY.policy_closed - placed.labelY.auto_cleared).toBeCloseTo(24 + LABEL_GAP, 6);
    expect((placed.labelY.policy_closed + placed.labelY.auto_cleared) / 2).toBeCloseTo((93 + 112) / 2, 6);
  });

  it('leaves a visible run of the escalated ribbons whenever it reports a fit', () => {
    for (const width of [640, 656, 700, 768, 900, 1024, 1280]) {
      const input = flowAt(width);
      const placed = placeFlowLabels(input, TOUR3);
      if (placed.fit !== 'fits') continue;
      const escalated = input.nodes.find((node) => node.key === 'escalated')!;
      for (const key of ['closed', 'escalated_remaining']) {
        const size = TOUR3[key][placed.forms[key]];
        const left = width - 10 - 2 - 8 - size.w;
        expect(left - (escalated.x + escalated.w)).toBeGreaterThanOrEqual(MIN_RIBBON_RUN);
      }
    }
  });
});

describe('spreadColumn', () => {
  it('moves two overlapping labels apart symmetrically around what they want', () => {
    expect(spreadColumn([100, 104], [24, 24], 0, 240)).toEqual([88, 116]);
  });

  it('keeps labels that already clear each other where they are', () => {
    expect(spreadColumn([60, 120], [24, 24], 0, 240)).toEqual([60, 120]);
  });

  it('pushes a column down from its floor and up from its ceiling', () => {
    expect(spreadColumn([10, 14], [24, 24], 20, 240)).toEqual([32, 60]);
    expect(spreadColumn([230, 236], [24, 24], 0, 240)).toEqual([200, 228]);
  });

  it('reports a column that cannot fit its lane', () => {
    expect(spreadColumn([50, 52], [40, 40], 30, 100)).toBeNull();
  });
});

/**
 * The polish 3 re-verify payload: analyst-policy closes put a third node in the decision
 * column. 1,234,567 alerts, 98,765 clusters, 12,345 cases = 9,000 auto-cleared + 1,345
 * closed by analyst policy + 2,000 escalated, 1,500 of them closed by a human.
 */
const POLICY = { ingested: 1_234_567, clustered: 98_765, cases: 12_345, auto: 9_000, policy: 1_345, escalated: 2_000, closed: 1_500 };
const POLICY_SIZES = sizesFor({
  ingested: ['Alerts ingested', '1,234,567 alerts · —'],
  clustered: ['After clustering', '98,765 clusters · 8%'],
  cases: ['Cases opened', '12,345 · 12%'],
  auto_cleared: ['Auto-cleared by AI', '9,000 · 73%'],
  policy_closed: ['Closed by analyst policy', '1,345 · 11%'],
  escalated: ['Escalated', '2,000 · 16%'],
  closed: ['Closed by human', '1,500 · 75%'],
  escalated_remaining: ['Not analyst-closed', '500 · 25%'],
});

/**
 * That payload laid out exactly as `buildSimpleLayout` lays out the inline band (the
 * square-root display scale, the 14 px decision gaps of a three-way split, the resolution
 * block centred on Escalated), with the case-flow ribbons it draws.
 */
function policyFlowAt(
  width: number,
  p: typeof POLICY = POLICY,
  height = 259,
): FlowLabelInput & { ribbons: FlowLabelRibbon[] } {
  const plotTop = 34;
  const plotBottom = height - 10;
  const pipeline = plotBottom - plotTop - 24;
  const compressed = (total: number) => pipeline * Math.sqrt(total / p.ingested);
  const caseH = compressed(p.cases);
  const contextY = (plotTop + plotBottom) / 2;
  const casesX = width * 0.405;
  const decisionX = width * 0.69;
  const resolutionX = width - 10;
  const casesTop = contextY - caseH / 2;
  const autoH = (p.auto / p.cases) * caseH;
  const policyH = (p.policy / p.cases) * caseH;
  const escalatedH = (p.escalated / p.cases) * caseH;
  const autoTop = contextY - (caseH + 14 * 2) / 2;
  const policyTop = autoTop + autoH + 14;
  const escalatedTop = policyTop + policyH + 14;
  const closedH = (p.closed / p.escalated) * escalatedH;
  const remainingH = escalatedH - closedH;
  const resolutionH = escalatedH + 18;
  const closedTop = Math.max(plotTop, Math.min(plotBottom - resolutionH, escalatedTop + escalatedH / 2 - resolutionH / 2));
  const remainingTop = closedTop + closedH + 18;
  const clusteredH = compressed(p.clustered);
  const node = (key: string, x: number, y: number, h: number, labelSide: 'after' | 'before') => ({
    key,
    x: x - 2,
    y,
    w: 4,
    h,
    labelY: y + h / 2,
    labelSide,
  });
  const ribbon = (source: string, target: string, x0: number, sy0: number, sy1: number, x1: number, ty0: number, ty1: number) => ({
    key: `${source}>${target}`,
    source,
    target,
    x0,
    sy0,
    sy1,
    x1,
    ty0,
    ty1,
  });
  return {
    width,
    height,
    nodes: [
      { ...node('cases', casesX, casesTop, caseH, 'after'), labelY: Math.max(plotTop + 9, casesTop - 8), growUp: true },
      node('auto_cleared', decisionX, autoTop, autoH, 'after'),
      node('policy_closed', decisionX, policyTop, policyH, 'after'),
      node('escalated', decisionX, escalatedTop, escalatedH, 'before'),
      node('closed', resolutionX, closedTop, closedH, 'before'),
      node('escalated_remaining', resolutionX, remainingTop, remainingH, 'before'),
    ],
    conversion: [
      { key: 'ingested', x: 10, y: contextY - pipeline / 2, w: 4, h: pipeline, labelY: contextY - pipeline / 2 - 6, labelSide: 'above' },
      { key: 'clustered', x: width * 0.205 - 2, y: contextY - clusteredH / 2, w: 4, h: clusteredH, labelY: contextY + clusteredH / 2 + 6, labelSide: 'below' },
    ],
    columns: [['auto_cleared', 'policy_closed'], ['closed', 'escalated_remaining']],
    ribbonSource: { escalated: 'cases', closed: 'escalated', escalated_remaining: 'escalated' },
    stackFirst: ['closed', 'escalated_remaining'],
    ribbons: [
      ribbon('cases', 'auto_cleared', casesX + 2, casesTop, casesTop + autoH, decisionX - 2, autoTop, autoTop + autoH),
      ribbon('cases', 'policy_closed', casesX + 2, casesTop + autoH, casesTop + autoH + policyH, decisionX - 2, policyTop, policyTop + policyH),
      ribbon('cases', 'escalated', casesX + 2, casesTop + autoH + policyH, casesTop + caseH, decisionX - 2, escalatedTop, escalatedTop + escalatedH),
      ribbon('escalated', 'closed', decisionX + 2, escalatedTop, escalatedTop + closedH, resolutionX - 2, closedTop, closedTop + closedH),
      ribbon('escalated', 'escalated_remaining', decisionX + 2, escalatedTop + closedH, escalatedTop + escalatedH, resolutionX - 2, remainingTop, remainingTop + remainingH),
    ],
  };
}

/** The longest stretch of each ribbon that no label hides under a placement. */
function visibleRuns(
  input: FlowLabelInput & { ribbons: FlowLabelRibbon[] },
  sizes: Record<string, FlowLabelSizes>,
  placement: ReturnType<typeof placeFlowLabels>,
): Record<string, number> {
  const boxes = placedLabelBoxes(input, sizes, placement);
  return Object.fromEntries(input.ribbons.map((r) => [r.key, longestVisibleRun(ribbonSections(r), boxes)]));
}

/** How many pixels of the escalated ribbons a label covers (the decision labels must cover none). */
function escalatedCoveredBy(
  input: FlowLabelInput & { ribbons: FlowLabelRibbon[] },
  sizes: Record<string, FlowLabelSizes>,
  placement: ReturnType<typeof placeFlowLabels>,
  label: string,
): number {
  const box = placedLabelBoxes(input, sizes, placement).find((b) => b.key === label)!;
  return input.ribbons
    .filter((r) => r.source === 'escalated')
    .flatMap((r) => ribbonSections(r))
    .filter((s) => s.x >= box.left && s.x <= box.right && box.top < s.bottom && s.top < box.bottom).length;
}

const SMALL_POLICY = { ingested: 176, clustered: 44, cases: 44, auto: 28, policy: 4, escalated: 12, closed: 2 };
const SMALL_POLICY_SIZES = sizesFor({
  ingested: ['Alerts ingested', '176 alerts · —'],
  clustered: ['After clustering', '44 clusters · 25%'],
  cases: ['Cases opened', '44 · 100%'],
  auto_cleared: ['Auto-cleared by AI', '28 · 64%'],
  policy_closed: ['Closed by analyst policy', '4 · 9%'],
  escalated: ['Escalated', '12 · 27%'],
  closed: ['Closed by human', '2 · 17%'],
  escalated_remaining: ['Not analyst-closed', '10 · 83%'],
});

describe('case-flow ribbons stay in view (polish 3 re-verify: Closed by analyst policy)', () => {
  it('samples the same curve ribbonPath draws', () => {
    const r: FlowLabelRibbon = { key: 'a>b', source: 'a', target: 'b', x0: 100, sy0: 40, sy1: 60, x1: 300, ty0: 10, ty1: 14 };
    const sections = ribbonSections(r);
    expect(sections.length).toBe(201);
    expect(sections[0]).toEqual({ x: 100, top: 40, bottom: 60 });
    expect(sections[200].x).toBeCloseTo(300, 9);
    expect(sections[200].top).toBeCloseTo(10, 6);
    expect(sections[200].bottom).toBeCloseTo(14, 6);
    // The curve is symmetric about its horizontal middle: halfway along, halfway down.
    expect(sections[100].top).toBeCloseTo(25, 6);
    expect(sections[100].bottom).toBeCloseTo(37, 6);
    // And it is the SVG path's own top edge: M x0,sy0 C xm,sy0 xm,ty0 x1,ty0.
    expect(ribbonPath(100, 40, 60, 300, 10, 14)).toMatch(/^M100,40 C200,40 200,10 300,10 /);
    for (let i = 1; i < sections.length; i += 1) expect(sections[i].top).toBeLessThanOrEqual(sections[i - 1].top);
  });

  it('counts a ribbon a label only grazes as visible, and one it covers as hidden', () => {
    const r: FlowLabelRibbon = { key: 'a>b', source: 'a', target: 'b', x0: 0, sy0: 100, sy1: 120, x1: 200, ty0: 100, ty1: 120 };
    const sections = ribbonSections(r);
    expect(longestVisibleRun(sections, [])).toBe(200);
    const grazing = { key: 'g', left: 20, right: 180, top: 80, bottom: 101 };
    expect(longestVisibleRun(sections, [grazing])).toBe(200);
    const covering = { key: 'c', left: 20, right: 180, top: 80, bottom: 130 };
    // 0..19 and 181..200 stay visible: the longest of the two is 19 px.
    expect(longestVisibleRun(sections, [covering])).toBe(19);
    // Two labels splitting the cross-section between them still hide it.
    const upper = { key: 'u', left: 0, right: 200, top: 90, bottom: 111 };
    const lower = { key: 'l', left: 0, right: 200, top: 110, bottom: 130 };
    expect(longestVisibleRun(sections, [upper, lower])).toBe(0);
    // A ribbon thinner than the sliver must be wholly clear: covering half of a 1 px
    // ribbon from 50 to 150 hides it there, leaving 0..49 and 151..200.
    const thin = ribbonSections({ ...r, sy1: 101, ty1: 101 });
    expect(longestVisibleRun(thin, [{ key: 't', left: 50, right: 150, top: 100.5, bottom: 130 }])).toBe(49);
  });

  it('reproduces the defect without the ribbons: the policy label lies across the escalated ribbons', () => {
    const input = policyFlowAt(640);
    const { ribbons: _ignored, ...withoutRibbons } = input;
    const placed = placeFlowLabels(withoutRibbons, POLICY_SIZES);
    // Placement alone called this a fit...
    expect(placed.fit).toBe('fits');
    const runs = visibleRuns(input, POLICY_SIZES, placed);
    // ...while neither escalated ribbon kept a stretch the eye could follow.
    expect(runs['escalated>closed']).toBeLessThan(MIN_RIBBON_RUN);
    expect(runs['escalated>escalated_remaining']).toBeLessThan(MIN_RIBBON_RUN);
    // The smaller window at 900 px: the label lay across the escalated-to-closed ribbon.
    const small = policyFlowAt(900, SMALL_POLICY);
    const { ribbons: _alsoIgnored, ...smallWithout } = small;
    const before = placeFlowLabels(smallWithout, SMALL_POLICY_SIZES);
    expect(escalatedCoveredBy(small, SMALL_POLICY_SIZES, before, 'policy_closed')).toBeGreaterThan(0);
  });

  it('keeps every case-flow ribbon in view whenever it reports a fit', () => {
    for (const [payload, sizes] of [
      [POLICY, POLICY_SIZES],
      [SMALL_POLICY, SMALL_POLICY_SIZES],
    ] as const) {
      for (const width of [640, 656, 700, 768, 900, 1024, 1280]) {
        const input = policyFlowAt(width, payload);
        const placed = placeFlowLabels(input, sizes);
        expect(placed.fit, `fit at ${width}`).toBe('fits');
        for (const [key, run] of Object.entries(visibleRuns(input, sizes, placed))) {
          expect(run, `${key} at ${width}`).toBeGreaterThanOrEqual(MIN_RIBBON_RUN);
        }
        // The labels right of the decision nodes lie across no escalated ribbon at all.
        for (const label of ['auto_cleared', 'policy_closed']) {
          expect(escalatedCoveredBy(input, sizes, placed, label), `${label} at ${width}`).toBe(0);
        }
      }
    }
  });

  it('spreads Closed by analyst policy above the escalated ribbons instead of over them', () => {
    const input = policyFlowAt(640);
    const placed = placeFlowLabels(input, POLICY_SIZES);
    const boxes = placedLabelBoxes(input, POLICY_SIZES, placed);
    const policy = boxes.find((box) => box.key === 'policy_closed')!;
    const auto = boxes.find((box) => box.key === 'auto_cleared')!;
    for (const key of ['escalated>closed', 'escalated>escalated_remaining']) {
      const ribbon = input.ribbons.find((r) => r.key === key)!;
      const under = ribbonSections(ribbon).filter((s) => s.x >= policy.left && s.x <= policy.right);
      expect(under.length).toBeGreaterThan(0);
      expect(policy.bottom + LABEL_GAP).toBeLessThanOrEqual(Math.min(...under.map((s) => s.top)) + 1e-6);
    }
    // Auto-cleared moves up with it, one label and a gap above, never on top of it.
    expect(auto.bottom + LABEL_GAP).toBeLessThanOrEqual(policy.top + 1e-6);
  });

  it('reports a label left across a ribbon as a collision', () => {
    // Without the decision column, nothing moves "Closed by analyst policy" off the
    // escalated ribbons: the placement must refuse it rather than call it a fit.
    const input = { ...policyFlowAt(640), columns: [['closed', 'escalated_remaining']] };
    const placed = placeFlowLabels(input, POLICY_SIZES);
    expect(placed.fit).toBe('collides');
    expect(placed.collisions).toEqual(
      expect.arrayContaining([expect.stringMatching(/^ribbon:policy_closed\+escalated>/)]),
    );
  });
});
