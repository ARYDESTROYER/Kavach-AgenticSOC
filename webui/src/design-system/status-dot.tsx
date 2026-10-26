/**
 * StatusDot: a status as a 6px dot and plain text (Round 14, SPEC §4.9.2; ui-standard
 * "Tables, filters and lists").
 *
 * One status vocabulary for rows and settings ("Active", "Ready", "Needs key",
 * "Unsupported", "Off"). The healthy default is quiet: a neutral dot and muted text, so
 * a list of healthy rows reads calm and the exceptions stand out. Only a tone that is
 * not the healthy default colours the dot, and its text steps up to the foreground ink.
 * The fact is always in the text (status is never colour alone, WCAG 1.4.1): the dot is
 * decorative and hidden from assistive technology, and in forced colours (where
 * backgrounds are dropped) the text still carries it. All text is plain (#9).
 *
 * A plain function component with no module-level calls, so the `@/design-system` index
 * that the entry imports stays tree-shakeable (SPEC §3.4).
 */
import * as React from 'react';

import { cn } from '@/lib/cn';

/** `neutral` is the healthy default; the other tones mark an exception. */
export type StatusTone = 'neutral' | 'success' | 'info' | 'warning' | 'critical';

const DOT: Record<StatusTone, string> = {
  neutral: 'bg-muted-foreground/60',
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
  critical: 'bg-critical',
};

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** The tone of the dot. Default `neutral` (the healthy default: muted, uncoloured). */
  tone?: StatusTone;
  /** The status in words ("Needs key"). Required: the dot alone never carries it. */
  children: React.ReactNode;
}

export function StatusDot({ tone = 'neutral', className, children, ...rest }: StatusDotProps) {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-sm',
        tone === 'neutral' ? 'text-muted-foreground' : 'text-foreground',
        className,
      )}
      data-status-tone={tone}
      {...rest}
    >
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', DOT[tone])} />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
