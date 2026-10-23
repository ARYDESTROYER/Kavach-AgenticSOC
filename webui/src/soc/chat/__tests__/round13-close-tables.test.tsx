/**
 * Round 13 closing pass: chat table cells measured on the live Demo.
 *
 * - A Techniques cell listed its ATT&CK ids as one inline code run, so on a phone it
 *   wrapped over three lines ("T1021," / "T1048," / "T1078") with its fill cut at each
 *   line end. Each technique is now its own chip and the chips wrap whole.
 * - A blank cell showed an em dash. It now draws nothing; assistive tech reads "None",
 *   or "Not measured" for a figure (a `null` number is not measured, BLOCKS G3).
 *
 * jsdom has no line layout: these pin the structure and classes; the wrapping was
 * measured live in Chromium at 390 (SPEC-chat §10.5, closing pass).
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { AnnouncerProvider } from '@/soc/components/announcer';
import { TooltipProvider } from '@/ui/tooltip';

import AnswerBlocks from '../blocks/AnswerBlocks';
import { blankCellText, techniqueList, TableView } from '../blocks/renderers/TableView';
import { parseBlock, type AnswerBlock, type TableBlock } from '../blocks/schema';

function show(blocks: AnswerBlock[]) {
  return render(
    <AnnouncerProvider>
      <TooltipProvider>
        <AnswerBlocks blocks={blocks} messageId="m1" />
      </TooltipProvider>
    </AnnouncerProvider>,
  );
}

const campaigns = (rows: unknown[][]) =>
  parseBlock({
    id: 'c',
    type: 'table',
    title: 'Open campaigns',
    provenance: 'code',
    artifact_kind: 'table',
    columns: [
      { key: 'name', label: 'Campaign', type: 'text' },
      { key: 'cases', label: 'Cases', type: 'number' },
      { key: 'risk', label: 'Risk', type: 'risk' },
      { key: 'last', label: 'Last seen', type: 'time' },
      { key: 'mitre', label: 'Techniques', type: 'code' },
    ],
    rows,
  });

describe('technique lists in a cell', () => {
  it('reads a list of ATT&CK ids, with or without the server\'s "and K more"', () => {
    expect(techniqueList('T1021, T1048, T1078')).toEqual({ ids: ['T1021', 'T1048', 'T1078'], more: null });
    expect(techniqueList('T1021, T1048.001, T1078 and 2 more')).toEqual({
      ids: ['T1021', 'T1048.001', 'T1078'],
      more: 'and 2 more',
    });
    expect(techniqueList('T1078 and 3 more')).toEqual({ ids: ['T1078'], more: 'and 3 more' });
    // One id alone stays the single chip it always was; anything else is not a list.
    expect(techniqueList('T1078')).toBeNull();
    expect(techniqueList('T1021, lateral movement')).toBeNull();
    expect(techniqueList('SELECT a, b FROM t')).toBeNull();
  });

  it('draws one chip per technique, each on one line, and the rest as plain text', () => {
    show([campaigns([['Lateral movement', 5, 62, '2026-10-23T18:47:00Z', 'T1021, T1048, T1078 and 1 more']])]);
    const table = screen.getByTestId('block-table');
    const list = table.querySelector('[data-technique-chips]') as HTMLElement;
    expect(list).toHaveClass('inline-flex', 'flex-wrap');
    const chips = Array.from(list.querySelectorAll('code'));
    expect(chips.map((c) => c.textContent)).toEqual(['T1021', 'T1048', 'T1078']);
    for (const chip of chips) expect(chip).toHaveClass('whitespace-nowrap');
    const more = within(list).getByText('and 1 more');
    expect(more.tagName).toBe('SPAN');
    expect(more).toHaveClass('whitespace-nowrap', 'text-muted-foreground');
    // Assistive tech and copied text still read the list in order.
    expect(list).toHaveTextContent('T1021, T1048, T1078and 1 more');
  });

  it('keeps a single technique in a mitre cell as one chip', () => {
    show([
      parseBlock({
        id: 'm',
        type: 'table',
        provenance: 'code',
        artifact_kind: 'table',
        columns: [{ key: 'mitre', label: 'Technique', type: 'mitre' }],
        rows: [['T1078'], ['T1566.001, T1059']],
      }),
    ]);
    const table = screen.getByTestId('block-table');
    const cells = within(table).getAllByRole('cell');
    expect(cells[0].querySelector('[data-technique-chips]')).toBeNull();
    expect(cells[0].querySelector('code')).toHaveTextContent(/^T1078$/);
    expect(Array.from(cells[1].querySelectorAll('code'), (c) => c.textContent)).toEqual(['T1566.001', 'T1059']);
  });
});

describe('blank cells', () => {
  it('says what a blank means without an em dash: "None" for a label, "Not measured" for a figure', () => {
    expect(blankCellText('text')).toBe('None');
    expect(blankCellText('code')).toBe('None');
    expect(blankCellText('time')).toBe('None');
    expect(blankCellText('number')).toBe('Not measured');
    expect(blankCellText('risk')).toBe('Not measured');
  });

  it('draws nothing in a blank cell and names it for assistive tech', () => {
    show([
      campaigns([
        ['Lateral movement', 5, 62, '2026-10-23T18:47:00Z', 'T1021, T1078'],
        ['Scanner noise', null, null, null, ''],
      ]),
    ]);
    const table = screen.getByTestId('block-table');
    expect(table.textContent ?? '').not.toContain('—');
    const row = within(table).getAllByRole('row')[2];
    const cells = within(row).getAllByRole('cell');
    // Cases (number), Risk, Last seen (time), Techniques (code).
    const said = cells.slice(1).map((cell) => {
      const sr = cell.querySelector('.sr-only');
      expect(cell.querySelectorAll(':scope *:not(.sr-only)').length).toBe(0);
      return sr?.textContent;
    });
    expect(said).toEqual(['Not measured', 'Not measured', 'None', 'None']);
  });

  it('prints a blank cell blank too (no em dash in print or static export)', () => {
    const block = campaigns([
      ['Lateral movement', 5, 62, '2026-10-23T18:47:00Z', 'T1021, T1078'],
      ['Scanner noise', 3, 20, '2026-10-23T18:47:00Z', null],
    ]) as TableBlock;
    const { container } = render(
      <AnnouncerProvider>
        <TableView block={block} title="Open campaigns" staticMode />
      </AnnouncerProvider>,
    );
    expect(container.textContent ?? '').not.toContain('—');
    expect(within(container).getByText('None')).toHaveClass('sr-only');
  });
});
