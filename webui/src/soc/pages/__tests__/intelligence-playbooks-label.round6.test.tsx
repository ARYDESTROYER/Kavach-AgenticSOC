/**
 * Intelligence: each job has one direct destination and one label (Round 14, SPEC §4.10.1).
 * Runbooks and Agent personas are pages of their own that draw their own header; the
 * retired `playbooks` and `catalog` ids open Runbooks. Knowledge and memory keep the host
 * header. The sub-pages are stubbed so the host renders without their network surface.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../Knowledge', () => ({ default: () => <div>knowledge body</div> }));
vi.mock('../Runbooks', () => ({ default: () => <div>runbooks page</div> }));
vi.mock('../Memory', () => ({ default: () => <div>memory body</div> }));
vi.mock('../Personas', () => ({ default: () => <div>personas page</div> }));

import { TooltipProvider } from '@/ui/tooltip';
import Intelligence, { intelligenceView } from '../Intelligence';
import { navLabel } from '@/soc/nav';

function renderHost(tab: string) {
  return render(
    <TooltipProvider>
      <Intelligence tab={tab} />
    </TooltipProvider>,
  );
}

describe('Intelligence host: direct destinations', () => {
  it.each(['runbooks', 'playbooks', 'catalog'])('opens the Runbooks page for %s', (tab) => {
    renderHost(tab);
    expect(navLabel('runbooks')).toBe('Runbooks');
    expect(screen.getByText('runbooks page')).toBeInTheDocument();
    // The page draws its own header; the host adds none.
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('renders Agent personas as its own page', () => {
    renderHost('personas');
    expect(navLabel('personas')).toBe('Agent personas');
    expect(screen.getByText('personas page')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('keeps one host header for Knowledge and Operator memory', () => {
    renderHost('knowledge');
    expect(screen.getByRole('heading', { level: 1, name: 'Knowledge corpus' })).toBeInTheDocument();
    expect(screen.getByText('knowledge body')).toBeInTheDocument();
  });

  it('maps every tab to one view', () => {
    expect(intelligenceView('memory')).toBe('memory');
    expect(intelligenceView(undefined)).toBe('knowledge');
    expect(intelligenceView('catalog')).toBe('runbooks');
  });
});
