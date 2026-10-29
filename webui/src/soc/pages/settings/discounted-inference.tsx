/**
 * Discounted inference settings section (Round 14, D30: moved here from the Jobs page).
 *
 * `Preferences.batch` (mirrors backend `BatchConfig`): compatible live OpenAI alert
 * investigations prefer the Flex service tier by default, with a standard fallback; the
 * separate asynchronous Batch queue stays opt-in for low-urgency work. The usage ledger
 * records the tier each call actually used (#6), and neither path changes a verdict or a
 * deterministic case decision (#3). It saves through the Settings page like every other
 * preference, so changing it needs `settings:manage` (the server's gate on PUT
 * /api/settings). On the Jobs page it saved through PUT /api/batch/config with
 * `models:manage`; the built-in roles hold both grants together, so only a custom role
 * that held one without the other sees a difference. Without the grant the section is
 * read-only: every control is disabled, as it was on Jobs (the Settings page says why).
 */
import type { BatchConfig } from '@/lib/types';
import { TagInput } from '@/soc/components/TagInput';

import { SettingRow, SettingsGroup, SettingsSection, type SecProps } from './primitives';

/** Backend defaults (mirror `config.BatchConfig`). */
export const DEFAULT_BATCH_CONFIG: Readonly<Required<Omit<BatchConfig, 'flex'>>> = {
  enabled: false,
  severity_floor: 3,
  providers: ['anthropic', 'openai'],
  prefer_discounted_alerts: true,
  fallback_to_standard: true,
};

/** OCSF severity_id 1 to 6, named. */
export const SEVERITY_FLOOR_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '1', label: 'Informational' },
  { value: '2', label: 'Low' },
  { value: '3', label: 'Medium' },
  { value: '4', label: 'High' },
  { value: '5', label: 'Critical' },
  { value: '6', label: 'Fatal' },
];

/** Keep a provider name as typed, lower case and trimmed; drop duplicates and empties. */
function cleanProviders(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const name = raw.trim().toLowerCase();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export function DiscountedInferenceSection({
  prefs,
  update,
  readOnly = false,
}: SecProps & {
  /** The viewer cannot save Settings (`settings:manage`): show the policy, change nothing. */
  readOnly?: boolean;
}) {
  const stored: BatchConfig = prefs.batch ?? {};
  const cfg = { ...DEFAULT_BATCH_CONFIG, ...stored };
  const set = (patch: Partial<BatchConfig>) => update({ batch: { ...stored, ...patch } });
  const floor = String(Math.min(6, Math.max(1, Math.round(Number(cfg.severity_floor) || 3))));
  return (
    <SettingsSection title="Discounted inference">
      <SettingsGroup
        id="discounted-live"
        title="Live alert investigations"
        caption="Compatible OpenAI GPT-5, o3 and o4-mini alert work. Chat, standup, the Overview brief and model tests stay on the standard tier."
      >
        <SettingRow
          variant="switch"
          label="Prefer discounted alert inference"
          help="Route compatible alert investigations through the live Flex tier."
          checked={cfg.prefer_discounted_alerts !== false}
          disabled={readOnly}
          onCheckedChange={(value) => set({ prefer_discounted_alerts: value })}
        />
        <SettingRow
          variant="switch"
          label="Standard fallback"
          help="Keep alert work moving on the standard tier when Flex is unavailable. Fallback calls are recorded at standard prices."
          checked={cfg.fallback_to_standard !== false}
          disabled={readOnly}
          onCheckedChange={(value) => set({ fallback_to_standard: value })}
        />
      </SettingsGroup>

      <SettingsGroup
        id="discounted-batch"
        title="Asynchronous Batch queue"
        caption="Optional delayed processing for low-urgency events, at about half price."
      >
        <SettingRow
          variant="switch"
          label="Batch routing"
          help="Send candidates at or below the severity floor to a provider's Batch API instead of a live call."
          checked={Boolean(cfg.enabled)}
          disabled={readOnly}
          onCheckedChange={(value) => set({ enabled: value })}
        />
        <SettingRow
          variant="select"
          label="Severity floor"
          help="A candidate at or below this severity may wait in the Batch queue; anything above stays live."
          value={floor}
          options={SEVERITY_FLOOR_OPTIONS}
          onValueChange={(value) => set({ severity_floor: Number(value) })}
          disabled={readOnly}
          controlWidth="12rem"
        />
        <SettingRow variant="field" wide mono>
          <TagInput
            label="Batch providers"
            description="Providers whose Batch APIs may be used."
            value={[...(cfg.providers ?? [])]}
            placeholder="Add a provider"
            disabled={readOnly}
            onChange={(next) => set({ providers: cleanProviders(next) })}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
