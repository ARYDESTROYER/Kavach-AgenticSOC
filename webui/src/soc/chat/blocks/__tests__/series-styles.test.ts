/**
 * Series colours (Round 12 SPEC §7.2 decision 27): a severity breakdown wears the
 * severity axis (Critical red, never a categorical green), in the canonical order the
 * server sends; a chart whose semantic series would share a colour, or that mixes
 * semantic and plain series, keeps the categorical palette as a whole.
 */
import { describe, expect, it } from 'vitest';

import { categorical, token } from '@/soc/components/palette';

import { seriesStyles, usesSemanticColours } from '../charts/series';
import { parseBlock } from '../schema';
import type { ChartBlock } from '../schema';

function chart(series: Array<{ key: string; label: string; semantic?: string }>): ChartBlock {
  const block = parseBlock({
    type: 'chart',
    id: 'b1',
    kind: 'stacked_bar',
    provenance: 'code',
    title: 'Cases by severity and day',
    unit: 'count',
    x: { kind: 'category', values: ['Mon', 'Tue'] },
    series: series.map((s) => ({ ...s, values: [1, 2] })),
  });
  expect(block?.type).toBe('chart');
  return block as ChartBlock;
}

describe('seriesStyles', () => {
  it('colours a severity breakdown by the severity axis, in the order sent', () => {
    const block = chart([
      { key: 's1', label: 'Critical', semantic: 'critical' },
      { key: 's2', label: 'High', semantic: 'high' },
      { key: 's3', label: 'Medium', semantic: 'medium' },
      { key: 's4', label: 'Low', semantic: 'low' },
    ]);
    expect(usesSemanticColours(block)).toBe(true);
    const styles = seriesStyles(block);
    expect(styles.map((s) => s.label)).toEqual(['Critical', 'High', 'Medium', 'Low']);
    expect(styles.map((s) => s.color)).toEqual([
      token('critical'),
      token('high'),
      token('medium'),
      token('low'),
    ]);
    expect(styles.every((s) => s.icon)).toBe(true);
  });

  it('keeps "Other" neutral beside semantic series', () => {
    const styles = seriesStyles(
      chart([
        { key: 's1', label: 'True positive', semantic: 'true_positive' },
        { key: 's2', label: 'False positive', semantic: 'false_positive' },
        { key: 'other', label: 'Other' },
      ]),
    );
    expect(styles.map((s) => s.color)).toEqual([token('critical'), token('info'), token('chart-8')]);
  });

  it('falls back to the categorical palette when two semantic series share a colour', () => {
    // Resolved and closed are both green on the status axis.
    const block = chart([
      { key: 's1', label: 'Resolved', semantic: 'resolved' },
      { key: 's2', label: 'Closed', semantic: 'closed' },
    ]);
    expect(usesSemanticColours(block)).toBe(false);
    expect(seriesStyles(block).map((s) => s.color)).toEqual([categorical(0), categorical(1)]);
  });

  it('falls back to the categorical palette when only some series are semantic', () => {
    const block = chart([
      { key: 's1', label: 'Critical', semantic: 'critical' },
      { key: 's2', label: 'Unrated' },
    ]);
    expect(usesSemanticColours(block)).toBe(false);
    expect(seriesStyles(block).map((s) => s.color)).toEqual([categorical(0), categorical(1)]);
  });
});
