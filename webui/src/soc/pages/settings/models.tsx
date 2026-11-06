/**
 * Models settings section (Round-5 Sett-A decomposition; Round 14 grouped panels).
 *
 * The model each agent role uses, one row per role, and a row that opens the Models
 * page (catalog, pricing, budgets, providers). Model ids render as plain text
 * (externally sourced but non-secret).
 */
import type { ModelConfig, ModelsResponse, Preferences } from '@/lib/types';
import { MODEL_ROLES } from '@/lib/types';
import { Callout } from '@/design-system';

import {
  ModelPicker,
  SettingRow,
  SettingsGroup,
  SettingsSection,
  type NavigateFn,
  type SecProps,
} from './primitives';

/** Per-role → Preferences model-config field. */
export const ROLE_PREF_KEY: Record<string, keyof Preferences> = {
  router: 'router_model',
  investigator: 'investigator_model',
  formatter: 'formatter_model',
  standup: 'standup_model',
  chat: 'chat_model',
  overview: 'overview_model',
  embedding: 'embedding_model',
};

/** One plain line per role: what the model in that role does. */
export const ROLE_HELP: Record<string, string> = {
  router: 'Decides which alerts need a full investigation.',
  investigator: 'Runs the investigation and reaches a verdict.',
  formatter: 'Writes the case summary from the verdict.',
  standup: 'Writes the shift summary from aggregates.',
  chat: 'Answers questions in Workspace and Case Manager chat.',
  overview: 'Writes the Overview brief.',
  embedding: 'Turns knowledge and cases into search vectors.',
};

/** "Investigator", "Router": the role's name as a row label. */
function roleLabel(role: string): string {
  return role ? `${role.charAt(0).toUpperCase()}${role.slice(1)}` : role;
}

export function ModelsSection({
  prefs,
  update,
  models,
}: SecProps & { models: ModelsResponse | null; onNavigate?: NavigateFn }) {
  return (
    <SettingsSection title="Models">
      {!models ? (
        // A live condition: the catalog could not be read, so the pickers cannot list models.
        <Callout intent="warning" title="Model list unavailable">
          The available models could not be loaded. Add a model key under Secret keys, then reload
          this page.
        </Callout>
      ) : null}
      <SettingsGroup
        title="Per-role models"
        caption="Fresh workspaces use OpenAI GPT-5.6 Luna for completion roles. Embeddings keep their own model."
      >
        {MODEL_ROLES.map((role) => (
          <SettingRow key={role} variant="field">
            <ModelPicker
              role={role}
              label={roleLabel(role)}
              help={ROLE_HELP[role]}
              models={models}
              value={prefs[ROLE_PREF_KEY[role]] as ModelConfig | undefined}
              onChange={(m) => update({ [ROLE_PREF_KEY[role]]: m } as Partial<Preferences>)}
            />
          </SettingRow>
        ))}
      </SettingsGroup>
      <SettingsGroup title="Administration">
        <SettingRow
          variant="link"
          label="Model administration"
          help="The model catalog, pricing, budgets, capabilities and providers."
          href="#/models"
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
