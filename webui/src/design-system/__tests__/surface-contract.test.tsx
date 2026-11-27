/**
 * Shared Console surface contract.
 *
 * These assertions deliberately pin the small set of classes that make the UI read
 * as one command surface: compact, quiet controls with concentric radii (an 8px rail
 * holding 6px targets), border-first sections, and no default resting elevation. A page should compose these primitives instead of
 * reintroducing pill tabs or card-on-card shadows.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Settings } from 'lucide-react';

import { Card } from '@/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { ControlBar } from '@/soc/components/ControlBar';
import { FilterBar } from '@/soc/components/FilterBar';
import { EmptyState } from '@/soc/components/EmptyState';
import { SettingsCard } from '@/soc/components/SettingsGrid';

describe('Console surface contract', () => {
  it('keeps cards border-first and makes elevation an explicit opt-in', () => {
    const { rerender } = render(<Card data-testid="card">Body</Card>);
    expect(screen.getByTestId('card')).toHaveClass('rounded-md', 'border-border/80');
    expect(screen.getByTestId('card')).not.toHaveClass('shadow-elev1');

    rerender(
      <Card data-testid="card" elevation="sm">
        Body
      </Card>,
    );
    expect(screen.getByTestId('card')).toHaveClass('shadow-elev1');
  });

  it('uses one compact concentric grammar for tabs and value segments', () => {
    render(
      <>
        <Tabs defaultValue="overview">
          <TabsList aria-label="Case views">
            <TabsTrigger value="overview">Overview</TabsTrigger>
          </TabsList>
        </Tabs>
        <SegmentedControl
          aria-label="Density"
          value="compact"
          onValueChange={() => {}}
          options={[{ value: 'compact', label: 'Compact' }]}
        />
      </>,
    );

    const tabList = screen.getByRole('tablist', { name: 'Case views' });
    const tab = screen.getByRole('tab', { name: 'Overview' });
    const segments = screen.getByRole('radiogroup', { name: 'Density' });
    const segment = screen.getByRole('radio', { name: 'Compact' });

    expect(tabList).toHaveClass('h-9', 'rounded-md', 'bg-transparent');
    expect(segments).toHaveClass('h-9', 'rounded-md', 'bg-transparent');
    // Round 12: the inner target is concentric with its 8px rail (6px, `rounded-sm`),
    // replacing the squared 3px — and tabs and segments still match each other.
    expect(tab).toHaveClass('h-8', 'rounded-sm');
    expect(segment).toHaveClass('h-7', 'rounded-sm');
    expect(tab.className).not.toContain('shadow-sm');
    expect(segment.className).not.toContain('shadow-sm');
  });

  it('keeps operational control bands and settings sections flat', () => {
    const { container } = render(
      <>
        <ControlBar
          variant="bordered"
          label="Page actions"
          controls={<button type="button">Refresh</button>}
        />
        <FilterBar aria-label="Page filters" variant="band">
          <button type="button">Severity</button>
        </FilterBar>
        <SettingsCard title="Detection" icon={Settings}>
          Fields
        </SettingsCard>
      </>,
    );

    const controlBar = screen.getByRole('group', { name: 'Page actions' }).parentElement;
    // A labelled group, never a toolbar (no roving-focus model; Round 14).
    const filterBar = screen.getByRole('group', { name: 'Page filters' });
    const section = container.querySelector('section');

    expect(controlBar).toHaveClass('rounded-md', 'border-border/80');
    expect(controlBar?.className).not.toContain('shadow-elev1');
    expect(filterBar).toHaveClass('border-y', 'bg-transparent');
    expect(filterBar.className).not.toContain('rounded-lg');
    expect(section).toHaveClass('border-t', 'bg-transparent');
    expect(section?.className).not.toContain('border-y');
  });

  it('uses a compact squared icon marker for empty states', () => {
    const { container } = render(<EmptyState title="Nothing to review" />);
    const iconMarker = container.querySelector('svg')?.parentElement;
    expect(iconMarker).toHaveClass('size-11', 'rounded-md');
    expect(iconMarker?.className).not.toContain('rounded-full');
  });
});
