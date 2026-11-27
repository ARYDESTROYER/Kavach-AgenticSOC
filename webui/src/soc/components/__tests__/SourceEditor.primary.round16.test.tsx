/**
 * The source editor's Primary switch and its save notice (Round 16 WP15E part 2,
 * following B46):
 *
 *   - Primary is offered from the source's own ingest mode (`canBePrimary`, the rule the
 *     Sources page and the wizard use), not from the connector merely listing pull. A new
 *     source takes the connector's first mode, as the server does.
 *   - The notice says only what the server's answer confirms: "Source saved" when the
 *     returned list holds the source; "Only a pull source can be the primary source." when
 *     primary was asked for and the server kept it non-primary.
 *   - A real source added while Demo Mode is on is saved, but the list shows only the
 *     Demo sources, so the notice says where it went.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { upsertSource, demoState } = vi.hoisted(() => ({
  upsertSource: vi.fn(),
  demoState: { active: false },
}));

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
      sourceLogs: ok({ source_id: 'x', mode: 'search', count: 0, logs: [] }),
      sources: { analyzeSample: ok({ fields: [], suggested_mappings: {} }) },
      demo: { status: ok({ mode: 'off' }) },
    },
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/soc/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/demo')>();
  return {
    ...actual,
    useDemoGuard: () => ({
      active: demoState.active,
      disabled: demoState.active,
      reason: 'Not available in Demo mode, which blocks real actions.',
    }),
  };
});

import { TooltipProvider } from '@/ui/tooltip';
import { SourceEditor, SOURCE_SAVED_IN_DEMO } from '../SourceEditor';
import type { ConnectorManifest, SourceInstance } from '@/lib/types';

/** A connector that can push or pull, push first (the server's default mode). */
const EITHER: ConnectorManifest = {
  source_type: 'kafka',
  display_name: 'Kafka',
  ingest_modes: ['push', 'pull'],
  auth_fields: [],
  config_fields: [],
} as unknown as ConnectorManifest;

const PULL: ConnectorManifest = {
  source_type: 'elasticsearch',
  display_name: 'Elasticsearch',
  ingest_modes: ['pull'],
  auth_fields: [],
  config_fields: [],
} as unknown as ConnectorManifest;

const pushSource: SourceInstance = {
  id: 'kafka-1',
  source_type: 'kafka',
  display_name: 'Kafka feed',
  enabled: true,
  is_primary: false,
  ingest_mode: 'push',
  configured_secrets: [],
  config: {},
};

const pullSource: SourceInstance = {
  id: 'es-1',
  source_type: 'elasticsearch',
  display_name: 'Prod ES',
  enabled: true,
  is_primary: false,
  ingest_mode: 'pull',
  configured_secrets: [],
  config: { index_patterns: [{ pattern: 'logs-*', role: 'events', auto_correlate: true }] },
};

function renderEditor(props: { existing?: SourceInstance; connectors: ConnectorManifest[]; defaultPrimary?: boolean }) {
  const onSaved = vi.fn();
  render(
    <TooltipProvider>
      <SourceEditor {...props} onSaved={onSaved} />
    </TooltipProvider>,
  );
  return onSaved;
}

beforeEach(() => {
  demoState.active = false;
  upsertSource.mockReset();
});

describe('the Primary switch follows the source own ingest mode', () => {
  it('is not offered for a push source of a connector that can also pull', () => {
    renderEditor({ existing: pushSource, connectors: [EITHER] });
    expect(screen.getByRole('switch', { name: /Primary/ })).toBeDisabled();
  });

  it('is not offered for a new source whose connector pushes first', () => {
    renderEditor({ connectors: [EITHER] });
    fireEvent.click(screen.getByRole('button', { name: 'Select Kafka' }));
    expect(screen.getByRole('switch', { name: /Primary/ })).toBeDisabled();
  });

  it('is offered for a pull source', () => {
    renderEditor({ existing: pullSource, connectors: [PULL] });
    expect(screen.getByRole('switch', { name: /Primary/ })).toBeEnabled();
  });
});

describe('the save notice says only what the server confirmed', () => {
  it('"Source saved" when the returned list holds the source', async () => {
    upsertSource.mockResolvedValue({ ok: true, sources: [{ ...pullSource }] });
    const onSaved = renderEditor({ existing: pullSource, connectors: [PULL] });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledWith({ tone: 'success', text: 'Source saved' });
  });

  it('warns when primary was asked for and the server kept the source non-primary', async () => {
    upsertSource.mockResolvedValue({ ok: true, sources: [{ ...pullSource, is_primary: false }] });
    const onSaved = renderEditor({ existing: pullSource, connectors: [PULL] });
    fireEvent.click(screen.getByRole('switch', { name: /Primary/ }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(upsertSource.mock.calls[0][0].is_primary).toBe(true);
    expect(onSaved).toHaveBeenCalledWith({
      tone: 'warning',
      text: 'Source saved. Only a pull source can be the primary source.',
    });
  });

  it('says the source is the primary source when the server confirms it', async () => {
    upsertSource.mockResolvedValue({ ok: true, sources: [{ ...pullSource, is_primary: true }] });
    const onSaved = renderEditor({ existing: pullSource, connectors: [PULL] });
    fireEvent.click(screen.getByRole('switch', { name: /Primary/ }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledWith({ tone: 'success', text: 'Source saved. It is the primary source.' });
  });

  it('in Demo Mode, says where a confirmed real source went', async () => {
    demoState.active = true;
    upsertSource.mockImplementation((body: { id: string }) =>
      Promise.resolve({ ok: true, sources: [{ ...pullSource, id: body.id }] }),
    );
    const onSaved = renderEditor({ connectors: [PULL] });
    fireEvent.click(screen.getByRole('button', { name: 'Select Elasticsearch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(SOURCE_SAVED_IN_DEMO).toBe('Saved. Real sources appear here after Demo Mode is turned off.');
    expect(onSaved).toHaveBeenCalledWith({ tone: 'success', text: SOURCE_SAVED_IN_DEMO });
  });
});
