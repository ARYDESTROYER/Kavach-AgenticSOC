/**
 * Helpers for turning a ConnectorForm value into the backend's save calls.
 *
 * Secrets live in TWO tiers:
 *
 *   - GLOBAL (`POST /api/setup/secrets`) — the known top-level keys that back the
 *     implicit PRIMARY Elasticsearch source + the shared LLM/enrichment keys. These
 *     are written ONLY when saving the primary source, so a second ES-family source
 *     can never clobber the primary's credentials.
 *   - PER-SOURCE (`POST /api/sources/{id}/secrets`) — every other secret VALUE: a
 *     non-primary ES source's `es_api_key`, or a push/queue/object-store receiver's
 *     `sasl_password` / `secret_access_key` / `session_token` / `connection_string` /
 *     `credentials_json`, etc. The value lands in the in-memory secret tier keyed by
 *     source id (merged into that source's effective config at runtime); only the
 *     field NAMES are recorded on the SourceInstance (#10).
 *
 * A connector's `auth_fields` mark secrets with `secret: true`.
 */
import { api } from './api';
import type { ConnectorManifest, SecretsUpdate, SourceUpsert } from './types';

/** A connector form's value: non-secret config + secret values typed this session. */
export interface ConnectorFormValue {
  /** Non-secret config values, keyed by field key. */
  config: Record<string, unknown>;
  /** Secret values the operator typed THIS session, keyed by field key. */
  secrets: Record<string, string>;
}

/** Secret keys the backend accepts on POST /api/setup/secrets. */
export const KNOWN_SECRET_KEYS = new Set<keyof SecretsUpdate>([
  'es_api_key',
  'es_mgmt_api_key',
  'es_url',
  'es_ca_cert',
  'openai_api_key',
  'anthropic_api_key',
  'abuseipdb_api_key',
  'virustotal_api_key',
  'embedding_api_key',
]);

/** Field keys that are config in a connector but also map to known top-level secrets/wiring. */
const CONFIG_TO_SECRET_KEY: Record<string, keyof SecretsUpdate> = {
  es_url: 'es_url',
  es_ca_cert: 'es_ca_cert',
};

/**
 * Split a form value into:
 *   - `globalSecrets` : the SecretsUpdate body (known top-level keys) — populated ONLY
 *     for the PRIMARY source, or null; a non-primary source never writes global keys.
 *   - `sourceSecrets` : the per-source secret VALUES (field key → value) for everything
 *     else — a non-primary ES `es_api_key`, a receiver's `sasl_password`, etc.
 *   - `config`        : the non-secret connector config to store on the source.
 *
 * `opts.isPrimary` decides where the known ES keys go: on the primary they wire the
 * shared global client (byte-identical to the wizard flow); elsewhere they are
 * per-source so a second ES-family source cannot overwrite the primary's credentials.
 */
export function splitFormValue(
  _manifest: ConnectorManifest,
  value: ConnectorFormValue,
  opts: { isPrimary: boolean },
): {
  globalSecrets: SecretsUpdate | null;
  sourceSecrets: Record<string, string>;
  config: Record<string, unknown>;
} {
  const globalSecrets: Partial<SecretsUpdate> = {};
  const sourceSecrets: Record<string, string> = {};

  // typed secret VALUES from password fields
  for (const [key, v] of Object.entries(value.secrets)) {
    if (!v) continue;
    if (opts.isPrimary && KNOWN_SECRET_KEYS.has(key as keyof SecretsUpdate)) {
      globalSecrets[key as keyof SecretsUpdate] = v;
    } else {
      // Non-primary ES keys AND every receiver secret (sasl_password, secret_access_key,
      // session_token, connection_string, credentials_json, …) persist per-source.
      sourceSecrets[key] = v;
    }
  }

  // non-secret config; on the PRIMARY only, es_url/es_ca_cert ALSO wire the shared
  // global client. A non-primary ES source keeps them in its own config, where the
  // per-source ES client reads them (never clobbering the global connection).
  const config: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value.config)) {
    config[key] = v;
    if (opts.isPrimary) {
      const mapped = CONFIG_TO_SECRET_KEY[key];
      if (mapped && typeof v === 'string' && v) {
        globalSecrets[mapped] = v;
      }
    }
  }

  return {
    globalSecrets: Object.keys(globalSecrets).length ? (globalSecrets as SecretsUpdate) : null,
    sourceSecrets,
    config,
  };
}

/**
 * Persist a source: write global secrets (primary only), upsert the source instance,
 * then push any per-source secret values. Per-source secrets go LAST because the
 * `POST /api/sources/{id}/secrets` endpoint requires the source to already exist.
 */
export async function saveSource(
  manifest: ConnectorManifest,
  value: ConnectorFormValue,
  opts: {
    id: string;
    displayName: string;
    enabled: boolean;
    isPrimary: boolean;
    ingestMode?: string | null;
    /**
     * The source's DECLARED native severity-ladder ceiling. THREE-state, and the
     * distinction matters: `undefined` OMITS the key (the backend then carries the
     * stored declaration forward), while `null` explicitly CLEARS it. Only the source
     * editor passes this; a toggle/bulk/make-primary path must leave it undefined.
     */
    severityScaleMax?: number | null;
  },
): Promise<void> {
  const { globalSecrets, sourceSecrets, config } = splitFormValue(manifest, value, {
    isPrimary: opts.isPrimary,
  });
  if (globalSecrets) {
    await api.updateSecrets(globalSecrets);
  }
  const upsert: SourceUpsert = {
    id: opts.id,
    source_type: manifest.source_type,
    display_name: opts.displayName,
    enabled: opts.enabled,
    is_primary: opts.isPrimary,
    ingest_mode: opts.ingestMode ?? null,
    config,
    // Spread, never assign: an assigned `undefined` still serializes as an ABSENT key
    // today, but spreading makes the omit-vs-null contract explicit at the call site
    // instead of relying on that.
    ...('severityScaleMax' in opts ? { severity_scale_max: opts.severityScaleMax } : {}),
  };
  await api.upsertSource(upsert);
  const secretEntries = Object.entries(sourceSecrets).filter(([, v]) => v);
  if (secretEntries.length) {
    await api.setSourceSecrets(opts.id, Object.fromEntries(secretEntries));
  }
}

/** A URL-safe slug from a display name (for a default source id). */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      // Truncate BEFORE trimming hyphens so a 48-char cut that lands after a separator
      // never re-introduces a trailing '-' (which would yield a double-hyphen id).
      .slice(0, 48)
      .replace(/^-+|-+$/g, '') || 'source'
  );
}
