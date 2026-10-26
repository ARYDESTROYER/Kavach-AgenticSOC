/**
 * Callout: a message box with three intents only (Round 14, SPEC §4.9.2, D26;
 * ui-standard "Forms, Settings, and dangerous actions").
 *
 *   warning  a live condition the reader should know about now ("RBAC is disabled").
 *   error    something failed or blocks the task.
 *   intro    a first-run explanation the reader can dismiss; the dismissal is
 *            remembered per user (`UserPrefs.misc.dismissed_intros`, at most 50 ids), so
 *            the note never returns once read.
 *
 * Reassurance that does not change what the reader does is not a callout: it is the
 * page's or section's help tip. `Alert variant="info"` in a page file fails the console
 * grammar guard for that reason.
 *
 * Text: the title carries the intent's measured `-text` colour (AA on its 10% wash, and
 * on a panel the panel steps); the body stays in the foreground ink, which reads better
 * than coloured paragraphs. The icon repeats the intent for sighted readers, the title
 * states it in words. Live semantics: `error` is an `alert`, `warning` a polite `status`,
 * `intro` a `note`. All text is plain (#9).
 *
 * A plain function component with no module-level calls, so the `@/design-system` index
 * that the entry imports stays tree-shakeable (SPEC §3.4).
 */
import * as React from 'react';
import { CircleAlert, Info, TriangleAlert, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { useOptionalPrefs } from '@/soc/prefs';

export type CalloutIntent = 'warning' | 'error' | 'intro';

/** The `UserPrefs.misc` key that remembers dismissed intro callouts. */
export const DISMISSED_INTROS_KEY = 'dismissed_intros';
/** The server keeps at most this many dismissed intro ids per user. */
export const DISMISSED_INTROS_MAX = 50;
/**
 * The id grammar the server keeps (`DISMISSED_INTRO_ID_PATTERN` in `backend/app/models.py`):
 * lower case letters and digits first, then up to 63 of `a-z 0-9 _ . : -`. The server
 * silently drops any other id, so an intro with one would dismiss for the session and come
 * back on the next load; such an intro is not dismissible at all.
 */
export const DISMISSED_INTRO_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

export interface CalloutProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  intent: CalloutIntent;
  /** A short sentence-case title that states the condition ("RBAC is disabled"). */
  title?: React.ReactNode;
  /** One action (a button or link), under the body. */
  action?: React.ReactNode;
  /**
   * `intro` only: the stable id the dismissal is remembered by ("runbook-migration"). It
   * must match {@link DISMISSED_INTRO_ID_PATTERN} (lower case, `a-z 0-9 _ . : -`, at most 64
   * characters), the grammar the server keeps. Without a valid one an intro cannot be
   * dismissed.
   */
  introId?: string;
  /** Called after an intro is dismissed. */
  onDismiss?: () => void;
  children?: React.ReactNode;
}

const INTENT = {
  warning: {
    Icon: TriangleAlert,
    box: 'border-warning/40 bg-warning/10',
    ink: 'text-warning-text',
    role: 'status',
  },
  error: {
    Icon: CircleAlert,
    box: 'border-critical/40 bg-critical/10',
    ink: 'text-critical-text',
    role: 'alert',
  },
  intro: {
    Icon: Info,
    box: 'border-border bg-muted/60',
    ink: 'text-foreground',
    role: 'note',
  },
} as const;

/** The ids this viewer has dismissed, read defensively (the server normalises the list). */
function readDismissed(misc: Record<string, unknown> | undefined): string[] {
  const raw = misc?.[DISMISSED_INTROS_KEY];
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * A candidate can take focus: it is rendered (no `display: none` or `visibility: hidden`
 * on it or an ancestor) and not inert or hidden from assistive technology. Focusing a
 * hidden control does nothing, which would drop focus on the page body.
 */
function canTakeFocus(node: HTMLElement): boolean {
  if (node.closest('[inert],[aria-hidden="true"],[hidden]')) return false;
  if (typeof node.checkVisibility === 'function') {
    return node.checkVisibility({ checkVisibilityCSS: true });
  }
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

/**
 * The next focusable element after `el` in document order (else the one before), so
 * dismissing a note never drops keyboard focus onto the page body. Hidden controls (a
 * copy shown only at another breakpoint, a closed region) are skipped.
 */
function neighbourFocusTarget(el: HTMLElement): HTMLElement | null {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const all = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((n) => !el.contains(n));
  const after = all.find(
    (n) => el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING && canTakeFocus(n),
  );
  if (after) return after;
  const before = all.filter((n) => el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (canTakeFocus(before[i])) return before[i];
  }
  return null;
}

export function Callout({
  intent,
  title,
  action,
  introId,
  onDismiss,
  className,
  children,
  role,
  ...rest
}: CalloutProps) {
  const prefs = useOptionalPrefs();
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [dismissedHere, setDismissedHere] = React.useState(false);
  const meta = INTENT[intent];
  const validIntroId = introId != null && DISMISSED_INTRO_ID_PATTERN.test(introId);
  const dismissible = intent === 'intro' && validIntroId;
  React.useEffect(() => {
    if (import.meta.env.DEV && intent === 'intro' && introId != null && !validIntroId) {
      console.error(
        `Callout: introId "${introId}" does not match ${String(DISMISSED_INTRO_ID_PATTERN)}; the intro cannot be dismissed.`,
      );
    }
  }, [intent, introId, validIntroId]);
  const dismissed = React.useMemo(() => readDismissed(prefs?.prefs.misc), [prefs?.prefs.misc]);

  if (dismissible) {
    if (dismissedHere || dismissed.includes(introId as string)) return null;
    // Until the viewer's preferences are loaded we cannot know whether they dismissed
    // this note, so it waits rather than flashing in and out.
    if (prefs && !prefs.ready) return null;
  }

  const dismiss = () => {
    const el = boxRef.current;
    const next = el ? neighbourFocusTarget(el) : null;
    setDismissedHere(true);
    if (prefs && introId) {
      const list = [...dismissed.filter((id) => id !== introId), introId].slice(-DISMISSED_INTROS_MAX);
      prefs.patchMisc({ [DISMISSED_INTROS_KEY]: list });
    }
    next?.focus();
    onDismiss?.();
  };

  const { Icon } = meta;
  return (
    <div
      ref={boxRef}
      role={role ?? meta.role}
      data-callout={intent}
      className={cn('flex w-full gap-3 rounded-lg border px-4 py-3 text-sm', meta.box, className)}
      {...rest}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', meta.ink)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className={cn('font-medium', meta.ink)}>{title}</p> : null}
        {children ? <div className="text-foreground">{children}</div> : null}
        {action ? <div className="pt-1">{action}</div> : null}
      </div>
      {dismissible ? (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className={cn(
            '-mr-1 -mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            focusRing,
          )}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
