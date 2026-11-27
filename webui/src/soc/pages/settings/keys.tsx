/**
 * Secret keys settings section (Round-5 Sett-A decomposition; Round 14 grouped panels).
 *
 * Keys are WRITE-ONLY:
 * the console only ever knows whether a key is configured (a boolean), never the
 * value. Entered values are buffered in the page's `secretDraft` and pushed via the
 * dedicated secrets route through the Settings-wide Save/Discard bar (#10).
 */
import type { ConfiguredStatus } from '@/lib/types';

import { SecretInput, SettingRow, SettingsGroup, SettingsSection } from './primitives';

type SecretGroup = 'Data access' | 'AI runtime' | 'Threat intelligence';

export const SECRET_KEYS: Array<{ key: string; label: string; help: string; group: SecretGroup }> = [
  { key: 'es_api_key', label: 'Elasticsearch read-only API key', help: 'Scoped, read-only key for the log indices.', group: 'Data access' },
  { key: 'es_mgmt_api_key', label: 'Elasticsearch management API key', help: 'Scoped to tlsoc-agent-* bookkeeping indices.', group: 'Data access' },
  { key: 'openai_api_key', label: 'OpenAI API key', help: 'Default runtime for GPT-5.6 Luna completion roles and embeddings.', group: 'AI runtime' },
  { key: 'anthropic_api_key', label: 'Anthropic API key', help: 'Optional alternate runtime for Claude models.', group: 'AI runtime' },
  { key: 'embedding_api_key', label: 'Embedding API key', help: 'Defaults to the OpenAI key when blank.', group: 'AI runtime' },
  { key: 'abuseipdb_api_key', label: 'AbuseIPDB API key', help: 'IP reputation enrichment (optional).', group: 'Threat intelligence' },
  { key: 'virustotal_api_key', label: 'VirusTotal API key', help: 'File, URL and IP reputation (optional).', group: 'Threat intelligence' },
];

const SECRET_GROUPS: SecretGroup[] = ['Data access', 'AI runtime', 'Threat intelligence'];

export function KeysSection({
  configured,
  draft,
  setDraft,
  saving,
  readOnly,
}: {
  configured: ConfiguredStatus;
  draft: Record<string, string>;
  setDraft: (d: Record<string, string>) => void;
  saving: boolean;
  readOnly: boolean;
}) {
  const set = (k: string, v: string) => setDraft({ ...draft, [k]: v });
  return (
    <SettingsSection title="Secret keys">
      {SECRET_GROUPS.map((group) => (
        <SettingsGroup key={group} title={group}>
          {SECRET_KEYS.filter((key) => key.group === group).map((key) => (
            <SettingRow key={key.key} variant="field" controlWidth="18rem">
              <SecretInput
                label={key.label}
                secretKey={key.key}
                configured={configured[key.key]}
                value={draft[key.key] || ''}
                help={key.help}
                onChange={(value) => set(key.key, value)}
                disabled={saving || readOnly}
              />
            </SettingRow>
          ))}
        </SettingsGroup>
      ))}
    </SettingsSection>
  );
}
