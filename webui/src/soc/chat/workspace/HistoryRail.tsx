/**
 * HistoryRail — the Workspace conversation list (chat revamp SPEC §10.2), docked at
 * 264 px or inside the left History Sheet, plus the 48 px icon strip it collapses to.
 *
 *  - Header: New chat and a server-side content search (`?q=`) whose hits show a
 *    snippet under the title; opening a hit selects that thread and highlights the
 *    matching message.
 *  - Groups: Pinned, Today, Yesterday, Previous 7 days, Previous 30 days, then month.
 *  - One-line rows: title + relative time, with the full title and exact date in a
 *    tooltip. The accessible name is "<title> — <exact date> · N messages"; the active
 *    row carries `aria-current`. ↑/↓/Home/End move between rows (one roving tab stop
 *    that always lands on an existing, enabled row).
 *  - Group labels are labels of `role="group"`, not headings: the page's heading
 *    outline is h1 Chat → h2 thread title → h3 turns (SPEC §10.1a).
 *  - Inline rename returns focus to the row it replaced.
 *  - Row menu: Rename (inline), Pin/Unpin, Open report (when the thread has one),
 *    Export ▸, Delete (disabled for the thread a turn is running in).
 *  - Footer: the retention note when history was truncated or ≥ 45 threads exist.
 *
 * History truth is fail-closed: a read failure is an explicit retryable error, never
 * the calm "No previous conversations" state. Titles and snippets are display text.
 */
import * as React from 'react';
import {
  Check,
  Download,
  FileText,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatTimestamp } from '@/lib/format';
import type { ChatConversationSearchHit, ChatConversationSummary } from '@/lib/types';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { LoadingState } from '@/design-system/loading';
import { IconButton, type IconButtonProps } from '@/soc/components/IconButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { UNTITLED_CONVERSATION } from '../chat-api';
import { shortcutLabel, type ShortcutKey } from '../shortcuts/shortcut-list';
import type { ChatRetentionInfo } from '../useChatConversations';

export type ConversationExportFormat = 'markdown' | 'html' | 'print';

export const EXPORT_FORMATS: ReadonlyArray<{ format: ConversationExportFormat; label: string }> = [
  { format: 'markdown', label: 'Markdown (.md)' },
  { format: 'html', label: 'HTML (.html)' },
  { format: 'print', label: 'Print / Save as PDF' },
];

/* -------------------------------------------------------------------------- */
/* Grouping and time labels (pure; exported for tests).                        */
/* -------------------------------------------------------------------------- */

export interface HistoryGroup {
  label: string;
  conversations: ChatConversationSummary[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Calendar-day ordinal in local time (immune to 23/25-hour DST days). */
const localDay = (date: Date) => Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);

/** Pinned first (as listed), then Today / Yesterday / Previous 7 days / Previous 30 days / month. */
export function groupConversations(conversations: readonly ChatConversationSummary[], now = new Date()): HistoryGroup[] {
  const pinned: ChatConversationSummary[] = [];
  const fixed: HistoryGroup[] = [
    { label: 'Today', conversations: [] },
    { label: 'Yesterday', conversations: [] },
    { label: 'Previous 7 days', conversations: [] },
    { label: 'Previous 30 days', conversations: [] },
  ];
  const months = new Map<string, HistoryGroup>();
  const today = localDay(now);
  for (const conversation of conversations) {
    if (conversation.pinned) {
      pinned.push(conversation);
      continue;
    }
    const ms = Date.parse(conversation.updated_at);
    if (!Number.isFinite(ms)) {
      const older = months.get('Older') ?? { label: 'Older', conversations: [] };
      older.conversations.push(conversation);
      months.set('Older', older);
      continue;
    }
    const date = new Date(ms);
    const age = Math.max(0, today - localDay(date));
    if (age === 0) fixed[0].conversations.push(conversation);
    else if (age === 1) fixed[1].conversations.push(conversation);
    else if (age < 7) fixed[2].conversations.push(conversation);
    else if (age < 30) fixed[3].conversations.push(conversation);
    else {
      const label = date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      const group = months.get(label) ?? { label, conversations: [] };
      group.conversations.push(conversation);
      months.set(label, group);
    }
  }
  const out: HistoryGroup[] = [];
  if (pinned.length) out.push({ label: 'Pinned', conversations: pinned });
  out.push(...fixed.filter((group) => group.conversations.length));
  // Months keep the newest-first order the rows arrived in; "Older" (unparsable) last.
  const monthGroups = Array.from(months.values());
  out.push(...monthGroups.filter((g) => g.label !== 'Older'), ...monthGroups.filter((g) => g.label === 'Older'));
  return out;
}

/** "now", "5m", "3h", "Tue", "Sep 12", "Sep 2025" — the row's quiet time stamp. */
export function shortAge(iso: string, now = new Date()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const diff = Math.max(0, now.getTime() - ms);
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  const date = new Date(ms);
  const days = localDay(now) - localDay(date);
  if (days === 0) return `${Math.floor(diff / 3_600_000)}h`;
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/* -------------------------------------------------------------------------- */
/* Shortcut hints.                                                             */
/* -------------------------------------------------------------------------- */

/** The visible keys of the rail / toolbar shortcuts (SPEC §10.4a). */
export const SHORTCUT_HINT_KEYS = {
  newChat: ['Mod', 'Shift', 'O'],
  toggleHistory: ['Mod', 'Shift', 'S'],
} as const satisfies Record<string, readonly ShortcutKey[]>;

/**
 * An icon button whose tooltip adds the keyboard shortcut ("New chat (Ctrl+Shift+O)")
 * while its accessible name stays the plain label; `aria-keyshortcuts` carries the
 * machine form.
 */
export function HintedIconButton({
  label,
  hint,
  tooltipSide = 'top',
  ...props
}: Omit<IconButtonProps, 'tooltip'> & { hint?: readonly ShortcutKey[] }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton label={label} tooltip={false} {...props} />
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{hint ? `${label} (${shortcutLabel(hint)})` : label}</TooltipContent>
    </Tooltip>
  );
}

function rowName(conversation: ChatConversationSummary): string {
  const count = conversation.message_count;
  return `${conversation.title || UNTITLED_CONVERSATION} — ${formatTimestamp(conversation.updated_at)} · ${count} ${count === 1 ? 'message' : 'messages'}`;
}

/* -------------------------------------------------------------------------- */
/* Rows.                                                                       */
/* -------------------------------------------------------------------------- */

interface RowActions {
  activeId: string | null | undefined;
  /** A turn is running: selection is refused and the active thread cannot be deleted. */
  busy: boolean;
  onSelect: (conversation: ChatConversationSummary) => void;
  onRename: (conversation: ChatConversationSummary, title: string) => void;
  onTogglePin: (conversation: ChatConversationSummary) => void;
  onOpenReport?: (conversation: ChatConversationSummary) => void;
  onExport?: (conversation: ChatConversationSummary, format: ConversationExportFormat) => void;
  onDelete: (conversation: ChatConversationSummary) => void;
}

function RenameField({
  conversation,
  onCommit,
  onCancel,
}: {
  conversation: ChatConversationSummary;
  onCommit: (title: string) => void;
  /** Escape, Cancel, or a commit with no change. */
  onCancel: () => void;
}) {
  const [value, setValue] = React.useState(conversation.title);
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const title = value.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (title && title !== conversation.title) onCommit(title);
    else onCancel();
  };
  return (
    <div className="flex h-8 items-center gap-1 px-1">
      <Input
        ref={ref}
        value={value}
        maxLength={80}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // An IME composition's Enter picks a candidate; it must not commit.
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        className="h-7 rounded-sm px-2 text-sm"
        aria-label={`Rename ${conversation.title || UNTITLED_CONVERSATION}`}
      />
      <IconButton label="Save conversation name" size="sm" onClick={commit}>
        <Check aria-hidden />
      </IconButton>
      <IconButton label="Cancel rename" size="sm" onClick={onCancel}>
        <X aria-hidden />
      </IconButton>
    </div>
  );
}

function RowMenu({ conversation, actions, onRename, tabIndex }: { conversation: ChatConversationSummary; actions: RowActions; onRename: () => void; tabIndex: number }) {
  const title = conversation.title || UNTITLED_CONVERSATION;
  const deleteLocked = actions.busy && actions.activeId === conversation.id;
  // Selection is refused while a turn runs, so another thread's report cannot open yet.
  const reportLocked = actions.busy && actions.activeId !== conversation.id;
  // Rename replaces the row (and this trigger) with a field that takes focus. It starts
  // only once the menu has closed: Radix runs an item's onSelect synchronously while the
  // menu's focus trap is still active, which would pull focus back out of the field.
  const renamingRef = React.useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          tabIndex={tabIndex}
          aria-label={`Actions for ${title}`}
          className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-48"
        onCloseAutoFocus={(event) => {
          if (!renamingRef.current) return;
          renamingRef.current = false;
          // Not back to the trigger, which the rename field replaces.
          event.preventDefault();
          onRename();
        }}
      >
        <DropdownMenuItem
          onSelect={() => {
            renamingRef.current = true;
          }}
        >
          <Pencil aria-hidden />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onTogglePin(conversation)}>
          {conversation.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
          {conversation.pinned ? 'Unpin' : 'Pin'}
        </DropdownMenuItem>
        {conversation.report_id && actions.onOpenReport ? (
          <DropdownMenuItem disabled={reportLocked} onSelect={() => actions.onOpenReport?.(conversation)}>
            <FileText aria-hidden />
            {reportLocked ? 'Open report (answer in progress)' : 'Open report'}
          </DropdownMenuItem>
        ) : null}
        {actions.onExport ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {/* A sub-trigger does not size its icon like a menu item does (16 px, muted). */}
              <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              Export
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {EXPORT_FORMATS.map(({ format, label }) => (
                <DropdownMenuItem key={format} onSelect={() => actions.onExport?.(conversation, format)}>
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-critical-text focus:text-critical-text"
          disabled={deleteLocked}
          onSelect={() => actions.onDelete(conversation)}
        >
          <Trash2 aria-hidden />
          {deleteLocked ? 'Delete (answer in progress)' : 'Delete'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* -------------------------------------------------------------------------- */
/* The rail.                                                                   */
/* -------------------------------------------------------------------------- */

export interface HistoryRailSearch {
  query: string;
  setQuery: (query: string) => void;
  results: ChatConversationSearchHit[] | null;
  searching: boolean;
  error: string | null;
  openHit: (hit: ChatConversationSearchHit) => void;
}

export interface HistoryRailProps extends RowActions {
  conversations: readonly ChatConversationSummary[];
  loading: boolean;
  error: string | null;
  retention: ChatRetentionInfo;
  search: HistoryRailSearch;
  onRetry: () => void;
  onNewChat: () => void;
  /** Docked rail: collapse to the icon strip (Ctrl/Cmd+Shift+S). */
  onCollapse?: () => void;
  autoFocusSearch?: boolean;
  /** `aria-keyshortcuts` for New chat / the collapse toggle. */
  shortcuts?: { newChat?: string; toggle?: string };
  /** Leave room for a Sheet's own close button in the header. */
  inSheet?: boolean;
  className?: string;
}

export function HistoryRail({
  conversations,
  loading,
  error,
  retention,
  search,
  onRetry,
  onNewChat,
  onCollapse,
  autoFocusSearch = false,
  shortcuts,
  inSheet = false,
  className,
  ...actions
}: HistoryRailProps) {
  const { activeId, busy } = actions;
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [focusIndex, setFocusIndex] = React.useState<number | null>(null);
  /** A row to focus once it renders again (after an inline rename ends). */
  const [refocusId, setRefocusId] = React.useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const headingPrefix = `chat-history-${React.useId().replace(/[^A-Za-z0-9_-]/g, '')}`;

  React.useEffect(() => {
    if (autoFocusSearch) searchRef.current?.focus();
  }, [autoFocusSearch]);

  const searching = search.query.trim().length > 0;
  const groups = React.useMemo(() => groupConversations(conversations), [conversations]);
  const ordered = React.useMemo(() => groups.flatMap((group) => group.conversations), [groups]);
  const activeIndex = ordered.findIndex((row) => row.id === activeId);
  const rowDisabled = (index: number) => busy && ordered[index]?.id !== activeId;
  // The one tab stop: the last focused row while it still exists and is enabled, else
  // the active row, else the first row. A deleted row or a shorter list never leaves
  // the history without a tab stop.
  const tabStop = (() => {
    if (focusIndex !== null && focusIndex < ordered.length && !rowDisabled(focusIndex)) return focusIndex;
    if (activeIndex >= 0) return activeIndex;
    const firstEnabled = ordered.findIndex((_, index) => !rowDisabled(index));
    return firstEnabled >= 0 ? firstEnabled : 0;
  })();
  const tabIndexFor = (index: number) => (index === tabStop ? 0 : -1);

  React.useEffect(() => {
    if (!refocusId) return;
    const row = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-rail-row]') ?? []).find(
      (candidate) => candidate.dataset.conversationId === refocusId,
    );
    row?.focus();
    setRefocusId(null);
  }, [refocusId, renamingId]);

  const endRename = (id: string) => {
    setRenamingId(null);
    setRefocusId(id);
  };

  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    // Only the rows rove: keys in the rename field or on a row's ⋯ trigger (which
    // opens its menu on ArrowDown) keep their own meaning.
    if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-rail-row]')) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-rail-row]') ?? []);
    if (!rows.length) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : Math.min(rows.length - 1, current + 1);
    if (event.key === 'ArrowUp') next = current < 0 ? 0 : Math.max(0, current - 1);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = rows.length - 1;
    event.preventDefault();
    setFocusIndex(next);
    rows[next]?.focus();
  };

  const showEmpty = !loading && !error && conversations.length === 0;

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className={cn('shrink-0 space-y-2 px-3 pb-2 pt-3', inSheet && 'pr-12')}>
        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 flex-1 justify-start gap-2"
                onClick={onNewChat}
                disabled={busy}
                aria-keyshortcuts={shortcuts?.newChat}
              >
                <Plus aria-hidden />
                New chat
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{`New chat (${shortcutLabel(SHORTCUT_HINT_KEYS.newChat)})`}</TooltipContent>
          </Tooltip>
          {onCollapse ? (
            <HintedIconButton
              label="Collapse history"
              hint={SHORTCUT_HINT_KEYS.toggleHistory}
              onClick={onCollapse}
              aria-keyshortcuts={shortcuts?.toggle}
            >
              <PanelLeftClose aria-hidden />
            </HintedIconButton>
          ) : null}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={searchRef}
            type="search"
            value={search.query}
            onChange={(event) => search.setQuery(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="h-8 rounded-md pl-8 text-sm"
          />
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Chat history" aria-busy={loading || search.searching}>
        {searching ? (
          <SearchResults search={search} busy={busy} headingPrefix={headingPrefix} />
        ) : (
          <>
            {loading && conversations.length === 0 ? (
              <LoadingState layout="inline" label="Loading conversations" className="px-2 py-4" />
            ) : null}
            {error ? (
              <div className="mx-1 my-2 border-l-2 border-critical px-2 py-1 text-xs text-muted-foreground" role="note">
                <p>{error}</p>
                <Button type="button" size="sm" variant="ghost" className="mt-1 h-7 px-2" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            ) : null}
            {showEmpty ? (
              <div className="px-2 py-6">
                <p className="text-sm font-medium text-foreground">No previous conversations</p>
                <p className="mt-1 text-xs text-muted-foreground">A conversation appears here after its first answer.</p>
              </div>
            ) : null}
            {/* Arrow keys move between rows (one roving tab stop for the whole list). */}
            {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
            <div ref={listRef} onKeyDown={moveFocus}>
              {groups.map((group) => {
                const headingId = `${headingPrefix}-${group.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
                return (
                  <div key={group.label} role="group" aria-labelledby={headingId} className="pt-2">
                    <p id={headingId} className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
                      {group.label}
                    </p>
                    <ul className="space-y-px">
                      {group.conversations.map((conversation) => {
                        const index = ordered.indexOf(conversation);
                        const active = conversation.id === activeId;
                        const tabIndex = tabIndexFor(index);
                        if (renamingId === conversation.id) {
                          return (
                            <li key={conversation.id}>
                              <RenameField
                                conversation={conversation}
                                onCommit={(title) => {
                                  endRename(conversation.id);
                                  actions.onRename(conversation, title);
                                }}
                                onCancel={() => endRename(conversation.id)}
                              />
                            </li>
                          );
                        }
                        return (
                          <li key={conversation.id} className="group/row relative">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  data-rail-row=""
                                  data-conversation-id={conversation.id}
                                  tabIndex={tabIndex}
                                  aria-current={active ? 'page' : undefined}
                                  aria-label={rowName(conversation)}
                                  disabled={busy && !active}
                                  onFocus={() => setFocusIndex(index)}
                                  onClick={() => actions.onSelect(conversation)}
                                  className={cn(
                                    // No reserved gutter: the ⋯ menu takes the time's place on
                                    // hover/focus (the time keeps a 28 px box for it), so titles use
                                    // the full row at rest.
                                    'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors motion-reduce:transition-none',
                                    'hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                                    'disabled:cursor-not-allowed disabled:opacity-60',
                                    active ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground',
                                  )}
                                >
                                  <span className="min-w-0 flex-1 truncate">{conversation.title || UNTITLED_CONVERSATION}</span>
                                  <span
                                    // Hidden whenever the ⋯ trigger shows: on hover, on focus,
                                    // and while its menu is open (focus is then in the portalled
                                    // menu and the pointer may have left the row).
                                    className="min-w-7 shrink-0 text-right text-2xs tabular-nums text-muted-foreground group-focus-within/row:invisible group-hover/row:invisible group-has-[[data-state=open]]/row:invisible"
                                    aria-hidden
                                  >
                                    {shortAge(conversation.updated_at)}
                                  </span>
                                </button>
                              </TooltipTrigger>
                              {/* The full title (rows truncate) and the exact date (SPEC §10.2). */}
                              <TooltipContent side="right" className="max-w-xs break-words">
                                <span className="block font-medium">{conversation.title || UNTITLED_CONVERSATION}</span>
                                <span className="block text-muted-foreground">{formatTimestamp(conversation.updated_at)}</span>
                              </TooltipContent>
                            </Tooltip>
                            <RowMenu
                              conversation={conversation}
                              actions={actions}
                              tabIndex={tabIndex}
                              onRename={() => setRenamingId(conversation.id)}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </nav>

      {retention.showNote ? (
        <p className="shrink-0 border-t border-border px-3 py-2 text-2xs leading-relaxed text-muted-foreground" role="note">
          {retention.truncated
            ? `Showing the latest ${conversations.length}${retention.total > conversations.length ? ` of ${retention.total}` : ''} conversations. Older ones were removed by retention; pin up to 10 to keep them.`
            : `Chat keeps your latest ${retention.limit} conversations. Pin up to 10 to keep them.`}
        </p>
      ) : null}
    </div>
  );
}

const foldText = (text: string) => text.replace(/\u2026/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The match snippet worth showing under a hit's title: none when it only repeats the
 * title (a hit in the title, or in the first question the title was made from), so a
 * result never shows, or a screen reader never reads, the same sentence twice.
 */
export function distinctSnippet(title: string, snippet: string | null | undefined): string {
  if (!snippet) return '';
  const a = foldText(snippet);
  const b = foldText(title);
  if (!a || a === b || b.startsWith(a) || a.startsWith(b)) return '';
  return snippet;
}

function SearchResults({ search, busy, headingPrefix }: { search: HistoryRailSearch; busy: boolean; headingPrefix: string }) {
  const results = search.results;
  const headingId = `${headingPrefix}-results`;
  return (
    <div role="group" aria-labelledby={headingId} className="pt-2">
      <p id={headingId} className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
        {search.searching ? 'Searching…' : results ? `${results.length} ${results.length === 1 ? 'match' : 'matches'}` : 'Search'}
      </p>
      {search.error ? (
        <p className="px-2 py-2 text-xs text-muted-foreground" role="note">
          {search.error}
        </p>
      ) : null}
      {results && results.length === 0 && !search.searching && !search.error ? (
        <div className="px-2 py-4">
          <p className="text-sm font-medium text-foreground">No matching conversations</p>
          <p className="mt-1 text-xs text-muted-foreground">Search looks at titles, questions, answers and chart titles.</p>
        </div>
      ) : null}
      <ul className="space-y-px">
        {(results ?? []).map((hit) => {
          const title = hit.title || UNTITLED_CONVERSATION;
          const snippet = distinctSnippet(title, hit.match?.snippet);
          return (
            <li key={hit.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => search.openHit(hit)}
                aria-label={`${title}${snippet ? ` — ${snippet}` : ''}`}
                className="block w-full min-w-0 rounded-md px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60"
              >
                <span className="block truncate text-sm text-foreground">{title}</span>
                {snippet ? <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{snippet}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The 48 px strip.                                                            */
/* -------------------------------------------------------------------------- */

export interface HistoryStripProps {
  onNewChat: () => void;
  onSearch: () => void;
  onExpand: () => void;
  busy: boolean;
  shortcuts?: { newChat?: string; toggle?: string };
}

/** The collapsed rail: New chat, Search, Expand (SPEC §10.1). */
export function HistoryStrip({ onNewChat, onSearch, onExpand, busy, shortcuts }: HistoryStripProps) {
  return (
    <nav className="flex h-full flex-col items-center gap-1 py-3" aria-label="Chat history">
      <HintedIconButton
        label="New chat"
        hint={SHORTCUT_HINT_KEYS.newChat}
        tooltipSide="right"
        onClick={onNewChat}
        disabled={busy}
        aria-keyshortcuts={shortcuts?.newChat}
      >
        <Plus aria-hidden />
      </HintedIconButton>
      <IconButton label="Search chats" tooltipSide="right" onClick={onSearch}>
        <Search aria-hidden />
      </IconButton>
      <HintedIconButton
        label="Show history"
        hint={SHORTCUT_HINT_KEYS.toggleHistory}
        tooltipSide="right"
        onClick={onExpand}
        aria-keyshortcuts={shortcuts?.toggle}
      >
        <PanelLeftOpen aria-hidden />
      </HintedIconButton>
    </nav>
  );
}
