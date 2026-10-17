/**
 * StartScreen — the new-chat start stack (SPEC-chat §3.9 to §3.11, §5.2, §5.6).
 *
 *   Good afternoon, Aryan                                   h3, text-2xl
 *   Since 09:12: 5 new cases (2 critical) and Wazuh quiet…   or the capability line
 *   [card][card][card][card]                                 1, 2 or 4 columns
 *   Investigate  Hunt  Posture  Report  Learn the app  All prompts
 *
 * The host (`Transcript`) anchors the stack to the bottom of the conversation lane,
 * directly above the docked composer (D6), and the stack spans the lane, so the card
 * grid, the pills and the composer share both edges. Columns and the card count follow
 * the MEASURED width of the stack (never a viewport query): 1 column and 3 cards below
 * 560 px, 2 columns and 4 cards from 560 px, 4 columns from 1,040 px. Rows are as tall
 * as their tallest card, the skeleton shows exactly the visible count at the card's
 * height, and a card swap is an opacity cross-fade, so nothing shifts. Below a 480 px
 * lane height the greeting is visually hidden (it still names the section). When the
 * stack is taller than the lane, the lane opens at its end.
 *
 * States (§3.11): loading (skeletons), loaded, nothing allowed (no grid), read failed
 * ("Couldn't load suggestions." with Retry), switched off by the viewer (`starters`
 * null: no request was made). The cards are paused, with the composer's reason, while
 * a turn runs, a thread restores or a promptbook runs.
 *
 * Keyboard (§5.6): the grid is one tab stop (roving `tabIndex`); arrow keys move in
 * reading order and wrap, Home and End jump to the first and last card, Enter or Space
 * activates, Delete or Backspace (not its auto-repeat, and never on a paused card)
 * hides the focused card and focus moves to the card that takes its place.
 *
 * Hide (§3.9): the next ranked card not on screen takes the hidden card's OWN slot and
 * every other card keeps its slot and its DOM node ({@link starterSlots} replays the
 * hide and Undo history over the server order); the toast "Hidden for a day" offers
 * Undo, which puts the card back in its slot. The `dismissed` event (the family hidden
 * on the server for 24 hours) is posted only when the toast closes without Undo, so
 * Undo posts nothing and the server never hides a card the analyst brought back.
 * Within one applied result and card count the grid never gets shorter (a shorter card
 * taking a slot does not move the bottom-anchored stack). While the pointer is over the
 * grid or focus is inside it, a fresh result is held (never reorder under the analyst).
 * Retry keeps its row, busy, until the read lands, then hands focus to the cards only
 * when focus was still on Retry (never one the analyst moved elsewhere). Nothing here is
 * a live region.
 */
import * as React from 'react';
import { RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import type { ChatContextInfo, ChatStarter } from '@/lib/types';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { PROMPTBOOK_RUNNING_REASON } from '../composer/PromptRunner';
import { getPromptbook, subscribePromptbook } from '../composer/promptbook-store';
import { CatchUpLine } from './CatchUpLine';
import { CategoryPills } from './CategoryPills';
import { greetingLine, useGreetingName } from './greeting';
import { STARTER_CARD_FRAME, StarterCard } from './StarterCard';
import {
  commitStarterDismissal,
  hideStarterLocally,
  restoreStarterLocally,
  useHiddenStarters,
  type ChatStartersController,
  type HiddenStarters,
} from './useChatStarters';

/** §5.2 second line when there is no catch-up line. */
export const CAPABILITY_LINE = 'Ask about cases, logs, metrics or this console.';
/** §3.11 read failure. */
export const STARTERS_LOAD_ERROR = "Couldn't load suggestions.";
/** §5.5 toast after Hide. */
export const HIDDEN_FOR_A_DAY = 'Hidden for a day';

/** Lane width breakpoints (§5.2), in CSS px of the measured stack. */
export const TWO_COLUMNS_FROM = 560;
export const FOUR_COLUMNS_FROM = 1040;
/** Below this lane height the greeting is visually hidden (§3.11). */
export const GREETING_MIN_LANE_HEIGHT = 480;

/** Columns and visible cards for a measured lane width (0 = not measured yet: narrow). */
export function startGrid(width: number): { columns: 1 | 2 | 4; count: 3 | 4 } {
  if (width >= FOUR_COLUMNS_FROM) return { columns: 4, count: 4 };
  if (width >= TWO_COLUMNS_FROM) return { columns: 2, count: 4 };
  return { columns: 1, count: 3 };
}

const GRID_COLUMNS: Record<1 | 2 | 4, string> = { 1: 'grid-cols-1', 2: 'grid-cols-2', 4: 'grid-cols-4' };

/** The local identity a card is hidden under (its opaque key, else its family). */
export function starterHideKey(starter: Pick<ChatStarter, 'id' | 'key'>): string {
  return starter.key ?? `id:${starter.id}`;
}

/**
 * The cards on screen, slot by slot (§3.9, §3.10, §5.6). The first `count` cards of the
 * server order fill the slots; the hide and Undo history is then replayed in order: a
 * hidden card's slot takes the next card of the server order that is neither on screen
 * nor hidden at that point, and every other slot is left alone; Undo puts the card back
 * into the slot it left (the card standing there returns to the reserve). Each slot keeps
 * its claims in hide order: an Undo drops only the claims above the restored card (the
 * stand-ins hidden from that slot after it), never the ones below it, so Undo in either
 * order ends with the first card hidden from a slot back in it. A slot with no card left
 * to take it closes. Anything hidden now that the (bounded) history no longer names still
 * leaves its slot the same way.
 */
export function starterSlots(
  starters: readonly ChatStarter[],
  hidden: Pick<HiddenStarters, 'keys' | 'log'>,
  count: number,
): ChatStarter[] {
  const order = starters.map(starterHideKey);
  const byKey = new Map(starters.map((starter) => [starterHideKey(starter), starter] as const));
  const slots: Array<string | null> = order.slice(0, Math.max(0, count));
  const used = new Set<string>(order.slice(0, Math.max(0, count)));
  /** Hidden as of the point the replay has reached. */
  const out = new Set<string>();
  /** A hidden card → the slot it left (Undo puts it back there). */
  const owner = new Map<string, number>();
  /** A slot → the cards hidden from it that still have a claim on it, oldest first. */
  const claims = new Map<number, string[]>();
  const fill = (index: number) => {
    const next = order.find((key) => !used.has(key) && !out.has(key)) ?? null;
    slots[index] = next;
    if (next) used.add(next);
  };
  for (const event of hidden.log) {
    if (event.type === 'hide') {
      out.add(event.key);
      const index = slots.indexOf(event.key);
      if (index < 0) continue;
      // Off screen now (and never picked while hidden): an Undo that finds no claim to
      // honour leaves it in the reserve, where a later stand-in can still pick it.
      used.delete(event.key);
      owner.set(event.key, index);
      claims.set(index, [...(claims.get(index) ?? []), event.key]);
      fill(index);
      continue;
    }
    out.delete(event.key);
    const index = owner.get(event.key);
    owner.delete(event.key);
    if (index === undefined) continue;
    // (A claim is only ever made by a card on screen, so it is in this order.)
    const stack = claims.get(index) ?? [];
    const position = stack.indexOf(event.key);
    // The stand-ins hidden from this slot after this card lose their claim on it (an
    // Undo of one of them later sends it to the reserve); the claims below it remain.
    if (position >= 0) {
      for (const later of stack.slice(position + 1)) owner.delete(later);
      claims.set(index, stack.slice(0, position));
    }
    if (slots.includes(event.key)) continue;
    const standIn = slots[index];
    if (standIn) used.delete(standIn);
    slots[index] = event.key;
    used.add(event.key);
  }
  for (const key of hidden.keys) out.add(key);
  for (let index = 0; index < slots.length; index += 1) {
    const key = slots[index];
    if (key && hidden.keys.has(key)) fill(index);
  }
  return slots.flatMap((key) => {
    const starter = key ? byKey.get(key) : undefined;
    return starter ? [starter] : [];
  });
}

/** Measure an element's width, and the height of the scroll lane it sits in. */
function useStackGeometry(node: HTMLElement | null): { width: number; laneHeight: number } {
  const [geometry, setGeometry] = React.useState({ width: 0, laneHeight: 0 });
  React.useLayoutEffect(() => {
    if (!node) return undefined;
    const lane = node.closest<HTMLElement>('[data-chat-scroll-lane]');
    const measure = () => {
      const width = Math.round(node.getBoundingClientRect().width);
      const laneHeight = lane ? lane.clientHeight : 0;
      setGeometry((prev) => (prev.width === width && prev.laneHeight === laneHeight ? prev : { width, laneHeight }));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    if (lane) observer.observe(lane);
    return () => observer.disconnect();
  }, [node]);
  return geometry;
}

export interface StartScreenProps {
  /** The tool catalogue (`/chat/context`): which category pills to show. */
  context: ChatContextInfo | null;
  /** The home starters; null when the viewer switched suggestions off (no request). */
  starters: ChatStartersController | null;
  /** The signed-in username (null when auth is off): the greeting's name. */
  principal?: string | null;
  /** A turn runs or a thread restores: cards and clauses are paused. */
  disabled?: boolean;
  /** A card or a catch-up clause was chosen (the host dispatches on its action). */
  onActivate: (starter: ChatStarter) => void;
  /** The keys of the cards on screen (the `viewed` event reports them). */
  onShownKeysChange?: (keys: string[]) => void;
  className?: string;
}

export function StartScreen({
  context,
  starters,
  principal = null,
  disabled = false,
  onActivate,
  onShownKeysChange,
  className,
}: StartScreenProps) {
  const headingId = React.useId();
  const reasonId = React.useId();
  const [node, setNode] = React.useState<HTMLElement | null>(null);
  const { width, laneHeight } = useStackGeometry(node);
  const { columns, count } = startGrid(width);
  const name = useGreetingName(principal);
  // The running promptbook lives outside any composer (it outlives a thread switch).
  const book = React.useSyncExternalStore(subscribePromptbook, getPromptbook, getPromptbook);
  const bookRunning = book?.status === 'running';
  const paused = disabled || bookRunning;
  const hidden = useHiddenStarters();

  const info = starters?.info ?? null;
  const loading = !!starters && starters.loading;
  const failed = !!starters && !!starters.error && !info;
  const visible = React.useMemo(() => starterSlots(info?.starters ?? [], hidden, count), [info, hidden, count]);
  const visibleSignature = visible.map(starterHideKey).join(',');
  const catchUp = info?.catch_up && info.catch_up.clauses.length ? info.catch_up : null;

  // The keys on screen, for the `viewed` event.
  const shownKeys = visible.map((starter) => starter.key).filter((key): key is string => !!key);
  const shownSignature = shownKeys.join(',');
  const onShownRef = React.useRef(onShownKeysChange);
  onShownRef.current = onShownKeysChange;
  React.useEffect(() => {
    onShownRef.current?.(shownSignature ? shownSignature.split(',') : []);
  }, [shownSignature]);

  /* ------------------------------------------------------------ roving focus -- */
  const cardRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = React.useState(0);
  const activeIndex = visible.length ? Math.min(active, visible.length - 1) : 0;
  const pendingFocus = React.useRef<number | null>(null);
  /** The card an Undo brought back: it takes focus when focus has nowhere better to be. */
  const undoFocus = React.useRef<string | null>(null);

  const focusCard = (index: number) => {
    setActive(index);
    cardRefs.current[index]?.focus();
  };

  // After a hide, focus the card that took the slot (or the last one; the first pill
  // when no card is left). After an Undo, focus the card that came back when focus was
  // on the toast's Undo, on <body> or inside the grid (its stand-in has just gone).
  const visibleCount = visible.length;
  // Read inside the layout effects below, which run when the cards in the slots change.
  const visibleRef = React.useRef(visible);
  visibleRef.current = visible;
  const activeRef = React.useRef(activeIndex);
  activeRef.current = activeIndex;
  React.useLayoutEffect(() => {
    const restored = undoFocus.current;
    if (restored !== null) {
      undoFocus.current = null;
      const index = visibleRef.current.findIndex((starter) => starterHideKey(starter) === restored);
      const focused = document.activeElement;
      const strayFocus =
        !focused ||
        focused === document.body ||
        !!node?.contains(focused) ||
        !!(focused instanceof Element && focused.closest('[data-sonner-toaster]'));
      if (index >= 0 && strayFocus) {
        setActive(index);
        cardRefs.current[index]?.focus();
        return;
      }
    }
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    if (!visibleCount) {
      node?.querySelector<HTMLElement>('[data-pill]')?.focus();
      return;
    }
    const next = Math.min(index, visibleCount - 1);
    setActive(next);
    cardRefs.current[next]?.focus();
  }, [visibleSignature, visibleCount, node]);

  const hide = (starter: ChatStarter, index: number, fromKeyboard: boolean) => {
    // A paused card is shown but not usable: it cannot be hidden either (§3.9).
    if (paused) return;
    const id = starterHideKey(starter);
    const token = hideStarterLocally(id, starter.key ?? null);
    if (fromKeyboard || cardRefs.current[index] === document.activeElement || node?.contains(document.activeElement)) {
      pendingFocus.current = index;
    }
    // The family is hidden on the server only once the toast closes without Undo.
    toast(HIDDEN_FOR_A_DAY, {
      action: {
        label: 'Undo',
        onClick: () => {
          undoFocus.current = id;
          restoreStarterLocally(id, token);
        },
      },
      onAutoClose: () => commitStarterDismissal(id, token),
      onDismiss: () => commitStarterDismissal(id, token),
    });
  };

  const onCardKeyDown = (index: number, starter: ChatStarter) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const n = visible.length;
    if (!n) return;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusCard((index + 1) % n);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        focusCard((index - 1 + n) % n);
        break;
      case 'Home':
        event.preventDefault();
        focusCard(0);
        break;
      case 'End':
        event.preventDefault();
        focusCard(n - 1);
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        // One hide per key press: a held key's auto-repeat would walk through every
        // card that takes the slot and hide each family in turn.
        if (event.repeat || paused) break;
        hide(starter, index, true);
        break;
      default:
        break;
    }
  };

  /* --------------------------------------------- hold fresh results (§3.10) -- */
  const pointerInside = React.useRef(false);
  const focusInside = React.useRef(false);
  const setHeld = starters?.setHeld;
  const [grid, setGrid] = React.useState<HTMLUListElement | null>(null);
  React.useEffect(() => {
    if (!grid || !setHeld) return undefined;
    const sync = () => setHeld(pointerInside.current || focusInside.current);
    const onPointerEnter = () => {
      pointerInside.current = true;
      sync();
    };
    const onPointerLeave = () => {
      pointerInside.current = false;
      sync();
    };
    const onFocusIn = () => {
      focusInside.current = true;
      sync();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (grid.contains(event.relatedTarget as Node | null)) return;
      focusInside.current = false;
      sync();
    };
    grid.addEventListener('pointerenter', onPointerEnter);
    grid.addEventListener('pointerleave', onPointerLeave);
    grid.addEventListener('focusin', onFocusIn);
    grid.addEventListener('focusout', onFocusOut);
    return () => {
      grid.removeEventListener('pointerenter', onPointerEnter);
      grid.removeEventListener('pointerleave', onPointerLeave);
      grid.removeEventListener('focusin', onFocusIn);
      grid.removeEventListener('focusout', onFocusOut);
      // The grid went away: release any held result.
      pointerInside.current = false;
      focusInside.current = false;
      setHeld(false);
    };
  }, [grid, setHeld]);

  /* ------------------------------------------- the grid never gets shorter -- */
  // Within one applied result at one width, a hide or an Undo can bring a shorter card
  // into a row: the grid keeps the tallest height it had, so the bottom-anchored stack
  // never jumps down and back. A new result, another width, or another number of cards
  // (a slot closed with no card left to take it, or an Undo reopened one) starts from
  // its own height, so the cards left are never stretched over the rows that went.
  const floorSignature = `${info?.as_of ?? ''}|${info?.expires_at ?? ''}|${width}|${columns}|${visibleCount}`;
  const [gridFloor, setGridFloor] = React.useState<{ signature: string; height: number }>({ signature: '', height: 0 });
  React.useLayoutEffect(() => {
    if (!grid) return undefined;
    const measure = () => {
      const height = Math.round(grid.getBoundingClientRect().height);
      setGridFloor((prev) =>
        prev.signature === floorSignature ? (height > prev.height ? { signature: floorSignature, height } : prev) : { signature: floorSignature, height },
      );
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(grid);
    return () => observer.disconnect();
  }, [grid, floorSignature]);
  const gridMinHeight = gridFloor.signature === floorSignature && gridFloor.height > 0 ? gridFloor.height : undefined;

  /* ------------------------------------------------------------------ retry -- */
  // Retry keeps its row (busy) while the read runs, so focus is never dropped to <body>:
  // when cards land, the grid's tab stop takes it (the first pill when no card is
  // allowed); when the read fails again, it stays on the same Retry button. The hand-off
  // belongs to that one Retry press: it lapses when the read settles without cards or
  // when the analyst moves focus elsewhere, and it only ever picks up a focus the Retry
  // row dropped as it left (never a focus the analyst placed).
  const [retrying, setRetrying] = React.useState(false);
  const retryButton = React.useRef<HTMLButtonElement>(null);
  const retryHadFocus = React.useRef(false);
  const retryBusy = retrying && loading;
  React.useEffect(() => {
    if (!retrying || loading) return;
    // The read settled. A success already handed focus over in the layout effect below
    // (layout effects run first); a failure keeps focus on Retry and ends the hand-off,
    // so a later background refresh never moves focus.
    retryHadFocus.current = false;
    setRetrying(false);
  }, [retrying, loading]);
  const onRetry = () => {
    if (retryBusy || !starters) return;
    retryHadFocus.current = document.activeElement === retryButton.current;
    setRetrying(true);
    starters.retry();
  };
  const showError = failed || retryBusy;

  /* --------------------------------------- open at the end when it overflows -- */
  const phase = showError ? 'failed' : loading ? 'loading' : 'ready';
  React.useLayoutEffect(() => {
    if (!retryHadFocus.current || phase !== 'ready') return;
    retryHadFocus.current = false;
    // The Retry row left in this same commit: pick up only the focus it dropped. Focus
    // the analyst put somewhere else (the composer, say) stays where it is.
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    const target = (visibleCount ? cardRefs.current[activeRef.current] : null) ?? node?.querySelector<HTMLElement>('[data-pill]');
    target?.focus();
  }, [phase, node, visibleCount]);
  React.useLayoutEffect(() => {
    const lane = node?.closest<HTMLElement>('[data-chat-scroll-lane]');
    if (lane && lane.scrollHeight > lane.clientHeight) lane.scrollTop = lane.scrollHeight;
  }, [node, phase, laneHeight]);

  const shortLane = laneHeight > 0 && laneHeight < GREETING_MIN_LANE_HEIGHT;

  return (
    <section
      ref={setNode}
      aria-labelledby={headingId}
      data-testid="chat-start"
      data-columns={columns}
      // `flow-root`: the narrow pill row's negative block margin (room for its focus rings
      // inside its scroll clip) stays inside the stack, so the stack's edge is the pills'.
      className={cn('flow-root w-full', className)}
    >
      <h3 id={headingId} className={cn('text-2xl font-semibold text-foreground', shortLane && 'sr-only')}>
        {greetingLine(name)}
      </h3>
      {catchUp ? (
        <CatchUpLine catchUp={catchUp} onSend={onActivate} disabled={paused} className={shortLane ? undefined : 'mt-1'} />
      ) : (
        <p className={cn('text-base text-muted-foreground', !shortLane && 'mt-1')}>{CAPABILITY_LINE}</p>
      )}

      {showError ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="starters-error">
          <p className="text-sm text-muted-foreground">{STARTERS_LOAD_ERROR}</p>
          <Button
            ref={retryButton}
            type="button"
            size="sm"
            variant="outline"
            onClick={onRetry}
            onBlur={(event) => {
              // Focus moved on to something else: the hand-off no longer applies.
              if (event.relatedTarget) retryHadFocus.current = false;
            }}
            aria-disabled={retryBusy || undefined}
            aria-busy={retryBusy || undefined}
            className={cn(retryBusy && 'cursor-progress opacity-60')}
          >
            <RotateCcw aria-hidden />
            Retry
          </Button>
        </div>
      ) : loading ? (
        <div
          aria-hidden="true"
          data-testid="starter-skeletons"
          className={cn('mt-4 grid auto-rows-fr gap-2', GRID_COLUMNS[columns])}
        >
          {Array.from({ length: count }, (_, index) => (
            <div key={index} className={cn(STARTER_CARD_FRAME, 'motion-safe:animate-pulse')} />
          ))}
        </div>
      ) : visible.length ? (
        <ul
          ref={setGrid}
          aria-label="Suggested questions"
          aria-describedby={bookRunning ? reasonId : undefined}
          className={cn('mt-4 grid auto-rows-fr gap-2', GRID_COLUMNS[columns])}
          style={gridMinHeight ? { minHeight: gridMinHeight } : undefined}
        >
          {visible.map((starter, index) => (
            <li
              key={starterHideKey(starter)}
              className="min-w-0 animate-in fade-in-0 duration-200 ease-spring"
              data-testid="starter-card"
            >
              <StarterCard
                ref={(el) => {
                  cardRefs.current[index] = el;
                }}
                starter={starter}
                tabIndex={index === activeIndex ? 0 : -1}
                disabled={paused}
                onActivate={onActivate}
                onHide={(chosen) => hide(chosen, index, false)}
                onKeyDown={onCardKeyDown(index, starter)}
                onFocus={() => setActive(index)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {bookRunning && visible.length > 0 && !showError && !loading ? (
        <p id={reasonId} className="mt-2 text-xs text-muted-foreground">
          {PROMPTBOOK_RUNNING_REASON}
        </p>
      ) : null}

      <CategoryPills context={context} narrow={width > 0 && width < TWO_COLUMNS_FROM} className="mt-3" />
    </section>
  );
}
