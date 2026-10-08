/**
 * NoticeCallout — the one callout at the top of an answer that explains why it is
 * partial, refused, stopped or failed (chat revamp SPEC §4.5, §10.3 notice placement).
 *
 * `cap` is not a callout: it becomes the "Continue where this stopped" chip under the
 * answer, and `not_saved` is the quiet "Not saved · Retry save" line under the meta
 * row (see `MemoryLine`). The callout is `role="note"`, never a live region: the page
 * announces errors once through the shell announcer (SPEC §10.9).
 */
import * as React from 'react';
import { CircleAlert, CircleStop, Info, RotateCcw, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { TurnNotice, TurnNoticeKind } from '@/lib/types';
import { Button } from '@/ui/button';

/** Notice kinds that render as the top-of-answer callout. */
export const CALLOUT_NOTICE_KINDS: ReadonlySet<TurnNoticeKind> = new Set([
  'partial',
  'denied',
  'timeout',
  'provider',
  'breaker',
  'cancelled',
  'unsupported',
  'budget',
]);

type Tone = 'warning' | 'critical' | 'info' | 'neutral';

const NOTICE_TITLE: Record<TurnNoticeKind, string> = {
  partial: 'Partial answer',
  cap: 'Answer limit reached',
  budget: 'Daily AI budget reached',
  provider: 'The model could not answer',
  breaker: 'The model is paused after repeated failures',
  denied: 'Some lookups were not allowed',
  timeout: 'The answer ran out of time',
  cancelled: 'Stopped',
  unsupported: 'Not something this assistant can do',
  not_saved: 'Not saved',
};

const NOTICE_TONE: Record<TurnNoticeKind, Tone> = {
  partial: 'warning',
  cap: 'warning',
  budget: 'critical',
  provider: 'critical',
  breaker: 'critical',
  denied: 'info',
  timeout: 'warning',
  cancelled: 'neutral',
  unsupported: 'info',
  not_saved: 'warning',
};

const TONE_CLASS: Record<Tone, { box: string; icon: string; Icon: React.ComponentType<{ className?: string }> }> = {
  warning: { box: 'border-l-warning', icon: 'text-warning-text', Icon: TriangleAlert },
  critical: { box: 'border-l-critical', icon: 'text-critical-text', Icon: CircleAlert },
  info: { box: 'border-l-info', icon: 'text-info-text', Icon: Info },
  neutral: { box: 'border-l-border-strong', icon: 'text-muted-foreground', Icon: CircleStop },
};

export interface NoticeCalloutProps {
  /** The bold first line; defaults to the notice kind's title. */
  title?: string;
  /** The engine-template message (display text). */
  message: string;
  kind?: TurnNoticeKind;
  /** Force a tone (an error turn without a notice reads as critical). */
  tone?: Tone;
  /** Shown only when the notice (or failure) is retryable. */
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  /** A second, quieter action (e.g. "Ask again" on a non-retryable failure). */
  secondaryLabel?: string;
  onSecondary?: () => void;
  className?: string;
}

export function NoticeCallout({
  title,
  message,
  kind = 'partial',
  tone,
  actionLabel,
  onAction,
  actionDisabled = false,
  secondaryLabel,
  onSecondary,
  className,
}: NoticeCalloutProps) {
  const style = TONE_CLASS[tone ?? NOTICE_TONE[kind]];
  const heading = title ?? NOTICE_TITLE[kind];
  const Icon = style.Icon;
  return (
    <div
      role="note"
      aria-label={heading}
      className={cn('flex items-start gap-2.5 rounded-md border border-l-2 border-border bg-surface/50 px-3 py-2', style.box, className)}
      data-notice-kind={kind}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', style.icon)} aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-foreground">{heading}</p>
        {message && message !== heading ? <p className="mt-0.5 text-muted-foreground">{message}</p> : null}
        {(actionLabel && onAction) || (secondaryLabel && onSecondary) ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {actionLabel && onAction ? (
              <Button type="button" size="sm" variant="outline" className="h-7" onClick={onAction} disabled={actionDisabled}>
                <RotateCcw aria-hidden />
                {actionLabel}
              </Button>
            ) : null}
            {secondaryLabel && onSecondary ? (
              <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onSecondary} disabled={actionDisabled}>
                {secondaryLabel}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
