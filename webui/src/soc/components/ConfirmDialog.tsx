/**
 * ConfirmDialog — the ONE destructive-action gate (DESIGN_STANDARD §5.2). Replaces
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
 * a11y / safety (§5.2, map §3.16): built on the vendored AlertDialog (role=
 * alertdialog, no top-right close). For `destructive` gates we SUPPRESS
 * dismiss-on-overlay-click and Escape so a dangerous action is never confirmed by
 * an accidental click-away — the operator must pick Cancel or Confirm explicitly.
 * All text renders plain (#9).
 */
import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
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
}

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
}: ConfirmDialogProps) {
  // The Action/Cancel buttons are Radix `Close`s, so clicking either ALSO fires
  // `onOpenChange(false)`. We route the cancel/dismiss path through onOpenChange
  // ONLY (single source of truth) and mark a confirm so the ensuing close does
  // not also fire onCancel. This keeps each callback exactly-once.
  const confirmedRef = React.useRef(false);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
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
        dismissible={!destructive}
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
          {/* Cancel closes the dialog; onCancel fires via onOpenChange (single path). */}
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          {hideConfirm ? null : (
            <AlertDialogAction
              variant={destructive ? 'destructive' : 'default'}
              onClick={() => {
                confirmedRef.current = true;
                onConfirm();
              }}
            >
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
