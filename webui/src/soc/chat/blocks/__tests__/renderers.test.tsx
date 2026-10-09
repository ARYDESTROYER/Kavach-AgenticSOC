/**
 * Non-chart renderers (BLOCKS.md §5.3): typed table cells with client sort, ≤ 10 inline
 * rows and a View-all dialog; case links that navigate through the router; KPI tiles with
 * bounds, nulls, gauges, trends and refs; timeline, entity, MITRE (constructed ATT&CK
 * links only), query, callout roles, citation anchors, guide refs, markdown and the Brief.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => () => undefined }));

import AnswerBlocks from '../AnswerBlocks';
import { galleryBlock } from '../__fixtures__/gallery';
import { attackUrl } from '../renderers/MitreView';
import { sortRows, visibleColumns } from '../renderers/TableView';
import { parseBlock } from '../schema';
import type { AnswerBlock, EntityBlock, InternalRef, TableBlock } from '../schema';

function show(block: AnswerBlock, props: Partial<React.ComponentProps<typeof AnswerBlocks>> = {}) {
  return render(<AnswerBlocks blocks={[block]} messageId="m1" {...props} />);
}

describe('table', () => {
  it('hides all-blank columns and shows ≤ 10 rows inline with a View-all dialog', () => {
    show(galleryBlock('signins'));
    const table = within(screen.getByTestId('block-table')).getAllByRole('table')[0];
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.join('|')).not.toContain('Notes');
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    fireEvent.click(screen.getByRole('button', { name: 'View all 12 rows' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('row')).toHaveLength(13);
  });

  it('sorts by the declared column (nulls last) and re-sorts on a header click', () => {
    const block = galleryBlock('signins') as TableBlock;
    const order = sortRows(block.rows, 5, 'desc');
    expect(block.rows[order[order.length - 1]][5]).toBeNull();
    expect(visibleColumns(block)).not.toContain(8);
    show(block);
    const table = within(screen.getByTestId('block-table')).getAllByRole('table')[0];
    const attempts = within(table).getByRole('columnheader', { name: /Attempts/ });
    expect(attempts).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(within(attempts).getByRole('button'));
    expect(attempts).toHaveAttribute('aria-sort', 'ascending');
  });

  it('types cells: badges, UTC time, mono untrusted text, case links, literal formulas', () => {
    const nav = vi.fn();
    const { container } = show(galleryBlock('signins'), { onNavigate: nav });
    expect(screen.getAllByText(/^2026-10-0[78] \d\d:\d\d UTC$/).length).toBeGreaterThan(0);
    expect(container.querySelector('code')).toHaveTextContent(/svc-backup|corp\.example/);
    expect(screen.getAllByText('=HYPERLINK("http://evil.example","click")')[0].tagName).toBe('SPAN');
    const caseLink = screen.getAllByRole('link', { name: /case-10/ })[0];
    expect(caseLink.getAttribute('href')).toMatch(/^#\/case_manager\?caseId=case-10\d\d$/);
    fireEvent.click(caseLink);
    expect(nav).toHaveBeenCalledWith(expect.objectContaining({ page: 'case_manager' }));
    // No untrusted value ever becomes a link.
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs.every((h) => h?.startsWith('#/case_manager'))).toBe(true);
  });
});

describe('case list', () => {
  it('links every title to the exact case and shows its badges', () => {
    const nav = vi.fn();
    show(galleryBlock('open-cases'), { onNavigate: nav });
    const link = screen.getByRole('link', { name: 'Suspicious PowerShell on web-01' });
    expect(link).toHaveAttribute('href', '#/case_manager?caseId=case-1049');
    fireEvent.click(link);
    expect(nav).toHaveBeenCalledWith({ page: 'case_manager', opts: { caseId: 'case-1049' } });
    expect(screen.getByText('Escalated')).toBeInTheDocument();
  });

  it('loads the hover preview only once a pointer arrives', async () => {
    show(galleryBlock('open-cases'));
    const list = screen.getByTestId('block-case-list');
    await act(async () => {
      fireEvent.pointerEnter(list.parentElement!);
    });
    // Wait for the SWAP, not just for a link: the plain link is there before the hover
    // card loads, so `findByRole` can return it and the lazy module (slow under a loaded
    // full-suite run) can then replace it before the assertion. The armed link is the
    // hover card's trigger (Radix marks it with `data-state`); the wait is generous.
    const name = 'Brute force against vpn-gw-2';
    await waitFor(() => expect(screen.getByRole('link', { name })).toHaveAttribute('data-state'), { timeout: 10_000 });
    // The link survives the lazy swap and is still a single link per case.
    expect(screen.getAllByRole('link', { name })).toHaveLength(1);
  }, 15_000);
});

describe('kpi group', () => {
  it('formats values, marks a lower bound, and says "not measured" for null', () => {
    show(galleryBlock('kpis'));
    const kpis = screen.getByTestId('block-kpis');
    expect(kpis).toHaveTextContent('12,840');
    expect(kpis).toHaveTextContent('≥43');
    expect(kpis).toHaveTextContent('at least');
    expect(kpis).toHaveTextContent('18%');
    expect(kpis).toHaveTextContent('1.5 h');
    expect(kpis).toHaveTextContent('not measured');
    expect(kpis).toHaveTextContent('+1,960 vs prev 24h');
  });

  it('draws a gauge for display=gauge and decorative trend columns with a text twin', () => {
    const { container } = show(galleryBlock('kpis'));
    expect(container.querySelector('[data-testid="kpi-chat-0-4"]')).toHaveTextContent('62');
    expect(container.querySelector('[data-testid="trend-columns"]')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText(/Over last 24h, 2h buckets: first 420, peak 700, latest 530; 11 of 12 buckets measured\./)).toBeInTheDocument();
  });

  it('reads deltas in the change\'s own terms: points for rates and scores', () => {
    const b = parseBlock({
      id: 'd',
      type: 'kpi_group',
      provenance: 'code',
      artifact_kind: 'kpis',
      allowed_views: ['kpi_group', 'table'],
      items: [
        { key: 'fp', label: 'FP rate', value: 21, unit: 'percent', delta: { value: 3.2, period_label: 'vs last week', good_direction: 'down' } },
        { key: 'r', label: 'Precision', value: 0.9, unit: 'ratio', delta: { value: -0.05, period_label: 'vs last week', good_direction: 'up' } },
        { key: 's', label: 'Risk index', value: 62, unit: 'score', delta: { value: 5, period_label: 'vs yesterday', good_direction: 'down' } },
      ],
    });
    show(b);
    const kpis = screen.getByTestId('block-kpis');
    expect(kpis).toHaveTextContent('+3.2 pp vs last week');
    expect(kpis).toHaveTextContent('−5 pp vs last week');
    expect(kpis).toHaveTextContent('+5 vs yesterday');
    expect(kpis).not.toHaveTextContent('/100 vs');
    // The strip is a list with one item per figure.
    expect(within(kpis).getAllByRole('listitem')).toHaveLength(3);
  });

  it('renders a KPI caption in the sans muted caption style, and a zero-minute median in minutes (D7, D8)', () => {
    show(
      parseBlock({
        id: 'cap',
        type: 'kpi_group',
        provenance: 'code',
        artifact_kind: 'kpis',
        items: [
          { key: 'open', label: 'Open cases', value: 4, unit: 'count', context: 'not windowed' },
          { key: 'mttr', label: 'MTTR (median)', value: 0, unit: 'minutes', context: 'of 1 queried' },
        ],
      }),
    );
    const caption = screen.getByText('not windowed');
    expect(caption).toHaveClass('font-sans');
    expect(caption).not.toHaveClass('font-mono');
    expect(screen.getByTestId('block-kpis')).toHaveTextContent('0 min');
    expect(screen.getByTestId('block-kpis')).not.toHaveTextContent('0 ms');
  });

  it('closes the frame around a partial last row and says "no change" for a zero delta (no rising arrow)', () => {
    show(
      parseBlock({
        id: 'flat',
        type: 'kpi_group',
        provenance: 'code',
        artifact_kind: 'kpis',
        items: [
          { key: 'nh', label: 'Needs a human', value: 0, unit: 'count', delta: { value: 0, period_label: 'vs previous window', good_direction: 'down' } },
          { key: 'sla', label: 'SLA breached', value: 10, unit: 'count', delta: { value: 2, period_label: 'vs previous window', good_direction: 'down' } },
        ],
      }),
    );
    // The frame is the wrapper's own four-sided border; cells only draw inner hairlines.
    const frame = screen.getByTestId('block-kpis-frame');
    expect(frame).toHaveClass('border', 'rounded-md', 'overflow-hidden');
    expect(within(frame).getByRole('list')).toHaveClass('-mr-px', '-mb-px');
    const kpis = screen.getByTestId('block-kpis');
    expect(kpis).toHaveTextContent('no change vs previous window');
    expect(within(kpis).getByRole('img', { name: 'no change vs previous window' }).querySelector('svg')).toBeNull();
    expect(within(kpis).getByRole('img', { name: /^changed up by \+2 vs previous window, worse$/ })).toBeInTheDocument();
  });

  it('makes a tile with a ref a navigation button', () => {
    const nav = vi.fn();
    show(galleryBlock('kpis'), { onNavigate: nav });
    fireEvent.click(screen.getByRole('button', { name: /Open cases/ }));
    expect(nav).toHaveBeenCalledWith({ page: 'cases', opts: { status: 'open' } });
  });
});

describe('heatmap labels', () => {
  it('draws axis titles and gives each thinned column label the span up to the next', () => {
    show(galleryBlock('logon-heatmap'));
    expect(screen.getByTestId('heatmap-x-label')).toHaveTextContent('Hour');
    expect(screen.getByTestId('heatmap-y-label')).toHaveTextContent('Day');
    const ticks = screen.getAllByTestId('heatmap-x-tick');
    expect(ticks[0]).toHaveTextContent('00');
    // Every labelled span is at least as wide as one cell times the thinning step.
    const widths = ticks.map((t) => parseFloat((t as HTMLElement).style.width));
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(24);
  });

  it.each([390, 560])('keeps 2-character hour labels readable at 48 columns and %ipx', (px) => {
    // jsdom has no layout: report the embed width the chart measures.
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(px);
    try {
      const hours = Array.from({ length: 48 }, (_, i) => String(i % 24).padStart(2, '0'));
      const b = parseBlock({
        id: 'hw',
        type: 'heatmap',
        provenance: 'source',
        artifact_kind: 'heatmap',
        allowed_views: ['heatmap', 'table'],
        unit: 'count',
        x: { values: hours },
        y: { values: ['Mon', 'Tue'] },
        cells: [hours.map((_, i) => i), hours.map((_, i) => 48 - i)],
      });
      show(b);
      const ticks = screen.getAllByTestId('heatmap-x-tick');
      expect(ticks.length).toBeGreaterThan(1);
      const cellW = (px - 30) / 48;
      expect(cellW).toBeLessThan(13.2); // one cell alone could not hold "00" (2 × 6.6 px)
      // Each label owns the columns up to the next label: ≥ 24 px, except a short last one.
      const widths = ticks.map((t) => parseFloat((t as HTMLElement).style.width));
      expect(widths.slice(0, -1).every((w) => w >= 24)).toBe(true);
      // Forced colours drop the ramp: cells wide enough carry their legend step (1–5),
      // shown only under `forced-colors: active`.
      const digits = document.querySelectorAll('[data-state="measured"] > .forced-colors\\:inline');
      if (cellW >= 10) {
        expect(digits.length).toBeGreaterThan(0);
        expect(Array.from(digits).every((d) => /^[1-5]$/.test(d.textContent ?? ''))).toBe(true);
      } else {
        expect(digits).toHaveLength(0);
      }
    } finally {
      width.mockRestore();
    }
  });
});

describe('timeline', () => {
  it('is an ordered list of <time> items with day dividers, fenced untrusted detail and refs', () => {
    const nav = vi.fn();
    const { container } = show(galleryBlock('incident-timeline'), { onNavigate: nav });
    const list = container.querySelector('ol')!;
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0].querySelector('time')).toHaveAttribute('datetime', '2026-10-07T23:58:00Z');
    expect(screen.getByText('Oct 7 (UTC)')).toBeInTheDocument();
    expect(screen.getByText('Oct 8 (UTC)')).toBeInTheDocument();
    expect(container.querySelector('pre')).toHaveTextContent('rule 5712');
    fireEvent.click(screen.getByRole('link', { name: 'Open ›' }));
    expect(nav).toHaveBeenCalledWith({ page: 'case_manager', opts: { caseId: 'case-1052' } });
  });
});

describe('entity', () => {
  it('renders only attacker-derived facts mono; product values are sans (G7, D7)', () => {
    // Even on a block marked untrusted, a fact's mono follows the per-fact flag.
    show({ ...(galleryBlock('ioc') as EntityBlock), untrusted: true });
    expect(screen.getByText('scan-14.example.net')).toHaveClass('font-mono');
    expect(screen.getByText('NL')).not.toHaveClass('font-mono');
  });

  it('keeps a reputation note mono on an untrusted block (third-party tags), sans otherwise', () => {
    const { unmount } = show({ ...(galleryBlock('ioc') as EntityBlock), untrusted: true });
    expect(screen.getByText('314 reports in 30 days')).toHaveClass('font-mono');
    expect(screen.getByText('314 reports in 30 days')).toHaveClass('text-muted-foreground');
    unmount();
    show({ ...(galleryBlock('ioc') as EntityBlock), untrusted: false });
    expect(screen.getByText('314 reports in 30 days')).not.toHaveClass('font-mono');
    expect(screen.getByText('314 reports in 30 days')).toHaveClass('text-muted-foreground');
  });

  it('shows the indicator verbatim, the risk gauge, reputation and navigation', () => {
    const { container } = show(galleryBlock('ioc'));
    expect(container.querySelector('code')).toHaveTextContent('203.0.113.14');
    expect(screen.getByText('Malicious')).toBeInTheDocument();
    expect(screen.getByText('score 92')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Investigate/ })).toHaveAttribute('href', '#/investigate');
    expect(screen.getByRole('link', { name: 'Brute force against vpn-gw-2' })).toHaveAttribute(
      'href',
      '#/case_manager?caseId=case-1052',
    );
    expect(screen.getByRole('button', { name: 'Copy value' })).toBeInTheDocument();
  });
});

describe('mitre', () => {
  it('constructs ATT&CK links only from validated ids', () => {
    expect(attackUrl('T1059.001')).toBe('https://attack.mitre.org/techniques/T1059/001/');
    expect(attackUrl('T1021')).toBe('https://attack.mitre.org/techniques/T1021/');
    expect(attackUrl('javascript:alert(1)')).toBeNull();
    expect(attackUrl('T1059/../../evil')).toBeNull();
  });

  it('draws counts as a heatmap and lists uncounted techniques (never as 0)', () => {
    show(galleryBlock('attack-coverage'));
    expect(screen.getByTestId('block-mitre-heatmap')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /T1021 Remote Services/ });
    expect(link).toHaveAttribute('href', 'https://attack.mitre.org/techniques/T1021/');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('groups uncounted techniques by tactic as chips', () => {
    show(galleryBlock('attack-mapped'));
    expect(screen.getByTestId('block-mitre-chips')).toHaveTextContent('Credential Access');
    expect(screen.getByRole('link', { name: /T1110\.003/ })).toHaveAttribute('href', 'https://attack.mitre.org/techniques/T1110/003/');
  });
});

describe('query, callout, citations, guide, markdown', () => {
  it('captions the query and keeps it as code', () => {
    show(galleryBlock('lookup-query'));
    expect(screen.getByTestId('block-query')).toHaveTextContent('ES|QL · Primary · 1,240 hits');
    expect(screen.getByTestId('block-query').querySelector('code')).toHaveTextContent('FROM all-logs-*');
  });

  it('renders every callout tone as a note, never a chat-local live region (SPEC §10.9)', () => {
    const { container, rerender } = show(galleryBlock('scan-bound'));
    expect(screen.getByTestId('block-callout')).toHaveAttribute('role', 'note');
    expect(screen.getByTestId('block-callout')).toHaveAttribute('data-tone', 'warning');
    for (const tone of ['info', 'success', 'critical'] as const) {
      const b = parseBlock({ id: tone, type: 'callout', provenance: 'code', tone, text: 'FYI' });
      rerender(<AnswerBlocks blocks={[b]} messageId="m1" />);
      expect(screen.getByTestId('block-callout')).toHaveAttribute('role', 'note');
    }
    expect(container.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });

  it('renders the G9 fallback with its plain fallback text', () => {
    const b = parseBlock({ id: 'x', type: 'sankey', fallback_text: 'Top host: web-01 (1,840)' });
    show(b);
    const fb = screen.getByTestId('block-fallback');
    expect(fb).toHaveTextContent('This part of the answer could not be displayed');
    expect(fb).toHaveTextContent('Top host: web-01 (1,840)');
  });

  it('renders a retention stub as "Expired from saved history"', () => {
    const b = parseBlock({ id: 'e', type: 'callout', provenance: 'code', tone: 'info', title: 'Top hosts', text: 'x', expired: { type: 'chart', artifact_kind: 'categories' } });
    show(b);
    expect(screen.getByTestId('block-expired')).toHaveTextContent('Expired from saved history');
  });

  it('anchors citations in-message and never links log snippets', () => {
    const { container } = show(galleryBlock('sources'), { domId: 'msg-7' });
    expect(container.querySelector('#msg-7-cite-1')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Chat in the Help Center' })).toHaveAttribute('href', '/docs/0.1/analyst/chat/');
    const log = container.querySelector('#msg-7-cite-3')!;
    expect(log.querySelector('a')).toBeNull();
    expect(log.querySelector('pre')).toHaveTextContent('Failed password for root');
  });

  it('builds guide links only from validated refs (Settings deep link included)', () => {
    show(galleryBlock('howto'));
    expect(screen.getByRole('link', { name: 'Open Settings › Sources' })).toHaveAttribute('href', '#/settings?s=sources');
    expect(screen.getByRole('link', { name: 'Read: Sources in the Help Center' })).toHaveAttribute('href', '/docs/0.1/admin/sources/');
  });

  it('prefixes a Help Center link with "Read:" exactly once, for plain and stored titles (D1)', () => {
    const guide = (label: string) =>
      parseBlock({
        id: 'g',
        type: 'guide',
        provenance: 'code',
        artifact_kind: 'guide',
        steps: [],
        links: [{ label, ref: { doc: '/docs/0.1/admin/sources/' } }],
      });
    const { unmount } = show(guide('Pull sources › Supported connectors'));
    expect(screen.getByRole('link', { name: /Pull sources › Supported connectors/ })).toHaveTextContent(
      /^Read: Pull sources › Supported connectors$/,
    );
    unmount();
    // An answer saved before the server stopped prefixing.
    show(guide('Read: Pull sources › Supported connectors'));
    expect(screen.getByRole('link', { name: /Pull sources › Supported connectors/ })).toHaveTextContent(
      /^Read: Pull sources › Supported connectors$/,
    );
  });

  it('renders markdown with the host renderer or the safe built-in', () => {
    const block = galleryBlock('note');
    const { rerender } = show(block);
    expect(screen.getByTestId('block-markdown').querySelector('strong')).toHaveTextContent('18%');
    rerender(<AnswerBlocks blocks={[block]} messageId="m1" renderMarkdown={(t) => <p data-testid="host-md">{t.length}</p>} />);
    expect(screen.getByTestId('host-md')).toBeInTheDocument();
  });
});

describe('report (Brief)', () => {
  it('shows scope, provenance chips, a contents list and every section', () => {
    show(galleryBlock('shift-brief'), { domId: 'm9' });
    const report = screen.getByTestId('block-report');
    expect(screen.getByText(/Window: last 12h · Sources: Wazuh, Elastic · Generated 2026-10-08 09:15 UTC/)).toBeInTheDocument();
    expect(within(report).getByTestId('report-provenance')).toHaveTextContent('1 measured');
    expect(within(report).getByTestId('report-provenance')).toHaveTextContent('0 AI-stated');
    expect(within(report).getAllByRole('heading', { level: 5 }).map((h) => h.textContent)).toEqual([
      'Summary',
      'Numbers',
      'Watch next shift',
    ]);
    const toc = screen.getByRole('button', { name: /Contents \(3 sections\)/ });
    expect(toc).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toc);
    fireEvent.click(screen.getByRole('button', { name: 'Watch next shift' }));
    expect(document.activeElement).toHaveTextContent('Watch next shift');
    // Leaves inside the report never get their own Add to report.
    expect(report.querySelector('[data-testid="block-add-to-report"]')).toBeNull();
  });
});

describe('navigation defaults', () => {
  it('falls back to the router (a no-op outside a RouterProvider) without crashing', () => {
    show(galleryBlock('open-cases'));
    fireEvent.click(screen.getByRole('link', { name: 'Suspicious PowerShell on web-01' }));
    expect(screen.getByTestId('block-case-list')).toBeInTheDocument();
  });

  it('keeps modifier clicks as plain links (open in new tab)', () => {
    const nav = vi.fn<[InternalRef], void>();
    show(galleryBlock('open-cases'), { onNavigate: nav });
    fireEvent.click(screen.getByRole('link', { name: 'Suspicious PowerShell on web-01' }), { ctrlKey: true });
    expect(nav).not.toHaveBeenCalled();
  });
});
