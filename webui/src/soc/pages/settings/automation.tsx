/**
 * Threshold automation settings section (Round-5 Sett-A decomposition + Round-6 de-dup).
 *
 * ROUND-6 DE-DUPLICATION: two surfaces used to edit the SAME
 * `threshold_automation.rules`: this legacy section AND the G6 "Detection & rules"
 * home. The Detection & rules home is now THE editor. This section keeps only the
 * NON-rule automation control, the master enable switch (`threshold_automation.enabled`),
 * with the #3 explanation in its help tip, and a row that opens Detection & rules. The
 * wire keys are unchanged (nothing is deleted).
 *
 * INVARIANT #3 (unchanged): a matched rule can only tag, recommend, notify, queue a
 * reinvestigation or draft an approval proposal; it NEVER sets a case's status or
 * closes it. Every outside-world write goes through the approval queue.
 */
import { ArrowRight } from 'lucide-react';

import type { ThresholdAutomationConfig } from '@/lib/types';

import { Button } from '@/ui/button';

import { SettingRow, SettingsGroup, SettingsSection, type SecProps } from './primitives';

/**
 * The automation section. `onOpenRules` (wired by the Settings page to
 * `setSection('detection_rules')`) switches to the Detection & rules home where the
 * per-rule editor lives. When absent (a standalone unit render) the row has no button.
 */
export function AutomationSection({
  prefs,
  update,
  onOpenRules,
}: SecProps & { onOpenRules?: () => void }) {
  const cfg: ThresholdAutomationConfig = prefs.threshold_automation || {};
  const ruleCount = (cfg.rules || []).length;

  const setCfg = (patch: Partial<ThresholdAutomationConfig>) =>
    update({ threshold_automation: { ...cfg, ...patch } });

  return (
    <SettingsSection title="Automation">
      <SettingsGroup
        title="Case automation"
        caption="Anything that would change another system goes through the approval queue."
      >
        <SettingRow
          variant="switch"
          label="Threshold automation enabled"
          help="The master switch. When off, no automation rule runs."
          checked={Boolean(cfg.enabled)}
          onCheckedChange={(v) => setCfg({ enabled: v })}
        />
        {/* One editor for the rules: this row only points at it and never edits a rule
            (#3-safe: no decide(), no status write). */}
        <SettingRow
          variant="action"
          label="Case automation rules"
          help={
            ruleCount > 0
              ? `You have ${ruleCount} case-automation ${ruleCount === 1 ? 'rule' : 'rules'}. You write them in Detection & rules.`
              : 'You have no case-automation rules yet. You write them in Detection & rules.'
          }
          action={
            onOpenRules ? (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={onOpenRules}>
                Open Detection &amp; rules
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            ) : null
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
