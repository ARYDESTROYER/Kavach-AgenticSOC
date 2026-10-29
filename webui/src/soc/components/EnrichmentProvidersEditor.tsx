/**
 * EnrichmentProvidersEditor: the multi-provider threat-intel control surface
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
 * Round 14 (SE6, F13): the editor lays out its own Settings groups ("Lookups" with the
 * two master switches as setting rows, "Providers" as a `ListRows` list with one switch
 * per row and an icon Refresh, "Try a lookup"); a provider opens a detail sheet with its
 * example, setup steps, links and write-only keys, instead of 38 bordered cards. Only
 * an exception ("Needs key" on an enabled provider) gets a status; no text under 12px.
 *
 * Security: secrets are write-only (#10); every provider-returned string in a lookup
 * is FENCED UNTRUSTED by the backend and shown in a CodeBlock (#9); the lookup is
 * advisory and never feeds the deterministic decision (#3).
 */
import * as React from 'react';
import { AlertCircle, ExternalLink, Globe, Loader2, Search, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/cn';
import { DASH, humanizeToken } from '@/lib/format';
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
import { RefreshButton } from './RefreshButton';
import { SecretField } from './SecretField';
import { ListRow, ListRows, StatusDot } from '@/design-system';
import { Callout } from '@/design-system/callout';
import { SettingRow, SettingsGroup } from '@/soc/pages/settings/primitives';
import { useReturnFocus } from '@/soc/hooks/useReturnFocus';

import { Button } from '@/ui/button';
import { Badge, type BadgeProps } from '@/ui/badge';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Skeleton } from '@/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

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

/* ----------------------------------------------------------- provider row --- */

/** A key-gated provider that is enabled but has no key cannot actually run. */
function providerNeedsKey(provider: EnrichmentProviderManifest): boolean {
  return provider.enabled_by_config && !provider.keyless && !provider.key_present;
}

/** The provider's key state in words: "Free", "Key set" or "Needs key". */
function keyStateLabel(provider: EnrichmentProviderManifest): string {
  if (provider.keyless) return 'Free';
  return provider.key_present ? 'Key set' : 'Needs key';
}

/**
 * One provider as a list row: its name opens the detail sheet, its description is the
 * muted line, the switch turns it on or off. "Needs key" is a warning status only when
 * the provider is on without its key (the exception); otherwise the key state is muted
 * meta ("Free", "Key set", "Needs key").
 */
const ProviderRow: React.FC<{
  provider: EnrichmentProviderManifest;
  canManage: boolean;
  toggling: boolean;
  onToggle: (provider: EnrichmentProviderManifest, on: boolean) => void;
  onOpen: (provider: EnrichmentProviderManifest) => void;
}> = ({ provider, canManage, toggling, onToggle, onOpen }) => {
  const needsKey = providerNeedsKey(provider);
  return (
    <ListRow
      // display_name + description are fixed manifest strings (trusted UI), plain text.
      title={provider.display_name}
      description={provider.description || undefined}
      status={needsKey ? <StatusDot tone="warning">Needs key</StatusDot> : undefined}
      meta={needsKey ? undefined : keyStateLabel(provider)}
      onOpen={() => onOpen(provider)}
      data-testid={`enrichment-provider-${provider.name}`}
      control={
        <span className="flex items-center gap-2">
          {toggling ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden /> : null}
          <Switch
            checked={provider.enabled_by_config}
            disabled={!canManage || toggling}
            onCheckedChange={(v) => onToggle(provider, v)}
            aria-label={`Enable ${provider.display_name}`}
          />
        </span>
      }
    />
  );
};

/**
 * The provider's detail sheet: what it does, an example, the indicator kinds, the free
 * tier, its docs link, the setup steps as an ordered list, and the write-only keys.
 * setup_steps/example are FIXED manifest strings (trusted UI copy), still rendered
 * defensively as plain text only (never markup).
 */
const ProviderSheet: React.FC<{
  provider: EnrichmentProviderManifest | null;
  canManage: boolean;
  onClose: () => void;
  onSecretConfigured: (name: string, key: string, configured: boolean, keyPresent: boolean) => void;
  /** Hands focus back to the provider row that opened the sheet (SPEC §3.3). */
  onCloseAutoFocus?: (event: Event) => void;
}> = ({ provider, canManage, onClose, onSecretConfigured, onCloseAutoFocus }) => {
  const setupSteps = (provider?.setup_steps ?? []).filter(
    (step): step is string => typeof step === 'string' && step.length > 0,
  );
  return (
    <Sheet open={provider !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <SheetContent side="right" size="default" className="flex flex-col p-0" onCloseAutoFocus={onCloseAutoFocus}>
        {provider ? (
          <>
            <SheetHeader>
              <SheetTitle className="pr-8">{provider.display_name}</SheetTitle>
              {provider.description ? (
                <SheetDescription>{provider.description}</SheetDescription>
              ) : null}
            </SheetHeader>
            <div className="flex-1 space-y-6 overflow-y-auto px-6 pb-6" data-testid="enrichment-provider-sheet">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">State</dt>
                <dd className="text-foreground">
                  {provider.enabled_by_config ? 'On' : 'Off'}
                  {provider.default_enabled ? ' (on by default)' : ''}
                </dd>
                <dt className="text-muted-foreground">Key</dt>
                <dd className="text-foreground">
                  {providerNeedsKey(provider) ? (
                    <StatusDot tone="warning">Needs key</StatusDot>
                  ) : (
                    keyStateLabel(provider)
                  )}
                </dd>
                <dt className="text-muted-foreground">Looks up</dt>
                <dd className="text-foreground">
                  {provider.indicator_kinds.map((k) => humanizeToken(k)).join(', ') || DASH}
                </dd>
                {provider.free_tier ? (
                  <>
                    <dt className="text-muted-foreground">Free tier</dt>
                    <dd className="text-foreground">{provider.free_tier}</dd>
                  </>
                ) : null}
              </dl>

              {provider.example ? (
                <p className="text-sm text-muted-foreground">{provider.example}</p>
              ) : null}

              {providerNeedsKey(provider) ? (
                <p className="text-sm text-warning-text">
                  This provider is on but has no API key. Add the key below so it can run.
                </p>
              ) : null}

              {setupSteps.length > 0 ? (
                <section aria-labelledby={`setup-${provider.name}`} className="space-y-2">
                  <h3 id={`setup-${provider.name}`} className="text-sm font-semibold text-foreground">
                    How to set up
                  </h3>
                  <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                    {setupSteps.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                </section>
              ) : null}

              {provider.docs_url ? (
                <a
                  href={provider.docs_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-sm text-sm text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Provider docs
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              ) : null}

              {provider.secret_fields.length > 0 ? (
                <section aria-labelledby={`keys-${provider.name}`} className="space-y-4">
                  <h3 id={`keys-${provider.name}`} className="text-sm font-semibold text-foreground">
                    {provider.secret_fields.length === 1 ? 'Key' : 'Keys'}
                  </h3>
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
                </section>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
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
    <div className="space-y-4" data-testid="enrichment-lookup">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="enr-indicator">Indicator</Label>
          <Input
            id="enr-indicator"
            placeholder="For example 8.8.8.8, evil.example.com or a SHA-256"
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
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2.5">
            <Badge variant="outline" className="font-mono">
              {humanizeToken(result.kind)}
            </Badge>
            <Badge variant={repVariant(result.reputation_score)}>
              reputation {typeof result.reputation_score === 'number' ? result.reputation_score : DASH}
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
            <span className="ml-auto text-sm text-muted-foreground">
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
        <p className="text-sm text-muted-foreground">
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
  // The provider whose detail sheet is open (by name, so it follows refreshed data).
  const [openName, setOpenName] = React.useState<string | null>(null);

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

  const openProvider = React.useMemo(
    () => providers.find((p) => p.name === openName) ?? null,
    [providers, openName],
  );
  // The sheet opens from a provider row (no Radix trigger): focus returns to that row's
  // name when it closes, so a keyboard user keeps their place in the list (SPEC §3.3).
  const sheetOpener = useReturnFocus();

  return (
    <div className={cn('space-y-10', className)}>
      {!embedded ? (
        <div className="space-y-1">
          <h2 className="text-md font-semibold text-foreground">Enrichment providers</h2>
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
          title="Could not load enrichment providers"
          onRetry={() => void load()}
        />
      ) : (
        <>
          <SettingsGroup title="Lookups" caption="Saved as soon as you change a switch.">
            <SettingRow
              variant="switch"
              label="Enrichment enabled"
              help="Master switch for all provider lookups."
              checked={enrichmentEnabled}
              disabled={!canManage || savingFlag || loading}
              onCheckedChange={(v) => void setMasterFlag('enabled', v)}
            />
            {/* Off is a live condition, stated in words; the provider list below stays at
                full contrast because it remains editable (WCAG 1.4.3, no dimming). */}
            {!enrichmentEnabled && !loading ? (
              <SettingRow variant="block">
                <Callout intent="warning" data-testid="enrichment-off-callout">
                  Enrichment is off. No provider is queried until you turn it on.
                </Callout>
              </SettingRow>
            ) : null}
            <SettingRow
              variant="switch"
              label="Fuse provider scores"
              help="Combine providers into one normalised reputation score."
              checked={fusionEnabled}
              disabled={!canManage || savingFlag || loading}
              onCheckedChange={(v) => void setMasterFlag('fusion_enabled', v)}
            />
          </SettingsGroup>

          <SettingsGroup
            title="Providers"
            caption={loading ? undefined : `${enabledCount} of ${providers.length} on`}
            action={
              <RefreshButton
                onClick={() => void load()}
                refreshing={loading}
                label="Refresh providers"
                display="icon"
              />
            }
          >
            {loading ? (
              <SettingRow variant="block">
                <div className="space-y-3">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              </SettingRow>
            ) : providers.length === 0 ? (
              <SettingRow variant="block">
                <EmptyState
                  icon={Globe}
                  title="No enrichment providers"
                  description="No providers are registered. Check the backend enrichment configuration."
                />
              </SettingRow>
            ) : (
              <SettingRow variant="block" bleed>
                <ListRows aria-label="Enrichment providers">
                  {providers.map((p) => (
                    <ProviderRow
                      key={p.name}
                      provider={p}
                      canManage={canManage}
                      toggling={togglingName === p.name}
                      onToggle={(prov, on) => void toggleProvider(prov, on)}
                      onOpen={(prov) => {
                        sheetOpener.remember();
                        setOpenName(prov.name);
                      }}
                    />
                  ))}
                </ListRows>
              </SettingRow>
            )}
            {!canManage && !loading ? (
              <SettingRow variant="block">
                <p className="text-sm text-muted-foreground">
                  You have read-only access to enrichment settings. Provider toggles and keys
                  need the enrichment:manage permission.
                </p>
              </SettingRow>
            ) : null}
          </SettingsGroup>
        </>
      )}

      {/* try a lookup: read-only; the server enforces enrichment:read */}
      <SettingsGroup
        title="Try a lookup"
        caption="Enrich one observable across the enabled providers, exactly as the investigator sees it."
      >
        <SettingRow variant="block">
          <LookupBox />
        </SettingRow>
      </SettingsGroup>

      <ProviderSheet
        provider={openProvider}
        canManage={canManage}
        onClose={() => setOpenName(null)}
        onCloseAutoFocus={sheetOpener.onCloseAutoFocus}
        onSecretConfigured={onSecretConfigured}
      />
    </div>
  );
}

export default EnrichmentProvidersEditor;
