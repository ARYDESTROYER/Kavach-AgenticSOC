/**
 * Remember me: the sign-in page controls (Round 12, SPEC D14). LAZY chunk.
 *
 * The sign-in page is part of the first-paint entry chunk, so everything Remember
 * me draws lives here and is loaded in parallel with the page's own startup probes
 * (the page waits for both before it paints, so nothing pops in):
 *
 *   - {@link RememberMeControl}: the checkbox row (the whole row is a ≥44px hit
 *     target with press feedback) and the warning dialog shown when the box is
 *     checked for anyone this device does not already remember. Shown DISABLED with
 *     a one-line reason when the administrator turned it off or the connection is
 *     not secure. "Use a different account" on the sign-in page forgets the device;
 *     "Forget this device" lives in Settings, under Sessions & activity.
 *   - {@link SessionEndNotice}: the calm notice explaining why the last session
 *     ended (the server's reason, or a remembered session that ran out while the
 *     browser was closed), announced to screen readers.
 *
 * All copy is plain text; the username is user-entered and rendered as text (#9).
 */
import * as React from 'react';
import { Info, ShieldAlert } from 'lucide-react';
import type { RememberMeStatus, SessionEndReason } from '@/lib/types';
import { cn } from '@/lib/cn';
import { Checkbox } from '@/ui/checkbox';
import { Alert, AlertDescription } from '@/ui/alert';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import {
  formatRememberDuration,
  formatRememberWindow,
  insecureRememberHint,
  readRememberedUsername,
  rememberAckCovers,
  signedOutNotice,
  takeExpiredRememberedSession,
} from './rememberMe';

export interface RememberMeControlProps {
  /** The public policy from GET /api/setup/status. */
  status: RememberMeStatus;
  /** Whether the box is checked (the caller owns the one shared state). */
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** A sign-in is in flight. */
  busy?: boolean;
  /** The identity being signed in (for the warning); may be empty (SSO). */
  username: string;
  /** The product / organisation name shown in the warning. */
  wordmark: string;
}

/**
 * The remembered inactivity limit worth stating ("12 hours"), or null when no
 * inactivity limit is shorter than the remembered lifetime (or the server does not
 * report one).
 */
export function rememberIdleLimit(status: RememberMeStatus | null | undefined): string | null {
  const idle = Math.round(Number(status?.idle_seconds) || 0);
  const lifetime = Math.round(Number(status?.duration_seconds) || 0);
  if (idle <= 0 || (lifetime > 0 && idle >= lifetime)) return null;
  return formatRememberDuration(idle);
}

/** Whether the policy lets this console offer Remember me right now. */
export function rememberAvailable(status: RememberMeStatus | null | undefined): boolean {
  return Boolean(status?.enabled && !status?.insecure_blocked);
}

export function RememberMeControl({
  status,
  checked,
  onCheckedChange,
  busy = false,
  username,
  wordmark,
}: RememberMeControlProps) {
  const [promptOpen, setPromptOpen] = React.useState(false);
  // The account whose warning was accepted on THIS page (before signing in), so
  // unchecking and re-checking the same name does not nag. Never persisted.
  const [acceptedFor, setAcceptedFor] = React.useState<string | null>(null);
  const checkboxRef = React.useRef<HTMLButtonElement>(null);
  const available = rememberAvailable(status);
  const interactive = available && !busy;
  const duration = formatRememberDuration(status.duration_seconds);
  const idle = rememberIdleLimit(status);
  // "Up to": a remembered device can be signed out sooner (inactivity, an
  // administrator); the warning spells out each limit.
  const hint = !status.enabled
    ? 'Turned off by your administrator'
    : status.insecure_blocked
      ? insecureRememberHint()
      : `Stay signed in on this device for up to ${duration}`;

  const name = username.trim();
  const nameKey = name.toLowerCase();

  const onChange = (next: boolean) => {
    if (!next) {
      onCheckedChange(false);
      return;
    }
    // The warning is skipped only for the person this device already remembers
    // (they accepted it when they signed in) or whoever accepted it on this page.
    // Anyone else on the same device sees it (shared and kiosk computers).
    if (rememberAckCovers(name) || (nameKey !== '' && acceptedFor === nameKey)) {
      onCheckedChange(true);
      return;
    }
    setPromptOpen(true);
  };

  return (
    <div className="flex items-center">
      <label
        data-login-remember
        className={cn(
          '-mx-2 flex min-h-11 min-w-0 select-none items-center gap-3 rounded-md px-2',
          // Press feedback only when pressing can do something.
          interactive ? 'press-scale cursor-pointer' : 'cursor-not-allowed',
        )}
      >
        <Checkbox
          ref={checkboxRef}
          id="login-remember"
          checked={available && checked}
          disabled={!interactive}
          onCheckedChange={(value) => onChange(value === true)}
          onKeyDown={(event) => {
            // A native checkbox submits its form on Enter; Radix's button does not.
            // Keep the familiar "tick the box, press Enter to sign in" flow.
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.closest('form')?.requestSubmit();
            }
          }}
          aria-labelledby="login-remember-label"
          aria-describedby="login-remember-hint"
        />
        <span className="min-w-0">
          <span
            id="login-remember-label"
            className={cn('block text-sm', available ? 'text-foreground' : 'text-muted-foreground')}
          >
            Remember me
          </span>
          <span id="login-remember-hint" className="block text-xs text-muted-foreground">
            {hint}
          </span>
        </span>
      </label>
      <ConfirmDialog
        open={promptOpen}
        onOpenChange={setPromptOpen}
        returnFocusRef={checkboxRef}
        richDescription
        title={
          // Warning tone, not destructive: an amber shield and a normal primary button.
          <span className="flex items-center gap-2" data-remember-warning-title>
            <ShieldAlert className="h-5 w-5 shrink-0 text-warning-text" aria-hidden="true" />
            Keep this device signed in?
          </span>
        }
        description={
          // The whole warning (the paragraph AND the list) is the dialog's
          // accessible description, so a screen reader hears the shared-device advice.
          <>
            <p>
              Only choose this on a device that you alone use. For{' '}
              {formatRememberWindow(status.duration_seconds)}, anyone who can open this browser
              can use {wordmark}
              {name ? (
                <>
                  {' '}as <span className="font-medium text-foreground">{name}</span>
                </>
              ) : (
                ' with your account'
              )}
              , including cases, chat and response actions, without entering your password.
            </p>
            <ul data-remember-warning className="list-disc space-y-1.5 pl-5">
              <li>
                Your username will be remembered on this device, and your browser may offer to
                save your password.
              </li>
              <li data-remember-warning-limits>
                You&apos;ll be asked to sign in again after {duration}
                {idle ? <>, after {idle} without activity,</> : ','} or sooner if an
                administrator ends your session. Sensitive actions still ask for your password.
              </li>
              <li>
                Don&apos;t use this on shared, public, or kiosk computers. Sign out when
                you&apos;re done, and review your signed-in devices in Settings, under Sessions
                &amp; activity.
              </li>
            </ul>
          </>
        }
        confirmLabel="Keep me signed in"
        cancelLabel="Cancel"
        onConfirm={() => {
          // Recorded on this device only after a SUCCESSFUL remembered sign-in
          // (afterSignIn), never here: an abandoned or refused attempt leaves nothing.
          setAcceptedFor(nameKey || null);
          onCheckedChange(true);
        }}
        onCancel={() => onCheckedChange(false)}
      />
    </div>
  );
}

export interface SessionEndNoticeProps {
  /** The server's reason the previous session ended (registry-aware /auth/me). */
  reason?: SessionEndReason | null;
  /**
   * Told whether the notice is showing, so the page can point the focused field's
   * `aria-describedby` at {@link SESSION_END_NOTICE_ID}.
   */
  onShownChange?: (shown: boolean) => void;
}

/** The notice's element id (for the focused field's `aria-describedby`). */
export const SESSION_END_NOTICE_ID = 'login-session-notice';

/**
 * Why the last session ended: the server's reason first; otherwise a remembered
 * session on this device that ran out while the browser was closed (the browser
 * dropped the expired cookie, so only this device knows). The local marker is
 * consumed either way, so the notice shows once. The notice never states how long
 * the session lasted (Round 14 SPEC §4.1), whatever the server or the marker knows.
 *
 * The polite live region is in the page from the first paint and EMPTY; the text is
 * set after mount, which is what makes a screen reader announce it (a region that
 * arrives already filled is usually not read). The page also links the focused
 * field to it through `aria-describedby`.
 */
export function SessionEndNotice({ reason, onShownChange }: SessionEndNoticeProps) {
  const [text, setText] = React.useState<string | null>(null);
  React.useEffect(() => {
    const local = takeExpiredRememberedSession();
    const next =
      signedOutNotice(reason) ??
      (local && readRememberedUsername() ? signedOutNotice('absolute_expired') : null);
    // Only ever SET it here (StrictMode re-runs the effect after the marker is gone).
    if (next) setText(next);
  }, [reason]);
  React.useEffect(() => {
    onShownChange?.(Boolean(text));
  }, [text, onShownChange]);
  React.useEffect(() => () => onShownChange?.(false), [onShownChange]);
  return (
    <div role="status" aria-live="polite" data-login-notice-region>
      {text ? (
        <Alert variant="info" role="none" className="mb-5" data-login-notice>
          <Info aria-hidden />
          <AlertDescription id={SESSION_END_NOTICE_ID}>{text}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
