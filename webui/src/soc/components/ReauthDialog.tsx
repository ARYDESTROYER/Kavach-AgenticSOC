/**
 * Step-up re-authentication modal (Round-2 Wave 3).
 *
 * Registers a global gate with the api client (`setReauthHandler`). When ANY API
 * call returns 401 `{code:'reauth_required'}`, the client awaits this gate: the
 * modal opens, the user re-proves their password (and optionally a TOTP / recovery
 * code), and on success the gate resolves `true` so the original request is retried
 * once. Cancelling resolves `false` (the original 401 surfaces).
 *
 * Back-compat: the gate is only registered when `active` (auth enabled). When auth
 * is off, no handler is registered, so the api client never calls it — the no-auth
 * path is untouched. A queue dedupes concurrent gated requests onto ONE prompt.
 *
 * The dialog says what the sign-in is for: the gated request's `reauthPurpose` (an
 * export, which changes nothing, says so: "Sign in again to export audit events."),
 * else that it confirms a change. The first gated request names it; requests that
 * ride along on the open prompt do not change it.
 */
import * as React from 'react';
import { Lock, Eye, EyeOff, Loader2 } from 'lucide-react';
import { api, ApiError, setReauthHandler, type ReauthGate } from '@/lib/api';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Alert, AlertDescription } from '@/ui/alert';
import { IconButton } from './IconButton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/ui/dialog';

type Resolver = (ok: boolean) => void;

export interface ReauthDialogProps {
  /** Register the gate only when auth is enabled (off → no-op, back-compat). */
  active: boolean;
}

export function ReauthDialog({ active }: ReauthDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [reveal, setReveal] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // What this sign-in is for (the first gated request's purpose); none: a change.
  const [purpose, setPurpose] = React.useState<string | undefined>();
  // Every concurrently-gated request parks its resolver here; the first one opens
  // the modal, the rest ride along and are all settled together on close.
  const waitersRef = React.useRef<Resolver[]>([]);

  const settle = React.useCallback((ok: boolean) => {
    const waiters = waitersRef.current;
    waitersRef.current = [];
    setOpen(false);
    setPassword('');
    setCode('');
    setReveal(false);
    setError(null);
    setBusy(false);
    for (const resolve of waiters) resolve(ok);
  }, []);

  React.useEffect(() => {
    if (!active) {
      setReauthHandler(null);
      return undefined;
    }
    const gate: ReauthGate = (why) =>
      new Promise<boolean>((resolve) => {
        if (!waitersRef.current.length) setPurpose(why);
        waitersRef.current.push(resolve);
        setOpen(true);
      });
    setReauthHandler(gate);
    return () => setReauthHandler(null);
  }, [active]);

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.reauth(password, code.trim() || undefined);
      settle(true);
    } catch (e) {
      setBusy(false);
      // The api client words a wrong password ("That password is not correct. Try
      // again.", reason `bad_password`); any other failure keeps the server's sentence.
      setError(e instanceof ApiError && e.message ? e.message : 'Sign-in failed.');
    }
  };

  // Closing via the overlay / escape / Cancel resolves the gate as cancelled.
  const onOpenChange = (next: boolean) => {
    if (!next) settle(false);
    else setOpen(true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        // While a re-auth request is in flight, block Escape / overlay-click dismissal
        // (matching the disabled Cancel button): otherwise settle(false) clears the
        // parked waiters, so a request that then succeeds has nothing to retry and the
        // gated action fails despite a correct password.
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning-text"
              aria-hidden
            >
              <Lock className="h-4 w-4" />
            </span>
            Confirm your identity
          </DialogTitle>
          <DialogDescription>{purpose || 'Sign in again to confirm this change.'}</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="reauth-pass">Password</Label>
            <div className="relative">
              <Input
                id="reauth-pass"
                type={reveal ? 'text' : 'password'}
                className="pr-10"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={busy}
                /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                autoFocus
              />
              <div className="absolute inset-y-0 right-1 flex items-center">
                <IconButton
                  label={reveal ? 'Hide password' : 'Show password'}
                  tooltip={false}
                  onClick={() => setReveal((r) => !r)}
                  disabled={busy}
                >
                  {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </IconButton>
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reauth-code">
              Authentication code <span className="text-muted-foreground">(if enabled)</span>
            </Label>
            <Input
              id="reauth-code"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              placeholder="123456 or a recovery code"
              disabled={busy}
            />
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => settle(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-warning text-warning-foreground shadow-sm hover:bg-warning/90 active:bg-warning/85"
              disabled={busy || !password}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Sign in
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default ReauthDialog;
