/**
 * ThreadToolbar — the conversation zone's single 44 px band (chat revamp SPEC §10.1a).
 *
 * Left to right: [History] (only when the rail is a Sheet) · the thread title as the
 * page's `<h2>` (inline rename, full text in a tooltip) · [Report n] (Workspace only) ·
 * [New chat] (only when the rail is a Sheet, so exactly one New chat is ever visible) ·
 * ⋯ (the thread menu).
 *
 * Round 13 (SPEC-chat T6, T10, T21, T26, T36):
 *  - The title (now written by the model with the first answer) renders as text only.
 *    While a New chat's first answer is written, the host passes the temporary row
 *    (`isPendingThreadRow`): its client title shows, with no thread actions until saved.
 *  - No inline total: the thread menu's first line reads "This chat: 12.4k tokens ·
 *    $0.03" ("Usage not recorded" for an older thread; never a dash placeholder).
 *  - The menu: the usage line, then Rename, Pin (Unpin), Export ▸, Save conversation as
 *    report and Delete (the rail's words), a separator, then a "View" group with the
 *    conversation width as three choices described in words, not pixels.
 *
 * Save conversation as report (Round 12 SPEC D11, SYNTHESIS-chat P0-7): every answer of
 * this saved Workspace thread becomes one section of a NEW report, resolved on the server
 * from the persisted conversation (`POST /api/reports/from-conversation`; the client sends
 * only the id). A toast links to the report; a failed save that may succeed again offers
 * "Try again" with the same idempotency key, so a retry never makes a duplicate. Case
 * chat has no thread actions, so a case conversation can never be saved this way.
 *
 * Report (Round 12, diagnosis/layout.md (f1)): the count of items the analyst ADDED from
 * this chat shows only when there are any, as a badge, never "Report · 0"; the tooltip
 * and the accessible name say what it counts, so it does not read as the number of
 * reports an answer wrote.
 *
 * Width (Round 12 SPEC D12): the viewer's conversation width, Comfortable / Wide /
 * Full width, offered on drafts too (it is a viewer preference, not a thread action).
 *
 * Inline rename returns focus to the title when it ends from the keyboard (Enter /
 * Escape); a blur commit leaves focus wherever the reader moved it.
 */
import * as React from 'react';
import { Download, FilePlus2, FileText, History, MoreHorizontal, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/cn';
import type { ChatConversationSummary } from '@/lib/types';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { useNavigateOptional } from '@/soc/router';
import { shortcutLabel } from '../shortcuts/shortcut-list';
import {
  conversationReportErrorMessage,
  conversationReportRetryable,
  conversationReportSummary,
  newConversationReportKey,
  saveConversationAsReport,
} from '../report/from-conversation';
import { emitReportChanged } from '../report/report-sync';
import { compactTokens, formatCost } from '../message/format';
import { LANE_WIDTHS, LANE_WIDTH_HINT, LANE_WIDTH_LABEL, isLaneWidth, type ChatLaneWidth } from '../message/lane';
import { isPendingThreadRow } from '../useChatConversations';
import { EXPORT_FORMATS, HintedIconButton, SHORTCUT_HINT_KEYS, type ConversationExportFormat } from './HistoryRail';

/** The usage line of a thread saved before totals were recorded (T36: no dash). */
export const USAGE_NOT_RECORDED = 'Usage not recorded';

/** "12.4k tokens · $0.03", or "Usage not recorded" for a legacy thread without totals. */
export function conversationTotal(summary: ChatConversationSummary | null): string | null {
  if (!summary || isPendingThreadRow(summary)) return null;
  if (typeof summary.total_tokens !== 'number') return USAGE_NOT_RECORDED;
  const cost = typeof summary.total_cost === 'number' ? ` · ${formatCost(summary.total_cost)}` : '';
  return `${compactTokens(summary.total_tokens)} tokens${cost}`;
}

/** The thread menu's first line (T10): "This chat: 12.4k tokens · $0.03". */
export function conversationUsageLine(summary: ChatConversationSummary | null): string | null {
  const total = conversationTotal(summary);
  if (total === null || total === USAGE_NOT_RECORDED) return total;
  return `This chat: ${total}`;
}

/** "Report" plus the added-item count only when there is one (never "· 0"). */
export function reportButtonLabel(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return n > 0 ? `Report, ${n} ${n === 1 ? 'item' : 'items'} added` : 'Report';
}

/** The Report control's tooltip: what the count means, and what the panel is for. */
export function reportButtonHint(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n === 0) return 'Collect answers and blocks from this chat into a report';
  return `${n} ${n === 1 ? 'item' : 'items'} you added from this chat`;
}

/** The note under the toast when an answer was still being written during the save. */
export const SAVE_REPORT_RUNNING_NOTE = 'The answer still being written is not included.';

/**
 * Save one Workspace conversation as a new report, with a toast that opens it. One save
 * runs at a time; a retryable failure offers "Try again" with the same key.
 */
export function useSaveConversationAsReport(conversationId: string | null) {
  const navigate = useNavigateOptional();
  const [saving, setSaving] = React.useState(false);
  const inFlight = React.useRef(false);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = React.useCallback(
    async (id: string, key: string, running: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setSaving(true);
      try {
        const result = await saveConversationAsReport({ conversationId: id, idempotencyKey: key });
        // A standalone report (no conversation draft): the Reports library refreshes, the
        // conversation's own draft report is untouched.
        emitReportChanged({ reportId: result.report.id, conversationId: null, report: result.report, origin: 'thread-menu' });
        const summary = conversationReportSummary(result);
        toast.success(result.created ? 'Saved to Reports' : 'Already saved to Reports', {
          description: `${result.report.title} · ${summary}${running ? `. ${SAVE_REPORT_RUNNING_NOTE}` : ''}`,
          action: { label: 'Open report', onClick: () => navigate('reports', { reportId: result.report.id }) },
        });
      } catch (error) {
        const retry = conversationReportRetryable(error);
        toast.error(conversationReportErrorMessage(error), {
          action: retry ? { label: 'Try again', onClick: () => void run(id, key, running) } : undefined,
        });
      } finally {
        inFlight.current = false;
        if (alive.current) setSaving(false);
      }
    },
    [navigate],
  );

  const save = React.useCallback(
    (running = false) => {
      if (!conversationId) return;
      void run(conversationId, newConversationReportKey(), running);
    },
    [conversationId, run],
  );

  return { save, saving };
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
  /**
   * The toolbar is ≥ 560 px wide. Kept for hosts; since Round 13 (T10) the total never
   * shows inline at any width (it is the thread menu's first line).
   */
  wide?: boolean;
  /** Under 480 px: History and Report keep their icon (and count) only. */
  narrow?: boolean;
  report?: { count: number; open: boolean; onToggle: () => void } | null;
  busy: boolean;
  onRename: (title: string) => void;
  onTogglePin: () => void;
  onExport: (format: ConversationExportFormat) => void;
  onDelete: () => void;
  shortcuts?: { newChat?: string; history?: string };
  /** The viewer's conversation width (the ⋯ menu's Width submenu). */
  laneWidth?: { value: ChatLaneWidth; onChange: (width: ChatLaneWidth) => void } | null;
  className?: string;
}

export function ThreadToolbar({
  title,
  summary,
  caseScoped = false,
  railInSheet,
  onOpenHistory,
  onNewChat,
  narrow = false,
  report = null,
  busy,
  onRename,
  onTogglePin,
  onExport,
  onDelete,
  shortcuts,
  laneWidth = null,
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
  const usage = conversationUsageLine(summary);
  // A New chat's first turn is not a saved thread yet (T21): no rename, no actions.
  const saved = !!summary && !isPendingThreadRow(summary);
  const saveReport = useSaveConversationAsReport(caseScoped ? null : (summary?.id ?? null));
  const threadActions = !caseScoped && saved;
  const showMenu = threadActions || !!laneWidth;
  const viewLabelId = `${hintId}-view`;

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
          </div>
        )}
      </div>

      {report && !caseScoped ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={report.open ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 shrink-0 gap-1.5 px-2"
              aria-pressed={report.open}
              aria-label={reportButtonLabel(report.count)}
              onClick={report.onToggle}
              data-testid="chat-report-toggle"
            >
              <FileText aria-hidden />
              {narrow ? null : 'Report'}
              {report.count > 0 ? (
                <span
                  aria-hidden
                  className="min-w-[1.25rem] rounded-full bg-muted px-1.5 text-center text-2xs font-medium tabular-nums text-foreground"
                  data-testid="chat-report-count"
                >
                  {report.count}
                </span>
              ) : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{reportButtonHint(report.count)}</TooltipContent>
        </Tooltip>
      ) : null}

      {railInSheet && !caseScoped ? (
        <HintedIconButton
          label="New chat"
          hint={SHORTCUT_HINT_KEYS.newChat}
          tooltipSide="bottom"
          onClick={onNewChat}
          aria-keyshortcuts={shortcuts?.newChat}
        >
          <Plus aria-hidden />
        </HintedIconButton>
      ) : null}

      {showMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={threadActions ? 'Conversation actions' : 'Conversation options'}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            // The 16 px screen-edge gap the composer layers keep (SPEC-chat T23, audit C8).
            collisionPadding={16}
            // Wide enough that "Save conversation as report" stays on one line.
            className="w-64"
            onCloseAutoFocus={(event) => {
              if (!renamingRef.current) return;
              renamingRef.current = false;
              // Not back to ⋯: the title field takes focus as it mounts.
              event.preventDefault();
              setEditing(true);
            }}
          >
            {usage ? (
              <>
                <DropdownMenuLabel className="text-xs font-normal tabular-nums text-muted-foreground" data-testid="conversation-usage">
                  {usage}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {threadActions ? (
              <>
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
                  {summary?.pinned ? 'Unpin' : 'Pin'}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {/* A sub-trigger does not size its icon like a menu item does (16 px, muted). */}
                    <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    Export
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent collisionPadding={16}>
                    {EXPORT_FORMATS.map(({ format, label }) => (
                      <DropdownMenuItem key={format} onSelect={() => onExport(format)}>
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem
                  disabled={saveReport.saving}
                  onSelect={() => saveReport.save(busy)}
                  data-testid="save-conversation-report"
                >
                  <FilePlus2 aria-hidden />
                  {saveReport.saving ? 'Saving as report…' : 'Save conversation as report'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={busy}
                  className="text-critical-text focus:text-critical-text"
                  onSelect={onDelete}
                >
                  <Trash2 aria-hidden />
                  Delete
                </DropdownMenuItem>
              </>
            ) : null}
            {laneWidth ? (
              <>
                {threadActions ? <DropdownMenuSeparator /> : null}
                <DropdownMenuGroup aria-labelledby={viewLabelId}>
                  <DropdownMenuLabel id={viewLabelId} className="text-xs font-medium text-muted-foreground">
                    View
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    aria-label="Conversation width"
                    value={laneWidth.value}
                    onValueChange={(value) => {
                      if (isLaneWidth(value)) laneWidth.onChange(value);
                    }}
                  >
                    {LANE_WIDTHS.map((width) => (
                      <DropdownMenuRadioItem
                        key={width}
                        value={width}
                        textValue={LANE_WIDTH_LABEL[width]}
                        className="flex-col items-start gap-0"
                      >
                        <span>{LANE_WIDTH_LABEL[width]}</span>
                        <span className="sr-only">, </span>
                        <span className="text-xs text-muted-foreground">{LANE_WIDTH_HINT[width]}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
