/**
 * MfaSetupCard — self-service two-factor (TOTP) enrollment + disable (Wave 2 / F3).
 *
 * Enroll flow:
 *   1. "Enable two-factor" → POST /api/auth/mfa/setup (returns secret + otpauth URI +
 *      10 recovery codes, shown ONCE).
 *   2. Render the URI as a scannable QR (<QRCode>, dependency-free) AND always show
 *      the secret + URI as copyable text for manual entry.
 *   3. Show + let the operator copy/download the recovery codes.
 *   4. Enter a 6-digit code → POST /api/auth/mfa/confirm → enabled.
 *
 * Disable flow: enter a current TOTP (or a recovery code) → POST /api/auth/mfa/disable.
 *
 * LOGIN-PHASE MANDATED ENROLLMENT (Round 11): when `pendingToken` is set there is NO
 * session yet — the login returned `mfa_enrollment_required` — so setup/confirm are
 * rerouted to the PUBLIC pending-token-gated endpoints (/auth/mfa/enroll-setup +
 * /enroll-confirm; byte-same setup payload, recovery codes included). Enrollment
 * auto-starts (the step is mandatory), the mid-flow Cancel affordance is hidden (the
 * parent owns the only exits), the confirm input never steals focus (the parent's
 * mode heading owns it, keeping the QR/secret/recovery reading order), a required
 * "I have saved my recovery codes" acknowledgment gates the submit (success destroys
 * the only copy of the codes), and a successful confirm IS a completed login: the
 * server mints the session + cookie and `onComplete` receives the verify-shaped
 * LoginResult. A rejected/expired pending token surfaces via `onPendingExpired`.
 *
 * All values shown here are the user's own enrollment data (trusted), but the secret
 * + recovery codes are sensitive — they are shown only transiently and never persisted
 * client-side beyond the component's state.
 *
 * a11y — WCAG 2.2 §3.3.8 Accessible Authentication (Round-5 W0-E): the confirm/disable
 * code inputs carry `autoComplete="one-time-code"` and never block paste, so a
 * password manager can autofill / the operator can paste a TOTP or recovery code.
 */
import * as React from 'react';
import {
  ShieldCheck,
  ShieldOff,
  Copy,
  Check,
  Download,
  Loader2,
  KeyRound,
  AlertCircle,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import type { LoginResult, MfaSetupResult } from '@/lib/types';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Alert, AlertDescription } from '@/ui/alert';
import { Card, CardContent } from '@/ui/card';
import { Badge } from '@/ui/badge';
import { Separator } from '@/ui/separator';
import { QRCode } from './QRCode';

export interface MfaSetupCardProps {
  /** Whether MFA is currently enabled for the signed-in user. */
  enabled: boolean;
  /** Called after a successful enable/disable so the parent can refresh the session. */
  onChanged?: () => void;
  /**
   * Render WITHOUT the outer `<Card>` frame + the internal title/description/badge
   * header, for when a parent already supplies the card frame + heading (e.g. the
   * login MFA-enroll step, which wraps this in its own titled Card). Avoids the
   * card-in-card double frame + duplicate heading (DESIGN_STANDARD "ONE card grammar").
   */
  frameless?: boolean;
  /**
   * LOGIN-PHASE MANDATED ENROLLMENT: the short-lived pending token from a login that
   * returned `mfa_enrollment_required`. When set there is NO session yet — setup and
   * confirm are rerouted to the public /auth/mfa/enroll-setup + /enroll-confirm
   * endpoints, enrollment auto-starts, the mid-flow Cancel affordance is hidden, and
   * a successful confirm is a COMPLETED LOGIN delivered via `onComplete`.
   */
  pendingToken?: string;
  /**
   * Login-phase completion (pendingToken mode only): the confirm endpoint minted the
   * full session and returned the exact /auth/mfa/verify success payload — the parent
   * should finish the login (incl. handling `user.must_change_password`).
   */
  onComplete?: (result: LoginResult) => void;
  /**
   * The pending token was rejected as invalid/expired (401) — the parent should
   * return to sign-in with a clear message. (A wrong TOTP code is NOT this: it stays
   * an inline retryable error while the pending token lives.)
   */
  onPendingExpired?: () => void;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 gap-1.5"
      onClick={() => {
        // copyText falls back to execCommand over plain HTTP (no secure context),
        // so this works even when navigator.clipboard is undefined.
        void copyText(text).then((ok) => {
          if (ok) {
            setFailed(false);
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          } else {
            setFailed(true);
            window.setTimeout(() => setFailed(false), 2500);
          }
        });
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {done ? 'Copied' : failed ? 'Copy failed' : label}
    </Button>
  );
}

export function MfaSetupCard({
  enabled,
  onChanged,
  frameless = false,
  pendingToken,
  onComplete,
  onPendingExpired,
}: MfaSetupCardProps) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Enroll state.
  const [enroll, setEnroll] = React.useState<MfaSetupResult | null>(null);
  const [qrFailed, setQrFailed] = React.useState(false);
  const [confirmCode, setConfirmCode] = React.useState('');
  // pendingToken mode: a successful confirm IS the login and immediately destroys
  // the only copy of the recovery codes, so an explicit "I saved them" ack gates
  // the submit (session-authed mode keeps its Cancel/onChanged flow unchanged).
  const [savedAck, setSavedAck] = React.useState(false);
  // Disable state.
  const [disabling, setDisabling] = React.useState(false);
  const [disableCode, setDisableCode] = React.useState('');

  /**
   * Is this error the pending token being rejected (vs a retryable wrong code)?
   * enroll-setup carries no code, so ANY 401 there means the pending lapsed;
   * enroll-confirm 401s for BOTH a wrong code and a dead pending — only the
   * latter mentions the pending session. An unmatched 401 stays an inline,
   * retryable error, which degrades gracefully even if the wording ever shifts.
   */
  const isPendingRejected = (e: unknown, phase: 'setup' | 'confirm'): boolean =>
    !!pendingToken &&
    e instanceof ApiError &&
    e.status === 401 &&
    (phase === 'setup' || /pending/i.test(e.message ?? ''));

  const begin = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setQrFailed(false);
    try {
      // pendingToken → the PUBLIC login-phase enroll endpoint (no session exists).
      const res = pendingToken
        ? await api.auth.mfa.enrollSetup(pendingToken)
        : await api.auth.mfa.setup();
      setEnroll(res);
      setConfirmCode('');
      setSavedAck(false);
    } catch (e) {
      if (isPendingRejected(e, 'setup')) {
        onPendingExpired?.();
      } else {
        setError(e instanceof ApiError ? e.message : 'Could not start MFA enrollment.');
      }
    } finally {
      setBusy(false);
    }
  };

  // Mandated login-phase enrollment auto-starts: the step cannot be skipped, so
  // making the operator click "Enable two-factor" first would only add friction.
  // Guarded by a ref so it fires once (a failed start leaves the manual button).
  const autoStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (pendingToken && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void begin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount; `begin` is stable in effect
  }, [pendingToken]);

  const confirm = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy || !enroll) return;
    setBusy(true);
    setError(null);
    try {
      if (pendingToken) {
        // Login-phase confirm: the server persists the factor AND mints the full
        // session — the response is the /auth/mfa/verify payload. Success here IS
        // a completed login; hand it to the parent unchanged.
        const res = await api.auth.mfa.enrollConfirm(pendingToken, confirmCode.trim());
        setEnroll(null);
        setConfirmCode('');
        onComplete?.(res);
        return;
      }
      await api.auth.mfa.confirm(confirmCode.trim());
      setEnroll(null);
      setConfirmCode('');
      onChanged?.();
    } catch (err) {
      if (isPendingRejected(err, 'confirm')) {
        onPendingExpired?.();
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not confirm the code.');
      }
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.mfa.disable(disableCode.trim());
      setDisabling(false);
      setDisableCode('');
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disable MFA.');
    } finally {
      setBusy(false);
    }
  };

  const downloadCodes = () => {
    if (!enroll) return;
    const blob = new Blob(
      [`Agentic SOC — two-factor recovery codes\n\n${enroll.recovery_codes.join('\n')}\n`],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'agentic-soc-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const body = (
    <>
      {frameless ? null : (
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface text-primary">
              {enabled ? <ShieldCheck className="h-5 w-5" aria-hidden /> : <KeyRound className="h-5 w-5" aria-hidden />}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Two-factor authentication</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Add a time-based one-time code from an authenticator app to your sign-in.
              </p>
            </div>
          </div>
          <Badge variant={enabled ? 'default' : 'outline'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
        </div>
      )}

        {error ? (
          <Alert variant="destructive">
            <AlertCircle aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {/* ---- Already enabled: offer disable ------------------------------- */}
        {enabled && !enroll ? (
          disabling ? (
            <form onSubmit={disable} className="space-y-3" noValidate>
              <Label htmlFor="mfa-disable-code">Enter a current code to disable</Label>
              <Input
                id="mfa-disable-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456 or a recovery code"
                value={disableCode}
                onChange={(ev) => setDisableCode(ev.target.value)}
                disabled={busy}
                /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                autoFocus
              />
              <div className="flex gap-2">
                <Button type="submit" variant="destructive" size="sm" disabled={busy || !disableCode.trim()}>
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldOff aria-hidden />}
                  Disable two-factor
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setDisabling(false)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="outline" size="sm" onClick={() => { setDisabling(true); setError(null); }}>
              <ShieldOff aria-hidden />
              Disable two-factor
            </Button>
          )
        ) : null}

        {/* ---- Not enrolled yet: start ------------------------------------- */}
        {/* Mandated login-phase mode auto-starts, so it shows a quiet preparing row
            instead of flashing the manual button; a failed start degrades to an
            explicit retry (the error Alert above says why). */}
        {!enabled && !enroll ? (
          pendingToken && !error ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Preparing your authenticator setup…
            </div>
          ) : (
            <Button size="sm" onClick={begin} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
              {pendingToken ? 'Try again' : 'Enable two-factor'}
            </Button>
          )
        ) : null}

        {/* ---- Enrollment in progress: QR + secret + recovery + confirm ----- */}
        {enroll ? (
          <div className="space-y-5">
            <Separator />
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <div className="shrink-0">
                {qrFailed ? (
                  <div className="flex h-[180px] w-[180px] items-center justify-center rounded-md border border-dashed border-border bg-muted/40 p-3 text-center text-xs text-muted-foreground">
                    QR unavailable — enter the secret manually below.
                  </div>
                ) : (
                  <div className="rounded-md border border-border bg-white p-2">
                    <QRCode value={enroll.otpauth_uri} size={180} onError={() => setQrFailed(true)} />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <p className="text-sm font-medium text-foreground">1. Scan with your authenticator app</p>
                  <p className="text-xs text-muted-foreground">
                    Google Authenticator, 1Password, Authy, Microsoft Authenticator, etc. Can&apos;t
                    scan? Enter the secret or URI by hand:
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Secret</Label>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted px-2 py-1 font-mono text-xs">
                      {enroll.secret}
                    </code>
                    <CopyButton text={enroll.secret} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">otpauth URI</Label>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted px-2 py-1 font-mono text-[11px]">
                      {enroll.otpauth_uri}
                    </code>
                    <CopyButton text={enroll.otpauth_uri} />
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">2. Save your recovery codes</p>
                <div className="flex gap-2">
                  <CopyButton text={enroll.recovery_codes.join('\n')} label="Copy all" />
                  <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={downloadCodes}>
                    <Download className="h-3.5 w-3.5" aria-hidden />
                    Download
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Each code works once if you lose your device. Store them somewhere safe — they
                are shown only now.
              </p>
              <div className="grid grid-cols-2 gap-1.5 font-mono text-xs">
                {enroll.recovery_codes.map((c) => (
                  <span key={c} className="rounded border border-border bg-card px-2 py-1">{c}</span>
                ))}
              </div>
              {/* Login-phase mandated mode only: confirming immediately completes the
                  login and this one-time view of the codes is gone — require an
                  explicit save acknowledgment before "Verify & sign in" enables. */}
              {pendingToken ? (
                <div className="flex items-center gap-2 pt-1">
                  <Checkbox
                    id="mfa-recovery-saved"
                    checked={savedAck}
                    onCheckedChange={(v) => setSavedAck(v === true)}
                    disabled={busy}
                  />
                  <Label htmlFor="mfa-recovery-saved" className="text-xs font-normal">
                    I have saved my recovery codes somewhere safe
                  </Label>
                </div>
              ) : null}
            </div>

            <form onSubmit={confirm} className="space-y-2" noValidate>
              <Label htmlFor="mfa-confirm-code">3. Enter the 6-digit code to finish</Label>
              <div className="flex gap-2">
                <Input
                  id="mfa-confirm-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  className="max-w-[160px]"
                  value={confirmCode}
                  onChange={(ev) => setConfirmCode(ev.target.value)}
                  disabled={busy}
                  /* No autoFocus in the login-phase mandated mode: the enroll payload
                     resolves AFTER the mode heading takes focus, and yanking focus to
                     the last field would skip the secret/QR/recovery-codes reading
                     order. Session-authed mode keeps the deliberate placement. */
                  /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog flow (session mode only); suppressed in pendingToken mode */
                  autoFocus={pendingToken ? undefined : true}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || confirmCode.trim().length < 6 || (!!pendingToken && !savedAck)}
                >
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
                  {/* In the login-phase mandated mode a successful confirm IS the login. */}
                  {pendingToken ? 'Verify & sign in' : 'Verify & enable'}
                </Button>
                {/* No mid-flow Cancel in the mandated login-phase mode: there is no
                    session to fall back into — the parent owns the only exits
                    (complete enrollment, or back to sign-in). */}
                {pendingToken ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => { setEnroll(null); setError(null); }}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </form>
          </div>
        ) : null}
    </>
  );

  // Frameless: a parent supplies the card frame + heading (login MFA-enroll step),
  // so render just the body to avoid a double frame + duplicate heading.
  if (frameless) return <div className="space-y-5">{body}</div>;

  return (
    <Card>
      <CardContent className="space-y-5 p-6">{body}</CardContent>
    </Card>
  );
}

export default MfaSetupCard;
