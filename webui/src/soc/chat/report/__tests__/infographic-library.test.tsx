/**
 * The Reports library draws a report saved from an infographic Brief as an infographic
 * (Round 12 follow-up): the server stores the Brief as one item per section, so the
 * screen view re-assembles those items into ONE Brief with the infographic layout (hero
 * KPI row, highlights, 2-up grid) instead of a plain document — every leaf once, every
 * note and source link kept. Print keeps the document layout; other templates are
 * unchanged; a report that holds a whole Brief (briefs do not nest) stays a document.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { Report, ReportItem } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';

vi.mock('@/soc/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/router')>();
  return { ...actual, useNavigateOptional: () => vi.fn() };
});

import { ReportDocument } from '../ReportDocument';
import { INFOGRAPHIC_BRIEF_TITLE, infographicBrief, wantsInfographic } from '../InfographicFindings';
import { buildReportDoc } from '../model';
import { rawBlock, sampleReport } from './fixtures';

expect.extend(toHaveNoViolations);

const SCOPE = { window: 'September 2026', sources: ['Wazuh'], generated_by: 'demo-chat', app_version: '0.1.13', demo: true };

function section(id: string, title: string, blocks: Array<Record<string, unknown>>, extra: Partial<ReportItem> = {}): ReportItem {
  return {
    id,
    kind: 'section',
    block: { title, blocks, truncated: false },
    note: null,
    source: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: `brief.${id}` },
    scope: SCOPE,
    added_at: '2026-10-08T13:00:00Z',
    ...extra,
  };
}

/** A report saved from an infographic Brief: the server's one-item-per-section split. */
function infographicReport(overrides: Partial<Report> = {}): Report {
  return sampleReport({
    id: 'rep-info',
    title: 'September 2026 at a glance',
    template: 'infographic',
    summary: null,
    items: [
      section('s1', 'Key figures', [rawBlock('kpis')]),
      section('s2', 'Volume', [
        { id: 's2-summary', type: 'markdown', provenance: 'ai', text: 'Volume rose in the second half of the month.' },
        rawBlock('alerts-by-source'),
        rawBlock('mtta-trend'),
      ]),
      section('s3', 'Watch', [{ id: 'watch', type: 'callout', provenance: 'ai', tone: 'warning', text: 'Brute force from one /24.' }], {
        note: 'Share with the network team.',
      }),
    ],
    ...overrides,
  });
}

function doc(report: Report) {
  return buildReportDoc(report, { author: 'ana', appVersion: '0.1.13', generatedAt: '2026-10-08T14:00:00Z' });
}

function show(report: Report, mode: 'screen' | 'print' = 'screen', headingShift = 1) {
  return render(
    <TooltipProvider>
      <ReportDocument doc={doc(report)} mode={mode} showTitle={false} headingShift={headingShift} onOpenSource={vi.fn()} />
    </TooltipProvider>,
  );
}

/** Every heading level in document order. */
function outline(root: HTMLElement): number[] {
  return Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => Number(h.tagName.slice(1)));
}

/** The first place the outline skips a level going down (e.g. H2 → H4), or null. */
function skippedLevel(levels: number[]): string | null {
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] > levels[i - 1] + 1) return `H${levels[i - 1]} → H${levels[i]}`;
  }
  return null;
}

describe('infographicBrief', () => {
  it('re-assembles the items as one infographic Brief, one section per item, in order', () => {
    const brief = infographicBrief(doc(infographicReport()));
    expect(brief).not.toBeNull();
    expect(brief).toMatchObject({ type: 'report', layout: 'infographic', template: 'infographic', title: INFOGRAPHIC_BRIEF_TITLE });
    expect(brief!.sections.map((s) => s.heading)).toEqual(['Key figures', 'Volume', 'Watch']);
    // Every leaf of every item, once.
    expect(brief!.sections.map((s) => s.blocks.length)).toEqual([1, 3, 1]);
    expect(brief!.scope).toMatchObject({ window_label: 'September 2026', sources: ['Wazuh'] });
  });

  it('applies only to the infographic template, and never nests a Brief', () => {
    expect(wantsInfographic(doc(infographicReport()))).toBe(true);
    expect(wantsInfographic(doc(sampleReport()))).toBe(false);
    const nested = infographicReport({
      items: [section('s1', 'Key figures', [rawBlock('kpis')]), { ...section('s2', 'Brief', []), kind: 'block', block: rawBlock('shift-brief') }],
    });
    expect(infographicBrief(doc(nested))).toBeNull();
  });
});

describe('ReportDocument — infographic template on screen', () => {
  it('draws the hero KPI row, the highlights and the 2-up grid, with notes and sources below', async () => {
    const view = show(infographicReport());
    const findings = screen.getByRole('region', { name: 'Findings' });
    await waitFor(() => expect(within(findings).getByTestId('infographic')).toBeInTheDocument());
    expect(within(findings).getByTestId('block-report')).toHaveAttribute('data-layout', 'infographic');
    expect(within(findings).getByTestId('infographic-hero')).toBeInTheDocument();
    expect(within(findings).getByTestId('infographic-highlights')).toHaveTextContent('Brute force from one /24.');
    expect(within(findings).getAllByTestId('infographic-grid').length).toBeGreaterThan(0);
    // Not drawn item by item as a document.
    expect(findings.querySelectorAll('[data-report-item]')).toHaveLength(0);
    // Notes and the way back to the source answer are kept.
    expect(within(findings).getByTestId('report-infographic-notes')).toHaveTextContent('3. Watch');
    expect(within(findings).getByTestId('report-infographic-notes')).toHaveTextContent('Analyst note: Share with the network team.');
    expect(within(findings).getAllByRole('button', { name: 'Open source conversation' })).toHaveLength(1);
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('never skips a heading level under the page title (Reports library: Findings is an H2)', async () => {
    const view = show(infographicReport(), 'screen', 0);
    const findings = screen.getByRole('region', { name: 'Findings' });
    await waitFor(() => expect(within(findings).getByTestId('infographic')).toBeInTheDocument());
    const levels = outline(view.container);
    expect(levels[0]).toBe(2); // "Findings"
    expect(levels).toContain(4); // the Brief's title ("At a glance")
    expect(skippedLevel(levels)).toBeNull();
    // The bridge is an H3 for screen readers only; the visible layout is unchanged.
    const bridge = within(findings).getByRole('heading', { level: 3, name: 'Infographic' });
    expect(bridge).toHaveClass('sr-only');
    // Under an H3 "Findings" (a shifted host) no bridge is needed.
    view.unmount();
    const shifted = show(infographicReport(), 'screen', 1);
    await waitFor(() => expect(screen.getByTestId('infographic')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Infographic' })).toBeNull();
    expect(skippedLevel(outline(shifted.container))).toBeNull();
  });

  it('keeps the document layout in print and for every other template', async () => {
    const printed = show(infographicReport(), 'print');
    expect(screen.queryByTestId('report-infographic')).toBeNull();
    expect(printed.container.querySelectorAll('[data-report-item]')).toHaveLength(3);
    printed.unmount();

    show(sampleReport());
    expect(screen.queryByTestId('report-infographic')).toBeNull();
    expect(document.querySelectorAll('[data-report-item]').length).toBeGreaterThan(0);
  });
});
