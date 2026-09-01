/**
 * Models — first-class LLM model administration (Round 3 / Feature 9).
 *
 * Promoted out of the Settings subsection into its own admin page. Three tabs:
 *   - Catalog            — every model with capability badges, pricing, provenance,
 *                          per-role assignment; per-row price-override + metered test.
 *   - Cost & budget      — a live cost estimator (POST /api/cost/estimate) and the
 *                          budget ceiling card with a burn-down (GET/PUT /api/budget,
 *                          GET /api/budget/status) using the Stage-1 chart primitives.
 *   - Providers          — the provider registry (anthropic/openai/azure/bedrock/
 *                          vertex/openai_compatible/mock) + configured booleans.
 *
 * RBAC: gated behind <ProtectedRoute resource="models" action="read">; the mutating
 * controls (price override, budget save, test call) additionally require
 * `models:manage` (driven by the existing <Can>/useCan guard).
 *
 * #9: model ids / labels / replies / errors are attacker-influenceable — rendered as
 * PLAIN text or in a fenced CodeBlock; never HTML, never re-fed into a prompt.
 * #3: nothing here touches case_manager.decide(); a budget only governs whether an LLM
 * call RUNS (enforced in the gateway, which fails to NEEDS_HUMAN).
 */
import * as React from 'react';
import {
  Cpu,
  RefreshCw,
  Loader2,
  DollarSign,
  Calculator,
  Server,
  CheckCircle2,
  XCircle,
  Save,
  Plus,
  Trash2,
  HardDrive,
  Radar,
} from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { Card } from '@/ui/card';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Textarea } from '@/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { KpiTile } from '@/soc/components/KpiTile';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { ProtectedRoute, useCan } from '@/soc/components/Can';
import { NumberField } from '@/soc/components/NumberField';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { SecretField } from '@/soc/components/SecretField';
import { ModelsCatalog } from '@/soc/components/ModelsCatalog';
import { BudgetCard } from '@/soc/components/BudgetCard';
import { LoadingState } from '@/design-system';
import {
  modelsApi,
  providerLabel,
  PRICING_SOURCE_META,
  type ModelCatalogRow,
  type ModelsCatalogResponse,
  type ProvidersResponse,
  type ModelTestResult,
  type CostEstimateResult,
} from './Models.api';

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

export default function Models() {
  return (
    <ProtectedRoute resource="models" action="read">
      <PageContainer variant="wide">
        <ModelsInner />
      </PageContainer>
    </ProtectedRoute>
  );
}

export function ModelsInner() {
  const canManage = useCan('models', 'manage');
  const [catalog, setCatalog] = React.useState<ModelsCatalogResponse | null>(null);
  const [providers, setProviders] = React.useState<ProvidersResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [providersError, setProvidersError] = React.useState<unknown>(null);
  const [providerFilter, setProviderFilter] = React.useState('all');

  // Per-model dialogs.
  const [priceFor, setPriceFor] = React.useState<ModelCatalogRow | null>(null);
  const [testFor, setTestFor] = React.useState<ModelCatalogRow | null>(null);
  // "Add local model" (self-hosted / LiteLLM) dialog + per-row remove busy id.
  const [addLocalOpen, setAddLocalOpen] = React.useState(false);
  const [removingId, setRemovingId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setProvidersError(null);
    try {
      const [cat, prov] = await Promise.all([
        modelsApi.catalog(),
        // Providers is a secondary panel: a providers-only failure must NOT fail the
        // whole page, but it must also not masquerade as an empty registry — capture it.
        modelsApi.providers().catch((e) => {
          setProvidersError(e);
          return null;
        }),
      ]);
      setCatalog(cat);
      if (prov) setProviders(prov);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const models = React.useMemo(() => catalog?.models ?? [], [catalog?.models]);
  const providerNames = React.useMemo(
    () => Array.from(new Set(models.map((m) => m.provider))).sort(),
    [models],
  );

  // If the filtered-to provider disappears from the catalog on refresh (e.g. its LLM key
  // was removed), fall back to "all" so the Select trigger never points at a removed
  // item (which blanks the trigger and hides every row behind a false "No models").
  React.useEffect(() => {
    if (providerFilter !== 'all' && !providerNames.includes(providerFilter)) {
      setProviderFilter('all');
    }
  }, [providerNames, providerFilter]);

  const exactCount = models.filter((m) => m.pricing_source === 'exact').length;
  const assignedCount = models.filter((m) => m.assigned_roles.length > 0).length;
  const overrideCount = models.filter((m) => m.price_overridden).length;
  const localModels = models.filter((m) => m.is_custom);

  const removeLocal = React.useCallback(
    async (row: ModelCatalogRow) => {
      setRemovingId(row.id);
      try {
        await modelsApi.removeCustom(row.id);
        toast.success(`Removed ${row.label || row.id}.`);
        await load();
      } catch (e) {
        toast.error(errMsg(e, 'Could not remove the local model.'));
      } finally {
        setRemovingId(null);
      }
    },
    [load],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Cpu}
        eyebrow="Administration"
        title="Models & LLMs"
        description="The model catalog, per-role routing, pricing, and the cost-budget ceiling."
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
            Refresh
          </Button>
        }
      />

      {loading && !catalog ? (
        <LoadingState
          layout="page"
          shape="rows"
          shapeRows={4}
          label="Loading model catalog"
          description="Preparing model routing, pricing, and provider status."
        />
      ) : error && !catalog ? (
        <LoadError error={error} title="Couldn't load models" onRetry={() => void load()} />
      ) : (
      <>
      <div className="grid border-y border-border/70 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Models" value={models.length} icon={Cpu} accent="primary" variant="strip" className="border-b border-border/70 sm:border-r lg:border-b-0" />
        <KpiTile label="Verified pricing" value={exactCount} accent="success" sub="exact rates" variant="strip" className="border-b border-border/70 lg:border-b-0 lg:border-r" />
        <KpiTile label="Assigned" value={assignedCount} accent="info" sub="to a role" variant="strip" className="border-b border-border/70 sm:border-b-0 sm:border-r" />
        <KpiTile label="Overrides" value={overrideCount} accent="medium" sub="operator prices" variant="strip" />
      </div>

      <Tabs defaultValue="catalog">
        <TabsList>
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="cost">Cost &amp; budget</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
        </TabsList>

        {/* --- Catalog --- */}
        <TabsContent value="catalog" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Every model the gateway can route. Pricing provenance is badged; an operator
              override pins a contract rate.
            </p>
            <div className="flex items-center gap-2">
              {canManage ? (
                <Button size="sm" variant="outline" onClick={() => setAddLocalOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Add local model
                </Button>
              ) : null}
              <div className="w-48">
                <Select value={providerFilter} onValueChange={setProviderFilter}>
                  <SelectTrigger aria-label="Filter by provider">
                    <SelectValue placeholder="All providers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All providers</SelectItem>
                    {providerNames.map((p) => (
                      <SelectItem key={p} value={p}>
                        {providerLabel(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <LocalModelsPanel
            rows={localModels}
            canManage={canManage}
            removingId={removingId}
            onRemove={removeLocal}
            onAdd={() => setAddLocalOpen(true)}
          />
          <ModelsCatalog
            rows={models}
            loading={loading}
            providerFilter={providerFilter}
            canManage={canManage}
            onEditPrice={(r) => setPriceFor(r)}
            onTest={(r) => setTestFor(r)}
          />
        </TabsContent>

        {/* --- Cost & budget --- */}
        <TabsContent value="cost" className="space-y-6">
          <CostEstimator models={models} />
          <BudgetCard canManage={canManage} />
        </TabsContent>

        {/* --- Providers --- */}
        <TabsContent value="providers" className="space-y-4">
          <ProvidersGrid
            providers={providers}
            loading={loading}
            error={providersError}
            onRetry={() => void load()}
          />
        </TabsContent>
      </Tabs>
      </>
      )}

      {priceFor ? (
        <PriceOverrideDialog
          model={priceFor}
          onClose={() => setPriceFor(null)}
          onSaved={() => {
            setPriceFor(null);
            void load();
          }}
        />
      ) : null}

      {testFor ? (
        <TestCallDialog model={testFor} onClose={() => setTestFor(null)} />
      ) : null}

      {addLocalOpen ? (
        <AddLocalModelDialog
          onClose={() => setAddLocalOpen(false)}
          onSaved={() => {
            setAddLocalOpen(false);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Local models panel — the operator's runtime-registered self-hosted / LiteLLM
// (OpenAI-compatible) models, with a Remove action. These ALSO appear in the full
// catalog table below; this panel is the management surface (add / remove).
// #9: every id / label / base_url is operator-influenceable → rendered PLAIN.
// --------------------------------------------------------------------------- //
function LocalModelsPanel({
  rows,
  canManage,
  removingId,
  onRemove,
  onAdd,
}: {
  rows: ModelCatalogRow[];
  canManage: boolean;
  removingId: string | null;
  onRemove: (row: ModelCatalogRow) => void;
  onAdd: () => void;
}) {
  if (!rows.length) return null;
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold text-foreground">Local &amp; self-hosted models</h2>
          <Badge variant="secondary" className="text-2xs">
            {rows.length}
          </Badge>
        </div>
        {canManage ? (
          <Button size="sm" variant="ghost" onClick={onAdd}>
            <Plus className="h-4 w-4" aria-hidden />
            Add
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Served over an OpenAI-compatible endpoint (LiteLLM / vLLM / Ollama / LM Studio).
        Metered at $0.
      </p>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{r.label}</span>
                <Badge variant="info" className="text-2xs">
                  Local
                </Badge>
                <Badge variant="secondary" className="text-2xs">
                  $0
                </Badge>
              </div>
              <div className="truncate font-mono text-2xs text-muted-foreground">
                {r.id}
                {r.base_url ? ` · ${r.base_url}` : ''}
              </div>
            </div>
            {canManage ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-critical"
                onClick={() => onRemove(r)}
                disabled={removingId === r.id}
                aria-label={`Remove ${r.id}`}
                title="Remove local model"
              >
                {removingId === r.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="h-4 w-4" aria-hidden />
                )}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --------------------------------------------------------------------------- //
// Add-local-model dialog (POST /api/llm/models/custom). Reuses the existing
// openai_compatible provider path; a local model is FREE ($0). An optional
// "Fetch models" probe (POST /api/llm/providers/test) is NON-metered.
// #9: the model id / label are plain data; the API key is a SecretField (#10).
// --------------------------------------------------------------------------- //
function AddLocalModelDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [modelId, setModelId] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [contextWindow, setContextWindow] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [fetching, setFetching] = React.useState(false);
  const [fetched, setFetched] = React.useState<string[] | null>(null);

  const canSave = baseUrl.trim().length > 0 && modelId.trim().length > 0;

  const fetchModels = async () => {
    if (!baseUrl.trim()) {
      toast.error('Enter a base URL first.');
      return;
    }
    setFetching(true);
    setFetched(null);
    try {
      const res = await modelsApi.providersTest(baseUrl.trim(), apiKey.trim() || undefined);
      if (res.ok) {
        setFetched(res.models);
        if (res.models.length) {
          if (!modelId.trim()) setModelId(res.models[0]);
          toast.success(res.message || `Found ${res.models.length} model(s).`);
        } else {
          toast.info('Reachable, but no models were returned — enter the model id manually.');
        }
      } else {
        toast.error(res.error || 'Could not reach the endpoint.');
      }
    } catch (e) {
      toast.error(errMsg(e, 'Could not reach the endpoint.'));
    } finally {
      setFetching(false);
    }
  };

  const save = async () => {
    if (!canSave) {
      toast.error('A base URL and a model id are required.');
      return;
    }
    setBusy(true);
    try {
      await modelsApi.addCustom({
        model_id: modelId.trim(),
        base_url: baseUrl.trim(),
        label: label.trim() || undefined,
        context_window: contextWindow > 0 ? contextWindow : undefined,
        api_key: apiKey.trim() || undefined,
      });
      toast.success(`Added ${label.trim() || modelId.trim()}.`);
      onSaved();
    } catch (e) {
      toast.error(errMsg(e, 'Could not add the local model.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a local model</DialogTitle>
          <DialogDescription>
            Register a self-hosted model served over an OpenAI-compatible endpoint
            (LiteLLM / vLLM / Ollama / LM Studio). It is metered at $0.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="local-base-url">
              Base URL <span className="text-critical">*</span>
            </Label>
            <div className="flex gap-2">
              <Input
                id="local-base-url"
                value={baseUrl}
                placeholder="http://localhost:4000/v1"
                onChange={(e) => setBaseUrl(e.target.value)}
                disabled={busy}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void fetchModels()}
                disabled={busy || fetching || !baseUrl.trim()}
                title="Reach the endpoint and list its models (not metered)"
              >
                {fetching ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Radar className="h-4 w-4" aria-hidden />
                )}
                Fetch models
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Usually ends in <span className="font-mono">/v1</span> — e.g.{' '}
              <span className="font-mono">http://localhost:4000/v1</span> (LiteLLM),{' '}
              <span className="font-mono">http://localhost:11434/v1</span> (Ollama).
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="local-model-id">
              Model id <span className="text-critical">*</span>
            </Label>
            {fetched && fetched.length ? (
              <Select value={modelId || undefined} onValueChange={setModelId}>
                <SelectTrigger aria-label="Fetched model id">
                  <SelectValue placeholder="— pick a model —" />
                </SelectTrigger>
                <SelectContent>
                  {fetched.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="local-model-id"
                value={modelId}
                placeholder="llama-3.1-8b-instruct"
                onChange={(e) => setModelId(e.target.value)}
                disabled={busy}
              />
            )}
            <p className="text-xs text-muted-foreground">
              The LiteLLM alias / Ollama tag / vLLM served-model name.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="local-label">Label (optional)</Label>
            <Input
              id="local-label"
              value={label}
              placeholder="Team Llama 3.1"
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
            />
          </div>

          <SecretField
            label="API key (optional)"
            description="Leave blank for a no-auth local server. Stored as a secret — never shown."
            configured={false}
            value={apiKey}
            onChange={setApiKey}
            placeholder="sk-… (optional)"
          />

          <NumberField
            label="Context window (optional)"
            value={contextWindow}
            onChange={setContextWindow}
            min={0}
            step={1024}
            unit="tokens"
          />

          <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface px-4 py-3">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium text-foreground">Free / $0</p>
              <p className="text-xs text-muted-foreground">
                A self-hosted model is metered at $0 (tokens are still recorded).
              </p>
            </div>
            {/* Always-on + disabled: a local model is $0 by contract. */}
            <Switch checked disabled aria-label="Free / $0 (local models are always free)" />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || !canSave}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Save className="h-4 w-4" aria-hidden />
            )}
            Add model
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- //
// Price-override dialog (PUT/DELETE /api/llm/models/{id}/pricing).
// --------------------------------------------------------------------------- //
function PriceOverrideDialog({
  model,
  onClose,
  onSaved,
}: {
  model: ModelCatalogRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [input, setInput] = React.useState(String(model.input_per_million));
  const [output, setOutput] = React.useState(String(model.output_per_million));
  const [busy, setBusy] = React.useState(false);

  const save = async () => {
    const inp = Number(input);
    const out = Number(output);
    if (!Number.isFinite(inp) || inp < 0 || !Number.isFinite(out) || out < 0) {
      toast.error('Enter non-negative numbers for both rates.');
      return;
    }
    setBusy(true);
    try {
      await modelsApi.setPricing(model.id, inp, out);
      toast.success(`Price override set for ${model.id}.`);
      onSaved();
    } catch (e) {
      toast.error(errMsg(e, 'Could not set the price override.'));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await modelsApi.clearPricing(model.id);
      toast.success(`Override cleared for ${model.id}.`);
      onSaved();
    } catch (e) {
      toast.error(errMsg(e, 'Could not clear the override.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Override pricing</DialogTitle>
          <DialogDescription>
            Pin a contract rate for <span className="font-mono">{model.id}</span> (USD per
            1M tokens). Overrides badge as “Exact”.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="price-in">Input / 1M</Label>
            <Input
              id="price-in"
              type="number"
              min={0}
              step="0.01"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="price-out">Output / 1M</Label>
            <Input
              id="price-out"
              type="number"
              min={0}
              step="0.01"
              value={output}
              onChange={(e) => setOutput(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          {model.price_overridden ? (
            <Button variant="outline" className="text-critical" onClick={() => void clear()} disabled={busy}>
              Clear override
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- //
// Test-call dialog (POST /api/llm/models/test) — metered; fenced output (#9).
// --------------------------------------------------------------------------- //
function TestCallDialog({ model, onClose }: { model: ModelCatalogRow; onClose: () => void }) {
  const [prompt, setPrompt] = React.useState('Reply with the single word: ok');
  const [mode, setMode] = React.useState<'chat' | 'embedding'>('chat');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ModelTestResult | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await modelsApi.test({
        model: model.id,
        provider: model.provider,
        prompt: prompt.slice(0, 2000),
        mode,
      });
      setResult(res);
      if (res.ok) toast.success(`${model.id} responded.`);
      else toast.error('Test call failed — see the response below.');
    } catch (e) {
      toast.error(errMsg(e, 'The test call could not be sent.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Test model</DialogTitle>
          <DialogDescription>
            Routes one tiny call through the one gateway against{' '}
            <span className="font-mono">{model.id}</span> — a completion, or the embedding
            probe. Either way it is metered and hits the cost ledger.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label>What to test</Label>
            <SegmentedControl
              aria-label="What to test"
              size="sm"
              value={mode}
              onValueChange={(v) => {
                setMode(v);
                setResult(null);
              }}
              options={[
                { value: 'chat', label: 'Completion' },
                { value: 'embedding', label: 'Embedding' },
              ]}
            />
            <p className="text-xs text-muted-foreground">
              {mode === 'chat'
                ? 'Sends the prompt as a completion.'
                : 'Embeds three fixed probe strings and reports what the endpoint actually returned — the evidence a self-hosted embedding endpoint is judged on, since the bundled catalog can hold no opinion about it.'}
            </p>
          </div>
          {mode === 'chat' ? (
            <div className="space-y-1.5">
              <Label htmlFor="test-prompt">Prompt</Label>
              <Textarea
                id="test-prompt"
                rows={3}
                value={prompt}
                maxLength={2000}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={busy}
              />
            </div>
          ) : null}

          {result ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={result.ok ? 'success' : 'critical'}>
                  {result.ok ? 'OK' : 'Error'}
                </Badge>
                {result.mode === 'embedding' ? (
                  <span className="text-xs text-muted-foreground">
                    {result.observed?.dimensions ?? '—'} dims ·{' '}
                    {result.observed?.provider || 'unknown provider'}
                  </span>
                ) : null}
                {result.ok && result.mode !== 'embedding' ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {result.prompt_tokens ?? 0} in · {result.completion_tokens ?? 0} out ·{' '}
                      {fmtMoney(result.cost ?? 0)}
                    </span>
                    {result.pricing_source ? (
                      <Badge
                        variant={
                          PRICING_SOURCE_META[String(result.pricing_source)]?.variant ?? 'secondary'
                        }
                        className="text-2xs"
                      >
                        {PRICING_SOURCE_META[String(result.pricing_source)]?.label ??
                          result.pricing_source}
                      </Badge>
                    ) : null}
                  </>
                ) : null}
              </div>
              {result.mode === 'embedding' ? (
                <>
                  {/* Every row is an OBSERVATION, so a refusal is arguable against
                      evidence rather than against a bundled capability list. */}
                  <ul className="space-y-1 text-xs">
                    {(result.checks ?? []).map((check) => (
                      <li key={check.id} className="flex items-start gap-2">
                        <Badge
                          variant={check.passed ? 'success' : 'critical'}
                          className="text-2xs shrink-0"
                        >
                          {check.passed ? 'pass' : 'fail'}
                        </Badge>
                        <span className="text-muted-foreground">
                          <span className="font-mono">{check.id}</span> — {check.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {result.catalog_declaration ? (
                    <p className="text-xs text-muted-foreground">
                      Bundled catalog: {result.catalog_declaration.state}
                      {result.catalog_declaration.state === 'unknown'
                        ? ' — normal for a self-hosted model; the probe above is the evidence.'
                        : null}
                    </p>
                  ) : null}
                  {/* Provider-derived text → fenced CodeBlock (#9). */}
                  <CodeBlock
                    value={result.message || result.error || '(no detail)'}
                    caption="What was observed"
                    wrap
                    maxHeightClassName="max-h-56"
                  />
                </>
              ) : (
                /* The reply / error is UNTRUSTED model output → fenced CodeBlock (#9). */
                <CodeBlock
                  value={
                    result.ok ? result.reply || '(empty reply)' : result.error || 'Unknown error'
                  }
                  caption={result.ok ? 'Model reply' : 'Error'}
                  wrap
                  maxHeightClassName="max-h-56"
                />
              )}
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Send test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- //
// Cost estimator (POST /api/cost/estimate) — a pre-flight USD estimate.
// --------------------------------------------------------------------------- //
function CostEstimator({ models }: { models: ModelCatalogRow[] }) {
  const [model, setModel] = React.useState(models[0]?.id ?? '');
  const [promptChars, setPromptChars] = React.useState(4000);
  const [maxTokens, setMaxTokens] = React.useState(1000);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<CostEstimateResult | null>(null);

  React.useEffect(() => {
    if (!model && models.length) setModel(models[0].id);
  }, [models, model]);

  const run = async () => {
    if (!model) {
      toast.error('Pick a model.');
      return;
    }
    setBusy(true);
    try {
      const res = await modelsApi.estimate({
        model,
        prompt_chars: Math.max(0, promptChars),
        max_tokens: Math.max(0, maxTokens),
      });
      setResult(res);
    } catch (e) {
      toast.error(errMsg(e, 'Estimate failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-center gap-2">
        <Calculator className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">Cost estimator</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        A pre-flight USD estimate for a prompt size + completion budget on one model.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1.5">
          <Label>Model</Label>
          <Select value={model || undefined} onValueChange={setModel}>
            <SelectTrigger aria-label="Model to estimate">
              <SelectValue placeholder="— model —" />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <NumberField
          label="Prompt chars"
          value={promptChars}
          onChange={setPromptChars}
          min={0}
          step={1}
        />
        <NumberField
          label="Max output tokens"
          value={maxTokens}
          onChange={setMaxTokens}
          min={0}
          step={1}
        />
        <div className="flex items-end">
          {/* Estimating is a pre-flight arithmetic call — it neither mutates state nor
              hits the cost ledger — so it is NOT gated on models:manage (only busy). */}
          <Button onClick={() => void run()} disabled={busy} className="w-full">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Estimate
          </Button>
        </div>
      </div>
      {result ? (
        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-success" aria-hidden />
            <span className="text-lg font-semibold tabular-nums text-foreground">
              {fmtMoney(result.estimated_cost, result.currency)}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {result.prompt_chars.toLocaleString()} chars · {result.max_tokens.toLocaleString()} max tokens
          </span>
          <Badge
            variant={PRICING_SOURCE_META[String(result.pricing_source)]?.variant ?? 'secondary'}
            className="text-2xs"
          >
            {PRICING_SOURCE_META[String(result.pricing_source)]?.label ?? result.pricing_source}
          </Badge>
        </div>
      ) : null}
    </Card>
  );
}

// --------------------------------------------------------------------------- //
// Providers grid (GET /api/llm/providers).
// --------------------------------------------------------------------------- //
function ProvidersGrid({
  providers,
  loading,
  error,
  onRetry,
}: {
  providers: ProvidersResponse | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  if (loading && !providers) {
    return (
      <LoadingState
        layout="panel"
        shape="panel"
        label="Loading model providers"
        description="Checking provider availability and model coverage."
      />
    );
  }
  // A providers-only fetch failure surfaces its own error+retry instead of the
  // misleading "No providers" empty state (which reads as an empty registry).
  if (error && !providers) {
    return <LoadError error={error} title="Couldn't load providers" onRetry={onRetry} />;
  }
  const rows = providers?.providers ?? [];
  if (!rows.length) {
    return (
      <EmptyState
        state="first-use"
        icon={Server}
        title="No model providers are registered"
        description="Provider configuration has not been added yet. Open Settings → Secret keys to configure a hosted provider, or add a compatible self-hosted model from the Catalog tab."
      />
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((p) => (
        <Card key={p.name} className="space-y-2 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-muted-foreground" aria-hidden />
              <span className="font-medium text-foreground">{providerLabel(p.name)}</span>
            </div>
            {p.configured ? (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="h-3 w-3" aria-hidden /> Configured
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <XCircle className="h-3 w-3" aria-hidden /> Not set
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{p.models.length} models</span>
            {p.supports_base_url ? <Badge variant="outline">Custom base URL</Badge> : null}
          </div>
        </Card>
      ))}
    </div>
  );
}
