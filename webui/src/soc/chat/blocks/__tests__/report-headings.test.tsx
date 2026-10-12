/**
 * A Brief section never says its heading twice (Round 12 final review, L4).
 *
 * The performance report a "Create a report of lifetime performance" answer builds has
 * sections whose only card is titled like the section ("Response times" over a card
 * titled "Response times", "AI cost" over "AI cost"). The infographic layout already
 * handled it; the DOCUMENT layout (the default, and the one model-written Briefs use)
 * and every static export (PDF, Word, Markdown, HTML) printed the pair back to back.
 * One shared rule (`report-headings.ts`) now drives all three: on screen the card keeps
 * its visible title and the heading stays for assistive tech and the contents jump; in an
 * export the section heading stays and the card's repeated title is left out.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => vi.fn() }));

import AnswerBlocks from '../AnswerBlocks';
import { headingRepeatsLeaf } from '../report-headings';
import { headingRepeatsLeaf as infographicRule } from '../renderers/InfographicView';
import { calloutTitle } from '../renderers/SimpleViews';
import { calloutTitle as sharedCalloutTitle } from '../report-headings';
import { parseBlock } from '../schema';
import type { ReportBlock } from '../schema';
import { blockNodes } from '../../report/export/walker';
import { nodesToMarkdown } from '../../report/export/markdown';

const kpis = (id: string, title: string, label: string, value: number, unit: string) => ({
  id,
  type: 'kpi_group',
  title,
  provenance: 'code',
  artifact_kind: 'kpis',
  allowed_views: ['kpi_group', 'table'],
  items: [{ key: id, label, value, unit }],
});

/** The demo planner's lifetime performance report, in the document layout. */
const PERFORMANCE = parseBlock({
  id: 'perf',
  type: 'report',
  provenance: 'code',
  artifact_kind: null,
  title: 'Lifetime performance report',
  template: 'executive',
  scope: { window_label: 'All time', sources: [], generated_at: '2026-10-12T08:00:00Z' },
  sections: [
    { id: 'summary', heading: 'Summary', blocks: [{ id: 'md', type: 'markdown', provenance: 'code', text: '**45 cases** over all time.' }] },
    { id: 'times', heading: 'Response times', blocks: [kpis('mttr', 'Response times', 'MTTR (median)', 42, 'minutes')] },
    { id: 'cost', heading: 'AI cost', blocks: [kpis('spend', 'AI cost', 'Spend', 1.25, 'usd')] },
    // A summary between the heading and the card keeps the heading visible.
    { id: 'noise', heading: 'Noise reduction', summary: 'Alerts folded into cases.', blocks: [kpis('noise', 'Noise reduction', 'Reduction', 81, 'percent')] },
    // Two different titles: nothing repeats.
    { id: 'quality', heading: 'Quality', blocks: [kpis('fp', 'False-positive rate', 'FP rate', 12, 'percent')] },
  ],
}) as ReportBlock;

describe('the document layout', () => {
  it('says "AI cost" and "Response times" once each, keeping the card title and the group name', () => {
    render(<AnswerBlocks blocks={[PERFORMANCE]} messageId="m1" />);
    expect(screen.getByTestId('block-report')).toHaveAttribute('data-layout', 'document');
    for (const name of ['Response times', 'AI cost']) {
      const heading = screen.getByRole('heading', { level: 5, name });
      expect(heading).toHaveClass('sr-only');
      expect(heading).toHaveAttribute('data-repeats-leaf', 'true');
      const group = screen.getByRole('group', { name });
      expect(within(group).getByRole('heading', { level: 6, name })).not.toHaveClass('sr-only');
      // On screen the words appear exactly once (the card's title).
      const visible = group.cloneNode(true) as HTMLElement;
      visible.querySelectorAll('.sr-only').forEach((n) => n.remove());
      expect(visible.textContent?.match(new RegExp(name, 'g'))).toHaveLength(1);
    }
  });

  it('keeps a heading visible when a summary stands between it and the card, or the titles differ', () => {
    render(<AnswerBlocks blocks={[PERFORMANCE]} messageId="m1" />);
    for (const name of ['Noise reduction', 'Quality', 'Summary']) {
      const heading = screen.getByRole('heading', { level: 5, name });
      expect(heading).not.toHaveClass('sr-only');
      expect(heading).not.toHaveAttribute('data-repeats-leaf');
    }
  });

  it('keeps the contents list naming every section', () => {
    render(<AnswerBlocks blocks={[PERFORMANCE]} messageId="m1" />);
    const contents = screen.getByRole('button', { name: /Contents \(5 sections\)/ });
    expect(contents).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI cost' })).toBeInTheDocument();
  });
});

describe('the static exports', () => {
  it('print the section heading once and leave the repeated card title out', () => {
    const md = nodesToMarkdown(blockNodes([PERFORMANCE], { defang: false }, 2));
    for (const name of ['Response times', 'AI cost']) {
      expect(md.match(new RegExp(`^#+ ${name}$`, 'gm'))).toHaveLength(1);
    }
    // The figures themselves are all still there.
    expect(md).toContain('MTTR (median)');
    expect(md).toContain('Spend');
    // A summary between them, or a different title, keeps both headings.
    expect(md.match(/^#+ Noise reduction$/gm)).toHaveLength(2);
    expect(md).toMatch(/^#+ Quality$/m);
    expect(md).toMatch(/^#+ False-positive rate$/m);
  });
});

describe('one rule everywhere', () => {
  it('is the same function in the infographic layout, the document layout and the exports', () => {
    expect(infographicRule).toBe(headingRepeatsLeaf);
    expect(calloutTitle).toBe(sharedCalloutTitle);
    const [, times, , noise] = PERFORMANCE.sections;
    expect(headingRepeatsLeaf(times.heading, times.blocks, times.summary)).toBe(true);
    expect(headingRepeatsLeaf(noise.heading, noise.blocks, noise.summary)).toBe(false);
  });
});
