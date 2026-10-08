/**
 * Transcript — the conversation lane (chat revamp SPEC §10.3 scrolling, §10.7
 * highlight, §10.9 accessibility and performance).
 *
 *  - `role="log"` with an explicit `aria-live="off"`: the log role is implicitly
 *    polite, which would read every streamed delta and run-log row on top of the shell
 *    announcer. New content is announced once through the shell announcer (see
 *    `useTurnAnnouncer`), never by a chat-local live region.
 *  - Focus never jumps on new content. A transcript action that sends (follow-up,
 *    Continue, Ask again, Retry) or Jump to latest hands focus to the composer through
 *    `onFocusComposer`, because the control that was activated usually unmounts.
 *  - On send, the new user turn is scrolled to the lane top with a 48 px peek of the
 *    previous turn. While the answer grows the lane follows the latest content only if
 *    the reader is within 72 px of the bottom, and only until the turn's top reaches
 *    the lane top; otherwise a "Jump to latest" button appears. A fresh exchange gets a
 *    min-height of the lane so the anchor works even before the answer is long.
 *  - Without an anchor (a thread just opened, or after Jump to latest) the lane sticks
 *    to the bottom while a turn runs or late content lands (the lazy answer blocks
 *    replacing their placeholders), until the reader scrolls, points or focuses inside
 *    the lane. Content growth is observed (ResizeObserver), not only transcript
 *    updates, so Jump to latest comes back whenever new content lands below a reader
 *    who scrolled away.
 *  - Reduced motion: no smooth scrolling.
 *  - Off-screen exchanges use `content-visibility: auto` (the latest two never do);
 *    every exchange repeats the lane tracks instead of subgridding (see `lane.ts`).
 *  - A requested message (deep link or search hit) is scrolled to and highlighted for
 *    2 s. A request whose message is not in the restored thread (retention dropped it,
 *    a stale link) is reported done and the thread opens at its latest turn.
 */
import * as React from 'react';
import { ArrowDown } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { usePrefersReducedMotion } from '@/soc/hooks/usePrefersReducedMotion';
import type { ChatAssistantItem, ChatEngine, ChatTranscriptItem, ChatUserItem } from '../useChatEngine';
import { CONTENT_COL, LANE_EXCHANGE, LANE_GRID, LANE_SUBGRID } from './lane';
import { Message, type MessageEngine, type MessageReportBinding } from './Message';
import { UserTurn } from './UserTurn';

/** Distance from the bottom that still counts as "following the latest" (SPEC §10.3). */
export const FOLLOW_THRESHOLD_PX = 72;
/** How much of the previous turn stays visible above an anchored user turn. */
export const ANCHOR_PEEK_PX = 48;
/** How long a requested message stays highlighted. */
export const HIGHLIGHT_MS = 2000;

interface Exchange {
  key: string;
  user: ChatUserItem | null;
  assistant: ChatAssistantItem | null;
}

/** Pair each user turn with the answer that follows it. */
export function groupExchanges(items: readonly ChatTranscriptItem[]): Exchange[] {
  const out: Exchange[] = [];
  for (const item of items) {
    if (item.kind === 'user') {
      out.push({ key: item.key, user: item, assistant: null });
      continue;
    }
    const last = out[out.length - 1];
    if (last && !last.assistant) last.assistant = item;
    else out.push({ key: item.key, user: null, assistant: item });
  }
  return out;
}

export interface TranscriptHighlight {
  messageId: string;
  /** Changes on every request so the same message can be highlighted again. */
  nonce: number;
}

export interface TranscriptProps {
  engine: Pick<ChatEngine, 'items'> & MessageEngine;
  /** Accessible name of the log. */
  label?: string;
  compact?: boolean;
  /** Rendered in the lane when there is no turn yet (and nothing is restoring). */
  empty?: React.ReactNode;
  /** Rendered above the turns (retention note, unavailable notice, restore state). */
  header?: React.ReactNode;
  /** Replace the turns entirely (restoring / restore error). */
  replace?: React.ReactNode;
  highlight?: TranscriptHighlight | null;
  /**
   * The highlight's conversation has finished restoring into this transcript: a request
   * whose message is still not rendered is then dropped (default true).
   */
  highlightReady?: boolean;
  onHighlightDone?: () => void;
  /** Move focus to the composer (after a transcript action that sends, or a jump). */
  onFocusComposer?: () => void;
  /** Report state for one assistant message (Workspace only). */
  reportFor?: (item: ChatAssistantItem) => MessageReportBinding | null;
  continueEstimate?: number | null;
  onSavePrompt?: (item: ChatUserItem) => void;
  className?: string;
}

function scrollToTop(el: HTMLElement, top: number, smooth: boolean) {
  const target = Math.max(0, top);
  if (typeof el.scrollTo === 'function') el.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });
  else el.scrollTop = target;
}

/** How long the scroll events of one programmatic smooth scroll are treated as ours. */
const AUTO_SCROLL_MS = 1000;

/** `el`'s offset from the top of the scroll container's content. */
function offsetWithin(container: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
}

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function Transcript({
  engine,
  label = 'Messages',
  compact = false,
  empty,
  header,
  replace,
  highlight = null,
  highlightReady = true,
  onHighlightDone,
  onFocusComposer,
  reportFor,
  continueEstimate = null,
  onSavePrompt,
  className,
}: TranscriptProps) {
  const reduceMotion = usePrefersReducedMotion();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  /** The reader is within 72 px of the bottom (only the reader's own scrolls change it). */
  const followRef = React.useRef(true);
  /** Keep the bottom in view while late content lands, until the reader takes over. */
  const settleRef = React.useRef(true);
  const anchorKeyRef = React.useRef<string | null>(null);
  const runningKeyRef = React.useRef<string | null>(null);
  /** A programmatic smooth scroll in flight: its intermediate scroll events are ours. */
  const autoScrollRef = React.useRef<{ top: number; until: number } | null>(null);
  const [laneHeight, setLaneHeight] = React.useState(0);
  const [showJump, setShowJump] = React.useState(false);
  const [highlighted, setHighlighted] = React.useState<string | null>(null);
  const threadKeyRef = React.useRef<string | null>(null);
  const handledNonceRef = React.useRef<number | null>(null);
  const highlightTimerRef = React.useRef<number | null>(null);
  const highlightRef = React.useRef(highlight);
  highlightRef.current = highlight;
  const onHighlightDoneRef = React.useRef(onHighlightDone);
  onHighlightDoneRef.current = onHighlightDone;
  const focusComposerRef = React.useRef(onFocusComposer);
  focusComposerRef.current = onFocusComposer;
  const baseId = React.useId().replace(/[^A-Za-z0-9_-]/g, '');

  const items = engine.items;
  // A stable action object, so memoised messages skip live updates of other turns. An
  // action that sends hands focus to the composer: the activated control (a follow-up
  // chip, Continue, a replaced failed turn) usually unmounts (SPEC §10.9).
  const { busy, retry, askAgain, continueAnswer, send } = engine;
  const messageEngine = React.useMemo<MessageEngine>(() => {
    const thenFocus =
      <A extends unknown[]>(action: (...args: A) => boolean) =>
      (...args: A): boolean => {
        const sent = action(...args);
        if (sent) focusComposerRef.current?.();
        return sent;
      };
    return {
      busy,
      retry: thenFocus(retry),
      askAgain: thenFocus(askAgain),
      continueAnswer: thenFocus(continueAnswer),
      send: thenFocus(send),
    };
  }, [busy, retry, askAgain, continueAnswer, send]);
  const exchanges = React.useMemo(() => groupExchanges(items), [items]);
  const running = items.find((item): item is ChatAssistantItem => item.kind === 'assistant' && item.status === 'running');
  const latestAssistantKey = [...items].reverse().find((item) => item.kind === 'assistant')?.key ?? null;

  // A locally stopped turn: the engine marks its prompt failed and gives no message id.
  const stoppedLocally = React.useMemo(() => {
    const out = new Set<string>();
    exchanges.forEach(({ user, assistant }) => {
      if (user?.failed && assistant?.status === 'done' && assistant.response?.notice?.kind === 'cancelled' && !assistant.messageId) {
        out.add(assistant.key);
      }
    });
    return out;
  }, [exchanges]);

  // The anchored exchange is one sent in this session (never a restored one).
  const anchoredKey = React.useMemo(() => {
    const last = exchanges[exchanges.length - 1];
    if (!last?.user || last.assistant?.restored) return null;
    return last.key;
  }, [exchanges]);

  const exchangeElement = React.useCallback((key: string): HTMLElement | null => {
    const el = scrollRef.current;
    if (!el) return null;
    for (const node of Array.from(el.querySelectorAll<HTMLElement>('[data-exchange]'))) {
      if (node.dataset.exchange === key) return node;
    }
    return null;
  }, []);

  const scrollLane = React.useCallback((top: number, smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    // Where the browser will actually land (it clamps to the scrollable range).
    const landing = Math.min(Math.max(0, top), Math.max(0, el.scrollHeight - el.clientHeight));
    // Only a real animated scroll emits intermediate events (none when nothing moves).
    const animated = smooth && typeof el.scrollTo === 'function' && Math.abs(el.scrollTop - landing) > 2;
    autoScrollRef.current = animated ? { top: landing, until: Date.now() + AUTO_SCROLL_MS } : null;
    scrollToTop(el, top, animated);
  }, []);

  /**
   * Bring the lane in line with its content after anything grew or shrank: follow the
   * anchored turn (or the bottom, when sticking), else offer Jump to latest whenever
   * content sits more than 72 px below the reader.
   */
  const reconcile = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.clientHeight;
    const anchor = anchorKeyRef.current ? exchangeElement(anchorKeyRef.current) : null;
    if (anchor) {
      if (followRef.current) {
        // Follow only until the anchored turn's top reaches the lane top.
        const target = Math.min(bottom, offsetWithin(el, anchor));
        if (target > el.scrollTop + 1) scrollLane(target, false);
        setShowJump(bottom - Math.max(target, el.scrollTop) > FOLLOW_THRESHOLD_PX);
      } else {
        setShowJump(distanceFromBottom(el) > FOLLOW_THRESHOLD_PX);
      }
      return;
    }
    const sticky = followRef.current && (runningKeyRef.current !== null || settleRef.current);
    if (sticky) {
      if (bottom - el.scrollTop > 1) scrollLane(bottom, false);
      setShowJump(false);
    } else {
      setShowJump(distanceFromBottom(el) > FOLLOW_THRESHOLD_PX);
    }
  }, [exchangeElement, scrollLane]);
  const reconcileRef = React.useRef(reconcile);
  reconcileRef.current = reconcile;

  // The lane's height (anchor spacer) and the content's growth (lazy blocks, disclosures,
  // a composer that grew) both re-run the follow rule.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const measure = () => setLaneHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const laneObserver = new ResizeObserver(() => {
      measure();
      reconcileRef.current();
    });
    laneObserver.observe(el);
    const content = contentRef.current;
    const contentObserver = new ResizeObserver(() => reconcileRef.current());
    if (content) contentObserver.observe(content);
    return () => {
      laneObserver.disconnect();
      contentObserver.disconnect();
    };
  }, []);

  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const auto = autoScrollRef.current;
    if (auto) {
      // Our own smooth scroll is still travelling: not the reader moving away.
      if (Math.abs(el.scrollTop - auto.top) > 2 && Date.now() < auto.until) return;
      autoScrollRef.current = null;
    }
    followRef.current = distanceFromBottom(el) <= FOLLOW_THRESHOLD_PX;
    if (followRef.current) setShowJump(false);
  }, []);

  // The reader takes over: no more sticking to late content, and a smooth scroll they
  // interrupted is no longer ours.
  const takeOver = React.useCallback(() => {
    settleRef.current = false;
    autoScrollRef.current = null;
  }, []);

  // Scroll behaviour on every transcript change.
  const firstKey = items[0]?.key ?? null;
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const runningKey = running?.key ?? null;
    const started = runningKey !== null && runningKey !== runningKeyRef.current;
    runningKeyRef.current = runningKey;
    const threadChanged = firstKey !== threadKeyRef.current;
    threadKeyRef.current = firstKey;

    if (started && anchoredKey) {
      // A new turn: put its user message at the lane top with a peek of the previous turn.
      anchorKeyRef.current = anchoredKey;
      settleRef.current = false;
      followRef.current = true;
      setShowJump(false);
      const node = exchangeElement(anchoredKey);
      if (node) scrollLane(offsetWithin(el, node) - ANCHOR_PEEK_PX, !reduceMotion);
      return;
    }
    if (threadChanged) {
      // Another transcript (a thread opened, New chat): open at its latest turn and keep
      // it there while the lazy blocks land, unless a requested message is about to be
      // scrolled to.
      anchorKeyRef.current = null;
      followRef.current = true;
      settleRef.current = !highlightRef.current;
      setShowJump(false);
      if (firstKey && !highlightRef.current) scrollLane(el.scrollHeight, false);
      return;
    }
    reconcile();
    // `items` changes identity on every live update (steps, usage, text).
  }, [items, firstKey, running, anchoredKey, exchangeElement, reduceMotion, reconcile, scrollLane]);

  // A requested message: scroll to it once it is rendered, highlight it for 2 s. The
  // timer lives in a ref so later live updates cannot cancel the un-highlight. Once the
  // thread is ready without that message, the request is dropped (else a stale one
  // would keep every later thread from opening at its latest turn).
  React.useEffect(() => {
    if (!highlight || handledNonceRef.current === highlight.nonce) return;
    const el = scrollRef.current;
    if (!el) return;
    const node = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (candidate) => candidate.dataset.messageId === highlight.messageId,
    );
    if (!node) {
      if (!highlightReady || replace) return;
      handledNonceRef.current = highlight.nonce;
      followRef.current = true;
      settleRef.current = true;
      scrollLane(el.scrollHeight, false);
      onHighlightDoneRef.current?.();
      return;
    }
    handledNonceRef.current = highlight.nonce;
    settleRef.current = false;
    const exchange = node.closest<HTMLElement>('[data-exchange]') ?? node;
    scrollLane(offsetWithin(el, exchange) - ANCHOR_PEEK_PX, !reduceMotion);
    setHighlighted(highlight.messageId);
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlighted(null);
      onHighlightDoneRef.current?.();
    }, HIGHLIGHT_MS);
  }, [highlight, highlightReady, items, reduceMotion, replace, scrollLane]);

  React.useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    },
    [],
  );

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    settleRef.current = true;
    anchorKeyRef.current = null;
    setShowJump(false);
    scrollLane(el.scrollHeight, !reduceMotion);
    // The button unmounts: keep focus somewhere useful.
    focusComposerRef.current?.();
  };

  const hasTurns = exchanges.length > 0;
  const lastIndex = exchanges.length - 1;
  // Lane height minus the peek and the lane's bottom padding (py-3 / py-6): exactly
  // enough room to scroll a fresh user turn to 48 px below the lane top.
  const minAnchorHeight = laneHeight > ANCHOR_PEEK_PX * 2 ? laneHeight - ANCHOR_PEEK_PX - (compact ? 12 : 24) : undefined;

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={takeOver}
        onTouchStart={takeOver}
        onPointerDown={takeOver}
        onFocus={takeOver}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable_both-edges]"
        data-chat-scroll-lane="true"
      >
        <div ref={contentRef} className={cn(LANE_GRID, compact ? 'gap-y-4 px-1 py-3' : 'gap-y-6 px-4 py-6 sm:px-6')}>
          {header ? <div className={cn(CONTENT_COL, 'space-y-2')}>{header}</div> : null}
          {replace ? (
            <div className={CONTENT_COL}>{replace}</div>
          ) : hasTurns ? (
            <div
              role="log"
              aria-label={label}
              // Explicitly off: the log role's implicit "polite" would read every delta.
              aria-live="off"
              className={cn(LANE_SUBGRID, compact ? 'gap-y-4' : 'gap-y-8')}
            >
              {exchanges.map((exchange, index) => {
                const recent = index >= lastIndex - 1;
                const anchored = exchange.key === anchoredKey && index === lastIndex;
                return (
                  <div
                    key={exchange.key}
                    data-exchange={exchange.key}
                    className={cn(
                      LANE_EXCHANGE,
                      'content-start gap-y-3',
                      !recent && '[contain-intrinsic-size:auto_320px] [content-visibility:auto]',
                    )}
                    style={anchored && minAnchorHeight ? { minHeight: minAnchorHeight } : undefined}
                  >
                    {exchange.user ? (
                      <UserTurn
                        className={CONTENT_COL}
                        item={exchange.user}
                        headingId={`${baseId}-u${index}`}
                        compact={compact}
                        onSavePrompt={onSavePrompt}
                        highlighted={!!highlighted && exchange.user.messageId === highlighted}
                      />
                    ) : null}
                    {exchange.assistant ? (
                      <Message
                        item={exchange.assistant}
                        latest={exchange.assistant.key === latestAssistantKey}
                        engine={messageEngine}
                        headingId={`${baseId}-a${index}`}
                        compact={compact}
                        stoppedLocally={stoppedLocally.has(exchange.assistant.key)}
                        report={reportFor ? reportFor(exchange.assistant) : null}
                        continueEstimate={continueEstimate}
                        highlighted={!!highlighted && exchange.assistant.messageId === highlighted}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={CONTENT_COL}>{empty}</div>
          )}
        </div>
      </div>
      {showJump ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button type="button" size="sm" variant="outline" className="pointer-events-auto h-7 shadow-sm" onClick={jumpToLatest}>
            <ArrowDown aria-hidden />
            Jump to latest
          </Button>
        </div>
      ) : null}
    </div>
  );
}
