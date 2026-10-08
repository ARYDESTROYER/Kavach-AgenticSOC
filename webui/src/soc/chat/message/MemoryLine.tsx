/**
 * MemoryLine — the one quiet line under an answer's meta row (chat revamp SPEC §4.8,
 * §10.3): a memory echo, a memory PROPOSAL, or "Not saved · Retry save".
 *
 * The agent loop never changes memory (SPEC §4.8.1). A model-emitted change arrives
 * as `memory_proposal`; only a human with `memory:manage` can confirm it, through the
 * existing memory routes (add: `POST /api/memory`; remove: `DELETE /api/memory/{id}`
 * for the exact ids). Without the grant the proposal is shown, never actionable. The
 * legacy `memory_action` is an echo of something the compatibility path already did.
 *
 * #9: proposal and echo text are model-influenced: text nodes only.
 */
import * as React from 'react';
import { BookmarkCheck, BookmarkPlus, BookmarkX, CloudOff, RotateCcw } from 'lucide-react';

import { api } from '@/lib/api';
import type { ChatResponse, MemoryProposal, TurnNotice } from '@/lib/types';
import { useCan } from '@/soc/components/Can';

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

/** A proposed change; confirmable only with `memory:manage`. */
function MemoryProposalLine({ proposal }: { proposal: MemoryProposal }) {
  const canManage = useCan('memory', 'manage');
  const [state, setState] = React.useState<ProposalState>('pending');
  const [error, setError] = React.useState<string | null>(null);
  if (state === 'dismissed') return null;
  const adding = proposal.op === 'add';
  const text = adding ? (proposal.text ?? '') : '';
  const ids = proposal.ids ?? [];

  const confirm = async () => {
    if (state === 'saving' || state === 'done') return;
    setState('saving');
    setError(null);
    try {
      if (adding) await api.addMemory({ text });
      else for (const id of ids) await api.deleteMemory(id);
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
        <span className="font-medium text-foreground">{adding ? 'Saved to memory' : 'Removed from memory'}</span>
      </p>
    );
  }

  return (
    <div className={LINE}>
      {adding ? <BookmarkPlus className="size-3.5 shrink-0" aria-hidden /> : <BookmarkX className="size-3.5 shrink-0" aria-hidden />}
      <span className="font-medium text-foreground">{adding ? 'Suggested memory' : 'Suggested removal'}</span>
      <span className="min-w-0">
        {adding ? text : `${ids.length} saved ${ids.length === 1 ? 'fact' : 'facts'}`}
      </span>
      {canManage ? (
        <>
          <button type="button" className={LINK_BUTTON} onClick={() => void confirm()} disabled={state === 'saving'}>
            {state === 'saving' ? 'Saving…' : adding ? 'Remember this' : 'Forget these'}
          </button>
          <button type="button" className={LINK_BUTTON} onClick={() => setState('dismissed')} disabled={state === 'saving'}>
            Dismiss
          </button>
        </>
      ) : (
        <span>· needs memory:manage to save</span>
      )}
      {state === 'error' && error ? <span className="basis-full text-critical-text">{error}</span> : null}
    </div>
  );
}

/** "Not saved · Retry save" (SPEC §4.6): Retry only when the store error is retryable. */
function NotSavedLine({ notice, onRetry, disabled }: { notice: TurnNotice; onRetry?: () => void; disabled?: boolean }) {
  return (
    <p className={LINE}>
      <CloudOff className="size-3.5 shrink-0" aria-hidden />
      <span className="font-medium text-foreground">Not saved</span>
      <span className="min-w-0">{notice.message}</span>
      {notice.retryable && onRetry ? (
        <button type="button" className={`${LINK_BUTTON} inline-flex items-center gap-1`} onClick={onRetry} disabled={disabled}>
          <RotateCcw className="size-3" aria-hidden />
          Retry save
        </button>
      ) : null}
    </p>
  );
}

export interface MemoryLineProps {
  response: ChatResponse;
  onRetrySave?: () => void;
  retryDisabled?: boolean;
}

/** At most one quiet line; nothing when no memory change or save problem applies. */
export function MemoryLine({ response, onRetrySave, retryDisabled }: MemoryLineProps) {
  if (response.notice?.kind === 'not_saved') {
    return <NotSavedLine notice={response.notice} onRetry={onRetrySave} disabled={retryDisabled} />;
  }
  if (response.memory_proposal) return <MemoryProposalLine proposal={response.memory_proposal} />;
  // A pre-revamp suggestion is the same human-confirmed add.
  if (response.memory_suggestion?.text) {
    return <MemoryProposalLine proposal={{ op: 'add', text: response.memory_suggestion.text, ids: [] }} />;
  }
  if (response.memory_action) return <MemoryEcho action={response.memory_action} />;
  return null;
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
