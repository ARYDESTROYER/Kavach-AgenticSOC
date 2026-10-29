/**
 * SLA, priority & suppression settings section (Round-6: mount the orphaned G6 editors;
 * Round 14 grouped panels).
 *
 * One group per policy family:
 *   - SLA targets: one row per priority (respond and resolve minutes) plus the clock
 *     settings, writing `Preferences.sla` (advisory timers),
 *   - {@link PriorityMatrixEditor} writes `Preferences.priority_matrix` (advisory),
 *   - {@link SuppressionRuleBuilder} writes `Preferences.suppression_rules`,
 *   - {@link AnalystPolicyBuilder} writes `Preferences.analyst_rule_policies`.
 *
 * CONFIG WRITER ONLY (#3): every editor emits config via the shared deep-merge
 * `{prefs, update}` buffer the Settings page owns (which PUTs `/api/settings`). NONE call
 * `decide()`, set a case status, or bill an LLM (#6). SLA and priority are ADVISORY
 * (sorting, badges and MTTR only). Suppression is the ONE family that can hide events
 * (it drops a matching event before triage), so deleting a LIVE rule routes through a
 * `ConfirmDialog`. Every operator-authored value renders as plain text (#9).
 */
import * as React from 'react';

import type {
  AnalystRulePolicyConfig,
  SlaPolicy,
  SlaTarget,
  SuppressionRuleConfig,
} from '@/lib/types';

import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { NumberField } from '@/soc/components/NumberField';
import {
  PriorityMatrixEditor,
  AnalystPolicyBuilder,
  SuppressionRuleBuilder,
} from '@/soc/components/rules';

import { minutesReading } from './duration';
import { SettingRow, SettingsGroup, SettingsSection, TextPref, type SecProps } from './primitives';

/** The four priority tiers, in descending urgency, with their names. */
export const SLA_LEVELS: ReadonlyArray<{ level: string; name: string }> = [
  { level: 'P1', name: 'Critical' },
  { level: 'P2', name: 'High' },
  { level: 'P3', name: 'Medium' },
  { level: 'P4', name: 'Low' },
];

/**
 * Per-level fallback targets: MIRROR the backend `SlaPolicy` defaults (`config.py`: P1
 * 15/240, P2 30/480, P3 120/1440, P4 480/4320), shown for a level whose target is absent
 * so the editor never implies a target the system does not enforce.
 */
export const SLA_DEFAULT_TARGETS: Record<string, { response: number; resolve: number }> = {
  P1: { response: 15, resolve: 240 },
  P2: { response: 30, resolve: 480 },
  P3: { response: 120, resolve: 1440 },
  P4: { response: 480, resolve: 4320 },
};

/**
 * One priority: its name, then the respond and resolve targets in minutes on the row's
 * end; the help line reads them as people say them ("resolve within 3 days"). An emptied
 * field is no value (`empty="keep"`): committing 0 would put every case in breach at once.
 */
function SlaTargetRow({
  level,
  name,
  target,
  disabled,
  onChange,
}: {
  level: string;
  name: string;
  target: SlaTarget;
  disabled: boolean;
  onChange: (patch: Partial<SlaTarget>) => void;
}) {
  const def = SLA_DEFAULT_TARGETS[level];
  const respond = target.response_minutes ?? def.response;
  const resolve = target.resolve_minutes ?? def.resolve;
  return (
    <SettingRow
      variant="control"
      label={`${level} ${name}`}
      help={`Respond within ${minutesReading(respond)}, resolve within ${minutesReading(resolve)}.`}
      control={
        <div className="flex items-start gap-3" data-sla-level={level}>
          <NumberField
            label={
              <>
                <span className="sr-only">{`${level} ${name}: `}</span>Respond
              </>
            }
            value={respond}
            min={0}
            unit="min"
            size="sm"
            empty="keep"
            disabled={disabled}
            onChange={(v) => onChange({ response_minutes: v })}
          />
          <NumberField
            label={
              <>
                <span className="sr-only">{`${level} ${name}: `}</span>Resolve
              </>
            }
            value={resolve}
            min={0}
            unit="min"
            size="sm"
            empty="keep"
            disabled={disabled}
            onChange={(v) => onChange({ resolve_minutes: v })}
          />
        </div>
      }
    />
  );
}

/** The SLA group: tracking on or off, one row per priority, then the clock. */
function SlaGroup({ policy, onChange }: { policy: SlaPolicy; onChange: (next: SlaPolicy) => void }) {
  const enabled = policy.enabled ?? false;
  const targets = policy.targets ?? {};
  const setTarget = (level: string, patch: Partial<SlaTarget>) => {
    const cur = targets[level] ?? {};
    onChange({ ...policy, targets: { ...targets, [level]: { ...cur, ...patch } } });
  };
  return (
    <SettingsGroup
      id="case-policy-sla"
      title="SLA targets"
      caption="Advisory timers: they show at-risk and breached badges and feed MTTR reporting, and never change a verdict or a case decision."
    >
      <SettingRow
        variant="switch"
        label="SLA tracking"
        help="When off, no SLA badges or timers are shown."
        checked={enabled}
        onCheckedChange={(v) => onChange({ ...policy, enabled: v })}
      />
      {/* Each disabled control dims itself; the text stays at full contrast. */}
      <div className="divide-y divide-border/70">
        {SLA_LEVELS.map(({ level, name }) => (
          <SlaTargetRow
            key={level}
            level={level}
            name={name}
            target={targets[level] ?? {}}
            disabled={!enabled}
            onChange={(patch) => setTarget(level, patch)}
          />
        ))}
        <SettingRow variant="field" controlWidth="16rem" mono>
          <TextPref
            label="Timezone"
            help="The IANA timezone the SLA clock runs in, for example UTC or America/New_York."
            value={policy.timezone ?? 'UTC'}
            placeholder="UTC"
            disabled={!enabled}
            onChange={(v) => onChange({ ...policy, timezone: v })}
          />
        </SettingRow>
        <SettingRow
          variant="switch"
          label="Business hours only"
          help="Pause the SLA clock outside business hours. Off means the clock runs all day, every day."
          checked={policy.business_hours_only ?? false}
          disabled={!enabled}
          onCheckedChange={(v) => onChange({ ...policy, business_hours_only: v })}
        />
      </div>
    </SettingsGroup>
  );
}

export function CasePolicySection({ prefs, update }: SecProps) {
  const rules = prefs.suppression_rules ?? [];
  const declarations = prefs.analyst_rule_policies ?? [];
  const [pendingDeclaration, setPendingDeclaration] = React.useState<{
    index: number;
    policy: AnalystRulePolicyConfig;
  } | null>(null);
  // A LIVE suppression rule silently hides events, so its delete is gated. The builder
  // calls `onRequestRemove` for a live rule; we hold the pending target for the dialog.
  const [pendingRemove, setPendingRemove] = React.useState<{
    index: number;
    rule: SuppressionRuleConfig;
  } | null>(null);

  return (
    <SettingsSection title="SLA, priority & suppression">
      <SlaGroup policy={prefs.sla ?? {}} onChange={(next) => update({ sla: next })} />

      <SettingsGroup
        id="case-policy-priority"
        title="Priority matrix"
        caption="Map every impact and urgency pair to a priority. Priority orders the queue and picks the SLA tier, never the decision."
      >
        <SettingRow variant="block">
          {/* The group caption carries the explanation (D26): no standing note. */}
          <PriorityMatrixEditor
            intro={false}
            matrix={prefs.priority_matrix ?? {}}
            onChange={(next) => update({ priority_matrix: next })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        id="case-policy-suppression"
        title="Suppression rules"
        caption="A field and value rule drops a matching event before it becomes a case: the one rule family that can hide events. Keep rules narrow and prefer turning one off to deleting it; you confirm before a live rule is deleted."
      >
        <SettingRow variant="block">
          <SuppressionRuleBuilder
            intro={false}
            rules={rules}
            onChange={(next) => update({ suppression_rules: next })}
            onRequestRemove={(index, rule) => setPendingRemove({ index, rule })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        id="case-policy-declarations"
        title="Declared benign"
        caption="Your statement that a detection is benign here. A matching cluster closes with no model call and the case stays visible, audited and reopenable, unlike suppression, which drops the event before a case exists."
      >
        <SettingRow variant="block">
          <AnalystPolicyBuilder
            policies={declarations}
            onChange={(next) => update({ analyst_rule_policies: next })}
            onRequestRemove={(index, policy) => setPendingDeclaration({ index, policy })}
          />
        </SettingRow>
      </SettingsGroup>

      {/* Destructive-delete gate for a LIVE suppression rule (parity with the rest of the
          console). Config writer only (#3): the confirmed delete flows through `update`. */}
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => {
          if (!o) setPendingRemove(null);
        }}
        destructive
        title="Delete this suppression rule?"
        description={
          pendingRemove
            ? `This enabled rule (${pendingRemove.rule.field || 'field'} == ${pendingRemove.rule.value || 'value'}) drops matching events before triage. Deleting it stops the suppression. It changes configuration only, never a case.`
            : ''
        }
        confirmLabel="Delete rule"
        onConfirm={() => {
          if (pendingRemove) {
            update({ suppression_rules: rules.filter((_, i) => i !== pendingRemove.index) });
          }
          setPendingRemove(null);
        }}
      />

      {/* Same gate for a LIVE declaration. Deleting one RESTORES investigation for that
          rule, so the copy states the consequence in the direction that matters. */}
      <ConfirmDialog
        open={pendingDeclaration !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDeclaration(null);
        }}
        destructive
        title="Delete this declaration?"
        description={
          pendingDeclaration
            ? `This live declaration (${pendingDeclaration.policy.rule_id || 'rule'}) closes matching cases without a model call. Deleting it means those cases are investigated normally again. Cases it already closed stay closed and can be reopened. It changes configuration only, never a case.`
            : ''
        }
        confirmLabel="Delete declaration"
        onConfirm={() => {
          if (pendingDeclaration) {
            update({
              analyst_rule_policies: declarations.filter(
                (_, i) => i !== pendingDeclaration.index,
              ),
            });
          }
          setPendingDeclaration(null);
        }}
      />
    </SettingsSection>
  );
}
