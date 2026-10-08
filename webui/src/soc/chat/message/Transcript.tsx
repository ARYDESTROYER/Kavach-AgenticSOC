/**
 * Transcript — the conversation lane (chat revamp SPEC §10.3 scrolling, §10.7
 * highlight, §10.9 accessibility and performance).
 *
 *  - `role="log"` WITHOUT `aria-live`: new content is announced once through the shell
 *    announcer (see `useTurnAnnouncer`), never by a chat-local live region. Focus never
 *    jumps on new content.
 *  - On send, the new user turn is scrolled to the lane top with a 48 px peek of the
 *    previous turn. While the answer grows the lane follows the latest content only if
 *    the reader is within 72 px of the bottom, and only until the turn's top reaches
 *    the lane top; otherwise a "Jump to latest" button appears. A fresh exchange gets a
 *    min-height of the lane so the anchor works even before the answer is long.
 *  - Reduced motion: no smooth scrolling.
 *  - Off-screen exchanges use `content-visibility: auto` (the latest two never do).
 *  - A requested message (deep link or search hit) is scrolled to and highlighted for
 *    2 s.
 */
import * as React from 'react';
import { ArrowDown } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { usePrefersReducedMotion } from '@/soc/hooks/usePrefersReducedMotion';
import type { ChatAssistantItem, ChatEngine, ChatTranscriptItem, ChatUserItem } from '../useChatEngine';
import { CONTENT_COL, LANE_GRID, LANE_SUBGRID } from './lane';
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
  onHighlightDone?: () => void;
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

/** `el`'s offset from the top of the scroll container's content. */
function offsetWithin(container: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
}

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function Transcript({
  engine,
  label = 'Conversation',
  compact = false,
  empty,
  header,
  replace,
  highlight = null,
  onHighlightDone,
  reportFor,
  continueEstimate = null,
  onSavePrompt,
  className,
}: TranscriptProps) {
  const reduceMotion = usePrefersReducedMotion();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const followRef = React.useRef(true);
  const anchorKeyRef = React.useRef<string | null>(null);
  const runningKeyRef = React.useRef<string | null>(null);
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
  const baseId = React.useId().replace(/[^A-Za-z0-9_-]/g, '');

  const items = engine.items;
  // A stable action object, so memoised messages skip live updates of other turns.
  const { busy, retry, askAgain, continueAnswer, send } = engine;
  const messageEngine = React.useMemo<MessageEngine>(
    () => ({ busy, retry, askAgain, continueAnswer, send }),
    [busy, retry, askAgain, continueAnswer, send],
  );
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

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const measure = () => setLaneHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = distanceFromBottom(el) <= FOLLOW_THRESHOLD_PX;
    if (followRef.current) setShowJump(false);
  }, []);

  const exchangeElement = React.useCallback((key: string): HTMLElement | null => {
    const el = scrollRef.current;
    if (!el) return null;
    for (const node of Array.from(el.querySelectorAll<HTMLElement>('[data-exchange]'))) {
      if (node.dataset.exchange === key) return node;
    }
    return null;
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
      const node = exchangeElement(anchoredKey);
      if (node) scrollToTop(el, offsetWithin(el, node) - ANCHOR_PEEK_PX, !reduceMotion);
      followRef.current = true;
      setShowJump(false);
      return;
    }
    if (threadChanged) {
      // Another transcript (a thread opened, New chat): open at its latest turn, unless
      // a requested message is about to be scrolled to.
      anchorKeyRef.current = null;
      followRef.current = true;
      setShowJump(false);
      if (firstKey && !highlightRef.current) scrollToTop(el, el.scrollHeight, false);
      return;
    }
    const anchor = anchorKeyRef.current ? exchangeElement(anchorKeyRef.current) : null;
    if (!anchor) return;
    const bottom = el.scrollHeight - el.clientHeight;
    if (followRef.current) {
      // Follow only until the anchored turn's top reaches the lane top.
      const target = Math.min(bottom, offsetWithin(el, anchor));
      if (target > el.scrollTop) scrollToTop(el, target, false);
      setShowJump(bottom - target > FOLLOW_THRESHOLD_PX);
    } else if (distanceFromBottom(el) > FOLLOW_THRESHOLD_PX) {
      setShowJump(true);
    }
    // `items` changes identity on every live update (steps, usage, text).
  }, [items, firstKey, running, anchoredKey, exchangeElement, reduceMotion]);

  // A requested message: scroll to it once it is rendered, highlight it for 2 s. The
  // timer lives in a ref so later live updates cannot cancel the un-highlight.
  React.useEffect(() => {
    if (!highlight || handledNonceRef.current === highlight.nonce) return;
    const el = scrollRef.current;
    if (!el) return;
    const node = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (candidate) => candidate.dataset.messageId === highlight.messageId,
    );
    if (!node) return;
    handledNonceRef.current = highlight.nonce;
    const exchange = node.closest<HTMLElement>('[data-exchange]') ?? node;
    scrollToTop(el, offsetWithin(el, exchange) - ANCHOR_PEEK_PX, !reduceMotion);
    setHighlighted(highlight.messageId);
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlighted(null);
      onHighlightDoneRef.current?.();
    }, HIGHLIGHT_MS);
  }, [highlight, items, reduceMotion]);

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
    anchorKeyRef.current = null;
    setShowJump(false);
    scrollToTop(el, el.scrollHeight, !reduceMotion);
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
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable_both-edges]"
        data-chat-scroll-lane="true"
      >
        <div className={cn(LANE_GRID, compact ? 'gap-y-4 px-1 py-3' : 'gap-y-6 px-4 py-6 sm:px-6')}>
          {header ? <div className={cn(CONTENT_COL, 'space-y-2')}>{header}</div> : null}
          {replace ? (
            <div className={CONTENT_COL}>{replace}</div>
          ) : hasTurns ? (
            <div role="log" aria-label={label} className={cn(LANE_SUBGRID, compact ? 'gap-y-4' : 'gap-y-8')}>
              {exchanges.map((exchange, index) => {
                const recent = index >= lastIndex - 1;
                const anchored = exchange.key === anchoredKey && index === lastIndex;
                return (
                  <div
                    key={exchange.key}
                    data-exchange={exchange.key}
                    className={cn(
                      LANE_SUBGRID,
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
