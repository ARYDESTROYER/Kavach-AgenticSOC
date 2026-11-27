/**
 * SourceEditor — the DECLARED severity-ladder ceiling must be reachable from the Console.
 *
 * `severity_scale_max` is the ONE number that tells the suite what a source's native
 * severity range is. Without a control for it the documented remedy for a ~10x band drop
 * ("declare the ceiling") would only be reachable by hand-posting `POST /api/sources`.
 *
 * The three-state wire contract is what these tests pin: a blank field CLEARS the
 * declaration (explicit `null`), a number DECLARES it, and an unusable value is caught
 * before the request instead of being sent for the backend to 422.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const upsertSource = vi.fn();

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    api: {
      upsertSource: (body: unknown) => upsertSource(body),
      updateSecrets: ok({ ok: true }),
      setSourceSecrets: ok({ ok: true, configured_secrets: [] }),
      sourceLogs: ok({ source_id: 'es-1', mode: 'search', count: 0, logs: [] }),
      sources: { analyzeSample: ok({ fields: [], suggested_mappings: {} }) },
      demo: { status: ok({ mode: 'off' }) },
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TooltipProvider } from '@/ui/tooltip';
import { SourceEditor } from '../SourceEditor';
import type { ConnectorManifest, SourceInstance } from '@/lib/types';

const manifest: ConnectorManifest = {
  source_type: 'elasticsearch',
  display_name: 'Elasticsearch',
  ingest_modes: ['pull'],
  auth_fields: [],
  config_fields: [],
} as unknown as ConnectorManifest;

const existing: SourceInstance = {
  id: 'es-1',
  source_type: 'elasticsearch',
  display_name: 'Prod ES',
  enabled: true,
  is_primary: true,
  configured_secrets: [],
  config: { index_patterns: [{ pattern: 'all-logs-*', role: 'events' }] },
};

const renderEditor = (source: SourceInstance) =>
  render(
    <TooltipProvider>
      <SourceEditor connectors={[manifest]} existing={source} onSaved={vi.fn()} />
    </TooltipProvider>,
  );

/** The control lives under the collapsed "Advanced" disclosure — open it first. */
const openAdvanced = () =>
  fireEvent.click(screen.getByRole('button', { name: /advanced .* severity scale/i }));
const field = () => document.getElementById('se-sev-scale') as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

beforeEach(() => upsertSource.mockReset().mockResolvedValue({ ok: true, sources: [] }));

describe('SourceEditor — declared severity ladder ceiling', () => {
  it('renders the stored declaration and sends an edited one', async () => {
    renderEditor({ ...existing, severity_scale_max: 16 });
    openAdvanced();
    expect(field().value).toBe('16');

    fireEvent.change(field(), { target: { value: '10' } });
    save();
    await waitFor(() => expect(upsertSource).toHaveBeenCalledTimes(1));
    expect(upsertSource.mock.calls[0][0].severity_scale_max).toBe(10);
  });

  it('is blank when undeclared, and a blank field CLEARS the declaration', async () => {
    renderEditor(existing);
    openAdvanced();
    expect(field().value).toBe('');

    save();
    await waitFor(() => expect(upsertSource).toHaveBeenCalledTimes(1));
    const body = upsertSource.mock.calls[0][0];
    // Present-and-null, not omitted: the operator is stating "no declaration".
    expect('severity_scale_max' in body).toBe(true);
    expect(body.severity_scale_max).toBeNull();
  });

  it('refuses a non-positive ceiling before it reaches the API', async () => {
    renderEditor(existing);
    openAdvanced();
    fireEvent.change(field(), { target: { value: '0' } });
    save();
    expect(await screen.findByText(/greater than 0/i)).toBeInTheDocument();
    expect(upsertSource).not.toHaveBeenCalled();
  });
});
