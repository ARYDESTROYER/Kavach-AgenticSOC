/**
 * The whole gallery (one realistic block of every type and chart kind) renders without
 * throwing, without console noise and with no axe violations — in the inline transcript
 * density and in the compact Case Manager density. Realistic transcripts repeat titles
 * (two untitled "Key figures", the same block asked again), so blocks must never be
 * landmarks (axe `landmark-unique`), and no DOM id may be minted twice.
 */
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, expect, it } from 'vitest';

import AnswerBlocks from '../AnswerBlocks';
import { GALLERY_RAW, galleryBlock, galleryBlocks } from '../__fixtures__/gallery';
import { parseBlock } from '../schema';

function duplicateIds(root: HTMLElement): string[] {
  const seen = new Map<string, number>();
  root.querySelectorAll('[id]').forEach((el) => seen.set(el.id, (seen.get(el.id) ?? 0) + 1));
  return Array.from(seen.entries())
    .filter(([, n]) => n > 1)
    .map(([id]) => id);
}

expect.extend(toHaveNoViolations);

describe('answer-blocks gallery', () => {
  it('parses every fixture block without dropping any', () => {
    const blocks = galleryBlocks();
    expect(blocks).toHaveLength(GALLERY_RAW.length);
    expect(blocks.filter((b) => b.type === 'callout' && b.text.startsWith('This part'))).toHaveLength(0);
  });

  it('renders every block type and is axe-clean', async () => {
    const { container } = render(
      <AnswerBlocks blocks={galleryBlocks()} messageId="m1" canAddToReport onAddToReport={() => undefined} inReport={new Set(['kpis'])} />,
    );
    expect(screen.getByTestId('answer-blocks')).toBeInTheDocument();
    for (const t of ['kpi_group', 'chart', 'heatmap', 'table', 'case_list', 'timeline', 'entity', 'mitre', 'query', 'callout', 'citations', 'guide', 'report', 'markdown']) {
      expect(container.querySelector(`[data-block-type="${t}"]`)).not.toBeNull();
    }
    expect(await axe(container)).toHaveNoViolations();
  });

  it('is axe-clean in the compact density too', async () => {
    const { container } = render(<AnswerBlocks blocks={galleryBlocks()} messageId="m1" compact />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('mints no DOM id twice and exposes no landmark per block', () => {
    const { container } = render(<AnswerBlocks blocks={galleryBlocks()} messageId="m1" domId="m1" />);
    expect(duplicateIds(container)).toEqual([]);
    expect(container.querySelectorAll('section, [role="region"]')).toHaveLength(0);
    // Every visual card is a figure named by its heading; a Brief is announced as one.
    expect(screen.getByRole('figure', { name: 'Top hosts by failed logons' })).toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'Brief Shift brief' })).toBeInTheDocument();
  });

  it('stays axe-clean when the same block and two untitled KPI groups repeat across turns', async () => {
    const kpis = (id: string) => parseBlock({ ...(galleryBlock('kpis') as object), id, title: undefined });
    const turn = [galleryBlock('top-hosts'), kpis('k1'), kpis('k2'), galleryBlock('shift-brief')];
    const { container } = render(
      <div>
        <AnswerBlocks blocks={turn} messageId="m1" />
        <AnswerBlocks blocks={turn} messageId="m2" />
      </div>,
    );
    // Two per turn, plus the Brief's own untitled KPI leaf in each turn.
    expect(screen.getAllByRole('figure', { name: 'Key figures' })).toHaveLength(6);
    expect(duplicateIds(container)).toEqual([]);
    expect(await axe(container)).toHaveNoViolations();
  });
});
