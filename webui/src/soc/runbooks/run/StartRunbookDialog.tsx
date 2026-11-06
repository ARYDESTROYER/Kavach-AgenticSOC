/**
 * Start runbook (Round 14, SPEC §4.10.11): a dialog with a searchable list of Published
 * runbooks for this case. The best match is pre-selected with its explanation, then
 * "Other matches", "Fallback" (Generic incident), "Suggested by the AI" and "All published
 * runbooks". A preview of the selected runbook's phases sits beside the list; an optional
 * note goes to the team. "Suggest a runbook" (one AI call, when it is on) adds an entry
 * with its reason that a person must select: the AI never attaches a runbook (§4.10.10).
 *
 * The list is one radio group (one tab stop, arrow keys move the choice) and fades at its
 * bottom edge when it scrolls. On a phone the dialog takes the full height and, with no
 * room for the preview, the selected runbook shows its phases under its own entry. Starting attaches the Published version; its lookups run
 * and attach their results as evidence; a runbook never closes a case (#3). Names and
 * summaries are Published operator text, a suggestion's reason is AI text: both are
 * plain text (#9).
 */
import * as React from 'react';
import { BookCheck, Bot, Search } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { attachRunbook, getRunbookCandidates, getRunbookDetail, suggestRunbook } from '@/lib/api-runbooks';
import type {
  AiCallEstimate,
  PhaseId,
  RunbookAttachResult,
  RunbookCandidate,
  RunbookStep,
} from '@/lib/types-runbooks';
import {
  describeExplanation,
  ORIGIN_LABEL,
  PHASE_LABEL,
  ProvenanceChip,
  runbookFailure,
} from '@/soc/runbooks/shared';
import { ARIA_DISABLED_LOOK } from './ui';

/** The longest note a person may leave when starting a runbook. */
export const ATTACH_NOTE_MAX_CHARS = 500;

const GROUPS: ReadonlyArray<{ key: RunbookCandidate['group']; label: string }> = [
  { key: 'best', label: 'Best match' },
  { key: 'other', label: 'Other matches' },
  { key: 'fallback', label: 'Fallback' },
  { key: 'suggested', label: 'Suggested by the AI' },
  { key: 'all', label: 'All published runbooks' },
];

function initialChoice(list: RunbookCandidate[]): string {
  return (list.find((c) => c.group === 'best') ?? list.find((c) => c.group === 'fallback'))?.id ?? '';
}

function estimateWords(estimate: AiCallEstimate | null): string {
  if (!estimate) return '';
  const parts: string[] = [];
  if (estimate.total_tokens > 0) parts.push(`≈ ${estimate.total_tokens.toLocaleString()} tokens`);
  if (typeof estimate.cost === 'number') parts.push(`≈ $${estimate.cost.toFixed(4)}${estimate.simulated ? ' simulated' : ''}`);
  return parts.join(' · ');
}

export interface StartRunbookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseId: string;
  /** "CASE-000231 · Shell opened in a production pod", for the dialog's description. */
  caseLine: string;
  /** "Suggest a runbook" is offered (runbooks.ai_suggest). */
  aiSuggest: boolean;
  /** Runbook ids already on the case (listed as already attached). */
  attachedIds: readonly string[];
  onStarted: (result: RunbookAttachResult) => void;
  /** Where focus goes when the dialog closes and its opener is gone. */
  returnFocusTo?: () => HTMLElement | null;
}

export function StartRunbookDialog({
  open,
  onOpenChange,
  caseId,
  caseLine,
  aiSuggest,
  attachedIds,
  onStarted,
  returnFocusTo,
}: StartRunbookDialogProps) {
  const [query, setQuery] = React.useState('');
  const [candidates, setCandidates] = React.useState<RunbookCandidate[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [choice, setChoice] = React.useState('');
  const [note, setNote] = React.useState('');
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);
  const [suggesting, setSuggesting] = React.useState(false);
  const [suggestNote, setSuggestNote] = React.useState<string | null>(null);
  const [estimate, setEstimate] = React.useState<AiCallEstimate | null>(null);
  const [scrolled, setScrolled] = React.useState({ more: false });
  const [phases, setPhases] = React.useState<Record<string, Array<[PhaseId, number]> | 'error'>>({});
  const estimateAsked = React.useRef(false);
  const touched = React.useRef(false);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  if (open && !openerRef.current && typeof document !== 'undefined') {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  const searchId = React.useId();
  const noteId = React.useId();
  const listLabelId = React.useId();
  const estimateId = React.useId();

  // Reset whenever the dialog opens afresh.
  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setNote('');
    setStartError(null);
    setSuggestNote(null);
    setCandidates(null);
    setLoadError(null);
    touched.current = false;
    estimateAsked.current = false;
    setEstimate(null);
  }, [open]);

  // The candidates for the case; the search is read by the server (name, rule or technique).
  React.useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      getRunbookCandidates(caseId, query.trim() || undefined, controller.signal)
        .then((res) => {
          if (controller.signal.aborted) return;
          const list = res.candidates ?? [];
          setCandidates(list);
          setLoadError(null);
          setChoice((cur) => (touched.current && list.some((c) => c.id === cur) ? cur : initialChoice(list)));
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setLoadError(runbookFailure(err, 'The runbooks could not be listed. Try again.').message);
        });
    }, query ? 250 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, caseId, query]);

  const selected = candidates?.find((c) => c.id === choice) ?? null;

  // The selected runbook's phases with their step counts, read once per runbook.
  React.useEffect(() => {
    if (!open || !selected || phases[selected.id]) return undefined;
    let alive = true;
    getRunbookDetail(selected.id)
      .then((detail) => {
        const steps: RunbookStep[] = detail.live?.definition?.steps ?? [];
        const order: PhaseId[] = detail.live?.definition?.phases ?? selected.phases;
        const counts = order.map((p) => [p, steps.filter((s) => s.phase === p).length] as [PhaseId, number]).filter(([, n]) => n > 0);
        if (alive) setPhases((prev) => ({ ...prev, [selected.id]: counts }));
      })
      .catch(() => {
        if (alive) setPhases((prev) => ({ ...prev, [selected.id]: 'error' }));
      });
    return () => {
      alive = false;
    };
  }, [open, selected, phases]);

  const onListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setScrolled({ more: el.scrollTop + el.clientHeight < el.scrollHeight - 4 });
  };
  React.useEffect(() => {
    const el = listRef.current;
    if (el) setScrolled({ more: el.scrollTop + el.clientHeight < el.scrollHeight - 4 });
  }, [candidates]);

  const askEstimate = () => {
    if (estimateAsked.current) return;
    estimateAsked.current = true;
    suggestRunbook(caseId, { dryRun: true })
      .then((res) => setEstimate(res.estimate ?? null))
      .catch(() => undefined);
  };

  const suggest = async () => {
    if (suggesting) return;
    setSuggesting(true);
    setSuggestNote(null);
    try {
      const res = await suggestRunbook(caseId);
      const candidate = res.candidate;
      if (!candidate) {
        setSuggestNote('The AI had no suggestion for this case.');
        return;
      }
      const suggestion: RunbookCandidate = { ...candidate, group: 'suggested' };
      // One entry per runbook: the suggestion replaces any other listing of the same one.
      setCandidates((prev) => [...(prev ?? []).filter((c) => c.group !== 'suggested' && c.id !== suggestion.id), suggestion]);
      setSuggestNote(`The AI suggested ${suggestion.title}. Select it to start it.`);
    } catch (err) {
      setSuggestNote(runbookFailure(err, 'The AI could not answer. Try again later.').message);
    } finally {
      setSuggesting(false);
    }
  };

  const start = async () => {
    if (!selected || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const trimmed = note.trim();
      const result = await attachRunbook(caseId, { runbook_id: selected.id, ...(trimmed ? { note: trimmed } : {}) });
      onStarted(result);
      onOpenChange(false);
    } catch (err) {
      setStartError(runbookFailure(err, 'The runbook could not be started. Try again.').message);
    } finally {
      setStarting(false);
    }
  };

  const estimateLine = estimateWords(estimate);
  const attached = new Set(attachedIds);
  const groups = GROUPS.map((g) => ({ ...g, items: (candidates ?? []).filter((c) => c.group === g.key) })).filter((g) => g.items.length);
  const preview = selected ? phases[selected.id] : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => (!starting || next ? onOpenChange(next) : undefined)}>
      <DialogContent
        data-testid="start-runbook-dialog"
        className="flex max-h-[calc(100dvh-2rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[min(42rem,calc(100dvh-2rem))]"
        onCloseAutoFocus={(event) => {
          const opener = openerRef.current;
          openerRef.current = null;
          const target = [opener, returnFocusTo?.() ?? null].find((el): el is HTMLElement => Boolean(el && el.isConnected));
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader className="shrink-0 px-6 pb-4 pt-6">
          <DialogTitle className="flex items-center gap-2">
            <BookCheck className="h-5 w-5" aria-hidden />
            Start a runbook
          </DialogTitle>
          <DialogDescription>{caseLine}</DialogDescription>
        </DialogHeader>
        <div className="@container/pick flex min-h-0 flex-1 flex-col border-t border-border">
          <div className="grid min-h-0 flex-1 @[44rem]/pick:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
            <div className="flex min-h-0 flex-col @[44rem]/pick:border-r @[44rem]/pick:border-border">
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
                <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <Label htmlFor={searchId} className="sr-only">
                  Search runbooks
                </Label>
                <Input
                  id={searchId}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search runbooks by name, rule or technique"
                  className="h-8 border-0 px-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                />
              </div>
              <div className="relative min-h-0 flex-1">
                <div ref={listRef} onScroll={onListScroll} className="h-full max-h-[24rem] overflow-y-auto px-2 py-2 @[44rem]/pick:max-h-none">
                  {loadError ? (
                    <p role="alert" className="px-2 py-3 text-sm text-critical-text">
                      {loadError}
                    </p>
                  ) : candidates === null ? (
                    <p className="px-2 py-3 text-sm text-muted-foreground" aria-busy="true">
                      Loading runbooks
                    </p>
                  ) : groups.length === 0 ? (
                    <p className="px-2 py-3 text-sm text-muted-foreground">
                      {query.trim() ? 'No published runbook matches that search.' : 'No published runbook can be started on this case.'}
                    </p>
                  ) : (
                    <RadioGroup
                      value={choice}
                      onValueChange={(value) => {
                        touched.current = true;
                        setChoice(value);
                      }}
                      aria-labelledby={listLabelId}
                      className="gap-0"
                    >
                      <span id={listLabelId} className="sr-only">
                        Runbooks you can start
                      </span>
                      {groups.map((group) => (
                        <div key={group.key} role="presentation" className="pb-2">
                          <p className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground" aria-hidden>
                            {group.label}
                          </p>
                          {group.items.map((item) => {
                            const id = `start-rb-${group.key}-${item.id}`;
                            const isOn = attached.has(item.id);
                            const why =
                              item.group === 'suggested'
                                ? item.reason
                                : item.explanation
                                  ? describeExplanation(item.explanation)
                                  : null;
                            return (
                              <label
                                key={`${group.key}-${item.id}`}
                                htmlFor={id}
                                className={cn(
                                  'flex cursor-pointer items-start gap-3 rounded-md px-2 py-2',
                                  choice === item.id ? 'bg-accent' : 'hover:bg-muted/60',
                                )}
                              >
                                <RadioGroupItem
                                  id={id}
                                  value={item.id}
                                  className="mt-0.5"
                                  aria-label={`${item.title}, ${group.label}${isOn ? ', already on this case' : ''}`}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium text-foreground">{item.title}</span>
                                    {item.group === 'suggested' ? <ProvenanceChip kind="ai">AI suggestion</ProvenanceChip> : null}
                                    {isOn ? <span className="text-xs text-muted-foreground">Already on this case</span> : null}
                                  </span>
                                  {why ? <span className="mt-0.5 block text-xs text-muted-foreground">{why}</span> : null}
                                  <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
                                    {item.phases.length.toLocaleString()} {item.phases.length === 1 ? 'phase' : 'phases'} · version{' '}
                                    {item.version.toLocaleString()} · {ORIGIN_LABEL[item.origin] ?? item.origin}
                                  </span>
                                  {/* No preview pane on a narrow dialog: the choice shows its phases here. */}
                                  {choice === item.id && item.phases.length ? (
                                    <span className="mt-0.5 block text-xs text-secondary-foreground @[44rem]/pick:hidden" data-start-phases="">
                                      {item.phases.map((p) => PHASE_LABEL[p]).join(', ')}
                                    </span>
                                  ) : null}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      ))}
                    </RadioGroup>
                  )}
                </div>
                {scrolled.more ? (
                  <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
                ) : null}
              </div>
              {aiSuggest ? (
                <div className="shrink-0 space-y-1 border-t border-border px-4 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className={ARIA_DISABLED_LOOK}
                      onPointerEnter={askEstimate}
                      onFocus={askEstimate}
                      onClick={suggesting ? undefined : () => void suggest()}
                      aria-busy={suggesting || undefined}
                      aria-disabled={suggesting || undefined}
                      aria-describedby={estimateLine ? estimateId : undefined}
                    >
                      <Bot aria-hidden />
                      {suggesting ? 'Asking the AI' : 'Suggest a runbook'}
                    </Button>
                    {estimateLine ? (
                      <span id={estimateId} className="text-xs tabular-nums text-muted-foreground">
                        {estimateLine}
                      </span>
                    ) : null}
                  </div>
                  {suggestNote ? (
                    <p role="status" className="text-xs text-muted-foreground">
                      {suggestNote}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="hidden min-h-0 overflow-y-auto px-5 py-4 @[44rem]/pick:block" data-start-preview="">
              {selected ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Version {selected.version.toLocaleString()} · {(ORIGIN_LABEL[selected.origin] ?? selected.origin).toLowerCase()}
                  </p>
                  <h3 className="mt-0.5 text-md font-semibold text-foreground">{selected.title}</h3>
                  {selected.summary ? <p className="mt-1.5 text-sm text-secondary-foreground">{selected.summary}</p> : null}
                  {Array.isArray(preview) && preview.length ? (
                    <ol className="mt-3 space-y-1" aria-label="Phases">
                      {preview.map(([phase, count], i) => (
                        <li key={phase} className="flex items-center gap-2 text-sm">
                          <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-2xs font-semibold tabular-nums text-muted-foreground" aria-hidden>
                            {i + 1}
                          </span>
                          <span className="text-foreground">{PHASE_LABEL[phase]}</span>
                          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                            {count.toLocaleString()} {count === 1 ? 'step' : 'steps'}
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {selected.phases.map((p) => PHASE_LABEL[p]).join(', ')}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Pick a runbook to see its phases.</p>
              )}
            </div>
          </div>
          <div className="shrink-0 space-y-1.5 border-t border-border px-6 py-3">
            <Label htmlFor={noteId} className="text-xs">
              Note for the team (optional)
            </Label>
            <Input
              id={noteId}
              value={note}
              maxLength={ATTACH_NOTE_MAX_CHARS}
              placeholder="Why you are starting it"
              className="h-8 text-sm"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter className="shrink-0 items-center gap-3 border-t border-border bg-card px-6 py-4 sm:justify-between">
          {/* Above the buttons on a phone (the footer stacks in reverse), left of them wider. */}
          <div className="order-last max-w-md space-y-1 sm:order-none">
            <p className="text-xs text-muted-foreground">
              Attaches the published version to this case. Its lookups run now and attach their results as evidence. A
              runbook never closes a case.
            </p>
            {startError ? (
              <p role="alert" className="text-xs text-critical-text">
                {startError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={starting}>
              Cancel
            </Button>
            <Button
              className={ARIA_DISABLED_LOOK}
              onClick={!selected || starting ? undefined : () => void start()}
              aria-disabled={!selected || starting || undefined}
              aria-busy={starting || undefined}
            >
              <BookCheck aria-hidden />
              Start runbook
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
