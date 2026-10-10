/**
 * "Remember me" — the device-side half (Round 12, SPEC D14).
 *
 * The SESSION is remembered by the server (a persistent, server-bounded cookie the
 * page never sees). This module only keeps three NON-SECRET conveniences on this
 * device, under the `soc.login.*` prefix (AGENTS.md: no new compatibility-prefixed
 * keys):
 *
 *   - `soc.login.rememberedUsername` — the account name, written only after a
 *     successful remembered sign-in, so the next visit opens on the password step.
 *   - `soc.login.rememberAck`        — the warning was accepted by the person whose
 *     username this device remembers. It is written only after a successful
 *     remembered sign-in and removed with the username, so it never lets someone
 *     else on a shared device skip the warning.
 *   - `soc.login.rememberedUntil`    — when the remembered session ends (epoch ms) and
 *     its length, so the sign-in page can say "you were signed out after 24 hours"
 *     even though the browser dropped the expired cookie.
 *
 * The PASSWORD is never written to any app storage (localStorage, sessionStorage,
 * IndexedDB or a readable cookie). Remembering it is the browser password manager's
 * job: correct `autocomplete` attributes, a hidden username field in the password
 * step, and — in Chromium — an explicit `PasswordCredential` store.
 *
 * Every storage access is wrapped: a private window, blocked site data or a quota
 * error degrades to "nothing remembered" and never breaks sign-in.
 */
import { toast } from 'sonner';
import type { LoginResult, SessionEndReason } from '@/lib/types';

export const REMEMBERED_USERNAME_KEY = 'soc.login.rememberedUsername';
export const REMEMBER_ACK_KEY = 'soc.login.rememberAck';
export const REMEMBERED_UNTIL_KEY = 'soc.login.rememberedUntil';

const MAX_USERNAME = 256;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the convenience is simply not kept */
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** The username remembered on this device, or null. */
export function readRememberedUsername(): string | null {
  const raw = read(REMEMBERED_USERNAME_KEY);
  const value = (raw ?? '').trim();
  return value && value.length <= MAX_USERNAME ? value : null;
}

/** Whether a warning acknowledgement is stored on this device (any account). */
export function hasRememberAck(): boolean {
  return read(REMEMBER_ACK_KEY) === '1';
}

export function setRememberAck(): void {
  write(REMEMBER_ACK_KEY, '1');
}

/**
 * Whether checking "Remember me" for `username` may skip the warning: only when this
 * device already remembers THAT account and its owner accepted the warning when they
 * signed in. A different name, an empty name, or an acknowledgement left without a
 * remembered username always shows the warning (shared and kiosk devices).
 */
export function rememberAckCovers(username: string): boolean {
  const name = username.trim().toLowerCase();
  if (!name || !hasRememberAck()) return false;
  const remembered = readRememberedUsername();
  return remembered !== null && remembered.toLowerCase() === name;
}

/**
 * Record the outcome of a SUCCESSFUL sign-in. Remembered → keep the username and
 * the session end; anything else → forget the username (an unchecked box or a
 * server refusal must not leave a name behind). Never called on a failed attempt.
 */
export function recordSignIn(
  username: string,
  remembered: boolean,
  opts: { expiresAt?: string | null; lifetimeSeconds?: number | null } = {},
): void {
  const name = username.trim();
  if (!remembered || !name || name.length > MAX_USERNAME) {
    // The acknowledgement belongs to the remembered account: drop it with the name.
    remove(REMEMBERED_USERNAME_KEY);
    remove(REMEMBER_ACK_KEY);
    remove(REMEMBERED_UNTIL_KEY);
    return;
  }
  write(REMEMBERED_USERNAME_KEY, name);
  const until = opts.expiresAt ? Date.parse(opts.expiresAt) : NaN;
  if (Number.isFinite(until)) {
    const lifetime = Math.max(0, Math.round(Number(opts.lifetimeSeconds ?? 0)) || 0);
    write(REMEMBERED_UNTIL_KEY, JSON.stringify({ until, lifetime }));
  } else {
    remove(REMEMBERED_UNTIL_KEY);
  }
}

/**
 * Forget this device: the remembered username, the warning acknowledgement and the
 * session-end marker. Does not sign anyone out.
 */
export function forgetDevice(): void {
  remove(REMEMBERED_USERNAME_KEY);
  remove(REMEMBER_ACK_KEY);
  remove(REMEMBERED_UNTIL_KEY);
}

/** A deliberate sign-out: the session did not "expire", so drop the end marker. */
export function clearRememberedSessionEnd(): void {
  remove(REMEMBERED_UNTIL_KEY);
}

/**
 * When a remembered session on this device has already ended by time, return its
 * length once (and clear the marker) so the sign-in page can explain it. Null when
 * there is nothing to explain.
 */
export function takeExpiredRememberedSession(now: number = Date.now()): { lifetimeSeconds: number } | null {
  const raw = read(REMEMBERED_UNTIL_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { until?: unknown; lifetime?: unknown };
    const until = Number(parsed.until);
    if (!Number.isFinite(until)) {
      remove(REMEMBERED_UNTIL_KEY);
      return null;
    }
    if (until > now) return null;
    remove(REMEMBERED_UNTIL_KEY);
    const lifetime = Math.max(0, Math.round(Number(parsed.lifetime) || 0));
    return { lifetimeSeconds: lifetime };
  } catch {
    remove(REMEMBERED_UNTIL_KEY);
    return null;
  }
}

/** "24 hours", "6 hours", "1 hour", "90 minutes" — plain duration copy. */
export function formatRememberDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s >= 3600 && s % 3600 === 0) {
    const h = s / 3600;
    return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  if (s >= 3600) {
    const h = Math.round((s / 3600) * 10) / 10;
    return `${h} hours`;
  }
  const m = Math.max(1, Math.round(s / 60));
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

/** "the next hour" / "the next 24 hours" — the window phrase for the warning. */
export function formatRememberWindow(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s === 3600) return 'the next hour';
  return `the next ${formatRememberDuration(s)}`;
}

/**
 * The calm sign-out notice for a session that ended on its own (never an error
 * tone). Null for reasons that need no explanation.
 */
export function signedOutNotice(
  reason: SessionEndReason | null | undefined,
  lifetimeSeconds?: number | null,
): string | null {
  switch (reason) {
    case 'absolute_expired':
      return lifetimeSeconds && lifetimeSeconds > 0
        ? `For your security, you were signed out after ${formatRememberDuration(lifetimeSeconds)}. Sign in to continue.`
        : 'For your security, your session ended. Sign in to continue.';
    case 'idle_expired':
      return 'For your security, you were signed out after a period of inactivity. Sign in to continue.';
    case 'revoked':
      return 'This session was ended from another device or by an administrator. Sign in to continue.';
    case 'tv_mismatch':
      return 'All of your sessions were signed out. Sign in to continue.';
    default:
      return null;
  }
}

/** Whether this page was loaded over HTTPS. */
export function pageIsHttps(): boolean {
  try {
    return window.location.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The one-line reason Remember me can't be used on this console's connection. On
 * plain HTTP it needs HTTPS; on HTTPS the server's cookies are not yet marked
 * secure, which only an administrator can change.
 */
export function insecureRememberHint(https: boolean = pageIsHttps()): string {
  return https
    ? 'Not available on this connection yet. Ask your administrator.'
    : 'Available when the console is served over HTTPS';
}

/** The one-line explanation when the server did not remember a sign-in. */
export function rememberRefusedMessage(
  reason: string | null | undefined,
  https: boolean = pageIsHttps(),
): string | null {
  switch (reason) {
    case 'role_excluded':
      return "Remember me isn't available for your role. You'll stay signed in until you close the browser.";
    case 'insecure_transport':
      return https
        ? "Remember me isn't available on this connection yet, so it wasn't turned on. You'll stay signed in until you close the browser."
        : "Remember me needs HTTPS, so it wasn't turned on. You'll stay signed in until you close the browser.";
    case 'disabled':
      return "Remember me is turned off by your administrator. You'll stay signed in until you close the browser.";
    default:
      return null;
  }
}

interface PasswordCredentialCtor {
  new (data: { id: string; password: string; name?: string }): Credential;
}

/**
 * Chromium only: hand the credential to the browser's password manager explicitly
 * (progressive enhancement; Firefox/Safari rely on their own form heuristics and
 * the hidden username field). Feature-detected, fire-and-forget, never throws and
 * never blocks sign-in. The password goes to the browser API only — never to app
 * storage.
 */
export function storePasswordCredential(username: string, password: string): void {
  try {
    if (typeof window === 'undefined' || !window.isSecureContext) return;
    const Ctor = (window as unknown as { PasswordCredential?: PasswordCredentialCtor })
      .PasswordCredential;
    const container = typeof navigator !== 'undefined' ? navigator.credentials : undefined;
    if (!Ctor || !container || typeof container.store !== 'function') return;
    const name = username.trim();
    if (!name || !password) return;
    const credential = new Ctor({ id: name, password, name });
    void container.store(credential).catch(() => undefined);
  } catch {
    /* progressive enhancement only */
  }
}

/**
 * Everything a SUCCESSFUL sign-in does for Remember me on this device (password,
 * MFA or mandated enrollment): keep or drop the username, record the warning
 * acknowledgement, hand the credential to the browser's password manager when the
 * session was remembered, and explain once when the server refused a request.
 * Never called for a failed attempt.
 */
export function afterSignIn(
  res: LoginResult,
  opts: { username: string; requested: boolean; password?: string; lifetimeSeconds?: number | null },
): void {
  const name = (res.user?.username || opts.username).trim();
  const remembered = Boolean(res.remembered);
  recordSignIn(name, remembered, {
    expiresAt: res.session_expires_at,
    lifetimeSeconds: opts.lifetimeSeconds,
  });
  if (remembered) {
    setRememberAck();
    // Never offer a temporary password the user must change right now; the change
    // form's `new-password` field lets the browser save the new one.
    if (opts.password && !res.user?.must_change_password) {
      storePasswordCredential(name, opts.password);
    }
  } else if (opts.requested) {
    const message = rememberRefusedMessage(res.remember_reason);
    if (message) toast(message);
  }
}

/**
 * A single sign-on landing carries `remember_refused=<reason>` when the server did
 * not remember that sign-in: explain it once, then remove it from the address bar.
 */
export function explainRememberRefusedParam(): void {
  try {
    const url = new URL(window.location.href);
    const refused = url.searchParams.get('remember_refused');
    if (!refused) return;
    url.searchParams.delete('remember_refused');
    window.history.replaceState(window.history.state, '', url.toString());
    const message = rememberRefusedMessage(refused);
    if (message) toast(message);
  } catch {
    /* no URL API — nothing to explain */
  }
}
