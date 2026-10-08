/**
 * ThreadToolbar — the conversation zone's single 44 px band (chat revamp SPEC §10.1a).
 *
 * Left to right: [History] (only when the rail is a Sheet) · the thread title as the
 * page's `<h2>` (inline rename, full text in a tooltip) · the conversation total
 * "12.4k tokens · $0.03" (only when the toolbar is ≥ 560 px; otherwise inside ⋯) ·
 * [Report · n] (Workspace only) · [New chat] (only when the rail is a Sheet, so exactly
 * one New chat is ever visible) · ⋯ (Rename, Pin conversation, Export conversation ▸,
 * Delete).
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
import { IconButton } from '@/soc/components/IconButton';
import { compactTokens, formatCost } from '../message/format';
import { EXPORT_FORMATS, type ConversationExportFormat } from './HistoryRail';

/** "12.4k tokens · $0.03", or "Usage —" for a legacy thread without totals. */
export function conversationTotal(summary: ChatConversationSummary | null): string | null {
  if (!summary) return null;
  if (typeof summary.total_tokens !== 'number') return 'Usage —';
  const cost = typeof summary.total_cost === 'number' ? ` · ${formatCost(summary.total_cost)}` : '';
  return `${compactTokens(summary.total_tokens)} tokens${cost}`;
}

function TitleEditor({ initial, onCommit, onCancel }: { initial: string; onCommit: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = React.useState(initial);
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const title = value.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (title && title !== initial) onCommit(title);
    else onCancel();
  };
  return (
    <Input
      ref={ref}
      value={value}
      maxLength={80}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
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
  const hintId = `${React.useId().replace(/[^A-Za-z0-9_-]/g, '')}-rename-hint`;
  const total = conversationTotal(summary);
  const saved = !!summary;

  return (
    <div className={cn('flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-3', className)} data-testid="chat-thread-toolbar">
      {railInSheet && !caseScoped ? (
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
      ) : null}

      <div className="min-w-0 flex-1">
        {editing && summary ? (
          <TitleEditor
            initial={summary.title}
            onCommit={(next) => {
              setEditing(false);
              onRename(next);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
              {saved ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
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
        <IconButton label="New chat" onClick={onNewChat} disabled={busy} aria-keyshortcuts={shortcuts?.newChat}>
          <Plus aria-hidden />
        </IconButton>
      ) : null}

      {!caseScoped ? (
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
          <DropdownMenuContent align="end" className="w-56">
            {!wide && total ? (
              <>
                <DropdownMenuLabel className="text-xs font-normal tabular-nums text-muted-foreground">
                  This conversation: {total}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem disabled={!saved} onSelect={() => setEditing(true)}>
              <Pencil aria-hidden />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!saved} onSelect={onTogglePin}>
              {summary?.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
              {summary?.pinned ? 'Unpin conversation' : 'Pin conversation'}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={!saved}>
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
              disabled={!saved || busy}
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
