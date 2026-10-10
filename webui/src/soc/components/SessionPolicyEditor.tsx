/**
 * Token / session policy editor (Round-2 Wave 3; Round 12 adds "Remember me").
 *
 * Admin-only (mount it inside `<Can resource="settings" action="manage">`). Edits
 * `prefs.session_policy` and persists it via the existing settings PUT — no new
 * endpoint. Durations are entered in friendly units (minutes / hours) and stored
 * as SECONDS to match the backend model. Two notify toggles gate the optional
 * new-device / terminate emails.
 *
 * The "Remember me" group (SPEC D14) edits `session_policy.remember_me`: whether the
 * sign-in page offers it, how long a remembered device stays signed in (6 / 12 /
 * 24 hour presets or a custom 1–24 hours), an optional inactivity limit, roles that
 * are never remembered, and whether plain HTTP is allowed (not recommended).
 *
 * The editor states what the server actually enforces: a remembered device never
 * outlasts the absolute lifetime, and without its own inactivity limit it follows the
 * idle timeout. It reads the public sign-in status (`GET /api/setup/status`) to show
 * how long a sign-in without Remember me lasts (`AUTH_TOKEN_HOURS`) and whether the
 * server marks its cookies secure; the plain-HTTP switch appears only when it can
 * matter (secure cookies off). The inert `access_ttl` lives under Advanced.
 *
 * Self-contained: loads its own settings slice and saves independently so it can be
 * dropped onto the Security page now and folded into Settings > Security in W4.
 */
import * as React from 'react';
import { Timer, Save, Loader2, ShieldAlert, Info } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import type { RememberMePolicy, RememberMeStatus, SessionPolicy } from '@/lib/types';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Card, CardContent } from '@/ui/card';
import { LoadingState } from '@/design-system';
import { LoadError } from '@/soc/components/LoadError';
import { NumberField } from '@/soc/components/NumberField';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { ROLE_LABELS } from '@/soc/pages/Roles.api';
import { formatRememberDuration } from '@/soc/components/auth/rememberMe';

/**
 * The backend defaults (`config.SessionPolicyConfig`), mirrored exactly so a blank
 * stored policy never shows — or saves — values the server does not use. A test
 * pins this against the backend's numbers.
 */
export const SESSION_POLICY_DEFAULTS: Required<
  Pick<
    SessionPolicy,
    'access_ttl' | 'idle_timeout' | 'absolute_lifetime' | 'sudo_reauth_window'
  >
> = {
  access_ttl: 3600, // 1h
  idle_timeout: 43_200, // 12h
  absolute_lifetime: 2_592_000, // 30 days
  sudo_reauth_window: 600, // 10m
};
const DEFAULTS = SESSION_POLICY_DEFAULTS;

/** `config.RememberMePolicy` defaults (Round 12). */
export const REMEMBER_ME_DEFAULTS: Required<RememberMePolicy> = {
  enabled: true,
  duration_seconds: 86_400,
  idle_seconds: null,
  excluded_roles: [],
  allow_insecure_http: false,
};

const HOUR = 3600;
/** The duration presets (seconds) offered as one segmented choice. */
export const REMEMBER_PRESETS: { value: string; seconds: number; label: string }[] = [
  { value: '6h', seconds: 6 * HOUR, label: '6 hours' },
  { value: '12h', seconds: 12 * HOUR, label: '12 hours' },
  { value: '24h', seconds: 24 * HOUR, label: '24 hours' },
];

/**
 * The server's sign-in status for THIS console (public `GET /api/setup/status`):
 * whether cookies are marked secure, whether this connection would refuse Remember
 * me, and how long a sign-in without it lasts. Null while loading or unavailable —
 * the editor then shows everything, as before.
 */
function useSigninRuntime(): RememberMeStatus | null {
  const [runtime, setRuntime] = React.useState<RememberMeStatus | null>(null);
  React.useEffect(() => {
    let alive = true;
    const load = api.setup?.status;
    if (typeof load !== 'function') return undefined;
    Promise.resolve()
      .then(() => load())
      .then(
        (status) => {
          if (alive && status?.remember_me) setRuntime(status.remember_me);
        },
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, []);
  return runtime;
}

/** What the server enforces for a remembered device under `policy` (seconds). */
export function effectiveRememberLimits(policy: SessionPolicy): { absolute: number; idle: number } {
  const rm = rememberOf(policy);
  const absoluteCap = policy.absolute_lifetime ?? DEFAULTS.absolute_lifetime;
  const absolute = absoluteCap > 0 ? Math.min(rm.duration_seconds, absoluteCap) : rm.duration_seconds;
  const standardIdle = policy.idle_timeout ?? DEFAULTS.idle_timeout;
  const own = rm.idle_seconds != null && rm.idle_seconds > 0 ? rm.idle_seconds : null;
  const idle = Math.min(own ?? (standardIdle > 0 ? standardIdle : absolute), absolute);
  return { absolute, idle };
}

function rememberOf(policy: SessionPolicy | null | undefined): Required<RememberMePolicy> {
  const raw = (policy?.remember_me ?? {}) as RememberMePolicy;
  return {
    ...REMEMBER_ME_DEFAULTS,
    ...raw,
    excluded_roles: Array.isArray(raw.excluded_roles) ? raw.excluded_roles : [],
    idle_seconds: raw.idle_seconds ?? null,
  };
}

/**
 * Whether role-based access control is on in a settings payload: null when the
 * settings are not known, false when the `rbac` block is missing (the backend
 * default is off). While it is off every account counts as Super admin, which
 * matters for "Never remember these roles".
 */
export function rbacEnabledOf(prefs: unknown): boolean | null {
  if (!prefs || typeof prefs !== 'object') return null;
  const rbac = (prefs as { rbac?: { enabled?: unknown } | null }).rbac;
  return Boolean(rbac && typeof rbac === 'object' && rbac.enabled === true);
}

/** A labelled duration field that edits seconds via a `unit` divisor. */
function DurationField({
  id,
  label,
  help,
  seconds,
  unit,
  unitLabel,
  defaultSeconds,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  help: string;
  seconds: number;
  unit: number;
  unitLabel: string;
  /** The safe fallback committed when the field is cleared / non-positive. */
  defaultSeconds: number;
  onChange: (seconds: number) => void;
  disabled?: boolean;
}) {
  const asText = React.useCallback(
    (s: number) => String(Math.round((s > 0 ? s : defaultSeconds) / unit)),
    [defaultSeconds, unit],
  );
  // A raw text buffer so the field can be CLEARED and retyped; we only parse/clamp on
  // commit (blur / Enter). A cleared or <=0 value commits the safe default — persisting
  // 0 would immediately idle-out / expire every live session (a lockout footgun).
  const [text, setText] = React.useState(() => asText(seconds));
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => {
    if (!editing) setText(asText(seconds));
  }, [seconds, editing, asText]);

  const commit = (raw: string) => {
    const n = Number(raw);
    const next = Number.isFinite(n) && n > 0 ? Math.round(n * unit) : defaultSeconds;
    setEditing(false);
    setText(asText(next));
    if (next !== seconds) onChange(next);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={1}
          className="h-9 w-28"
          value={text}
          disabled={disabled}
          onFocus={() => setEditing(true)}
          onChange={(e) => {
            setEditing(true);
            setText(e.target.value);
          }}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          }}
        />
        <span className="text-xs text-muted-foreground">{unitLabel}</span>
      </div>
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

/**
 * The "Remember me" policy group. Durations round-trip in seconds; the presets are
 * one segmented choice (6 / 12 / 24 hours) with a custom 1–24 hour field.
 */
export function RememberMeGroup({
  value,
  onChange,
  disabled,
  policy = {},
  runtime = null,
  rbacEnabled = null,
}: {
  value: Required<RememberMePolicy>;
  onChange: (next: Required<RememberMePolicy>) => void;
  disabled?: boolean;
  /** The whole session policy, to state the limits the server actually applies. */
  policy?: SessionPolicy;
  /** This console's sign-in status (secure cookies, transport); null when unknown. */
  runtime?: RememberMeStatus | null;
  /**
   * Whether role-based access control is on (`prefs.rbac.enabled`); null when
   * unknown. While it is off every account counts as Super admin, so excluding
   * Super admin turns Remember me off for everyone; the role list says so.
   */
  rbacEnabled?: boolean | null;
}) {
  const presetFor = (seconds: number) =>
    REMEMBER_PRESETS.find((p) => p.seconds === seconds)?.value ?? 'custom';
  const [customPicked, setCustomPicked] = React.useState(
    () => presetFor(value.duration_seconds) === 'custom',
  );
  const segment = customPicked ? 'custom' : presetFor(value.duration_seconds);
  const patch = (next: Partial<RememberMePolicy>) => onChange({ ...value, ...next } as Required<RememberMePolicy>);
  const off = disabled || !value.enabled;
  const idleOn = value.idle_seconds != null && value.idle_seconds > 0;
  const excluded = new Set(value.excluded_roles);
  const effective = effectiveRememberLimits({ ...policy, remember_me: value });
  const capped = effective.absolute < value.duration_seconds;
  const standardIdle = policy.idle_timeout ?? DEFAULTS.idle_timeout;
  // The plain-HTTP exception only matters while the server's cookies are not marked
  // secure; with secure cookies it changes nothing, so it is not shown.
  const secureCookies = runtime?.secure_cookies === true;
  const showInsecureSwitch = !secureCookies || value.allow_insecure_http;
  // With role-based access off, the server treats every account as Super admin
  // (session_limits.effective_roles), so that one exclusion covers everyone.
  const rbacOffNote =
    rbacEnabled === false && value.enabled
      ? excluded.has('super_admin')
        ? 'Role-based access is off, so every account counts as Super admin. While Super admin is excluded, Remember me is off for everyone.'
        : 'Role-based access is off, so every account counts as Super admin. Excluding Super admin turns Remember me off for everyone.'
      : null;

  return (
    <section
      className="space-y-4 border-t border-border pt-4"
      data-session-policy-remember
      aria-labelledby="sp-remember-heading"
      aria-describedby="sp-remember-help"
    >
      <div className="space-y-1">
        <h4 id="sp-remember-heading" className="text-sm font-semibold text-foreground">
          Remember me
        </h4>
        <p id="sp-remember-help" className="max-w-prose text-xs text-muted-foreground">
          Lets people keep a device signed in after they choose “Remember me”. When the
          time runs out they sign in again, including two-factor authentication. Sensitive
          actions still ask for the password.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Switch
          id="sp-remember-enabled"
          checked={value.enabled}
          onCheckedChange={(v) => patch({ enabled: v })}
          disabled={disabled}
        />
        <Label htmlFor="sp-remember-enabled" className="text-sm">
          Offer “Remember me” on the sign-in page
        </Label>
      </div>

      <div className="space-y-2">
        <span className="block text-xs font-medium text-foreground" aria-hidden="true">
          Keep devices signed in for
        </span>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl<string>
            aria-label="Keep devices signed in for"
            value={segment}
            onValueChange={(v) => {
              if (v === 'custom') {
                setCustomPicked(true);
                return;
              }
              const preset = REMEMBER_PRESETS.find((p) => p.value === v);
              setCustomPicked(false);
              if (preset) patch({ duration_seconds: preset.seconds });
            }}
            options={[
              ...REMEMBER_PRESETS.map((p) => ({ value: p.value, label: p.label })),
              { value: 'custom', label: 'Custom' },
            ]}
            disabled={off}
          />
          {segment === 'custom' ? (
            <NumberField
              label="Custom duration"
              value={Math.round(value.duration_seconds / HOUR)}
              onChange={(hours) => patch({ duration_seconds: hours * HOUR })}
              min={1}
              max={24}
              unit="hours"
              disabled={off}
              className="w-40"
            />
          ) : null}
        </div>
        <p className="max-w-prose text-xs text-muted-foreground">
          How long a remembered device stays signed in before a full sign-in is needed. NIST
          SP 800-63B recommends no more than 24 hours for accounts that use two-factor
          authentication.
        </p>
        {capped && value.enabled ? (
          <p className="max-w-prose text-xs text-foreground" data-remember-capped>
            Remembered devices sign out after {formatRememberDuration(effective.absolute)} here,
            because the absolute lifetime is shorter.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Switch
            id="sp-remember-idle"
            checked={idleOn}
            onCheckedChange={(v) => patch({ idle_seconds: v ? 3600 : null })}
            disabled={off}
          />
          <Label htmlFor="sp-remember-idle" className="text-sm">
            Also sign out remembered devices after inactivity
          </Label>
        </div>
        {idleOn ? null : (
          <p className="max-w-prose text-xs text-muted-foreground" data-remember-idle-default>
            When this is off, remembered devices follow the idle timeout (
            {formatRememberDuration(Math.min(standardIdle, effective.absolute))} without activity).
          </p>
        )}
        {idleOn ? (
          <NumberField
            label="Inactivity limit"
            value={Math.round((value.idle_seconds ?? 3600) / 60)}
            onChange={(minutes) => patch({ idle_seconds: minutes * 60 })}
            min={5}
            max={1440}
            step={5}
            unit="minutes"
            disabled={off}
            className="w-44"
          />
        ) : null}
      </div>

      <div className="space-y-2">
        <span className="block text-xs font-medium text-foreground" id="sp-remember-roles-label">
          Never remember these roles
        </span>
        <div
          role="group"
          aria-labelledby="sp-remember-roles-label"
          aria-describedby={
            rbacOffNote ? 'sp-remember-roles-help sp-remember-roles-rbac' : 'sp-remember-roles-help'
          }
          className="flex flex-wrap gap-x-5 gap-y-1"
        >
          {Object.entries(ROLE_LABELS).map(([role, label]) => (
            <label
              key={role}
              className={`flex min-h-9 items-center gap-2 text-sm ${off ? 'cursor-not-allowed text-muted-foreground' : 'cursor-pointer text-foreground'}`}
            >
              <Checkbox
                checked={excluded.has(role)}
                disabled={off}
                onCheckedChange={(v) => {
                  const next = new Set(excluded);
                  if (v === true) next.add(role);
                  else next.delete(role);
                  patch({
                    excluded_roles: Object.keys(ROLE_LABELS).filter((r) => next.has(r))
                      .concat(value.excluded_roles.filter((r) => !(r in ROLE_LABELS))),
                  });
                }}
              />
              {label}
            </label>
          ))}
        </div>
        <p id="sp-remember-roles-help" className="text-xs text-muted-foreground">
          People with these roles stay signed in only until they close the browser.
        </p>
        {rbacOffNote ? (
          <p
            id="sp-remember-roles-rbac"
            className="flex max-w-prose items-start gap-1.5 text-xs text-warning-text"
            data-remember-rbac-note
          >
            <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{rbacOffNote}</span>
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5" data-remember-transport>
        {runtime && runtime.insecure_blocked && value.enabled ? (
          <p className="flex max-w-prose items-start gap-1.5 text-xs text-foreground" data-remember-transport-status>
            <Info className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              People who open the console the way you did can&apos;t use Remember me yet:{' '}
              {secureCookies
                ? 'this connection is not secure.'
                : 'the server does not mark its sign-in cookies as secure. Serve the console over HTTPS and set AUTH_COOKIE_SECURE=true.'}
            </span>
          </p>
        ) : null}
        {showInsecureSwitch ? (
          <>
            <div className="flex items-center gap-3">
              <Switch
                id="sp-remember-insecure"
                checked={value.allow_insecure_http}
                onCheckedChange={(v) => patch({ allow_insecure_http: v })}
                disabled={off}
              />
              <Label htmlFor="sp-remember-insecure" className="text-sm">
                Allow on plain HTTP (not recommended)
              </Label>
            </div>
            <p className="flex max-w-prose items-start gap-1.5 text-xs text-warning-text">
              <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                {secureCookies
                  ? 'Sign-in cookies are marked secure, so this setting has no effect.'
                  : runtime
                    ? 'Secure cookies are off (AUTH_COOKIE_SECURE is not set), so Remember me is offered only when the console is opened directly on the server. Allowing it on plain HTTP keeps a long-lived sign-in on a connection that is not encrypted.'
                    : 'Remember me is normally offered only over HTTPS with secure cookies (AUTH_COOKIE_SECURE=true), or when the console is opened directly on the server. Allowing it on plain HTTP keeps a long-lived sign-in on a connection that is not encrypted.'}
              </span>
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}

export interface SessionPolicyEditorProps {
  /**
   * Controlled value (embedded in Settings). When provided, the editor edits the
   * parent's `prefs.session_policy` via `onChange` and hides its own Save button —
   * Settings owns the single Save. When omitted, the editor self-loads settings and
   * renders its own Save (the standalone /security route).
   */
  policy?: SessionPolicy;
  /** Controlled change handler (embedded mode). */
  onChange?: (next: SessionPolicy) => void;
  /** Use the flat divider-led Settings grammar instead of a nested card. */
  embedded?: boolean;
  /**
   * Whether role-based access control is on (see {@link rbacEnabledOf}). In
   * controlled mode the parent passes it from its prefs; the standalone editor
   * reads it from the settings it loads. Null/omitted when unknown.
   */
  rbacEnabled?: boolean | null;
}

export function SessionPolicyEditor({
  policy: controlledPolicy,
  onChange,
  embedded = false,
  rbacEnabled: controlledRbac,
}: SessionPolicyEditorProps = {}) {
  const controlled = Boolean(onChange);

  const [localPolicy, setLocalPolicy] = React.useState<SessionPolicy | null>(
    controlled ? { ...DEFAULTS, ...(controlledPolicy ?? {}) } : null,
  );
  const [loading, setLoading] = React.useState(!controlled);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<unknown>(null);
  const [loadedRbac, setLoadedRbac] = React.useState<boolean | null>(null);
  const runtime = useSigninRuntime();
  const rbacEnabled = controlledRbac ?? loadedRbac;

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const s = await api.getSettings();
      const p = (s.prefs.session_policy as SessionPolicy | undefined) ?? {};
      setLocalPolicy({ ...DEFAULTS, ...p });
      setLoadedRbac(rbacEnabledOf(s.prefs));
    } catch (error) {
      setLoadError(error);
      setLocalPolicy(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!controlled) void load();
  }, [controlled, load]);

  // In controlled mode, fold the parent's value over the generous defaults so a
  // blank stored policy never expires a live session mid-edit.
  const policy: SessionPolicy | null = controlled
    ? { ...DEFAULTS, ...(controlledPolicy ?? {}) }
    : localPolicy;

  const set = (patch: Partial<SessionPolicy>) => {
    if (controlled) onChange?.({ ...DEFAULTS, ...(controlledPolicy ?? {}), ...patch });
    else setLocalPolicy((prev) => ({ ...(prev ?? {}), ...patch }));
  };

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    try {
      await api.putSettings({ session_policy: policy });
      toast.success('Session policy saved.');
    } catch (e) {
      toast.error(e instanceof ApiError && e.message ? e.message : 'Could not save the session policy.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <LoadingState
        layout="panel"
        shape="panel"
        label="Loading session policy"
        description="Retrieving the authoritative token and timeout settings."
      />
    );
  }

  if (loadError || !policy) {
    return (
      <LoadError
        error={loadError}
        fallback="The session policy could not be retrieved."
        title="Could not load session policy"
        onRetry={() => void load()}
      />
    );
  }

  return (
    <Card
      variant={embedded ? 'flat' : 'default'}
      className={embedded ? 'rounded-none border-t border-border/70' : undefined}
    >
      <CardContent className={embedded ? 'space-y-5 px-1 pb-5 pt-5' : 'space-y-5 p-5'}>
        <div className="grid gap-4 sm:grid-cols-3">
          <DurationField
            id="sp-idle"
            label="Idle timeout"
            help="A sign-in ends after this long without activity. Remembered devices follow it too, unless they have their own limit below."
            seconds={policy.idle_timeout ?? DEFAULTS.idle_timeout}
            unit={60}
            unitLabel="minutes"
            defaultSeconds={DEFAULTS.idle_timeout}
            onChange={(v) => set({ idle_timeout: v })}
            disabled={saving}
          />
          <DurationField
            id="sp-absolute"
            label="Absolute lifetime"
            help="A hard cap on every sign-in, regardless of activity. A remembered device never stays signed in longer than this."
            seconds={policy.absolute_lifetime ?? DEFAULTS.absolute_lifetime}
            unit={3600}
            unitLabel="hours"
            defaultSeconds={DEFAULTS.absolute_lifetime}
            onChange={(v) => set({ absolute_lifetime: v })}
            disabled={saving}
          />
          <DurationField
            id="sp-sudo"
            label="Re-auth (sudo) window"
            help="Sensitive actions re-prompt for the password after this long."
            seconds={policy.sudo_reauth_window ?? DEFAULTS.sudo_reauth_window}
            unit={60}
            unitLabel="minutes"
            defaultSeconds={DEFAULTS.sudo_reauth_window}
            onChange={(v) => set({ sudo_reauth_window: v })}
            disabled={saving}
          />
        </div>
        {runtime?.standard_session_seconds ? (
          <p className="max-w-prose text-xs text-muted-foreground" data-session-standard-limit>
            A sign-in without “Remember me” also ends after{' '}
            {formatRememberDuration(runtime.standard_session_seconds)} (set on the server with
            AUTH_TOKEN_HOURS), or when the browser closes.
          </p>
        ) : null}

        <RememberMeGroup
          value={rememberOf(policy)}
          onChange={(next) => set({ remember_me: next })}
          disabled={saving}
          policy={policy}
          runtime={runtime}
          rbacEnabled={rbacEnabled}
        />

        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-3">
            <Switch
              id="sp-notify-new-device"
              checked={Boolean(policy.notify_on_new_device)}
              onCheckedChange={(v) => set({ notify_on_new_device: v })}
              disabled={saving}
            />
            <Label htmlFor="sp-notify-new-device" className="text-sm">
              Email users when a session signs in from a new device or location
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              id="sp-notify-terminate"
              checked={Boolean(policy.notify_on_terminate)}
              onCheckedChange={(v) => set({ notify_on_terminate: v })}
              disabled={saving}
            />
            <Label htmlFor="sp-notify-terminate" className="text-sm">
              Email users when one of their sessions is terminated
            </Label>
          </div>
        </div>

        <details className="border-t border-border pt-4" data-session-policy-advanced>
          <summary className="cursor-pointer text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Advanced
          </summary>
          <div className="mt-4 max-w-xs">
            <DurationField
              id="sp-access-ttl"
              label="Access token TTL"
              help="Not enforced in this version: it is kept for API clients that rotate tokens. Browser sign-ins follow the limits above."
              seconds={policy.access_ttl ?? DEFAULTS.access_ttl}
              unit={60}
              unitLabel="minutes"
              defaultSeconds={DEFAULTS.access_ttl}
              onChange={(v) => set({ access_ttl: v })}
              disabled={saving}
            />
          </div>
        </details>

        {/* In controlled (Settings) mode the parent owns the single Save button. */}
        {!controlled ? (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
              Save session policy
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A titled section wrapper for the Security page. Forwards controlled props. */
export function SessionPolicySection(props: SessionPolicyEditorProps = {}) {
  const Heading = props.embedded ? 'h3' : 'h2';
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Timer className="h-4 w-4 text-muted-foreground" aria-hidden />
        <Heading className="text-sm font-semibold text-foreground">Token &amp; session policy</Heading>
      </div>
      <p className="text-xs text-muted-foreground">
        Control how long sign-ins last and when sensitive actions require re-authentication.
      </p>
      <SessionPolicyEditor {...props} />
    </section>
  );
}

export default SessionPolicyEditor;
