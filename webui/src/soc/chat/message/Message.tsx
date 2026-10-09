/**
 * Message — one assistant turn (chat revamp SPEC §10.3).
 *
 * Unboxed, full column width, no avatar, with a hidden `<h3>` "Assistant". In order:
 *
 *   [Product help label] → [notice callout] → [run log, while running] → answer prose
 *   (ChatMarkdown, `[D1]` markers jump to Sources) → answer blocks (LAZY chunk) →
 *   [Continue chip on a capped answer] → meta row → [Sources] → [memory / not-saved
 *   line] → [follow-ups, latest turn only]
 *
 * While the turn runs the run log sits expanded under the user turn with a live
 * header; it collapses when answer text starts (first `text.delta`, or `turn.done` in
 * Live steps) and the meta row's disclosure reopens it in place. Restored turns always
 * render collapsed.
 *
 * Every string comes normalised from `stream-events.ts` and renders as a text node; the
 * blocks pass through `parseBlocks()` (G9) and load from their own chunk, never
 * statically (`chat-blocks-bundle.test.ts`).
 */
import * as React from 'react';
import { BookOpen, Check, Copy, FileCheck2, FilePlus2, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import type { TurnNoticeKind } from '@/lib/types';
import { IconButton } from '@/soc/components/IconButton';
import { useAnnouncer } from '@/soc/components/announcer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { ChatMarkdown } from '../ChatMarkdown';
import { isSafeChatId } from '../chat-api';
import { legacyTableBlock, parseBlocks, type AnswerBlock } from '../blocks/schema';
import { isUnsavedTurn, type ChatAssistantItem, type ChatEngine } from '../useChatEngine';
import { FollowUps } from './FollowUps';
import { compactTokens } from './format';
import { CONTENT_COL, LANE_SUBGRID, WIDE_COL } from './lane';
import { MemoryLine, hasMemoryLine } from './MemoryLine';
import { MetaRow, type TurnOutcomeWord } from './MetaRow';
import { CALLOUT_NOTICE_KINDS, NoticeCallout } from './NoticeCallout';
import { RunLogHeader, RunLogList, stepsFromLive, stepsFromResponse } from './RunLog';
import { SourcesDisclosure, sourceEntryId } from './SourcesDisclosure';

const AnswerBlocks = React.lazy(() => import('../blocks/AnswerBlocks'));

/** What a locally stopped turn says (the server's saved version may differ). */
export const LOCAL_STOP_MESSAGE = 'Stopped. The saved version appears after refresh.';

/** The engine actions a message needs (a subset, so tests can stub it). */
export type MessageEngine = Pick<ChatEngine, 'busy' | 'retry' | 'askAgain' | 'continueAnswer' | 'send'>;

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
  /** The newest turn: actions always visible, follow-ups and Continue offered. */
  latest: boolean;
  engine: MessageEngine;
  headingId: string;
  compact?: boolean;
  /** Stop abandoned the stream locally (the saved copy appears after a refresh). */
  stoppedLocally?: boolean;
  report?: MessageReportBinding | null;
  /** ≈ tokens a Continue turn would send (from `/chat/context`); null when unknown. */
  continueEstimate?: number | null;
  /** A requested message (deep link / search hit): its answer is ringed for 2 s. */
  highlighted?: boolean;
  className?: string;
}

const OUTCOME: Partial<Record<TurnNoticeKind, TurnOutcomeWord>> = {
  cancelled: 'Stopped',
  partial: 'Partial',
  timeout: 'Partial',
  cap: 'Partial',
  provider: 'Failed',
  breaker: 'Failed',
  budget: 'Failed',
};

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

function CopyAnswer({ text }: { text: string }) {
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
  continueEstimate = null,
  highlighted = false,
  className,
}: MessageProps) {
  const rawId = React.useId();
  const domId = `msg${rawId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const logId = `${domId}-log`;
  const sourcesId = `${domId}-sources`;
  const running = item.status === 'running';
  const live = item.live;
  const response = item.response;

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
  // A D1 turn's answer IS its notice message: say it once, in the callout.
  const showAnswer = !!answer && !(notice && answer.trim() === notice.message.trim());
  const calloutNotice = notice && CALLOUT_NOTICE_KINDS.has(notice.kind) ? notice : null;
  // The deterministic $0 Help Center answer (§5.4.1: no model call, usage.calls = 0)
  // did answer: its notice explains why AI was unavailable, but the turn is not
  // "Failed". A billed product answer keeps every outcome word (Stopped, Partial,
  // Failed): it is the only signal on an older capped or interrupted answer.
  const helpFallback =
    response?.answer_kind === 'product_help' &&
    response.usage?.calls === 0 &&
    (notice?.kind === 'budget' || notice?.kind === 'provider' || notice?.kind === 'breaker');
  const outcome: TurnOutcomeWord | null = notice && !helpFallback ? (OUTCOME[notice.kind] ?? null) : null;
  const persistedMessageId = isSafeChatId(item.messageId) ? item.messageId : null;
  const blocksMessageId = persistedMessageId ?? item.key;
  const busy = engine.busy;

  const actions =
    !running && response ? (
      <>
        {response.answer ? <CopyAnswer text={response.answer} /> : null}
        {report && persistedMessageId ? <AnswerReportToggle report={report} /> : null}
        {!unsaved ? (
          <IconButton label="Ask again" size="sm" disabled={busy} onClick={() => engine.askAgain(item.key)}>
            <RefreshCw aria-hidden />
          </IconButton>
        ) : null}
      </>
    ) : null;

  return (
    <article
      className={cn(LANE_SUBGRID, compact ? 'gap-y-1.5' : 'gap-y-2', 'group/turn', className)}
      aria-labelledby={headingId}
      data-message-id={persistedMessageId ?? undefined}
      data-turn-status={item.status}
      data-highlighted={highlighted || undefined}
    >
      <h3 id={headingId} className="sr-only">
        Assistant
      </h3>

      {response?.answer_kind === 'product_help' ? (
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

      {calloutNotice ? (
        <NoticeCallout
          className={CONTENT_COL}
          kind={calloutNotice.kind}
          message={stoppedLocally ? LOCAL_STOP_MESSAGE : calloutNotice.message}
          actionLabel={calloutNotice.retryable ? 'Retry' : undefined}
          onAction={calloutNotice.retryable ? () => engine.retry(item.key) : undefined}
          actionDisabled={busy}
        />
      ) : null}

      {running && live ? (
        <div className={cn(CONTENT_COL, 'space-y-1.5')}>
          <RunLogHeader live={live} open={logOpen} onToggle={() => setLogOpen((open) => !open)} controls={logId} />
          <RunLogList steps={steps} id={logId} hidden={!logOpen} />
        </div>
      ) : null}

      {showAnswer ? (
        <div
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

      {!running && notice?.kind === 'cap' && latest ? (
        <div className={CONTENT_COL}>
          <button
            type="button"
            disabled={busy}
            onClick={() => engine.continueAnswer(item.key)}
            className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            Continue where this stopped
            {continueEstimate ? (
              <span className="font-normal text-muted-foreground">(≈ +{compactTokens(continueEstimate)} tokens)</span>
            ) : null}
          </button>
        </div>
      ) : null}

      {!running && response ? (
        <div className={cn(CONTENT_COL, 'space-y-1.5')}>
          <MetaRow
            response={response}
            steps={steps}
            outcome={outcome}
            log={steps.some((step) => step.kind === 'tool') ? { open: logOpen, onToggle: () => setLogOpen((open) => !open), controls: logId } : null}
            sources={{
              open: sourcesOpen,
              onToggle: () => setSourcesOpen((open) => !open),
              controls: sourcesId,
              count: citations.length + consoleLinks.length,
            }}
            actions={actions}
            actionsAlwaysVisible={latest}
          />
          {steps.some((step) => step.kind === 'tool') ? <RunLogList steps={steps} id={logId} hidden={!logOpen} /> : null}
          {citations.length + consoleLinks.length > 0 ? (
            <SourcesDisclosure
              id={sourcesId}
              domId={domId}
              citations={citations}
              consoleLinks={consoleLinks}
              hidden={!sourcesOpen}
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

      {!running && latest && response?.follow_ups?.length ? (
        <FollowUps
          className={CONTENT_COL}
          items={response.follow_ups}
          disabled={busy}
          onPick={(text) => engine.send(text, { origin: 'follow_up' })}
        />
      ) : null}
    </article>
  );
}

/** Memoised: a settled turn re-renders only when its own props change. */
export const Message = React.memo(MessageView);
