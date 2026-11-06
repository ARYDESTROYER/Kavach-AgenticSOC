/**
 * Closing a case by hand while required runbook steps are open (Round 14, SPEC §4.10.11,
 * §4.10.15, D34): the open required steps, each with its status on a second line, and
 * the field "Why are you closing with required steps open?" (1 to 500 characters).
 *
 * The close is never blocked: the reason is recorded with the person's name on
 * `case.closed_with_open_steps` (#2). Automatic closes never look at runbook steps, and
 * nothing here reaches `decide()` or the auto-close policy (#3). Step titles are Published
 * runbook text; the reason is plain text (#9).
 */
import * as React from 'react';
import { TriangleAlert } from 'lucide-react';

import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { StatusMark } from '@/soc/runbooks/shared';

import { openStepWords, type OpenRequiredStep } from './model';

/** The longest reason a close with open steps keeps (`open_steps_reason`). */
export const OPEN_STEPS_REASON_MAX_CHARS = 500;

export const OPEN_STEPS_REASON_LABEL = 'Why are you closing with required steps open?';
export const AUTOMATIC_CLOSES_NOTE = 'Automatic closes never look at runbook steps.';

export interface OpenStepsNoticeProps {
  steps: readonly OpenRequiredStep[];
  reason: string;
  onReasonChange: (value: string) => void;
  /** False for a close that needs no reason (Mark duplicate). */
  required: boolean;
  /** The message under the field (asked after a submit without one). */
  error?: string | null;
  disabled?: boolean;
  fieldRef?: React.Ref<HTMLTextAreaElement>;
  idPrefix?: string;
}

/** True while the element's content is taller than the element (it scrolls). */
function useScrolls(ref: React.RefObject<HTMLElement | null>, contentKey: unknown): boolean {
  const [scrolls, setScrolls] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setScrolls(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, contentKey]);
  return scrolls;
}

export function OpenStepsNotice({
  steps,
  reason,
  onReasonChange,
  required,
  error = null,
  disabled = false,
  fieldRef,
  idPrefix = 'close-open-steps',
}: OpenStepsNoticeProps) {
  const listRef = React.useRef<HTMLUListElement | null>(null);
  const scrolls = useScrolls(listRef, steps.length);
  if (!steps.length) return null;
  const fieldId = `${idPrefix}-reason`;
  const helpId = `${idPrefix}-help`;
  const errorId = `${idPrefix}-error`;
  const runs = Array.from(new Set(steps.map((s) => s.runLabel).filter(Boolean)));
  const count = steps.length;
  return (
    <div className="space-y-3" data-open-steps-notice="">
      <section aria-label="Open runbook steps" className="rounded-md border border-warning/40 bg-warning/[0.06]">
        <div className="flex items-start gap-2 px-3 pt-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden />
          <div>
            <p className="text-sm font-medium text-foreground">
              {count.toLocaleString()} required runbook {count === 1 ? 'step is' : 'steps are'} still open
            </p>
            {runs.length ? <p className="text-xs text-muted-foreground">{runs.join('; ')}</p> : null}
          </div>
        </div>
        {/* A scroller with nothing focusable inside is reachable by keyboard only when it
            takes focus itself (Safari does not make scrollers focusable): it does, while
            its steps overflow. */}
        <ul
          ref={listRef}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a named scroller is the documented exception (WCAG 2.1.1)
          tabIndex={scrolls ? 0 : undefined}
          aria-label="Open required steps"
          className="mt-2 max-h-52 divide-y divide-warning/20 overflow-y-auto border-t border-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {steps.map((step) => (
            <li key={`${step.run_id}-${step.step_id}`} className="flex items-start gap-2.5 px-3 py-1.5">
              <StatusMark status={step.display} size="sm" className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-foreground [overflow-wrap:anywhere]">
                  {step.number !== null ? <span className="mr-1 tabular-nums text-muted-foreground">{step.number}</span> : null}
                  {step.title}
                </span>
                <span className="block text-xs text-muted-foreground">{openStepWords(step)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
      <div className="space-y-1.5">
        <Label htmlFor={fieldId} className="text-xs">
          {OPEN_STEPS_REASON_LABEL}
          {required ? null : <span className="font-normal text-muted-foreground"> (optional for a duplicate)</span>}
        </Label>
        <Textarea
          id={fieldId}
          ref={fieldRef}
          rows={3}
          value={reason}
          maxLength={OPEN_STEPS_REASON_MAX_CHARS}
          disabled={disabled}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={[helpId, error ? errorId : null].filter(Boolean).join(' ')}
          placeholder="For example: contained by the network team under CHG-4821; the account reset is tracked in the platform ticket."
          className="text-sm"
          onChange={(event) => onReasonChange(event.target.value)}
        />
        {error ? (
          <p id={errorId} role="alert" className="text-xs text-critical-text">
            {error}
          </p>
        ) : null}
        <p id={helpId} className="text-xs text-muted-foreground">
          Saved with your name in the case activity and the audit log. The open steps stay open in the runbook record.{' '}
          {AUTOMATIC_CLOSES_NOTE}
        </p>
      </div>
    </div>
  );
}
