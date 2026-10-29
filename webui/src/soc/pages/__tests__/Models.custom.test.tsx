/**
 * Models — "Add local model" (self-hosted / LiteLLM) dialog tests (task 7).
 *
 * Asserts the Catalog tab exposes an "Add local model" action, the dialog posts the
 * expected body to POST /api/llm/models/custom (reusing the openai_compatible path,
 * $0), the optional "Fetch models" probe hits POST /api/llm/providers/test, and a
 * registered local model can be removed. The modelsApi client is mocked (no network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { addCustomMock, removeCustomMock, providersTestMock, catalogMock, providersMock } =
  vi.hoisted(() => ({
    addCustomMock: vi.fn(),
    removeCustomMock: vi.fn(),
    providersTestMock: vi.fn(),
    catalogMock: vi.fn(),
    providersMock: vi.fn(),
  }));

vi.mock('../Models.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Models.api')>();
  return {
    ...actual,
    modelsApi: {
      ...actual.modelsApi,
      catalog: catalogMock,
      providers: providersMock,
      addCustom: addCustomMock,
      removeCustom: removeCustomMock,
      providersTest: providersTestMock,
    },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'tester', authEnabled: false, hasPermission: () => true }),
}));

vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  return {
    ...actual,
    // Bypass the route guard + grant manage in the test.
    ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useCan: () => true,
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import type * as React from 'react';
import { TooltipProvider } from '@/ui/tooltip';
import Models from '../Models';
import type { ModelCatalogRow, ModelsCatalogResponse, ProvidersResponse } from '../Models.api';

function row(over: Partial<ModelCatalogRow>): ModelCatalogRow {
  return {
    id: 'x',
    label: 'X',
    provider: 'openai',
    context_window: 0,
    max_output: 0,
    modalities: [],
    capabilities: [],
    input_per_million: 1,
    output_per_million: 3,
    cache_write_per_million: null,
    cache_read_per_million: null,
    batch_multiplier: 0.5,
    base_url: null,
    pricing_source: 'exact',
    assigned_roles: [],
    price_overridden: false,
    ...over,
  };
}

const CATALOG: ModelsCatalogResponse = {
  models: [row({ id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' })],
  providers: { openai: ['gpt-4o'] },
  configured: {},
  overrides: {},
};

const PROVIDERS: ProvidersResponse = {
  providers: [{ name: 'openai_compatible', configured: true, models: [], supports_base_url: true }],
};

function renderPage() {
  return render(
    <TooltipProvider>
      <Models />
    </TooltipProvider>,
  );
}

describe('Models — Add local model', () => {
  beforeEach(() => {
    catalogMock.mockReset();
    providersMock.mockReset();
    addCustomMock.mockReset();
    removeCustomMock.mockReset();
    providersTestMock.mockReset();
    catalogMock.mockResolvedValue(CATALOG);
    providersMock.mockResolvedValue(PROVIDERS);
    addCustomMock.mockResolvedValue({ ok: true, model: {}, configured: {} });
    providersTestMock.mockResolvedValue({ ok: true, models: ['llama-3.1-8b'] });
  });

  it('posts the expected body to POST /api/llm/models/custom', async () => {
    renderPage();
    // Open the dialog from the Catalog tab toolbar.
    const openBtn = await screen.findByRole('button', { name: /add local model/i });
    fireEvent.click(openBtn);

    fireEvent.change(await screen.findByLabelText(/base url/i), {
      target: { value: 'http://localhost:4000/v1' },
    });
    fireEvent.change(screen.getByLabelText(/model id/i), {
      target: { value: 'llama-3.1-8b-instruct' },
    });
    fireEvent.change(screen.getByLabelText(/^label/i), { target: { value: 'Team Llama' } });

    fireEvent.click(screen.getByRole('button', { name: /add model/i }));

    await waitFor(() => expect(addCustomMock).toHaveBeenCalledTimes(1));
    expect(addCustomMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model_id: 'llama-3.1-8b-instruct',
        base_url: 'http://localhost:4000/v1',
        label: 'Team Llama',
      }),
    );
  });

  it('fetches models from the endpoint via the reachability probe', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add local model/i }));
    fireEvent.change(await screen.findByLabelText(/base url/i), {
      target: { value: 'http://litellm:4000/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /fetch models/i }));
    await waitFor(() => expect(providersTestMock).toHaveBeenCalledWith('http://litellm:4000/v1', undefined));
    // The fetched id populates the model-id picker.
    expect(await screen.findByText('llama-3.1-8b')).toBeInTheDocument();
  });

  it('lists a registered local model with a Remove action', async () => {
    catalogMock.mockResolvedValue({
      ...CATALOG,
      models: [
        ...CATALOG.models,
        row({
          id: 'team-llama',
          label: 'Team Llama',
          provider: 'openai_compatible',
          input_per_million: 0,
          output_per_million: 0,
          base_url: 'http://litellm:4000/v1',
          is_custom: true,
        }),
      ],
    });
    removeCustomMock.mockResolvedValue({ ok: true, model: 'team-llama', removed: true });
    renderPage();

    // The local-models panel shows the row + a Remove control.
    const removeBtn = await screen.findByRole('button', { name: /remove team-llama/i });
    expect(screen.getByRole('region', { name: 'Local and self-hosted models' })).toBeInTheDocument();
    // Round 14: the remove icon is neutral at rest (red only on hover or focus).
    expect(removeBtn).toHaveClass('text-muted-foreground');
    expect(removeBtn.className).not.toMatch(/(^|\s)text-critical(\s|$)/);
    fireEvent.click(removeBtn);
    await waitFor(() => expect(removeCustomMock).toHaveBeenCalledWith('team-llama'));
  });

  it('explains first-use recovery when no provider is registered', async () => {
    providersMock.mockResolvedValue({ providers: [] });
    renderPage();

    await userEvent.click(await screen.findByRole('tab', { name: 'Providers' }));

    const empty = await screen.findByRole('group', {
      name: 'No model providers are registered',
    });
    expect(empty).toHaveAttribute('data-empty-state', 'first-use');
    expect(empty).toHaveAccessibleDescription(
      /open Settings.*Secret keys.*hosted provider.*self-hosted model/i,
    );
  });
});

describe('Models on the Round 14 console grammar (MO1 to MO4)', () => {
  beforeEach(() => {
    catalogMock.mockReset();
    providersMock.mockReset();
    catalogMock.mockResolvedValue({
      ...CATALOG,
      models: [
        ...CATALOG.models,
        row({ id: 'claude-x', label: 'Claude X', provider: 'anthropic', price_overridden: true }),
      ],
    });
    providersMock.mockResolvedValue({
      providers: [
        { name: 'openai', configured: true, models: ['gpt-4o'], supports_base_url: false },
        { name: 'anthropic', configured: false, models: [], supports_base_url: false },
      ],
    });
  });

  it('heads the page with "Models", a help tip and an icon Refresh', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Models' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Models' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh models' })).toBeInTheDocument();
    expect(screen.queryByText('Models & LLMs')).toBeNull();
    expect(screen.queryByText('Administration')).toBeNull();
  });

  it('shows the counts as a compact strip, underline tabs and the catalog in a panel', async () => {
    renderPage();
    const strip = await screen.findByRole('group', { name: 'Model summary' });
    expect(strip).toHaveAttribute('data-kpi-strip', 'compact');
    expect(strip.querySelectorAll('svg')).toHaveLength(0);
    expect(screen.getByRole('tablist')).toHaveAttribute('data-variant', 'underline');
    const catalog = screen.getByRole('region', { name: 'Catalog' });
    expect(catalog).toHaveClass('surface-panel');
    expect(within(catalog).getByRole('combobox', { name: 'Filter by provider' })).toBeInTheDocument();
    expect(within(catalog).getByRole('button', { name: /add local model/i })).toBeInTheDocument();
  });

  it('lists providers as rows with a status in words', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Providers' }));
    const panel = await screen.findByRole('region', { name: 'Providers' });
    expect(within(panel).getByText('1 of 2 configured')).toBeInTheDocument();
    expect(within(panel).getByTestId('provider-status-openai')).toHaveTextContent('Configured');
    expect(within(panel).getByTestId('provider-status-anthropic')).toHaveTextContent('Not set');
  });

  it('sets a price override through number fields, not raw number inputs', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Override price for gpt-4o' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('spinbutton', { name: /Input per 1M/ })).toHaveValue('1');
    expect(within(dialog).getByRole('spinbutton', { name: /Output per 1M/ })).toHaveValue('3');
    expect(dialog.querySelector('input[type="number"]')).toBeNull();
  });

  it('returns focus to the row button that opened the price or test dialog (SPEC §3.3)', async () => {
    renderPage();
    const price = await screen.findByRole('button', { name: 'Override price for gpt-4o' });
    price.focus();
    fireEvent.click(price);
    const priceDialog = await screen.findByRole('dialog', { name: 'Override pricing' });
    fireEvent.click(within(priceDialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(price));
  });

  it('returns focus to Add local model when its dialog closes', async () => {
    renderPage();
    const catalog = await screen.findByRole('region', { name: 'Catalog' });
    const add = within(catalog).getByRole('button', { name: /add local model/i });
    add.focus();
    fireEvent.click(add);
    const dialog = await screen.findByRole('dialog', { name: 'Add a local model' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it('keeps em dashes out of its copy', async () => {
    renderPage();
    await screen.findByRole('region', { name: 'Catalog' });
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const offenders: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      // A lone em dash is the missing-value placeholder; a sentence break is not.
      if (text.includes('\u2014') && text.trim() !== '\u2014') offenders.push(text);
    }
    expect(offenders).toEqual([]);
  });
});
