/**
 * NoticeCallout — the one callout at the top of an answer that explains why it is
 * partial, refused, stopped or failed (chat revamp SPEC §4.5, §10.3 notice placement;
 * Round 12 copy in `notice-copy.ts`).
 *
 * `not_saved` is the quiet "Not saved · Run again to save" line under the meta row (see
 * `MemoryLine`) and `compacted` is a quiet run-log row, so neither is a callout. Chat
 * has no Continue chip (Round 12 SPEC D2/D3): a capped answer in the operator's bounded
 * mode says so here, without an action. The callout is `role="note"`, never a live
 * region: the page announces errors once through the shell announcer (SPEC §10.9).
 */
import * as React from 'react';
import { CircleAlert, CircleStop, Info, RotateCcw, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { TurnNoticeKind } from '@/lib/types';
import { Button } from '@/ui/button';
import { CALLOUT_NOTICE_KINDS, NOTICE_TITLE, NOTICE_TONE, noticeBody, type NoticeTone } from './notice-copy';

export { CALLOUT_NOTICE_KINDS };

const TONE_CLASS: Record<NoticeTone, { box: string; icon: string; Icon: React.ComponentType<{ className?: string }> }> = {
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
  /**
   * The sentence under the title. Default: `message` without a repeat of the title
   * (`noticeBody`); `null` shows the title alone.
   */
  body?: string | null;
  kind?: TurnNoticeKind;
  /** Force a tone (an error turn without a notice reads as critical). */
  tone?: NoticeTone;
  /** Shown only when the notice (or failure) is retryable. */
  actionLabel?: string;
  onAction?: () => void;
  /** The action's icon (default: the retry arrow). */
  actionIcon?: React.ReactNode;
  actionDisabled?: boolean;
  /** A second, quieter action (e.g. "Ask again" on a non-retryable failure). */
  secondaryLabel?: string;
  onSecondary?: () => void;
  className?: string;
}

export function NoticeCallout({
  title,
  message,
  body,
  kind = 'partial',
  tone,
  actionLabel,
  onAction,
  actionIcon,
  actionDisabled = false,
  secondaryLabel,
  onSecondary,
  className,
}: NoticeCalloutProps) {
  const style = TONE_CLASS[tone ?? NOTICE_TONE[kind]];
  const heading = title ?? NOTICE_TITLE[kind];
  const text = body === undefined ? noticeBody(heading, message) : body;
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
        {text ? <p className="mt-0.5 text-muted-foreground">{text}</p> : null}
        {(actionLabel && onAction) || (secondaryLabel && onSecondary) ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {actionLabel && onAction ? (
              <Button type="button" size="sm" variant="outline" className="h-7" onClick={onAction} disabled={actionDisabled}>
                {actionIcon ?? <RotateCcw aria-hidden />}
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
