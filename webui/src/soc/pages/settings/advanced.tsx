/**
 * Advanced settings section (Round-5 Sett-A decomposition; Round 14 grouped panels).
 *
 * Power-user controls: per-case caps, the kill switch, background scans, the
 * auto-forward allowlist, suppression rules in retrieval, and the Console settings
 * lock.
 *
 * Operator-entered rule values render as PLAIN TEXT (#9).
 */
import { Callout } from '@/design-system';
import { TagInput } from '@/soc/components/TagInput';

import { NumPref, SettingRow, SettingsGroup, SettingsSection, type NavigateFn, type SecProps } from './primitives';

export function AdvancedSection({
  prefs,
  persistedPrefs,
  update,
}: SecProps & {
  /**
   * The last saved settings. The kill-switch warning states what the server does now, so
   * it reads the saved value, never the draft (flipping the switch is not yet stopping
   * anything, and turning it off in the draft has not restarted anything).
   */
  persistedPrefs?: SecProps['prefs'];
  onNavigate?: NavigateFn;
}) {
  const caps = prefs.caps || {};
  const killSwitchOn = Boolean((persistedPrefs ?? prefs).caps?.kill_switch);
  const setCaps = (patch: Partial<typeof caps>) => update({ caps: { ...caps, ...patch } });
  const rag = prefs.rag || {};
  const setRag = (patch: Partial<typeof rag>) => update({ rag: { ...rag, ...patch } });
  const allowlist = prefs.auto_forward_allowlist || [];
  return (
    <SettingsSection title="Advanced">
      {killSwitchOn ? (
        // A live condition: automated investigation is stopped right now (saved state).
        <Callout intent="warning" title="The kill switch is on">
          Automated investigation is stopped. Manual investigation still works.
        </Callout>
      ) : null}

      <SettingsGroup
        id="advanced-caps"
        title="Per-case caps"
        caption="Hard limits per investigation. A case that reaches a cap goes to a person rather than running on."
      >
        {/*
          `min={1}` mirrors the backend floor (`CapsConfig`, `ge=1`): 0 and negatives are
          not a stricter limit, they are a broken configuration that fails the run silently
          and for $0. There is deliberately NO `max`: an upper bound here would encode one
          vendor's hosted-API envelope as product policy and would fight the config of any
          deployer already above it.
        */}
        <SettingRow variant="field" controlWidth="9rem">
          <NumPref label="Tool calls per case" value={caps.max_tool_calls} min={1} step={1} onChange={(v) => setCaps({ max_tool_calls: v })} />
        </SettingRow>
        <SettingRow variant="field" controlWidth="9rem">
          <NumPref label="Tokens per case" value={caps.max_tokens} min={1} step={1} onChange={(v) => setCaps({ max_tokens: v })} />
        </SettingRow>
        <SettingRow variant="field" controlWidth="9rem">
          <NumPref label="Timeout" unit="s" value={caps.timeout_seconds} min={1} step={1} onChange={(v) => setCaps({ timeout_seconds: v })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup id="advanced-killswitch" title="Kill switch" caption="An emergency stop for automated investigation.">
        <SettingRow
          variant="switch"
          label="Kill switch"
          help="When on, the agent stops all automated investigation at once. Manual investigation still works."
          checked={Boolean(caps.kill_switch)}
          onCheckedChange={(v) => setCaps({ kill_switch: v })}
        />
      </SettingsGroup>

      <SettingsGroup id="advanced-scans" title="Background scans">
        <SettingRow
          variant="switch"
          label="Background scans"
          help="Scan new events from every source in the background, so each one is correlated, scored and visible."
          checked={Boolean(prefs.background_scan_enabled)}
          onCheckedChange={(v) => update({ background_scan_enabled: v })}
        />
      </SettingsGroup>

      <SettingsGroup
        id="advanced-allowlist"
        title="Auto-forward allowlist"
        caption="Alerts from these rule values go straight to investigation, skipping the router."
      >
        <SettingRow variant="field" wide mono>
          <TagInput
            label="Allowlisted rule values"
            description="Press Enter to add a value. Exact duplicates are ignored."
            placeholder="Add a rule value"
            value={allowlist}
            onChange={(next) => {
              const out: string[] = [];
              for (const raw of next) {
                const value = raw.trim();
                if (value && !out.includes(value)) out.push(value);
              }
              update({ auto_forward_allowlist: out });
            }}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup id="advanced-suppression" title="Suppression rules in retrieval">
        <SettingRow
          variant="switch"
          label="Inject suppression rules"
          help="Give investigations the approved suppression rules as trusted context. A suppression rule only goes live through the approval queue, never automatically."
          checked={rag.use_suppression_rules ?? true}
          onCheckedChange={(v) => setRag({ use_suppression_rules: v })}
        />
      </SettingsGroup>

      <SettingsGroup
        id="advanced-lock"
        title="Settings lock"
        caption="A guard against accidental edits in shared or production deployments. A server-side read-only mode still wins."
      >
        <SettingRow
          variant="switch"
          label="Read-only settings mode"
          help="Show settings as read-only in the Console. Save is turned off while this is on, except to turn it off."
          checked={Boolean(prefs.read_only_settings_mode)}
          onCheckedChange={(v) => update({ read_only_settings_mode: v })}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
