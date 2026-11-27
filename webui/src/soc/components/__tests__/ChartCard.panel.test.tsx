/**
 * ChartCard on the shared Panel (Round 14, SPEC §4.9.2 "ChartPanel", operator choice C7
 * option 1): the Analytics modules and the dashboard widget bodies keep the component name
 * and API, but render as the Overview's tinted module, with the panel's 14px title row,
 * no header rule and no icon chip.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Crosshair } from 'lucide-react';

import { ChartCard, ChartEmpty } from '../ChartCard';

describe('ChartCard renders on the Panel', () => {
  it('is a labelled tinted region with the instrument title and no card chrome', () => {
    render(
      <ChartCard title="Verdict mix" icon={Crosshair} accentClass="text-high">
        <div>chart</div>
      </ChartCard>,
    );
    const region = screen.getByRole('region', { name: 'Verdict mix' });
    expect(region).toHaveClass('surface-panel', 'p-4', 'xl:p-5', '3xl:p-6', 'flex', 'flex-col');
    expect(region.className).not.toMatch(/\b(rounded-lg|border|bg-card)\b/);
    expect(within(region).getByRole('heading', { level: 2, name: 'Verdict mix' })).toHaveClass('text-base');
    // The icon prop is still accepted (no caller breaks) but draws nothing.
    expect(region.querySelector('svg')).toBeNull();
    // No header rule.
    expect(region.querySelector('.border-b')).toBeNull();
  });

  it('puts the action on the right of the title row and the caption on its baseline', () => {
    render(
      <ChartCard title="Top rules" icon={Crosshair} caption="last 7 days" action={<button type="button">Export</button>}>
        <div>chart</div>
      </ChartCard>,
    );
    const row = screen.getByRole('heading').closest('[data-panel-title-row]') as HTMLElement;
    expect(within(row).getByText('last 7 days')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });

  it('titles a module h2 by default and h3 inside a titled group, keeping the outline (WCAG 1.3.1)', () => {
    render(
      <section aria-labelledby="group">
        <h2 id="group">Response times</h2>
        <ChartCard title="Time to acknowledge" level={3}>
          <div>chart</div>
        </ChartCard>
        <ChartCard title="Burn-down">
          <div>chart</div>
        </ChartCard>
      </section>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Time to acknowledge' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Burn-down' })).toBeInTheDocument();
    // Still a region named by its own heading at either level.
    expect(screen.getByRole('region', { name: 'Time to acknowledge' })).toHaveClass('surface-panel');
  });

  it('works without an icon and renders the title as plain text (#9)', () => {
    render(<ChartCard title="<b>x</b>">body</ChartCard>);
    expect(screen.getByRole('heading').textContent).toBe('<b>x</b>');
  });

  it('keeps the empty hint centred and plain', () => {
    render(<ChartEmpty>No data in this window</ChartEmpty>);
    expect(screen.getByText('No data in this window')).toHaveClass('text-center', 'text-muted-foreground');
  });
});
