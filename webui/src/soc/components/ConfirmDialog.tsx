/**
 * ConfirmDialog: the ONE destructive-action gate (DESIGN_STANDARD §5.2). Replaces
 * every `window.confirm(...)` (Roles.tsx / Users.tsx) with an accessible,
 * themeable, promise-based confirmation.
 *
 * Two shapes, pick whichever fits the call site:
 *
 * 1) Imperative (promise-based) via `useConfirm()` — mount `<ConfirmRoot/>` once
 *    near the app root, then:
 *       const confirm = useConfirm();
 *       if (await confirm({ title: 'Delete role?', destructive: true })) doDelete();
 *
 * 2) Declarative (controlled) via `<ConfirmDialog open onOpenChange .../>` when you
 *    already hold open state.
 *
 * Async confirm (Round 14): pass `busy` when the confirmed work is asynchronous. The
 * confirm then leaves the dialog open; while `busy` is true the action shows that it is
 * working and does nothing when pressed, and Cancel, Escape and click-away wait, so the
 * operator sees the work finish (or fail) where they started it. The caller closes the
 * dialog when the work ends (`open={false}`), or keeps it open to show what went wrong.
 * Busy, not disabled: both buttons stay focusable (`aria-disabled`), because a browser
 * moves focus from a button that becomes `disabled` to the page body, which would take a
 * keyboard or screen reader user out of the dialog while the work runs (WCAG 2.4.3).
 *
 * a11y / safety (§5.2, map §3.16): built on the vendored AlertDialog (role=
 * alertdialog, no top-right close). For `destructive` gates we SUPPRESS
 * dismiss-on-overlay-click and Escape so a dangerous action is never confirmed by
 * an accidental click-away — the operator must pick Cancel or Confirm explicitly.
 * All text renders plain (#9).
 */
import * as React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/ui/alert-dialog';
import { cn } from '@/lib/cn';

export interface ConfirmOptions {
  /** Dialog heading (plain text). */
  title: React.ReactNode;
  /** Optional body / explanation of consequences. */
  description?: React.ReactNode;
  /** Confirm button text. Default "Confirm". */
  confirmLabel?: string;
  /** Cancel button text. Default "Cancel". */
  cancelLabel?: string;
  /** Style the confirm button as destructive + show a warning icon + lock dismiss. */
  destructive?: boolean;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the operator confirms. */
  onConfirm: () => void;
  /** Optional: called when the operator cancels/dismisses. */
  onCancel?: () => void;
  /** Extra content between the description and the footer (e.g. a "type to confirm" input). */
  children?: React.ReactNode;
  /** Hide the confirm action when the caller cannot safely offer it yet. */
  hideConfirm?: boolean;
  /**
   * Where keyboard focus returns when the dialog closes. A controlled dialog has no
   * trigger, so without this focus would fall back to the page body (WCAG 2.4.3).
   */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /**
   * Render `description` as a block (paragraphs and lists) rather than one
   * paragraph. It stays the dialog's accessible description, so assistive
   * technology reads all of it.
   */
  richDescription?: boolean;
  /**
   * Async confirm: set while the confirmed work runs (see the module comment). Passing
   * it at all, even `false`, means the confirm does not close the dialog by itself; the
   * caller closes it when the work ends.
   */
  busy?: boolean;
}

/**
 * A busy button looks unavailable but keeps focus (see the module comment): the
 * `aria-disabled` styling from the Wizard's busy Remove, not the native `disabled` one.
 */
const BUSY_INERT = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

/** The controlled dialog. */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  onCancel,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive,
  children,
  hideConfirm = false,
  returnFocusRef,
  richDescription = false,
  busy,
}: ConfirmDialogProps) {
  // An async confirm (`busy` given) keeps the dialog open after the click; while the work
  // runs nothing can close it.
  const asyncConfirm = busy !== undefined;
  const working = busy === true;
  // The Action/Cancel buttons are Radix `Close`s, so clicking either ALSO fires
  // `onOpenChange(false)`. We route the cancel/dismiss path through onOpenChange
  // ONLY (single source of truth) and mark a confirm so the ensuing close does
  // not also fire onCancel. This keeps each callback exactly-once.
  const confirmedRef = React.useRef(false);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Nothing closes the dialog while the confirmed work runs.
        if (!next && working) return;
        if (!next) {
          if (confirmedRef.current) {
            confirmedRef.current = false; // a confirm-driven close: onConfirm already ran
          } else {
            onCancel?.(); // a true cancel / Escape / click-away
          }
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent
        // Destructive gates cannot be dismissed by click-away / Escape (§3.16). Defer
        // to the primitive's `dismissible` switch as the single source of truth — it
        // suppresses pointer-outside, Escape AND interact-outside (the hand-rolled
        // handlers missed the last one), so no accidental dismissal slips through.
        dismissible={!destructive && !working}
        onCloseAutoFocus={
          returnFocusRef
            ? (event) => {
                const target = returnFocusRef.current;
                if (target) {
                  event.preventDefault();
                  target.focus();
                }
              }
            : undefined
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle className={cn(destructive && 'flex items-center gap-2')}>
            {destructive ? <AlertTriangle className="h-5 w-5 text-critical-text" aria-hidden="true" /> : null}
            {title}
          </AlertDialogTitle>
          {description ? (
            richDescription ? (
              <AlertDialogDescription asChild>
                <div className="space-y-3">{description}</div>
              </AlertDialogDescription>
            ) : (
              <AlertDialogDescription>{description}</AlertDialogDescription>
            )
          ) : null}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          {/* Cancel closes the dialog; onCancel fires via onOpenChange (single path).
              While the work runs it stays focusable but does nothing: preventing the
              click stops the primitive's own close, and onOpenChange ignores a close
              while working as a backstop. */}
          <AlertDialogCancel
            aria-disabled={working || undefined}
            className={BUSY_INERT}
            onClick={(event) => {
              if (working) event.preventDefault();
            }}
          >
            {cancelLabel}
          </AlertDialogCancel>
          {hideConfirm ? null : (
            <AlertDialogAction
              variant={destructive ? 'destructive' : 'default'}
              aria-disabled={working || undefined}
              aria-busy={working || undefined}
              className={BUSY_INERT}
              onClick={(event) => {
                if (working) {
                  event.preventDefault();
                  return;
                }
                if (asyncConfirm) {
                  // The caller closes the dialog when the work ends.
                  event.preventDefault();
                } else {
                  confirmedRef.current = true;
                }
                onConfirm();
              }}
            >
              {working ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {confirmLabel}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
ConfirmDialog.displayName = 'ConfirmDialog';

/* ── Imperative promise-based API ─────────────────────────────────────────── */

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

/**
 * Provider — mount ONCE near the app root (inside the TooltipProvider). Hosts a
 * single ConfirmDialog and exposes the imperative `confirm()` via context.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<ConfirmOptions | null>(null);
  const resolver = React.useRef<((v: boolean) => void) | null>(null);

  const confirm = React.useCallback<ConfirmFn>((opts) => {
    setState(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = React.useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setState(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state ? (
        <ConfirmDialog
          {...state}
          open
          onOpenChange={(next) => {
            if (!next) settle(false);
          }}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      ) : null}
    </ConfirmContext.Provider>
  );
}

/**
 * useConfirm — returns an async `confirm(opts) => Promise<boolean>`. Requires a
 * `<ConfirmProvider>` ancestor. Throws (dev-loud) if used outside one so a missing
 * provider never silently no-ops a destructive gate.
 */
export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a <ConfirmProvider>');
  return ctx;
}
