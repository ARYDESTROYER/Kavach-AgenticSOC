/**
 * ThreadToolbar — the conversation zone's single 44 px band (chat revamp SPEC §10.1a).
 *
 * Left to right: [History] (only when the rail is a Sheet) · the thread title as the
 * page's `<h2>` (inline rename, full text in a tooltip) · the conversation total
 * "12.4k tokens · $0.03" (only when the toolbar is ≥ 560 px; otherwise inside ⋯) ·
 * [Report · n] (Workspace only) · [New chat] (only when the rail is a Sheet, so exactly
 * one New chat is ever visible) · ⋯ (Rename, Pin conversation, Export conversation ▸,
 * Delete; only once the thread is saved — a draft has nothing to act on).
 *
 * Inline rename returns focus to the title when it ends from the keyboard (Enter /
 * Escape); a blur commit leaves focus wherever the reader moved it.
 */
import * as React from 'react';
import { Download, FileText, History, MoreHorizontal, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { ChatConversationSummary } from '@/lib/types';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { shortcutLabel } from '../shortcuts/shortcut-list';
import { compactTokens, formatCost } from '../message/format';
import { EXPORT_FORMATS, HintedIconButton, SHORTCUT_HINT_KEYS, type ConversationExportFormat } from './HistoryRail';

/** "12.4k tokens · $0.03", or "Usage —" for a legacy thread without totals. */
export function conversationTotal(summary: ChatConversationSummary | null): string | null {
  if (!summary) return null;
  if (typeof summary.total_tokens !== 'number') return 'Usage —';
  const cost = typeof summary.total_cost === 'number' ? ` · ${formatCost(summary.total_cost)}` : '';
  return `${compactTokens(summary.total_tokens)} tokens${cost}`;
}

/** How an inline rename ended: from the keyboard (refocus the title) or by blur. */
type EditEnd = 'keyboard' | 'blur';

function TitleEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (title: string, end: EditEnd) => void;
  onCancel: (end: EditEnd) => void;
}) {
  const [value, setValue] = React.useState(initial);
  const ref = React.useRef<HTMLInputElement>(null);
  const endedRef = React.useRef(false);
  React.useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = (end: EditEnd) => {
    // Enter commits and unmounts the field, which also blurs it: end once.
    if (endedRef.current) return;
    endedRef.current = true;
    const title = value.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (title && title !== initial) onCommit(title, end);
    else onCancel(end);
  };
  return (
    <Input
      ref={ref}
      value={value}
      maxLength={80}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit('blur')}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          commit('keyboard');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          endedRef.current = true;
          onCancel('keyboard');
        }
      }}
      className="h-7 max-w-md rounded-sm px-2 text-sm font-semibold"
      aria-label="Conversation title"
    />
  );
}

export interface ThreadToolbarProps {
  title: string;
  /** The saved thread (null for a New-chat draft or case scope). */
  summary: ChatConversationSummary | null;
  /** Case-scoped chat: no report, no thread actions. */
  caseScoped?: boolean;
  /** The rail is a Sheet: show the History trigger and the toolbar's New chat. */
  railInSheet: boolean;
  onOpenHistory: () => void;
  onNewChat: () => void;
  /** The toolbar is ≥ 560 px wide (show the total inline). */
  wide: boolean;
  /** Under 480 px: History and Report keep their icon (and count) only. */
  narrow?: boolean;
  report?: { count: number; open: boolean; onToggle: () => void } | null;
  busy: boolean;
  onRename: (title: string) => void;
  onTogglePin: () => void;
  onExport: (format: ConversationExportFormat) => void;
  onDelete: () => void;
  shortcuts?: { newChat?: string; history?: string };
  className?: string;
}

export function ThreadToolbar({
  title,
  summary,
  caseScoped = false,
  railInSheet,
  onOpenHistory,
  onNewChat,
  wide,
  narrow = false,
  report = null,
  busy,
  onRename,
  onTogglePin,
  onExport,
  onDelete,
  shortcuts,
  className,
}: ThreadToolbarProps) {
  const [editing, setEditing] = React.useState(false);
  const [refocusTitle, setRefocusTitle] = React.useState(false);
  const titleButtonRef = React.useRef<HTMLButtonElement>(null);
  // ⋯ → Rename: the field must mount only after the menu has closed. Radix flushes an
  // item's onSelect synchronously while the menu (and its focus trap) is still open, so
  // a field mounted there would lose focus to the trap at once — and its blur commits.
  const renamingRef = React.useRef(false);
  const hintId = `${React.useId().replace(/[^A-Za-z0-9_-]/g, '')}-rename-hint`;
  const total = conversationTotal(summary);
  const saved = !!summary;

  React.useEffect(() => {
    if (!refocusTitle || editing) return;
    titleButtonRef.current?.focus();
    setRefocusTitle(false);
  }, [editing, refocusTitle]);
  const endEdit = (end: EditEnd) => {
    setEditing(false);
    if (end === 'keyboard') setRefocusTitle(true);
  };

  return (
    <div className={cn('flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-3', className)} data-testid="chat-thread-toolbar">
      {railInSheet && !caseScoped ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 gap-1.5 px-2"
              onClick={onOpenHistory}
              aria-label={narrow ? 'History' : undefined}
              aria-keyshortcuts={shortcuts?.history}
            >
              <History aria-hidden />
              {narrow ? null : 'History'}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{`History (${shortcutLabel(SHORTCUT_HINT_KEYS.toggleHistory)})`}</TooltipContent>
        </Tooltip>
      ) : null}

      <div className="min-w-0 flex-1">
        {editing && summary ? (
          <TitleEditor
            initial={summary.title}
            onCommit={(next, end) => {
              endEdit(end);
              onRename(next);
            }}
            onCancel={endEdit}
          />
        ) : (
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
              {saved ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      ref={titleButtonRef}
                      type="button"
                      className="max-w-full truncate rounded-sm text-left hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setEditing(true)}
                      aria-describedby={hintId}
                    >
                      {title}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-md break-words">
                    {title}
                  </TooltipContent>
                </Tooltip>
              ) : (
                title
              )}
            </h2>
            {saved ? (
              <span id={hintId} hidden>
                Activate to rename this conversation
              </span>
            ) : null}
            {wide && total ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="conversation-total">
                {total}
              </span>
            ) : null}
          </div>
        )}
      </div>

      {report && !caseScoped ? (
        <Button
          type="button"
          variant={report.open ? 'secondary' : 'ghost'}
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2"
          aria-pressed={report.open}
          aria-label={narrow ? `Report · ${report.count}` : undefined}
          onClick={report.onToggle}
        >
          <FileText aria-hidden />
          {narrow ? null : 'Report'}
          <span className="tabular-nums text-muted-foreground">{narrow ? report.count : `· ${report.count}`}</span>
        </Button>
      ) : null}

      {railInSheet && !caseScoped ? (
        <HintedIconButton
          label="New chat"
          hint={SHORTCUT_HINT_KEYS.newChat}
          tooltipSide="bottom"
          onClick={onNewChat}
          disabled={busy}
          aria-keyshortcuts={shortcuts?.newChat}
        >
          <Plus aria-hidden />
        </HintedIconButton>
      ) : null}

      {!caseScoped && saved ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Conversation actions"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56"
            onCloseAutoFocus={(event) => {
              if (!renamingRef.current) return;
              renamingRef.current = false;
              // Not back to ⋯: the title field takes focus as it mounts.
              event.preventDefault();
              setEditing(true);
            }}
          >
            {!wide && total ? (
              <>
                <DropdownMenuLabel className="text-xs font-normal tabular-nums text-muted-foreground">
                  This conversation: {total}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              onSelect={() => {
                renamingRef.current = true;
              }}
            >
              <Pencil aria-hidden />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onTogglePin}>
              {summary?.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
              {summary?.pinned ? 'Unpin conversation' : 'Pin conversation'}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Download aria-hidden />
                Export conversation
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {EXPORT_FORMATS.map(({ format, label }) => (
                  <DropdownMenuItem key={format} onSelect={() => onExport(format)}>
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={busy}
              className="text-critical-text focus:text-critical-text"
              onSelect={onDelete}
            >
              <Trash2 aria-hidden />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
