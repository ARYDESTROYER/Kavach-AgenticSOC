/**
 * AskAboutThis (SPEC §10.7): opens a NEW chat with the topic id only (never free text),
 * is shown only to a caller who can use chat (cases:read), renders nothing outside the
 * app router, and rides at the end of a KPI tile's help popover.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { authState, navigate } = vi.hoisted(() => ({
  authState: { denied: new Set<string>(), present: true },
  navigate: vi.fn(),
}));
vi.mock('@/soc/auth', () => ({
  useAuth: () => {
    if (!authState.present) throw new Error('no AuthProvider');
    return { hasPermission: (r: string, a: string) => !authState.denied.has(`${r}:${a}`) };
  },
}));
const routeState = vi.hoisted(() => ({ present: true }));
vi.mock('@/soc/router', () => ({
  useRoute: () => {
    if (!routeState.present) throw new Error('no RouterProvider');
    return { page: 'overview', opts: undefined, navigate };
  },
}));

import { AskAboutThis } from '../AskAboutThis';
import { KpiTile } from '../KpiTile';

afterEach(() => {
  authState.denied = new Set();
  authState.present = true;
  routeState.present = true;
  navigate.mockReset();
});

describe('AskAboutThis', () => {
  it('opens a new chat with the topic id', async () => {
    const user = userEvent.setup();
    render(<AskAboutThis topic="kpi:mttr" subject="MTTR" />);
    await user.click(screen.getByRole('button', { name: 'Ask about this: MTTR' }));
    expect(navigate).toHaveBeenCalledWith('chat', { newChat: true, topic: 'kpi:mttr' });
  });

  it('is hidden without cases:read, and outside the app router or auth', () => {
    authState.denied = new Set(['cases:read']);
    const { container, rerender } = render(<AskAboutThis topic="kpi:mttr" />);
    expect(container).toBeEmptyDOMElement();
    authState.denied = new Set();
    routeState.present = false;
    rerender(<AskAboutThis topic="kpi:mttr" />);
    expect(container).toBeEmptyDOMElement();
    routeState.present = true;
    authState.present = false;
    rerender(<AskAboutThis topic="kpi:mttr" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('ends a KPI tile help popover', async () => {
    const user = userEvent.setup();
    render(<KpiTile label="MTTR" value="4 h" help="Median time to resolve." askTopic="kpi:mttr" />);
    await user.click(screen.getByRole('button', { name: 'About MTTR' }));
    await user.click(await screen.findByRole('button', { name: 'Ask about this: MTTR' }));
    expect(navigate).toHaveBeenCalledWith('chat', { newChat: true, topic: 'kpi:mttr' });
  });

  it('a tile without askTopic offers no ask action', async () => {
    const user = userEvent.setup();
    render(<KpiTile label="MTTR" value="4 h" help="Median time to resolve." />);
    await user.click(screen.getByRole('button', { name: 'About MTTR' }));
    await screen.findByText('Median time to resolve.');
    expect(screen.queryByRole('button', { name: /Ask about this/ })).toBeNull();
  });
});
