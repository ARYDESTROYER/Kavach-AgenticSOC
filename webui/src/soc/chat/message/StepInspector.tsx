/**
 * StepInspector — open any lookup from the run log (Round 12 SYNTHESIS-chat P1-1): what
 * was sent (its parameters and the exact query), what came back (the stored observation
 * the model saw, read through `GET …/steps/{index}`), its time, rows and tokens.
 *
 *   - #9: everything that came back is untrusted. The observation renders ONLY as text
 *     in a code block (`CodeBlock` takes text children), never as markup or a link; the
 *     model- or log-derived parameter values are mono text marked "untrusted". In both
 *     halves ("What was sent": untrusted inputs and the query as run; "What the model
 *     saw": the observation) invisible and bidi characters are written as visible
 *     `\uXXXX` escapes (`visibleText`, `visibleJson`), as the model read them, so
 *     "admin" + ZWSP never looks like "admin" and a right-to-left override never
 *     reorders what the analyst reads or copies.
 *   - #7: the observation is the aggregate the model saw, never raw log rows (the route
 *     stores and returns only that).
 *   - "Retry step" asks again in a new turn (`origin: "retry_step"`), offered for a
 *     lookup that failed, timed out, was stopped or skipped; "Explain this step" is a
 *     follow-up. Neither puts a parameter VALUE into the question: the model reads the
 *     step from its own history. Step numbers restart in every answer, so the question
 *     names WHICH answer by quoting the analyst's question it replied to, and by its
 *     recency when several answers replied to the same question ("your second most
 *     recent answer to …", `answerRecencies`); both origins are in the follow_up taint
 *     class (#9), so a quoted chip question stays untrusted.
 *   - A side sheet (a parallel task: the conversation stays where it was). It opens on
 *     its title, never on an action that sends a turn; focus returns to the row's
 *     Inspect button when it closes.
 *   - Round 13 (SPEC-chat T14, T28): the status and time are said ONCE, in the header; the
 *     lookup reads as its catalogue label ("Read SOC metrics"), the tool id only in its
 *     tooltip; "Explain this step" and "Retry step" are secondary buttons (no filled
 *     primary in the chat); the query and the stored result keep their lines and scroll
 *     sideways instead of wrapping JSON mid-key on a phone.
 */
import * as React from 'react';
import { MessageCircleQuestion, RotateCcw } from 'lucide-react';

import { cn } from '@/lib/cn';
import { LoadingState } from '@/design-system/loading';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { Button } from '@/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/ui/sheet';
import { apiErrorCode, getStepObservation, isSafeChatId, type ChatStepObservation } from '../chat-api';
import { CAPABILITY_LABELS } from '../composer/access-copy';
import { displayText, INVISIBLE_TEXT_CLASS } from '../stream-events';
import { compactTokens, formatDuration, paramKeyLabel, paramValue, STEP_STATUS_LABEL, BASIS_LABEL, windowLabel } from './format';
import type { RunLogStep } from './RunLog';

/** A lookup's tool as the access list names it ("soc_metrics" → "Read SOC metrics"); else the id. */
export function lookupLabel(tool: string): string {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_LABELS, tool) ? CAPABILITY_LABELS[tool] : tool;
}

/** Statuses a "Retry step" can help with. */
const RETRYABLE = new Set(['error', 'timeout', 'cancelled', 'skipped']);

/** A window the engine validated ("this_week", "now-90d", "all"), as words, else null. */
function stepWindow(step: Pick<RunLogStep, 'params' | 'result'>): string | null {
  const raw = (step.result?.params ?? step.params)?.window;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_:./+-]{1,64}$/.test(raw)) return null;
  return windowLabel(raw);
}

/** The longest quote of the answer's question a step question carries. */
const QUESTION_QUOTE_CHARS = 120;

/** The quote a step question names its answer by: display-normalised, one line, bounded. */
export function answerQuote(question: string | null | undefined): string {
  return displayText(question ?? '', QUESTION_QUOTE_CHARS);
}

/**
 * For each answer of a thread (the question it replied to, `null` for none), how recent it
 * is among the answers whose question QUOTES the same (`answerQuote`): 0 when the quote is
 * unique or unknown, 1 for the latest of several, 2 for the one before it, and so on.
 * "Ask again", a repeated follow-up chip or clarify pick asks the identical question, and
 * the quote alone would then name the wrong answer. Counted from the newest, so older
 * answers that are not loaded, or that the model reads only as a summary, never shift it.
 */
export function answerRecencies(questions: ReadonlyArray<string | null | undefined>): number[] {
  const quotes = questions.map((question) => answerQuote(question));
  const totals = new Map<string, number>();
  for (const quote of quotes) if (quote) totals.set(quote, (totals.get(quote) ?? 0) + 1);
  const ranks = new Map<string, number>();
  const out = quotes.map(() => 0);
  for (let i = quotes.length - 1; i >= 0; i -= 1) {
    const quote = quotes[i];
    if (!quote || (totals.get(quote) ?? 0) < 2) continue;
    const rank = (ranks.get(quote) ?? 0) + 1;
    ranks.set(quote, rank);
    out[i] = rank;
  }
  return out;
}

const RECENCY_WORDS = ['', 'latest', 'second most recent', 'third most recent', 'fourth most recent', 'fifth most recent'];

/** "latest", "second most recent" … "12th most recent" (`answerRecencies` ranks). */
export function recencyWords(rank: number): string {
  if (!Number.isInteger(rank) || rank < 1) return '';
  if (rank < RECENCY_WORDS.length) return RECENCY_WORDS[rank];
  const tens = rank % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][rank % 10] ?? 'th');
  return `${rank}${suffix} most recent`;
}

/**
 * " of your answer to “…”": which answer the step belongs to. Step numbers restart in
 * every answer (most lookups are step 2), so without it "explain step 2" from an older
 * answer reads as the latest answer's step 2. When several answers replied to the same
 * question, `recency` (an `answerRecencies` rank) names which one: " of your second most
 * recent answer to “…”". Empty when the question is unknown.
 */
function ofAnswer(question: string | null | undefined, recency = 0): string {
  const quote = answerQuote(question);
  if (!quote) return '';
  const which = recencyWords(recency);
  return ` of your ${which ? `${which} ` : ''}answer to “${quote}”`;
}

/**
 * The question "Retry step" sends: engine words only (the step's template label and its
 * validated window) plus the analyst's own question that answer replied to, never a
 * free-text parameter value, so log-derived text never becomes the analyst's words (#9).
 */
export function retryStepQuestion(
  step: Pick<RunLogStep, 'index' | 'label' | 'params' | 'result'>,
  question?: string | null,
  recency = 0,
): string {
  const window = stepWindow(step);
  return `Run step ${step.index} (${step.label})${ofAnswer(question, recency)} again${window ? ` for ${window}` : ''} with the same inputs and update the answer.`;
}

/** The follow-up "Explain this step" sends (naming its answer, as above). */
export function explainStepQuestion(
  step: Pick<RunLogStep, 'index' | 'label'>,
  question?: string | null,
  recency = 0,
): string {
  return `Explain step ${step.index} (${step.label})${ofAnswer(question, recency)}: what it looked up, what it found and how it shaped the answer.`;
}

const INVISIBLE_GLOBAL = new RegExp(`[${INVISIBLE_TEXT_CLASS}]`, 'gu');
// With the `u` flag this matches only an UNPAIRED surrogate half.
const LONE_SURROGATE_GLOBAL = /[\uD800-\uDFFF]/gu;

/** `\uXXXX` for one character; an astral one as its surrogate pair, as `ensure_ascii` writes it. */
function escapeChar(char: string): string {
  let out = '';
  for (let i = 0; i < char.length; i += 1) out += `\\u${char.charCodeAt(i).toString(16).padStart(4, '0')}`;
  return out;
}

/**
 * `text` with every invisible, bidi, tag and control character (the backend
 * `INVISIBLE_TEXT_RANGES`) and every lone surrogate written as a visible `\uXXXX`
 * escape. The backend already sends a step's untrusted inputs and query in this form
 * (`visible_display_text`); escaping again here is a no-op for that ASCII text and keeps
 * "What was sent" exact even if a raw character ever reached it.
 */
export function visibleText(text: string): string {
  return text.replace(LONE_SURROGATE_GLOBAL, escapeChar).replace(INVISIBLE_GLOBAL, escapeChar);
}

/**
 * The stored observation as the text the analyst reads and copies: indented JSON with
 * every invisible character written as a visible JSON escape (`visibleText`). The model
 * read the same value through `fence_block`'s `ensure_ascii` serialisation, so the panel
 * shows what the model saw, the JSON stays valid (same value), and no override can
 * reorder the text.
 */
export function visibleJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
  return visibleText(text);
}

/** A run of at least this many `null` points is shown as one "null × N" entry. */
const NULL_RUN = 3;
/** An object of plain values this short sits on one line in the compact view. */
const INLINE_OBJECT_CHARS = 100;
/** The compact view is offered only for a result this long that it shortens by a quarter. */
const COMPACT_MIN_LINES = 16;
const lineCount = (text: string): number => text.split('\n').length;

const isScalar = (v: unknown): boolean =>
  v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string';

function scalarJson(v: unknown): string {
  return JSON.stringify(v) ?? 'null';
}

/** A list of plain values on one line, each run of not-measured points counted once. */
function inlineArray(items: unknown[]): string {
  const parts: string[] = [];
  for (let i = 0; i < items.length; ) {
    if (items[i] === null) {
      let end = i;
      while (end < items.length && items[end] === null) end += 1;
      if (end - i >= NULL_RUN) {
        parts.push(`null × ${end - i} (not measured)`);
        i = end;
        continue;
      }
    }
    parts.push(scalarJson(items[i]));
    i += 1;
  }
  return `[${parts.join(', ')}]`;
}

function compactValue(value: unknown, indent: string): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every(isScalar)) return inlineArray(value);
    return `[\n${value.map((v) => inner + compactValue(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (!entries.length) return '{}';
    if (entries.every(([, v]) => isScalar(v))) {
      const line = `{ ${entries.map(([k, v]) => `${scalarJson(k)}: ${scalarJson(v)}`).join(', ')} }`;
      if (line.length <= INLINE_OBJECT_CHARS) return line;
    }
    return `{\n${entries.map(([k, v]) => `${inner}${scalarJson(k)}: ${compactValue(v, inner)}`).join(',\n')}\n${indent}}`;
  }
  return scalarJson(value);
}

/**
 * The stored observation as a compact READING view: a list of plain values sits on one
 * line, a run of not-measured points reads "null × 30 (not measured)" instead of thirty
 * lines of `null`, and a short object of plain values sits on one line. Every value is
 * still there, with the same escapes as {@link visibleJson}; the exact JSON stays one
 * click away and is what Copy takes.
 */
export function compactJson(value: unknown): string {
  try {
    return visibleText(compactValue(value, ''));
  } catch {
    return '';
  }
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
  /** The step to show (kept while the sheet animates closed). */
  step: RunLogStep;
  open: boolean;
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
  /** The analyst's question this answer replied to (names the answer in a step question). */
  question?: string | null;
  /** Which of several answers to the same question this is (`answerRecencies`; 0 = unique). */
  questionRecency?: number;
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

/**
 * How much the result added to the model's input. A copy shortened for storage is
 * smaller than what the model read, so its size is only a lower bound and says so.
 */
export function observationTokensLine(observation: Record<string, unknown>, truncated: boolean): string | null {
  const tokens = observationTokens(observation);
  if (!tokens) return null;
  return truncated
    ? `This stored copy is ${tokens}; the result the model read was larger`
    : `Its result added ${tokens} to the model’s input`;
}

/** The line under a stored copy that was cut to fit storage (the model read all of it). */
export const OBSERVATION_TRUNCATED_NOTE = 'Shortened to fit storage. The model saw the full result; this copy is cut.';

/**
 * "What the model saw": the compact view first (long runs of not-measured points
 * counted, short lists on one line), with a toggle to the exact stored JSON. Copy always
 * takes the exact JSON, so nothing read in the compact view is ever pasted as data.
 */
function ObservationView({ observation }: { observation: Record<string, unknown> }) {
  const exactText = React.useMemo(() => visibleJson(observation), [observation]);
  const compactText = React.useMemo(() => compactJson(observation), [observation]);
  // A short result reads fine as it is: no second view to choose between.
  const canCompact =
    compactText !== '' &&
    lineCount(exactText) >= COMPACT_MIN_LINES &&
    lineCount(compactText) <= lineCount(exactText) * 0.75;
  const [exact, setExact] = React.useState(false);
  const blockId = React.useId();
  const showExact = exact || !canCompact;
  return (
    <div className="space-y-1.5">
      {canCompact ? (
        // Above the result, so the reader knows which view this is before reading it.
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="text-xs text-muted-foreground" data-testid="step-inspector-view-note">
            {exact
              ? 'The exact JSON the lookup stored.'
              : 'Compact view: runs of null (not measured) are counted. Copy takes the exact result.'}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            aria-controls={blockId}
            onClick={() => setExact((value) => !value)}
          >
            {exact ? 'Show compact view' : 'Show exact result'}
          </Button>
        </div>
      ) : null}
      <CodeBlock
        id={blockId}
        value={showExact ? exactText : compactText}
        copyValue={exactText}
        caption="Stored result · untrusted text"
        // JSON keeps its lines and scrolls sideways; it never wraps mid-key (T28).
        wrap={false}
        maxHeightClassName="max-h-[50dvh]"
        data-testid="step-inspector-observation"
        data-view={showExact ? 'exact' : 'compact'}
      />
    </div>
  );
}

export function StepInspector({
  step,
  open,
  conversationId,
  messageId,
  onOpenChange,
  returnFocus,
  onAsk = null,
  busy = false,
  question = null,
  questionRecency = 0,
}: StepInspectorProps) {
  const result = step.result ?? null;
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const ref = result?.observation_ref ?? null;
  const readable = !!ref && isSafeChatId(conversationId) && isSafeChatId(messageId);
  const [load, setLoad] = React.useState<Load>({ state: 'idle' });
  const [attempt, setAttempt] = React.useState(0);
  const index = step.index;
  // A question asked from the sheet is sent once it has closed, so the host can hand
  // focus to the composer (the sheet would otherwise return it to the Inspect button).
  const pending = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    if (!open || !readable || !conversationId || !messageId) {
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

  const untrustedMap = result?.untrusted_params ?? {};
  const untrusted = Object.entries(untrustedMap);
  // Most tools put the same input in both maps: a key shown as untrusted text is shown
  // ONCE (as in the run log), never also as a plain value that reads as applied twice.
  const params = Object.entries(result?.params ?? step.params ?? {}).filter(
    ([key]) => !Object.prototype.hasOwnProperty.call(untrustedMap, key),
  );
  const status = STEP_STATUS_LABEL[step.status];
  const duration = result && step.status !== 'running' ? formatDuration(result.duration_ms) : null;
  const rows =
    typeof result?.rows === 'number'
      ? `${result.rows.toLocaleString()} ${result.rows === 1 ? 'row' : 'rows'}${result.basis ? ` (${BASIS_LABEL[result.basis]})` : ''}`
      : null;
  const usage = result?.usage ?? null;
  const embedding = usage?.embedding_tokens ? `${compactTokens(usage.embedding_tokens)} embedding tokens` : null;
  const canRetry = RETRYABLE.has(step.status) && !!onAsk;
  const ask = (question: string, origin: 'retry_step' | 'follow_up') => {
    if (!onAsk || busy) return;
    pending.current = () => {
      onAsk(question, origin);
    };
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        size="lg"
        className="flex flex-col gap-0 p-0"
        // Open on the step's name, never on a footer action that sends a (billed) turn:
        // a screen-reader user hears what opened first, and a repeated Enter is harmless.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const send = pending.current;
          pending.current = null;
          if (send) {
            // The host moves focus to the composer as it sends.
            event.preventDefault();
            send();
            return;
          }
          const target = returnFocus?.();
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
        data-testid="step-inspector"
      >
        {(
          <>
            <SheetHeader className="p-5 pr-14">
              <SheetTitle
                ref={titleRef}
                tabIndex={-1}
                className="-mx-1 rounded-sm px-1 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="step-inspector-title"
              >
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
                      <span data-testid="step-inspector-lookup">{lookupLabel(step.tool)}</span>
                      {lookupLabel(step.tool) !== step.tool ? (
                        // The tool's id stays visible for an administrator (never only a tooltip).
                        <span className="ml-1.5 font-mono text-2xs text-muted-foreground" data-testid="step-inspector-tool-id">
                          ({step.tool})
                        </span>
                      ) : null}
                    </Field>
                  ) : null}
                  {params.map(([key, value]) => (
                    <Field key={key} name={paramKeyLabel(key)}>
                      {paramValue(value, key)}
                    </Field>
                  ))}
                  {untrusted.map(([key, value]) => (
                    <Field key={`u-${key}`} name={paramKeyLabel(key)}>
                      <span className="font-mono text-xs" data-testid="step-inspector-untrusted">
                        {visibleText(value)}
                      </span>{' '}
                      <span className="text-2xs text-muted-foreground">untrusted</span>
                    </Field>
                  ))}
                  {!params.length && !untrusted.length && !step.tool ? <p className="text-sm text-muted-foreground">No parameters.</p> : null}
                </dl>
                {result?.query ? (
                  <CodeBlock
                    value={visibleText(result.query)}
                    caption="Query as run · untrusted text"
                    // Lines keep their shape and scroll sideways (T28).
                    wrap={false}
                    maxHeightClassName="max-h-48"
                    data-testid="step-inspector-query"
                  />
                ) : null}
              </section>

              <section aria-labelledby="step-inspector-cost" className="space-y-2">
                <h3 id="step-inspector-cost" className="text-sm font-semibold text-foreground">
                  {result?.sources?.length ? 'Sources and tokens' : rows && result?.coverage ? 'Coverage and tokens' : 'Tokens'}
                </h3>
                <dl className="space-y-1">
                  {/* The status, time and rows are in the header (one status line, T28). */}
                  {rows && result?.coverage ? <Field name="Coverage">{result.coverage}</Field> : null}
                  {result?.sources?.length ? <Field name="Sources">{result.sources.join(', ')}</Field> : null}
                  <Field name="Tokens">
                    {embedding ?? 'No model tokens (a lookup does not call the model)'}
                    {load.state === 'ready' && observationTokensLine(load.data.observation, load.data.truncated) ? (
                      <span className="block text-xs text-muted-foreground" data-testid="step-inspector-tokens">
                        {observationTokensLine(load.data.observation, load.data.truncated)}
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
                      ? 'The result the model saw is kept for saved Workspace answers only.'
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
                    <ObservationView observation={load.data.observation} />
                    {load.data.truncated ? (
                      <p className="text-xs text-muted-foreground" data-testid="step-inspector-truncated">
                        {OBSERVATION_TRUNCATED_NOTE}
                      </p>
                    ) : null}
                  </>
                )}
              </section>
            </div>
            {onAsk ? (
              <SheetFooter className={cn('gap-2 p-4 sm:justify-start')}>
                {canRetry ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => ask(retryStepQuestion(step, question, questionRecency), 'retry_step')}
                  >
                    <RotateCcw aria-hidden />
                    Retry step
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => ask(explainStepQuestion(step, question, questionRecency), 'follow_up')}
                >
                  <MessageCircleQuestion aria-hidden />
                  Explain this step
                </Button>
                {busy ? <p className="self-center text-xs text-muted-foreground">Available once the current answer is ready.</p> : null}
              </SheetFooter>
            ) : null}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
