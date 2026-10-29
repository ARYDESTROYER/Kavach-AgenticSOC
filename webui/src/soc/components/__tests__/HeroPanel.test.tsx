/**
 * HeroPanel (Round 14, SPEC §4.9.3): the thin wrapper renders the one page header grammar.
 * The title is the page `h1`, the explanation lives in the help tip, and there is no
 * overline, icon chip or description line, whatever a legacy caller still passes.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Gauge } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/ui/tooltip';
import { HeroPanel } from '../HeroPanel';

describe('HeroPanel', () => {
  it('renders the page header grammar and ignores the retired overline and icon', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <HeroPanel
          eyebrow="COMMAND CENTER"
          icon={Gauge}
          title="Overview"
          description="Everything at a glance."
          meta="Updated 2 minutes ago"
          actions={<button type="button">Refresh</button>}
          data-testid="hero"
        >
          <p>Body below the header</p>
        </HeroPanel>
      </TooltipProvider>,
    );
    const header = screen.getByTestId('hero');
    expect(header).toHaveAttribute('data-page-header', 'page');
    expect(within(header).getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(within(header).queryByText('COMMAND CENTER')).toBeNull();
    expect(within(header).queryByText('Everything at a glance.')).toBeNull();
    expect(header.querySelectorAll('svg.lucide-gauge')).toHaveLength(0);
    expect(within(header).getByText('Updated 2 minutes ago')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByText('Body below the header')).toBeInTheDocument();

    await user.click(within(header).getByRole('button', { name: 'About Overview' }));
    expect(await screen.findByText('Everything at a glance.')).toBeInTheDocument();
  });
});
