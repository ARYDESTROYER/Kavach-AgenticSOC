/**
 * ComposerMenu — the `/` and `@` menus' list, built on the shared cmdk primitive
 * (`src/ui/command.tsx`, SPEC §10.4).
 *
 * Focus never leaves the textarea: the composer filters the items itself
 * (`shouldFilter={false}`), drives the highlighted item through cmdk's controlled
 * `value`, and points the textarea's `aria-activedescendant` at it (the composer reads
 * the rendered option ids back through {@link onListRendered}). Denied scopes stay
 * listed but disabled, with the permission that would unlock them.
 *
 * Round 13 (SPEC-chat T22): one icon per group heading instead of the same glyph on
 * every row; each row is its label (`text-sm`) with the description on a second line
 * (`text-xs`, muted, wrapping, never pushed to the far edge); group headings stay in
 * view while the list scrolls (`sticky top-0 bg-popover`), and the list fades at its
 * bottom edge while more rows are below, so a heading never sits alone at the bottom
 * with no cue that its items are further down. A saved prompt's text is the
 * analyst's own and can be long, so it shows at most two lines here (the library shows
 * it in full).
 *
 * The composer drives the highlight through cmdk's controlled `value`, which never runs
 * cmdk's own scroll-into-view, so the list keeps the highlighted row in view itself
 * ({@link keepOptionInView}): never under its group's sticky heading, never under the
 * bottom fade, and only the list scrolls (never the page). Like cmdk, it never scrolls
 * for a highlight the pointer made: a hover that moved the list would slide another row
 * under the pointer, and the click would choose that row instead.
 */
import * as React from 'react';
import { AtSign, Bookmark, FileText, Library, Slash, Sparkles, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Command, CommandGroup, CommandItem, CommandList } from '@/ui/command';
import type { ComposerMenuGroup, ComposerMenuItem } from './commands';
import { BOTTOM_FADE, useMoreBelow } from './useMoreBelow';

export interface ComposerMenuProps {
  kind: 'slash' | 'at';
  groups: ComposerMenuGroup[];
  active: string;
  onActiveChange: (value: string) => void;
  onChoose: (item: ComposerMenuItem) => void;
  /** Called after each render with the list element (for aria-controls/activedescendant). */
  onListRendered?: (list: HTMLElement | null) => void;
}

/** The one icon a group heading carries (by its first item's kind). */
function groupIcon(group: ComposerMenuGroup): LucideIcon {
  const first = group.items[0];
  if (!first) return Slash;
  if (first.kind === 'scope') return AtSign;
  if (first.kind === 'library') return Library;
  if (first.kind === 'report') return FileText;
  if (first.kind === 'prompt') return first.prompt.starter ? Sparkles : Bookmark;
  return Slash;
}

/** The bottom fade's height (`BOTTOM_FADE`, 1.5rem): a row under it reads as faded. */
const FADE_PX = 24;

/**
 * Scroll `list` (only the list) so `option` sits fully inside its visible box, below
 * the sticky heading of the option's own group and above the bottom fade while the
 * list can scroll further. Does nothing when the option is already clear.
 */
export function keepOptionInView(list: HTMLElement, option: HTMLElement): void {
  const box = list.getBoundingClientRect();
  const row = option.getBoundingClientRect();
  const heading = option.closest('[cmdk-group]')?.querySelector<HTMLElement>('[cmdk-group-heading]');
  const top = box.top + (heading ? heading.getBoundingClientRect().height : 0);
  const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
  const bottom = box.bottom - (atEnd ? 0 : FADE_PX);
  // The browser clamps `scrollTop` to the list's range (at the end the fade is gone).
  if (row.top < top) list.scrollTop -= top - row.top;
  else if (row.bottom > bottom) list.scrollTop += row.bottom - bottom;
}

/** Literal tokens (commands, report templates, @-scopes) read as code. */
const isToken = (item: ComposerMenuItem) => item.kind === 'command' || item.kind === 'report' || item.kind === 'scope';

export function ComposerMenu({ kind, groups, active, onActiveChange, onChoose, onListRendered }: ComposerMenuProps) {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const more = useMoreBelow<HTMLDivElement>();
  const { ref: moreRef } = more;
  const setList = React.useCallback(
    (el: HTMLDivElement | null) => {
      listRef.current = el;
      moreRef(el);
    },
    [moreRef],
  );
  React.useLayoutEffect(() => {
    onListRendered?.(listRef.current);
  });
  /** True while a pointer event on the list is being handled (cmdk selects on pointermove and click). */
  const pointerEvent = React.useRef(false);
  /** The value the pointer last highlighted, until the effect below has seen it. */
  const pointerPick = React.useRef<string | null>(null);
  const markPointer = React.useCallback(() => {
    pointerEvent.current = true;
  }, []);
  const clearPointer = React.useCallback(() => {
    pointerEvent.current = false;
  }, []);
  const onValueChange = React.useCallback(
    (value: string) => {
      pointerPick.current = pointerEvent.current ? value : null;
      pointerEvent.current = false;
      onActiveChange(value);
    },
    [onActiveChange],
  );
  // The highlighted row moved (arrow keys in the textarea, or the list changed under
  // the draft): keep it in view. A row the pointer highlighted is already under the
  // pointer, so the list stays put.
  React.useLayoutEffect(() => {
    const fromPointer = pointerPick.current !== null && pointerPick.current === active;
    pointerPick.current = null;
    if (fromPointer) return;
    const list = listRef.current;
    if (!list || !active) return;
    const option = Array.from(list.querySelectorAll<HTMLElement>('[cmdk-item]')).find(
      (el) => el.getAttribute('data-value') === active,
    );
    if (option) keepOptionInView(list, option);
  }, [active]);
  return (
    <Command shouldFilter={false} value={active} onValueChange={onValueChange} className="rounded-[3px]">
      <CommandList
        ref={setList}
        // Capture runs before the row's own handler (which selects), bubble after it.
        onPointerMoveCapture={markPointer}
        onPointerMove={clearPointer}
        onClickCapture={markPointer}
        onClick={clearPointer}
        label={kind === 'slash' ? 'Commands' : 'Scopes'}
        data-more-below={more.moreBelow ? '' : undefined}
        className={cn('max-h-72 px-1 pb-1', more.moreBelow && BOTTOM_FADE)}
      >
        {groups.map((group) => {
          const Icon = groupIcon(group);
          return (
            <CommandGroup
              key={group.heading}
              heading={
                <span className="flex items-center gap-1.5" data-menu-heading="">
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  {group.heading}
                </span>
              }
              // `overflow-visible`: an overflow box would become the sticky heading's
              // scroll container and the heading would scroll away with its group.
              className={cn(
                'overflow-visible p-0',
                '[&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10',
                '[&_[cmdk-group-heading]]:bg-popover [&_[cmdk-group-heading]]:pt-2',
              )}
            >
              {group.items.map((item) => {
                const disabled = item.kind === 'scope' && item.disabled;
                return (
                  <CommandItem
                    key={item.value}
                    value={item.value}
                    disabled={disabled}
                    onSelect={() => onChoose(item)}
                    className="flex-col items-start gap-0.5 py-1.5"
                  >
                    <span className={cn('max-w-full break-words text-sm text-foreground', isToken(item) && 'font-mono')}>
                      {item.label}
                    </span>
                    {item.hint ? (
                      <span
                        className={cn(
                          'max-w-full break-words text-xs text-muted-foreground',
                          // The analyst's own text can be long; console copy never is.
                          item.kind === 'prompt' && !item.prompt.starter && 'line-clamp-2',
                        )}
                      >
                        {item.hint}
                      </span>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          );
        })}
      </CommandList>
      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-2xs text-muted-foreground" aria-hidden="true">
        <span>↑↓ move</span>
        <span>Enter choose</span>
        <span>Esc close</span>
      </div>
    </Command>
  );
}
