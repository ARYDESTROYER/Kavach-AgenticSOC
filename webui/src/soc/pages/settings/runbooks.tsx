/**
 * Runbooks settings section (Round 14, SPEC §4.9.6 and §4.10.19).
 *
 * Every key of `Preferences.runbooks` (backend `RunbookConfig`): the feature switch, how
 * runbooks reach cases (auto-attach and the Generic incident fallback), what the agent
 * and the AI help may use, and the publishing rules. The migration marker
 * `runbooks_config_version` is carried through untouched. A runbook, a run and these
 * switches never feed the close or escalate decision (#3); AI help is offered as clicks,
 * each one gateway call in the cost ledger (#6); only Published runbook text is trusted
 * by the agent (#9).
 */
import type { Preferences } from '@/lib/types';

import {
  NumPref,
  SettingRow,
  SettingsGroup,
  SettingsSection,
  type SecProps,
} from './primitives';

/** `Preferences.runbooks`, mirrored from backend `RunbookConfig`. */
export interface RunbookSettings {
  enabled: boolean;
  auto_attach: boolean;
  fallback: boolean;
  investigator_guidance: boolean;
  rag_corpus: boolean;
  ai_suggest: boolean;
  ai_step_drafts: boolean;
  require_distinct_approver: boolean;
  step_approvals: boolean;
  review_every_days_default: number;
  runbooks_config_version?: number;
}

/** Backend defaults (`config.RunbookConfig`). */
export const RUNBOOK_SETTINGS_DEFAULTS: Readonly<Omit<RunbookSettings, 'runbooks_config_version'>> = Object.freeze({
  enabled: true,
  auto_attach: true,
  fallback: true,
  investigator_guidance: true,
  rag_corpus: true,
  ai_suggest: true,
  ai_step_drafts: true,
  require_distinct_approver: false,
  step_approvals: false,
  review_every_days_default: 180,
});

/** `RUNBOOK_REVIEW_DAYS_MIN` and `RUNBOOK_REVIEW_DAYS_MAX` (backend). */
export const RUNBOOK_REVIEW_DAYS_BOUNDS = [30, 730] as const;

const SWITCH_KEYS = [
  'enabled',
  'auto_attach',
  'fallback',
  'investigator_guidance',
  'rag_corpus',
  'ai_suggest',
  'ai_step_drafts',
  'require_distinct_approver',
  'step_approvals',
] as const;

/**
 * The block as the editor shows it: stored values over the defaults, with the same
 * repair the backend applies on load (`RunbookConfig._repair`): a switch that is not a
 * boolean takes its default and the review cadence is clamped into 30 to 730 days.
 */
export function runbooksConfig(prefs: Pick<Preferences, 'runbooks'> | Preferences): RunbookSettings {
  const raw = (prefs as { runbooks?: unknown }).runbooks;
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: RunbookSettings = { ...RUNBOOK_SETTINGS_DEFAULTS };
  for (const key of SWITCH_KEYS) {
    if (typeof stored[key] === 'boolean') out[key] = stored[key] as boolean;
  }
  const days = Number(stored.review_every_days_default);
  if (Number.isFinite(days)) {
    const [lo, hi] = RUNBOOK_REVIEW_DAYS_BOUNDS;
    out.review_every_days_default = Math.min(hi, Math.max(lo, Math.round(days)));
  }
  if (typeof stored.runbooks_config_version === 'number') {
    out.runbooks_config_version = stored.runbooks_config_version;
  }
  return out;
}

export function RunbooksSection({ prefs, update }: SecProps) {
  const cfg = runbooksConfig(prefs);
  const stored = ((prefs as { runbooks?: unknown }).runbooks ?? {}) as Record<string, unknown>;
  // Merge onto the stored block so a key this editor does not know is kept as it is.
  const set = (patch: Partial<RunbookSettings>) =>
    update({ runbooks: { ...stored, ...cfg, ...patch } } as Partial<Preferences>);
  const off = !cfg.enabled;

  return (
    <SettingsSection title="Runbooks">
      <SettingsGroup title="Library" caption="The library, the checklist on each case and the guidance the agent reads.">
        <SettingRow
          variant="switch"
          label="Runbooks enabled"
          help={
            off
              ? 'Off: no runbook is attached, run or given to the agent. Turn it on to change the settings below.'
              : 'When off, no runbook is attached, run or given to the agent.'
          }
          checked={cfg.enabled}
          onCheckedChange={(v) => set({ enabled: v })}
        />
        <SettingRow
          variant="link"
          label="Runbook library"
          help="Write, review and publish runbooks."
          href="#/runbooks"
        />
      </SettingsGroup>

      {/* With runbooks off, every control below is disabled and dims itself; the group
          titles, captions and help stay at full contrast. */}
      <div className="space-y-10">
        <SettingsGroup
          id="runbooks-cases"
          title="Runbooks on cases"
          caption="Matching is deterministic, and each case says why its runbook was attached."
        >
          <SettingRow
            variant="switch"
            label="Attach the matching runbook"
            help="Attach the best matching Published runbook to each case that needs a person."
            checked={cfg.auto_attach}
            disabled={off}
            onCheckedChange={(v) => set({ auto_attach: v })}
          />
          <SettingRow
            variant="switch"
            label="Attach Generic incident when nothing matches"
            help="The NIST 800-61 based runbook, shown on the case as Fallback."
            checked={cfg.fallback}
            disabled={off || !cfg.auto_attach}
            onCheckedChange={(v) => set({ fallback: v })}
          />
        </SettingsGroup>

        <SettingsGroup
          title="Agent and AI help"
          caption="AI help is offered as a click; each use is one model call, counted in the cost ledger."
        >
          <SettingRow
            variant="switch"
            label="Guide the agent with the matching runbook"
            help="Give the investigator the winning Published runbook as guidance. It can recommend, never decide."
            checked={cfg.investigator_guidance}
            disabled={off}
            onCheckedChange={(v) => set({ investigator_guidance: v })}
          />
          <SettingRow
            variant="switch"
            label="Use Published runbooks in retrieval"
            help="Index Published runbooks so the agent and chat can find relevant steps."
            checked={cfg.rag_corpus}
            disabled={off}
            onCheckedChange={(v) => set({ rag_corpus: v })}
          />
          <SettingRow
            variant="switch"
            label="Offer Suggest a runbook"
            help="On a case with no runbook, a person can ask the AI which one fits."
            checked={cfg.ai_suggest}
            disabled={off}
            onCheckedChange={(v) => set({ ai_suggest: v })}
          />
          <SettingRow
            variant="switch"
            label="Offer Draft note on Check steps"
            help="A person can ask the AI to draft the note for a Check step, then edit it."
            checked={cfg.ai_step_drafts}
            disabled={off}
            onCheckedChange={(v) => set({ ai_step_drafts: v })}
          />
        </SettingsGroup>

        <SettingsGroup
          id="runbooks-publishing"
          title="Publishing and review"
          caption="Publishing needs the publish permission. Edits create a Draft; only Published text is used."
        >
          <SettingRow
            variant="switch"
            label="The publisher must differ from the author"
            help="Off by default. When on, nobody can publish a version they wrote."
            checked={cfg.require_distinct_approver}
            disabled={off}
            onCheckedChange={(v) => set({ require_distinct_approver: v })}
          />
          <SettingRow
            variant="switch"
            label="Honour step approvals"
            help="Off by default. When on, a step that names an approval role waits for someone with that role."
            checked={cfg.step_approvals}
            disabled={off}
            onCheckedChange={(v) => set({ step_approvals: v })}
          />
          {/* No narrow control column: three digits, "days" and the steppers need the
              field's own 12rem, and a narrower column would clip the value. */}
          <SettingRow variant="field">
            <NumPref
              label="Review new runbooks every"
              help="The review date given to a new runbook; each runbook can change its own. From 30 to 730 days."
              unit="days"
              value={cfg.review_every_days_default}
              min={RUNBOOK_REVIEW_DAYS_BOUNDS[0]}
              max={RUNBOOK_REVIEW_DAYS_BOUNDS[1]}
              step={30}
              disabled={off}
              onChange={(v) => set({ review_every_days_default: v })}
            />
          </SettingRow>
        </SettingsGroup>
      </div>
    </SettingsSection>
  );
}
