/**
 * Round-5 Sett-C — the schema-driven "Advanced (all settings)" generic renderer.
 *
 * Proves the formerly-dead `GET /api/settings/schema` is now WIRED into an editable
 * form that:
 *   - renders scalar knobs from the schema and edits them through the shared
 *     `{prefs, update}` deep-merge buffer (never a full-doc replace),
 *   - hides curated-home blocks (e.g. notifications) so a knob isn't editable twice,
 *   - special-cases `demo` + `read_only_settings_mode` as read-only (managed elsewhere),
 *   - gives default-OFF engine features a head-of-section enable toggle that discloses
 *     the rest of the block only once enabled,
 *   - filters to setting-level via the search box.
 *
 * The api client is mocked so the test is fully offline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { schemaMock } = vi.hoisted(() => ({ schemaMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { getSettingsSchema: schemaMock },
  // LoadError (shared error panel) coerces the caught value via errorMessage → ApiError.
  ApiError: class ApiError extends Error {},
}));

import { AdvancedSchemaSection, schemaLabel, sentenceTitle } from '../advanced-schema';
import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences } from '@/lib/types';

/** A minimal schema covering: a scalar group, a curated block (hidden), a special-cased
 * key, a structured collection, and a default-OFF engine feature. */
const SCHEMA = {
  sections: [
    {
      key: 'general',
      title: 'General',
      kind: 'group' as const,
      model: null,
      fields: [
        { name: 'data_view_pattern', type: 'string' as const, default: 'all-logs-*', required: false, choices: null, description: 'The index pattern.' },
        { name: 'severity_threshold', type: 'integer' as const, default: 3, required: false, choices: null, description: 'Minimum severity.' },
        { name: 'polling_enabled', type: 'boolean' as const, default: false, required: false, choices: null, description: 'Poll for new alerts.' },
        // A structured collection — described, not edited.
        {
          name: 'rule_catalog', type: 'array' as const, default: [], required: false, choices: null, description: 'Detection rules.',
          element: { container: 'list' as const, model: 'RuleDefinition', fields: [] },
        },
        // Special-cased: never generically editable.
        { name: 'read_only_settings_mode', type: 'boolean' as const, default: false, required: false, choices: null, description: null },
      ],
    },
    {
      // Curated home → hidden from the generic long tail.
      key: 'notifications',
      title: 'Notifications',
      kind: 'object' as const,
      model: 'NotificationsConfig',
      fields: [{ name: 'enabled', type: 'boolean' as const, default: false, required: false, choices: null, description: null }],
    },
    {
      // Default-OFF engine feature → head-of-section enable toggle.
      key: 'baseline',
      title: 'Anomaly Baseline',
      kind: 'object' as const,
      model: 'BaselineConfig',
      fields: [
        { name: 'enabled', type: 'boolean' as const, default: false, required: false, choices: null, description: 'Turn on baselining.' },
        { name: 'horizon_days', type: 'integer' as const, default: 14, required: false, choices: null, description: 'Warm-up window.' },
      ],
    },
    {
      // The demo block is a nested-model SECTION (managed via /api/demo/*) — read-only here.
      // Its scalar-looking sub-fields (mode/seed/…) must NOT render as editable controls.
      key: 'demo',
      title: 'Demo',
      kind: 'object' as const,
      model: 'DemoConfig',
      fields: [
        { name: 'mode', type: 'enum' as const, default: 'off', required: false, choices: ['off', 'seeded', 'live'], description: null },
        { name: 'seed', type: 'integer' as const, default: 42, required: false, choices: null, description: null },
      ],
    },
  ],
};

function renderSection(prefs: Partial<Preferences>, update = vi.fn()) {
  const utils = render(
    <TooltipProvider>
      <AdvancedSchemaSection prefs={prefs as Preferences} update={update} />
    </TooltipProvider>,
  );
  return { update, ...utils };
}

describe('AdvancedSchemaSection (schema-driven generic renderer)', () => {
  beforeEach(() => {
    schemaMock.mockReset();
    schemaMock.mockResolvedValue(SCHEMA);
  });

  it('renders scalar knobs from the schema and edits through deep-merge update()', async () => {
    const { update } = renderSection({ data_view_pattern: 'all-logs-*', severity_threshold: 3, polling_enabled: false, baseline: { enabled: false } });
    // The general scalar knobs render (label humanised from the field name).
    await waitFor(() => expect(screen.getByLabelText('Data view pattern')).toBeInTheDocument());
    const input = screen.getByLabelText('Data view pattern') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wazuh-*' } });
    // Edit posts a MINIMAL top-level patch (only the changed key) — deep-merge-safe.
    expect(update).toHaveBeenCalledWith({ data_view_pattern: 'wazuh-*' });
  });

  it('uses the shared centered loading grammar while the schema is unresolved', () => {
    schemaMock.mockReturnValueOnce(new Promise(() => undefined));
    renderSection({});

    const loading = screen.getByRole('status', { name: 'Loading settings schema' });
    expect(loading).toHaveAttribute('data-loading-layout', 'panel');
    expect(loading.querySelector('[data-testid="console-loading-glyph"]')).toBeTruthy();
    expect(loading.querySelectorAll('[data-loading-shape]')).toHaveLength(1);
  });

  it('hides curated-home blocks (notifications) from the generic long tail', async () => {
    renderSection({ baseline: { enabled: false } });
    await waitFor(() => expect(screen.getByLabelText('Data view pattern')).toBeInTheDocument());
    // Notifications has a curated section — it must NOT appear as a generic card.
    expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
  });

  it('hides chat_agent: the Chat assistant section is its one editor', async () => {
    schemaMock.mockResolvedValueOnce({
      sections: [
        ...SCHEMA.sections,
        {
          key: 'chat_agent',
          title: 'Chat assistant',
          kind: 'object' as const,
          model: 'ChatAgentConfig',
          fields: [
            { name: 'max_tool_calls', type: 'integer' as const, default: 10, required: false, choices: null, description: 'Lookups (tool calls) per chat turn.' },
          ],
        },
      ],
    });
    renderSection({ baseline: { enabled: false } });
    await waitFor(() => expect(screen.getByLabelText('Data view pattern')).toBeInTheDocument());
    expect(screen.queryByText('Chat assistant')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Max tool calls')).not.toBeInTheDocument();
  });

  it('special-cases read_only_settings_mode (field) as read-only (managed elsewhere)', async () => {
    renderSection({ baseline: { enabled: false } });
    await waitFor(() => expect(screen.getByLabelText('Data view pattern')).toBeInTheDocument());
    // The special-cased field renders an explanatory note, NOT an editable control.
    expect(screen.queryByLabelText('Read only settings mode')).not.toBeInTheDocument();
    // Its managed-elsewhere note is present.
    expect(screen.getByText(/settings lock is managed in Organization, Advanced/i)).toBeInTheDocument();
  });

  it('humanises schema labels with known acronyms in capitals (SPEC §4.9.6)', () => {
    expect(schemaLabel('source_ip_field')).toBe('Source IP field');
    expect(schemaLabel('webhook_url')).toBe('Webhook URL');
    expect(schemaLabel('case_id_template')).toBe('Case ID template');
    expect(schemaLabel('access_ttl')).toBe('Access TTL');
    expect(schemaLabel('data_view_pattern')).toBe('Data view pattern');
  });

  it('renders the demo block as a whole read-only SECTION (no editable sub-fields)', async () => {
    renderSection({ baseline: { enabled: false } });
    await waitFor(() => expect(screen.getByLabelText('Data view pattern')).toBeInTheDocument());
    // Demo is managed via /api/demo/* — its scalar sub-fields must NOT be editable here.
    expect(screen.queryByLabelText('Mode')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Seed')).not.toBeInTheDocument();
    // …and the managed-elsewhere note is shown.
    expect(screen.getByText(/Demo mode is managed/i)).toBeInTheDocument();
  });

  it('describes a structured collection read-only (points to its curated editor)', async () => {
    renderSection({ baseline: { enabled: false } });
    await waitFor(() => expect(screen.getByLabelText('Data view pattern')).toBeInTheDocument());
    // rule_catalog is a list-of-model — shown as a read-only descriptor with its element type.
    expect(screen.getByText('Rule catalog')).toBeInTheDocument();
    expect(screen.getByText(/list of RuleDefinition/i)).toBeInTheDocument();
    // …and NOT as an editable input.
    expect(screen.queryByLabelText('Rule catalog')).not.toBeInTheDocument();
  });

  it('gates a default-OFF engine feature behind a head-of-section enable toggle', async () => {
    const { update } = renderSection({ baseline: { enabled: false } });
    await waitFor(() => expect(screen.getByText('Anomaly baseline')).toBeInTheDocument());
    // Disabled → its body control (horizon_days) is NOT disclosed.
    expect(screen.queryByLabelText('Horizon days')).not.toBeInTheDocument();
    // The enable toggle is present; flipping it posts the block enable via deep-merge.
    const toggle = screen.getByLabelText('Enable anomaly baseline');
    fireEvent.click(toggle);
    expect(update).toHaveBeenCalledWith({ baseline: { enabled: true } });
  });

  it('discloses the engine-feature body once enabled', async () => {
    renderSection({ baseline: { enabled: true, horizon_days: 14 } });
    await waitFor(() => expect(screen.getByText('Anomaly baseline')).toBeInTheDocument());
    // Enabled → the body control IS disclosed.
    expect(screen.getByLabelText('Horizon days')).toBeInTheDocument();
  });

  it('filters to setting-level via the search box', async () => {
    renderSection({ baseline: { enabled: false } });
    await waitFor(() => expect(screen.getByLabelText('Data view pattern')).toBeInTheDocument());
    const filter = screen.getByLabelText('Filter all settings');
    fireEvent.change(filter, { target: { value: 'severity' } });
    // Only the matching field remains.
    await waitFor(() => expect(screen.getByLabelText('Severity threshold')).toBeInTheDocument());
    expect(screen.queryByLabelText('Data view pattern')).not.toBeInTheDocument();
  });

  it('keeps a default-OFF engine feature GATED when only a sub-field is searched (Round-6 #42)', async () => {
    renderSection({ baseline: { enabled: false, horizon_days: 14 } });
    await waitFor(() => expect(screen.getByText('Anomaly baseline')).toBeInTheDocument());
    const filter = screen.getByLabelText('Filter all settings');
    // Search for the baseline sub-field only. The `enabled` toggle does NOT match the query,
    // so the old code filtered it out → isEngineFeature flipped false → the toggle vanished
    // and the sub-field rendered as editable despite the feature being OFF.
    fireEvent.change(filter, { target: { value: 'horizon' } });
    // The head enable toggle is still present (the block stays gated)…
    await waitFor(() => expect(screen.getByLabelText('Enable anomaly baseline')).toBeInTheDocument());
    // …and because the feature is OFF, the matched sub-field stays HIDDEN behind the toggle.
    expect(screen.queryByLabelText('Horizon days')).not.toBeInTheDocument();
  });

  it('shows an error + retry when the schema fetch fails', async () => {
    schemaMock.mockRejectedValueOnce(new Error('boom'));
    renderSection({});
    await waitFor(() => expect(screen.getByText(/Could not load the settings schema/i)).toBeInTheDocument());
  });
});

describe('sentenceTitle (group titles in sentence case, SPEC §3.1 and §4.9.1)', () => {
  beforeEach(() => {
    schemaMock.mockReset();
    schemaMock.mockResolvedValue(SCHEMA);
  });

  it('lower-cases every word after the first and keeps known acronyms', () => {
    // The backend sends Title Case (`settings_schema._SECTION_TITLES`) and `str.title()`
    // for any key it has no name for; every group title reads in sentence case.
    expect(sentenceTitle('SLA Policy')).toBe('SLA policy');
    expect(sentenceTitle('Cross-Source Correlation')).toBe('Cross-source correlation');
    expect(sentenceTitle('Threshold Tuning')).toBe('Threshold tuning');
    expect(sentenceTitle('Case ID Format')).toBe('Case ID format');
    expect(sentenceTitle('Caps / Kill Switch')).toBe('Caps / kill switch');
    expect(sentenceTitle('Auto-Close (legacy)')).toBe('Auto-close (legacy)');
    expect(sentenceTitle('RAG')).toBe('RAG');
    expect(sentenceTitle('Single Sign-On')).toBe('Single sign-on');
    // An unknown key's `str.title()` fallback reads the same way.
    expect(sentenceTitle('Some New Block')).toBe('Some new block');
    // Already sentence case is unchanged.
    expect(sentenceTitle('Chat assistant')).toBe('Chat assistant');
  });

  it('reads mid-sentence for the engine-feature switch, still keeping acronyms', () => {
    expect(sentenceTitle('Threshold Tuning', { midSentence: true })).toBe('threshold tuning');
    expect(sentenceTitle('SLA Policy', { midSentence: true })).toBe('SLA policy');
  });

  it('renders the group title and the enable switch label in sentence case', async () => {
    renderSection({ baseline: { enabled: false } });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Anomaly baseline', level: 3 })).toBeInTheDocument());
    expect(screen.queryByText('Anomaly Baseline')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable anomaly baseline' })).toBeInTheDocument();
  });
});
