/**
 * UserTurn — the operator's message: a compact, muted, right-aligned bubble (max
 * 36rem) with a hidden `<h3>` for heading navigation (chat revamp SPEC §10.1a, §10.3).
 *
 * It renders `ChatUserItem.content` — the DISPLAY form with invisible, bidi and
 * control characters already stripped — and never `.prompt` (the exact stored text
 * that Ask again reuses). Copy and Save prompt sit beside the bubble on hover or
 * keyboard focus.
 */
import * as React from 'react';
import { Bookmark, Check, Copy } from 'lucide-react';

import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import { IconButton } from '@/soc/components/IconButton';
import { useAnnouncer } from '@/soc/components/announcer';
import { isSafeChatId } from '../chat-api';
import type { ChatUserItem } from '../useChatEngine';

export interface UserTurnProps {
  item: ChatUserItem;
  headingId: string;
  /** Save the prompt to the viewer's saved prompts (Workspace only). */
  onSavePrompt?: (item: ChatUserItem) => void;
  compact?: boolean;
  /** A requested message (deep link / search hit): ringed for 2 s. */
  highlighted?: boolean;
  className?: string;
}

function UserTurnView({ item, headingId, onSavePrompt, compact = false, highlighted = false, className }: UserTurnProps) {
  const announce = useAnnouncer();
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    // copyText falls back to a textarea copy over plain HTTP; only claim success on true.
    void copyText(item.content).then((ok) => {
      if (!ok) return;
      setCopied(true);
      announce('Copied');
    });
  };

  return (
    <div className={cn('group/user flex min-w-0 items-start justify-end gap-1', className)}>
      <h3 id={headingId} className="sr-only">
        You
      </h3>
      {/* Opacity, not visibility: these stay in the tab order (a user turn has no other
          focusable content that could reveal them through focus-within). */}
      <div className="flex shrink-0 items-center gap-0.5 pt-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/user:opacity-100 motion-reduce:transition-none">
        <IconButton label={copied ? 'Copied' : 'Copy message'} size="sm" onClick={copy}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </IconButton>
        {onSavePrompt ? (
          <IconButton label="Save prompt" size="sm" onClick={() => onSavePrompt(item)}>
            <Bookmark aria-hidden />
          </IconButton>
        ) : null}
      </div>
      <div
        className={cn(
          'min-w-0 max-w-[min(36rem,100%)] whitespace-pre-wrap break-words rounded-lg bg-muted text-foreground',
          compact ? 'px-3 py-1.5 text-sm' : 'px-3.5 py-2 text-md leading-relaxed',
          highlighted && 'ring-2 ring-primary/60 ring-offset-2 ring-offset-background',
        )}
        data-highlighted={highlighted || undefined}
        data-message-id={isSafeChatId(item.messageId) ? item.messageId : undefined}
      >
        {item.content}
      </div>
    </div>
  );
}

/** Memoised: a user turn never changes once sent (only its `failed` flag). */
export const UserTurn = React.memo(UserTurnView);
