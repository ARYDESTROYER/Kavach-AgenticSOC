/**
 * StepInspector — open any lookup from the run log (Round 12 SYNTHESIS-chat P1-1): what
 * was sent (its parameters and the exact query), what came back (the stored observation
 * the model saw, read through `GET …/steps/{index}`), its time, rows and tokens.
 *
 *   - #9: everything that came back is untrusted. The observation renders ONLY as text
 *     in a code block (`CodeBlock` takes text children), never as markup or a link; the
 *     model- or log-derived parameter values are mono text marked "untrusted".
 *   - #7: the observation is the aggregate the model saw, never raw log rows (the route
 *     stores and returns only that).
 *   - "Retry step" asks again in a new turn (`origin: "retry_step"`), offered for a
 *     lookup that failed, timed out, was stopped or skipped; "Explain this step" is a
 *     follow-up. Neither puts a parameter VALUE into the question: the model reads the
 *     step from its own history, so log-derived text never becomes the analyst's words.
 *   - A side sheet (a parallel task: the conversation stays where it was); focus returns
 *     to the row's Inspect button when it closes.
 */
import * as React from 'react';
import { MessageCircleQuestion, RotateCcw } from 'lucide-react';

import { cn } from '@/lib/cn';
import { LoadingState } from '@/design-system/loading';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { Button } from '@/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/ui/sheet';
import { apiErrorCode, getStepObservation, isSafeChatId, type ChatStepObservation } from '../chat-api';
import { compactTokens, formatDuration, paramKeyLabel, paramValue, STEP_STATUS_LABEL, BASIS_LABEL } from './format';
import type { RunLogStep } from './RunLog';

/** Statuses a "Retry step" can help with. */
const RETRYABLE = new Set(['error', 'timeout', 'cancelled', 'skipped']);

/** The question "Retry step" sends (engine words only, no parameter values). */
export function retryStepQuestion(step: Pick<RunLogStep, 'index' | 'label'>): string {
  return `Run step ${step.index} (${step.label}) again with the same inputs and update the answer.`;
}

/** The follow-up "Explain this step" sends. */
export function explainStepQuestion(step: Pick<RunLogStep, 'index' | 'label'>): string {
  return `Explain step ${step.index} (${step.label}): what it looked up, what it found and how it shaped the answer.`;
}

/** Why the stored result cannot be shown, from the route's error code. */
export function observationErrorMessage(code: string | null): string {
  switch (code) {
    case 'step_observation_expired':
      return 'This lookup’s result is no longer stored. Results are kept for your most recent answers.';
    case 'step_observation_unavailable':
      return 'No result was stored for this lookup.';
    case 'step_not_found':
    case 'message_not_found':
      return 'This lookup is not part of a saved answer.';
    default:
      return 'The stored result could not be loaded.';
  }
}

type Load =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; data: ChatStepObservation }
  | { state: 'error'; message: string; retryable: boolean };

export interface StepInspectorProps {
  step: RunLogStep | null;
  /** The saved answer this step belongs to (Workspace); `null` = nothing stored to read. */
  conversationId: string | null;
  messageId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Focus target when the sheet closes (the row's Inspect button). */
  returnFocus?: () => HTMLElement | null;
  /** Ask in a new turn (`origin` decides the taint class). */
  onAsk?: ((question: string, origin: 'retry_step' | 'follow_up') => boolean) | null;
  /** An answer is being written in this thread. */
  busy?: boolean;
}

function Field({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-3 gap-y-0.5 text-sm">
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

/** "≈ 1.2k tokens" for a stored observation (chars ÷ 4, the console's usual estimate). */
function observationTokens(observation: Record<string, unknown>): string | null {
  try {
    const size = JSON.stringify(observation).length;
    return size > 2 ? `≈ ${compactTokens(Math.ceil(size / 4))} tokens` : null;
  } catch {
    return null;
  }
}

export function StepInspector({ step, conversationId, messageId, onOpenChange, returnFocus, onAsk = null, busy = false }: StepInspectorProps) {
  const open = step !== null;
  const result = step?.result ?? null;
  const ref = result?.observation_ref ?? null;
  const readable = !!ref && isSafeChatId(conversationId) && isSafeChatId(messageId);
  const [load, setLoad] = React.useState<Load>({ state: 'idle' });
  const [attempt, setAttempt] = React.useState(0);
  const index = step?.index ?? null;

  React.useEffect(() => {
    if (!open || index === null || !readable || !conversationId || !messageId) {
      setLoad({ state: 'idle' });
      return undefined;
    }
    const controller = new AbortController();
    setLoad({ state: 'loading' });
    getStepObservation(conversationId, messageId, index, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setLoad({ state: 'ready', data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const code = apiErrorCode(error);
        setLoad({
          state: 'error',
          message: observationErrorMessage(code),
          retryable: code !== 'step_observation_expired' && code !== 'step_observation_unavailable' && code !== 'step_not_found',
        });
      });
    return () => controller.abort();
  }, [attempt, conversationId, index, messageId, open, readable]);

  const params = Object.entries(result?.params ?? step?.params ?? {});
  const untrusted = Object.entries(result?.untrusted_params ?? {});
  const status = step ? STEP_STATUS_LABEL[step.status] : '';
  const duration = result && step?.status !== 'running' ? formatDuration(result.duration_ms) : null;
  const rows =
    typeof result?.rows === 'number'
      ? `${result.rows.toLocaleString()} ${result.rows === 1 ? 'row' : 'rows'}${result.basis ? ` (${BASIS_LABEL[result.basis]})` : ''}`
      : null;
  const usage = result?.usage ?? null;
  const embedding = usage?.embedding_tokens ? `${compactTokens(usage.embedding_tokens)} embedding tokens` : null;
  const canRetry = !!step && RETRYABLE.has(step.status) && !!onAsk;
  const ask = (question: string, origin: 'retry_step' | 'follow_up') => {
    if (!onAsk) return;
    if (onAsk(question, origin)) onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        size="lg"
        className="flex flex-col gap-0 p-0"
        onCloseAutoFocus={(event) => {
          const target = returnFocus?.();
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
        data-testid="step-inspector"
      >
        {step ? (
          <>
            <SheetHeader className="p-5 pr-14">
              <SheetTitle className="text-base">
                Step {step.index}: {step.label}
              </SheetTitle>
              <SheetDescription>
                {[status, duration, rows ?? result?.coverage ?? null].filter(Boolean).join(' · ')}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              <section aria-labelledby="step-inspector-sent" className="space-y-2">
                <h3 id="step-inspector-sent" className="text-sm font-semibold text-foreground">
                  What was sent
                </h3>
                <dl className="space-y-1">
                  {step.tool ? (
                    <Field name="Lookup">
                      <span className="font-mono text-xs">{step.tool}</span>
                    </Field>
                  ) : null}
                  {params.map(([key, value]) => (
                    <Field key={key} name={paramKeyLabel(key)}>
                      {paramValue(value, key)}
                    </Field>
                  ))}
                  {untrusted.map(([key, value]) => (
                    <Field key={`u-${key}`} name={paramKeyLabel(key)}>
                      <span className="font-mono text-xs">{value}</span>{' '}
                      <span className="text-2xs text-muted-foreground">untrusted</span>
                    </Field>
                  ))}
                  {!params.length && !untrusted.length && !step.tool ? <p className="text-sm text-muted-foreground">No parameters.</p> : null}
                </dl>
                {result?.query ? (
                  <CodeBlock value={result.query} caption="Query as run · untrusted text" wrap maxHeightClassName="max-h-48" />
                ) : null}
              </section>

              <section aria-labelledby="step-inspector-cost" className="space-y-2">
                <h3 id="step-inspector-cost" className="text-sm font-semibold text-foreground">
                  Time, rows and tokens
                </h3>
                <dl className="space-y-1">
                  <Field name="Status">{status}</Field>
                  {duration ? <Field name="Time">{duration}</Field> : null}
                  {rows ? <Field name="Rows">{rows}</Field> : null}
                  {result?.coverage ? <Field name="Coverage">{result.coverage}</Field> : null}
                  {result?.sources?.length ? <Field name="Sources">{result.sources.join(', ')}</Field> : null}
                  <Field name="Tokens">
                    {embedding ?? 'No model tokens (a lookup does not call the model)'}
                    {load.state === 'ready' && observationTokens(load.data.observation) ? (
                      <span className="block text-xs text-muted-foreground">
                        Its result added {observationTokens(load.data.observation)} to the model’s input
                      </span>
                    ) : null}
                  </Field>
                </dl>
              </section>

              <section aria-labelledby="step-inspector-saw" className="space-y-2">
                <h3 id="step-inspector-saw" className="text-sm font-semibold text-foreground">
                  What the model saw
                </h3>
                {result?.summary ? <p className="text-sm text-muted-foreground">{result.summary}</p> : null}
                {!readable ? (
                  <p className="text-sm text-muted-foreground">
                    {ref
                      ? 'The stored result is available once the answer is saved.'
                      : 'No result was stored for this lookup.'}
                  </p>
                ) : load.state === 'loading' || load.state === 'idle' ? (
                  <LoadingState label="Loading the stored result" layout="inline" />
                ) : load.state === 'error' ? (
                  <div className="space-y-2" role="note">
                    <p className="text-sm text-muted-foreground">{load.message}</p>
                    {load.retryable ? (
                      <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => setAttempt((n) => n + 1)}>
                        <RotateCcw aria-hidden />
                        Try again
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <CodeBlock
                      value={load.data.observation}
                      caption="Stored result · untrusted text"
                      wrap
                      maxHeightClassName="max-h-[50dvh]"
                      data-testid="step-inspector-observation"
                    />
                    {load.data.truncated ? (
                      <p className="text-xs text-muted-foreground">Shortened to fit storage; the model saw the same shortened copy.</p>
                    ) : null}
                  </>
                )}
              </section>
            </div>
            {onAsk ? (
              <SheetFooter className={cn('gap-2 p-4 sm:justify-start')}>
                {canRetry ? (
                  <Button type="button" size="sm" disabled={busy} onClick={() => ask(retryStepQuestion(step), 'retry_step')}>
                    <RotateCcw aria-hidden />
                    Retry step
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant={canRetry ? 'outline' : 'default'}
                  disabled={busy}
                  onClick={() => ask(explainStepQuestion(step), 'follow_up')}
                >
                  <MessageCircleQuestion aria-hidden />
                  Explain this step
                </Button>
                {busy ? <p className="self-center text-xs text-muted-foreground">Available once the current answer is ready.</p> : null}
              </SheetFooter>
            ) : null}
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
