/**
 * `WidgetGallery` tests (Round 5 / G7, CD4 step 3): add-from-a-curated-gallery.
 *
 * Asserts the gallery lists registry widgets (curated, not a blank canvas), RBAC-filters
 * entries the caller lacks the grant for, and that picking one calls `onAdd` with a
 * fresh, ALLOWLISTED widget instance (a known registry type + a stable id + the
 * registry default size).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { WidgetGallery, makeWidget } from '@/soc/dashboard/WidgetGallery';
import { isKnownWidgetType, WIDGET_TYPES } from '@/soc/dashboard/registry';
import { widgetId } from '@/soc/dashboard/layout-utils';

describe('WidgetGallery: curated add', () => {
  it('lists registry widgets and adds a fresh allowlisted instance on pick', () => {
    const onAdd = vi.fn();
    render(<WidgetGallery open onOpenChange={vi.fn()} onAdd={onAdd} />);

    // A curated gallery: several registry widgets are offered (not a blank canvas).
    expect(screen.getByText('Awaiting a decision')).toBeInTheDocument();
    expect(screen.getByText('Cases by verdict')).toBeInTheDocument();

    // Pick the Needs human count ("Awaiting a decision").
    fireEvent.click(screen.getByRole('button', { name: 'Add Awaiting a decision' }));
    expect(onAdd).toHaveBeenCalledTimes(1);

    const added = onAdd.mock.calls[0][0];
    // The added widget carries a KNOWN (allowlisted) type + a stable id.
    expect(isKnownWidgetType(added.type)).toBe(true);
    expect(added.type).toBe('kpi.needs_human');
    expect(widgetId(added).length).toBeGreaterThan(0);
    // …and its registry default size.
    expect(added.w).toBeGreaterThan(0);
    expect(added.h).toBeGreaterThan(0);
  });

  it('RBAC-filters entries the caller lacks the grant for', () => {
    const onAdd = vi.fn();
    // Deny cost: the "AI spend" widget (requires cost:view) is hidden.
    const can = (resource: string) => resource !== 'cost';
    render(<WidgetGallery open onOpenChange={vi.fn()} can={can} onAdd={onAdd} />);

    expect(screen.getByText('Awaiting a decision')).toBeInTheDocument();
    expect(screen.queryByText('AI spend')).not.toBeInTheDocument();
  });

  it('makeWidget only produces registry-allowlisted types', () => {
    for (const t of WIDGET_TYPES) {
      const wdt = makeWidget(t);
      expect(isKnownWidgetType(wdt.type)).toBe(true);
    }
  });
});
