/**
 * Intelligence — explicit leaf labels and direct Persona discovery.
 *
 * Every Intelligence job has one direct destination and one derived label. Agent
 * personas no longer hide behind a second Playbooks/Catalog tab, while the legacy
 * `catalog` alias resolves to Response playbooks.
 *
 * The sub-pages are stubbed so the host renders without their network surface.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../Knowledge', () => ({ default: () => <div>knowledge body</div> }));
vi.mock('../Runbooks', () => ({ default: () => <div>runbooks body</div> }));
vi.mock('../Memory', () => ({ default: () => <div>memory body</div> }));
vi.mock('../Catalog', () => ({
  default: ({ defaultTab }: { defaultTab?: string }) => (
    <div>catalog body · {defaultTab}</div>
  ),
}));

import { TooltipProvider } from '@/ui/tooltip';
import Intelligence from '../Intelligence';
import { navLabel } from '@/soc/nav';

describe('Intelligence host — direct leaf labels', () => {
  it('maps the legacy Catalog alias to Response playbooks', () => {
    render(
      <TooltipProvider>
        <Intelligence tab="catalog" />
      </TooltipProvider>,
    );
    // Round 14 (D44): the registry's `playbooks` alias opens the one Runbooks feature (the
    // router redirects it); this host still renders its legacy view until WP-W7a.
    expect(navLabel('playbooks')).toBe('Runbooks');
    expect(screen.getByRole('heading', { name: 'Response playbooks' })).toBeInTheDocument();
    expect(screen.getByText('catalog body · playbooks')).toBeInTheDocument();
  });

  it('renders the dedicated Runbooks Intelligence child at its registry label', () => {
    render(
      <TooltipProvider>
        <Intelligence tab="runbooks" />
      </TooltipProvider>,
    );
    // Round 14 (SPEC §4.8.2): one "Runbooks" destination; the host's own heading is
    // rewritten with the page (WP-W7a).
    expect(navLabel('runbooks')).toBe('Runbooks');
    expect(screen.getByRole('heading', { name: 'Reference runbooks' })).toBeInTheDocument();
    expect(screen.getByText('runbooks body')).toBeInTheDocument();
  });

  it('renders Agent personas as its own Intelligence destination', () => {
    render(
      <TooltipProvider>
        <Intelligence tab="personas" />
      </TooltipProvider>,
    );
    expect(navLabel('personas')).toBe('Agent personas');
    expect(screen.getByRole('heading', { name: 'Agent personas' })).toBeInTheDocument();
    expect(screen.getByText('catalog body · personas')).toBeInTheDocument();
  });
});
