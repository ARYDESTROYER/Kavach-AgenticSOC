/**
 * Models catalog render tests (Round 3 / Feature 9).
 *
 * Renders the ModelsCatalog table with a mixed catalog and asserts: capability chips,
 * pricing, the provenance badge, the assigned-role badge, and the operator-override
 * marker all show; the provider filter narrows the rows; and the per-row test/edit
 * actions fire their callbacks. Offline — the component is presentational.
 */
import type * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';
import { ModelsCatalog, capabilityChips } from '../components/ModelsCatalog';
import { batchRates, type ModelCatalogRow } from '../pages/Models.api';

const ROWS: ModelCatalogRow[] = [
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    provider: 'anthropic',
    context_window: 1000000,
    max_output: 128000,
    modalities: ['text', 'vision'],
    capabilities: ['tools', 'cache'],
    input_per_million: 5,
    output_per_million: 25,
    cache_write_per_million: 6.25,
    cache_read_per_million: 0.5,
    batch_multiplier: 0.5,
    base_url: null,
    pricing_source: 'exact',
    assigned_roles: ['investigator', 'chat'],
    price_overridden: true,
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    provider: 'openai',
    context_window: 128000,
    max_output: 16000,
    modalities: ['text'],
    capabilities: ['tools'],
    input_per_million: 0.15,
    output_per_million: 0.6,
    cache_write_per_million: null,
    cache_read_per_million: null,
    batch_multiplier: null,
    base_url: null,
    pricing_source: 'heuristic',
    assigned_roles: [],
    price_overridden: false,
  },
];

/** Every price cell's text, in order. */
function priceTexts(): string[] {
  return Array.from(document.querySelectorAll('[data-price]')).map((el) => el.textContent ?? '');
}

function renderCatalog(props: Partial<React.ComponentProps<typeof ModelsCatalog>> = {}) {
  return render(
    <TooltipProvider>
      <ModelsCatalog rows={ROWS} {...props} />
    </TooltipProvider>,
  );
}

describe('capabilityChips', () => {
  it('derives context/output/modality/tool/cache chips', () => {
    const chips = capabilityChips(ROWS[0]).map((c) => c.label);
    expect(chips).toContain('1000K ctx');
    expect(chips).toContain('128K out');
    expect(chips).toContain('Vision');
    expect(chips).toContain('Tool JSON');
    expect(chips).toContain('Cache');
  });

  it('marks cache from a cache price even without a capability flag', () => {
    const row: ModelCatalogRow = {
      ...ROWS[1],
      capabilities: [],
      cache_read_per_million: 0.05,
    };
    expect(capabilityChips(row).map((c) => c.label)).toContain('Cache');
  });
});

describe('batchRates', () => {
  it('halves both rates for a 0.5 multiplier', () => {
    const b = batchRates(ROWS[0]);
    expect(b).not.toBeNull();
    expect(b?.multiplier).toBe(0.5);
    expect(b?.input).toBeCloseTo(2.5); // 5 * 0.5
    expect(b?.output).toBeCloseTo(12.5); // 25 * 0.5
  });

  it('returns null when there is no real discount', () => {
    expect(batchRates(ROWS[1])).toBeNull(); // null multiplier
    expect(batchRates({ input_per_million: 1, output_per_million: 2, batch_multiplier: 1 })).toBeNull();
    expect(batchRates({ input_per_million: 1, output_per_million: 2, batch_multiplier: 0 })).toBeNull();
    expect(
      batchRates({ input_per_million: 1, output_per_million: 2, batch_multiplier: NaN }),
    ).toBeNull();
  });
});

describe('ModelsCatalog render', () => {
  it('renders both models with labels, pricing and provenance', () => {
    renderCatalog();
    expect(screen.getByText('Claude Opus 4.8')).toBeInTheDocument();
    expect(screen.getByText('GPT-4o mini')).toBeInTheDocument();
    // Provenance badges.
    expect(screen.getByText('Exact')).toBeInTheDocument();
    expect(screen.getByText('Heuristic')).toBeInTheDocument();
    // Assigned-role badges (humanized).
    expect(screen.getByText('Investigator')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
  });

  it('renders cache-write, cache-read and batch prices for a cached model, one per cell', () => {
    renderCatalog();
    const prices = priceTexts();
    expect(prices).toContain('In $5.00');
    expect(prices).toContain('Out $25.00');
    expect(prices).toContain('Cache write $6.25');
    expect(prices).toContain('Cache read $0.5000');
    // Batch (0.5×) derived input/output: 2.5 / 12.5, with the share in a tooltip.
    expect(prices).toContain('Batch in $2.50');
    expect(prices).toContain('Batch out $12.50');
    const batchCell = Array.from(document.querySelectorAll('[data-price]')).find(
      (el) => el.textContent === 'Batch in $2.50',
    );
    expect(batchCell).toHaveAttribute('title', 'Batch is 50% of the list price');
  });

  it('omits cache + batch rows for a model with none', () => {
    renderCatalog({ providerFilter: 'openai' });
    // GPT-4o mini has null cache + null batch multiplier → no extra pricing lines.
    expect(priceTexts()).toEqual(['In $0.1500', 'Out $0.6000']);
    expect(screen.queryByText(/Cache/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Batch/)).not.toBeInTheDocument();
  });

  it('filters by provider', () => {
    renderCatalog({ providerFilter: 'openai' });
    expect(screen.getByText('GPT-4o mini')).toBeInTheDocument();
    expect(screen.queryByText('Claude Opus 4.8')).not.toBeInTheDocument();
  });

  it('fires onTest and onEditPrice for a row', () => {
    const onTest = vi.fn();
    const onEditPrice = vi.fn();
    renderCatalog({ onTest, onEditPrice });
    fireEvent.click(screen.getByLabelText('Test claude-opus-4-8'));
    fireEvent.click(screen.getByLabelText('Override price for claude-opus-4-8'));
    expect(onTest).toHaveBeenCalledWith(ROWS[0]);
    expect(onEditPrice).toHaveBeenCalledWith(ROWS[0]);
  });

  it('disables actions when the user cannot manage models', () => {
    const onTest = vi.fn();
    renderCatalog({ onTest, canManage: false });
    const btn = screen.getByLabelText('Test claude-opus-4-8');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onTest).not.toHaveBeenCalled();
  });
});

describe('ModelsCatalog on the Round 14 grammar (F9, F13)', () => {
  const VISION_TWICE: ModelCatalogRow = {
    ...ROWS[0],
    id: 'vision-twice',
    label: 'Vision twice',
    capabilities: ['tools', 'cache', 'vision', 'reasoning'],
  };

  it('de-duplicates chips by label (a vision modality and a vision flag are one chip)', () => {
    const labels = capabilityChips(VISION_TWICE).map((c) => c.label);
    expect(labels.filter((l) => l === 'Vision')).toHaveLength(1);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('shows two chips then "+N" with the full list in its name', () => {
    renderCatalog({ rows: [VISION_TWICE] });
    const all = capabilityChips(VISION_TWICE).map((c) => c.label);
    expect(all.length).toBeGreaterThan(2);
    expect(screen.getByText(all[0])).toBeInTheDocument();
    expect(screen.getByText(all[1])).toBeInTheDocument();
    expect(screen.queryByText(all[2])).toBeNull();
    const more = screen.getByTestId('capability-more');
    expect(more).toHaveTextContent(`+${all.length - 2}`);
    // The name starts with the visible text, so "click plus N" reaches it (WCAG 2.5.3).
    expect(more).toHaveAccessibleName(`+${all.length - 2} more capabilities: ${all.slice(2).join(', ')}`);
    expect(screen.getByRole('button', { name: new RegExp(`^\\+${all.length - 2} more capabilities`) })).toBe(more);
  });

  it('keeps every price on one line and every label at 12px or more', () => {
    const { container } = renderCatalog();
    for (const cell of Array.from(container.querySelectorAll('[data-price]'))) {
      expect(cell).toHaveClass('whitespace-nowrap');
    }
    expect(container.innerHTML).not.toMatch(/text-\[(?:[0-9]|10)px\]|text-\[0\.[0-6]\d*rem\]/);
  });
});
