/**
 * Standup settings section (Round-5 Sett-A decomposition; Round 14 grouped panels).
 *
 * The aggregate-only shift summary: whether it runs, the window it covers and how often
 * it is rebuilt.
 */

import { durationReading, withReading } from './duration';
import { NumPref, SettingRow, SettingsGroup, SettingsSection, type SecProps } from './primitives';

/** Re-exported for callers that read the Standup cadence. */
export { durationReading };

export function StandupSection({ prefs, update }: SecProps) {
  const s = prefs.standup || {};
  const set = (patch: Partial<typeof s>) => update({ standup: { ...s, ...patch } });
  const every = durationReading(s.interval_seconds);
  return (
    <SettingsSection title="Standup">
      <SettingsGroup title="Shift summary" caption="Aggregates only. No raw logs ever reach a model.">
        <SettingRow
          variant="switch"
          label="Standup enabled"
          help="Build the shift summary on the cadence below."
          checked={s.enabled ?? true}
          onCheckedChange={(v) => set({ enabled: v })}
        />
        <SettingRow variant="field" controlWidth="8rem">
          <NumPref
            label="Window"
            help="How much activity each summary covers."
            unit="h"
            min={1}
            value={s.window_hours}
            onChange={(v) => set({ window_hours: v })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth="8rem">
          <NumPref
            label="Refresh interval"
            help={withReading('How often the summary is rebuilt.', every)}
            unit="s"
            min={1}
            value={s.interval_seconds}
            onChange={(v) => set({ interval_seconds: v })}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
