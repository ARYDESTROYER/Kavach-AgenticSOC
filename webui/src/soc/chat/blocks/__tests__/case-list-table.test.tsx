/**
 * A case list's own table surfaces name a case as its list view does (Round 13 polish,
 * re-shoot PW3-1): "Show table", the Expand sheet's table, Copy data (TSV, a format people
 * read) and the Case column of a CSV read the case's number ("CASE-000045"), the internal
 * id only for a case the server sent without one. The table view still links each case by
 * its internal id, and a CSV (the machine format) carries the id in its own "Case ID"
 * column after "Case" so other tools can match it.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const announce = vi.fn();
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));
const copyText = vi.fn(async (_text: string) => true);
vi.mock('@/lib/clipboard', () => ({ copyText: (t: string) => copyText(t), default: (t: string) => copyText(t) }));

import type { Report, ReportItem } from '@/lib/types';

import AnswerBlocks from '../AnswerBlocks';
import { blockTabular, toCSV, toTSV } from '../export-helpers';
import { parseBlock } from '../schema';
import { buildReportDoc } from '../../report/model';
import { blockToCsv, reportTablesCsv } from '../../report/export/csv';

const CASES = parseBlock({
  type: 'case_list',
  id: 'open',
  title: 'Highest-risk cases',
  provenance: 'code',
  artifact_kind: 'case_list',
  allowed_views: ['case_list', 'table'],
  untrusted: true,
  items: [
    { case_id: 'demo-recent-00000539-0000', case_number: 'CASE-000044', title: 'user:vpatel · demo_phishing_chain', severity: 'critical', status: 'new', risk: 92 },
    { case_id: 'demo-00000539-0004', case_number: 'SOC.IR-0042', title: 'ip:203.0.113.77 sign-in', severity: 'high', status: 'investigating', risk: 71 },
    { case_id: 'case-6b22d1f0a9c84e1b9f3d70b4', title: 'user:trao sign-in', severity: 'low', status: 'investigating', risk: 20 },
  ],
});

/** Ids of the numbered cases: no surface people read may print them. */
const NUMBERED_IDS = ['demo-recent-00000539-0000', 'demo-00000539-0004'];
const UNNUMBERED_ID = 'case-6b22d1f0a9c84e1b9f3d70b4';

function readBlob(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(b);
  });
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByTestId('block-menu-trigger')[0]);
  return screen.findByRole('menu');
}

/** The visible text of an element: no tooltips, no text kept only for assistive tech. */
function visibleText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('.sr-only').forEach((n) => n.remove());
  return copy.textContent ?? '';
}

/** One RFC-4180 line as its fields (strings are quoted, numbers raw). */
function csvRow(line: string): string[] {
  const out: string[] = [];
  const re = /(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) && m[0] !== '') out.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]);
  return out;
}

const CSV_HEAD = ['Case', 'Case ID', 'Title', 'Severity', 'Verdict', 'Status', 'Risk', 'Created (UTC)'];

/** The first column of each body row of a rendered block table. */
function caseCells(table: HTMLElement): HTMLElement[] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]);
}

beforeEach(() => {
  announce.mockClear();
  copyText.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('the shared projection', () => {
  it('names each case by its number and carries the id beside it', () => {
    const tab = blockTabular(CASES)!;
    expect(tab.columns[0]).toMatchObject({ label: 'Case', identifier: true });
    expect(tab.rows.map((r) => r[0])).toEqual(['CASE-000044', 'SOC.IR-0042', UNNUMBERED_ID]);
    expect(tab.caseIds).toEqual([...NUMBERED_IDS, UNNUMBERED_ID]);
  });

  it('Copy data (TSV) reads the numbers, never defangs one, and has no Case ID column', () => {
    const tsv = toTSV(blockTabular(CASES)!);
    const lines = tsv.split('\n');
    expect(lines[0]).toBe('Case\tTitle\tSeverity\tVerdict\tStatus\tRisk\tCreated (UTC)');
    expect(lines.slice(1).map((l) => l.split('\t')[0])).toEqual(['CASE-000044', 'SOC.IR-0042', UNNUMBERED_ID]);
    // The title is still defanged as indicator text; the case number keeps its spelling.
    expect(tsv).toContain('ip:203[.]0[.]113[.]77 sign-in');
    for (const id of NUMBERED_IDS) expect(tsv).not.toContain(id);
  });

  it('CSV writes the number under Case and the internal id under Case ID', () => {
    const csv = toCSV(blockTabular(CASES)!);
    const rows = csv.split('\r\n').map(csvRow);
    expect(rows[0]).toEqual(CSV_HEAD);
    expect(rows.slice(1).map((r) => [r[0], r[1]])).toEqual([
      ['CASE-000044', NUMBERED_IDS[0]],
      ['SOC.IR-0042', NUMBERED_IDS[1]],
      [UNNUMBERED_ID, UNNUMBERED_ID],
    ]);
    // Severity and risk keep their place after the inserted column.
    expect(rows[1][3]).toBe('Critical');
    expect(rows[1][6]).toBe('92');
    expect(toCSV(blockTabular(CASES)!, { defang: true })).toContain('SOC.IR-0042');
  });

  it('the report CSV exports (one block and all tables) carry the same two columns', () => {
    expect(csvRow(blockToCsv(CASES)!.split('\r\n')[0])).toEqual(CSV_HEAD);
    const report = {
      id: 'rep',
      owner: 'Admin',
      title: 'Open work',
      template: 'executive',
      conversation_id: 'chat-1',
      items: [
        {
          id: 'it-1',
          kind: 'section',
          block: { title: 'Cases', blocks: [CASES], truncated: false },
          note: null,
          source: { conversation_id: 'chat-1', message_id: 'msg-2', block_id: null },
          scope: { window: 'last 7 days', sources: [], generated_by: 'demo-chat', app_version: '0.1.13', demo: true },
          added_at: '2026-10-08T13:00:00Z',
        } as ReportItem,
      ],
      summary: null,
      created_at: '2026-10-08T13:00:00Z',
      updated_at: '2026-10-08T13:00:00Z',
      version: 1,
    } as Report;
    const all = reportTablesCsv(buildReportDoc(report, { author: 'Admin', appVersion: '0.1.13', generatedAt: '2026-10-08T13:00:00Z' }))!;
    const lines = all.split('\r\n');
    expect(csvRow(lines[1])).toEqual(CSV_HEAD);
    expect(csvRow(lines[2]).slice(0, 2)).toEqual(['CASE-000044', NUMBERED_IDS[0]]);
  });

  it('a table block a server sent keeps its own columns (no Case ID column)', () => {
    const table = parseBlock({
      type: 'table',
      id: 't',
      title: 'Cases',
      provenance: 'code',
      artifact_kind: 'table',
      allowed_views: ['table'],
      columns: [{ key: 'case', label: 'Case', type: 'case' }],
      rows: [['case-1']],
    });
    expect(csvRow(toCSV(blockTabular(table)!).split('\r\n')[0])).toEqual(['Case']);
  });
});

describe('the block menu', () => {
  it('Show table names each case by number, links it by id, and keeps the id in the tooltip', async () => {
    const user = userEvent.setup();
    render(<AnswerBlocks blocks={[CASES]} messageId="m1" />);
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Show table' }));
    const table = within(screen.getByTestId('block-table')).getByRole('table');
    const cells = caseCells(table);
    expect(cells.map((c) => visibleText(c))).toEqual(['CASE-000044', 'SOC.IR-0042', 'case-6b22…70b4']);
    // Each case links to Case Manager by its internal id, named as the screen names it.
    const links = cells.map((c) => within(c).getByRole('link'));
    expect(links[0]).toHaveAccessibleName('CASE-000044');
    expect(links[0].getAttribute('href')).toContain(encodeURIComponent(NUMBERED_IDS[0]).replace(/%2D/g, '-'));
    expect(cells[0].querySelector('[data-case-ref="number"]')?.getAttribute('title')).toBe(NUMBERED_IDS[0]);
    // A case without a number: its id, shortened on screen and whole for assistive tech.
    expect(links[2]).toHaveAccessibleName(UNNUMBERED_ID);
    expect(cells[2].querySelector('[data-case-ref="id"]')?.getAttribute('title')).toBe(UNNUMBERED_ID);
    for (const id of NUMBERED_IDS) expect(visibleText(table)).not.toContain(id);
  });

  it('the Expand sheet shows the same table', async () => {
    const user = userEvent.setup();
    render(<AnswerBlocks blocks={[CASES]} messageId="m1" />);
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Show table' }));
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Expand' }));
    const sheet = await screen.findByRole('dialog');
    const table = within(within(sheet).getByTestId('block-table')).getByRole('table');
    expect(caseCells(table).map((c) => visibleText(c))).toEqual(['CASE-000044', 'SOC.IR-0042', 'case-6b22…70b4']);
    for (const id of NUMBERED_IDS) expect(visibleText(sheet)).not.toContain(id);
  });

  it('Copy data and Download CSV', async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((b: Blob) => {
        blobs.push(b);
        return 'blob:x';
      }),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<AnswerBlocks blocks={[CASES]} messageId="m1" />);
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Copy data' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    const tsv = copyText.mock.calls[0][0];
    expect(tsv.split('\n')[1].split('\t')[0]).toBe('CASE-000044');
    for (const id of NUMBERED_IDS) expect(tsv).not.toContain(id);

    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Download CSV' }));
    const csv = (await readBlob(blobs[0])).replace(/^﻿/, '');
    expect(csvRow(csv.split('\r\n')[0])).toEqual(CSV_HEAD);
    expect(csvRow(csv.split('\r\n')[1]).slice(0, 2)).toEqual(['CASE-000044', NUMBERED_IDS[0]]);
  });
});
