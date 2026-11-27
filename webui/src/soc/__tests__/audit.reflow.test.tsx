/**
 * The Audit list follows its own width (Round 16 bug hunt B72 and B79, WP15F).
 *
 * B72: the table layout was chosen from the viewport, so from 768 px (where the docked rail
 * takes 240 px) the medium layout's 656 px of fixed columns cut Actor and Summary off. The
 * list now measures the panel it sits in: phone below 816 px of list, medium below 992 px,
 * wide above. Before the first measurement the viewport still decides.
 *
 * B79: a phone Time cell truncated every time before its seconds ("24 Nov 20:57:..."); it now
 * wraps at the space into a date line and a clock line.
 */
import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const realMatchMedia = window.matchMedia;
const realResizeObserver = window.ResizeObserver;
afterAll(() => {
  window.matchMedia = realMatchMedia;
});

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    request: vi.fn(),
    ApiError: class ApiError extends Error {},
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
    },
  };
});
vi.mock('@/lib/api-audit', () => ({
  AUDIT_COUNT_CAP: 100_001,
  listAuditPage: listMock,
  countAudit: vi.fn(),
  submitAuditExport: vi.fn(),
}));

import { AuthProvider } from '../auth';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Audit from '../pages/Audit';

/** The width every observed list panel reports (`null`: the observer never reports). */
let listWidth: number | null = null;

class ListResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    if (listWidth === null || !(target instanceof HTMLElement) || !target.querySelector('[data-audit-list]')) return;
    const size = { inlineSize: listWidth, blockSize: 400 } as ResizeObserverSize;
    this.callback(
      [{ target, contentRect: DOMRect.fromRect({ width: listWidth, height: 400 }), contentBoxSize: [size] } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

function viewport(width: number) {
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    const min = /min-width:\s*([\d.]+)px/.exec(query);
    const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}

function record(id: string, ts: string) {
  return {
    event_id: null,
    app_version: '0.2.0',
    build_sha: 'abcdef1234567890',
    source_id: null,
    model: null,
    prompt_excerpt: null,
    query_text: null,
    tool_name: null,
    tool_input: null,
    tool_output_summary: null,
    outcome_derived: false,
    actor_type_derived: false,
    demo: false,
    truncated_fields: [],
    record_id: id,
    ts,
    action_type: 'status',
    action: 'case.closed',
    actor: 'analyst-jo',
    actor_type: 'human',
    surface: 'case',
    case_id: 'case-001',
    target: { type: 'case', id: 'case-001', label: 'CASE-000001' },
    outcome: 'success',
    category: 'case_work',
    event_label: 'Case closed',
    result_summary: 'action=close status open to closed',
  };
}

async function renderGrid() {
  render(
    <TooltipProvider>
      <AuthProvider>
        <RouterProvider>
          <Audit />
        </RouterProvider>
      </AuthProvider>
    </TooltipProvider>,
  );
  return screen.findByRole('grid', { name: 'Audit events' });
}

function headers(grid: HTMLElement): string[] {
  return within(grid)
    .getAllByRole('columnheader')
    .map((th) => (th.textContent ?? '').trim());
}

describe('Audit list layout follows the list width (B72)', () => {
  beforeEach(() => {
    window.ResizeObserver = ListResizeObserver as unknown as typeof ResizeObserver;
    window.location.hash = '#/audit';
    listMock.mockReset();
    listMock.mockResolvedValue({
      records: [record('mem:2', '2026-11-24T21:45:52Z'), record('mem:1', '2026-11-24T21:45:10Z')],
      total: 2,
      next_cursor: null,
      total_relation: 'eq',
      run_totals: {},
      retention: { hot_days: 180, warm_days: 90, volatile: false },
    });
  });
  afterEach(() => {
    window.ResizeObserver = realResizeObserver;
    listWidth = null;
  });

  it.each([480, 656, 812])('a %i px list beside the docked rail shows the three phone columns', async (width) => {
    viewport(1024);
    listWidth = width;
    const grid = await renderGrid();
    await waitFor(() => expect(headers(grid)).toHaveLength(3));
    expect(within(grid).queryByRole('columnheader', { name: /actor/i })).toBeNull();
  });

  it('a 900 px list shows Actor and Summary but not Target', async () => {
    viewport(1280);
    listWidth = 900;
    const grid = await renderGrid();
    await waitFor(() => expect(headers(grid)).toHaveLength(5));
    expect(within(grid).getByRole('columnheader', { name: /actor/i })).toBeInTheDocument();
    expect(within(grid).getByRole('columnheader', { name: /summary/i })).toBeInTheDocument();
    expect(within(grid).queryByRole('columnheader', { name: /target/i })).toBeNull();
  });

  it('a 1000 px list shows every column, Target included', async () => {
    viewport(1100);
    listWidth = 1000;
    const grid = await renderGrid();
    await waitFor(() => expect(within(grid).getByRole('columnheader', { name: /target/i })).toBeInTheDocument());
    expect(headers(grid)).toHaveLength(6);
  });

  it('keeps the viewport layout until the list is measured', async () => {
    viewport(1440);
    listWidth = null;
    const grid = await renderGrid();
    expect(within(grid).getByRole('columnheader', { name: /target/i })).toBeInTheDocument();
  });

  it('contains the rows inside the list so nothing widens the page', async () => {
    viewport(768);
    listWidth = 480;
    const grid = await renderGrid();
    expect(grid.closest('[data-audit-list]')).toHaveClass('relative');
  });
});

describe('Phone audit times wrap instead of truncating (B79)', () => {
  beforeEach(() => {
    window.ResizeObserver = ListResizeObserver as unknown as typeof ResizeObserver;
    window.location.hash = '#/audit';
    listMock.mockReset();
    listMock.mockResolvedValue({
      records: [record('mem:2', '2026-11-24T21:45:52Z')],
      total: 1,
      next_cursor: null,
      total_relation: 'eq',
      run_totals: {},
      retention: { hot_days: 180, warm_days: 90, volatile: false },
    });
  });
  afterEach(() => {
    window.ResizeObserver = realResizeObserver;
    listWidth = null;
  });

  it('lets a phone Time cell wrap at its space, seconds included', async () => {
    viewport(390);
    listWidth = 358;
    const grid = await renderGrid();
    const time = grid.querySelector('tbody time');
    expect(time).not.toBeNull();
    const cell = time!.closest('td')!;
    expect(cell).not.toHaveClass('truncate');
    expect(cell).toHaveClass('whitespace-normal');
    expect(cell).not.toHaveClass('whitespace-nowrap');
  });

  it('keeps one line on wider lists', async () => {
    viewport(1440);
    listWidth = 1100;
    const grid = await renderGrid();
    const cell = grid.querySelector('tbody time')!.closest('td')!;
    expect(cell).toHaveClass('truncate');
  });
});
