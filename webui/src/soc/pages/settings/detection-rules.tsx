/**
 * Detection & rules settings section (Round-5 G6, R2): the Settings-hosted HOME for
 * the unified rule editor. Registered under the General group in
 * `settings-sections.ts` (ON BY DEFAULT), gated on the unified `automation:manage`
 * grant for mutations (`automation:read` implicitly for viewing).
 *
 * The section is a thin shell around `@/soc/rules DetectionRulesHome`, which owns the
 * catalog table and the four-part (Define, About, Schedule, Actions) rule editor.
 * It edits through the SAME `{prefs, update}` deep-merge buffer every other settings
 * section uses, writing `rule_catalog` / `threshold_automation` and NEVER calling
 * `decide()` (#3). Every rule name/field renders plain text (#9); no secret is shown (#10).
 */
import { SettingsSection, type SecProps } from './primitives';
import { DetectionRulesHome } from '@/soc/rules';

export function DetectionRulesSection({ prefs, update }: SecProps) {
  return (
    <SettingsSection
      title="Detection & rules"
      width="full"
    >
      <DetectionRulesHome prefs={prefs} update={update} />
    </SettingsSection>
  );
}
