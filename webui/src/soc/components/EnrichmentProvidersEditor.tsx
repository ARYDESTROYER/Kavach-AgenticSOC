/**
 * EnrichmentProvidersEditor — the multi-provider threat-intel control surface
 * (Group 6 / Feature 7 / Round 3 Wave 2).
 *
 * Lists every registered enrichment provider (GET /api/enrichment/providers) with:
 *   - a per-provider ENABLE toggle (flips `prefs.enrichment.use_*` via the settings
 *     PUT — the manifest's `config_key` is the field name),
 *   - a per-provider write-only SECRET entry (POST .../{name}/secrets; the console
 *     only ever shows a configured BOOLEAN, never a value — #10),
 *   - a "try a lookup" box (GET /api/enrichment/lookup) rendering the fused result +
 *     the per-provider rows inside escaped CodeBlocks (#9).
 *
 * Self-contained: it fetches the provider manifests itself and writes the enrichment
 * config through the shared settings PUT, so it works BOTH mounted inside the Settings
 * "enrichment" section AND as a standalone reachable surface. RBAC is enforced server-
 * side (enrichment:read / enrichment:manage); the UI additionally gates the mutating
 * controls behind <Can resource="enrichment" action="manage">.
 *
 * Security: secrets are write-only (#10); every provider-returned string in a lookup
 * is FENCED UNTRUSTED by the backend and shown in a CodeBlock (#9); the lookup is
 * advisory and never feeds the deterministic decision (#3).
 */
import * as React from 'react';
import {
  AlertCircle,
  ChevronDown,
  ExternalLink,
  Gift,
  Globe,
  KeyRound,
  Lightbulb,
  ListOrdered,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/cn';
import { humanizeToken } from '@/lib/format';
import {
  enrichmentApi,
  INDICATOR_KINDS,
  type EnrichmentLookupResult,
  type EnrichmentProviderManifest,
} from './EnrichmentProviders.api';

import { useCan } from './Can';
import { CodeBlock } from './CodeBlock';
import { EmptyState } from './EmptyState';
import { LoadError } from './LoadError';
import { SecretField } from './SecretField';

import { Button } from '@/ui/button';
import { Badge, type BadgeProps } from '@/ui/badge';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Skeleton } from '@/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Separator } from '@/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';

/* ---------------------------------------------------------------- helpers --- */

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Reputation score (0..100) → a calm badge variant. */
function repVariant(score?: number | null): BadgeProps['variant'] {
  if (typeof score !== 'number') return 'secondary';
  if (score >= 75) return 'critical';
  if (score >= 40) return 'high';
  if (score > 0) return 'warning';
  return 'success';
}

/* ----------------------------------------------------------- secret entry --- */

/**
 * A write-only secret field for one provider key, built on the SHARED `SecretField`
 * primitive (uniform reveal toggle + boolean status pill + explicit clear across every
 * secret surface). The console NEVER shows the value — only a "Configured" / "Not set"
 * boolean (#10). Saving posts the new value (via the Save button); clearing posts null
 * (via the primitive's "Remove stored value" affordance). An empty Save is blocked so a
 * stored secret can never be clobbered with a blank value.
 */
const ProviderSecretField: React.FC<{
  providerName: string;
  field: { key: string; label: string; required: boolean; help?: string | null; configured: boolean };
  canManage: boolean;
  onConfigured: (key: string, configured: boolean, keyPresent: boolean) => void;
}> = ({ providerName, field, canManage, onConfigured }) => {
  const [draft, setDraft] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const save = async (clear: boolean) => {
    const value = clear ? null : draft.trim();
    if (!clear && !value) {
      toast.message('Enter a value first.');
      return;
    }
    setSaving(true);
    try {
      const res = await enrichmentApi.setSecrets(providerName, { [field.key]: value });
      onConfigured(field.key, Boolean(res.configured[field.key]), res.key_present);
      setDraft('');
      toast.success(clear ? `${field.label} cleared.` : `${field.label} saved.`);
    } catch (e) {
      toast.error(errMsg(e, 'Could not update the secret.'));
    } finally {
      setSaving(false);
    }
  };

  if (!canManage) {
    return (
      <div className="space-y-1.5">
        <Label className="text-xs">{field.label}</Label>
        <p className="text-xs text-muted-foreground">
          You do not have permission to edit provider keys.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <SecretField
        label={field.label}
        description={field.help ?? undefined}
        configured={field.configured}
        required={field.required}
        value={draft}
        onChange={setDraft}
        disabled={saving}
        placeholder={field.configured ? '•••••••• (enter a new value to replace)' : 'Enter a value'}
        onClear={field.configured ? () => void save(true) : undefined}
        configuredLabel="Configured"
      />
      <Button size="sm" variant="outline" disabled={saving} onClick={() => void save(false)}>
        {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : 'Save'}
      </Button>
    </div>
  );
};

/* ---------------------------------------------------------- provider card --- */

const ProviderCard: React.FC<{
  provider: EnrichmentProviderManifest;
  canManage: boolean;
  toggling: boolean;
  onToggle: (provider: EnrichmentProviderManifest, on: boolean) => void;
  onSecretConfigured: (name: string, key: string, configured: boolean, keyPresent: boolean) => void;
}> = ({ provider, canManage, toggling, onToggle, onSecretConfigured }) => {
  const [open, setOpen] = React.useState(false);
  const [setupOpen, setSetupOpen] = React.useState(false);
  const hasSecrets = provider.secret_fields.length > 0;
  const enabled = provider.enabled_by_config;
  // A key-gated provider that is enabled but missing its key can't actually run.
  const needsKey = enabled && !provider.keyless && !provider.key_present;
  // setup_steps/example are FIXED manifest strings (trusted UI copy) — still
  // rendered defensively as plain text only (never markup).
  const setupSteps = (provider.setup_steps ?? []).filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Globe className="size-4" aria-hidden />
            </span>
            {/* display_name + description are fixed manifest strings (trusted UI). */}
            <p className="font-semibold text-foreground">{provider.display_name}</p>
            {provider.keyless ? (
              <Badge variant="success" className="gap-1">
                <Gift className="size-3" aria-hidden />
                Free
              </Badge>
            ) : provider.key_present ? (
              <Badge variant="info" className="gap-1">
                <KeyRound className="size-3" aria-hidden />
                Key set
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <KeyRound className="size-3" aria-hidden />
                Needs key
              </Badge>
            )}
            {provider.default_enabled ? (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                default on
              </Badge>
            ) : null}
          </div>
          {provider.description ? (
            <p className="text-sm text-muted-foreground">{provider.description}</p>
          ) : null}
          {provider.example ? (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Lightbulb className="mt-0.5 size-3 shrink-0" aria-hidden />
              {/* example is a fixed manifest UI string — plain text only */}
              <span className="italic">{provider.example}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {provider.indicator_kinds.map((k) => (
              <Badge key={k} variant="secondary" className="text-[10px]">
                {humanizeToken(k)}
              </Badge>
            ))}
          </div>
          {provider.free_tier ? (
            <p className="flex items-start gap-1.5 pt-1 text-xs text-muted-foreground">
              <Sparkles className="mt-0.5 size-3 shrink-0" aria-hidden />
              {/* free_tier is a fixed manifest UI string */}
              <span>{provider.free_tier}</span>
            </p>
          ) : null}
          {provider.docs_url ? (
            <a
              href={provider.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            >
              Provider docs
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
          {setupSteps.length > 0 ? (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setSetupOpen((o) => !o)}
                aria-expanded={setupOpen}
                className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ListOrdered className="size-3.5" aria-hidden />
                How to set up
                <ChevronDown
                  className={cn('size-3.5 transition-transform', setupOpen && 'rotate-180')}
                  aria-hidden
                />
              </button>
              {setupOpen ? (
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
                  {/* setup_steps are fixed manifest UI strings — plain text only */}
                  {setupSteps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            {toggling ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden /> : null}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Switch
                      checked={enabled}
                      disabled={!canManage || toggling}
                      onCheckedChange={(v) => onToggle(provider, v)}
                      aria-label={`Enable ${provider.display_name}`}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{enabled ? 'Enabled' : 'Disabled'}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {hasSecrets ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
            >
              <KeyRound className="size-3.5" aria-hidden />
              {provider.secret_fields.length === 1 ? 'Key' : 'Keys'}
              <ChevronDown
                className={cn('size-3.5 transition-transform', open && 'rotate-180')}
                aria-hidden
              />
            </Button>
          ) : null}
        </div>
      </div>

      {needsKey ? (
        <div className="border-t border-border px-4 py-2">
          <p className="flex items-center gap-1.5 text-xs text-warning-text">
            <KeyRound className="size-3.5" aria-hidden />
            Enabled but missing its API key — add it below so it can run.
          </p>
        </div>
      ) : null}

      {hasSecrets && open ? (
        <div className="space-y-4 border-t border-border bg-surface px-4 py-4">
          {provider.secret_fields.map((f) => (
            <ProviderSecretField
              key={f.key}
              providerName={provider.name}
              field={f}
              canManage={canManage}
              onConfigured={(key, configured, keyPresent) =>
                onSecretConfigured(provider.name, key, configured, keyPresent)
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

/* ------------------------------------------------------------- lookup box --- */

const LookupBox: React.FC = () => {
  const [indicator, setIndicator] = React.useState('');
  // 'auto' is the auto-detect sentinel (Radix Select needs a non-empty value).
  const [kind, setKind] = React.useState('auto');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [result, setResult] = React.useState<EnrichmentLookupResult | null>(null);

  const run = React.useCallback(async () => {
    const value = indicator.trim();
    if (!value) return;
    setLoading(true);
    setError(null);
    try {
      const res = await enrichmentApi.lookup(value, kind && kind !== 'auto' ? kind : undefined);
      setResult(res);
    } catch (e) {
      setError(e);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [indicator, kind]);

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="inline-flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Search className="size-4" aria-hidden />
        </span>
        <div>
          <p className="font-semibold text-foreground">Try a lookup</p>
          <p className="text-xs text-muted-foreground">
            Enrich one observable across the enabled providers — exactly what the
            investigator sees.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="enr-indicator">Indicator</Label>
          <Input
            id="enr-indicator"
            placeholder="e.g. 8.8.8.8, evil.example.com, a SHA-256…"
            value={indicator}
            onChange={(e) => setIndicator(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void run();
              }
            }}
            className="font-mono"
            aria-label="Indicator to enrich"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="enr-kind">Kind</Label>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger id="enr-kind" className="w-44" aria-label="Indicator kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INDICATOR_KINDS.map((k) => (
                <SelectItem key={k.value || 'auto'} value={k.value}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => void run()} disabled={!indicator.trim() || loading}>
          {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Search className="size-4" aria-hidden />}
          Look up
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Lookup failed</AlertTitle>
          <AlertDescription>{errMsg(error, 'Request failed.')}</AlertDescription>
        </Alert>
      ) : loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : result ? (
        <div className="space-y-3">
          {/* fused summary — values are backend-derived, rendered as plain badges */}
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2.5">
            <Badge variant="outline" className="font-mono">
              {humanizeToken(result.kind)}
            </Badge>
            <Badge variant={repVariant(result.reputation_score)}>
              reputation {typeof result.reputation_score === 'number' ? result.reputation_score : '—'}
            </Badge>
            {result.is_malicious ? (
              <Badge variant="critical" className="gap-1">
                {/* Threat-signaling icon (ShieldAlert), not ShieldCheck — a check-shield
                    reads as "safe/verified" and contradicts a malicious verdict (G9
                    non-color signaling). */}
                <ShieldAlert className="size-3" aria-hidden />
                flagged malicious
              </Badge>
            ) : (
              <Badge variant="success">no malicious verdict</Badge>
            )}
            {result.country ? (
              <Badge variant="secondary">{humanizeToken(result.country)}</Badge>
            ) : null}
            <span className="ml-auto text-xs text-muted-foreground">
              {result.queried} provider{result.queried === 1 ? '' : 's'} queried
            </span>
          </div>

          {result.providers.length === 0 ? (
            <EmptyState
              icon={Search}
              compact
              title="No provider returned data"
              description="No enabled, capable provider returned a result for this indicator. Enable more providers or add their keys above."
            />
          ) : (
            <div className="space-y-2">
              {result.providers.map((p, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="default">
                      {/* provider name is fenced/escaped backend data → plain text */}
                      {String(p.provider ?? `provider ${i + 1}`)}
                    </Badge>
                    {typeof p.reputation_score === 'number' ? (
                      <Badge variant={repVariant(p.reputation_score)}>
                        score {p.reputation_score}
                      </Badge>
                    ) : null}
                  </div>
                  {/* Whole result object is UNTRUSTED — render fenced (#9). */}
                  <CodeBlock value={p} wrap maxHeightClassName="max-h-60" />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Enter an indicator and run a lookup to preview the enrichment result. Results
          are cached and treated as untrusted evidence.
        </p>
      )}
    </div>
  );
};

/* -------------------------------------------------------------------- panel - */

export interface EnrichmentProvidersEditorProps {
  className?: string;
  /** Suppress the panel's own heading (when hosted inside a Settings section). */
  embedded?: boolean;
}

export function EnrichmentProvidersEditor({ className, embedded = false }: EnrichmentProvidersEditorProps) {
  const [providers, setProviders] = React.useState<EnrichmentProviderManifest[]>([]);
  const [enrichmentEnabled, setEnrichmentEnabled] = React.useState(true);
  const [fusionEnabled, setFusionEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  // provider name with an in-flight enable/disable toggle (disables its switch).
  const [togglingName, setTogglingName] = React.useState<string | null>(null);
  const [savingFlag, setSavingFlag] = React.useState(false);

  const canManage = useCan('enrichment', 'manage');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await enrichmentApi.providers();
      setProviders(res.providers ?? []);
      setEnrichmentEnabled(res.enrichment_enabled);
      setFusionEnabled(res.fusion_enabled);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  /** Flip one provider's `use_*` toggle through the settings PUT (optimistic). */
  const toggleProvider = React.useCallback(
    async (provider: EnrichmentProviderManifest, on: boolean) => {
      setTogglingName(provider.name);
      // optimistic
      setProviders((prev) =>
        prev.map((p) => (p.name === provider.name ? { ...p, enabled_by_config: on } : p)),
      );
      try {
        await enrichmentApi.setEnrichmentConfig({ [provider.config_key]: on });
        toast.success(`${provider.display_name} ${on ? 'enabled' : 'disabled'}.`);
      } catch (e) {
        // revert on failure
        setProviders((prev) =>
          prev.map((p) => (p.name === provider.name ? { ...p, enabled_by_config: !on } : p)),
        );
        toast.error(errMsg(e, 'Could not update the provider.'));
      } finally {
        setTogglingName(null);
      }
    },
    [],
  );

  const setMasterFlag = React.useCallback(
    async (field: 'enabled' | 'fusion_enabled', value: boolean) => {
      setSavingFlag(true);
      if (field === 'enabled') setEnrichmentEnabled(value);
      else setFusionEnabled(value);
      try {
        await enrichmentApi.setEnrichmentConfig({ [field]: value });
        toast.success('Enrichment settings saved.');
      } catch (e) {
        if (field === 'enabled') setEnrichmentEnabled(!value);
        else setFusionEnabled(!value);
        toast.error(errMsg(e, 'Could not save the setting.'));
      } finally {
        setSavingFlag(false);
      }
    },
    [],
  );

  const onSecretConfigured = React.useCallback(
    (name: string, key: string, configured: boolean, keyPresent: boolean) => {
      setProviders((prev) =>
        prev.map((p) =>
          p.name === name
            ? {
                ...p,
                key_present: keyPresent,
                secret_fields: p.secret_fields.map((f) =>
                  f.key === key ? { ...f, configured } : f,
                ),
              }
            : p,
        ),
      );
    },
    [],
  );

  /* ---- derived ---- */
  const enabledCount = React.useMemo(
    () => providers.filter((p) => p.enabled_by_config).length,
    [providers],
  );

  return (
    <div className={cn('space-y-6', className)}>
      {!embedded ? (
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            Enrichment providers
          </h2>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Threat-intel providers the investigator queries for IOC reputation, geo and
            context (cached in Redis). Keys are stored write-only; enrichment is advisory
            and never changes a case decision.
          </p>
        </div>
      ) : null}

      {/* On a providers-load failure, replace the config body (master flags + list) with
          the shared LoadError so we never show contradictory "no providers registered"
          copy alongside live, writable master switches. */}
      {error ? (
        <LoadError
          error={error}
          title="Couldn't load enrichment providers"
          onRetry={() => void load()}
        />
      ) : (
        <>
          {/* master flags */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Enrichment enabled</p>
                <p className="text-xs text-muted-foreground">
                  Master switch for all provider lookups.
                </p>
              </div>
              <Switch
                checked={enrichmentEnabled}
                disabled={!canManage || savingFlag || loading}
                onCheckedChange={(v) => void setMasterFlag('enabled', v)}
                aria-label="Enrichment enabled"
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Fuse provider scores</p>
                <p className="text-xs text-muted-foreground">
                  Combine providers into one normalised reputation score.
                </p>
              </div>
              <Switch
                checked={fusionEnabled}
                disabled={!canManage || savingFlag || loading}
                onCheckedChange={(v) => void setMasterFlag('fusion_enabled', v)}
                aria-label="Fuse provider scores"
              />
            </div>
          </div>

          {/* provider list */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Providers
                </p>
                {!loading ? (
                  <Badge variant="outline">
                    {enabledCount} of {providers.length} on
                  </Badge>
                ) : null}
              </div>
              <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
                <RefreshCw className={cn('size-4', loading && 'animate-spin')} aria-hidden />
                Refresh
              </Button>
            </div>

            {loading ? (
              <div className="space-y-3">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-28 w-full rounded-lg" />
                ))}
              </div>
            ) : providers.length === 0 ? (
              <EmptyState
                icon={Globe}
                title="No enrichment providers"
                description="No providers are registered. Check the backend enrichment configuration."
              />
            ) : (
              <div className={cn('space-y-3', !enrichmentEnabled && 'opacity-60')}>
                {providers.map((p) => (
                  <ProviderCard
                    key={p.name}
                    provider={p}
                    canManage={canManage}
                    toggling={togglingName === p.name}
                    onToggle={(prov, on) => void toggleProvider(prov, on)}
                    onSecretConfigured={onSecretConfigured}
                  />
                ))}
              </div>
            )}

            {!canManage && !loading ? (
              <p className="text-xs text-muted-foreground">
                You have read-only access to enrichment settings. Provider toggles and keys
                require the enrichment:manage permission.
              </p>
            ) : null}
          </div>
        </>
      )}

      <Separator />

      {/* try a lookup — read-only; the server enforces enrichment:read */}
      <LookupBox />
    </div>
  );
}

export default EnrichmentProvidersEditor;
