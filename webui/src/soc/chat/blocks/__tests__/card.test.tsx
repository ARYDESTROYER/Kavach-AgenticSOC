/**
 * The ONE card chrome (SPEC §10.3): title + scope caption + provenance tag, one visible
 * Add to report toggle, and the ⋯ menu — Expand, Show as <view>, Show table, Copy data
 * (TSV, defused, defanged by default), Download CSV/JSON, Copy query and an exact
 * Open-in target. Disclosures (G4 truncation, G5 model-stated) are never menu-only.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const announce = vi.fn();
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));
const copyText = vi.fn(async (_text: string) => true);
vi.mock('@/lib/clipboard', () => ({ copyText: (t: string) => copyText(t), default: (t: string) => copyText(t) }));

import AnswerBlocks from '../AnswerBlocks';
import { galleryBlock } from '../__fixtures__/gallery';
import { parseBlock } from '../schema';
import type { AnswerBlock, ReportBlock } from '../schema';

function show(blocks: AnswerBlock[], props: Partial<React.ComponentProps<typeof AnswerBlocks>> = {}) {
  return render(<AnswerBlocks blocks={blocks} messageId="m1" {...props} />);
}

/** jsdom's Blob has no `.text()`; FileReader is available. */
function readBlob(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(b);
  });
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, index = 0) {
  await user.click(screen.getAllByTestId('block-menu-trigger')[index]);
  return screen.findByRole('menu');
}

beforeEach(() => {
  announce.mockClear();
  copyText.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('header', () => {
  it('shows title, caption, as-of and the provenance tag', () => {
    show([galleryBlock('kpis')]);
    expect(screen.getByRole('heading', { level: 4, name: 'Posture now' })).toBeInTheDocument();
    expect(screen.getByTestId('block-caption')).toHaveTextContent('Last 24h · all sources · as of 2026-10-08 09:12 UTC');
    expect(screen.getByRole('img', { name: /Provenance: Deterministic/ })).toBeInTheDocument();
  });

  it('always discloses truncation as top N of M (G4)', () => {
    show([galleryBlock('top-hosts')]);
    expect(screen.getByTestId('block-truncation')).toHaveTextContent('Showing top 8 of 1,240');
  });

  it('captions model-stated data (G5) but not prose', () => {
    const ai = parseBlock({ ...(galleryBlock('severity-mix') as object), provenance: undefined });
    show([ai, galleryBlock('note')]);
    expect(screen.getAllByTestId('block-ai-caption')).toHaveLength(1);
    expect(screen.getByTestId('block-ai-caption')).toHaveTextContent('Values stated by the model, not measured');
  });

  it('is a figure named by its heading, never a region landmark', () => {
    const { container } = show([galleryBlock('top-hosts')]);
    const fig = screen.getByRole('figure', { name: 'Top hosts by failed logons' });
    expect(fig.tagName).toBe('FIGURE');
    expect(fig.firstElementChild?.tagName).toBe('FIGCAPTION');
    expect(container.querySelector('section')).toBeNull();
  });

  it('shows an untitled indicator mono in its heading and labels a report "Brief"', () => {
    show([galleryBlock('ioc'), galleryBlock('shift-brief')]);
    const heading = screen.getByRole('heading', { level: 4, name: 'Indicator: 203.0.113.14' });
    expect(heading.querySelector('.font-mono')).toHaveTextContent('203.0.113.14');
    expect(screen.getByRole('figure', { name: 'Brief Shift brief' })).toHaveTextContent(/^Brief/);
  });

  it('falls back to a type title and never uses block.id as a DOM id', () => {
    const b = parseBlock({ id: 'evil-id', type: 'citations', provenance: 'code', items: [{ n: 1, kind: 'docs', label: 'Doc' }] });
    const { container } = show([b]);
    expect(screen.getByRole('heading', { name: 'Sources' })).toBeInTheDocument();
    expect(container.querySelector('#evil-id')).toBeNull();
  });
});

describe('add to report', () => {
  it('is one pressed/unpressed toggle that reports the block id', async () => {
    const user = userEvent.setup();
    const add = vi.fn();
    show([galleryBlock('top-hosts'), galleryBlock('kpis')], { canAddToReport: true, onAddToReport: add, inReport: new Set(['kpis']) });
    const [hosts, kpis] = screen.getAllByTestId('block-add-to-report');
    expect(hosts).toHaveAttribute('aria-pressed', 'false');
    expect(hosts).toHaveAccessibleName('Add Top hosts by failed logons to report');
    expect(kpis).toHaveAttribute('aria-pressed', 'true');
    // ONE stable name; the pressed state (not a flipped name) says it is in the report.
    expect(kpis).toHaveAccessibleName('Add Posture now to report');
    await user.click(hosts);
    expect(add).toHaveBeenCalledWith('top-hosts');
  });

  it('is absent without the capability and on prose/notes', () => {
    show([galleryBlock('top-hosts')]);
    expect(screen.queryByTestId('block-add-to-report')).toBeNull();
    show([galleryBlock('note'), galleryBlock('scan-bound')], { canAddToReport: true, onAddToReport: vi.fn() });
    expect(screen.queryAllByTestId('block-add-to-report')).toHaveLength(0);
  });
});

describe('the ⋯ menu', () => {
  it('switches views client-side among the allowed views', async () => {
    const user = userEvent.setup();
    show([galleryBlock('top-hosts')]);
    expect(screen.getByTestId('chart-hbar-list')).toBeInTheDocument();
    const menu = await openMenu(user);
    expect(within(menu).getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(['Horizontal bars', 'Columns']);
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Columns' }));
    expect(screen.getByTestId('chart-bar')).toBeInTheDocument();
    expect(announce).toHaveBeenCalledWith('Showing as Columns');
  });

  it('toggles a table view of the same data and back', async () => {
    const user = userEvent.setup();
    show([galleryBlock('alerts-by-source')]);
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Show table' }));
    expect(screen.getByTestId('block-table')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-stacked_bar')).toBeNull();
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Show chart' }));
    expect(screen.getByTestId('chart-stacked_bar')).toBeInTheDocument();
  });

  it('copies TSV data, defanged and formula-defused by default; raw when unticked', async () => {
    const user = userEvent.setup();
    show([galleryBlock('signins')]);
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Copy data' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    const tsv = copyText.mock.calls[0][0];
    expect(tsv.split('\n')[0]).toBe('Time\tUser\tSource IP\tRule\tSeverity\tAttempts\tCase\tTechnique\tNotes');
    expect(tsv).toContain(`'=HYPERLINK("hxxp://evil[.]example","click")`);
    expect(tsv).toContain('203[.]0[.]113[.]10');
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Copied 12 rows, indicators defanged'));

    const menu = await openMenu(user);
    const defang = within(menu).getByRole('menuitemcheckbox', { name: 'Defang indicators when copying' });
    expect(defang).toHaveAttribute('aria-checked', 'true');
    await user.click(defang);
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Copy data' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(2));
    expect(copyText.mock.calls[1][0]).toContain('203.0.113.10');
  });

  it('downloads CSV and JSON through an object URL', async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    const names: string[] = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((b: Blob) => {
        blobs.push(b);
        return 'blob:x';
      }),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    show([galleryBlock('top-hosts')]);
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Download CSV' }));
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Download JSON' }));
    expect(names[0]).toMatch(/^agentic-soc-top-hosts-by-failed-logons-\d{8}-\d{4}Z\.csv$/);
    expect(names[1]).toMatch(/\.json$/);
    expect(blobs[0].type).toBe('text/csv;charset=utf-8');
    expect(await readBlob(blobs[0])).toContain('"web-01.corp.example",1840');
    expect(JSON.parse(await readBlob(blobs[1])).block.id).toBe('top-hosts');
  });

  it('copies a query block, or a lookup step query through queryForStep', async () => {
    const user = userEvent.setup();
    const stepped = parseBlock({ ...(galleryBlock('top-hosts') as object), from_step: 2 });
    show([galleryBlock('lookup-query'), stepped], { queryForStep: (n) => (n === 2 ? 'host.name:*' : null) });
    await user.click(within(await openMenu(user, 0)).getByRole('menuitem', { name: 'Copy query' }));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith(expect.stringContaining('FROM all-logs-*')));
    await user.click(within(await openMenu(user, 1)).getByRole('menuitem', { name: 'Copy query' }));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('host.name:*'));
  });

  it('offers Open in … only for an exact single-case target', async () => {
    const user = userEvent.setup();
    const nav = vi.fn();
    const one = parseBlock({ ...(galleryBlock('open-cases') as object), items: [{ case_id: 'case-7', title: 'One' }] });
    show([galleryBlock('open-cases'), one], { onNavigate: nav });
    expect(within(await openMenu(user, 0)).queryByRole('menuitem', { name: /Open in/ })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(within(await openMenu(user, 1)).getByRole('menuitem', { name: 'Open in Case Manager' }));
    expect(nav).toHaveBeenCalledWith({ page: 'case_manager', opts: { caseId: 'case-7' } });
  });

  it('expands into a wide sheet with the same view', async () => {
    const user = userEvent.setup();
    show([galleryBlock('signins')]);
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Expand' }));
    const sheet = await screen.findByRole('dialog', { name: 'Recent sign-in failures' });
    // The expanded table pages every row instead of the 10-row inline cut.
    expect(within(sheet).getAllByRole('row')).toHaveLength(13);
  });

  it('in the sheet, one Esc closes only the chart tooltip (topmost layer), the next the sheet', async () => {
    const user = userEvent.setup();
    show([galleryBlock('severity-mix')]);
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Expand' }));
    const sheet = await screen.findByRole('dialog', { name: 'Open cases by severity' });
    const plot = within(sheet).getByTestId('chart-bar-plot');
    act(() => plot.focus());
    // Portalled INTO the sheet's layer, so it stays hoverable under the modal.
    expect(within(sheet).getByTestId('chart-bar-tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('chart-bar-tooltip')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Open cases by severity' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('resilience (G9)', () => {
  it('replaces a block whose renderer throws with the quiet fallback, keeping the rest', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { ...(galleryBlock('top-hosts') as object), series: null } as unknown as AnswerBlock;
    show([broken, galleryBlock('kpis')]);
    expect(screen.getByTestId('block-fallback')).toHaveTextContent('This part of the answer could not be displayed');
    expect(screen.getByTestId('block-kpis')).toBeInTheDocument();
  });

  it("keeps the failing block's own plain fallback_text (G9)", () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { ...(galleryBlock('top-hosts') as object), series: null, fallback_text: 'Top host: web-01 (1,840)' } as unknown as AnswerBlock;
    show([broken]);
    expect(screen.getByTestId('block-fallback')).toHaveTextContent('Top host: web-01 (1,840)');
  });

  it('degrades one broken report leaf alone, keeping the rest of the Brief', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const brief = galleryBlock('shift-brief') as ReportBlock;
    const sections = brief.sections.map((sec, si) =>
      si === 1 ? { ...sec, blocks: [{ ...sec.blocks[0], items: null, fallback_text: 'Alerts 6,400' } as unknown as typeof sec.blocks[0]] } : sec,
    );
    show([{ ...brief, sections }]);
    expect(screen.getByTestId('block-report')).toBeInTheDocument();
    expect(screen.getByTestId('block-fallback')).toHaveTextContent('Alerts 6,400');
    expect(screen.getByRole('heading', { name: 'Watch next shift' })).toBeInTheDocument();
    expect(screen.getByText('Keep an eye on 203.0.113.0/24.')).toBeInTheDocument();
  });

  it('anchors citations once per message, even with a second citations block in a report', () => {
    const brief = galleryBlock('shift-brief') as ReportBlock;
    const cites = galleryBlock('sources');
    const withCites = { ...brief, sections: [...brief.sections, { id: 'refs', heading: 'References', blocks: [cites as never] }] };
    const { container } = show([cites, withCites], { domId: 'msg1' });
    expect(container.querySelectorAll('#msg1-cite-1')).toHaveLength(1);
    // The anchor belongs to the top-level block, which the answer's [n] markers follow.
    expect(screen.getAllByTestId('block-citations')[0].querySelector('#msg1-cite-1')).not.toBeNull();
    // With only the report leaf, the leaf owns the anchors.
    const r2 = render(<AnswerBlocks blocks={[withCites]} messageId="m2" domId="msg2" />);
    expect(r2.container.querySelectorAll('#msg2-cite-1')).toHaveLength(1);
  });

  it('renders nothing for an empty or non-array list', () => {
    const { container } = show([]);
    expect(container).toBeEmptyDOMElement();
    const r2 = render(<AnswerBlocks blocks={null as unknown as AnswerBlock[]} messageId="m" />);
    expect(r2.container).toBeEmptyDOMElement();
  });

  it('lays consecutive entity blocks out as a responsive two-column grid', () => {
    const second = parseBlock({ ...(galleryBlock('ioc') as object), id: 'ioc2', entity: { kind: 'domain', value: 'evil.example' } });
    const { container } = show([galleryBlock('ioc'), second]);
    expect(container.querySelector('.\\@container > .grid')?.children).toHaveLength(2);
  });
});
