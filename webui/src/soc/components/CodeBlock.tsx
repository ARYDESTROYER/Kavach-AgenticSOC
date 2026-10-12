/**
 * UNTRUSTED-safe code rendering.
 *
 * Security: every value flowing through these components is treated as UNTRUSTED
 * (log lines, queries, IOCs, model keys, raw events, comments...). It is rendered
 * EXCLUSIVELY as text children inside a <pre>/<code> — never via
 * `dangerouslySetInnerHTML` — so no markup, script, or close-marker in the data
 * can escape the fence. Children are coerced to a string defensively.
 */
import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import { focusRing } from '@/lib/ui-recipes';

/** Coerce arbitrary content to a safe display string (never throws). */
function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// --------------------------------------------------------------------------- //
// InlineCode — a single-line UNTRUSTED token (an IP, a rule id, a model key).
// --------------------------------------------------------------------------- //
export interface InlineCodeProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
  /** Alternative to children: a raw value to render as text. */
  value?: unknown;
}

export const InlineCode = React.forwardRef<HTMLElement, InlineCodeProps>(
  ({ className, children, value, ...props }, ref) => {
    const text = value !== undefined ? toText(value) : children;
    return (
      <code
        ref={ref}
        className={cn(
          'rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-sm ' +
            'text-foreground break-all',
          className,
        )}
        {...props}
      >
        {text}
      </code>
    );
  },
);
InlineCode.displayName = 'InlineCode';

// --------------------------------------------------------------------------- //
// CodeBlock — a multi-line UNTRUSTED block with an optional copy button + caption.
// --------------------------------------------------------------------------- //
export interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Text content (preferred). */
  value?: unknown;
  /** Alternative to `value`: children rendered as text. */
  children?: React.ReactNode;
  /** Optional small caption / language tag shown in the header strip. */
  caption?: React.ReactNode;
  /** Show the copy-to-clipboard control (default true). */
  copyable?: boolean;
  /** What Copy takes when it differs from what is shown (a reading view of exact text). */
  copyValue?: string;
  /** Allow long lines to wrap instead of scrolling horizontally. */
  wrap?: boolean;
  /** Cap the visible height; content scrolls past it. */
  maxHeightClassName?: string;
}

export const CodeBlock = React.forwardRef<HTMLDivElement, CodeBlockProps>(
  (
    {
      className,
      value,
      children,
      caption,
      copyable = true,
      copyValue,
      wrap = false,
      maxHeightClassName = 'max-h-80',
      ...props
    },
    ref,
  ) => {
    const text = value !== undefined ? toText(value) : toText(children);
    const [copied, setCopied] = React.useState(false);
    const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(
      () => () => {
        if (timer.current) clearTimeout(timer.current);
      },
      [],
    );

    const onCopy = React.useCallback(() => {
      // Route through copyText() so copy ALSO works over plain HTTP (non-secure
      // context, where navigator.clipboard is undefined). Show "Copied" only on a
      // truthy result — never claim success for a copy that never happened (bug #4).
      void copyText(copyValue ?? text).then((ok) => {
        if (!ok) return;
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      });
    }, [copyValue, text]);

    const showHeader = Boolean(caption) || copyable;

    return (
      <div
        ref={ref}
        className={cn(
          'relative overflow-hidden rounded-md border border-border bg-card',
          className,
        )}
        {...props}
      >
        {showHeader && (
          <div className="flex items-center justify-between border-b border-border bg-surface px-3 py-1.5">
            <span className="truncate font-mono text-xs text-muted-foreground">{caption}</span>
            {copyable && (
              <button
                type="button"
                onClick={onCopy}
                aria-label={copied ? 'Copied' : 'Copy to clipboard'}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs ' +
                    'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                  focusRing,
                )}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
        )}
        <pre
          className={cn(
            'overflow-auto p-3 font-mono text-sm leading-relaxed text-foreground',
            wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
            maxHeightClassName,
          )}
        >
          <code>{text}</code>
        </pre>
      </div>
    );
  },
);
CodeBlock.displayName = 'CodeBlock';
