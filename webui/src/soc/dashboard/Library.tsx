/**
 * The Dashboards library body (Round 14, SPEC §2.2 and §4.4.5, operator choice C2).
 *
 * Two sections on the page the left navigation's "Overview" row opens (`#/dashboards`):
 *
 *   - "Built-in", with the aside "Read-only. Duplicate one to make it your own.": the Cyber
 *     Defence Center (badge "Default", a link to the landing page) and the three widget
 *     boards (badge "Built-in"). A built-in the viewer hid is left out until "Show 1
 *     hidden" (a disclosure of the list) reveals it with a "Hidden" badge and an "Unhide"
 *     button in its card foot.
 *   - "Yours": the viewer's personal boards (the role default "My dashboard" first, saved
 *     or not), then a dashed "New dashboard" tile (at the 24-board limit, the sentence
 *     that says why no other can be added).
 *
 * Every card is ONE link to its route, on the tinted panel, with an outline of the
 * board's grid (decorative, `aria-hidden`), a badge row, the name, the purpose (up to
 * three lines for a built-in's fixed copy, two for a personal board's detail, the whole
 * text in `title`) and the audience. Its accessible name is the board's name; the badge,
 * the window and the purpose describe it. Unhide is a separate button laid over the card
 * foot, a sibling after the link, never inside it; after an Unhide the card's link takes
 * the focus. A plain click goes through the router like every Console link.
 *
 * Names are untrusted and render as plain text (#9). The library reads nothing but the
 * personal board list and the viewer's preferences: no figures, no model call (#6).
 */
import * as React from 'react';
import { Lock, Plus } from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatTimestamp } from '@/lib/format';
import type { DashboardLayout } from '@/lib/types';
import type { BuiltinBoardId } from '@/lib/types-dashboards';
import { SectionTitle } from '@/design-system/panel';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import { LoadError } from '@/soc/components/LoadError';
import { useRouteLinkClick } from '@/soc/route-link';
import { pageHash } from '@/soc/router';

import {
  BOARD_LIMIT_TEXT,
  BUILTIN_BOARDS,
  LANDING_CARD,
  MY_DASHBOARD_ID,
  NEW_BOARD_ID,
  boardRouteId,
  displayBoardName,
  outlineFromWidgets,
  outlineRows,
  unavailableNote,
  type BuiltinBoard,
  type OutlineBox,
} from './builtins';
import { canUseWidget, getWidgetDef, unavailableWidgetCount, type PermissionCheck } from './registry';
import { BOARD_WINDOWS } from './widgets/requests';

// --------------------------------------------------------------------------- //
// Small pure helpers (exported for tests)
// --------------------------------------------------------------------------- //

/** The href of a board's card (`#/dashboards?board=...`, encoded the router's way). */
export function boardHref(boardId: string): string {
  return pageHash('dashboards', { board: boardId });
}

/** The href of the unsaved new-board draft. */
export const NEW_BOARD_HREF = boardHref(NEW_BOARD_ID);

/** "4 widgets", "1 widget". */
export function widgetCountText(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'widget' : 'widgets'}`;
}

const RELATIVE = (() => {
  try {
    return new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  } catch {
    return null;
  }
})();

/** "Edited 3 days ago", "Edited yesterday", "Edited just now"; null without a time. */
export function editedText(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60 || !RELATIVE) return secs < 60 ? 'Edited just now' : `Edited ${formatTimestamp(iso)}`;
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86_400],
    ['week', 604_800],
    ['month', 2_592_000],
    ['year', 31_536_000],
  ];
  let unit: Intl.RelativeTimeFormatUnit = 'minute';
  let size = 60;
  for (const [u, s] of steps) {
    if (secs >= s) {
      unit = u;
      size = s;
    }
  }
  return `Edited ${RELATIVE.format(-Math.floor(secs / size), unit)}`;
}

/** Whether the viewer may read at least one panel of a built-in (else it is not listed). */
export function builtinVisible(board: BuiltinBoard, can: PermissionCheck): boolean {
  return board.widgets.some((w) => {
    const def = getWidgetDef(w.type);
    return Boolean(def && canUseWidget(def, can));
  });
}

// --------------------------------------------------------------------------- //
// Pieces
// --------------------------------------------------------------------------- //

/**
 * The fixed-ratio outline of a board's grid: the KPI strip as one thin line, each module
 * as an outlined box with no fill, so it never reads as a loading skeleton. Decorative.
 */
export function BoardOutline({ boxes }: { boxes: readonly OutlineBox[] }) {
  const rows = outlineRows(boxes);
  return (
    <div
      aria-hidden="true"
      className="flex aspect-[16/7] w-full flex-col gap-1 overflow-hidden rounded-md border border-border/60 p-2"
      data-board-outline=""
    >
      {rows.map((row, i) =>
        row.strip ? (
          <div key={i} className="h-2 shrink-0 rounded-sm border border-border" />
        ) : (
          <div key={i} className="grid min-h-0 flex-1 grid-cols-12 gap-1">
            {row.boxes.map((box, j) => (
              <div
                key={j}
                className="min-w-0 rounded-sm border border-border"
                style={{ gridColumn: `${box.x + 1} / span ${box.w}` }}
              />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

interface CardProps {
  href: string;
  name: string;
  outline: readonly OutlineBox[];
  badge: React.ReactNode;
  /** Right of the badge: the window, or when a personal board was edited. */
  meta?: string | null;
  metaTitle?: string;
  purpose?: string | null;
  /** How many lines the purpose may take before it clamps (3 for a built-in's fixed copy). */
  purposeLines?: 2 | 3;
  /** The foot line ("For everyone"). */
  foot?: string | null;
  /** Keep the foot line clear of a button laid over the card foot (Unhide). */
  footReserve?: boolean;
  note?: string | null;
  /** The card's `board` value, so focus can come back to it (the landing card has none). */
  board?: string;
  linkRef?: (el: HTMLAnchorElement | null) => void;
  testId: string;
}

/** One library card: a single link on the tinted panel. */
function BoardCard({
  href,
  name,
  outline,
  badge,
  meta,
  metaTitle,
  purpose,
  purposeLines = 2,
  foot,
  footReserve = false,
  note,
  board,
  linkRef,
  testId,
}: CardProps) {
  const id = React.useId();
  const onClick = useRouteLinkClick(href);
  const describedBy = [`${id}-badge`, meta ? `${id}-meta` : null, purpose ? `${id}-purpose` : null, note ? `${id}-note` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <a
      ref={linkRef}
      href={href}
      onClick={onClick}
      aria-labelledby={`${id}-name`}
      aria-describedby={describedBy}
      data-testid={testId}
      data-board-card={board}
      className={cn(
        'surface-panel flex h-full min-w-0 flex-col gap-3 p-4 text-left transition-colors hover:bg-hover xl:p-5',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <BoardOutline boxes={outline} />
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span id={`${id}-badge`} className="flex min-w-0 flex-wrap items-center gap-1.5">
          {badge}
        </span>
        {meta ? (
          <span id={`${id}-meta`} title={metaTitle} className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {meta}
          </span>
        ) : null}
      </span>
      <span id={`${id}-name`} className="-mt-1 min-w-0 break-words text-md font-semibold text-foreground">
        {name}
      </span>
      {purpose ? (
        <span
          id={`${id}-purpose`}
          title={purpose}
          className={cn('-mt-2 text-sm text-muted-foreground', purposeLines === 3 ? 'line-clamp-3' : 'line-clamp-2')}
        >
          {purpose}
        </span>
      ) : null}
      {note ? (
        <span id={`${id}-note`} className="text-xs text-muted-foreground">
          {note}
        </span>
      ) : null}
      {foot ? (
        <span className={cn('mt-auto pt-1 text-xs text-muted-foreground', footReserve && 'pr-24')}>{foot}</span>
      ) : footReserve ? (
        // Room for the button laid over the foot, so the card keeps its height.
        <span aria-hidden="true" className="mt-auto h-8" />
      ) : null}
    </a>
  );
}

function BuiltinBadge({ label }: { label: 'Default' | 'Built-in' }) {
  return (
    <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-2xs">
      <Lock className="size-3" aria-hidden />
      {label}
    </Badge>
  );
}

function HiddenBadge() {
  return (
    <Badge variant="outline" className="px-1.5 py-0 text-2xs font-normal">
      Hidden
    </Badge>
  );
}

function YoursBadge() {
  return (
    <Badge variant="outline" className="px-1.5 py-0 text-2xs font-normal">
      Yours
    </Badge>
  );
}

/**
 * The dashed tile that ends the Yours grid: a link to the new-board draft, or at the
 * board limit the sentence that says why no other can be added (a draft could never be
 * saved).
 */
function NewBoardTile({ atLimit }: { atLimit: boolean }) {
  const onClick = useRouteLinkClick(NEW_BOARD_HREF);
  if (atLimit) {
    return (
      <p
        data-testid="dashboard-new-tile"
        data-limit=""
        className="flex h-full min-h-40 items-center justify-center rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground"
      >
        {BOARD_LIMIT_TEXT}
      </p>
    );
  }
  return (
    <a
      href={NEW_BOARD_HREF}
      onClick={onClick}
      data-testid="dashboard-new-tile"
      className={cn(
        'flex h-full min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-4',
        'text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <Plus className="size-5" aria-hidden />
      New dashboard
    </a>
  );
}

const GRID = 'grid gap-4 sm:grid-cols-2 xl:grid-cols-4 xl:gap-5';

// --------------------------------------------------------------------------- //
// The library
// --------------------------------------------------------------------------- //

/** One personal board as the library lists it. */
export interface PersonalBoardEntry {
  layout: DashboardLayout;
  /** False for the role default that has not been saved yet. */
  persisted: boolean;
}

export interface DashboardsLibraryProps {
  /** Personal boards, the role default first (`null` while loading). */
  personal: readonly PersonalBoardEntry[] | null;
  /** The personal list failed to load (built-ins stay usable). */
  error?: unknown;
  onRetry: () => void;
  /** Built-ins the viewer hid. */
  hidden: readonly BuiltinBoardId[];
  onUnhide: (id: BuiltinBoardId) => void;
  /** The viewer's permission check. */
  can: PermissionCheck;
  /** Row-level scope for the viewer (case panels are then unavailable). */
  objectScoped?: boolean;
  /** The viewer holds the most personal boards allowed (no new one can be saved). */
  atLimit?: boolean;
}

export function DashboardsLibrary({
  personal,
  error,
  onRetry,
  hidden,
  onUnhide,
  can,
  objectScoped,
  atLimit = false,
}: DashboardsLibraryProps) {
  const [showHidden, setShowHidden] = React.useState(false);
  // After an Unhide the button is gone: the board's card link takes the focus.
  const cardLinks = React.useRef(new Map<string, HTMLAnchorElement>());
  const [focusCard, setFocusCard] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (focusCard === null) return;
    setFocusCard(null);
    cardLinks.current.get(focusCard)?.focus();
  }, [focusCard]);
  const cardLink = React.useCallback(
    (board: string) => (el: HTMLAnchorElement | null) => {
      if (el) cardLinks.current.set(board, el);
      else cardLinks.current.delete(board);
    },
    [],
  );
  const builtins = React.useMemo(() => BUILTIN_BOARDS.filter((b) => builtinVisible(b, can)), [can]);
  const hiddenCount = builtins.filter((b) => hidden.includes(b.id)).length;
  // Derived, not reset: an Unhide that fails puts the board back as hidden and in view.
  const showing = showHidden && hiddenCount > 0;
  const listed = builtins.filter((b) => showing || !hidden.includes(b.id));

  const builtinAside = (
    <>
      <span>Read-only. Duplicate one to make it your own.</span>
      {hiddenCount > 0 ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-sm"
          aria-expanded={showing}
          aria-controls="dashboards-builtin-list"
          onClick={() => setShowHidden(!showing)}
          data-testid="dashboards-show-hidden"
        >
          {showing ? 'Show fewer' : `Show ${hiddenCount.toLocaleString('en-US')} hidden`}
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="space-y-8" data-testid="dashboards-library">
      <section aria-labelledby="dashboards-builtin-title" className="space-y-3">
        <SectionTitle id="dashboards-builtin-title" title="Built-in" aside={builtinAside} />
        <ul id="dashboards-builtin-list" className={GRID}>
          <li className="min-w-0">
            <BoardCard
              testId="dashboard-card-builtin:cyber-defence-center"
              href={LANDING_CARD.href}
              name={LANDING_CARD.name}
              outline={LANDING_CARD.outline}
              badge={<BuiltinBadge label="Default" />}
              meta={BOARD_WINDOWS[LANDING_CARD.window].label}
              purpose={LANDING_CARD.purpose}
              purposeLines={3}
              foot={`For ${LANDING_CARD.audience}`}
            />
          </li>
          {listed.map((board) => {
            const isHidden = hidden.includes(board.id);
            return (
              <li key={board.id} className="relative min-w-0">
                <BoardCard
                  testId={`dashboard-card-${board.id}`}
                  board={board.id}
                  linkRef={cardLink(board.id)}
                  href={boardHref(board.id)}
                  name={board.name}
                  outline={board.outline}
                  badge={
                    <>
                      <BuiltinBadge label={board.badge} />
                      {isHidden ? <HiddenBadge /> : null}
                    </>
                  }
                  meta={BOARD_WINDOWS[board.defaultWindow].label}
                  purpose={board.purpose}
                  purposeLines={3}
                  note={unavailableNote(unavailableWidgetCount(board.widgets, { can, objectScoped }))}
                  foot={`For ${board.audience}`}
                  footReserve={isHidden}
                />
                {isHidden ? (
                  // In the card foot, over the panel: a sibling after the link, never in it.
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="absolute bottom-4 right-4 xl:bottom-5 xl:right-5"
                    aria-label={`Unhide ${board.name}`}
                    onClick={() => {
                      onUnhide(board.id);
                      setFocusCard(board.id);
                    }}
                  >
                    Unhide
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="dashboards-yours-title" className="space-y-3">
        <SectionTitle id="dashboards-yours-title" title="Yours" />
        {error && !personal ? (
          <LoadError error={error} title="Your dashboards could not be loaded." onRetry={onRetry} />
        ) : null}
        <ul className={GRID} aria-busy={!personal && !error ? true : undefined}>
          {!personal && !error ? (
            [0, 1].map((i) => (
              <li key={`skeleton-${i}`} className="min-w-0" data-testid="dashboard-card-skeleton">
                <div className="surface-panel space-y-3 p-4 xl:p-5" aria-hidden="true">
                  <Skeleton className="aspect-[16/7] w-full" />
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              </li>
            ))
          ) : (
            (personal ?? []).map(({ layout, persisted }) => {
              const widgets = layout.widgets ?? [];
              const count = widgetCountText(widgets.length);
              const roleDefault = layout.id === MY_DASHBOARD_ID && !persisted;
              const edited = persisted ? editedText(layout.updated_at ?? layout.created_at) : null;
              const stamp = layout.updated_at ?? layout.created_at;
              const board = boardRouteId(layout.id);
              return (
                <li key={layout.id} className="min-w-0">
                  <BoardCard
                    testId={`dashboard-card-${layout.id}`}
                    board={board}
                    linkRef={cardLink(board)}
                    href={boardHref(board)}
                    name={displayBoardName(layout)}
                    outline={outlineFromWidgets(widgets)}
                    badge={<YoursBadge />}
                    meta={edited}
                    metaTitle={stamp ? formatTimestamp(stamp) : undefined}
                    purpose={roleDefault ? `${count} · your role default` : count}
                    note={unavailableNote(unavailableWidgetCount(widgets, { can, objectScoped }))}
                  />
                </li>
              );
            })
          )}
          <li className="min-w-0">
            <NewBoardTile atLimit={atLimit} />
          </li>
        </ul>
      </section>
    </div>
  );
}

export default DashboardsLibrary;
