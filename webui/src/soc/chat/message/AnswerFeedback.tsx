/**
 * Answer feedback controls (Round 12 SYNTHESIS-chat P1-4): thumbs up / thumbs down on
 * every saved Workspace answer, an optional reason (Wrong, Incomplete, Slow, Other) and
 * comment after a thumbs down, persisted with `POST /api/chat/feedback` and shown again
 * when the thread is reopened (`feedback.ts`).
 *
 *   - A single-choice pair: `role="radiogroup"` "Rate this answer" with two `role="radio"`
 *     thumbs (`aria-checked` = the stored rating, one tab stop, arrow keys move between
 *     them). A rating can be changed but not withdrawn (the feedback route has no
 *     delete), so the pair never claims toggle semantics it cannot honour: activating
 *     the checked thumb again does nothing, exactly as a checked radio does.
 *   - Thumbs up saves at once. Thumbs down saves at once too (a quick "no" counts even
 *     without details) and opens the reason panel under the meta row, scrolling the
 *     whole panel clear of the transcript's bottom band and moving focus to its first
 *     reason. The panel is a disclosure of its own: an "Add details" button
 *     (`aria-expanded`, `aria-controls`) beside a down rating opens and closes it; Send
 *     replaces the rating with the reason and comment, Esc or Close returns focus there.
 *   - Nothing is claimed before the server accepted it: a failed save keeps the old
 *     state, says so (announcer + toast) and leaves the panel open to try again.
 *   - The panel says plainly that feedback is never used to train a model.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { MessageSquareText, ThumbsDown, ThumbsUp } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import type { ChatFeedbackReason } from '@/lib/types';
import { IconButton } from '@/soc/components/IconButton';
import { useAnnouncer } from '@/soc/components/announcer';
import { Button } from '@/ui/button';
import { CHAT_FEEDBACK_COMMENT_CHARS } from '../chat-api';
import { saveAnswerFeedback, type AnswerFeedback } from './feedback';
import { REVEAL_SCROLL_MARGIN, revealAndFocus } from './reveal';

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
/** The disclosure that opens the reason panel of a down rating (a stable name). */
export const FEEDBACK_DETAILS_LABEL = 'Add details';

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
  /** Open or close the reason panel of a down rating ("Add details"). */
  toggleDetails: () => void;
  /** The thumbs-down radio. */
  downRef: React.RefObject<HTMLButtonElement>;
  /** The "Add details" disclosure (focus returns here when the panel closes). */
  detailsRef: React.RefObject<HTMLButtonElement>;
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
  const detailsRef = React.useRef<HTMLButtonElement>(null);
  const savingRef = React.useRef(false);
  const alive = React.useRef(true);
  React.useEffect(() => {
    // Set on every mount: StrictMode mounts, unmounts and mounts again.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

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

  // A checked radio does nothing when activated again (a rating cannot be withdrawn).
  const rateDown = React.useCallback(() => {
    if (value?.rating === 'down') return;
    void save({ rating: 'down', reason: null, comment: '' }).then((ok) => {
      if (ok && alive.current) setPanelOpen(true);
    });
  }, [save, value?.rating]);

  /** Focus after the panel closes: its disclosure, else the thumbs-down radio. */
  const focusAfterPanel = React.useCallback(() => {
    // The disclosure renders with the down rating; on the frame the panel closes it is
    // already there, so no timer is needed.
    (detailsRef.current ?? downRef.current)?.focus();
  }, []);

  const closePanel = React.useCallback(() => {
    setPanelOpen(false);
    focusAfterPanel();
  }, [focusAfterPanel]);

  const toggleDetails = React.useCallback(() => setPanelOpen((open) => !open), []);

  const sendDetails = React.useCallback(
    (reason: ChatFeedbackReason | null, comment: string) => {
      void save({ rating: 'down', reason, comment }).then((ok) => {
        if (!ok) return;
        announce(FEEDBACK_SAVED);
        if (!alive.current) return;
        setPanelOpen(false);
        focusAfterPanel();
      });
    },
    [announce, focusAfterPanel, save],
  );

  return { value, saving, panelOpen, rateUp, rateDown, sendDetails, closePanel, toggleDetails, downRef, detailsRef };
}

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/**
 * The two thumbs (meta-row icon actions) as one single-choice group, plus the "Add
 * details" disclosure beside a down rating. `panelId` is the reason panel's id.
 */
export function FeedbackButtons({ state, panelId }: { state: AnswerFeedbackState; panelId: string }) {
  const rating = state.value?.rating ?? null;
  const upRef = React.useRef<HTMLButtonElement>(null);
  // One tab stop: the checked thumb, else the first.
  const tabStop = rating === 'down' ? 'down' : 'up';
  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- the radios inside take focus (roving tab stop) */}
      <div
        role="radiogroup"
        aria-label="Rate this answer"
        className="inline-flex items-center gap-0.5"
        data-testid="feedback-rating"
        onKeyDown={(event) => {
          if (!ARROWS.has(event.key)) return;
          // Arrows move between the two thumbs; Space or Enter rates (a rating is saved,
          // so it is never chosen just by moving focus).
          event.preventDefault();
          (event.target === upRef.current ? state.downRef.current : upRef.current)?.focus();
        }}
      >
        <IconButton
          ref={upRef}
          role="radio"
          aria-checked={rating === 'up'}
          tabIndex={tabStop === 'up' ? 0 : -1}
          label="Good answer"
          size="sm"
          aria-busy={state.saving || undefined}
          onClick={state.rateUp}
          className={cn(rating === 'up' && 'text-primary')}
          data-testid="feedback-up"
        >
          <ThumbsUp aria-hidden className={cn(rating === 'up' && 'fill-current')} />
        </IconButton>
        <IconButton
          ref={state.downRef}
          role="radio"
          aria-checked={rating === 'down'}
          tabIndex={tabStop === 'down' ? 0 : -1}
          label="Bad answer"
          size="sm"
          aria-busy={state.saving || undefined}
          onClick={state.rateDown}
          className={cn(rating === 'down' && 'text-primary')}
          data-testid="feedback-down"
        >
          <ThumbsDown aria-hidden className={cn(rating === 'down' && 'fill-current')} />
        </IconButton>
      </div>
      {rating === 'down' ? (
        <IconButton
          ref={state.detailsRef}
          label={FEEDBACK_DETAILS_LABEL}
          size="sm"
          aria-expanded={state.panelOpen}
          aria-controls={state.panelOpen ? panelId : undefined}
          onClick={state.toggleDetails}
          className={cn(state.panelOpen && 'text-primary')}
          data-testid="feedback-details"
        >
          <MessageSquareText aria-hidden />
        </IconButton>
      ) : null}
    </>
  );
}

/** The reason and comment panel under the meta row (after a thumbs down). */
export function FeedbackPanel({ state, id }: { state: AnswerFeedbackState; id: string }) {
  const [reason, setReason] = React.useState<ChatFeedbackReason | null>(state.value?.reason ?? null);
  const [comment, setComment] = React.useState(state.value?.comment ?? '');
  const firstRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    // The panel opens under the latest answer, usually below the visible area: bring all
    // of it clear of the transcript's bottom band, then focus its first reason.
    revealAndFocus(panelRef.current, firstRef.current);
  }, []);
  const headingId = `${id}-title`;
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc closes the panel from any of its fields
    <div
      ref={panelRef}
      id={id}
      role="group"
      aria-labelledby={headingId}
      className={cn('space-y-2 rounded-md border border-border bg-surface/50 px-3 py-2.5 text-sm', REVEAL_SCROLL_MARGIN)}
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
