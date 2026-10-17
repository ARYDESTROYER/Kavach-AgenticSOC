/**
 * ThreadCatchUp — the catch-up line above the composer in an open Workspace
 * conversation (SPEC-chat §3.1 `thread`, §3.6).
 *
 * It shows when the composer is empty, no turn is running, the thread's last answer
 * settled 30 minutes ago or more, and the server has at least one clause since then
 * (`GET /api/chat/starters?surface=thread&conversation_id=`). It hides the moment the
 * composer gets text, a turn starts, the viewer presses Hide, or the thread changes, and
 * it shows at most once per thread per visit (this component lives as long as the Chat
 * page). A clause sends its question in the SAME conversation (`origin: "starter"`).
 * No request is made while the line could not show (switched off, a fresh answer, a
 * thread it already showed in).
 */
import * as React from 'react';

import type { ChatStarter } from '@/lib/types';
import { CatchUpLine } from './CatchUpLine';
import { useChatStarters } from './useChatStarters';

/** The thread's last answer must have settled this long ago (`THREAD_SETTLED`). */
export const THREAD_SETTLED_MS = 30 * 60 * 1000;

export interface ThreadCatchUpProps {
  /** The open, restored conversation (null: none, or still restoring). */
  conversationId: string | null;
  principal?: string | null;
  /** The viewer's "Suggestions when a chat starts" switch (and its preference is known). */
  enabled: boolean;
  /** When the thread's last answer settled (ms since the epoch); null: none, or running. */
  lastAnswerAt: number | null;
  /** The composer holds no text. */
  draftEmpty: boolean;
  /** A turn is running. */
  busy: boolean;
  /** Sending is blocked (a thread restores, a promptbook runs). */
  disabled?: boolean;
  onSend: (starter: ChatStarter) => void;
  /**
   * The viewer pressed Hide and the line is gone: the host moves focus on (to the
   * composer below it), so a keyboard user is never dropped to <body>.
   */
  onHidden?: () => void;
  className?: string;
  /** Test seam: the clock. */
  now?: () => number;
}

export function ThreadCatchUp({
  conversationId,
  principal = null,
  enabled,
  lastAnswerAt,
  draftEmpty,
  busy,
  disabled = false,
  onSend,
  onHidden,
  className,
  now = Date.now,
}: ThreadCatchUpProps) {
  /** Threads whose line already showed (and went) during this visit. */
  const doneRef = React.useRef(new Set<string>());
  const shownRef = React.useRef<string | null>(null);
  const [hiddenFor, setHiddenFor] = React.useState<string | null>(null);

  const settled = lastAnswerAt !== null && now() - lastAnswerAt >= THREAD_SETTLED_MS;
  const eligible = enabled && !!conversationId && settled && !doneRef.current.has(conversationId);
  const starters = useChatStarters({ surface: 'thread', conversationId, principal, enabled: eligible });
  const catchUp = starters.info?.catch_up ?? null;
  const show = eligible && draftEmpty && !busy && !!catchUp && catchUp.clauses.length > 0 && hiddenFor !== conversationId;

  // Once shown, any reason it goes (text, a turn, Hide, another thread) ends it for this
  // thread until the next visit.
  React.useEffect(() => {
    const previous = shownRef.current;
    if (previous && (!show || previous !== conversationId)) {
      doneRef.current.add(previous);
      shownRef.current = null;
    }
    if (show && conversationId) shownRef.current = conversationId;
  }, [show, conversationId]);

  if (!show || !catchUp) return null;
  return (
    <CatchUpLine
      variant="thread"
      catchUp={catchUp}
      disabled={disabled}
      onSend={onSend}
      onHide={() => {
        setHiddenFor(conversationId);
        onHidden?.();
      }}
      className={className}
    />
  );
}
