/**
 * The Team activity group of Settings, Single sign-on & policy (Round 15 SPEC D3.4):
 * one switch, `team_activity.enabled`, saved with the page's one save. On by default
 * (#10). Off, the Team activity routes answer `409 team_activity_off` and the page says
 * which switch turned it off. This group is the block's one editor: `team_activity` is
 * in Advanced's curated keys, so the long tail does not offer a second one.
 */
import { SettingRow, SettingsGroup, type SecProps } from './primitives';

export function TeamActivitySettingsGroup({ prefs, update }: SecProps) {
  const cfg = prefs.team_activity;
  const enabled = cfg?.enabled !== false;
  return (
    <SettingsGroup
      id="security-team-activity"
      title="Team activity"
      caption="Per-person work counts from the audit log, for SOC managers and auditors."
    >
      <SettingRow
        variant="switch"
        label="Team activity page"
        help="Shows what each person did, per day: cases acknowledged, closed and reviewed, comments and sign-ins. It never shows an IP address, a session or a ranking. Off, nobody can open it."
        checked={enabled}
        onCheckedChange={(value) => update({ team_activity: { ...cfg, enabled: value } })}
      />
    </SettingsGroup>
  );
}
