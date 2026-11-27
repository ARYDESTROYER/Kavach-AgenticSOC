/**
 * The chat activity glyph (Round 12, SPEC D13): a small ring that turns while an
 * answer is being written, an accent dot for an unread answer, amber when a question
 * waits on the analyst and red when an answer failed. Entry-safe (React + the store).
 *
 * The glyph itself is decorative (`aria-hidden`); hosts carry the meaning in text
 * through `aria-describedby` (the snapshot's precomputed `ChatActivitySummary.text`).
 * Titles in that text are prompt- or model-derived and are only ever rendered as text
 * nodes (#9).
 */
import '@/styles/activity.css';
import { cn } from '@/lib/cn';
import { useChatActivity, type ChatActivityStatus } from './store';

/**
 * One small mark (`.chat-activity` in `styles/activity.css`): a turning quarter arc
 * while an answer is being written (still under reduced motion), an accent dot for an
 * unread answer, amber when a question waits on the analyst, red when one failed.
 */
export function ActivityGlyph({ status, className }: { status: ChatActivityStatus | null; className?: string }) {
  return status ? <span aria-hidden="true" data-activity={status} className={cn('chat-activity', className)} /> : null;
}

/**
 * The thin ring that turns around the brand tile while any answer is being written
 * (`ChatAgentConfig.animated_brand`). Only the ring moves: an operator's logo is never
 * animated. Decorative; the navigation glyph carries the accessible state.
 */
export function BrandActivityRing() {
  const turning = useChatActivity((snapshot) => snapshot.animatedBrand && snapshot.all.status === 'running');
  return turning ? <span aria-hidden="true" className="chat-brand-ring" /> : null;
}
