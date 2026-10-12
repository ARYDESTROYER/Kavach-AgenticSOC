/**
 * Round 12 SYNTHESIS-chat P1-3 (#3): an investigation brief is labelled "Advisory: the
 * case decision is made by policy, not by this brief" wherever it is read, not only in chat:
 * the Reports library (ReportDocument draws the walker's header), Print, and every
 * static export (Markdown, HTML, Word) — the copy most likely to be forwarded. A brief
 * Brief block inside another report carries it too; other templates never do.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { Report } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';

import { INVESTIGATION_BRIEF_ADVISORY, INVESTIGATION_BRIEF_ADVISORY_NOTE } from '../../blocks/format';
import { INVESTIGATION_BRIEF_ADVISORY as RENDERER_LABEL } from '../../blocks/renderers/ReportView';
import { buildReportDoc } from '../model';
import { reportToMarkdown } from '../export/markdown';
import { reportToHtml } from '../export/html';
import { reportToDocx } from '../export/docx';
import { documentNodes, sectionNodes } from '../export/walker';
import { ReportDocument } from '../ReportDocument';
import { NOW, rawBlock, sampleReport } from './fixtures';
import { zipMap } from './zip-reader';

const brief = (overrides: Partial<Report> = {}) =>
  buildReportDoc(sampleReport({ template: 'investigation_brief', ...overrides }), { generatedAt: NOW.toISOString() });

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('investigation brief advisory label', () => {
  it('is one string, shared by the chat renderer and the document walker', () => {
    expect(RENDERER_LABEL).toBe(INVESTIGATION_BRIEF_ADVISORY);
    expect(INVESTIGATION_BRIEF_ADVISORY).toBe('Advisory: the case decision is made by policy, not by this brief');
  });

  it('heads a saved investigation brief in Markdown, HTML and Word, once', () => {
    const md = reportToMarkdown(brief(), { defang: false });
    expect(md).toContain(`> **${INVESTIGATION_BRIEF_ADVISORY}:** ${INVESTIGATION_BRIEF_ADVISORY_NOTE}`);
    expect(count(md, INVESTIGATION_BRIEF_ADVISORY)).toBe(1);
    // Defang never rewrites engine text.
    expect(reportToMarkdown(brief())).toContain(INVESTIGATION_BRIEF_ADVISORY);

    const html = reportToHtml(brief());
    expect(html).toContain(`<b>${INVESTIGATION_BRIEF_ADVISORY}:</b> ${INVESTIGATION_BRIEF_ADVISORY_NOTE}`);

    const docx = zipMap(reportToDocx(brief(), { now: NOW })).get('word/document.xml')!.text;
    expect(docx).toContain(INVESTIGATION_BRIEF_ADVISORY);
    expect(docx).toContain(INVESTIGATION_BRIEF_ADVISORY_NOTE);
  });

  it('is never added to another template', () => {
    for (const template of ['investigation', 'monthly', 'custom'] as const) {
      const doc = buildReportDoc(sampleReport({ template }), { generatedAt: NOW.toISOString() });
      expect(reportToMarkdown(doc, { defang: false })).not.toContain(INVESTIGATION_BRIEF_ADVISORY);
    }
  });

  it('labels an investigation-brief Brief block inside another report', () => {
    const block = { ...rawBlock('shift-brief'), template: 'investigation_brief' };
    const base = sampleReport();
    const report = sampleReport({ items: [{ ...base.items[1], block }], summary: null });
    const nodes = documentNodes(buildReportDoc(report, { generatedAt: NOW.toISOString() }));
    const labels = nodes.filter((n) => n.k === 'callout' && n.label === INVESTIGATION_BRIEF_ADVISORY);
    expect(labels).toHaveLength(1);
  });

  it('shows in the Reports library and in Print (the document header)', () => {
    expect(sectionNodes(brief(), 'header', { screen: true }).some((n) => n.k === 'callout' && n.label === INVESTIGATION_BRIEF_ADVISORY)).toBe(true);
    const { unmount } = render(
      <TooltipProvider>
        <ReportDocument doc={brief()} mode="screen" onOpenSource={() => undefined} />
      </TooltipProvider>,
    );
    expect(screen.getAllByText(new RegExp(INVESTIGATION_BRIEF_ADVISORY.replace(/[()]/g, '\\$&'))).length).toBeGreaterThan(0);
    unmount();
    render(
      <TooltipProvider>
        <ReportDocument doc={brief()} mode="print" defang renderBlocks={() => null} />
      </TooltipProvider>,
    );
    expect(screen.getAllByText(new RegExp(INVESTIGATION_BRIEF_ADVISORY.replace(/[()]/g, '\\$&'))).length).toBeGreaterThan(0);
  });
});
