/**
 * MemoryLine — the quiet lines under an answer's meta row (chat revamp SPEC §4.8,
 * §10.3): a memory echo or a memory PROPOSAL, and "Not saved · Run again to save".
 *
 * The agent loop never changes memory (SPEC §4.8.1). A model-emitted change arrives
 * as `memory_proposal`; only a human with `memory:manage` can confirm it, through the
 * existing memory routes (add: `POST /api/memory`; remove: `DELETE /api/memory/{id}`
 * for the exact ids). Without the grant the proposal is shown, never actionable. The
 * legacy `memory_action` is an echo of something the compatibility path already did.
 *
 * A removal proposal is model output that fenced log content can steer (#9, §4.8), so
 * it is never confirmed blind: the ids are resolved through `GET /api/memory` first and
 * every fact that would be forgotten is shown (as text). Ids that are unknown or
 * already gone are skipped and said so; with none left there is nothing to confirm.
 *
 * "Not saved": the case thread append failed. The engine can only re-run the turn
 * (a new model run, billed again; SPEC A4), so the action says exactly that instead of
 * promising a save-only retry.
 *
 * #9: proposal, echo and fact text are model- or operator-authored: text nodes only.
 */
import * as React from 'react';
import { BookmarkCheck, BookmarkPlus, BookmarkX, CloudOff, RotateCcw } from 'lucide-react';

import { api } from '@/lib/api';
import type { ChatResponse, MemoryEntry, MemoryProposal, TurnNotice } from '@/lib/types';
import { useCan } from '@/soc/components/Can';
import { displayText } from '../stream-events';

const LINE = 'flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground';
const LINK_BUTTON =
  'rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** What the compatibility path already did (no action offered). */
function MemoryEcho({ action }: { action: NonNullable<ChatResponse['memory_action']> }) {
  const op = (action.op || '').toLowerCase();
  const removed = op === 'delete' || op === 'remove';
  if (!removed && !action.text) return null;
  const label = removed ? 'Forgot this fact' : op === 'update' ? 'Memory updated' : 'Remembered';
  const Icon = removed ? BookmarkX : BookmarkCheck;
  return (
    <p className={LINE}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="font-medium text-foreground">{label}</span>
      {action.text ? <span className="min-w-0">{action.text}</span> : null}
    </p>
  );
}

type ProposalState = 'pending' | 'saving' | 'done' | 'dismissed' | 'error';

/** What a removal proposal's ids resolve to right now. */
type Resolution =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; facts: MemoryEntry[]; missing: number };

/** Resolve the proposed ids against the saved facts (exact id matches only). */
function useResolvedFacts(ids: readonly string[], enabled: boolean) {
  const [resolution, setResolution] = React.useState<Resolution>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const key = ids.join('\u0000');
  React.useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setResolution({ status: 'loading' });
    api
      .getMemory()
      .then((response) => {
        if (!live) return;
        const wanted = new Set(key ? key.split('\u0000') : []);
        const entries = Array.isArray(response?.entries) ? response.entries : [];
        const facts = entries.filter((entry) => wanted.has(entry.id));
        setResolution({ status: 'ready', facts, missing: wanted.size - facts.length });
      })
      .catch((err: unknown) => {
        if (live) setResolution({ status: 'error', message: errorText(err, 'Could not load the saved facts.') });
      });
    return () => {
      live = false;
    };
  }, [attempt, enabled, key]);
  return { resolution, retry: () => setAttempt((n) => n + 1) };
}

const factCount = (n: number) => `${n} saved ${n === 1 ? 'fact' : 'facts'}`;

/** A proposed change; confirmable only with `memory:manage`. */
function MemoryProposalLine({ proposal }: { proposal: MemoryProposal }) {
  const canManage = useCan('memory', 'manage');
  const [state, setState] = React.useState<ProposalState>('pending');
  const [error, setError] = React.useState<string | null>(null);
  const adding = proposal.op === 'add';
  const text = adding ? (proposal.text ?? '') : '';
  const ids = React.useMemo(() => Array.from(new Set(proposal.ids ?? [])), [proposal.ids]);
  const { resolution, retry } = useResolvedFacts(ids, !adding && canManage && state !== 'done' && state !== 'dismissed');
  if (state === 'dismissed') return null;
  const facts = resolution.status === 'ready' ? resolution.facts : [];
  const missing = resolution.status === 'ready' ? resolution.missing : 0;

  const confirm = async () => {
    if (state === 'saving' || state === 'done') return;
    // A removal forgets exactly the facts shown, never an unresolved id.
    if (!adding && !facts.length) return;
    setState('saving');
    setError(null);
    try {
      if (adding) await api.addMemory({ text });
      else for (const fact of facts) await api.deleteMemory(fact.id);
      setState('done');
    } catch (err) {
      setError(errorText(err, adding ? 'Could not save to memory.' : 'Could not remove the saved facts.'));
      setState('error');
    }
  };

  if (state === 'done') {
    return (
      <p className={LINE}>
        <BookmarkCheck className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-foreground">
          {adding ? 'Saved to memory' : `Removed from memory (${factCount(facts.length)})`}
        </span>
      </p>
    );
  }

  const removalReady = !adding && resolution.status === 'ready';
  const canConfirm = adding || (removalReady && facts.length > 0);

  return (
    <div className={LINE}>
      {adding ? <BookmarkPlus className="size-3.5 shrink-0" aria-hidden /> : <BookmarkX className="size-3.5 shrink-0" aria-hidden />}
      <span className="font-medium text-foreground">{adding ? 'Suggested memory' : 'Suggested removal'}</span>
      <span className="min-w-0">{adding ? text : factCount(ids.length)}</span>
      {canManage ? (
        <>
          {canConfirm ? (
            <button type="button" className={LINK_BUTTON} onClick={() => void confirm()} disabled={state === 'saving'}>
              {state === 'saving' ? 'Saving…' : adding ? 'Remember this' : facts.length === 1 ? 'Forget this fact' : `Forget these ${facts.length}`}
            </button>
          ) : null}
          <button type="button" className={LINK_BUTTON} onClick={() => setState('dismissed')} disabled={state === 'saving'}>
            Dismiss
          </button>
        </>
      ) : (
        <span>· needs memory:manage to save</span>
      )}
      {!adding && canManage ? (
        <div className="basis-full space-y-1">
          {resolution.status === 'loading' ? <p>Checking which saved facts these are…</p> : null}
          {resolution.status === 'error' ? (
            <p>
              <span className="text-critical-text">{resolution.message}</span>{' '}
              <button type="button" className={LINK_BUTTON} onClick={retry}>
                Retry
              </button>
            </p>
          ) : null}
          {facts.length ? (
            <ul className="list-disc space-y-0.5 pl-5 text-foreground" aria-label="Facts that would be forgotten">
              {facts.map((fact) => (
                <li key={fact.id} className="break-words">
                  {displayText(fact.text, 240) || '(empty fact)'}
                </li>
              ))}
            </ul>
          ) : null}
          {removalReady && missing > 0 ? (
            <p>
              {facts.length
                ? `${factCount(missing)} ${missing === 1 ? 'is' : 'are'} no longer saved and will be skipped.`
                : 'None of these facts are saved any more; there is nothing to forget.'}
            </p>
          ) : null}
        </div>
      ) : null}
      {state === 'error' && error ? <span className="basis-full text-critical-text">{error}</span> : null}
    </div>
  );
}

/**
 * "Not saved · Run again to save" (SPEC §4.6, §10.3). Offered only when the store
 * error is retryable. The engine re-runs the turn (a new model call, billed again), so
 * the action is labelled as a run, not as a save-only retry.
 */
function NotSavedLine({ notice, onRetry, disabled }: { notice: TurnNotice; onRetry?: () => void; disabled?: boolean }) {
  const hintId = `${React.useId().replace(/[^A-Za-z0-9_-]/g, '')}-rerun`;
  const offer = notice.retryable && onRetry;
  return (
    <p className={LINE}>
      <CloudOff className="size-3.5 shrink-0" aria-hidden />
      <span className="font-medium text-foreground">Not saved</span>
      <span className="min-w-0">{notice.message}</span>
      {offer ? (
        <>
          <button
            type="button"
            className={`${LINK_BUTTON} inline-flex items-center gap-1`}
            onClick={onRetry}
            disabled={disabled}
            aria-describedby={hintId}
          >
            <RotateCcw className="size-3" aria-hidden />
            Run again to save
          </button>
          <span id={hintId}>· asks the model again and uses tokens again</span>
        </>
      ) : null}
    </p>
  );
}

export interface MemoryLineProps {
  response: ChatResponse;
  onRetrySave?: () => void;
  retryDisabled?: boolean;
}

/** The memory line, if any. */
function MemoryChange({ response }: { response: ChatResponse }) {
  if (response.memory_proposal) return <MemoryProposalLine proposal={response.memory_proposal} />;
  // A pre-revamp suggestion is the same human-confirmed add.
  if (response.memory_suggestion?.text) {
    return <MemoryProposalLine proposal={{ op: 'add', text: response.memory_suggestion.text, ids: [] }} />;
  }
  if (response.memory_action) return <MemoryEcho action={response.memory_action} />;
  return null;
}

/**
 * The not-saved line and the memory line, each when it applies. A turn that was not
 * saved can still carry a memory proposal; neither hides the other.
 */
export function MemoryLine({ response, onRetrySave, retryDisabled }: MemoryLineProps) {
  return (
    <>
      {response.notice?.kind === 'not_saved' ? (
        <NotSavedLine notice={response.notice} onRetry={onRetrySave} disabled={retryDisabled} />
      ) : null}
      <MemoryChange response={response} />
    </>
  );
}

/** Whether {@link MemoryLine} renders anything for this response. */
export function hasMemoryLine(response: ChatResponse): boolean {
  return (
    response.notice?.kind === 'not_saved' ||
    !!response.memory_proposal ||
    !!response.memory_suggestion?.text ||
    !!response.memory_action
  );
}
