/**
 * Panel and SectionTitle (Round 14, SPEC §4.9.1 and §4.9.2, operator choice C7 option 1).
 *
 * The Overview's module grammar as one primitive: the tinted borderless `.surface-panel`,
 * the Overview's padding, and its instrument title row. jsdom has no layout, so these pin
 * structure, classes and semantics; the measured gutters are live-harness checks.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, expect, it } from 'vitest';

import {
  DESIGN_SYSTEM_CATALOG,
  Panel,
  PANEL_GAP,
  PANEL_PADDING,
  PANEL_PADDING_X,
  SectionTitle,
} from '@/design-system';

expect.extend(toHaveNoViolations);

describe('Panel', () => {
  it('is the tinted panel with the Overview padding, a labelled region named by its h2', () => {
    render(
      <Panel title="Open cases" data-testid="p">
        body
      </Panel>,
    );
    const region = screen.getByRole('region', { name: 'Open cases' });
    expect(region).toBe(screen.getByTestId('p'));
    expect(region.tagName).toBe('SECTION');
    expect(region).toHaveClass('surface-panel', 'p-4', 'xl:p-5', '3xl:p-6');
    expect(region).toHaveAttribute('data-panel', 'default');
    const heading = within(region).getByRole('heading', { level: 2, name: 'Open cases' });
    expect(region).toHaveAttribute('aria-labelledby', heading.id);
    // The instrument title: 14px semibold, never tracked capitals.
    expect(heading).toHaveClass('text-base', 'font-semibold');
    expect(heading.className).not.toMatch(/uppercase|tracking-/);
  });

  it('exposes the padding and gutter tokens it is built from', () => {
    expect(PANEL_PADDING).toBe('p-4 xl:p-5 3xl:p-6');
    expect(PANEL_PADDING_X).toBe('px-4 xl:px-5 3xl:px-6');
    expect(PANEL_GAP).toBe('gap-4 xl:gap-5 3xl:gap-6');
  });

  it('shows a count with thousands separators and a caption on the title baseline', () => {
    render(
      <Panel title="Latest cases" count={1284} caption="last 24 hours">
        body
      </Panel>,
    );
    const region = screen.getByRole('region', { name: 'Latest cases' });
    expect(within(region).getByText('1,284')).toHaveClass('tabular-nums', 'text-muted-foreground');
    const caption = within(region).getByText('last 24 hours');
    expect(caption).toHaveClass('text-sm', 'text-muted-foreground');
    // The title, count and caption share one baseline cluster.
    const heading = within(region).getByRole('heading');
    expect(heading.parentElement).toContainElement(caption);
    expect(heading.parentElement).toHaveClass('items-baseline');
  });

  it('puts the aside and actions on the right of the title row', () => {
    render(
      <Panel title="Response time" aside={<span>Updated 2m ago</span>} actions={<button type="button">View all</button>}>
        body
      </Panel>,
    );
    const row = screen.getByRole('heading').closest('[data-panel-title-row]') as HTMLElement;
    expect(within(row).getByText('Updated 2m ago')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'View all' })).toBeInTheDocument();
    const heading = within(row).getByRole('heading');
    const action = within(row).getByRole('button', { name: 'View all' });
    expect(heading.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('padding="none" bleeds the body to the edge, clips to the corners and insets only the title', () => {
    render(
      <Panel title="Audit events" padding="none">
        <table aria-label="Events">
          <tbody>
            <tr>
              <td>row</td>
            </tr>
          </tbody>
        </table>
      </Panel>,
    );
    const region = screen.getByRole('region', { name: 'Audit events' });
    expect(region).toHaveAttribute('data-panel', 'none');
    expect(region).toHaveClass('overflow-clip');
    expect(region).not.toHaveClass('p-4');
    const row = region.querySelector('[data-panel-title-row]') as HTMLElement;
    expect(row).toHaveClass('px-4', 'xl:px-5', '3xl:px-6', 'pt-4', 'xl:pt-5', '3xl:pt-6');
  });

  it('as="div" is plain (no region) and level 3 nests under a titled group', () => {
    const { rerender } = render(
      <Panel as="div" title="Flow">
        body
      </Panel>,
    );
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Flow' })).toBeInTheDocument();
    rerender(
      <Panel title="Flow" level={3}>
        body
      </Panel>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Flow' })).toBeInTheDocument();
  });

  it('without a title draws no title row and points aria-labelledby at nothing', () => {
    render(
      <Panel data-testid="p" aria-label="Case summary">
        body
      </Panel>,
    );
    const panel = screen.getByTestId('p');
    expect(panel.querySelector('[data-panel-title-row]')).toBeNull();
    expect(panel).not.toHaveAttribute('aria-labelledby');
    expect(screen.getByRole('region', { name: 'Case summary' })).toBe(panel);
  });

  it('renders the title as plain text (#9)', () => {
    render(<Panel title="<img src=x onerror=alert(1)>">body</Panel>);
    expect(screen.getByRole('heading').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <div>
        <h1>Page</h1>
        <Panel title="Open cases" count={20} caption="open now" actions={<button type="button">View all</button>}>
          <p>Body</p>
        </Panel>
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('SectionTitle', () => {
  it('is the 15px sentence-case module title with an optional 13px caption and aside', () => {
    render(<SectionTitle id="s1" title="Detection rules" caption="Rules that fired in the window" aside={<span>Updated now</span>} />);
    const heading = screen.getByRole('heading', { level: 2, name: 'Detection rules' });
    expect(heading).toHaveAttribute('id', 's1');
    expect(heading).toHaveClass('text-md', 'font-semibold');
    expect(heading.className).not.toMatch(/uppercase|tracking-/);
    expect(screen.getByText('Rules that fired in the window')).toHaveClass('text-sm', 'text-muted-foreground');
    expect(screen.getByText('Updated now')).toBeInTheDocument();
  });

  it('sets no outer margin of its own', () => {
    render(<SectionTitle title="Groups" />);
    const root = screen.getByRole('heading').closest('[data-section-title]') as HTMLElement;
    expect(root.className).not.toMatch(/(^|\s)m[tbxy]?-\d/);
  });
});

describe('module boundary and catalog', () => {
  const source = readFileSync(path.resolve(__dirname, '../panel.tsx'), 'utf8');

  it('stays tree-shakeable: the index the entry imports must not pull Panel into first paint', () => {
    expect(source).toMatch(/export const Panel = \/\*#__PURE__\*\/ React\.forwardRef/);
    expect(source).not.toMatch(/Panel\.displayName\s*=/);
  });

  it('carries no em dash or en dash and no retired product word in its copy', () => {
    expect(source).not.toMatch(/[–—]/);
    expect(source.toLowerCase()).not.toContain('playbook');
  });

  it('lists Panel, SectionTitle, the page header and the KPI strip in the catalog', () => {
    const ids = DESIGN_SYSTEM_CATALOG.components.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining(['surface.panel', 'typography.section-title', 'layout.page-header', 'metric.kpi-strip']),
    );
    expect(() => JSON.stringify(DESIGN_SYSTEM_CATALOG)).not.toThrow();
  });
});
