/**
 * Answer feedback controls (Round 12 SYNTHESIS-chat P1-4): thumbs up / thumbs down on
 * every saved Workspace answer, an optional reason (Wrong, Incomplete, Slow, Other) and
 * comment after a thumbs down, persisted with `POST /api/chat/feedback` and shown again
 * when the thread is reopened (`feedback.ts`).
 *
 *   - Two toggle buttons with stable names and `aria-pressed` (the stored rating).
 *   - Thumbs up saves at once. Thumbs down saves at once too (a quick "no" counts even
 *     without details) and opens the reason panel under the meta row, moving focus to
 *     its first reason; Send replaces the rating with the reason and comment, Esc or
 *     Close returns focus to the thumbs-down button.
 *   - Nothing is claimed before the server accepted it: a failed save keeps the old
 *     state, says so (announcer + toast) and leaves the panel open to try again.
 *   - The panel says plainly that feedback is never used to train a model.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { ThumbsDown, ThumbsUp } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import type { ChatFeedbackReason } from '@/lib/types';
import { IconButton } from '@/soc/components/IconButton';
import { useAnnouncer } from '@/soc/components/announcer';
import { Button } from '@/ui/button';
import { CHAT_FEEDBACK_COMMENT_CHARS } from '../chat-api';
import { saveAnswerFeedback, type AnswerFeedback } from './feedback';

export const FEEDBACK_REASON_LABEL: Record<ChatFeedbackReason, string> = {
  wrong: 'Wrong',
  incomplete: 'Incomplete',
  slow: 'Slow',
  other: 'Other',
};
const REASONS: ChatFeedbackReason[] = ['wrong', 'incomplete', 'slow', 'other'];

export const FEEDBACK_SAVED = 'Thanks. Your feedback was saved.';
export const FEEDBACK_FAILED = 'Feedback could not be saved. Try again.';
export const FEEDBACK_TRAINING_NOTE = 'Feedback is kept for your team’s review. It is never used to train a model.';

export interface AnswerFeedbackState {
  /** The stored feedback (`null` = not rated). */
  value: AnswerFeedback | null;
  saving: boolean;
  panelOpen: boolean;
  rateUp: () => void;
  rateDown: () => void;
  /** Send the reason and comment (keeps the down rating). */
  sendDetails: (reason: ChatFeedbackReason | null, comment: string) => void;
  closePanel: () => void;
  /** The thumbs-down button (focus returns here when the panel closes). */
  downRef: React.RefObject<HTMLButtonElement>;
}

/** The feedback controller one answer shares between its buttons and its panel. */
export function useAnswerFeedbackControls(
  conversationId: string,
  messageId: string,
  value: AnswerFeedback | null,
): AnswerFeedbackState {
  const announce = useAnnouncer();
  const [saving, setSaving] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const downRef = React.useRef<HTMLButtonElement>(null);
  const savingRef = React.useRef(false);
  const alive = React.useRef(true);
  React.useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const save = React.useCallback(
    async (next: AnswerFeedback): Promise<boolean> => {
      if (savingRef.current) return false;
      savingRef.current = true;
      setSaving(true);
      try {
        await saveAnswerFeedback(conversationId, messageId, next);
        return true;
      } catch {
        announce(FEEDBACK_FAILED);
        toast.error(FEEDBACK_FAILED);
        return false;
      } finally {
        savingRef.current = false;
        if (alive.current) setSaving(false);
      }
    },
    [announce, conversationId, messageId],
  );

  const rateUp = React.useCallback(() => {
    if (value?.rating === 'up') return;
    setPanelOpen(false);
    void save({ rating: 'up', reason: null, comment: '' }).then((ok) => {
      if (ok) announce(FEEDBACK_SAVED);
    });
  }, [announce, save, value?.rating]);

  const rateDown = React.useCallback(() => {
    if (value?.rating === 'down') {
      setPanelOpen((open) => !open);
      return;
    }
    void save({ rating: 'down', reason: null, comment: '' }).then((ok) => {
      if (ok && alive.current) setPanelOpen(true);
    });
  }, [save, value?.rating]);

  const closePanel = React.useCallback(() => {
    setPanelOpen(false);
    downRef.current?.focus();
  }, []);

  const sendDetails = React.useCallback(
    (reason: ChatFeedbackReason | null, comment: string) => {
      void save({ rating: 'down', reason, comment }).then((ok) => {
        if (!ok) return;
        announce(FEEDBACK_SAVED);
        if (!alive.current) return;
        setPanelOpen(false);
        downRef.current?.focus();
      });
    },
    [announce, save],
  );

  return { value, saving, panelOpen, rateUp, rateDown, sendDetails, closePanel, downRef };
}

/** The two thumbs (meta-row icon actions). */
export function FeedbackButtons({ state }: { state: AnswerFeedbackState }) {
  const rating = state.value?.rating ?? null;
  return (
    <>
      <IconButton
        label="Good answer"
        size="sm"
        aria-pressed={rating === 'up'}
        aria-busy={state.saving || undefined}
        onClick={state.rateUp}
        className={cn(rating === 'up' && 'text-primary')}
        data-testid="feedback-up"
      >
        <ThumbsUp aria-hidden className={cn(rating === 'up' && 'fill-current')} />
      </IconButton>
      <IconButton
        ref={state.downRef}
        label="Bad answer"
        size="sm"
        aria-pressed={rating === 'down'}
        aria-busy={state.saving || undefined}
        onClick={state.rateDown}
        className={cn(rating === 'down' && 'text-primary')}
        data-testid="feedback-down"
      >
        <ThumbsDown aria-hidden className={cn(rating === 'down' && 'fill-current')} />
      </IconButton>
    </>
  );
}

/** The reason and comment panel under the meta row (after a thumbs down). */
export function FeedbackPanel({ state, id }: { state: AnswerFeedbackState; id: string }) {
  const [reason, setReason] = React.useState<ChatFeedbackReason | null>(state.value?.reason ?? null);
  const [comment, setComment] = React.useState(state.value?.comment ?? '');
  const firstRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    firstRef.current?.focus();
  }, []);
  const headingId = `${id}-title`;
  return (
    <div
      id={id}
      role="group"
      aria-labelledby={headingId}
      className="space-y-2 rounded-md border border-border bg-surface/50 px-3 py-2.5 text-sm"
      data-testid="feedback-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          state.closePanel();
        }
      }}
    >
      <p id={headingId} className="font-medium text-foreground">
        What went wrong?
      </p>
      <div role="group" aria-label="Reason" className="flex flex-wrap gap-1.5">
        {REASONS.map((key, index) => (
          <button
            key={key}
            ref={index === 0 ? firstRef : undefined}
            type="button"
            aria-pressed={reason === key}
            onClick={() => setReason((current) => (current === key ? null : key))}
            className={cn(
              'inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs transition-colors motion-reduce:transition-none',
              reason === key ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-card text-foreground hover:bg-muted',
              focusRing,
            )}
          >
            {FEEDBACK_REASON_LABEL[key]}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="text-xs text-muted-foreground">Comment (optional)</span>
        <textarea
          value={comment}
          maxLength={CHAT_FEEDBACK_COMMENT_CHARS}
          rows={2}
          onChange={(event) => setComment(event.target.value)}
          className={cn(
            'mt-1 block w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground',
            focusRing,
          )}
          placeholder="What should the answer have said?"
        />
      </label>
      <p className="text-2xs text-muted-foreground">{FEEDBACK_TRAINING_NOTE}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" className="h-7" disabled={state.saving} onClick={() => state.sendDetails(reason, comment)}>
          Send
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={state.closePanel}>
          Close
        </Button>
      </div>
    </div>
  );
}
