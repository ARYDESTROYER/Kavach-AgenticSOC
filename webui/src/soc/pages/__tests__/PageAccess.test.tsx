/**
 * Pages a role can reach only by a typed or shared URL refuse plainly and send none of
 * their reads (Round 14 second acceptance pass, roles-02, roles-04, roles-05, roles-11):
 *
 * - Metrics and Agent effectiveness need `metrics:view`, Cost needs `cost:view`, Sources
 *   and Logs need `sources:read`. Without the grant the page keeps its title (`h1`) and
 *   shows one sentence, never a load error with a Retry that cannot work.
 * - Nothing behind the guard mounts, so no request is sent: each refused request would
 *   write an Access denied audit row and a console error.
 * - Inside Metrics, the LLM spend card needs `cost:view` too (GET /api/metrics leaves its
 *   `cost` part empty without it), and the knowledge strip's reads need `rag:read` and
 *   `memory:read`: a half the role lacks says so, in the wording of a missing grant, not
 *   the "not available" of a failed read.
 * - When the grants could not be loaded, a check that answers no says nothing about the
 *   role: the page keeps its title and shows a load failure with a Retry that loads the
 *   grants again, never "You do not have access".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const h = vi.hoisted(() => ({
  provider: true,
  grants: new Set<string>(),
  calls: [] as string[],
  /** False: the grants failed to load (RBAC reported off and every check denied). */
  grantsLoaded: true,
  refresh: vi.fn(),
}));

vi.mock('@/soc/auth', () => {
  const has = (resource: string, action: string) =>
    h.grantsLoaded && h.grants.has(`${resource}:${action}`);
  const auth = () => ({
    hasPermission: has,
    username: 'probe',
    authEnabled: true,
    isAuthenticated: true,
    rbacEnabled: h.grantsLoaded,
    refresh: h.refresh,
  });
  return {
    useOptionalAuth: () => (h.provider ? auth() : null),
    useAuth: auth,
  };
});

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  const handlers: Record<string, unknown> = {
    getMetrics: { total_cases: 3, by_status: {}, by_verdict: {}, cost: {}, feedback: {} },
    ragStats: { total_documents: 1, total_chunks: 2, by_source: {} },
    getMemory: { entries: [], count: 0 },
  };
  const target: Record<string, unknown> = {};
  return {
    ApiError,
    // The typed helpers some page modules build on (the open-by-verdict breakdown, MITRE
    // coverage); they answer an empty body here.
    request: vi.fn(() => Promise.resolve({})),
    api: new Proxy(target, {
      get: (t, prop) => {
        if (prop === 'then') return undefined;
        const name = String(prop);
        if (!(name in t)) {
          t[name] = vi.fn((..._args: unknown[]) => {
            h.calls.push(name);
            return Promise.resolve(handlers[name] ?? {});
          });
        }
        return t[name];
      },
    }),
  };
});

vi.mock('@/soc/demo', () => ({ useDemo: () => ({ active: false }) }));
vi.mock('@/soc/Metrics.posture.api', () => ({ fetchPosture: () => Promise.reject(new Error('n/a')) }));

import { PageAccess } from '../PageAccess';
import Metrics from '../Metrics';
import Cost from '../Cost';
import { AgentEffectivenessPage } from '../AgentEffectiveness';
import Sources from '../Sources';
import UnifiedLogs from '../UnifiedLogs';

beforeEach(() => {
  h.provider = true;
  h.grants = new Set();
  h.calls = [];
  h.grantsLoaded = true;
  h.refresh.mockReset().mockResolvedValue(null);
});

describe('direct URLs without the page grant', () => {
  it.each([
    ['Metrics', () => <Metrics />, 'You do not have access to metrics.'],
    ['Agent effectiveness', () => <AgentEffectivenessPage />, 'You do not have access to metrics.'],
    ['Cost', () => <Cost />, 'You do not have access to LLM spend.'],
    ['Sources', () => <Sources />, 'You do not have access to log sources.'],
    ['Logs', () => <UnifiedLogs opts={{}} />, 'You do not have access to log sources.'],
  ])('%s keeps its title, refuses in one sentence and sends no request', async (title, page, message) => {
    h.grants = new Set(['cases:read', 'settings:read']);
    render(page());
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByTestId('page-access-refused')).toHaveTextContent('Access restricted');
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    // Give any effect a chance to fire: none may, because nothing behind the guard mounted.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls).toEqual([]);
  });
});

describe('PageAccess', () => {
  it('renders the page with the grant', () => {
    h.grants = new Set(['metrics:view']);
    render(
      <PageAccess resource="metrics" action="view" title="Metrics" message="You do not have access to metrics.">
        <p>The page</p>
      </PageAccess>,
    );
    expect(screen.getByText('The page')).toBeInTheDocument();
    expect(screen.queryByTestId('page-access-refused')).not.toBeInTheDocument();
  });

  it('says the grants could not be loaded, with a Retry that loads them, never "no access"', async () => {
    h.grantsLoaded = false;
    h.grants = new Set(['metrics:view']);
    render(
      <PageAccess resource="metrics" action="view" title="Metrics" message="You do not have access to metrics.">
        <p>The page</p>
      </PageAccess>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Metrics' })).toBeInTheDocument();
    const notice = screen.getByTestId('grants-unknown');
    expect(notice).toHaveTextContent('Your permissions could not be loaded.');
    expect(notice).toHaveTextContent('Try again to load this page.');
    expect(screen.queryByText(/You do not have access/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('page-access-refused')).not.toBeInTheDocument();
    expect(screen.queryByText('The page')).not.toBeInTheDocument();
    await userEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Metrics', () => <Metrics />],
    ['Cost', () => <Cost />],
    ['Sources', () => <Sources />],
    ['Logs', () => <UnifiedLogs opts={{}} />],
  ])('%s sends nothing while the grants are unknown', async (title, page) => {
    h.grantsLoaded = false;
    h.grants = new Set(['metrics:view', 'cost:view', 'sources:read']);
    render(page());
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByTestId('grants-unknown')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls).toEqual([]);
  });

  it('renders the page outside the auth shell (no provider), as auth off does', () => {
    h.provider = false;
    render(
      <PageAccess resource="metrics" action="view" title="Metrics" message="You do not have access to metrics.">
        <p>The page</p>
      </PageAccess>,
    );
    expect(screen.getByText('The page')).toBeInTheDocument();
  });
});

describe('Metrics reads and panels follow their own grants', () => {
  it('skips the knowledge reads the role lacks and says LLM spend is not available to it', async () => {
    h.grants = new Set(['metrics:view']);
    render(<Metrics />);
    expect(await screen.findByTestId('analytics-spend-restricted')).toHaveTextContent(
      'You do not have access to LLM spend.',
    );
    expect(screen.queryByTestId('analytics-spend')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Cost' })).not.toBeInTheDocument();
    expect(h.calls).toContain('getMetrics');
    expect(h.calls).not.toContain('ragStats');
    expect(h.calls).not.toContain('getMemory');
  });

  it.each([
    [
      'memory:read',
      'rag:read',
      ['Documents', 'Chunks', 'Embedding dimensions'],
      'You do not have access to the knowledge corpus.',
      'getMemory',
      'ragStats',
    ],
    [
      'rag:read',
      'memory:read',
      ['Memory facts', 'Active memory'],
      'You do not have access to operator memory.',
      'ragStats',
      'getMemory',
    ],
  ])(
    'with %s but not %s, says that half is restricted and never reads it',
    async (_held, _missing, restrictedTiles, sentence, sent, skipped) => {
      h.grants = new Set(['metrics:view', _held]);
      render(<Metrics />);
      const strip = await screen.findByTestId('analytics-knowledge-strip');
      for (const label of restrictedTiles) {
        const tile = within(strip).getByText(label).closest('[data-testid^="kpi-"]');
        expect(tile).toHaveTextContent('Access restricted');
      }
      expect(screen.getByText(sentence)).toBeInTheDocument();
      expect(screen.queryByText(/figures are not available/)).not.toBeInTheDocument();
      expect(h.calls).toContain(sent);
      expect(h.calls).not.toContain(skipped);
    },
  );

  it('reads them, and shows the spend card, with rag, memory and cost grants', async () => {
    h.grants = new Set(['metrics:view', 'cost:view', 'rag:read', 'memory:read']);
    render(<Metrics />);
    expect(await screen.findByTestId('analytics-spend')).toBeInTheDocument();
    expect(screen.queryByTestId('analytics-spend-restricted')).not.toBeInTheDocument();
    await waitFor(() => expect(h.calls).toEqual(expect.arrayContaining(['getMetrics', 'ragStats', 'getMemory'])));
  });
});
