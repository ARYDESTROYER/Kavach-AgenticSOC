/**
 * Data scope settings section (Round-5 Sett-A decomposition; Round 14 grouped panels).
 *
 * The connected sources (a row that opens the Sources page), the fallback index pattern
 * and entity field mapping, the case evidence fields, and the durable poller. Every
 * value is operator-entered (trusted).
 */
import * as React from 'react';

import { api } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { TagInput } from '@/soc/components/TagInput';

import {
  NumPref,
  SettingRow,
  SettingsGroup,
  SettingsSection,
  TextPref,
  type NavigateFn,
  type SecProps,
} from './primitives';

/** The 16rem column a field path takes; numbers use the 8rem NumberField width. */
const PATH_WIDTH = '16rem';
const NUMBER_WIDTH = '8rem';

/**
 * "Connected sources" as one navigation row with its count ("5 of 5 enabled"), read
 * from the Sources API so it matches the Sources page (Demo Mode included). While the
 * count loads, or if it cannot be read, the row shows no value rather than a guess.
 */
function ConnectedSourcesRow() {
  const [count, setCount] = React.useState<{ enabled: number; total: number } | null>(null);
  React.useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.listSources())
      .then((res) => {
        if (!live) return;
        const rows = Array.isArray(res?.sources) ? res.sources : [];
        setCount({ enabled: rows.filter((row) => row.enabled !== false).length, total: rows.length });
      })
      .catch(() => {
        if (live) setCount(null);
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <SettingRow
      variant="link"
      label="Connected sources"
      help="SIEM, EDR, queue and push receivers. Each source can override the mapping below."
      href="#/sources"
      value={count ? `${fmtNumber(count.enabled)} of ${fmtNumber(count.total)} enabled` : undefined}
    />
  );
}

export function GeneralSection({
  prefs,
  update,
}: SecProps & { onNavigate?: NavigateFn }) {
  const path = (label: string, value: string | undefined, onChange: (v: string) => void, help?: string) => (
    <SettingRow variant="field" controlWidth={PATH_WIDTH} mono>
      <TextPref label={label} value={value} help={help} onChange={onChange} />
    </SettingRow>
  );
  return (
    <SettingsSection title="Data scope">
      <SettingsGroup
        id="general-sources"
        title="Data sources"
        caption="Sources are added, tested and browsed on the Sources page."
      >
        <ConnectedSourcesRow />
      </SettingsGroup>

      <SettingsGroup
        id="general-mapping"
        title="Log scope and field mapping"
        caption="Used when a source does not set its own."
      >
        {path('Log index pattern', prefs.data_view_pattern, (v) => update({ data_view_pattern: v }))}
        {path('Timestamp field', prefs.time_field, (v) => update({ time_field: v }))}
        {path('Source IP field', prefs.source_ip_field, (v) => update({ source_ip_field: v }))}
        {path('User field', prefs.user_field, (v) => update({ user_field: v }))}
        {path('Host field', prefs.host_field, (v) => update({ host_field: v }))}
        {path('Rule or module field', prefs.rule_field, (v) => update({ rule_field: v }))}
        {path('Rule name field', prefs.rule_name_field, (v) => update({ rule_name_field: v }))}
        {path('Severity field', prefs.severity_field, (v) => update({ severity_field: v }))}
        <SettingRow variant="field" controlWidth={NUMBER_WIDTH}>
          <NumPref
            label="Severity threshold"
            help="Events below this severity are not read."
            value={prefs.severity_threshold}
            step={0.5}
            onChange={(v) => update({ severity_threshold: v })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth={PATH_WIDTH}>
          <TextPref
            label="Investigate lookback"
            help="Starting window for a manual entity investigation, for example now-24h."
            value={prefs.investigate_lookback}
            onChange={(v) => update({ investigate_lookback: v })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        id="general-evidence"
        title="Case evidence fields"
        caption="The raw fields the agent sees for each event and searches with free text."
      >
        <SettingRow variant="field" wide mono>
          <TagInput
            label="Evidence fields"
            value={prefs.evidence_fields ?? []}
            onChange={(v) => update({ evidence_fields: v })}
            placeholder="Add a field"
            description="Dotted paths added to each event's identity fields. Use * for the whole record, bounded by the budget below; an empty list sends identity fields only. A source can set its own list."
            validate={(tag) => (tag.length > 128 ? 'Field paths are limited to 128 characters.' : null)}
            max={64}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth={NUMBER_WIDTH}>
          <NumPref
            label="Evidence budget per event"
            help="Characters per event. 0 sends identity fields only. An investigation reads 12 sample events, so the budget multiplies."
            value={prefs.evidence_max_chars_per_event}
            min={0}
            max={16000}
            step={100}
            onChange={(v) => update({ evidence_max_chars_per_event: v })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        id="general-polling"
        title="Polling"
        caption="The background poller reads new events on a durable cursor: nothing skipped, nothing twice."
      >
        <SettingRow
          variant="switch"
          label="Polling enabled"
          help="Off in some deployments, where sources push events instead."
          checked={Boolean(prefs.polling_enabled)}
          onCheckedChange={(v) => update({ polling_enabled: v })}
        />
        <SettingRow variant="field" controlWidth={NUMBER_WIDTH}>
          <NumPref
            label="Poll interval"
            help="Time between reads."
            unit="s"
            value={prefs.poll_interval_seconds}
            min={1}
            onChange={(v) => update({ poll_interval_seconds: v })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth={NUMBER_WIDTH}>
          <NumPref
            label="Poll batch size"
            help="Events read per poll."
            value={prefs.poll_batch_size}
            min={1}
            onChange={(v) => update({ poll_batch_size: v })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth={NUMBER_WIDTH}>
          <NumPref
            label="Cold-start lookback"
            help="How far back the first read starts."
            unit="min"
            value={prefs.cold_start_lookback_minutes}
            min={0}
            onChange={(v) => update({ cold_start_lookback_minutes: v })}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
