/**
 * Security — account two-factor (self-service) + SSO/OIDC configuration (admin).
 *
 * Two sections:
 *   1. "My account" — every authenticated user can enroll/disable TOTP MFA here
 *      (<MfaSetupCard>). When auth is OFF this page still renders but MFA is moot
 *      (there is no account); we surface a gentle note in that case.
 *   2. "Single sign-on" — admin-only (gated by <Can resource="settings" action="manage">):
 *      enable SSO, add/edit OIDC providers (Google/Microsoft presets + generic), set
 *      the client id + write-only client secret, group→role map, allowed domains/
 *      tenants, and the redirect/callback URL to register with the IdP.
 *
 * All provider config rides PUT /api/settings (prefs.sso); the client SECRET is set
 * separately via POST /api/auth/sso/providers/{id}/secret (write-only; the UI only
 * sees a configured-boolean). Operator-entered values are trusted text.
 */
import * as React from 'react';
import { ShieldCheck, KeyRound, Plus, Trash2, Save, Loader2, Copy, Check, Link2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import type { Preferences, SessionPolicy, SsoConfig, SsoProviderConfig, UserRole } from '@/lib/types';
import { useAuth } from '@/soc/auth';
import { Can } from '@/soc/components/Can';
import { PageHeader } from '@/soc/components/PageHeader';
import { MfaSetupCard } from '@/soc/components/MfaSetupCard';
import { LoadError } from '@/soc/components/LoadError';
import { SessionPolicySection, rbacEnabledOf } from '@/soc/components/SessionPolicyEditor';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import { Card, CardContent } from '@/ui/card';
import { Separator } from '@/ui/separator';
import { LoadingState } from '@/design-system';
import { Alert, AlertDescription } from '@/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

const ROLES: UserRole[] = [
  'super_admin',
  'soc_manager',
  'analyst_tier2',
  'analyst_tier1',
  'responder',
  'auditor',
];

const PROVIDER_PRESETS: Record<string, Partial<SsoProviderConfig>> = {
  google: { type: 'google', display_name: 'Google', scopes: 'openid email profile' },
  microsoft: { type: 'microsoft', display_name: 'Microsoft', scopes: 'openid email profile', tenant: 'organizations' },
  generic: { type: 'generic', display_name: '', scopes: 'openid email profile' },
};

function newProvider(type: 'google' | 'microsoft' | 'generic'): SsoProviderConfig {
  const id = `${type}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    enabled: true,
    client_id: '',
    allowed_domains: [],
    allowed_tenants: [],
    group_role_map: {},
    auto_create_users: false,
    default_role: 'analyst_tier1',
    ...PROVIDER_PRESETS[type],
  } as SsoProviderConfig;
}

function CopyField({ value }: { value: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted px-2 py-1 font-mono text-xs">
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1.5"
        aria-label={done ? 'Callback URL copied' : 'Copy callback URL'}
        onClick={() => {
          // copyText falls back to execCommand over plain HTTP (no secure context).
          void copyText(value).then((ok) => {
            if (ok) {
              setDone(true);
              window.setTimeout(() => setDone(false), 1500);
            } else {
              toast.error('Could not copy to clipboard.');
            }
          });
        }}
      >
        {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------- SSO provider editor -- */

function ProviderEditor({
  provider,
  callbackUrl,
  configuredSecret,
  onChange,
  onRemove,
  onSetSecret,
  embedded = false,
}: {
  provider: SsoProviderConfig;
  callbackUrl: string;
  configuredSecret: boolean;
  onChange: (next: SsoProviderConfig) => void;
  onRemove: () => void;
  onSetSecret: (clientSecret: string | null) => Promise<void>;
  embedded?: boolean;
}) {
  const [secretInput, setSecretInput] = React.useState('');
  const [savingSecret, setSavingSecret] = React.useState(false);
  const set = (patch: Partial<SsoProviderConfig>) => onChange({ ...provider, ...patch });

  const domains = (provider.allowed_domains ?? []).join(', ');
  const tenants = (provider.allowed_tenants ?? []).join(', ');
  const groupMapText = Object.entries(provider.group_role_map ?? {})
    .map(([g, r]) => `${g}=${r}`)
    .join('\n');

  return (
    <Card
      variant={embedded ? 'flat' : 'default'}
      className={embedded ? 'rounded-none border-t border-border/70' : undefined}
    >
      <CardContent className={embedded ? 'space-y-4 px-1 pb-6 pt-5' : 'space-y-4 p-5'}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="uppercase">{provider.type}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{provider.id}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor={`en-${provider.id}`} className="text-xs">Enabled</Label>
              <Switch
                id={`en-${provider.id}`}
                checked={Boolean(provider.enabled)}
                onCheckedChange={(v) => set({ enabled: v })}
              />
            </div>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={onRemove} aria-label="Remove provider">
              <Trash2 className="h-4 w-4 text-critical" aria-hidden />
            </Button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Display name</Label>
            <Input value={provider.display_name ?? ''} onChange={(e) => set({ display_name: e.target.value })} placeholder="Sign in with…" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Client ID</Label>
            <Input value={provider.client_id ?? ''} onChange={(e) => set({ client_id: e.target.value })} placeholder="OIDC client id" />
          </div>
          {provider.type === 'microsoft' ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Tenant</Label>
              <Input value={provider.tenant ?? ''} onChange={(e) => set({ tenant: e.target.value })} placeholder="organizations | common | {guid}" />
            </div>
          ) : null}
          {provider.type === 'generic' ? (
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">Discovery URL</Label>
              <Input value={provider.discovery_url ?? ''} onChange={(e) => set({ discovery_url: e.target.value })} placeholder="https://idp.example.com/.well-known/openid-configuration" />
            </div>
          ) : null}
        </div>

        {/* Client secret (write-only) */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Client secret</Label>
            <Badge variant={configuredSecret ? 'default' : 'outline'} className="text-2xs">
              {configuredSecret ? 'configured' : 'not set'}
            </Badge>
          </div>
          <div className="flex gap-2">
            <Input
              type="password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder={configuredSecret ? '•••••••• (set — leave blank to keep)' : 'paste the OIDC client secret'}
              autoComplete="off"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={savingSecret || !secretInput.trim()}
              onClick={async () => {
                setSavingSecret(true);
                try {
                  await onSetSecret(secretInput.trim());
                  setSecretInput('');
                } finally {
                  setSavingSecret(false);
                }
              }}
            >
              {savingSecret ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
              Save secret
            </Button>
          </div>
        </div>

        {/* Allowlists */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Allowed domains (comma-separated)</Label>
            <Input
              value={domains}
              onChange={(e) => set({ allowed_domains: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="acme.com, sub.acme.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Allowed tenants (comma-separated)</Label>
            <Input
              value={tenants}
              onChange={(e) => set({ allowed_tenants: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="tenant-guid"
            />
          </div>
        </div>

        {/* Group → role mapping */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Group claim</Label>
            <Input value={provider.group_claim ?? ''} onChange={(e) => set({ group_claim: e.target.value })} placeholder="groups | roles" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Default role</Label>
            <Select value={provider.default_role ?? 'analyst_tier1'} onValueChange={(v) => set({ default_role: v })}>
              <SelectTrigger aria-label="Default role"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`sso-group-role-map-${provider.id}`} className="text-xs">Group → role map (one per line, e.g. <span className="font-mono">soc-admins=super_admin</span>)</Label>
          <Textarea
            id={`sso-group-role-map-${provider.id}`}
            className="resize-y font-mono text-xs"
            rows={3}
            value={groupMapText}
            onChange={(e) => {
              const map: Record<string, string> = {};
              for (const line of e.target.value.split('\n')) {
                const [g, r] = line.split('=');
                if (g?.trim() && r?.trim()) map[g.trim()] = r.trim();
              }
              set({ group_role_map: map });
            }}
            placeholder={'soc-admins=super_admin\nanalysts=analyst_tier2'}
          />
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id={`acu-${provider.id}`}
            checked={Boolean(provider.auto_create_users)}
            onCheckedChange={(v) => set({ auto_create_users: v })}
          />
          <Label htmlFor={`acu-${provider.id}`} className="text-xs">
            Auto-provision new users on first sign-in (else only existing accounts may sign in)
          </Label>
        </div>

        <Separator />
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1.5 text-xs"><Link2 className="h-3.5 w-3.5" aria-hidden /> Redirect / callback URL (register this with the IdP)</Label>
          <CopyField value={callbackUrl} />
        </div>
      </CardContent>
    </Card>
  );
}

/* ----------------------------------------------------- self-service MFA card -- */

/**
 * The "My account · two-factor" block — every signed-in user can enroll/disable
 * TOTP MFA here. Exported so Settings can embed it under the Account (Personal)
 * group. Self-contained: loads its own `me` to read the enrolled state.
 */
export interface SecurityMfaInnerProps {
  /** True when hosted beneath the Settings workspace header. */
  embedded?: boolean;
}

export function SecurityMfaInner({ embedded = false }: SecurityMfaInnerProps) {
  const { authEnabled, isAuthenticated, username, refresh } = useAuth();
  const [mfaEnabled, setMfaEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<unknown>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const me = await api.auth.me();
      setMfaEnabled(Boolean(me.user?.mfa_enabled));
    } catch (error) {
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const onChanged = React.useCallback(async () => {
    await refresh();
    await load();
    toast.success('Two-factor settings updated.');
  }, [refresh, load]);

  return (
    <section
      aria-labelledby="account-two-factor-title"
      className={embedded ? 'space-y-4 border-t border-border/80 px-1 pb-5 pt-5' : 'space-y-3'}
      data-testid="two-factor-surface"
      data-surface={embedded ? 'embedded' : 'standalone'}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="account-two-factor-title"
            className={
              embedded
                ? 'text-base font-semibold tracking-tight text-foreground'
                : 'text-sm font-semibold text-foreground'
            }
          >
            Two-factor authentication
          </h2>
          {embedded ? (
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              Protect your account with a time-based code from an authenticator app.
            </p>
          ) : null}
        </div>
        {embedded && authEnabled && isAuthenticated && username && !loading && !loadError ? (
          <Badge variant={mfaEnabled ? 'success' : 'outline'}>
            {mfaEnabled ? 'Enabled' : 'Disabled'}
          </Badge>
        ) : null}
      </header>
      {!authEnabled ? (
        <Alert>
          <KeyRound aria-hidden />
          <AlertDescription>
            Authentication is disabled, so there is no account to protect. Enable auth on the
            backend to use two-factor sign-in.
          </AlertDescription>
        </Alert>
      ) : !isAuthenticated || !username ? (
        <Alert>
          <KeyRound aria-hidden />
          <AlertDescription>Sign in to manage two-factor authentication.</AlertDescription>
        </Alert>
      ) : loading ? (
        <LoadingState
          layout="panel"
          shape="panel"
          label="Loading two-factor settings"
          description="Checking your enrollment and recovery options."
        />
      ) : loadError ? (
        <LoadError
          error={loadError}
          fallback="Your enrollment status could not be verified."
          title="Could not load two-factor settings"
          onRetry={() => void load()}
        />
      ) : (
        <MfaSetupCard enabled={mfaEnabled} onChanged={onChanged} frameless={embedded} />
      )}
    </section>
  );
}

/* ------------------------------------------------------- admin SSO/OIDC block -- */

export interface SecuritySsoInnerProps {
  /**
   * When provided, the editor is CONTROLLED by the parent (Settings owns prefs.sso
   * and the single Save button) — there is no local load/save here. When omitted,
   * the block self-loads settings and renders its own "Save SSO settings" button
   * (the standalone /security route).
   */
  prefs?: Preferences | null;
  /** Controlled update of prefs.sso (embedded mode). */
  update?: (patch: Partial<Preferences>) => void;
  /** Controlled `configured` map (embedded mode); reads `sso_client_secrets`. */
  configured?: Record<string, boolean>;
  /** Use Settings' flat subsection hierarchy instead of standalone card chrome. */
  embedded?: boolean;
}

/**
 * The admin single-sign-on (OIDC) provider editor. Renders the token/session policy
 * editor above the providers. In CONTROLLED mode (Settings) the SSO config rides the
 * parent's prefs/update + the parent's single Save; in UNCONTROLLED mode (standalone
 * /security) it self-loads and has its own Save. Either way the per-provider client
 * secret is set via the separate write-only endpoint (`api.auth.sso.setSecret`), and
 * the `secretConfigured` booleans are preserved across both paths.
 *
 * Mount inside `<Can resource="settings" action="manage">`.
 */
export function SecuritySsoInner({
  prefs: controlledPrefs,
  update,
  configured: controlledConfigured,
  embedded = false,
}: SecuritySsoInnerProps) {
  const controlled = Boolean(update);

  // Uncontrolled (standalone) local state — only used when `update` is absent.
  const [localPrefs, setLocalPrefs] = React.useState<Preferences | null>(null);
  const [localConfigured, setLocalConfigured] = React.useState<Record<string, boolean>>({});
  const [loading, setLoading] = React.useState(!controlled);
  const [saving, setSaving] = React.useState(false);
  const [secretConfigured, setSecretConfigured] = React.useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = React.useState<unknown>(null);

  const callbackUrl = `${window.location.origin}/api/auth/sso/callback`;

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const s = await api.getSettings();
      setLocalPrefs(s.prefs);
      setLocalConfigured(s.configured ?? {});
    } catch (error) {
      setLoadError(error);
      setLocalPrefs(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!controlled) void load();
  }, [controlled, load]);

  const prefs = controlled ? controlledPrefs ?? null : localPrefs;
  const configured = controlled ? controlledConfigured ?? {} : localConfigured;
  const sso: SsoConfig = (prefs?.sso as SsoConfig) ?? { enabled: false, providers: [] };
  const providers = sso.providers ?? [];

  const updateSso = (next: SsoConfig) => {
    if (controlled) update?.({ sso: next });
    else setLocalPrefs((p) => (p ? { ...p, sso: next } : p));
  };

  const saveSso = async () => {
    if (!prefs) return;
    setSaving(true);
    try {
      await api.putSettings({ sso });
      toast.success('Single sign-on settings saved.');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save SSO settings.');
    } finally {
      setSaving(false);
    }
  };

  // Token/session policy: controlled by the parent's prefs/update in embedded mode.
  const policyProps = controlled
    ? {
        policy: (prefs?.session_policy as SessionPolicy | undefined) ?? {},
        onChange: (next: SessionPolicy) => update?.({ session_policy: next }),
        rbacEnabled: rbacEnabledOf(prefs),
      }
    : {};

  return (
    <>
      {/* Admin: Token & session policy */}
      <SessionPolicySection {...policyProps} embedded={embedded} />

      {/* Admin: SSO */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          {embedded ? (
            <h3 className="text-sm font-semibold text-foreground">Single sign-on (OIDC)</h3>
          ) : (
            <h2 className="text-sm font-semibold text-foreground">Single sign-on (OIDC)</h2>
          )}
          {/* In controlled (Settings) mode the parent owns the single Save button. */}
          {!controlled ? (
            <Button size="sm" onClick={saveSso} disabled={saving || !prefs}>
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
              Save SSO settings
            </Button>
          ) : null}
        </div>

        {loading ? (
          <LoadingState
            layout="panel"
            shape="panel"
            label="Loading single sign-on"
            description="Preparing provider and session-policy settings."
          />
        ) : loadError ? (
          <LoadError
            error={loadError}
            fallback="The identity-provider configuration could not be retrieved."
            title="Could not load single sign-on settings"
            onRetry={() => void load()}
          />
        ) : (
          <Card
            variant={embedded ? 'flat' : 'default'}
            className={embedded ? 'rounded-none border-t border-border/70' : undefined}
          >
            <CardContent className={embedded ? 'space-y-4 px-1 pb-5 pt-5' : 'space-y-4 p-5'}>
              <div className="flex items-center gap-2">
                <Switch
                  id="sso-enabled"
                  checked={Boolean(sso.enabled)}
                  onCheckedChange={(v) => updateSso({ ...sso, enabled: v })}
                />
                <Label htmlFor="sso-enabled" className="text-sm">Enable single sign-on</Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Add one or more OIDC providers below. Register the callback URL shown on each
                provider with your identity provider. Client secrets are stored server-side and
                never shown back.
              </p>
              <div className="flex flex-wrap gap-2">
                {(['google', 'microsoft', 'generic'] as const).map((t) => (
                  <Button
                    key={t}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => updateSso({ ...sso, providers: [...providers, newProvider(t)] })}
                  >
                    <Plus aria-hidden />
                    Add {t === 'generic' ? 'generic OIDC' : t}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {providers.map((p, idx) => (
          <ProviderEditor
            key={p.id}
            provider={p}
            callbackUrl={callbackUrl}
            // `configured.sso_client_secrets` is a GLOBAL boolean (true if ANY provider
            // has a stored secret), so it can only be trusted when there is exactly one
            // provider. With 2+ providers rely on the per-provider session flag, so a
            // secret-less provider is never falsely shown "configured" (backend handoff:
            // return a per-provider secret map to make the badge accurate for all).
            configuredSecret={
              Boolean(secretConfigured[p.id]) ||
              (providers.length === 1 && Boolean(configured.sso_client_secrets))
            }
            onChange={(next) => {
              const arr = [...providers];
              arr[idx] = next;
              updateSso({ ...sso, providers: arr });
            }}
            onRemove={() => updateSso({ ...sso, providers: providers.filter((_, i) => i !== idx) })}
            onSetSecret={async (clientSecret) => {
              try {
                const res = await api.auth.sso.setSecret(p.id, clientSecret);
                setSecretConfigured((m) => ({ ...m, [p.id]: Boolean(res.configured) }));
                toast.success('Client secret saved.');
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Could not save the secret.');
              }
            }}
            embedded={embedded}
          />
        ))}
      </section>
    </>
  );
}

/* --------------------------------------------------------------------- page -- */

export interface SecurityPageProps {
  onNavigate?: unknown;
}

/**
 * The full Security body, without the page header — self-service MFA followed by the
 * admin token-policy + SSO block (gated by `settings:manage`). Exported for tests /
 * any future embed. The standalone page wraps it with the PageHeader below.
 */
export function SecurityInner() {
  return (
    <div className="space-y-6">
      <SecurityMfaInner />
      <Can resource="settings" action="manage">
        <SecuritySsoInner />
      </Can>
    </div>
  );
}

export default function Security(_: SecurityPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="Security"
        description="Manage your two-factor authentication and (admins) single sign-on."
        icon={ShieldCheck}
      />
      <SecurityInner />
    </div>
  );
}
