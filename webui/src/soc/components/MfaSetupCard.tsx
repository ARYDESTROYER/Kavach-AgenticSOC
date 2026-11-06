/**
 * MfaSetupCard: self-service two-factor (TOTP) enrollment + turn-off (Wave 2 / F3).
 *
 * Enroll flow:
 *   1. "Turn on two-factor" → POST /api/auth/mfa/setup (returns secret + otpauth URI +
 *      10 recovery codes, shown ONCE).
 *   2. Render the URI as a scannable QR (<QRCode>, dependency-free) AND always show
 *      the secret + URI as copyable text for manual entry.
 *   3. Show + let the operator copy/download the recovery codes.
 *   4. Enter a 6-digit code → POST /api/auth/mfa/confirm → enabled.
 *
 * Turn-off flow: enter a current TOTP (or a recovery code) → POST /api/auth/mfa/disable.
 *
 * HOST-STARTED (Round 14, SPEC §4.9.6, `autoStart`): Settings shows two-factor as one row
 * ("Two-factor authentication · Off · Turn on") whose action mounts this card with
 * `autoStart`. The card then starts the flow itself (enrollment when off, the turn-off
 * form when on), renders no start or turn-off trigger of its own, and hands Cancel back
 * through `onCancel` so the host can close it and return focus to its row action. While
 * the setup request runs, focus rests on the "Preparing" status line, never on <body>.
 *
 * FOCUS (WCAG 2.4.3): when an enrollment the operator started arrives, focus moves to its
 * first step ("1. Scan with your authenticator app"), so reading order runs QR code,
 * secret, recovery codes, then the code field; it never jumps past the codes, which are
 * shown only once. While a code is being checked nothing that can hold focus is disabled
 * (the code field is read-only and its submit button `aria-disabled`): a browser moves
 * focus from a control that becomes disabled to <body>, and in Chromium it does so a frame
 * later, after React has already run. When the check fails, focus goes to the code field
 * to type it again, unless the operator has moved focus out of the card meanwhile.
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
import { downloadBlob } from '@/lib/download-blob';
import type { LoginResult, MfaSetupResult } from '@/lib/types';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Alert, AlertDescription } from '@/ui/alert';
import { Card, CardContent } from '@/ui/card';
import { Badge } from '@/ui/badge';
import { Separator } from '@/ui/separator';

/**
 * Stand-in for the QR encoder when its chunk cannot be fetched. It reports the failure
 * through the same `onError` path as an encoding failure, so the card shows its
 * "QR code unavailable" box and the secret, URI and
 * recovery codes stay on screen.
 */
function QrChunkUnavailable({ onError }: { onError?: () => void }) {
  const reported = React.useRef(false);
  React.useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    onError?.();
  }, [onError]);
  return null;
}

/**
 * The QR encoder (~6 kB) loads only when an enrollment actually shows a code: this card
 * is on the eager login path, and nearly every sign-in never enrolls. The secret and URI
 * are always shown as text, so scanning is never the only path while it loads.
 *
 * The import fails soft. Login renders outside every error boundary, so a rejected chunk
 * (a stale hashed file after a redeploy or supervised update, a proxy, going offline)
 * must not throw: it resolves to {@link QrChunkUnavailable} and enrolment continues with
 * manual entry.
 */
const QRCode = React.lazy(() =>
  import('./QRCode').catch(() => ({ default: QrChunkUnavailable })),
);

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
  /**
   * Start the flow on mount (Round 14, SPEC §4.9.6): enrollment when two-factor is off,
   * the turn-off form when it is on. The host owns the "Turn on" / "Turn off" action, so
   * the card renders no trigger of its own. Ignored with `pendingToken`, which always
   * starts enrollment.
   */
  autoStart?: boolean;
  /** `autoStart` only: the operator cancelled the flow; the host closes the card. */
  onCancel?: () => void;
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

/** A busy submit looks unavailable but keeps focus (see the module comment). */
const BUSY_INERT = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

export function MfaSetupCard({
  enabled,
  onChanged,
  frameless = false,
  pendingToken,
  onComplete,
  onPendingExpired,
  autoStart = false,
  onCancel,
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
  const [disabling, setDisabling] = React.useState(autoStart && enabled && !pendingToken);
  // Host-started (`autoStart`): the host row owns the start action and closing the card.
  const hostStarted = autoStart && !pendingToken;
  const retryRef = React.useRef<HTMLButtonElement | null>(null);
  const confirmInputRef = React.useRef<HTMLInputElement | null>(null);
  const disableInputRef = React.useRef<HTMLInputElement | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  // Set when a code submit fails; the effect below hands focus back to the code field.
  const refocusOnError = React.useRef(false);
  // Focus an element once, when it mounts: the host-started "Preparing" line, then the
  // first enrollment step when the setup arrives (a stable callback, so a re-render never
  // pulls focus back to it).
  const focusOnMount = React.useCallback((el: HTMLElement | null) => el?.focus(), []);
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
        setError(e instanceof ApiError ? e.message : 'Could not start two-factor setup.');
      }
    } finally {
      setBusy(false);
    }
  };

  // Mandated login-phase enrollment auto-starts: the step cannot be skipped, so
  // making the operator click "Turn on two-factor" first would only add friction. A
  // host-started card (`autoStart`) starts enrollment the same way. Guarded by a ref so
  // it fires once (a failed start leaves the manual "Try again").
  const autoStartedRef = React.useRef(false);
  React.useEffect(() => {
    if ((pendingToken || (hostStarted && !enabled)) && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void begin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount; `begin` is stable in effect
  }, [pendingToken]);

  // A host-started start that failed: the "Preparing" line holding focus is gone, so
  // focus moves to the retry it was replaced by, never to <body>.
  React.useEffect(() => {
    if (hostStarted && error && !enroll && !enabled) retryRef.current?.focus();
  }, [hostStarted, error, enroll, enabled]);

  // A failed code submit hands focus to the field the operator retypes in (the error above
  // says why), with the wrong code selected. Focus the operator moved out of the card
  // while the code was checked is left alone.
  React.useEffect(() => {
    if (!error || busy || !refocusOnError.current) return;
    refocusOnError.current = false;
    const active = document.activeElement;
    const root = rootRef.current;
    if (active && active !== document.body && root && !root.contains(active)) return;
    const field = enabled && disabling ? disableInputRef.current : enroll ? confirmInputRef.current : null;
    field?.focus();
    field?.select();
  }, [error, busy, enabled, disabling, enroll]);

  /** Leave the flow: a host-started card hands closing back to its host. */
  const cancel = () => {
    setError(null);
    if (hostStarted) {
      onCancel?.();
      return;
    }
    setEnroll(null);
    setDisabling(false);
  };

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
        refocusOnError.current = true;
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
      refocusOnError.current = true;
      setError(err instanceof ApiError ? err.message : 'Could not turn off two-factor.');
    } finally {
      setBusy(false);
    }
  };

  const downloadCodes = () => {
    if (!enroll) return;
    const blob = new Blob(
      [`Agentic SOC two-factor recovery codes\n\n${enroll.recovery_codes.join('\n')}\n`],
      { type: 'text/plain' },
    );
    downloadBlob('agentic-soc-recovery-codes.txt', blob);
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
          <Badge variant={enabled ? 'default' : 'outline'}>{enabled ? 'On' : 'Off'}</Badge>
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
              <Label htmlFor="mfa-disable-code">Enter a current code to turn off two-factor</Label>
              <Input
                ref={disableInputRef}
                id="mfa-disable-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456 or a recovery code"
                value={disableCode}
                onChange={(ev) => setDisableCode(ev.target.value)}
                // Read-only, not disabled, while the request runs: a disabled field
                // would push focus to <body> (see the module comment).
                readOnly={busy}
                aria-busy={busy || undefined}
                /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="destructive"
                  size="sm"
                  // Busy, not disabled: it keeps focus while the code is checked.
                  disabled={!busy && !disableCode.trim()}
                  aria-disabled={busy || undefined}
                  className={BUSY_INERT}
                >
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldOff aria-hidden />}
                  Turn off two-factor
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : hostStarted ? null : (
            <Button variant="outline" size="sm" onClick={() => { setDisabling(true); setError(null); }}>
              <ShieldOff aria-hidden />
              Turn off two-factor
            </Button>
          )
        ) : null}

        {/* ---- Not enrolled yet: start ------------------------------------- */}
        {/* Mandated login-phase mode and a host-started card auto-start, so they show a
            quiet preparing line instead of flashing the manual button; a failed start
            degrades to an explicit retry (the error Alert above says why). A host-started
            line takes focus while it waits, so the host's "Turn on" leaving the page
            never drops focus to <body>. */}
        {!enabled && !enroll ? (
          (pendingToken || hostStarted) && !error ? (
            <div
              role="status"
              tabIndex={hostStarted ? -1 : undefined}
              ref={hostStarted ? focusOnMount : undefined}
              className="flex items-center gap-2 rounded-sm text-sm text-muted-foreground focus-visible:outline-none"
            >
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              Preparing your authenticator setup…
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button ref={retryRef} size="sm" onClick={begin} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
                {pendingToken || hostStarted ? 'Try again' : 'Turn on two-factor'}
              </Button>
              {hostStarted ? (
                <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={busy}>
                  Cancel
                </Button>
              ) : null}
            </div>
          )
        ) : null}

        {/* ---- Enrollment in progress: QR + secret + recovery + confirm ----- */}
        {enroll ? (
          <div className="space-y-5">
            {/* A host-started card sits under its Settings row, whose hairline already
                divides it from the row; a second rule would stack under it. */}
            {hostStarted ? null : <Separator />}
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <div className="shrink-0">
                {qrFailed ? (
                  <div className="flex h-[180px] w-[180px] items-center justify-center rounded-md border border-dashed border-border bg-muted/40 p-3 text-center text-xs text-muted-foreground">
                    QR code unavailable. Enter the secret by hand below.
                  </div>
                ) : (
                  <div className="rounded-md border border-border bg-white p-2">
                    <React.Suspense fallback={<div className="h-[180px] w-[180px]" aria-hidden="true" />}>
                      <QRCode value={enroll.otpauth_uri} size={180} onError={() => setQrFailed(true)} />
                    </React.Suspense>
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  {/* An enrollment the operator started (not the login-phase mode, whose
                      heading keeps focus) moves focus here when it arrives, so the steps
                      read in order (see the module comment). Never a tab stop. */}
                  <p
                    id="mfa-step-scan"
                    tabIndex={pendingToken ? undefined : -1}
                    ref={pendingToken ? undefined : focusOnMount}
                    className="rounded-sm text-sm font-medium text-foreground outline-none"
                  >
                    1. Scan with your authenticator app
                  </p>
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
                Each code works once if you lose your device. Store them somewhere safe: they
                are shown only now.
              </p>
              <div className="grid grid-cols-2 gap-1.5 font-mono text-xs">
                {enroll.recovery_codes.map((c) => (
                  <span key={c} className="rounded border border-border bg-card px-2 py-1">{c}</span>
                ))}
              </div>
              {/* Login-phase mandated mode only: confirming immediately completes the
                  login and this one-time view of the codes is gone — require an
                  explicit save acknowledgment before "Verify and sign in" enables. */}
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
                {/* No autoFocus in any mode: focus starts at step 1 (or stays on the
                    login-phase mode heading), and yanking it to this last field would skip
                    the QR code, secret and one-time recovery codes. Read-only, not
                    disabled, while the request runs, so focus is never dropped. */}
                <Input
                  ref={confirmInputRef}
                  id="mfa-confirm-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  className="max-w-[160px]"
                  value={confirmCode}
                  onChange={(ev) => setConfirmCode(ev.target.value)}
                  readOnly={busy}
                  aria-busy={busy || undefined}
                />
                <Button
                  type="submit"
                  size="sm"
                  // Busy, not disabled: it keeps focus while the code is checked.
                  disabled={!busy && (confirmCode.trim().length < 6 || (!!pendingToken && !savedAck))}
                  aria-disabled={busy || undefined}
                  className={BUSY_INERT}
                >
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
                  {/* In the login-phase mandated mode a successful confirm IS the login. */}
                  {pendingToken ? 'Verify and sign in' : 'Verify and turn on'}
                </Button>
                {/* No mid-flow Cancel in the mandated login-phase mode: there is no
                    session to fall back into — the parent owns the only exits
                    (complete enrollment, or back to sign-in). */}
                {pendingToken ? null : (
                  <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={busy}>
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
  if (frameless) return <div ref={rootRef} className="space-y-5">{body}</div>;

  return (
    <Card>
      <CardContent ref={rootRef} className="space-y-5 p-6">{body}</CardContent>
    </Card>
  );
}

export default MfaSetupCard;
