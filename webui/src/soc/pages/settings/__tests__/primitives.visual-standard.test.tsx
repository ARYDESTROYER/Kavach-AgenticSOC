import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import {
  NumPref,
  PostureTile,
  SectionShell,
  SectionTitle,
  SwitchPref,
  TextPref,
} from '../primitives';
import { Button } from '@/ui/button';

describe('Settings form composition visual standard', () => {
  it('keeps section context and actions in one flat heading band', () => {
    const { container } = render(
      <SectionTitle
        title="Detection"
        sub="Tune deterministic detection inputs."
        actions={<Button size="sm">Reset</Button>}
      />,
    );

    expect(screen.getAllByRole('heading', { name: 'Detection', level: 2 })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Detection' }).className).toContain('text-xl');
    expect(container.firstElementChild).toHaveClass('border-b');
    expect(container.firstElementChild?.className).not.toMatch(/rounded|shadow|bg-card/);
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
  });

  it('renders the optional horizontal TOC as a flat hairline band', () => {
    const { container } = render(
      <SectionShell
        title="Data scope"
        toc={[
          { anchor: 'source', label: 'Source' },
          { anchor: 'mapping', label: 'Mapping' },
        ]}
      >
        <div id="source">Source settings</div>
        <div id="mapping">Mapping settings</div>
      </SectionShell>,
    );

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const tocBand = nav.parentElement as HTMLElement;
    expect(tocBand.className).toContain('border-y');
    // Sticky chrome wears the ONE Console material (it turns solid under reduced
    // transparency / increased contrast), never a page-local translucent fill.
    expect(tocBand.className).toContain('material-surface');
    expect(tocBand.className).not.toContain('bg-background/95');
    expect(tocBand.className).not.toMatch(/rounded|shadow|bg-card/);
    expect(container.querySelectorAll('h2')).toHaveLength(1);
  });

  it('keeps rail sections compact below md and vertical on wider editors', () => {
    render(
      <SectionShell
        title="Detection"
        rail
        toc={[
          { anchor: 'clustering', label: 'Clustering' },
          { anchor: 'risk', label: 'Risk weights' },
          { anchor: 'autonomy', label: 'Autonomy' },
        ]}
      >
        <div id="clustering">Clustering settings</div>
        <div id="risk">Risk settings</div>
        <div id="autonomy">Autonomy settings</div>
      </SectionShell>,
    );

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav.className).toContain('flex-row');
    expect(nav.className).toContain('md:flex-col');
    expect(nav.parentElement?.className).toContain('overflow-x-auto');
    expect(screen.getByRole('button', { name: 'Clustering' }).className).toContain(
      'md:border-l-2',
    );
  });

  it('wires text and numeric help copy to their controls', () => {
    render(
      <>
        <TextPref label="Index pattern" value="all-logs-*" help="Fallback source scope." onChange={() => {}} />
        <NumPref label="Batch size" value={100} help="Events per durable poll." onChange={() => {}} />
      </>,
    );

    const text = screen.getByLabelText('Index pattern');
    const number = screen.getByLabelText('Batch size');
    expect(text).toHaveAttribute('aria-describedby');
    expect(number).toHaveAttribute('aria-describedby');
    expect(document.getElementById(text.getAttribute('aria-describedby')!)).toHaveTextContent('Fallback source scope.');
    expect(document.getElementById(number.getAttribute('aria-describedby')!)).toHaveTextContent('Events per durable poll.');
  });

  it('uses divider-led switch rows without mini-card chrome', () => {
    const onChange = vi.fn();
    const { container } = render(
      <SwitchPref
        label="Polling enabled"
        help="Read from every configured pull source."
        checked={false}
        onChange={onChange}
      />,
    );

    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain('border-b');
    expect(row.className).not.toMatch(/rounded|shadow|bg-card|bg-surface/);
    const toggle = screen.getByRole('switch', { name: 'Polling enabled' });
    expect(toggle).toHaveAttribute('aria-describedby');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('renders posture as a status lane rather than a nested card', () => {
    const { container } = render(
      <PostureTile label="Authentication" on onText="Enforced" offText="Disabled" />,
    );
    const lane = container.firstElementChild as HTMLElement;
    expect(lane.className).toContain('border-l-2');
    expect(lane.className).not.toMatch(/rounded|shadow|bg-card|bg-surface/);
    expect(screen.getByText('Enforced')).toBeInTheDocument();
  });
});
