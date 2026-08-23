/**
 * Co-located data layer for the ENRICHMENT-providers editor (Group 6 / Feature 7 /
 * Round 3 Wave 2). Wraps the low-level `api.get/post/put` helpers from `@/lib/api`
 * so this builder owns its own contracts without touching the shared `lib/api.ts`
 * or `lib/types.ts` (parallel-safety). Backend routes (`routes_enrichment.py`):
 *
 *   GET  /api/enrichment/providers
 *   GET  /api/enrichment/lookup?indicator=&kind=
 *   POST /api/enrichment/providers/{name}/secrets   (booleans-only response, #10)
 *
 * Provider enable/disable rides the SETTINGS PUT (`prefs.enrichment.use_*`) via the
 * shared `api.putSettings` — the manifest's `config_key` (e.g. `use_abuseipdb`) is
 * the `EnrichmentConfig` field flipped.
 *
 * Security: secrets are NEVER read or returned — only configured booleans (#10).
 * Every provider-returned string in a lookup is FENCED as UNTRUSTED by the backend
 * and rendered here inside an escaped CodeBlock (#9). The lookup is advisory and
 * never feeds `decide()` (#3).
 */
import { api } from '@/lib/api';

/* ---------------------------------------------------------------- types ----- */

/** One declared secret field on a provider (boolean state only — no value, #10). */
export interface ProviderSecretField {
  key: string;
  label: string;
  required: boolean;
  help?: string | null;
  help_link?: string | null;
  /** Whether this key currently has a value set (boolean only). */
  configured: boolean;
}

/** A provider manifest + its current config/key state from GET /enrichment/providers. */
export interface EnrichmentProviderManifest {
  name: string;
  display_name: string;
  description?: string | null;
  /** Indicator kinds this provider can enrich (ip/domain/url/file_hash/email/...). */
  indicator_kinds: string[];
  /** The `EnrichmentConfig` field that toggles this provider, e.g. `use_abuseipdb`. */
  config_key: string;
  /** Whether the provider is enabled by the current config. */
  enabled_by_config: boolean;
  /** True when the provider needs no key (keyless / free). */
  keyless: boolean;
  /** Whether the required key(s) are present (boolean only, #10). */
  key_present: boolean;
  secret_fields: ProviderSecretField[];
  /** A short free-tier note (plain UI string). */
  free_tier?: string | null;
  docs_url?: string | null;
  /** Whether this provider ships ON by default. */
  default_enabled: boolean;
  version?: string | null;
  /**
   * Ordered operator setup steps (Round 11) — fixed manifest strings (trusted UI
   * copy, plain text). Rendered as a collapsible "How to set up" ordered list.
   */
  setup_steps?: string[] | null;
  /** One-or-two-sentence "how this helps triage" blurb (fixed manifest string). */
  example?: string | null;
}

export interface EnrichmentProvidersResponse {
  enrichment_enabled: boolean;
  fusion_enabled: boolean;
  providers: EnrichmentProviderManifest[];
}

/** One fenced provider result row from a lookup (every string already escaped). */
export interface FencedProviderResult {
  provider?: string;
  kind?: string;
  indicator?: string;
  reputation_score?: number | null;
  is_malicious?: boolean | null;
  country?: string | null;
  method?: string | null;
  /** Free-form provider-returned fields — UNTRUSTED, render fenced. */
  [key: string]: unknown;
}

/** The fused lookup result for one observable. */
export interface EnrichmentLookupResult {
  indicator: string;
  kind: string;
  reputation_score?: number | null;
  is_malicious?: boolean | null;
  method?: string | null;
  country?: string | null;
  per_provider?: Record<string, unknown>;
  queried: number;
  providers: FencedProviderResult[];
}

/** Response from setting a provider's secrets (configured booleans only, #10). */
export interface ProviderSecretsResult {
  ok: boolean;
  provider: string;
  configured: Record<string, boolean>;
  key_present: boolean;
}

/* ----------------------------------------------------------------- calls ---- */

export const enrichmentApi = {
  providers: () => api.get<EnrichmentProvidersResponse>('enrichment/providers'),

  lookup: (indicator: string, kind?: string) =>
    api.get<EnrichmentLookupResult>('enrichment/lookup', {
      indicator,
      ...(kind ? { kind } : {}),
    }),

  setSecrets: (name: string, secrets: Record<string, string | null>) =>
    api.post<ProviderSecretsResult>(
      `enrichment/providers/${encodeURIComponent(name)}/secrets`,
      { secrets },
    ),

  /**
   * Flip one provider's `use_*` toggle (and/or the master enable / fusion flag, or the
   * numeric `cache_ttl_seconds`) via the shared settings PUT. The body is an additive
   * partial of `prefs.enrichment`; the proxy forwards arbitrary JSON. Returns the saved
   * Preferences subtree shape loosely (we only read it to confirm success).
   */
  setEnrichmentConfig: (patch: Record<string, boolean | number>) =>
    api.put<{ ok: boolean; prefs?: { enrichment?: Record<string, unknown> } }>('settings', {
      enrichment: patch,
    }),
};

/**
 * Indicator kinds accepted by the "try a lookup" box (mirrors backend IndicatorKind).
 * The auto-detect option uses a non-empty sentinel value (`'auto'`) because Radix
 * Select treats an empty-string value as the cleared/placeholder state, which would
 * render the trigger blank even when Auto-detect is the effective selection.
 */
export const INDICATOR_KINDS: readonly { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'ip', label: 'IP address' },
  { value: 'domain', label: 'Domain' },
  { value: 'url', label: 'URL' },
  { value: 'file_hash', label: 'File hash' },
  { value: 'email', label: 'Email' },
] as const;
