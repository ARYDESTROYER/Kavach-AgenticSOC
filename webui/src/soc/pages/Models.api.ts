/**
 * Co-located API + types for the Models / LLM admin page (Round 3 / Feature 9).
 *
 * Kept OUT of the shared `lib/api.ts` (parallel-build hygiene). Endpoints (all `/api`):
 *   GET  /llm/models                — the catalog: capabilities, pricing, provenance,
 *                                     per-role assignment, operator overrides.
 *   GET  /llm/providers             — the provider registry + configured booleans.
 *   POST /llm/models/test           — route a tiny prompt through the ONE gateway
 *                                     (metered; hits the cost ledger) to verify a model.
 *   PUT  /llm/models/{id}/pricing   — set an operator per-model price override.
 *   DELETE /llm/models/{id}/pricing — clear the override.
 *   POST /cost/estimate             — a pre-flight USD estimate for a prompt + budget.
 *   GET/PUT /budget                 — read / update the cost-budget ceiling config.
 *   GET  /budget/status             — live rolling spend vs the ceilings (burn-down).
 *
 * #9: every model id / label / reply / error string is attacker-influenceable; the
 * server returns them PLAIN and bounded, and the UI renders them as plain text or in a
 * fenced CodeBlock — never HTML, never a prompt input.
 */
import { api } from '@/lib/api';
import { humanizeToken } from '@/lib/format';

export type PricingSource = 'exact' | 'heuristic' | 'zero' | 'default';

/**
 * Canonical display labels for known provider ids — the backend returns lowercase
 * codes (`openai`, `openai_compatible`), which `humanizeToken` alone renders as
 * "Openai" / "Openai compatible". Use this for a consistent, correctly-cased label on
 * EVERY provider surface (the catalog filter, the providers grid, the catalog table).
 */
const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  azure: 'Azure OpenAI',
  azure_openai: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
  aws_bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex',
  vertex_ai: 'Google Vertex',
  google: 'Google',
  openai_compatible: 'OpenAI-compatible',
  ollama: 'Ollama',
  cohere: 'Cohere',
  mistral: 'Mistral',
  mock: 'Mock',
};

/** A consistent, correctly-cased display label for a provider id (fallback: humanized). */
export function providerLabel(id?: string | null): string {
  if (!id) return humanizeToken(id);
  return PROVIDER_LABELS[id.toLowerCase()] ?? humanizeToken(id);
}

/** One row of GET /api/llm/models. */
export interface ModelCatalogRow {
  id: string;
  label: string;
  provider: string;
  context_window: number;
  max_output: number;
  modalities: string[];
  capabilities: string[];
  input_per_million: number;
  output_per_million: number;
  cache_write_per_million: number | null;
  cache_read_per_million: number | null;
  /**
   * The batch-API discount multiplier (default 0.5 = half list price) applied to BOTH
   * the input and output rate for a batched (async, non-interactive) call. Additive —
   * older backends omit it; treat an absent/invalid value as "no batch discount" (1×).
   */
  batch_multiplier: number | null;
  base_url: string | null;
  pricing_source: PricingSource | string;
  assigned_roles: string[];
  price_overridden: boolean;
  /**
   * True for an operator-registered self-hosted / LiteLLM (OpenAI-compatible) model
   * added at runtime (task 7). Such rows are FREE ($0), carry a `base_url`, and can be
   * removed. Additive — older backends omit it (treat absent as `false`).
   */
  is_custom?: boolean;
}

/**
 * The batched (async) input + output rate for a catalog row, derived from the
 * per-model ``batch_multiplier`` (default 0.5). Returns ``null`` when there is no real
 * discount (multiplier absent, ≥1, or non-finite) so the UI can show a dash rather than
 * a misleading "same as list" batch column. Pure — no I/O, safe to call per-render.
 */
export function batchRates(
  row: Pick<ModelCatalogRow, 'input_per_million' | 'output_per_million' | 'batch_multiplier'>,
): { input: number; output: number; multiplier: number } | null {
  const m = row.batch_multiplier;
  if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0 || m >= 1) return null;
  return {
    input: row.input_per_million * m,
    output: row.output_per_million * m,
    multiplier: m,
  };
}

/** GET /api/llm/models. */
export interface ModelsCatalogResponse {
  models: ModelCatalogRow[];
  providers: Record<string, string[]>;
  configured: Record<string, boolean>;
  overrides: Record<string, { input: number; output: number }>;
}

/** One provider row of GET /api/llm/providers. */
export interface ProviderRow {
  name: string;
  configured: boolean;
  models: string[];
  supports_base_url: boolean;
}

export interface ProvidersResponse {
  providers: ProviderRow[];
}

/** One assertion the embedding probe made about what the endpoint actually returned. */
export interface ModelProbeCheck {
  id: string;
  passed: boolean;
  detail: string;
}

/** What the embedding probe OBSERVED. Every field is a measurement, never a claim. */
export interface ModelProbeObserved {
  provider: string;
  model: string;
  fallback: boolean;
  fallback_reason: string;
  vectors_returned: number;
  dimensions: number | null;
  dimensions_stable: boolean | null;
  self_similarity: number | null;
  contrast_similarity: number | null;
  distinct_vectors: boolean | null;
}

/**
 * POST /api/llm/models/test result (success or a fenced error).
 *
 * `mode: 'chat'` (the default) fills `reply`/token counts. `mode: 'embedding'` runs
 * the empirical probe instead and fills `checks`/`observed`/`message` — the evidence a
 * self-hosted embedding endpoint is judged on, since the bundled catalog can hold no
 * opinion about it. `catalog_declaration.state` is CONTEXT only: `unknown` is the
 * normal state for a self-hosted model and must never be rendered as a failure.
 */
export interface ModelTestResult {
  ok: boolean;
  mode?: 'chat' | 'embedding' | string;
  model: string;
  provider: string;
  reply?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  pricing_source?: PricingSource | string;
  base_url?: string | null;
  error?: string;
  checks?: ModelProbeCheck[];
  observed?: ModelProbeObserved;
  message?: string;
  catalog_declaration?: {
    state: 'declared' | 'declared_absent' | 'unknown' | string;
    catalog_models: number;
    declaring_models: number;
  };
}

/** POST /api/cost/estimate result. */
export interface CostEstimateResult {
  model: string;
  prompt_chars: number;
  max_tokens: number;
  estimated_cost: number;
  currency: string;
  pricing_source: PricingSource | string;
}

/** The cost-budget ceiling config (mirrors backend BudgetConfig). */
export interface BudgetConfig {
  enabled: boolean;
  daily_usd: number | null;
  monthly_usd: number | null;
  soft_warn_pct: number;
  on_exceed: 'warn' | 'block';
}

/** One window's status in GET /api/budget/status. */
export interface BudgetWindowStatus {
  spent: number;
  cap: number | null;
  fraction: number | null;
  band: 'ok' | 'warn' | 'over' | string;
}

/** GET /api/budget/status. */
export interface BudgetStatus {
  enabled: boolean;
  on_exceed: 'warn' | 'block' | string;
  soft_warn_pct: number;
  currency: string;
  daily: BudgetWindowStatus;
  monthly: BudgetWindowStatus;
}

/** Body for POST /api/llm/models/custom (register a self-hosted / LiteLLM model). */
export interface CustomModelInput {
  model_id: string;
  base_url: string;
  label?: string;
  context_window?: number;
  api_key?: string;
}

/** One registered custom-model row echoed by POST /api/llm/models/custom. */
export interface CustomModelRow {
  id: string;
  label: string;
  base_url: string;
  provider: string;
  context_window: number;
  input_per_million: number;
  output_per_million: number;
}

/** POST /api/llm/providers/test — a NON-metered reachability + fetch-models probe. */
export interface ProviderTestResult {
  ok: boolean;
  models: string[];
  message?: string;
  error?: string;
}

export const modelsApi = {
  catalog: () => api.get<ModelsCatalogResponse>('llm/models'),
  providers: () => api.get<ProvidersResponse>('llm/providers'),
  /**
   * Send a live test call. `mode: 'embedding'` runs the empirical embedding probe
   * (does this endpoint really return usable vectors?) instead of a completion.
   */
  test: (body: {
    model: string;
    provider?: string;
    prompt?: string;
    mode?: 'chat' | 'embedding';
  }) => api.post<ModelTestResult>('llm/models/test', body),
  /** Register a self-hosted / LiteLLM (OpenAI-compatible) model at runtime ($0). */
  addCustom: (body: CustomModelInput) =>
    api.post<{ ok: boolean; model: CustomModelRow; configured: Record<string, boolean> }>(
      'llm/models/custom',
      body,
    ),
  /** Remove a registered custom model (+ clears its $0 overlay server-side). */
  removeCustom: (modelId: string) =>
    api.del<{ ok: boolean; model: string; removed: boolean }>(
      `llm/models/custom/${encodeURIComponent(modelId)}`,
    ),
  /** NON-metered reachability + "fetch models" probe for an OpenAI-compatible endpoint. */
  providersTest: (base_url: string, api_key?: string) =>
    api.post<ProviderTestResult>('llm/providers/test', { base_url, api_key }),
  setPricing: (modelId: string, input_per_million: number, output_per_million: number) =>
    api.put<{ ok: boolean; model: string; pricing: { input: number; output: number }; pricing_source: string }>(
      `llm/models/${encodeURIComponent(modelId)}/pricing`,
      { input_per_million, output_per_million },
    ),
  clearPricing: (modelId: string) =>
    api.del<{ ok: boolean; model: string; removed: boolean; pricing_source: string }>(
      `llm/models/${encodeURIComponent(modelId)}/pricing`,
    ),
  estimate: (body: { model: string; prompt?: string; prompt_chars?: number; max_tokens?: number }) =>
    api.post<CostEstimateResult>('cost/estimate', body),
  getBudget: () => api.get<{ budget: BudgetConfig }>('budget'),
  putBudget: (budget: BudgetConfig) =>
    api.put<{ ok: boolean; budget: BudgetConfig }>('budget', budget),
  budgetStatus: () => api.get<BudgetStatus>('budget/status'),
};

/** Provenance badge metadata — variant + label for a pricing source. */
export const PRICING_SOURCE_META: Record<
  string,
  { label: string; variant: 'success' | 'warning' | 'info' | 'secondary' }
> = {
  exact: { label: 'Exact', variant: 'success' },
  heuristic: { label: 'Heuristic', variant: 'warning' },
  zero: { label: 'Free', variant: 'info' },
  default: { label: 'Default', variant: 'secondary' },
};
