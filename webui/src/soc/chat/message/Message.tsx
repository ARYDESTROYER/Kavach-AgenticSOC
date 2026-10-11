/**
 * Message — one assistant turn (chat revamp SPEC §10.3; Round 12 SPEC D2–D4, D9–D11).
 *
 * Unboxed, full column width, no avatar, with a hidden `<h3>` "Assistant". In order:
 *
 *   [Product help label] → [notice callout | quiet compaction line] → [run log, while
 *   running] → [contents · Jump to end, long answers] → answer prose (ChatMarkdown, `[D1]`
 *   markers jump to Sources) → [clarify card] → answer blocks (LAZY chunk) → [end
 *   marker, long answers] → meta row → [feedback panel] → [Sources] → [saved report] →
 *   [memory / not-saved line] → [follow-ups, latest turn only] → [zero-result chips,
 *   latest turn only: they load after the answer, so they come last and only append]
 *
 * While the turn runs the run log sits expanded under the user turn with a live
 * header; it collapses when answer text starts (first `text.delta`, or `turn.done` in
 * Live steps) and the meta row's disclosure reopens it in place. Restored turns always
 * render collapsed. The running turn is `aria-busy`.
 *
 * Round 12: chat has no answer limits, so there is no Continue chip and a limit never
 * earns a "Partial" label (`notice-copy.ts`); `origin: continue`
 * stays accepted on the wire for old clients but is never sent. The run log shows the
 * engine's quiet notes (continued, summarised, wrapped up, stopped repeating) and opens
 * any lookup in the step inspector. A saved Workspace answer can be rated, added to a
 * case (human-confirmed) and shows the report the server saved from it.
 *
 * Every string comes normalised from `stream-events.ts` and renders as a text node; the
 * blocks pass through `parseBlocks()` (G9) and load from their own chunk, never
 * statically (`chat-blocks-bundle.test.ts`).
 */
import * as React from 'react';
import { BookOpen, BriefcaseBusiness, Check, Copy, FileCheck2, FilePlus2, ListCollapse, MoreHorizontal, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import type { ChatOrigin } from '@/lib/types';
import { useOptionalAuth } from '@/soc/auth';
import { IconButton } from '@/soc/components/IconButton';
import { useAnnouncer } from '@/soc/components/announcer';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { ChatMarkdown } from '../ChatMarkdown';
import { isSafeChatId } from '../chat-api';
import { legacyTableBlock, parseBlocks, type AnswerBlock } from '../blocks/schema';
import { isUnsavedTurn, type ChatAssistantItem, type ChatEngine } from '../useChatEngine';
import { AddToCaseDialog } from './AddToCaseDialog';
import { AnswerContents, AnswerEnd, LONG_ANSWER_CHARS, TOC_MIN_HEADINGS, useAnswerHeadings } from './AnswerContents';
import { FeedbackButtons, FeedbackPanel, useAnswerFeedbackControls } from './AnswerFeedback';
import { ClarifyCard } from './ClarifyCard';
import { useAnswerFeedback } from './feedback';
import { FollowUps } from './FollowUps';
import { CONTENT_COL, LANE_COL, LANE_SUBGRID, META_COL, WIDE_COL } from './lane';
import { MemoryLine, hasMemoryLine } from './MemoryLine';
import { MetaRow } from './MetaRow';
import { CALLOUT_NOTICE_KINDS, NoticeCallout } from './NoticeCallout';
import { NOTICE_TITLE, noticeView, outcomeWord, type TurnOutcomeWord } from './notice-copy';
import {
  NOTE_TEXT,
  RunLogHeader,
  RunLogList,
  quietModelNote,
  stepsFromLive,
  stepsFromResponse,
  type RunLogNote,
  type RunLogStep,
} from './RunLog';
import { ReportSaveErrorLine, SavedReportLine } from './SavedReportLine';
import { SourcesDisclosure, sourceEntryId } from './SourcesDisclosure';
import { StepInspector } from './StepInspector';
import { COPY_LAST_ANSWER_KEYS, useCopyLastAnswer } from './useCopyLastAnswer';
import { ZeroResultChips, useZeroResultChips } from './ZeroResultChips';
import { chipsNotInFollowUps } from './zero-suggestions';

const AnswerBlocks = React.lazy(() => import('../blocks/AnswerBlocks'));

/** What a locally stopped turn says (the server's saved version may differ). */
export const LOCAL_STOP_MESSAGE = 'Stopped. The saved version appears after refresh.';

/**
 * The engine actions a message needs (a subset, so tests can stub it), plus the saved
 * conversation it belongs to (Workspace): feedback, the step inspector's stored results
 * and the zero-result chips read the answer by `(conversationId, messageId)`.
 */
export type MessageEngine = Pick<ChatEngine, 'busy' | 'retry' | 'askAgain' | 'continueAnswer' | 'send'> & {
  conversationId?: string | null;
};

/** The conversation report as one message sees it (Workspace only). */
export interface MessageReportBinding {
  /** Block ids of THIS message already in the report ("In report ✓"). */
  blocks: ReadonlySet<string>;
  /** The whole answer is in the report as a section. */
  answerInReport: boolean;
  /** Adding is possible (the report is not full). Removing is always possible. */
  canAdd: boolean;
  /** Why adding is off (e.g. "Report is full (40 items)"); shown as the tooltip. */
  disabledReason?: string | null;
  /**
   * Toggle a block / the whole answer. The binding decides add vs remove and refuses an
   * add to a full report with its reason, so the controls never need to unmount.
   */
  onToggleBlock: (blockId: string) => void;
  onToggleAnswer: () => void;
}

export interface MessageProps {
  item: ChatAssistantItem;
  /** The newest turn: actions always visible; follow-ups, clarify and chips offered. */
  latest: boolean;
  engine: MessageEngine;
  headingId: string;
  compact?: boolean;
  /** Stop abandoned the stream locally (the saved copy appears after a refresh). */
  stoppedLocally?: boolean;
  report?: MessageReportBinding | null;
  /** The question this answer replied to (display text; "Add to case" quotes it). */
  question?: string | null;
  /**
   * Which of several answers to the same question this is, newest first (`answerRecencies`;
   * 0 = the only one): a step question then names "your second most recent answer to …".
   */
  questionRecency?: number;
  /** A requested message (deep link / search hit): its answer is ringed for 2 s. */
  highlighted?: boolean;
  className?: string;
}

/** Tools that read the product, not the SOC's data (D9: "Product help" only without data). */
const PRODUCT_TOOLS = new Set(['app_help', 'app_status']);

/** Blocks plus the legacy `table` when no table block carries those rows (SPEC §3.2). */
function answerBlocks(response: ChatAssistantItem['response']): AnswerBlock[] {
  if (!response) return [];
  const { blocks } = parseBlocks(response.blocks ?? []);
  if (response.table && !blocks.some((block) => block.type === 'table')) {
    const legacy = legacyTableBlock(response.table);
    if (legacy) return [...blocks, legacy];
  }
  return blocks;
}

function CopyAnswer({ text, shortcut = false }: { text: string; shortcut?: boolean }) {
  const announce = useAnnouncer();
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      label={copied ? 'Copied' : 'Copy answer'}
      size="sm"
      // The newest answer is also copied by Ctrl/⌘+Shift+C (useCopyLastAnswer).
      aria-keyshortcuts={shortcut ? COPY_LAST_ANSWER_KEYS : undefined}
      onClick={() => {
        // Only claim a copy that happened (copyText also works over plain HTTP).
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          announce('Copied');
        });
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </IconButton>
  );
}

/** The fallback reason when a binding refuses adds without saying why. */
const REPORT_REFUSED = 'The report cannot take more items';

/**
 * The answer's report toggle. ONE stable name (an APG toggle must not also flip its
 * name); `aria-pressed` says whether the answer is in the report, and the tooltip uses
 * the block vocabulary ("In report ✓ (click to remove)"). A full report makes it
 * `aria-disabled`, never `disabled`: it stays focusable so its tooltip can say why, and
 * a click is answered with the reason by the binding.
 */
function AnswerReportToggle({ report }: { report: MessageReportBinding }) {
  const unavailable = !report.answerInReport && !report.canAdd;
  const hint = report.answerInReport
    ? 'In report ✓ (click to remove)'
    : unavailable
      ? (report.disabledReason ?? REPORT_REFUSED)
      : 'Add answer to report';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton
          label="Add answer to report"
          tooltip={false}
          size="sm"
          aria-pressed={report.answerInReport}
          aria-disabled={unavailable || undefined}
          onClick={report.onToggleAnswer}
          className={cn(report.answerInReport && 'text-primary', unavailable && 'cursor-not-allowed opacity-50')}
          data-testid="answer-add-to-report"
        >
          {report.answerInReport ? <FileCheck2 aria-hidden /> : <FilePlus2 aria-hidden />}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent side="top">{hint}</TooltipContent>
    </Tooltip>
  );
}

interface MoreActionsProps {
  /** The answer text ("Copy answer"), or null. */
  copy: string | null;
  report: MessageReportBinding | null;
  onAddToCase: ((opener: HTMLElement | null) => void) | null;
  onAskAgain: (() => void) | null;
  busy: boolean;
}

/**
 * The narrow meta row's overflow menu (a phone or a slim panel): Copy, Add to report,
 * Add to case and Ask again move here so the lookup count, the token figure, the Demo
 * marker and Sources keep their ONE line whole (SPEC §10.3); the thumbs stay visible.
 * Wider rows show them all as icon buttons.
 */
function MoreActions({ copy, report, onAddToCase, onAskAgain, busy }: MoreActionsProps) {
  const announce = useAnnouncer();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  if (!copy && !report && !onAddToCase && !onAskAgain) return null;
  const reportUnavailable = !!report && !report.answerInReport && !report.canAdd;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton ref={triggerRef} label="More actions" size="sm" tooltip={false} data-testid="answer-more-actions">
          <MoreHorizontal aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {copy ? (
          <DropdownMenuItem
            onSelect={() => {
              void copyText(copy).then((ok) => {
                if (ok) announce('Copied');
              });
            }}
          >
            <Copy className="size-3.5" aria-hidden />
            Copy answer
          </DropdownMenuItem>
        ) : null}
        {report ? (
          // A full report keeps the item FOCUSABLE (`aria-disabled`, never Radix
          // `disabled`, which roving focus skips) so its reason stays in the reading
          // order; choosing it is answered with that reason by the binding, as on the
          // wide row's toggle.
          <DropdownMenuItem
            aria-disabled={reportUnavailable || undefined}
            onSelect={report.onToggleAnswer}
            className={cn(reportUnavailable && 'text-muted-foreground')}
            data-testid="more-actions-report"
          >
            {report.answerInReport ? <FileCheck2 className="size-3.5" aria-hidden /> : <FilePlus2 className="size-3.5" aria-hidden />}
            <span className="min-w-0">
              {report.answerInReport ? 'Remove answer from report' : 'Add answer to report'}
              {reportUnavailable ? (
                <span className="block text-2xs text-muted-foreground">{report.disabledReason ?? REPORT_REFUSED}</span>
              ) : null}
            </span>
          </DropdownMenuItem>
        ) : null}
        {onAddToCase ? (
          <DropdownMenuItem onSelect={() => onAddToCase(triggerRef.current)}>
            <BriefcaseBusiness className="size-3.5" aria-hidden />
            Add to case…
          </DropdownMenuItem>
        ) : null}
        {onAskAgain ? (
          <DropdownMenuItem disabled={busy} onSelect={onAskAgain}>
            <RefreshCw className="size-3.5" aria-hidden />
            Ask again
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A quiet, motionless placeholder while the blocks chunk loads. */
function BlocksPlaceholder() {
  return <div className="h-20 rounded-md border border-dashed border-border" aria-hidden data-testid="blocks-loading" />;
}

/** The per-answer storage hint (SPEC A22): a restored answer compacted to fit storage. */
export const ANSWER_TRIMMED_HINT = 'Trimmed to fit storage';

function MessageView({
  item,
  latest,
  engine,
  headingId,
  compact = false,
  stoppedLocally = false,
  report = null,
  question = null,
  questionRecency = 0,
  highlighted = false,
  className,
}: MessageProps) {
  const rawId = React.useId();
  const domId = `msg${rawId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const logId = `${domId}-log`;
  const sourcesId = `${domId}-sources`;
  const feedbackId = `${domId}-feedback`;
  const running = item.status === 'running';
  const live = item.live;
  const response = item.response;
  // Optional: a host without an auth provider (a standalone embed) offers no case write.
  const auth = useOptionalAuth();
  const canComment = auth ? auth.hasPermission('cases', 'comment') : false;

  // The log is open while a fresh turn runs, collapses once answer text starts or the
  // turn settles, and is reopened in place from the meta row. Restored turns: closed.
  const [logOpen, setLogOpen] = React.useState(running && !item.restored);
  const hasLiveText = !!live?.text;
  React.useEffect(() => {
    if (running && hasLiveText) setLogOpen(false);
  }, [running, hasLiveText]);
  const wasRunning = React.useRef(running);
  React.useEffect(() => {
    if (wasRunning.current && !running) setLogOpen(false);
    wasRunning.current = running;
  }, [running]);

  const [sourcesOpen, setSourcesOpen] = React.useState(false);
  const [focusSource, setFocusSource] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (focusSource === null || !sourcesOpen) return;
    const entry = document.getElementById(sourceEntryId(domId, focusSource));
    entry?.focus();
    setFocusSource(null);
  }, [domId, focusSource, sourcesOpen]);

  const steps = React.useMemo(
    () => (running && live ? stepsFromLive(live) : stepsFromResponse(response?.steps)),
    [running, live, response?.steps],
  );
  const blocks = React.useMemo(() => answerBlocks(response), [response]);
  const citations = React.useMemo(() => response?.citations ?? [], [response?.citations]);
  const consoleLinks = response?.console_links ?? [];
  const citationIds = React.useMemo(() => new Set(citations.map((citation) => citation.id)), [citations]);
  const onCitation = React.useCallback(
    (id: string) => {
      const index = citations.findIndex((citation) => citation.id === id);
      if (index < 0) return;
      setSourcesOpen(true);
      setFocusSource(index);
    },
    [citations],
  );
  const queryForStep = React.useCallback(
    (step: number) => response?.steps?.find((entry) => entry.index === step)?.query ?? null,
    [response?.steps],
  );
  const renderMarkdown = React.useCallback((text: string) => <ChatMarkdown text={text} headingBase={4} />, []);

  const notice = response?.notice ?? null;
  const unsaved = response ? isUnsavedTurn(response) : false;
  const answer = running ? (live?.text ?? '') : (response?.answer ?? '');
  // A D1 turn's answer IS its notice message: say it once, in the callout. A clarify
  // answer that is only its question says it once, in the card.
  const clarifyQuestion = !running ? (response?.clarify?.question ?? null) : null;
  const showAnswer =
    !!answer &&
    !(notice && answer.trim() === notice.message.trim()) &&
    !(clarifyQuestion && answer.trim() === clarifyQuestion.trim());
  const calloutNotice = notice && CALLOUT_NOTICE_KINDS.has(notice.kind) ? notice : null;
  const calloutView = calloutNotice
    ? noticeView(calloutNotice, { answered: showAnswer && !unsaved, hasConsoleLink: consoleLinks.length > 0 })
    : null;
  // D4: a summary of earlier messages is a quiet line, never a callout.
  const compacted = !running && (notice?.kind === 'compacted' || response?.compacted === true);
  // The deterministic $0 Help Center answer (§5.4.1: no model call, usage.calls = 0)
  // did answer: its notice explains why AI was unavailable, but the turn is not
  // "Failed". A billed product answer keeps every outcome word (Stopped, Failed).
  const helpFallback =
    response?.answer_kind === 'product_help' &&
    response.usage?.calls === 0 &&
    (notice?.kind === 'budget' || notice?.kind === 'provider' || notice?.kind === 'breaker');
  const clarify = !running ? (response?.clarify ?? null) : null;
  // The clarify card itself says "Needs input" (the meta row does not repeat it).
  const needsInput = !!clarify && latest;
  const outcome: TurnOutcomeWord | null = notice && !helpFallback ? outcomeWord(notice, { answered: !unsaved }) : null;
  // D9: "Product help" only for a product answer that read no SOC data.
  const readData = steps.some((step) => step.kind === 'tool' && !!step.tool && !PRODUCT_TOOLS.has(step.tool));
  const productHelp = response?.answer_kind === 'product_help' && !readData;

  const persistedMessageId = isSafeChatId(item.messageId) ? item.messageId : null;
  const conversationId = isSafeChatId(engine.conversationId) ? engine.conversationId : null;
  // A saved Workspace answer: rated, inspected and added to a case by its ids.
  const savedAnswer = !compact && !!conversationId && !!persistedMessageId && !!response && !unsaved;
  const blocksMessageId = persistedMessageId ?? item.key;
  const busy = engine.busy;

  // Round 12 quiet run-log notes the steps do not carry themselves.
  const notes = React.useMemo<RunLogNote[]>(() => {
    const out: RunLogNote[] = [];
    if (compacted && !steps.some((step) => quietModelNote(step) === 'compacted')) {
      out.push({ key: 'n-compacted', text: NOTE_TEXT.compacted, kind: 'compacted' });
    }
    if (notice?.kind === 'stopped_repeating') out.push({ key: 'n-repeat', text: NOTE_TEXT.repeat, kind: 'repeat' });
    return out;
  }, [compacted, notice?.kind, steps]);
  const hasLog = steps.some((step) => step.kind === 'tool' || quietModelNote(step) !== null) || notes.length > 0;

  // The step inspector (P1-1): any settled lookup of the run log.
  // The last inspected step stays mounted while the sheet closes (its exit animation).
  const [inspected, setInspected] = React.useState<RunLogStep | null>(null);
  const [inspectOpen, setInspectOpen] = React.useState(false);
  const inspectOpener = React.useRef<HTMLElement | null>(null);
  const onInspect = React.useCallback((step: RunLogStep, opener: HTMLElement) => {
    inspectOpener.current = opener;
    setInspected(step);
    setInspectOpen(true);
  }, []);
  const ask = React.useCallback(
    (text: string, origin: ChatOrigin) => engine.send(text, { origin }),
    [engine],
  );

  // Feedback (P1-4): the stored rating of a saved Workspace answer.
  const feedbackValue = useAnswerFeedback(savedAnswer ? conversationId : null, savedAnswer ? persistedMessageId : null);
  const feedback = useAnswerFeedbackControls(conversationId ?? '', persistedMessageId ?? '', feedbackValue);

  // Add to case (P1-9): human-confirmed, `cases:comment`, Workspace answers only.
  const [addCaseOpen, setAddCaseOpenState] = React.useState(false);
  // Mounted from the first open on, so the dialog can animate out and return focus.
  const [addCaseMounted, setAddCaseMounted] = React.useState(false);
  const setAddCaseOpen = React.useCallback((open: boolean) => {
    if (open) setAddCaseMounted(true);
    setAddCaseOpenState(open);
  }, []);
  const addCaseRef = React.useRef<HTMLButtonElement>(null);
  // Focus returns to whatever opened the dialog (the icon, or the narrow row's ⋯ menu).
  const addCaseOpener = React.useRef<HTMLElement | null>(null);
  const openAddToCase = React.useCallback(
    (opener: HTMLElement | null) => {
      addCaseOpener.current = opener;
      setAddCaseOpen(true);
    },
    [setAddCaseOpen],
  );
  const canAddToCase = savedAnswer && canComment && !!response?.answer?.trim();

  // Zero-result chips (D10): the latest saved answer's lookups that matched nothing. They
  // arrive after the answer, so they render LAST and only append: a follow-up already on
  // screen is never removed for them (a chip asking the same is left out instead).
  const followUps = response?.follow_ups ?? [];
  const allChips = useZeroResultChips(conversationId, persistedMessageId, response?.steps, latest && !running && savedAnswer);
  // Compared with the follow-ups actually shown (FollowUps offers at most three).
  const chips = React.useMemo(
    () => chipsNotInFollowUps(allChips, (response?.follow_ups ?? []).slice(0, 3)),
    [allChips, response?.follow_ups],
  );
  // Only some lookups found nothing (others returned data): the chips say so.
  const someZero = React.useMemo(
    () =>
      (response?.steps ?? []).some(
        (s) => s.kind === 'tool' && s.status === 'ok' && !!s.tool && !PRODUCT_TOOLS.has(s.tool) && (s.rows ?? 0) > 0,
      ),
    [response?.steps],
  );

  // Long answers (P1-6): contents, Jump to end, and Ctrl/⌘+Shift+C on the latest one.
  const answerRef = React.useRef<HTMLDivElement>(null);
  const endRef = React.useRef<HTMLParagraphElement>(null);
  const headings = useAnswerHeadings(answerRef, showAnswer ? answer : '', !running);
  const longAnswer = !running && showAnswer && (headings.length >= TOC_MIN_HEADINGS || answer.length >= LONG_ANSWER_CHARS);
  useCopyLastAnswer(latest && !running && response?.answer ? response.answer : null);

  const reportBinding = report && persistedMessageId ? report : null;
  // Wide rows show every action; a narrow row keeps the thumbs and moves the rest into ⋯
  // (a container query on the meta row, so the two forms never show at once).
  const actions =
    !running && response ? (
      <>
        <span className="hidden @[30rem]/meta:contents">{response.answer ? <CopyAnswer text={response.answer} shortcut={latest} /> : null}</span>
        {savedAnswer ? <FeedbackButtons state={feedback} panelId={feedbackId} /> : null}
        <span className="hidden @[30rem]/meta:contents">
          {reportBinding ? <AnswerReportToggle report={reportBinding} /> : null}
          {canAddToCase ? (
            <IconButton
              ref={addCaseRef}
              label="Add to case"
              size="sm"
              onClick={(event) => openAddToCase(event.currentTarget)}
              data-testid="answer-add-to-case"
            >
              <BriefcaseBusiness aria-hidden />
            </IconButton>
          ) : null}
          {!unsaved ? (
            <IconButton label="Ask again" size="sm" disabled={busy} onClick={() => engine.askAgain(item.key)}>
              <RefreshCw aria-hidden />
            </IconButton>
          ) : null}
        </span>
        <span className="contents @[30rem]/meta:hidden">
          <MoreActions
            copy={response.answer || null}
            report={reportBinding}
            onAddToCase={canAddToCase ? openAddToCase : null}
            onAskAgain={unsaved ? null : () => engine.askAgain(item.key)}
            busy={busy}
          />
        </span>
      </>
    ) : null;

  return (
    <article
      className={cn(LANE_SUBGRID, compact ? 'gap-y-1.5' : 'gap-y-2', 'group/turn', className)}
      aria-labelledby={headingId}
      aria-busy={running || undefined}
      data-message-id={persistedMessageId ?? undefined}
      data-turn-status={item.status}
      data-needs-input={needsInput || undefined}
      data-highlighted={highlighted || undefined}
    >
      <h3 id={headingId} className="sr-only">
        Assistant
      </h3>

      {productHelp ? (
        <p className={cn(CONTENT_COL, 'inline-flex items-center gap-1.5 text-2xs font-medium text-muted-foreground')}>
          <BookOpen className="size-3.5" aria-hidden />
          Product help
        </p>
      ) : null}

      {item.status === 'error' && item.failure ? (
        <NoticeCallout
          className={CONTENT_COL}
          kind={item.failure.notice?.kind ?? 'provider'}
          tone="critical"
          title={item.failure.kind === 'connection_lost' ? 'Connection lost' : 'The assistant could not answer'}
          message={item.failure.message}
          actionLabel={item.failure.retryable ? 'Retry same request' : undefined}
          onAction={item.failure.retryable ? () => engine.retry(item.key) : undefined}
          secondaryLabel={item.failure.retryable ? undefined : 'Ask again'}
          onSecondary={item.failure.retryable ? undefined : () => engine.askAgain(item.key)}
          actionDisabled={busy}
        />
      ) : null}

      {calloutNotice && calloutView ? (
        <NoticeCallout
          className={CONTENT_COL}
          kind={calloutNotice.kind}
          tone={calloutView.tone}
          title={stoppedLocally ? undefined : calloutView.title}
          message={stoppedLocally ? LOCAL_STOP_MESSAGE : calloutNotice.message}
          body={stoppedLocally ? LOCAL_STOP_MESSAGE : calloutView.body}
          actionLabel={calloutNotice.retryable ? 'Retry' : undefined}
          onAction={calloutNotice.retryable ? () => engine.retry(item.key) : undefined}
          actionDisabled={busy}
        />
      ) : null}

      {compacted ? (
        <p
          role="note"
          className={cn(CONTENT_COL, 'inline-flex items-center gap-1.5 text-2xs text-muted-foreground')}
          data-testid="answer-compacted"
        >
          <ListCollapse className="size-3.5 shrink-0" aria-hidden />
          {NOTICE_TITLE.compacted}
        </p>
      ) : null}

      {running && live ? (
        <div className={cn(CONTENT_COL, 'space-y-1.5')}>
          <RunLogHeader live={live} open={logOpen} onToggle={() => setLogOpen((open) => !open)} controls={logId} />
          <RunLogList steps={steps} id={logId} hidden={!logOpen} />
        </div>
      ) : null}

      {longAnswer ? (
        <AnswerContents
          className={CONTENT_COL}
          headings={headings}
          answerRef={answerRef}
          showJump={longAnswer}
          endRef={endRef}
        />
      ) : null}

      {showAnswer ? (
        <div
          ref={answerRef}
          className={cn(
            CONTENT_COL,
            highlighted && 'rounded-sm ring-2 ring-primary/60 ring-offset-4 ring-offset-background',
          )}
        >
          <ChatMarkdown
            text={answer}
            headingBase={3}
            citationIds={running ? null : citationIds}
            onCitation={running ? null : onCitation}
            className={compact ? 'text-sm' : undefined}
          />
        </div>
      ) : null}

      {clarify ? (
        <ClarifyCard
          className={CONTENT_COL}
          clarify={clarify}
          active={latest}
          disabled={busy}
          onPick={(text, own) => ask(text, own ? 'user' : 'clarify')}
        />
      ) : null}

      {!running && blocks.length ? (
        <div className={compact ? CONTENT_COL : WIDE_COL}>
          <React.Suspense fallback={<BlocksPlaceholder />}>
            <AnswerBlocks
              blocks={blocks}
              messageId={blocksMessageId}
              domId={domId}
              compact={compact}
              inReport={report?.blocks}
              // Visibility never follows `canAdd` or a pending request: a block already in
              // a full report must stay removable, and the clicked toggle must keep focus.
              canAddToReport={!!report && !!persistedMessageId}
              onAddToReport={report && persistedMessageId ? report.onToggleBlock : undefined}
              addDisabledReason={report && !report.canAdd ? (report.disabledReason ?? REPORT_REFUSED) : null}
              renderMarkdown={renderMarkdown}
              queryForStep={queryForStep}
            />
          </React.Suspense>
        </div>
      ) : null}

      {longAnswer ? <AnswerEnd ref={endRef} className={CONTENT_COL} /> : null}

      {!running && response ? (
        <div className={cn(blocks.length && !compact ? META_COL : CONTENT_COL, 'space-y-1.5')}>
          <MetaRow
            response={response}
            steps={steps}
            outcome={outcome}
            log={hasLog ? { open: logOpen, onToggle: () => setLogOpen((open) => !open), controls: logId } : null}
            sources={{
              open: sourcesOpen,
              onToggle: () => setSourcesOpen((open) => !open),
              controls: sourcesId,
              count: citations.length + consoleLinks.length,
            }}
            actions={actions}
            actionsAlwaysVisible={latest}
          />
          {savedAnswer && feedback.panelOpen ? <FeedbackPanel state={feedback} id={feedbackId} /> : null}
          {hasLog ? (
            <RunLogList steps={steps} id={logId} hidden={!logOpen} notes={notes} onInspect={onInspect} />
          ) : null}
          {citations.length + consoleLinks.length > 0 ? (
            <SourcesDisclosure
              id={sourcesId}
              domId={domId}
              citations={citations}
              consoleLinks={consoleLinks}
              hidden={!sourcesOpen}
            />
          ) : null}
          {!compact && response.saved_report ? <SavedReportLine report={response.saved_report} /> : null}
          {!compact && !response.saved_report && response.saved_report_error ? (
            <ReportSaveErrorLine
              error={response.saved_report_error}
              conversationId={conversationId}
              messageId={persistedMessageId}
            />
          ) : null}
          {item.restored && response.truncated === true ? (
            // A saved answer whose snapshot was compacted to fit storage (SPEC A22):
            // one quiet line under its own meta row, never a thread-level warning.
            <p className="text-2xs text-muted-foreground" data-testid="answer-trimmed-hint">
              {ANSWER_TRIMMED_HINT}
            </p>
          ) : null}
          {hasMemoryLine(response) ? (
            <MemoryLine response={response} onRetrySave={() => engine.retry(item.key)} retryDisabled={busy} />
          ) : null}
        </div>
      ) : null}

      {!running && latest && followUps.length ? (
        <FollowUps
          className={compact ? CONTENT_COL : LANE_COL}
          items={followUps}
          disabled={busy}
          onPick={(text) => engine.send(text, { origin: 'follow_up' })}
        />
      ) : null}

      {!running && latest && chips.length ? (
        <ZeroResultChips
          className={compact ? CONTENT_COL : LANE_COL}
          chips={chips}
          some={someZero}
          disabled={busy}
          onPick={(text) => ask(text, 'follow_up')}
        />
      ) : null}

      {inspected ? (
        <StepInspector
          step={inspected}
          open={inspectOpen}
          conversationId={savedAnswer ? conversationId : null}
          messageId={savedAnswer ? persistedMessageId : null}
          onOpenChange={setInspectOpen}
          returnFocus={() => inspectOpener.current}
          onAsk={(text, origin) => ask(text, origin)}
          busy={busy}
          question={question}
          questionRecency={questionRecency}
        />
      ) : null}

      {canAddToCase && addCaseMounted && response ? (
        <AddToCaseDialog
          open={addCaseOpen}
          onOpenChange={setAddCaseOpen}
          question={question}
          answer={response.answer}
          at={item.at}
          citations={citations}
          returnFocus={() => addCaseOpener.current ?? addCaseRef.current}
        />
      ) : null}
    </article>
  );
}

/** Memoised: a settled turn re-renders only when its own props change. */
export const Message = React.memo(MessageView);
