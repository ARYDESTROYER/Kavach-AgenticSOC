/**
 * SourceEditor on the Round 14 grammar (SPEC §4.9.2 NumberField, §4.9.4 pass 2, [uib] Y4,
 * Y10): a manifest number field is the one NumberField (an APG spinbutton with its reset
 * to the connector default), the per-feed poll schedule keeps "blank means inherit" in a
 * digits-only field with the unit inside, no raw number input remains, the feed Remove
 * icon is neutral at rest, and section titles are sentence case.
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

const numberManifest: ConnectorManifest = {
  source_type: 'elasticsearch',
  display_name: 'Elasticsearch',
  ingest_modes: ['pull'],
  auth_fields: [],
  config_fields: [
    { key: 'batch_size', label: 'Batch size', type: 'number', default: 500, help: 'Events per request.' },
  ],
} as unknown as ConnectorManifest;

const existing: SourceInstance = {
  id: 'es-1',
  source_type: 'elasticsearch',
  display_name: 'Prod ES',
  enabled: true,
  is_primary: true,
  configured_secrets: [],
  config: {
    index_patterns: [{ pattern: 'all-logs-*', role: 'events', auto_correlate: true }],
    data_view_pattern: 'all-logs-*',
  },
};

const renderEditor = (source: SourceInstance = existing, manifest: ConnectorManifest = numberManifest) =>
  render(
    <TooltipProvider>
      <SourceEditor connectors={[manifest]} existing={source} onSaved={vi.fn()} />
    </TooltipProvider>,
  );

beforeEach(() => upsertSource.mockReset().mockResolvedValue({ ok: true, sources: [] }));

describe('SourceEditor on the Round 14 grammar', () => {
  it('renders a manifest number field as the one NumberField and saves the typed number', async () => {
    const { container } = renderEditor();
    const field = await screen.findByRole('spinbutton', { name: /Batch size/ });
    // Unset: the connector default shows without being stored.
    expect(field).toHaveValue('500');
    expect(container.querySelector('input[type="number"]')).toBeNull();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '250' } });
    fireEvent.blur(field);
    // The reset to the connector default appears once the value differs.
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(upsertSource).toHaveBeenCalledTimes(1));
    expect(upsertSource.mock.calls[0][0].config.batch_size).toBe(250);
  });

  it('keeps the feed poll schedule blank for "inherit", digits only, with the unit inside', async () => {
    const { container } = renderEditor();
    await screen.findByRole('button', { name: 'Remove feed 1' });
    const schedule = container.querySelector('input[id$="-sched"]') as HTMLInputElement;
    expect(container.querySelector(`label[for="${schedule.id}"]`)).toHaveTextContent('Poll schedule');
    expect(schedule).toHaveAttribute('type', 'text');
    expect(schedule).toHaveAttribute('inputmode', 'numeric');
    expect(schedule).toHaveValue('');
    expect(schedule).toHaveAttribute('placeholder', 'Inherit');
    fireEvent.change(schedule, { target: { value: '9x0' } });
    expect(schedule).toHaveValue('90');
    fireEvent.change(schedule, { target: { value: '0' } });
    expect(schedule).toHaveValue('1');
    fireEvent.change(schedule, { target: { value: '' } });
    expect(schedule).toHaveValue('');
    // The visible "s" is decorative; the field still tells assistive technology its unit.
    expect(schedule).toHaveAccessibleDescription('In seconds. Leave it blank to use the source interval.');
  });

  it('keeps the feed Remove icon neutral at rest, red only on hover and focus', async () => {
    renderEditor();
    const remove = await screen.findByRole('button', { name: 'Remove feed 1' });
    expect(remove.className).not.toMatch(/(^|\s)text-critical(-text)?(\s|$)/);
    expect(remove).toHaveClass('hover:text-critical-text', 'focus-visible:text-critical-text');
  });

  it('uses sentence-case section titles and no tracked capitals', async () => {
    const { container } = renderEditor();
    expect(await screen.findByText('Feeds')).toHaveClass('text-sm', 'font-semibold');
    for (const el of container.querySelectorAll('[class]')) {
      const cls = el.getAttribute('class') ?? '';
      expect(cls.includes('uppercase') && cls.includes('tracking-'), cls).toBe(false);
    }
  });
});
