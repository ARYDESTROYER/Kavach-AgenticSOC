/**
 * General & data scope settings section (Round-5 Sett-A decomposition).
 *
 * Lifted verbatim from the former `Settings.tsx` `GeneralSection`. The fallback
 * index pattern, entity field mapping, and durable-poller controls. Every value is
 * operator-entered (trusted).
 */
import { Database, RefreshCw, ScanSearch, SlidersHorizontal } from 'lucide-react';

import { Button } from '@/ui/button';
import { SettingsGrid, SettingsCard, type SettingsTOCItem } from '@/soc/components/SettingsGrid';
import { TagInput } from '@/soc/components/TagInput';

import {
  SectionShell,
  NumPref,
  SwitchPref,
  TextPref,
  type NavigateFn,
  type SecProps,
} from './primitives';

const GENERAL_TOC: SettingsTOCItem[] = [
  { anchor: 'general-sources', label: 'Data sources', icon: Database },
  { anchor: 'general-mapping', label: 'Log scope & mapping', icon: SlidersHorizontal },
  { anchor: 'general-evidence', label: 'Case evidence fields', icon: ScanSearch },
  { anchor: 'general-polling', label: 'Polling', icon: RefreshCw },
];

export function GeneralSection({
  prefs,
  update,
  onNavigate,
}: SecProps & { onNavigate?: NavigateFn }) {
  return (
    <SectionShell
      // Match the Round-5 rail label (SETTINGS_SECTIONS_META title = 'Data scope') so the
      // nav item and the body heading agree; the longer phrasing lives in `sub` (mirrors
      // the detection.tsx fix).
      title="Data scope"
      sub="The index pattern, the fields the agent maps entities from, and how the durable poller pulls new events."
      toc={GENERAL_TOC}
    >
      <SettingsGrid>
        <SettingsCard
          anchor="general-sources"
          title="Data sources"
          icon={Database}
          description="Connect and manage SIEM/EDR/queue sources (Elasticsearch, OpenSearch, Wazuh, push receivers) on the dedicated Sources page."
          wide="full"
          actions={
            onNavigate ? (
              <Button variant="outline" size="sm" onClick={() => onNavigate('sources')}>
                <Database className="h-4 w-4" aria-hidden />
                Open Sources
              </Button>
            ) : null
          }
        >
          <p className="text-sm text-muted-foreground">
            Add, edit, and test-connect log sources, and browse a source&apos;s logs.
          </p>
        </SettingsCard>

        <SettingsCard
          anchor="general-mapping"
          title="Default log scope & field mapping"
          icon={SlidersHorizontal}
          description="The fallback index pattern and field mapping used when a source does not override them."
          wide="full"
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <TextPref label="Log index pattern" value={prefs.data_view_pattern} onChange={(v) => update({ data_view_pattern: v })} />
            <TextPref label="Timestamp field" value={prefs.time_field} onChange={(v) => update({ time_field: v })} />
            <TextPref label="Source IP field" value={prefs.source_ip_field} onChange={(v) => update({ source_ip_field: v })} />
            <TextPref label="User field" value={prefs.user_field} onChange={(v) => update({ user_field: v })} />
            <TextPref label="Host field" value={prefs.host_field} onChange={(v) => update({ host_field: v })} />
            <TextPref label="Rule / module field" value={prefs.rule_field} onChange={(v) => update({ rule_field: v })} />
            <TextPref label="Rule name field" value={prefs.rule_name_field} onChange={(v) => update({ rule_name_field: v })} />
            <TextPref label="Severity field" value={prefs.severity_field} onChange={(v) => update({ severity_field: v })} />
            <NumPref label="Severity threshold" value={prefs.severity_threshold} step={0.5} onChange={(v) => update({ severity_threshold: v })} />
            <TextPref
              label="Investigate lookback"
              value={prefs.investigate_lookback}
              help='Starting window for manual entity investigation, e.g. "now-24h".'
              onChange={(v) => update({ investigate_lookback: v })}
            />
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="general-evidence"
          title="Case evidence fields"
          icon={ScanSearch}
          description="The raw-record fields the agent is shown per event, and matched against by free-text search. One list drives both, so a field the agent can see is generally one it can then search for — numeric and IP fields are shown but not text-searched."
          wide="full"
        >
          <div className="space-y-4">
            <TagInput
              label="Evidence fields"
              value={prefs.evidence_fields ?? []}
              onChange={(v) => update({ evidence_fields: v })}
              placeholder="url.path"
              description={
                'Dotted paths added to each event\u2019s identity fields (id, ip, user, host, rule, severity). ' +
                'Defaults to the ECS set that most often carries the verdict. Use "*" to send the whole record, ' +
                'bounded only by the budget below; an empty list pins the narrow identity-only projection. ' +
                'A source can override this via its own `evidence_fields` config key.'
              }
              validate={(tag) =>
                tag.length > 128 ? 'Field paths are limited to 128 characters.' : null
              }
              max={64}
            />
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <NumPref
                label="Evidence budget per event (characters)"
                value={prefs.evidence_max_chars_per_event}
                min={0}
                max={16000}
                step={100}
                help={
                  'Applies per event. When it binds the agent is told which fields were withheld; ' +
                  'in whole-record ("*") mode, bulky rule metadata is dropped before evidence. ' +
                  '0 sends identity fields only. Raising it multiplies across the 12 sample events ' +
                  'an investigation reads.'
                }
                onChange={(v) => update({ evidence_max_chars_per_event: v })}
              />
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="general-polling"
          title="Polling"
          icon={RefreshCw}
          description="The background poller pulls new events on a durable cursor (no skip, no dup). Off by default in some deployments."
          wide="full"
        >
          <div className="space-y-4">
            <SwitchPref
              label="Polling enabled"
              checked={Boolean(prefs.polling_enabled)}
              onChange={(v) => update({ polling_enabled: v })}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <NumPref label="Poll interval (seconds)" value={prefs.poll_interval_seconds} onChange={(v) => update({ poll_interval_seconds: v })} />
              <NumPref label="Poll batch size" value={prefs.poll_batch_size} onChange={(v) => update({ poll_batch_size: v })} />
              <NumPref label="Cold-start lookback (minutes)" value={prefs.cold_start_lookback_minutes} onChange={(v) => update({ cold_start_lookback_minutes: v })} />
            </div>
          </div>
        </SettingsCard>
      </SettingsGrid>
    </SectionShell>
  );
}
