/**
 * The report Export controls (chat revamp SPEC §9.3, §10.6; Round 12 SPEC WP-REP):
 *
 *   - `ExportMenu`: ONE flat menu (no sub-menu) — PDF, Word, Excel, then Markdown and
 *     HTML, then CSV and JSON — plus the "Defang indicators" toggle. Its trigger shows
 *     button-level progress while an export runs (`aria-busy`, a spinner in the icon's
 *     fixed slot; the name and label stay stable) and refuses to open meanwhile
 *     (`aria-disabled`, still focusable), so a double pick cannot save two files.
 *     Opening it warms the export code and the report's sources (`onOpen`).
 *   - `DownloadPdfButton`: the visible one-click "Download PDF" (the browser's print
 *     dialog, already titled with the file name, offers Save as PDF).
 *   - `ExportMenuItems`: the bare item list, for a host that owns its own menu.
 *   - `ExportErrorNote`: an export's failure beside its controls — always closable with
 *     Dismiss, plus Retry for a failure a second try can fix; one it cannot ("no tables
 *     to export as CSV") is a neutral notice. Before the note unmounts, focus returns to
 *     the control that started the export (never to <body>, WCAG 2.4.3).
 *
 * Defanging is ON by default for the human documents (PDF, Word, Markdown, HTML and the
 * Excel workbook's "Report" sheet) and never applies to the data (the Excel table
 * sheets, CSV and JSON round-trip exactly). The choice is a per-viewer convenience
 * remembered in localStorage (best effort; every access is guarded).
 */
import * as React from 'react';
import { Braces, Download, FileCode2, FileDown, FileSpreadsheet, FileText, FileType2, Loader2, RefreshCw, Table2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

import { REPORT_EXPORT_LABEL, REPORT_EXPORT_NAME, type ReportExportFormat } from './export/formats';
import type { ExportError } from './useReportExport';

const DEFANG_KEY = 'soc.report.defang';

function readDefang(): boolean {
  try {
    return window.localStorage.getItem(DEFANG_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeDefang(on: boolean): void {
  try {
    window.localStorage.setItem(DEFANG_KEY, on ? 'on' : 'off');
  } catch {
    /* a private window or blocked storage: the default (on) applies next time */
  }
}

/** The viewer's defang preference (default on). */
export function useDefangPreference(): [boolean, (on: boolean) => void] {
  const [on, setOn] = React.useState<boolean>(() => readDefang());
  const set = React.useCallback((next: boolean) => {
    setOn(next);
    writeDefang(next);
  }, []);
  return [on, set];
}

/** The toggle's name: every document it applies to (`DEFANGED_FORMATS`). */
export const DEFANG_TOGGLE_LABEL = 'Defang indicators (PDF, Word, Markdown, HTML and the Excel report sheet)';

type Icon = React.ComponentType<{ className?: string }>;

const GROUPS: ReadonlyArray<ReadonlyArray<{ format: ReportExportFormat; icon: Icon }>> = [
  [
    { format: 'print', icon: FileDown },
    { format: 'docx', icon: FileText },
    { format: 'xlsx', icon: FileSpreadsheet },
  ],
  [
    { format: 'markdown', icon: FileType2 },
    { format: 'html', icon: FileCode2 },
  ],
  [
    { format: 'csv', icon: Table2 },
    { format: 'json', icon: Braces },
  ],
];

export interface ExportMenuItemsProps {
  onExport: (format: ReportExportFormat, defang: boolean) => void;
  defang: boolean;
  onDefangChange: (on: boolean) => void;
  /** Formats to offer (default all). */
  formats?: readonly ReportExportFormat[];
  disabled?: boolean;
  /** The format being exported (its item says "Preparing…"). */
  busy?: ReportExportFormat | null;
}

/** The format items and the defang toggle (one level, grouped by separators). */
export function ExportMenuItems({ onExport, defang, onDefangChange, formats, disabled = false, busy = null }: ExportMenuItemsProps) {
  const groups = GROUPS.map((group) => group.filter((f) => !formats || formats.includes(f.format))).filter((g) => g.length);
  return (
    <>
      <DropdownMenuLabel className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Download as</DropdownMenuLabel>
      {groups.map((group, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 ? <DropdownMenuSeparator /> : null}
          {group.map(({ format, icon: ItemIcon }) => (
            <DropdownMenuItem key={format} disabled={disabled || busy !== null} onSelect={() => onExport(format, defang)}>
              {busy === format ? (
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <ItemIcon className="size-3.5" aria-hidden />
              )}
              {REPORT_EXPORT_LABEL[format]}
            </DropdownMenuItem>
          ))}
        </React.Fragment>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={defang}
        onCheckedChange={(c) => onDefangChange(c === true)}
        // Keep the menu open so the toggle reads as a setting, not an action.
        onSelect={(e) => e.preventDefault()}
      >
        {DEFANG_TOGGLE_LABEL}
      </DropdownMenuCheckboxItem>
    </>
  );
}

export interface ExportMenuProps extends Omit<ExportMenuItemsProps, 'busy'> {
  /** The format being exported for this report, else null. */
  busy: ReportExportFormat | null;
  /** Called when the menu opens (warm the export code and sources). */
  onOpen?: () => void;
  /** `button`: an outline "Export" button; `icon`: an icon-only trigger (rows, panel). */
  variant?: 'button' | 'icon';
  /** The trigger's accessible name (icon variant), e.g. "Export Brute force…". */
  label?: string;
  align?: 'start' | 'end';
  testId?: string;
  /** The trigger element (focus returns here after a Retry or Dismiss). */
  triggerRef?: React.Ref<HTMLButtonElement>;
}

const ICON_TRIGGER = cn(
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground aria-disabled:opacity-60',
  focusRing,
);

/** The flat Export menu with its trigger (progress while an export runs). */
export function ExportMenu({
  onExport,
  defang,
  onDefangChange,
  formats,
  disabled = false,
  busy,
  onOpen,
  variant = 'button',
  label = 'Export',
  align = 'end',
  testId,
  triggerRef,
}: ExportMenuProps) {
  const running = busy !== null;
  // Controlled, so a running export can refuse to reopen the menu while the trigger
  // stays focusable (a `disabled` trigger would drop the focus the menu just returned).
  const [open, setOpen] = React.useState(false);
  const onOpenChange = (next: boolean) => {
    if (next && (running || disabled)) return;
    setOpen(next);
    if (next) onOpen?.();
  };
  const icon = running ? (
    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
  ) : (
    <Download className="size-4" aria-hidden />
  );
  const unavailable = running || disabled || undefined;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        {variant === 'icon' ? (
          <button
            ref={triggerRef}
            type="button"
            // A stable name: progress is the spinner, `aria-busy` and the announcement.
            aria-label={label}
            title={running ? `Preparing ${REPORT_EXPORT_NAME[busy]}…` : label}
            aria-busy={running || undefined}
            aria-disabled={unavailable}
            className={cn(ICON_TRIGGER, unavailable && 'cursor-progress')}
            data-testid={testId}
          >
            {icon}
          </button>
        ) : (
          <Button
            ref={triggerRef}
            variant="outline"
            size="sm"
            title={running ? `Preparing ${REPORT_EXPORT_NAME[busy]}…` : undefined}
            aria-busy={running || undefined}
            aria-disabled={unavailable}
            className={cn(unavailable && 'cursor-progress')}
            data-testid={testId}
          >
            {icon}
            {label}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64">
        <ExportMenuItems onExport={onExport} defang={defang} onDefangChange={onDefangChange} formats={formats} busy={busy} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface DownloadPdfButtonProps {
  onClick: () => void;
  busy: ReportExportFormat | null;
  disabled?: boolean;
  /** `button` (labelled) or `icon` (an icon button named "Download PDF"). */
  variant?: 'button' | 'icon';
  className?: string;
  /** The button element (focus returns here after a Retry or Dismiss). */
  buttonRef?: React.Ref<HTMLButtonElement>;
}

/** The visible one-click PDF action (the print dialog saves the PDF). */
export function DownloadPdfButton({ onClick, busy, disabled = false, variant = 'button', className, buttonRef }: DownloadPdfButtonProps) {
  const printing = busy === 'print';
  // Focusable while busy (aria-disabled, the click ignored): a disabled button would drop focus.
  const blocked = disabled || busy !== null;
  const icon = printing ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <FileDown className="size-4" aria-hidden />;
  if (variant === 'icon') {
    return (
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (!blocked) onClick();
        }}
        aria-disabled={blocked || undefined}
        aria-busy={printing || undefined}
        aria-label="Download PDF"
        title="Download PDF"
        className={cn(ICON_TRIGGER, className)}
        data-testid="report-download-pdf"
      >
        {icon}
      </button>
    );
  }
  return (
    <Button
      ref={buttonRef}
      variant="outline"
      size="sm"
      onClick={() => {
        if (!blocked) onClick();
      }}
      aria-disabled={blocked || undefined}
      aria-busy={printing || undefined}
      className={className}
      data-testid="report-download-pdf"
    >
      {icon}
      Download PDF
    </Button>
  );
}

export interface ExportErrorNoteProps {
  error: ExportError;
  onRetry: () => void;
  onDismiss: () => void;
  /**
   * The control focus moves to before the note unmounts (the trigger that started the
   * export). Retry clears the note at once; without this, focus would fall to <body>.
   */
  returnFocus?: () => HTMLElement | null | undefined;
  /** `page` (the library) or `bar` (the chat panel's strip under its header). */
  variant?: 'page' | 'bar';
  /** Name the report (a list, where the failed row is not otherwise obvious). */
  showTitle?: boolean;
}

/** An export's failure inline, beside the controls that started it. */
export function ExportErrorNote({ error, onRetry, onDismiss, returnFocus, variant = 'page', showTitle = false }: ExportErrorNoteProps) {
  const act = (fn: () => void) => () => {
    returnFocus?.()?.focus();
    fn();
  };
  const bar = variant === 'bar';
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        bar ? 'justify-between border-b border-border px-3 py-1.5 text-xs' : 'text-sm',
      )}
      data-testid="report-export-error"
      data-retryable={error.retryable ? 'true' : 'false'}
    >
      <span className={cn('min-w-0', error.retryable ? 'text-critical-text' : 'text-foreground')}>
        {showTitle && error.title ? (
          <>
            <span className="font-medium">{error.title}</span>
            {': '}
          </>
        ) : null}
        {error.message}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {error.retryable ? (
          <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={act(onRetry)}>
            <RefreshCw aria-hidden /> Retry
          </Button>
        ) : null}
        {/* Always closable: a failure that keeps failing (an unreachable server, a report
            deleted meanwhile) must not stay on the page until it reloads. */}
        <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={act(onDismiss)}>
          Dismiss
        </Button>
      </span>
    </div>
  );
}
