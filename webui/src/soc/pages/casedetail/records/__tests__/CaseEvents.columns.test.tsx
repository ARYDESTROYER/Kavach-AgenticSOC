/**
 * CaseEvents column widths (FXA1, acceptance gap events-table-message-column-cramped).
 *
 * The Events table is a fixed layout: every column but Message has a declared width and
 * joins at a container width, and Message takes what is left. jsdom has no layout, so
 * this reads the declared widths and breakpoints from the rendered header and checks the
 * room Message keeps at every width where a column joins: at least 12rem, and about
 * 16rem at the default 1440 layout (a 48.7rem events container), where Source IP used
 * to leave it 84 px.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

import type { CaseEventRow, CaseEventsPage } from '@/lib/types';
import { CaseEvents } from '../CaseEvents';

const ROW: CaseEventRow = {
  id: 'e1',
  ts: '2026-11-20T10:00:05+00:00',
  source_ip: '203.0.113.9',
  user: 'vpatel',
  host: 'web-1',
  rule: 'Impossible travel',
  severity: 'high',
  message: 'Impossible-travel sign-in: correlated activity for vpatel from two countries',
  _raw: {},
  index: 'logs-1',
  source_id: 'src-1',
  in_evidence: [],
};

const PAGE: CaseEventsPage = {
  case_id: 'case-1',
  available: true,
  reason: null,
  returned: 1,
  expected: 1,
  truncated: false,
  limit: 50,
  next_cursor: null,
  rows: [ROW],
};

interface Column {
  name: string;
  /** Declared width in rem, or a share of the table width (0..1). */
  rem: number;
  share: number;
  /** The container width (rem) from which it shows, and its width from there. */
  from: number;
  wideRem: number | null;
}

function columns(): Column[] {
  return Array.from(document.querySelectorAll('[data-testid="case-events"] thead th')).map((th) => {
    const cls = th.getAttribute('class') ?? '';
    const rem = /(?:^|\s)w-\[(\d+(?:\.\d+)?)rem\]/.exec(cls);
    const share = /(?:^|\s)w-\[(\d+)%\]/.exec(cls);
    const from = /@\[(\d+(?:\.\d+)?)rem\]\/events:table-cell/.exec(cls);
    const wide = /@\[\d+(?:\.\d+)?rem\]\/events:w-\[(\d+(?:\.\d+)?)rem\]/.exec(cls);
    return {
      name: th.textContent?.trim() ?? '',
      rem: rem ? Number(rem[1]) : 0,
      share: share ? Number(share[1]) / 100 : 0,
      from: from ? Number(from[1]) : cls.includes('hidden') ? Number.POSITIVE_INFINITY : 0,
      wideRem: wide ? Number(wide[1]) : null,
    };
  });
}

/** The room Message keeps in a container `width` rem wide. */
function messageRoom(cols: Column[], width: number): number {
  const wideFrom = 36; // the Time column widens with the Rule column
  let used = 0;
  for (const col of cols) {
    if (col.name === 'Message' || width < col.from) continue;
    const rem = col.wideRem !== null && width >= wideFrom ? col.wideRem : col.rem;
    used += rem + col.share * width;
  }
  return width - used;
}

describe('CaseEvents columns (FXA1)', () => {
  it('leave the message at least 12rem wherever a column joins, and about 16rem at 1440', async () => {
    render(<CaseEvents caseId="case-1" load={vi.fn(async () => PAGE)} />);
    await screen.findAllByTestId('case-event-row');
    const cols = columns();
    expect(cols.map((col) => col.name)).toEqual(['Time', 'Rule', 'Severity', 'Source IP', 'User', 'Host', 'Message']);
    const breakpoints = [...new Set(cols.map((col) => col.from).filter((from) => Number.isFinite(from) && from > 0))];
    expect(breakpoints.length).toBeGreaterThan(0);
    for (const at of breakpoints) {
      expect(messageRoom(cols, at), `message room at a ${at}rem container`).toBeGreaterThanOrEqual(12);
    }
    // The default 1440 layout (navigation expanded, queue at 340 px): a 779 px container.
    expect(messageRoom(cols, 779 / 16)).toBeGreaterThanOrEqual(15);
  });
});
