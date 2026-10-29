/**
 * Agent personas (Round 14): the read-only specialist roster is its own page, split out of
 * the retired combined catalog. One page header titled by the navigation label, one roster
 * panel, rows that open to their focus tools and routing terms, and no tab switcher.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ getPersonas: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, getPersonas: mocks.getPersonas } };
});

import { TooltipProvider } from '@/ui/tooltip';
import Personas from '../Personas';

function renderPage() {
  return render(
    <TooltipProvider>
      <Personas />
    </TooltipProvider>,
  );
}

describe('Agent personas page', () => {
  beforeEach(() => {
    mocks.getPersonas.mockReset();
    mocks.getPersonas.mockResolvedValue({
      enabled: true,
      personas: [
        {
          id: 'identity_access',
          label: 'Identity & access',
          specialization: 'Authentication and privilege investigations.',
          focus_tools: ['es_query', 'enrich'],
          keywords: ['login', 'mfa'],
        },
      ],
    });
  });

  it('renders the roster under its own page title, without a second tab switcher', async () => {
    const { container } = renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Agent personas' })).toBeInTheDocument();
    expect(await screen.findByText('Identity & access')).toBeInTheDocument();
    expect(screen.getByText('Authentication and privilege investigations.')).toBeInTheDocument();
    expect(screen.getByText('2 focus tools · 2 routing terms')).toBeInTheDocument();
    const personaSummary = screen.getByText('Identity & access').closest('summary');
    expect(personaSummary?.parentElement).not.toHaveAttribute('open');
    fireEvent.click(personaSummary as HTMLElement);
    expect(personaSummary?.parentElement).toHaveAttribute('open');
    expect(screen.getByText('es_query')).toBeInTheDocument();
    expect(screen.getByText('Routing terms')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(mocks.getPersonas).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toMatch(/—/);
    expect(container.textContent).not.toMatch(/playbook/i);
  });

  it('says when the roster is off', async () => {
    mocks.getPersonas.mockResolvedValue({ enabled: false, personas: [] });
    renderPage();
    expect(await screen.findByText('Specialist personas are off')).toBeInTheDocument();
  });

  it('shows a load failure with Retry', async () => {
    mocks.getPersonas.mockRejectedValueOnce(new Error('down'));
    renderPage();
    expect(await screen.findByText('Could not load the personas')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Identity & access')).toBeInTheDocument();
  });
});
