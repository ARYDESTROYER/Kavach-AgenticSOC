/**
 * AddToCaseDialog — "Add to case" on a Workspace answer (Round 12 SYNTHESIS-chat P1-9).
 *
 * A HUMAN-CONFIRMED write, never a chat side effect: the analyst picks a case (by id or
 * a search), reads the exact comment that will be posted, and posts it as THEIR OWN
 * case-thread comment through the existing collaboration route and permission
 * (`POST /api/cases/{id}/thread`, `cases:comment`). Posting never reads or changes the
 * case's status, verdict or disposition (#3), and the Workspace conversation is not
 * touched: Workspace history never receives case turns, and this is the reverse
 * direction, an explicit write (#5).
 *
 * The snapshot is plain text (`case-snapshot.ts`): the question and the answer, with
 * `@mentions` defanged so a pasted answer notifies no one, and the cited sources its
 * `[D1]` markers name listed at the end. Chart and table blocks stay in chat (a table
 * written in the answer is posted as rows of text).
 *
 * The case picker is ONE single-choice control: a `radiogroup` of `radio` rows with a
 * roving tab stop (arrows, Home and End move and pick), titles wrapping to two lines so
 * cases that share an entity prefix stay distinguishable on a phone, and a polite status
 * line inside the dialog ("8 cases", "No case matches that search.").
 */
import * as React from 'react';
import { toast } from 'sonner';
import { Search } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { ChatCitation } from '@/lib/types';
import { focusRing } from '@/lib/ui-recipes';
import { useAnnouncer } from '@/soc/components/announcer';
import { useNavigateOptional } from '@/soc/router';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { postCaseComment, searchCasesForPicker, type CasePickerEntry } from '../chat-api';
import { caseSnapshot, snapshotNote } from './case-snapshot';

/** Keep both ends of a long case id readable ("case-9991…0ae6"); the full id is in the name. */
export function shortCaseId(id: string, head = 9, tail = 4): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** Debounce of the case search (ms). */
export const CASE_SEARCH_DEBOUNCE_MS = 250;

/** The picker's status line for a search state. */
export function caseSearchStatus(search: { state: string; results?: readonly unknown[] }, query: string): string {
  if (search.state === 'error') return 'Cases could not be searched. Try again.';
  if (search.state !== 'ready') return 'Searching cases…';
  const n = search.results?.length ?? 0;
  if (!n) return query ? 'No case matches that search.' : 'No cases yet.';
  return `${n} ${n === 1 ? 'case' : 'cases'}`;
}

const PICKER_KEYS = new Set(['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']);

export interface AddToCaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The question this answer replied to (display text). */
  question: string | null;
  /** The answer text (display text). */
  answer: string;
  /** When the answer was given (ms epoch). */
  at: number;
  /** The answer's citations: its `[D1]` markers stay resolvable in the comment. */
  citations?: readonly ChatCitation[] | null;
  /** Focus target when the dialog closes (the Add to case button). */
  returnFocus?: () => HTMLElement | null;
}

type SearchState =
  | { state: 'idle' | 'loading' }
  | { state: 'ready'; results: CasePickerEntry[] }
  | { state: 'error' };

export function AddToCaseDialog({
  open,
  onOpenChange,
  question,
  answer,
  at,
  citations = null,
  returnFocus,
}: AddToCaseDialogProps) {
  const announce = useAnnouncer();
  const navigate = useNavigateOptional();
  const rawId = React.useId();
  const id = `add-case${rawId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const [query, setQuery] = React.useState('');
  const [search, setSearch] = React.useState<SearchState>({ state: 'idle' });
  const [picked, setPicked] = React.useState<CasePickerEntry | null>(null);
  const [posting, setPosting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const snapshot = React.useMemo(
    () => caseSnapshot({ question, answer, at, citations }),
    [answer, at, citations, question],
  );

  // A fresh dialog every time it opens.
  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setPicked(null);
    setError(null);
    setPosting(false);
  }, [open]);

  React.useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setSearch({ state: 'loading' });
    const timer = window.setTimeout(() => {
      searchCasesForPicker(query, controller.signal)
        .then((results) => {
          if (!controller.signal.aborted) setSearch({ state: 'ready', results });
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearch({ state: 'error' });
        });
    }, query ? CASE_SEARCH_DEBOUNCE_MS : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  const post = async () => {
    if (!picked || posting) return;
    setPosting(true);
    setError(null);
    try {
      await postCaseComment(picked.case_id, snapshot.body);
      const caseId = picked.case_id;
      announce(`Added to case ${picked.display_id}`);
      toast.success(`Added to case ${picked.display_id}`, {
        description: 'Posted as your comment in the case thread.',
        action: { label: 'Open case', onClick: () => navigate('case_manager', { caseId }) },
      });
      onOpenChange(false);
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      setError(
        status === 403
          ? 'You do not have permission to comment on cases.'
          : status === 404
            ? 'That case no longer exists. Pick another one.'
            : 'The comment could not be posted. Try again.',
      );
    } finally {
      setPosting(false);
    }
  };

  const results = search.state === 'ready' ? search.results : [];
  const radios = React.useRef<Array<HTMLButtonElement | null>>([]);
  const pickedIndex = picked ? results.findIndex((entry) => entry.case_id === picked.case_id) : -1;
  // One tab stop: the picked case, else the first.
  const tabStop = pickedIndex >= 0 ? pickedIndex : 0;
  const onPickerKey = (event: React.KeyboardEvent) => {
    if (!PICKER_KEYS.has(event.key) || !results.length) return;
    event.preventDefault();
    const from = radios.current.findIndex((el) => el === document.activeElement);
    const at = from >= 0 ? from : tabStop;
    const last = results.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowDown' || event.key === 'ArrowRight'
            ? (at + 1) % results.length
            : (at - 1 + results.length) % results.length;
    setPicked(results[next]);
    radios.current[next]?.focus();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85dvh] max-w-2xl flex-col gap-4"
        onCloseAutoFocus={(event) => {
          const target = returnFocus?.();
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
        data-testid="add-to-case-dialog"
      >
        <DialogHeader>
          <DialogTitle>Add this answer to a case</DialogTitle>
          <DialogDescription>
            It is posted as your own comment in the case thread. The case’s status and verdict do not change.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <div className="space-y-2">
            <label htmlFor={`${id}-q`} className="text-sm font-medium text-foreground">
              Case
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                id={`${id}-q`}
                type="search"
                value={query}
                autoComplete="off"
                maxLength={120}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPicked(null);
                }}
                placeholder="Search by case ID, title or entity"
                aria-controls={`${id}-results`}
                className={cn(
                  'h-9 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground',
                  focusRing,
                )}
              />
            </div>
            <div id={`${id}-results`} aria-busy={search.state === 'loading' || undefined} className="space-y-1">
              <p role="status" className="text-xs text-muted-foreground" data-testid="add-to-case-status">
                {caseSearchStatus(search, query)}
              </p>
              {results.length ? (
                // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- the radios inside take focus (roving tab stop)
                <div
                  role="radiogroup"
                  aria-label="Matching cases"
                  className="max-h-48 space-y-1 overflow-y-auto"
                  onKeyDown={onPickerKey}
                >
                  {results.map((entry, index) => {
                    const checked = picked?.case_id === entry.case_id;
                    return (
                      <button
                        key={entry.case_id}
                        ref={(el) => {
                          radios.current[index] = el;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        tabIndex={index === tabStop ? 0 : -1}
                        aria-label={`${entry.display_id}: ${entry.title}${entry.status ? ` (${entry.status})` : ''}`}
                        title={entry.display_id}
                        onClick={() => setPicked(entry)}
                        className={cn(
                          'flex w-full min-w-0 items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors motion-reduce:transition-none',
                          checked ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-muted',
                          focusRing,
                        )}
                      >
                        <span className="mt-0.5 shrink-0 font-mono text-xs text-foreground">{shortCaseId(entry.display_id)}</span>
                        <span className="line-clamp-2 min-w-0 flex-1 break-words text-foreground">{entry.title}</span>
                        {entry.status ? <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">{entry.status}</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <p id={`${id}-preview-label`} className="text-sm font-medium text-foreground">
              Comment preview
            </p>
            {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- a SCROLLABLE preview must take
                focus so a keyboard can scroll it (axe scrollable-region-focusable). */}
            <div
              role="region"
              aria-labelledby={`${id}-preview-label`}
              tabIndex={0}
              className={cn(
                'max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface/50 px-3 py-2 text-sm text-foreground',
                focusRing,
              )}
              data-testid="add-to-case-preview"
            >
              {snapshot.body}
            </div>
            {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
            <p className="text-xs text-muted-foreground" data-testid="add-to-case-note">
              {snapshotNote(snapshot)}
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-critical-text">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="sm:items-center">
          <p id={`${id}-target`} className="mr-auto min-w-0 truncate text-xs text-muted-foreground">
            {picked ? `To ${shortCaseId(picked.display_id)}` : 'Pick a case to post to'}
          </p>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!picked || posting}
            aria-busy={posting || undefined}
            aria-describedby={picked ? `${id}-target` : undefined}
            onClick={() => void post()}
          >
            Post comment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
