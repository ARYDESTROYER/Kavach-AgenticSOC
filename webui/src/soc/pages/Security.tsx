/**
 * Security: account two-factor (self-service) + SSO/OIDC configuration (admin).
 *
 * Two parts, each a Settings section (Round 14 grouped panels, D28):
 *   1. "Security & two-factor": every authenticated user can enroll or disable TOTP
 *      MFA here (<MfaSetupCard>). When auth is OFF this still renders but MFA is moot
 *      (there is no account); a gentle note says so.
 *   2. "Single sign-on & policy": admin-only (gated by <Can resource="settings" action="manage">):
 *      enable SSO, add/edit OIDC providers (Google/Microsoft presets + generic), set
 *      the client id + write-only client secret, group→role map, allowed domains/
 *      tenants, and the redirect/callback URL to register with the IdP.
 *
 * All provider config rides PUT /api/settings (prefs.sso); the client SECRET is set
 * separately via POST /api/auth/sso/providers/{id}/secret (write-only; the UI only
 * sees a configured-boolean). Operator-entered values are trusted text.
 */
import * as React from 'react';
import { KeyRound, Plus, Trash2, Save, Loader2, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import type { Preferences, SessionPolicy, SsoConfig, SsoProviderConfig, UserRole } from '@/lib/types';
import { useAuth } from '@/soc/auth';
import { Can } from '@/soc/components/Can';
import { MfaSetupCard } from '@/soc/components/MfaSetupCard';
import { LoadError } from '@/soc/components/LoadError';
import { SessionPolicySection, rbacEnabledOf } from '@/soc/components/SessionPolicyEditor';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { LoadingState, StatusDot } from '@/design-system';
import { Field } from '@/soc/components/Field';
import { SecretField } from '@/soc/components/SecretField';
import { TagInput } from '@/soc/components/TagInput';
import { ROLE_LABELS } from '@/soc/pages/Roles.api';
import {
  SettingRow,
  SettingsGroup,
  SettingsPageSection,
  SettingsSection,
  TextPref,
} from '@/soc/pages/settings/primitives';

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

/**
 * The Add buttons name each provider as its maker writes it ("Add Google", "Add
 * Microsoft"), never the lower-case type id the config stores.
 */
/** The provider kind as its maker writes it. */
const SSO_PROVIDER_NAME: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  generic: 'Generic OIDC',
};

const SSO_PROVIDER_ADD_LABEL: Record<'google' | 'microsoft' | 'generic', string> = {
  google: 'Add Google',
  microsoft: 'Add Microsoft',
  generic: 'Add generic OIDC',
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
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted px-2 py-1 font-mono text-sm" title={value}>
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0 gap-1.5"
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

/**
 * An allowlist as the tag field hands it over, cleaned: an entry pasted as a list
 * ("acme.com, sub.acme.com") becomes one entry per item, blanks go, and a repeat that
 * differs only in case is dropped (the backend compares both lists without case).
 */
export function normaliseAllowList(items: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const part of item.split(/[\s,]+/)) {
      const value = part.trim();
      const key = value.toLowerCase();
      if (value && !seen.has(key)) {
        seen.add(key);
        out.push(value);
      }
    }
  }
  return out;
}

/** An allowed domain is the part after the @ of an email address, never the address. */
function domainProblem(tag: string): string | null {
  return tag.includes('@') ? 'Enter the domain only, such as acme.com, without a name or @.' : null;
}

const KNOWN_ROLES: ReadonlySet<string> = new Set(ROLES);

/** The group to role map as text: one `group=role` line per mapping. */
function groupMapText(map: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(map ?? {})
    .map(([group, role]) => `${group}=${role}`)
    .join('\n');
}

/** A map's identity for comparison: its entries in order. */
function groupMapKey(map: Readonly<Record<string, string>> | undefined): string {
  return JSON.stringify(Object.entries(map ?? {}));
}

export interface GroupRoleMapParse {
  /** The mappings on lines that read as `group=role` with a known role, first line wins. */
  map: Record<string, string>;
  /** One sentence per line that is not used, in line order. */
  problems: string[];
}

/**
 * Reads the group to role map text. A blank line is skipped. A line without a group, an
 * equals sign and a role, a line whose role is not one of the six roles, and a second
 * line for a group already mapped are each reported, never dropped without a word.
 */
export function parseGroupRoleMap(text: string): GroupRoleMapParse {
  const entries: Array<[string, string]> = [];
  const firstLine = new Map<string, number>();
  const problems: string[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const n = index + 1;
    const eq = line.indexOf('=');
    const group = eq === -1 ? '' : line.slice(0, eq).trim();
    const role = eq === -1 ? '' : line.slice(eq + 1).trim();
    if (!group || !role) {
      problems.push(`Line ${n}: write it as group=role.`);
    } else if (!KNOWN_ROLES.has(role)) {
      problems.push(`Line ${n}: ${role} is not a role.`);
    } else if (firstLine.has(group)) {
      problems.push(`Line ${n}: ${group} is already mapped on line ${firstLine.get(group)}.`);
    } else {
      firstLine.set(group, n);
      entries.push([group, role]);
    }
  });
  // fromEntries defines own properties, so a group named like an Object key stays data.
  return { map: Object.fromEntries(entries), problems };
}

/** At most three problems in the message; the rest are counted. */
function groupMapMessage(problems: readonly string[], edited: boolean): string | undefined {
  if (problems.length === 0) return undefined;
  const shown = problems.slice(0, 3);
  const more = problems.length - shown.length;
  const parts = [...shown];
  if (more > 0) parts.push(more === 1 ? 'One more line has a problem.' : `${more} more lines have a problem.`);
  if (edited) parts.push(problems.length === 1 ? 'That line is not saved.' : 'Those lines are not saved.');
  return parts.join(' ');
}

/**
 * The group to role map as a text area. The text is kept exactly as typed, so a new
 * line or a half-typed mapping never vanishes under the cursor; every edit stores the
 * mappings that read correctly, and a line that does not is reported once focus leaves
 * the field. When the stored map changes from outside (a discard, a reload) to
 * something the text does not already say, the text follows it. The control id is
 * namespaced per provider, so two providers never share a DOM id and each label focuses
 * its own map.
 */
function GroupRoleMapField({
  id,
  value,
  onChange,
}: {
  /** The control id, unique per provider. */
  id: string;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const valueKey = groupMapKey(value);
  const [text, setText] = React.useState(() => groupMapText(value));
  const [syncedKey, setSyncedKey] = React.useState(valueKey);
  const [edited, setEdited] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const parsed = React.useMemo(() => parseGroupRoleMap(text), [text]);
  if (syncedKey !== valueKey) {
    setSyncedKey(valueKey);
    if (groupMapKey(parsed.map) !== valueKey) {
      setText(groupMapText(value));
      setEdited(false);
    }
  }
  const error = focused ? undefined : groupMapMessage(parsed.problems, edited);

  return (
    <Field
      label="Group to role map"
      description={`One mapping per line: a group, an equals sign, then a role, for example soc-admins=super_admin. Roles: ${ROLES.join(', ')}.`}
      error={error}
    >
      {/* A single element: Field keeps this id, points the label at it, and adds the
          description, error and aria-invalid wiring. */}
      <Textarea
        id={id}
        // The same critical border as a number or tag field with an error.
        className={cn('resize-y font-mono text-sm', error && 'border-critical hover:border-critical')}
        rows={3}
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          setEdited(true);
          const map = parseGroupRoleMap(next).map;
          if (groupMapKey(map) !== valueKey) onChange(map);
        }}
        placeholder={'soc-admins=super_admin\nanalysts=analyst_tier2'}
      />
    </Field>
  );
}

/* ---------------------------------------------------------- SSO provider editor -- */

/**
 * One OIDC provider as a group of Settings rows (SPEC §4.9.6): every value is a labelled
 * row (`TextPref`, the shared `TagInput` and `SecretField`, the group to role map, a
 * select row, a switch row), so each input's accessible name is its visible label (WCAG
 * 1.3.1 and 2.5.3) rather than a placeholder. The two allowlists are tag fields, so a
 * typed comma or space adds an entry instead of being eaten by a re-split of the text.
 * The provider's settings ride the Settings save; its client secret is written on its own
 * through the write-only secret route, only a configured flag ever comes back, and the
 * typed secret is cleared only once the write succeeded.
 */
function ProviderEditor({
  provider,
  callbackUrl,
  configuredSecret,
  onChange,
  onRemove,
  onSetSecret,
}: {
  provider: SsoProviderConfig;
  callbackUrl: string;
  configuredSecret: boolean;
  onChange: (next: SsoProviderConfig) => void;
  onRemove: () => void;
  /** Writes the client secret; true when it was stored. A failure keeps the typed value. */
  onSetSecret: (clientSecret: string | null) => Promise<boolean>;
}) {
  const [secretInput, setSecretInput] = React.useState('');
  const [savingSecret, setSavingSecret] = React.useState(false);
  const set = (patch: Partial<SsoProviderConfig>) => onChange({ ...provider, ...patch });

  const kind = SSO_PROVIDER_NAME[provider.type] ?? provider.type;
  const providerName = provider.display_name?.trim() || kind;
  const saveSecret = async () => {
    setSavingSecret(true);
    try {
      // Cleared only once it is stored: a failed write stays in the field to retry.
      if (await onSetSecret(secretInput.trim())) setSecretInput('');
    } finally {
      setSavingSecret(false);
    }
  };

  return (
    <SettingsGroup
      title={providerName}
      caption={`${kind} provider · ${provider.id}`}
      action={
        // Neutral at rest; red only on hover and keyboard focus (Y10).
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:bg-critical/10 hover:text-critical-text focus-visible:text-critical-text"
          onClick={onRemove}
          aria-label={`Remove provider ${providerName}`}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      }
    >
      <SettingRow
        variant="switch"
        label="Provider enabled"
        help="Offer this provider on the sign-in page."
        checked={Boolean(provider.enabled)}
        onCheckedChange={(v) => set({ enabled: v })}
      />
      <SettingRow variant="field">
        <TextPref
          label="Display name"
          help="The name on the sign-in button."
          value={provider.display_name ?? ''}
          placeholder={kind}
          onChange={(v) => set({ display_name: v })}
        />
      </SettingRow>
      <SettingRow variant="field" mono>
        <TextPref
          label="Client ID"
          help="The OIDC client ID your identity provider issued."
          value={provider.client_id ?? ''}
          onChange={(v) => set({ client_id: v })}
        />
      </SettingRow>
      {provider.type === 'microsoft' ? (
        <SettingRow variant="field" mono>
          <TextPref
            label="Tenant"
            help="organizations, common, or your directory (tenant) ID."
            value={provider.tenant ?? ''}
            placeholder="organizations"
            onChange={(v) => set({ tenant: v })}
          />
        </SettingRow>
      ) : null}
      {provider.type === 'generic' ? (
        <SettingRow variant="field" wide mono>
          <TextPref
            label="Discovery URL"
            help="The provider's OpenID configuration document."
            value={provider.discovery_url ?? ''}
            placeholder="https://idp.example.com/.well-known/openid-configuration"
            onChange={(v) => set({ discovery_url: v })}
          />
        </SettingRow>
      ) : null}
      {/* Client secret (write-only): saved on its own, never part of the Settings save. */}
      <SettingRow variant="field" wide>
        <SecretField
          label="Client secret"
          description="Stored on the server and never shown back. Save secret writes it at once."
          configured={configuredSecret}
          configuredLabel="Configured"
          value={secretInput}
          onChange={setSecretInput}
          placeholder={configuredSecret ? 'Set. Leave blank to keep it.' : 'Paste the OIDC client secret'}
        />
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={savingSecret || !secretInput.trim()}
            onClick={() => void saveSecret()}
          >
            {savingSecret ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
            Save secret
          </Button>
        </div>
      </SettingRow>
      <SettingRow variant="field" wide mono>
        <TagInput
          label="Allowed domains"
          description="Email domains that may sign in. Press Enter, a comma or a space to add one. Empty allows any domain."
          placeholder="Add a domain, such as acme.com"
          delimiters={[',', ' ']}
          validate={domainProblem}
          value={provider.allowed_domains ?? []}
          onChange={(next) => set({ allowed_domains: normaliseAllowList(next) })}
        />
      </SettingRow>
      <SettingRow variant="field" wide mono>
        <TagInput
          label="Allowed tenants"
          description="Directory (tenant) IDs that may sign in. Press Enter, a comma or a space to add one. Empty allows any tenant."
          placeholder="Add a tenant ID"
          delimiters={[',', ' ']}
          value={provider.allowed_tenants ?? []}
          onChange={(next) => set({ allowed_tenants: normaliseAllowList(next) })}
        />
      </SettingRow>
      <SettingRow variant="field" mono>
        <TextPref
          label="Group claim"
          help="The token claim that lists a person's groups, such as groups or roles."
          value={provider.group_claim ?? ''}
          placeholder="groups"
          onChange={(v) => set({ group_claim: v })}
        />
      </SettingRow>
      <SettingRow
        variant="select"
        label="Default role"
        help="The role a new account gets when no group below maps to one."
        value={provider.default_role ?? 'analyst_tier1'}
        options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] ?? r }))}
        onValueChange={(v) => set({ default_role: v })}
      />
      <SettingRow variant="field" wide mono>
        <GroupRoleMapField
          id={`sso-group-role-map-${provider.id}`}
          value={provider.group_role_map ?? {}}
          onChange={(map) => set({ group_role_map: map })}
        />
      </SettingRow>
      <SettingRow
        variant="switch"
        label="Create an account on first sign-in"
        help="When off, only people who already have an account may sign in."
        checked={Boolean(provider.auto_create_users)}
        onCheckedChange={(v) => set({ auto_create_users: v })}
      />
      <SettingRow
        variant="control"
        wide
        label="Callback URL"
        help="Register this with your identity provider."
        control={<CopyField value={callbackUrl} />}
      />
    </SettingsGroup>
  );
}

/* ----------------------------------------------------- self-service MFA card -- */

/**
 * The "My account · two-factor" block, every signed-in user can enroll/disable
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
  // The enrollment or turn-off flow, opened from the row's action (SPEC §4.9.6): one row
  // states the state ("Two-factor authentication · Off · Turn on") and the flow appears
  // under it only while it runs.
  const [flowOpen, setFlowOpen] = React.useState(false);
  const actionRef = React.useRef<HTMLButtonElement | null>(null);
  const returnFocus = React.useRef(false);

  /** Read the enrolled state. `quiet` keeps the row on screen while it re-reads. */
  const load = React.useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
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

  // Closing the flow (Cancel, or a finished change) returns focus to the row's action,
  // which is back on the page once the flow has gone.
  const closeFlow = React.useCallback(() => {
    returnFocus.current = true;
    setFlowOpen(false);
  }, []);
  React.useEffect(() => {
    if (flowOpen || !returnFocus.current || !actionRef.current) return;
    returnFocus.current = false;
    actionRef.current.focus();
  }, [flowOpen, mfaEnabled, loading]);

  // A finished change flips the state in the same render that closes the flow, so the row
  // action that takes focus back already names the new state ("Turn off" after turning two-
  // factor on), never the stale one for a moment. The quiet re-read then reconciles it with
  // the server.
  const onChanged = React.useCallback(async () => {
    setMfaEnabled((wasEnabled) => !wasEnabled);
    closeFlow();
    await refresh();
    await load(true);
    toast.success('Two-factor settings updated.');
  }, [closeFlow, refresh, load]);

  const ready = authEnabled && isAuthenticated && Boolean(username) && !loading && !loadError;
  const body = (
      <div data-testid="two-factor-surface" data-surface={embedded ? 'embedded' : 'standalone'}>
        <SettingsGroup id="account-two-factor" title="Authenticator app">
          {!authEnabled ? (
            <SettingRow
              variant="status"
              label="Two-factor authentication"
              help="Authentication is turned off on the backend, so there is no account to protect yet."
              status={<StatusDot>Not available</StatusDot>}
            />
          ) : !isAuthenticated || !username ? (
            <SettingRow
              variant="status"
              label="Two-factor authentication"
              help="Sign in to manage two-factor authentication."
              status={<StatusDot>Not signed in</StatusDot>}
            />
          ) : loading ? (
            <SettingRow variant="block">
              <LoadingState
                layout="panel"
                shape="panel"
                label="Loading two-factor settings"
                description="Checking your enrollment and recovery options."
              />
            </SettingRow>
          ) : loadError ? (
            <SettingRow variant="block">
              <LoadError
                error={loadError}
                fallback="Your enrollment status could not be verified."
                title="Could not load two-factor settings"
                onRetry={() => void load()}
              />
            </SettingRow>
          ) : (
            <>
              <SettingRow
                variant="status"
                label="Two-factor authentication"
                help="A code from an authenticator app, asked for each time you sign in."
                status={<StatusDot tone={mfaEnabled ? 'success' : 'neutral'}>{mfaEnabled ? 'On' : 'Off'}</StatusDot>}
                action={
                  ready && !flowOpen ? (
                    <Button
                      ref={actionRef}
                      type="button"
                      variant="outline"
                      size="sm"
                      // The visible word starts the name (WCAG 2.5.3); the rest says what it changes.
                      aria-label={mfaEnabled ? 'Turn off two-factor authentication' : 'Turn on two-factor authentication'}
                      onClick={() => setFlowOpen(true)}
                    >
                      {mfaEnabled ? 'Turn off' : 'Turn on'}
                    </Button>
                  ) : null
                }
              />
              {ready && flowOpen ? (
                <SettingRow variant="block">
                  <MfaSetupCard
                    enabled={mfaEnabled}
                    onChanged={onChanged}
                    onCancel={closeFlow}
                    autoStart
                    frameless
                  />
                </SettingRow>
              ) : null}
            </>
          )}
        </SettingsGroup>
      </div>
  );
  // Embedded, it is the Settings section; standalone, the host page owns the header.
  return embedded ? (
    <SettingsSection
      title="Security & two-factor"
      help="Protect your account with a code from an authenticator app each time you sign in."
    >
      {body}
    </SettingsSection>
  ) : (
    body
  );
}

/* ------------------------------------------------------- admin SSO/OIDC block -- */

export interface SecuritySsoInnerProps {
  /**
   * When provided, the editor is CONTROLLED by the parent (Settings owns prefs.sso
   * and the single Save button), there is no local load/save here. When omitted,
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

  // Uncontrolled (standalone) local state, only used when `update` is absent.
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
    <div className="space-y-10" data-testid="sso-settings">
      {/* Admin: session policy (its own groups). */}
      <SessionPolicySection {...policyProps} embedded={embedded} />

      {/* Admin: single sign-on. */}
      <SettingsGroup
        id="single-sign-on"
        title="Single sign-on (OIDC)"
        caption="Add one or more OIDC providers and register each callback URL with your identity provider. Client secrets are stored on the server and never shown back."
        action={
          // In controlled (Settings) mode the parent owns the single Save button.
          !controlled ? (
            <Button size="sm" onClick={saveSso} disabled={saving || !prefs}>
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
              Save SSO settings
            </Button>
          ) : null
        }
      >
        {loading ? (
          <SettingRow variant="block">
            <LoadingState
              layout="panel"
              shape="panel"
              label="Loading single sign-on"
              description="Preparing provider and session policy settings."
            />
          </SettingRow>
        ) : loadError ? (
          <SettingRow variant="block">
            <LoadError
              error={loadError}
              fallback="The identity provider configuration could not be retrieved."
              title="Could not load single sign-on settings"
              onRetry={() => void load()}
            />
          </SettingRow>
        ) : (
          <>
            <SettingRow
              variant="switch"
              label="Enable single sign-on"
              help="People sign in through the providers below."
              checked={Boolean(sso.enabled)}
              onCheckedChange={(v) => updateSso({ ...sso, enabled: v })}
            />
            <SettingRow
              variant="action"
              label="Add a provider"
              help={
                providers.length === 0
                  ? 'No providers yet.'
                  : `${providers.length} ${providers.length === 1 ? 'provider' : 'providers'} below.`
              }
              action={
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
                      {SSO_PROVIDER_ADD_LABEL[t]}
                    </Button>
                  ))}
                </div>
              }
            />
          </>
        )}
      </SettingsGroup>

      {providers.map((p, idx) => (
        <ProviderEditor
          key={p.id}
          provider={p}
          callbackUrl={callbackUrl}
          // `configured.sso_client_secrets` is a GLOBAL boolean (true if ANY provider
          // has a stored secret), so it can only be trusted when there is exactly one
          // provider. With 2+ providers rely on the per-provider session flag, so a
          // secret-less provider is never falsely shown "configured".
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
              return true;
            } catch (e) {
              toast.error(e instanceof Error ? e.message : 'Could not save the secret.');
              return false;
            }
          }}
        />
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- page -- */

export interface SecurityPageProps {
  onNavigate?: unknown;
}

/**
 * The full Security body: self-service two-factor followed by the admin session policy
 * and single sign-on block (gated by `settings:manage`). The standalone route (an old
 * bookmark; `#/security` normally redirects into Settings) shows both under one page
 * header.
 */
export function SecurityInner() {
  return (
    <div className="space-y-10">
      <SecurityMfaInner />
      <Can resource="settings" action="manage">
        <SecuritySsoInner />
      </Can>
    </div>
  );
}

export default function Security(_: SecurityPageProps) {
  return (
    <SettingsPageSection
      embedded={false}
      title="Security"
      help="Your two-factor authentication and, for administrators, single sign-on."
    >
      <SecurityInner />
    </SettingsPageSection>
  );
}
